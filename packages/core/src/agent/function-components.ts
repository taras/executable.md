import { invocationSourceOwner } from "../invocation-identity.ts";
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

import { openSessionRequest } from "./session-request.ts";

import type { ComponentInvocation, FunctionComponent } from "../types.ts";
import type { IdentityClaimant } from "../invocation-identity.ts";
import { cwd, flushOutput, parseDuration, reserveTerminal } from "@executablemd/runtime";
import type { Json, PropsSchema } from "../types.ts";
import type { Expansion } from "../expansion.ts";
import { Agent } from "./agent-api.ts";
import { sessionOf } from "./session-use.ts";
import type {
  LaunchOptions,
  PromptOptions,
  Session,
  SessionConfiguration,
  SessionLaunchResult,
} from "./agent-api.ts";
import {
  launchAgentSession,
  sessionUseConfiguration,
  useConfiguredSession,
  useProviderInstallation,
} from "./launch-install.ts";
import type { AgentSessionUse } from "./session-use.ts";
import type { AgentConversationProvider } from "./conversation-provider.ts";
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
import {
  auditedPromptStream,
  completedPromptAudit,
  persistPrompt,
  promptFailureFromRecord,
} from "./journal.ts";
import type { PromptRecord } from "./journal.ts";
import { checkpointOf } from "./checkpoint.ts";
import type { AgentPromptCheckpoint } from "./checkpoint.ts";
import { HostObservationFailure } from "./publication.ts";
import type {
  AgentPromptAssociation,
  AgentPromptHandle,
  AgentPromptPublisher,
} from "./publication.ts";
import { clearsLiveOutput } from "../secrets/policy.ts";
import type { Stream } from "effection";
import type { AgentPromptEvent } from "./agent-api.ts";

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
  properties: {
    name: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
  },
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
 * What a `<Session>` element authored, or nothing at all.
 *
 * Nothing is the released one-argument call: an element that configured nothing
 * asks for nothing, and an empty configuration object would be a request to
 * leave everything alone — which a provider cannot tell from a request to write
 * two values it was never given.
 */
function sessionConfigurationOf(props: Record<string, Json>): SessionConfiguration | undefined {
  const model = asString(props.model);
  const effort = asString(props.effort);
  if (model === undefined && effort === undefined) {
    return undefined;
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
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

/**
 * `<Session>`, closed over the identity authenticator that names its sessions.
 *
 * Built per execution, from the identity authenticator that execution
 * delivered to this factory: an implementation built for one execution's
 * `<Session>` names nothing under another's, and nothing at some other
 * element's invocation.
 */
export function sessionComponent(claim: IdentityClaimant): FunctionComponent {
  return function* SessionComponent(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<Json> {
    // The name routes; the identity does not. `<Session name="review">` written
    // twice is two sessions, and no handler on the public chain can make them one
    // — it holds the request, reads the name, and reaches no further.
    //
    // The issuance closes as soon as this element has resolved its session, so a
    // handler that kept the request cannot route it for the next `<Session>`:
    // both would otherwise resolve to this element's identity. `close()` is
    // synchronous, so the guarantee holds however the call left.
    const identity = yield* claim(invocation);
    const issuance = openSessionRequest(identity, asString(props.name));
    // Read before the request is routed, so one value describes this element
    // for everything beneath it.
    const configuration = sessionConfigurationOf(props);
    // Settled here, before anything routes, and settled either way: an element
    // that authored nothing says so, which is what leaves a handler holding
    // this request with nothing to add to it.
    issuance.configure(configuration);
    let session: Session | AgentSessionUse;
    try {
      // One released one-argument call, configured or not: what a handler sees
      // is this element's request and nothing else, and what the element asks
      // travels where the engine identity already travels — inside the value,
      // reachable only by the installed provider's coordinator.
      session = yield* Agent.operations.session(issuance.request);
    } finally {
      issuance.close();
    }
    if (!(yield* hasContent())) {
      return "";
    }
    // The one value this element stands for. It is the session — a prompt or a
    // launch beneath it is pinned to this exact object — and, where the element
    // configured anything, it is the use that says what the conversation runs
    // under. Installed whether or not anything was configured, because the
    // innermost `<Session>` owns the conversation a nested prompt belongs to.
    yield* AgentInternal.around({ sessionUse: () => session }, { at: "min" });
    yield* Agent.around(
      {
        *session(routed, next) {
          const [name] = routed;
          if (name === undefined) {
            return session;
          }
          // Delegated exactly as it arrived, arity included: a nested Session
          // that authored nothing stays a one-argument call on its way past.
          return yield* next(...routed);
        },
        *prompt([text, options], next) {
          // The conversation this element owns, for anything beneath it that
          // named none. A prompt that named its own — or a handler that routed
          // another — keeps what it has: the final routed session is what the
          // provider acts on, and what it runs under travels on that value.
          return yield* next(text, { session, ...options });
        },
      },
      { at: "min" },
    );
    return yield* content();
  };
}

export function* Prompt(
  props: Record<string, Json>,
  invocation?: ComponentInvocation,
): Operation<Json> {
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
  } else {
    // The conversation this prompt belongs to, named before anything routes.
    // A handler is entitled to see which conversation a prompt is for and to
    // send it somewhere else; naming it here is what makes that possible, and
    // the provider acts on whatever the last handler left. A prompt that named
    // its own session belongs to that one instead.
    const enclosing = yield* AgentInternal.operations.sessionUse;
    if (enclosing !== undefined) {
      options.session = enclosing;
    }
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
  // Held here rather than on the record: what the journal keeps about a prompt
  // is unchanged, and this is what a host may retain beside it.
  const carried: Carried = {};
  const record = yield* persistPrompt(
    {
      name: `prompt:${location}#${ordinal}`,
      input: text,
      position: expansion.position,
      sourceOwner: invocationSourceOwner(invocation),
    },
    () => runPrompt(text, options, sequence, throwOnError, carried),
    () => carried.association,
    () => carried.begun,
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
  /** Whether the provider said this turn started. */
  started?: true;
  /**
   * The exact session the provider said this turn ran in.
   *
   * Read off the `started` event rather than from the element, because a
   * handler may reroute a whole conversation and the record has to describe
   * the one that actually ran.
   */
  ranIn?: Session;
  status?: PromptRecord["status"];
  stopReason?: string;
  failure?: SerializedPromptFailure;
  text: string;
  /**
   * Which provider turn this completion was, when the provider said.
   *
   * Read off the exact terminal event the provider produced, through a carrier
   * only the delivered launch coordinator can write to. A terminal event a
   * handler substituted carries nothing, which retains nothing.
   */
  checkpoint?: AgentPromptCheckpoint;
}

/**
 * The provider a retained conversation reaches, and what it reaches it with.
 *
 * Supplied instead of the public chain, not beside it: a conversation that
 * routed its prompt could have its session replaced after the one its request
 * finished with had already been checked. Both values are the conversation's
 * own — the agent it resolved through this same provider, and the exact Session
 * its own setup settled — so this says which provider, under which agent, in
 * which conversation, with nothing between able to answer differently.
 */
export interface DirectPromptTurn {
  readonly provider: AgentConversationProvider;
  readonly agent: string;
  readonly session: Session;
}

/**
 * What this turn hands the publication beside the record: the association a
 * host may retain, and the handle that host recognised this exact live turn by.
 */
export interface Carried {
  association?: AgentPromptAssociation;
  begun?: AgentPromptHandle;
}

/**
 * The live account one observing host is given of this turn.
 *
 * Whole prefixes, not deltas: what a host shows is the source as it stands, so
 * a secret split across two transport chunks is found by scanning the
 * accumulation rather than the piece that happened to arrive. Each prefix is
 * cleared by the execution this turn runs in before it leaves Core at all.
 *
 * Doubt withdraws and stays withdrawn. A finding, a scanner that failed, and a
 * policy that is absent or not this execution's all answer the same way: the
 * host is told `null` once, and this turn tells it nothing further. That is a
 * decision about a screen — the journal's own gate still decides whether the
 * turn may be persisted at all.
 */
function liveObservation(
  observe: NonNullable<AgentPromptPublisher["observe"]>,
  carried: Carried,
): {
  /** Another piece of source arrived; offer what the whole of it now is. */
  delta(text: string): Operation<void>;
  /** The stream returned this; offer it when the deltas did not already say it. */
  returned(text: string): Operation<void>;
} {
  let accumulated = "";
  /** The last prefix this host was told, where it has been told one. */
  let offered: string | undefined;
  let withheld = false;
  function* tell(text: string | null): Operation<void> {
    try {
      yield* observe({ begun: carried.begun, text });
    } catch (error) {
      // A trusted host failed its own operation. Carried rather than
      // classified: the catch below reads errors as what the agent did, and
      // this is not something the agent did.
      throw new HostObservationFailure(error);
    }
  }
  function* offer(whole: string): Operation<void> {
    if (withheld) {
      return;
    }
    if (!(yield* clearsLiveOutput(whole))) {
      withheld = true;
      offered = undefined;
      yield* tell(null);
      return;
    }
    if (whole === offered) {
      return;
    }
    offered = whole;
    yield* tell(whole);
  }
  return {
    *delta(text: string): Operation<void> {
      accumulated += text;
      yield* offer(accumulated);
    },
    *returned(text: string): Operation<void> {
      yield* offer(text);
    },
  };
}

/**
 * Consume one provider turn into the record the journal holds.
 *
 * Exported for the trusted host conversation in `conversation.ts`, which is a
 * canonical turn by the same definition this is: the same publication, the same
 * audit, the same account of what the provider said the turn ran in. A second
 * implementation of it is how a programmatic caller and `<Prompt>` came to
 * disagree about what a turn *is* — so there is one, and the component and the
 * host operation both reach it.
 */
export function* runPrompt(
  text: string,
  options: PromptOptions,
  sequence: number,
  throwOnError: boolean,
  carried: Carried,
  direct?: DirectPromptTurn,
): Operation<PromptRecord> {
  let consumed: ConsumedTurn = { text: "" };
  // The exact stream this turn consumed, held out here because the audit
  // outlives the turn's own scope: a turn that failed still answered whatever
  // it was asked before it did. Holding the stream is what makes its audit
  // readable — nothing else can name it.
  let consumedStream: Stream<AgentPromptEvent, string> | undefined;
  // What this turn was authored to run under, and — once the provider has been
  // reached — the exact value it was reached with. The record below is written
  // from the second, so the journal describes the turn that actually ran.
  try {
    // The subscription is consumed inside its own scope: the subscribing scope
    // owns the turn, so the provider's per-turn cleanups (turn cancellation,
    // permission routing, session lock) run when this prompt finishes — not at
    // document teardown.
    consumed = yield* scoped(function* (): Operation<ConsumedTurn> {
      const result: ConsumedTurn = { text: "" };
      // Begun immediately before the provider is asked, in this turn's own
      // scope: the one moment that is both canonical and live, so it is the
      // only place a host can be handed something identifying this turn and
      // nothing else. A component calling the public `Agent.prompt()` never
      // reaches here, which is exactly why it can claim no publication later.
      const publisher = yield* AgentInternal.operations.promptPublisher;
      if (publisher?.begin !== undefined) {
        carried.begun = yield* publisher.begin(text);
      }
      // Only for a host that asked to be told. A publisher with no `observe`
      // accumulates no prefix and is scanned for nothing: this feature costs
      // an ordinary run exactly nothing.
      const observing = publisher?.observe;
      const watching =
        observing === undefined ? undefined : liveObservation(observing.bind(publisher), carried);
      // One turn, two ways of reaching a provider, one audit either way.
      //
      // An ordinary `<Prompt>` routes, and the middleware around that call is
      // what places the ledger — the stream that comes back already carries
      // its own. A retained conversation does not route: it was handed its
      // provider and the exact Session its own request finished with, so this
      // places the ledger itself, around that provider's own cold stream.
      // Holding the stream is how this turn reads what it was allowed to do,
      // and it is the same stream in both cases.
      const stream =
        direct === undefined
          ? yield* Agent.operations.prompt(text, options)
          : yield* auditedPromptStream(
              yield* direct.provider.prompt(text, {
                ...options,
                agent: direct.agent,
                session: direct.session,
              }),
            );
      consumedStream = stream;
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        const event = next.value;
        if (event.type === "started") {
          result.started = true;
          result.agent = event.agent;
          result.sessionKey = event.session.sessionKey;
          // The value the provider named as the conversation this turn ran in.
          // For a configured turn that is the authentic use it was verified
          // under, which is what the record is written from.
          result.ranIn = event.session;
          if (event.session.agentSessionId !== undefined) {
            result.agentSessionId = event.session.agentSessionId;
          }
        } else if (event.type === "text_delta") {
          // Awaited here, before the next provider event is asked for: one
          // observation is in flight at a time, and there is no queue of them
          // to fall behind the turn.
          if (watching !== undefined) {
            yield* watching.delta(event.text);
          }
        } else if (event.type === "terminal") {
          result.status = event.status;
          if (event.stopReason !== undefined) {
            result.stopReason = event.stopReason;
          }
          if (event.error) {
            result.failure = serializePromptFailure(event.error);
          }
          const checkpoint = checkpointOf(event);
          if (checkpoint !== undefined) {
            result.checkpoint = checkpoint;
          }
        }
        next = yield* subscription.next();
      }
      result.text = next.value;
      // What the stream returned, where it is not what the deltas already
      // said. A provider that answers with its own whole text — or with
      // nothing at all — replaces the candidate exactly rather than leaving a
      // host showing something the record will not hold. The journal's result
      // is the stream's own return, untouched by any of this.
      if (watching !== undefined) {
        yield* watching.returned(next.value);
      }
      return result;
    });
    if (consumed.status === undefined) {
      consumed.failure = { message: "agent prompt stream closed without a terminal event" };
    }
  } catch (error) {
    if (error instanceof HostObservationFailure) {
      // Not this turn's failure to describe. The provider's own cleanup has
      // already run — the scope above owns it — and this travels on to the
      // durability failure a host that cannot be trusted with its turn gets,
      // without a record being appended for it.
      throw error;
    }
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
    sessionKey: consumed.sessionKey ?? sessionOf(options.session)?.sessionKey ?? "",
    status,
    text: consumed.text,
  };
  if (consumed.agentSessionId !== undefined) {
    record.agentSessionId = consumed.agentSessionId;
  }
  // Read from the session the provider itself named as the one this turn ran
  // in, never from what the element held. Middleware may reroute a whole
  // conversation, and the record has to describe the one that actually ran: an
  // authentic use answers with what it was verified under, and a raw session
  // answers with nothing.
  //
  // Retained only once the provider said the turn started, because that is when
  // the conversation was under these settings: a prompt that failed while they
  // were still being applied ran under nothing, and one that started and then
  // failed still ran under exactly them.
  const configuration = yield* sessionUseConfiguration(consumed.ranIn);
  if (configuration !== undefined && consumed.started === true) {
    record.configuration = configuration;
  }
  if (consumed.stopReason !== undefined) {
    record.stopReason = consumed.stopReason;
  }
  if (failure !== undefined) {
    record.error = failure;
  }
  // Written once the turn is over, with the rest of the result: a decision is
  // part of the account of this turn, not an event of its own.
  // Read from the exact stream this turn consumed. A turn that never got one
  // was allowed nothing, because it never asked.
  const answered =
    (consumedStream === undefined ? undefined : yield* completedPromptAudit(consumedStream)) ?? [];
  if (answered.length > 0) {
    record.permissions = answered;
  }
  if (throwOnError && status !== "completed") {
    record.raised = true;
  }
  // Only a turn that completed under a session the provider named. Both halves
  // are the provider's own account of this exact turn; neither is inferred, and
  // a turn missing either offers nothing to retain.
  if (status === "completed" && consumed.checkpoint !== undefined && consumed.sessionKey) {
    carried.association = {
      checkpoint: consumed.checkpoint,
      sessionKey: consumed.sessionKey,
    };
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
 * retained through the journal installed here. That is also the coordination
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
