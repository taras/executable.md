/**
 * Agent component handlers (specs/acp-client-spec.md §Components).
 *
 * `<AgentProvider>`, `<Agent>`, `<Session>`, `<Prompt>`, `<ApproveAll>`,
 * and `<AskPermission>` are engine vocabulary claimed through the core
 * `expandInvocation` hook — the same pattern as the testing vocabulary.
 * Handlers implement the engine-wide `as` capture and prop validation
 * themselves because claimed invocations bypass built-in expansion.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import { Config } from "@executablemd/runtime";
import { env } from "../component-api.ts";
import { validateBindingName } from "../expand.ts";
import { renderSegments } from "../render.ts";
import { parseDuration } from "../modifiers/timeout.ts";
import { validateProps, PropValidationError } from "../validate.ts";
import type { ComponentInvocation, InputSchema, InvocationContext, Segment } from "../types.ts";
import { Agent } from "./agent-api.ts";
import type { PromptOptions, Session } from "./agent-api.ts";
import { AgentInternal } from "./internal.ts";
import { AgentProviders } from "./provider-api.ts";
import { installApproveAll, installAskPermission } from "./permission.ts";
import { serializePromptFailure } from "./errors.ts";
import type { SerializedPromptFailure } from "./errors.ts";
import { persistPrompt, promptFailureFromRecord } from "./journal.ts";
import type { PromptRecord } from "./journal.ts";

const AGENT_PROVIDER_INPUTS: InputSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    defaultAgent: { type: "string" },
    timeout: { type: "string" },
  },
  required: ["name"],
  additionalProperties: false,
};

const AGENT_INPUTS: InputSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  additionalProperties: false,
};

const SESSION_INPUTS: InputSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  additionalProperties: false,
};

const PROMPT_INPUTS: InputSchema = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    agent: { type: "string" },
    session: { type: "string" },
    timeout: { type: "string" },
    throwOnError: { type: "boolean" },
  },
  additionalProperties: false,
};

const NO_PROPS_INPUTS: InputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function errorSegment(source: string, message: string): Segment {
  return { type: "error", message: `<${source}> ${message}`, source };
}

/**
 * Literal props for a claimed invocation. Expression props are rejected —
 * the agent vocabulary takes string and boolean literals only. `as` and
 * `slot` are engine-reserved and stripped before schema validation.
 */
function parseLiteralProps(
  source: string,
  invocation: ComponentInvocation,
  schema: InputSchema,
): { props: Record<string, unknown> } | { error: Segment } {
  for (const name of Object.keys(invocation.expressions)) {
    if (name !== "as" && name !== "slot") {
      return {
        error: errorSegment(source, `the "${name}" prop must be a literal, not an expression.`),
      };
    }
  }
  const literals = { ...invocation.props };
  delete literals.as;
  delete literals.slot;
  try {
    return { props: validateProps(source, literals, schema) };
  } catch (error) {
    if (error instanceof PropValidationError) {
      return { error: errorSegment(source, error.message) };
    }
    throw error;
  }
}

/**
 * Engine-wide `as` capture for claimed invocations: bind the rendered
 * output into the current eval environment and emit nothing.
 */
function* captureAs(
  source: string,
  invocation: ComponentInvocation,
  segments: Segment[],
  rendered?: string,
): Operation<Segment[]> {
  if (!("as" in invocation.props) && !("as" in invocation.expressions)) {
    return segments;
  }
  if ("as" in invocation.expressions) {
    return [errorSegment(source, 'the "as" prop must be a string literal, not an expression.')];
  }
  const currentEnv = yield* env;
  if (!currentEnv) {
    return [errorSegment(source, 'binding with "as" requires an eval scope in context.')];
  }
  const parsed = validateBindingName(invocation.props.as);
  if (!parsed.ok) {
    return [errorSegment(source, `the "as" prop ${parsed.error}`)];
  }
  if (parsed.value === undefined) {
    return [errorSegment(source, 'the "as" prop must be a non-empty string.')];
  }
  currentEnv.values[parsed.value] = rendered ?? renderSegments(segments);
  return [];
}

function formatLocation(invocation: ComponentInvocation): string {
  const position = invocation.position;
  if (!position) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface AgentHandlers {
  expandAgentProvider(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]>;
  expandAgent(invocation: ComponentInvocation, ctx: InvocationContext): Operation<Segment[]>;
  expandSession(invocation: ComponentInvocation, ctx: InvocationContext): Operation<Segment[]>;
  expandPrompt(invocation: ComponentInvocation, ctx: InvocationContext): Operation<Segment[]>;
  expandApproveAll(invocation: ComponentInvocation, ctx: InvocationContext): Operation<Segment[]>;
  expandAskPermission(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]>;
}

export function createAgentHandlers(): AgentHandlers {
  function* expandAgentProvider(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    const parsed = parseLiteralProps("AgentProvider", invocation, AGENT_PROVIDER_INPUTS);
    if ("error" in parsed) {
      return [parsed.error];
    }
    const { props } = parsed;
    const inheritedDefault = yield* AgentInternal.operations.defaultAgentName;
    const permissionMode = yield* AgentInternal.operations.permissionMode;
    const defaultAgent = asString(props.defaultAgent) ?? inheritedDefault;
    if (defaultAgent === undefined) {
      throw new Error(
        `<AgentProvider name="${String(props.name)}"> has no default agent — set the ` +
          `defaultAgent prop, an enclosing <AgentProvider defaultAgent>, or the CLI default`,
      );
    }

    return yield* scoped(function* () {
      let factory;
      try {
        factory = yield* AgentProviders.operations.resolve(String(props.name));
      } catch (error) {
        return [
          errorSegment("AgentProvider", error instanceof Error ? error.message : String(error)),
        ];
      }
      const timeoutProp = asString(props.timeout);
      if (timeoutProp !== undefined) {
        const ms = parseDuration(timeoutProp);
        yield* Config.around({ timeout: () => ms }, { at: "min" });
      }
      yield* AgentInternal.around({ defaultAgentName: () => defaultAgent }, { at: "min" });
      yield* factory({ defaultAgent, permissionMode });
      if (invocation.selfClosing) {
        return [];
      }
      const segments = yield* ctx.expand(invocation.children);
      return yield* captureAs("AgentProvider", invocation, segments);
    });
  }

  function* expandAgent(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    const parsed = parseLiteralProps("Agent", invocation, AGENT_INPUTS);
    if ("error" in parsed) {
      return [parsed.error];
    }
    const resolved = yield* Agent.operations.agent(asString(parsed.props.name));
    if (invocation.selfClosing) {
      return [];
    }
    return yield* scoped(function* () {
      yield* Agent.around(
        {
          *agent([name], next) {
            return yield* next(name ?? resolved);
          },
          *prompt([content, options], next) {
            return yield* next(content, { agent: resolved, ...options });
          },
        },
        { at: "min" },
      );
      const segments = yield* ctx.expand(invocation.children);
      return yield* captureAs("Agent", invocation, segments);
    });
  }

  function* expandSession(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    const parsed = parseLiteralProps("Session", invocation, SESSION_INPUTS);
    if ("error" in parsed) {
      return [parsed.error];
    }
    const session: Session = yield* Agent.operations.session(asString(parsed.props.name));
    if (invocation.selfClosing) {
      return [];
    }
    return yield* scoped(function* () {
      yield* Agent.around(
        {
          *session([name], next) {
            if (name === undefined) {
              return session;
            }
            return yield* next(name);
          },
          *prompt([content, options], next) {
            return yield* next(content, { session, ...options });
          },
        },
        { at: "min" },
      );
      const segments = yield* ctx.expand(invocation.children);
      return yield* captureAs("Session", invocation, segments);
    });
  }

  function* expandPrompt(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    const parsed = parseLiteralProps("Prompt", invocation, PROMPT_INPUTS);
    if ("error" in parsed) {
      return [parsed.error];
    }
    const { props } = parsed;

    // Wrapper form always sends the rendered children — even when they
    // render to an empty string. The prompt prop is the self-closing
    // fallback only. Input is never trimmed.
    let content: string;
    if (invocation.selfClosing) {
      content = asString(props.prompt) ?? "";
    } else {
      content = renderSegments(yield* ctx.expand(invocation.children));
    }

    const options: PromptOptions = {};
    const agentProp = asString(props.agent);
    if (agentProp !== undefined) {
      options.agent = agentProp;
    }
    const sessionProp = asString(props.session);
    if (sessionProp !== undefined) {
      options.session = sessionProp;
    }
    const timeoutProp = asString(props.timeout);
    if (timeoutProp !== undefined) {
      options.timeout = parseDuration(timeoutProp);
    }

    const location = formatLocation(invocation);
    const ordinal = yield* AgentInternal.operations.promptOrdinal(location);
    const sequence = yield* AgentInternal.operations.nextPromptSequence();

    const record = yield* persistPrompt(
      { name: `prompt:${location}#${ordinal}`, input: content },
      () => runPrompt(content, options, sequence),
    );

    const failure = promptFailureFromRecord(record);
    if (failure) {
      if (props.throwOnError === true) {
        throw failure;
      }
      yield* AgentInternal.operations.recordPromptFailure(failure, record.sequence);
    }

    const segments: Segment[] = record.text ? [{ type: "text", content: record.text }] : [];
    return yield* captureAs("Prompt", invocation, segments, record.text);
  }

  function* expandApproveAll(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    const parsed = parseLiteralProps("ApproveAll", invocation, NO_PROPS_INPUTS);
    if ("error" in parsed) {
      return [parsed.error];
    }
    return yield* scoped(function* () {
      yield* installApproveAll();
      const segments = yield* ctx.expand(invocation.children);
      return yield* captureAs("ApproveAll", invocation, segments);
    });
  }

  function* expandAskPermission(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    const parsed = parseLiteralProps("AskPermission", invocation, NO_PROPS_INPUTS);
    if ("error" in parsed) {
      return [parsed.error];
    }
    return yield* scoped(function* () {
      yield* installAskPermission();
      const segments = yield* ctx.expand(invocation.children);
      return yield* captureAs("AskPermission", invocation, segments);
    });
  }

  return {
    expandAgentProvider,
    expandAgent,
    expandSession,
    expandPrompt,
    expandApproveAll,
    expandAskPermission,
  };
}

/**
 * Consume one prompt turn into its durable record. Setup failures, turn
 * failures, and non-success stop reasons all land in the record — the
 * public AgentPromptError is constructed only after the record persists
 * (or replays), so replay restores the identical failure without
 * contacting the provider.
 */
function* runPrompt(
  content: string,
  options: PromptOptions,
  sequence: number,
): Operation<PromptRecord> {
  let agent = options.agent ?? "";
  let sessionKey = typeof options.session === "object" ? options.session.sessionKey : "";
  let agentSessionId: string | undefined;
  let status: PromptRecord["status"] = "failed";
  let stopReason: string | undefined;
  let failure: SerializedPromptFailure | undefined;
  let text = "";
  let sawTerminal = false;

  try {
    const stream = yield* Agent.operations.prompt(content, options);
    const subscription = yield* stream;
    let next = yield* subscription.next();
    while (!next.done) {
      const event = next.value;
      if (event.type === "started") {
        agent = event.agent;
        sessionKey = event.session.sessionKey;
        agentSessionId = event.session.agentSessionId;
      } else if (event.type === "terminal") {
        sawTerminal = true;
        status = event.status;
        stopReason = event.stopReason;
        if (event.error) {
          failure = serializePromptFailure(event.error);
        }
      }
      next = yield* subscription.next();
    }
    text = next.value;
    if (!sawTerminal) {
      status = "failed";
      failure = { message: "agent prompt stream closed without a terminal event" };
    }
  } catch (error) {
    status = "failed";
    failure = serializePromptFailure(error);
  }

  if (status !== "completed" && failure === undefined) {
    failure = {
      message: stopReason
        ? `agent prompt failed with stop reason "${stopReason}"`
        : `agent prompt ${status}`,
    };
  }

  const record: PromptRecord = { sequence, agent, sessionKey, status, text };
  if (agentSessionId !== undefined) {
    record.agentSessionId = agentSessionId;
  }
  if (stopReason !== undefined) {
    record.stopReason = stopReason;
  }
  if (failure !== undefined) {
    record.error = failure;
  }
  return record;
}
