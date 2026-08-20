/**
 * The agent components (specs/acp-client-spec.md §Components).
 *
 * `<AgentProvider>`, `<Agent>`, `<Session>`, `<Prompt>`, `<ApproveAll>` and
 * `<AskPermission>` are ordinary function components, registered by
 * `installAgentComponents()` as non-reserved defaults. Expression props, schema
 * validation, `as`, content projection and invocation lifetime are the engine's,
 * exactly as they are for a repository `.ts` component — a document can replace
 * any of these names with a component of its own.
 *
 * They throw when a document cannot sensibly continue — an unknown provider, an
 * agent that is not there, a duration that is not a duration — and that stops
 * the document, because an ordinary component failure fails the operation it is
 * part of. None of them asks for anything special to make that so.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import { content, hasContent } from "../component-api.ts";
import { getExpansion } from "../expansion.ts";
import { cwd, flushOutput, parseDuration, reserveTerminal } from "@executablemd/runtime";
import type { Json, PropsSchema } from "../types.ts";
import type { Expansion } from "../expansion.ts";
import { Agent } from "./agent-api.ts";
import type { LaunchOptions, PromptOptions, Session, SessionLaunchResult } from "./agent-api.ts";
import { AgentLaunchError, AgentLaunchJournal } from "./launch.ts";
import type {
  DetachedLaunchRecord,
  ExitedLaunchRecord,
  LaunchPhase,
  PreparedLaunchRecord,
} from "./launch.ts";
import { persistDetach, persistExit, persistPreparation } from "./launch-journal.ts";
import type { LaunchIdentity } from "./launch-journal.ts";
import { AgentProviders } from "./provider-api.ts";
import { installApproveAll, installAskPermission } from "./permission.ts";
import { AgentInternal } from "./internal.ts";
import { serializePromptFailure } from "./errors.ts";
import type { SerializedPromptFailure } from "./errors.ts";
import { persistPrompt, promptFailureFromRecord } from "./journal.ts";
import type { PromptRecord } from "./journal.ts";

export const AGENT_PROVIDER_PROPS: PropsSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    defaultAgent: { type: "string" },
    timeout: { type: "string" },
  },
  required: ["name"],
  additionalProperties: false,
};

export const NO_PROPS_SCHEMA: PropsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const AGENT_PROPS: PropsSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  additionalProperties: false,
};

export const SESSION_PROPS: PropsSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  additionalProperties: false,
};

export const SESSION_LAUNCH_PROPS: PropsSchema = {
  type: "object",
  properties: {
    agent: { type: "string" },
    session: { type: "string" },
  },
  additionalProperties: false,
};

export const PROMPT_PROPS: PropsSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    agent: { type: "string" },
    session: { type: "string" },
    timeout: { type: "string" },
    throwOnError: { type: "boolean" },
  },
  additionalProperties: false,
};

function asString(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `path:line:column`, `line:column`, or `unknown` — the durable prompt key. */
function formatLocation(metadata: Expansion): string {
  const position = metadata.position;
  if (!position) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}

/**
 * Everything this component installs belongs to its own getExpansion, so the
 * engine dismantles content before the provider's resources. A failure from the
 * factory and a failure from the cleanup it installed are the same kind of
 * problem, and both stop the document — which is what an ordinary failure does.
 */
export function* AgentProvider(props: Record<string, Json>): Operation<Json> {
  const name = String(props.name);
  const factory = yield* AgentProviders.operations.resolve(name);
  const inheritedDefault = yield* AgentInternal.operations.defaultAgentName;
  const permissionMode = yield* AgentInternal.operations.permissionMode;
  const defaultAgent = asString(props.defaultAgent) ?? inheritedDefault;
  if (defaultAgent === undefined) {
    throw new Error(
      `<AgentProvider name="${name}"> has no default agent — set the defaultAgent ` +
        `prop, an enclosing <AgentProvider defaultAgent>, or the installed default`,
    );
  }

  const timeoutProp = asString(props.timeout);
  const promptTimeout =
    timeoutProp === undefined ? undefined : parseDuration(timeoutProp, "<AgentProvider timeout>");
  yield* AgentInternal.around(
    {
      defaultAgentName: () => defaultAgent,
      ...(promptTimeout === undefined ? {} : { promptTimeout: () => promptTimeout }),
    },
    { at: "min" },
  );
  yield* factory({ defaultAgent, permissionMode });

  if (!(yield* hasContent())) {
    return "";
  }
  return yield* content();
}

export function* ApproveAll(): Operation<Json> {
  yield* installApproveAll();
  if (!(yield* hasContent())) {
    return "";
  }
  return yield* content();
}

export function* AskPermission(): Operation<Json> {
  yield* installAskPermission();
  if (!(yield* hasContent())) {
    return "";
  }
  return yield* content();
}

export function* AgentComponent(props: Record<string, Json>): Operation<Json> {
  // Resolving first is the availability boundary: a self-closing invocation is
  // a probe, and it has to fail the same way a wrapping one does.
  const resolved = yield* Agent.operations.agent(asString(props.name));
  if (!(yield* hasContent())) {
    return "";
  }
  yield* Agent.around(
    {
      *agent([name], next) {
        return yield* next(name ?? resolved);
      },
      *prompt([text, options], next) {
        return yield* next(text, { agent: resolved, ...options });
      },
      *launch([instructions, options], next) {
        return yield* next(instructions, { agent: resolved, ...options });
      },
    },
    { at: "min" },
  );
  return yield* content();
}

export function* SessionComponent(props: Record<string, Json>): Operation<Json> {
  const session: Session = yield* Agent.operations.session(asString(props.name));
  if (!(yield* hasContent())) {
    return "";
  }
  yield* Agent.around(
    {
      *session([name], next) {
        if (name === undefined) {
          return session;
        }
        return yield* next(name);
      },
      *prompt([text, options], next) {
        return yield* next(text, { session, ...options });
      },
      *launch([instructions, options], next) {
        return yield* next(instructions, { session, ...options });
      },
    },
    { at: "min" },
  );
  return yield* content();
}

export function* Prompt(props: Record<string, Json>): Operation<Json> {
  // Content first, and before anything else happens: a prompt whose text failed
  // to render was never asked, so nothing may be resolved, sequenced, journaled
  // or sent on its behalf. An empty wrapper still beats the text prop.
  const text = (yield* hasContent()) ? yield* content() : (asString(props.text) ?? "");

  // Resolving before the durable operation makes this the availability
  // boundary: an unavailable agent fails expansion rather than being journaled
  // and collected as a prompt failure.
  const options: PromptOptions = {
    agent: yield* Agent.operations.agent(asString(props.agent)),
  };
  const sessionProp = asString(props.session);
  if (sessionProp !== undefined) {
    options.session = sessionProp;
  }
  const timeoutProp = asString(props.timeout);
  const inherited = yield* AgentInternal.operations.promptTimeout;
  if (timeoutProp !== undefined) {
    options.timeout = parseDuration(timeoutProp, "<Prompt timeout>");
  } else if (inherited !== undefined) {
    options.timeout = inherited;
  }

  const throwOnError =
    props.throwOnError === true || (yield* AgentInternal.operations.promptFailurePolicy());

  const expansion = yield* getExpansion();
  const location = formatLocation(expansion);
  const ordinal = yield* AgentInternal.operations.promptOrdinal(location);
  const sequence = yield* AgentInternal.operations.nextPromptSequence();

  const record = yield* persistPrompt(
    { name: `prompt:${location}#${ordinal}`, input: text, position: expansion.position },
    () => runPrompt(text, options, sequence, throwOnError),
  );

  const failure = promptFailureFromRecord(record);
  if (failure) {
    // Replay decides from the stored marker, not the live prop or policy, so a
    // partial replay reproduces the original throw exactly.
    if (record.raised === true) {
      throw failure;
    }
    yield* AgentInternal.operations.recordPromptFailure(failure, record.sequence);
  }

  return record.text;
}

/**
 * Consume one prompt turn into its durable record. Setup failures, turn
 * failures, and non-success stop reasons all land in the record — the public
 * AgentPromptError is constructed only after the record persists (or replays),
 * so replay restores the identical failure without contacting the provider.
 */
interface ConsumedTurn {
  agent?: string;
  sessionKey?: string;
  agentSessionId?: string;
  status?: PromptRecord["status"];
  stopReason?: string;
  failure?: SerializedPromptFailure;
  text: string;
}

function* runPrompt(
  text: string,
  options: PromptOptions,
  sequence: number,
  throwOnError: boolean,
): Operation<PromptRecord> {
  let consumed: ConsumedTurn = { text: "" };

  try {
    // The subscription is consumed inside its own scope: the subscribing scope
    // owns the turn, so the provider's per-turn cleanups (turn cancellation,
    // permission routing, session lock) run when this prompt finishes — not at
    // document teardown.
    consumed = yield* scoped(function* (): Operation<ConsumedTurn> {
      const result: ConsumedTurn = { text: "" };
      const stream = yield* Agent.operations.prompt(text, options);
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        const event = next.value;
        if (event.type === "started") {
          result.agent = event.agent;
          result.sessionKey = event.session.sessionKey;
          if (event.session.agentSessionId !== undefined) {
            result.agentSessionId = event.session.agentSessionId;
          }
        } else if (event.type === "terminal") {
          result.status = event.status;
          if (event.stopReason !== undefined) {
            result.stopReason = event.stopReason;
          }
          if (event.error) {
            result.failure = serializePromptFailure(event.error);
          }
        }
        next = yield* subscription.next();
      }
      result.text = next.value;
      return result;
    });
    if (consumed.status === undefined) {
      consumed.failure = { message: "agent prompt stream closed without a terminal event" };
    }
  } catch (error) {
    consumed.status = "failed";
    consumed.failure = serializePromptFailure(error);
  }

  const status = consumed.status ?? "failed";
  let failure = consumed.failure;
  if (status !== "completed" && failure === undefined) {
    failure = {
      message: consumed.stopReason
        ? `agent prompt failed with stop reason "${consumed.stopReason}"`
        : `agent prompt ${status}`,
    };
  }

  const record: PromptRecord = {
    sequence,
    agent: consumed.agent ?? options.agent ?? "",
    sessionKey:
      consumed.sessionKey ??
      (typeof options.session === "object" ? options.session.sessionKey : ""),
    status,
    text: consumed.text,
  };
  if (consumed.agentSessionId !== undefined) {
    record.agentSessionId = consumed.agentSessionId;
  }
  if (consumed.stopReason !== undefined) {
    record.stopReason = consumed.stopReason;
  }
  if (failure !== undefined) {
    record.error = failure;
  }
  if (throwOnError && status !== "completed") {
    record.raised = true;
  }
  return record;
}

/**
 * One native session launch: prepare a durable agent session from this body,
 * then hand the person the provider's own interactive UI for that exact
 * session (specs/native-agent-session-launch-spec.md).
 *
 * The body renders first and completely. Only what it rendered becomes
 * prepared instructions — the prose around this element is documentation, and
 * a file the provider happens to be able to read is not selected by being
 * readable. A body that failed to render prepares nothing, resolves nothing,
 * and launches nothing.
 *
 * The launch itself is the provider's, and every phase it completes is
 * retained through the journal installed here. That is also the authority
 * boundary: middleware around the Agent Api may observe a launch or refuse
 * one, but a result that arrives without those retained phases describes a
 * launch that did not happen, and is refused.
 */
export function* SessionLaunch(props: Record<string, Json>): Operation<Json> {
  const instructions = (yield* hasContent()) ? String(yield* content()) : "";

  const sessionProp = asString(props.session);
  const expansion = yield* getExpansion();
  const location = formatLocation(expansion);
  const ordinal = yield* AgentInternal.operations.launchOrdinal(location);
  const identity: LaunchIdentity = { name: `launch:${location}#${ordinal}` };
  if (expansion.position) {
    identity.position = expansion.position;
  }

  const permissionMode = yield* AgentInternal.operations.permissionMode;
  const contextualCwd = yield* cwd();
  // `Agent.AddDir` is not built, so a launch declares no additional roots yet
  // and the retained request says so explicitly rather than omitting the fact.
  const additionalDirectories: string[] = [];

  return yield* scoped(function* (): Operation<Json> {
    // The one foreground-terminal lease, and the first thing asked for. A host
    // with no terminal cannot launch anything, and learning that should not
    // cost an agent probe — so this refuses before any agent is resolved,
    // which is well before any session ownership could move.
    yield* reserveTerminal();
    // Everything the document has said so far reaches the reader before the
    // native UI draws over the terminal.
    yield* flushOutput();

    // Resolving here is the availability boundary: an agent that is not there
    // fails expansion rather than being retained as a refused launch.
    const options: LaunchOptions = {
      agent: yield* Agent.operations.agent(asString(props.agent)),
    };
    if (sessionProp !== undefined) {
      options.session = sessionProp;
    }

    const retained: RetainedPhases = {};
    yield* AgentLaunchJournal.around(
      {
        *recordPreparation([live]) {
          const record = yield* persistPreparation(
            identity,
            {
              instructions,
              agent: options.agent ?? "",
              ...(sessionProp === undefined ? {} : { session: sessionProp }),
              cwd: contextualCwd,
              additionalDirectories,
              permissionMode,
            },
            live,
          );
          retained.prepared = record;
          raiseRetained("prepared", record.failure);
          return record;
        },
        *recordDetach([live]) {
          const record = yield* persistDetach(identity, live);
          retained.detached = record;
          raiseRetained("detached", record.failure);
          return record;
        },
        *recordExit([live]) {
          const record = yield* persistExit(identity, live);
          retained.exited = record;
          raiseRetained("exited", record.failure);
          return record;
        },
      },
      { at: "min" },
    );

    const result = yield* Agent.operations.launch(instructions, options);
    settleLaunch(retained, result);
    return "";
  });
}

interface RetainedPhases {
  prepared?: PreparedLaunchRecord;
  detached?: DetachedLaunchRecord;
  exited?: ExitedLaunchRecord;
}

/**
 * Raise a phase that was retained as a refusal.
 *
 * Retained first and raised second, so the phase a later replay resumes from
 * is the phase that actually happened — including when what happened was the
 * provider declining to go further.
 */
function raiseRetained(
  phase: LaunchPhase,
  failure: { class: string; message: string } | undefined,
) {
  if (!failure) {
    return;
  }
  throw new AgentLaunchError(failure.message, {
    phase,
    failureClass: parseFailureClass(failure.class),
  });
}

function parseFailureClass(value: string): AgentLaunchError["failureClass"] {
  switch (value) {
    case "unsupported-capability":
    case "identity-unavailable":
    case "instructions-refused":
    case "directory-authority":
    case "detach-failed":
    case "process-creation-failed":
    case "native-exit":
      return value;
    default:
      return "unsupported-capability";
  }
}

/**
 * Decide what the launch was, from the phases that were retained rather than
 * from what the Agent Api returned.
 *
 * A `SessionLaunchResult` is ordinary structural data. Middleware can build
 * one, and this is where that stops being enough: the phases below are
 * written by the invocation's own journal, and a result that disagrees with
 * them — or arrives with none of them — is not a launch that happened.
 */
function settleLaunch(retained: RetainedPhases, result: SessionLaunchResult): void {
  const prepared = retained.prepared;
  if (!prepared) {
    throw new AgentLaunchError(
      "the agent provider returned a launch result without preparing a session — " +
        "a launch is authored by the provider that performed it",
      { phase: "prepared", failureClass: "unsupported-capability" },
    );
  }
  if (!retained.detached) {
    throw new AgentLaunchError(
      "the agent provider launched without releasing its ACP session — ACP and " +
        "the native UI never own one session at the same time",
      { phase: "prepared", failureClass: "detach-failed" },
    );
  }
  const exited = retained.exited;
  if (!exited) {
    throw new AgentLaunchError("the native agent UI never reported how it ended", {
      phase: "launched",
      failureClass: "process-creation-failed",
    });
  }
  if (exited.signal !== undefined) {
    throw new AgentLaunchError(`the native agent UI was terminated by ${exited.signal}`, {
      phase: "exited",
      failureClass: "native-exit",
    });
  }
  if (exited.exitCode !== 0) {
    throw new AgentLaunchError(
      `the native agent UI exited with status ${exited.exitCode ?? "unknown"}`,
      { phase: "exited", failureClass: "native-exit" },
    );
  }
  if (
    result.nativeSessionId !== prepared.nativeSessionId ||
    result.launcher !== prepared.launcher
  ) {
    throw new AgentLaunchError("the launch result names a session this launch did not prepare", {
      phase: "exited",
      failureClass: "identity-unavailable",
    });
  }
}
