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
 * What is not ordinary is that some of their failures end the document rather
 * than becoming a diagnostic, which is the behavior they had when they were
 * claimed through `Component.expand`. `<Agent>`, `<Session>` and `<Prompt>` mark
 * the individual failures that must stay fatal. `<AgentProvider>` cannot: the
 * resources its factory installs are dismantled by the invocation boundary
 * *after* the component returns, so the failure does not exist while the
 * component is running. It opts in by function identity instead, and the engine
 * classifies the complete body-and-teardown failure.
 */

import { Config } from "@executablemd/runtime";
import { scoped } from "effection";
import type { Operation } from "effection";
import { content, hasContent, invocation } from "../component-api.ts";
import { abortOrdinaryComponentFailures, componentAbort } from "../errors.ts";
import { parseDuration } from "../modifiers/timeout.ts";
import type { ComponentInvocationMetadata, Json, PropsSchema } from "../types.ts";
import { Agent } from "./agent-api.ts";
import type { PromptOptions, Session } from "./agent-api.ts";
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
 * Run `operation`, ending the document if it fails.
 *
 * These are the preconditions a document cannot continue past — an agent that
 * is not there, a duration that is not a duration. Rendering a diagnostic and
 * carrying on would run later siblings as though the agent had answered.
 */
function* fatally<T>(operation: () => Operation<T>): Operation<T> {
  try {
    return yield* operation();
  } catch (error) {
    throw componentAbort(error);
  }
}

/** `path:line:column`, `line:column`, or `unknown` — the durable prompt key. */
function formatLocation(metadata: ComponentInvocationMetadata): string {
  const position = metadata.position;
  if (!position) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}

/**
 * Everything this component installs belongs to its own invocation, so the
 * engine dismantles content before the provider's resources and reports what
 * both did. Nothing here catches: a failure from the factory and a failure from
 * the cleanup it installed are the same kind of problem, and only the boundary
 * sees both.
 */
export const AgentProvider = abortOrdinaryComponentFailures(function* (
  props: Record<string, Json>,
): Operation<Json> {
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
  if (timeoutProp !== undefined) {
    yield* Config.around({ timeout: () => parseDuration(timeoutProp) }, { at: "min" });
  }
  yield* AgentInternal.around({ defaultAgentName: () => defaultAgent }, { at: "min" });
  yield* factory({ defaultAgent, permissionMode });

  if (!(yield* hasContent())) {
    return "";
  }
  return yield* content();
});

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
  const resolved = yield* fatally(() => Agent.operations.agent(asString(props.name)));
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
  const session: Session = yield* fatally(() => Agent.operations.session(asString(props.name)));
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
    agent: yield* fatally(() => Agent.operations.agent(asString(props.agent))),
  };
  const sessionProp = asString(props.session);
  if (sessionProp !== undefined) {
    options.session = sessionProp;
  }
  const timeoutProp = asString(props.timeout);
  if (timeoutProp !== undefined) {
    // deno-lint-ignore require-yield
    options.timeout = yield* fatally(function* () {
      return parseDuration(timeoutProp);
    });
  }

  const throwOnError =
    props.throwOnError === true || (yield* AgentInternal.operations.promptFailurePolicy());

  const location = formatLocation(yield* invocation());
  const ordinal = yield* AgentInternal.operations.promptOrdinal(location);
  const sequence = yield* AgentInternal.operations.nextPromptSequence();

  const record = yield* persistPrompt({ name: `prompt:${location}#${ordinal}`, input: text }, () =>
    runPrompt(text, options, sequence, throwOnError),
  );

  const failure = promptFailureFromRecord(record);
  if (failure) {
    // Replay decides from the stored marker, not the live prop or policy, so a
    // partial replay reproduces the original throw exactly.
    if (record.raised === true) {
      throw componentAbort(failure);
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
