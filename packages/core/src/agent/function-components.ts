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
import { content, hasContent, raise } from "../component-api.ts";
import { getExpansion } from "../expansion.ts";
import { cwd, flushOutput, parseDuration, reserveTerminal } from "@executablemd/runtime";
import type { Json, PropsSchema } from "../types.ts";
import type { Expansion } from "../expansion.ts";
import { Agent } from "./agent-api.ts";
import type { LaunchOptions, PromptOptions, Session, SessionLaunchResult } from "./agent-api.ts";
import { launchAgentSession, useProviderInstallation } from "./launch-install.ts";
import { AgentLaunchError } from "./launch.ts";
import type {
  DetachedLaunchRecord,
  ExitedLaunchRecord,
  LaunchPhase,
  PreparedLaunchRecord,
} from "./launch.ts";
import type { LaunchIdentity } from "./launch-journal.ts";
import { installApproveAll, installAskPermission } from "./permission.ts";
import { AgentInternal, formatLocation } from "./internal.ts";
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

/**
 * Everything this component installs belongs to its own getExpansion, so the
 * engine dismantles content before the provider's resources. A failure from the
 * factory and a failure from the cleanup it installed are the same kind of
 * problem, and both stop the document — which is what an ordinary failure does.
 */
export function* AgentProvider(props: Record<string, Json>): Operation<Json> {
  const name = String(props.name);
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
  // Installed in this invocation, not inside a frame nested in it: the body
  // below is projected into the invocation, so a provider installed anywhere
  // else would be invisible to the very content it was selected for.
  yield* useProviderInstallation(name, { defaultAgent, permissionMode });

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
      *launch([request], next) {
        // Pinned by deriving, which is the only way a handler may change what a
        // launch asks for. An explicit `session` on the launch itself already
        // named one, and lexical pinning does not override it.
        return yield* next(request.session === undefined ? request.with({ session }) : request);
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
/**
 * Render the body, then launch. Nothing else.
 *
 * The phases, their order, their retention and the result all belong to
 * `Agent.launch()`, which a repository function component may call directly.
 * A second implementation here is what let the component and the programmatic
 * caller disagree about what a launch is — and it is why an exit the provider
 * never retained used to be able to settle one.
 */
export function* SessionLaunch(props: Record<string, Json>): Operation<Json> {
  const instructions = (yield* hasContent()) ? String(yield* content()) : "";
  const options: LaunchOptions = {};
  const agentProp = asString(props.agent);
  if (agentProp !== undefined) {
    options.agent = agentProp;
  }
  const sessionProp = asString(props.session);
  if (sessionProp !== undefined) {
    options.session = sessionProp;
  }
  try {
    yield* launchAgentSession(instructions, options);
  } catch (error) {
    if (!(error instanceof AgentLaunchError)) {
      throw error;
    }
    // Raised rather than thrown: how a launch ended is something the document
    // observed, and the observation chain is where a document's own failures
    // are seen — which is also what lets an author assert on one. The cause
    // carries the class so that assertion is about which refusal it was, not
    // about the wording of a message.
    const reported = yield* raise({
      type: "error",
      message: error.message,
      source: "Session.Launch",
      cause: { phase: error.phase, failureClass: error.failureClass },
    });
    return reported.message;
  }
  return "";
}
