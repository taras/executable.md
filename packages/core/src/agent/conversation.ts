/**
 * One retained agent conversation a trusted host holds open.
 *
 * A document's `<Session>` and `<Prompt>` are written where a conversation
 * belongs: inside an expansion, with an element to name the session and a
 * journal already around them. A host that *discusses* something with an agent
 * has neither. It has a person typing into a chat, a history file that outlives
 * the process, and no document at all — and it still needs the genuine thing:
 * a canonical agent session, journaled turns, verified configuration, and an
 * identity the provider will reattach to tomorrow.
 *
 * So the conversation is an execution the host keeps open, and everything about
 * its shape follows from three facts.
 *
 * ## It is an element, because that is where a conversation can be opened
 *
 * A provider and its launch coordinator are installed inside
 * `Execution.document`. A `DurablePreparation` runs *before* that, so a
 * conversation opened there could reach neither — no provider to resolve a
 * session with, and no coordinator to settle its setup. The conversation is
 * therefore a host-declared identity component, written into a synthetic root
 * of core's own: canonical resolution selects it, hands its implementation this
 * execution's identity holder, and the session is opened under the engine's own
 * identity for that invocation rather than under anything the host supplied.
 * The host's conversation id names the history; it names no session.
 *
 * ## The root is never completed, which is why it can be reopened
 *
 * A durable root that records its terminal is finished: a later run over the
 * same journal reads that terminal and replays its result without entering the
 * body at all. A conversation must do the opposite — reopening is the ordinary
 * case — so the element does not return. It serves turns until the resource
 * that owns it is released, and the halt that releases it appends nothing,
 * because `durableRun` writes a close only on its own success or failure. What
 * the history keeps is a partial continuation, which is what reopening resumes.
 *
 * ## A turn is a canonical durable operation, run where it can be cancelled
 *
 * Each turn is one journaled Prompt under its own durable name, offered in the
 * conversation's own sequence exactly as `<Prompt>` offers one in a document's.
 * It runs in a task of its own so that cancelling the call cancels the turn:
 * its append never lands, the position it would have taken stays free, and the
 * next turn is a new turn rather than that one resumed. Reopening re-offers the
 * turns the history retained, in their own order, which replays each from its
 * record and reaches no provider.
 *
 * A turn whose outcome the history does not hold is a fact rather than
 * something to finish, and a conversation holding one is refused before it
 * opens. Both alternatives are worse: resuming it would re-send a prompt the
 * provider may already have accepted, and writing a terminal for it would make
 * an unfinished turn look complete. Reconciling it belongs to the host, with
 * the provider's own account of that turn.
 *
 * ## What the handle can and cannot reach
 *
 * The handle is provided by a resource owned by the caller's scope, and it is a
 * mailbox rather than a door: a call puts a turn on the queue the element is
 * reading and waits for that turn's own answer. The work therefore happens
 * inside the conversation's durable root, where it belongs, and a handle kept
 * past the resource reaches a queue nobody is reading — so it refuses instead.
 * One turn runs at a time and an overlapping call refuses rather than queuing,
 * because a conversation with two turns in flight has no single next turn.
 */

import {
  createQueue,
  Err,
  ensure,
  Ok,
  race,
  resource,
  scoped,
  spawn,
  suspend,
  withResolvers,
} from "effection";
import type { Operation, Queue, Result } from "effection";
import { createDurableOperation } from "@executablemd/durable-streams";
import type {
  DurableEvent,
  DurableStream,
  Json as DurableJson,
} from "@executablemd/durable-streams";

import { executeInstalled } from "../execute.ts";
import type { ExecutionInstallation, HostExecution } from "../execute.ts";
import type { BoundRootEvaluator } from "../generated-root-owner.ts";
import type { GeneratedXmdRequest, GeneratedXmdRootResult } from "../generated-xmd.ts";
import { durabilityFailure } from "../errors.ts";
import { isJsonObject, parseJson } from "../json.ts";
import { retainedSource } from "../root-source.ts";
import { AgentConversationProvider } from "./conversation-provider.ts";
import type {
  AgentOptions,
  AgentOptionsRequest,
  PromptOptions,
  Session,
  SessionConfiguration,
} from "./agent-api.ts";
import { AgentInternal } from "./internal.ts";
import { runPrompt } from "./function-components.ts";
import type { Carried, DirectPromptTurn } from "./function-components.ts";
import {
  AGENT_PROMPT,
  parsePromptRecord,
  persistPrompt,
  promptFailureFromRecord,
} from "./journal.ts";
import { freezeJson, parseProviderConfiguration, sameJson } from "./provider-configuration.ts";
import type {
  AdmitProviderConfiguration,
  ProviderSessionConfiguration,
} from "./provider-configuration.ts";
import { openSessionRequest } from "./session-request.ts";
import { sessionOf } from "./session-use.ts";
import type { ComponentInvocation, IdentityClaimant } from "../invocation-identity.ts";
import type { Json } from "../types.ts";

/** Why a host conversation cannot be opened, continued or inspected. */
export class AgentConversationError extends Error {
  override name = "AgentConversationError";
}

/** What a trusted host asks for when it opens one conversation. */
export interface AgentConversationRequest {
  /** The durable stream holding this conversation's canonical history. */
  readonly history: DurableStream;
  /** The stable host-owned identity this conversation history belongs to. */
  readonly id: string;
  /** The selected agent name for this conversation. */
  readonly agent: string;
  /** The trusted installations for this conversation's execution. */
  readonly installations: readonly ExecutionInstallation[];
}

/** One open conversation, for as long as the caller's scope holds it. */
export interface AgentConversation {
  /** Send one journaled turn and return its successfully completed reply. */
  prompt(input: string, configuration?: SessionConfiguration): Operation<Result<string>>;
  /** Inspect the selected agent's advertised model and effort choices. */
  options(request?: AgentOptionsRequest): Operation<Result<AgentOptions>>;
  /**
   * Evaluate one complete generated root under this conversation's own
   * execution.
   *
   * Explicit, and separate from the turn that produced the source. `prompt`
   * returns a reply; it does not run one. A host that means to run what came
   * back decides that itself, and asks here — through the same conversation,
   * so the root is evaluated under the documentation and the canonical
   * protected dispatch that conversation's execution captured.
   *
   * It is a job on the same mailbox as `prompt` and `options`, so one of the
   * three runs at a time and an overlapping call refuses rather than queuing.
   * Evaluating sends no provider prompt and changes no configuration: the
   * conversation's turns and its evaluations are separate durable sequences on
   * one history.
   */
  evaluateGeneratedXmdRoot(request: GeneratedXmdRequest): Operation<Result<GeneratedXmdRootResult>>;
}

/**
 * The name the conversation's synthetic root writes, and the root that writes
 * it.
 *
 * Core's own constant, because a journal binds to the exact root it was opened
 * with: a caller-supplied source would make reopening depend on that caller
 * spelling the same text again.
 */
const CONVERSATION_COMPONENT = "AgentConversationHost";
const CONVERSATION_ROOT_PATH = "agent/conversation.md";
const CONVERSATION_ROOT_SOURCE = `<${CONVERSATION_COMPONENT} />\n`;

/** The durable effect that binds a history to the conversation it belongs to. */
const CONVERSATION_IDENTITY = "agent_conversation";

/**
 * The durable effect that holds what this conversation's sessions are built
 * under.
 *
 * One record for the conversation, written by the first turn's activation and
 * never rewritten. It is in the canonical history rather than beside it,
 * because the thing it has to survive is the process: a sidecar nothing
 * admitted would be a file a later run could be missing, be reading someone
 * else's copy of, or be comparing after the turn it was supposed to gate.
 */
const CONVERSATION_CONFIGURATION = "agent_conversation_configuration";
const CONFIGURATION_NAME = "configuration";

/** The durable name of the nth turn of a conversation, counting from one. */
function turnName(order: number): string {
  return `turn:${order}`;
}

/** Which turn a retained durable name is, or nothing when it is not one. */
function turnOrder(name: string): number | undefined {
  const match = /^turn:([1-9][0-9]*)$/.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/** One thing the caller asked the conversation's own execution to do. */
type Job = PromptJob | OptionsJob | EvaluateJob;

interface PromptJob {
  readonly kind: "prompt";
  readonly input: string;
  readonly configuration?: SessionConfiguration;
  readonly answer: Resolvers<Result<string>>;
  readonly cancelled: Resolvers<void>;
  readonly joined: Resolvers<void>;
}

interface OptionsJob {
  readonly kind: "options";
  readonly request?: AgentOptionsRequest;
  readonly answer: Resolvers<Result<AgentOptions>>;
  readonly cancelled: Resolvers<void>;
  readonly joined: Resolvers<void>;
}

interface EvaluateJob {
  readonly kind: "evaluate";
  readonly request: GeneratedXmdRequest;
  readonly answer: Resolvers<Evaluated>;
  readonly cancelled: Resolvers<void>;
  readonly joined: Resolvers<void>;
}

/**
 * What one evaluation settled to, as the element reports it.
 *
 * Two arms, because the two failures are different things for a host to be
 * holding. The request's own failure is a value; a failure of the run keeps the
 * identity and classification it already has, so it travels unchanged and is
 * raised again in the caller's frame rather than described there.
 */
type Evaluated = { readonly value: Result<GeneratedXmdRootResult> } | { readonly raised: unknown };

interface Resolvers<T> {
  readonly operation: Operation<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

/** What the conversation's own execution shares with the handle beside it. */
interface Live {
  /** False once the resource that owns this conversation has been released. */
  open: boolean;
  /**
   * True while one turn or inspection is in flight.
   *
   * It stays true through a cancelled call's own cleanup, because the
   * conversation is not free until that turn's work has finished unwinding — a
   * second turn admitted in between would start while the first was still
   * inside the provider.
   */
  busy: boolean;
  /**
   * Resolved when the conversation itself is released.
   *
   * What stops a caller waiting on a turn that nothing is left to run: the
   * element is gone, so nobody will report that turn joined, and the wait has
   * to end on this instead.
   */
  readonly closed: Resolvers<void>;
  /**
   * Resolved when the conversation's own execution has ended, however it ended.
   *
   * Release is one way an execution ends and not the only one. A failure of the
   * *run* — a journal that stopped describing it, a teardown that did not
   * finish — ends the element too, and the job it was serving is then a job
   * nobody will answer. Without this the caller would wait for an answer that
   * cannot arrive, holding the resource whose release is the only other thing
   * that could have ended the wait.
   */
  readonly ended: Resolvers<void>;
  /**
   * The authoritative failure one of this conversation's evaluations raised.
   *
   * The conversation's own document never completes — the ordinary ending is a
   * halt — so nothing reads the completion its execution settled, and a
   * failure of the *run* that a caller caught would otherwise be a failure
   * nothing reported. Kept here so the release that ends this conversation
   * reports it, which is what stops a caught evaluation failure from leaving a
   * conversation that looks as though it closed cleanly.
   *
   * The first and only the first: later ones are consequences of it, and one
   * ending names one outcome.
   */
  fatal?: Error;
}

/** The native conversation identity one turn saw the provider name. */
interface Observed {
  native?: string;
}

/** What a history already holds about the conversation it belongs to. */
interface Retained {
  /** The durable names of its turns, in the order the history holds them. */
  readonly turns: readonly string[];
  /**
   * What this conversation's sessions are built under, once anything says.
   *
   * Absent for a history whose first turn never reached activation, which is
   * the only case where there is nothing to hold a continuation to — and the
   * case where the next activation writes it.
   */
  readonly configuration?: DurableJson;
  /** The order the next turn takes, which is past every retained one. */
  readonly next: number;
  /**
   * The native conversation identity this history has already established, if
   * any.
   *
   * Read from the canonical turn records themselves rather than from a mapping
   * record of its own. A completed Prompt retains the exact conversation the
   * provider said that turn ran in, so the journal already holds the
   * establishment — which is what lets a turn accepted before anything
   * acknowledged a mapping be reconciled to *that* identity, instead of leaving
   * the conversation looking unestablished and open to a different one.
   */
  readonly native: string | undefined;
}

/**
 * Open one agent conversation and keep it open for the caller's scope.
 *
 * The installations are the host's, captured through the ordinary
 * `executeInstalled` boundary, so which provider this conversation reaches and
 * what creation policy it runs under are settled before any of its code runs.
 * Opening performs no model turn and resolves no session: the request is made
 * when the first turn asks for one, which is what leaves restoring a chat pane
 * provider-free.
 */
export function useAgentConversation(
  request: AgentConversationRequest,
): Operation<Result<AgentConversation>> {
  return resource(function* (provide) {
    const jobs = createQueue<Job, never>();
    const ready = withResolvers<Result<void>>();
    const live: Live = {
      open: true,
      busy: false,
      closed: withResolvers<void>(),
      ended: withResolvers<void>(),
    };

    // Before the execution exists, so a caller halted while this resource is
    // being acquired closes the handle rather than leaving one that looks open
    // — and so a caller waiting for its turn to join stops waiting when there
    // is no longer anything running it.
    yield* ensure(() => {
      live.open = false;
      live.closed.resolve();
    });

    // Read before anything opens, because what it finds decides whether this
    // conversation may be opened at all — and a refusal that had opened the
    // execution would have appended a terminal to the history it refused.
    const retained = yield* openable(request);
    if (!retained.ok) {
      yield* provide(Err(retained.error));
      return;
    }

    // Spawned, so the conversation's root is owned by this resource's scope and
    // halted — never completed — when that scope ends.
    yield* spawn(() => serve(request, retained.value, jobs, ready, live));

    const opened = yield* ready.operation;
    if (!opened.ok) {
      yield* provide(Err(opened.error));
      return;
    }
    yield* provide(Ok(handle(request, jobs, live)));
  });
}

/** The caller-facing handle, which reaches the conversation only through its queue. */
function handle(
  request: AgentConversationRequest,
  jobs: Queue<Job, never>,
  live: Live,
): AgentConversation {
  function admit(): Result<void> {
    if (!live.open) {
      return Err(
        new AgentConversationError(
          `the conversation "${request.id}" has been closed, so nothing reaches it — a handle ` +
            "kept past the scope that opened it names no conversation",
        ),
      );
    }
    if (live.busy) {
      return Err(
        new AgentConversationError(
          `the conversation "${request.id}" is already running a turn, and one conversation ` +
            "runs one turn at a time — a second is refused rather than queued behind it",
        ),
      );
    }
    live.busy = true;
    return Ok(undefined);
  }

  /**
   * What this call settles to: its own answer, or the conversation ending.
   *
   * One rule for all three jobs, because they are one mailbox. An answer that
   * can no longer arrive is the one wait a caller cannot escape on its own: it
   * holds the resource whose release would otherwise end it, so the wait has to
   * know that the element serving it is gone.
   */
  function awaiting<T>(answered: Operation<T>, ending: () => T): Operation<T> {
    return race([
      answered,
      (function* (): Operation<T> {
        yield* live.ended.operation;
        return ending();
      })(),
    ]);
  }

  const ended = (): AgentConversationError =>
    new AgentConversationError(
      `the conversation "${request.id}" ended while this call was waiting for its answer, so ` +
        "there is nothing left to answer it — its work has joined and whatever it recorded " +
        "stays retained",
    );

  return {
    prompt(input: string, configuration?: SessionConfiguration): Operation<Result<string>> {
      return scoped(function* () {
        const admitted = admit();
        if (!admitted.ok) {
          return admitted;
        }
        const answer = withResolvers<Result<string>>();
        const cancelled = withResolvers<void>();
        const joined = withResolvers<void>();
        // What makes this cancellation rather than an ordinary return: a call
        // that was answered has nothing to cancel, and signalling one anyway
        // would make every finished turn look abandoned.
        let answered = false;
        let sent = false;
        // Registered before the send, so a caller halted between the two
        // leaves no turn running that nothing is waiting for.
        yield* ensure(function* () {
          try {
            if (!sent) {
              return;
            }
            if (!answered) {
              cancelled.resolve();
            }
            // Asking is not stopping. This call does not finish until the turn
            // it started has finished unwinding — the provider's own cleanup
            // included — so a caller whose halt has returned knows that work is
            // over. The conversation closing ends the wait too, because then
            // there is nothing left to do the joining.
            yield* race([joined.operation, live.closed.operation]);
          } finally {
            live.busy = false;
          }
        });
        jobs.add({
          kind: "prompt",
          input,
          ...(configuration === undefined ? {} : { configuration }),
          answer,
          cancelled,
          joined,
        });
        sent = true;
        const settled = yield* awaiting(answer.operation, () => Err(ended()));
        answered = true;
        return settled;
      });
    },
    options(inspection?: AgentOptionsRequest): Operation<Result<AgentOptions>> {
      return scoped(function* () {
        const admitted = admit();
        if (!admitted.ok) {
          return admitted;
        }
        const answer = withResolvers<Result<AgentOptions>>();
        const cancelled = withResolvers<void>();
        const joined = withResolvers<void>();
        let answered = false;
        let sent = false;
        yield* ensure(function* () {
          try {
            if (!sent) {
              return;
            }
            if (!answered) {
              cancelled.resolve();
            }
            yield* race([joined.operation, live.closed.operation]);
          } finally {
            live.busy = false;
          }
        });
        jobs.add({
          kind: "options",
          ...(inspection === undefined ? {} : { request: inspection }),
          answer,
          cancelled,
          joined,
        });
        sent = true;
        const settled = yield* awaiting(answer.operation, () => Err(ended()));
        answered = true;
        return settled;
      });
    },
    evaluateGeneratedXmdRoot(
      request: GeneratedXmdRequest,
    ): Operation<Result<GeneratedXmdRootResult>> {
      return scoped(function* () {
        // The same admission a turn passes, because it is the same mailbox: an
        // evaluation while a turn is in flight is a second job on a conversation
        // that runs one, and it refuses here before any component work.
        const admitted = admit();
        if (!admitted.ok) {
          return admitted;
        }
        const answer = withResolvers<Evaluated>();
        const cancelled = withResolvers<void>();
        const joined = withResolvers<void>();
        let answered = false;
        let sent = false;
        yield* ensure(function* () {
          try {
            if (!sent) {
              return;
            }
            if (!answered) {
              cancelled.resolve();
            }
            yield* race([joined.operation, live.closed.operation]);
          } finally {
            live.busy = false;
          }
        });
        jobs.add({ kind: "evaluate", request, answer, cancelled, joined });
        sent = true;
        const settled = yield* awaiting<Evaluated>(answer.operation, () => ({
          value: Err<GeneratedXmdRootResult>(ended()),
        }));
        answered = true;
        // Raised in the caller's own frame, as the same object: a failure of the
        // run is not a response worth correcting, and describing it here would
        // make it look like one.
        if ("raised" in settled) {
          throw settled.raised;
        }
        return settled.value;
      });
    },
  };
}

/**
 * Run the conversation's own durable root, and serve turns inside it forever.
 *
 * The root is one element, and that element does not return. A document that
 * finished would record the root's terminal, and a recorded terminal replays
 * instead of reopening.
 */
function* serve(
  request: AgentConversationRequest,
  retained: Retained,
  jobs: Queue<Job, never>,
  ready: Resolvers<Result<void>>,
  live: Live,
): Operation<void> {
  // However this ends — returning, failing, or being halted — the element is
  // gone afterwards, so nothing is left to answer a job it was serving and
  // nothing new may be admitted.
  // Registered first, so it unwinds last: every job this element was serving
  // has joined and every waiter has been released by the time the ending is
  // reported, and reporting it cannot be what leaves a caller waiting.
  yield* ensure(() => {
    live.open = false;
    live.ended.resolve();
    const fatal = live.fatal;
    if (fatal !== undefined) {
      // The same object a caller was handed, raised into the scope that owns
      // this conversation. A host that caught the failure on the call cannot
      // then release the conversation and read a clean ending: the run this
      // conversation *is* suffered that failure, and a halted document records
      // no terminal for anything else to report it through.
      throw fatal;
    }
  });
  let announced = false;
  const announce = (outcome: Result<void>): void => {
    if (!announced) {
      announced = true;
      ready.resolve(outcome);
    }
  };
  // The one thing the element cannot have when it starts.
  //
  // The conversation's element runs inside the very execution whose handle
  // `executeInstalled` is about to return, so the bound evaluator does not
  // exist yet when the body begins. The bridge is how the two meet: the
  // element waits for it before announcing the conversation ready, and this
  // function resolves it as soon as the handle exists. It carries the bound
  // operation and nothing else — no protected table, no route, no reference —
  // and it is a local value rather than a context, so nothing running in the
  // conversation can set, read or replace what the element waits on.
  const bridge = withResolvers<BoundRootEvaluator>();
  const installation: ExecutionInstallation = {
    components: [
      {
        name: CONVERSATION_COMPONENT,
        origin: "@executablemd/core",
        props: { type: "object", properties: {}, additionalProperties: false },
        description: "Hold one agent conversation open for the host that opened it.",
        factory: (claim) =>
          function* (_props, invocation): Operation<Json> {
            yield* held(request, retained, jobs, announce, bridge, live, claim, invocation);
            return "";
          },
      },
    ],
  };
  try {
    const execution = yield* executeInstalled(
      {
        ...retainedSource(CONVERSATION_ROOT_PATH, CONVERSATION_ROOT_SOURCE),
        stream: request.history,
      },
      [...request.installations, installation],
    );
    // Before the completion is waited on, and after the handle exists: the
    // element is suspended on this, and nothing it does decides whether this
    // resolves.
    bridge.resolve(evaluatorOf(execution));
    const settled = yield* execution;
    // Reached only when the execution ended on its own terms. For a
    // conversation that means it ended before the element could serve
    // anything: the ordinary ending is a halt, which never arrives here.
    announce(
      Err(
        settled.ok
          ? new AgentConversationError(
              `the conversation "${request.id}" ended before it was established`,
            )
          : settled.error,
      ),
    );
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (announced) {
      throw failure;
    }
    announce(Err(failure));
  }
}

/**
 * The conversation itself, inside its own invocation.
 *
 * The identity holder answers for this invocation and no other, so what the
 * session is opened under is the engine's own identity — derived from where the
 * element is written, not from anything the host supplied.
 */
function* held(
  request: AgentConversationRequest,
  retained: Retained,
  jobs: Queue<Job, never>,
  announce: (outcome: Result<void>) => void,
  bridge: Resolvers<BoundRootEvaluator>,
  live: Live,
  claim: IdentityClaimant,
  invocation: ComponentInvocation,
): Operation<void> {
  const identity = yield* claim(invocation);
  // Read once, here, and never again: the installations ran before this element
  // did, so what this answers is the provider this conversation's host
  // selected. From this line on it is an ordinary local — a later selection
  // anywhere cannot reach a chat that is already open, and nothing inside the
  // conversation can replace what its turns go to.
  //
  // Reading is not work. No agent is probed, no runtime created, no session
  // ensured and nothing saved, which is why a cold opening and a replay reach
  // none of its four methods.
  //
  // Asked before the conversation is bound, so a history opened over a provider
  // that cannot serve it is left exactly as it was found: no identity written,
  // no configuration, no turn, and no terminal on the root.
  const provider =
    (yield* AgentConversationProvider.get()) ?? (yield* unsupported(request, announce));
  // The conversation's first durable fact, so a later opening compares what
  // this history belongs to against what it is being asked for.
  const bound = yield* bindConversation(request);
  if (!bound.ok) {
    announce(Err(bound.error));
    yield* suspend();
  }
  // What this conversation's sessions are built under, carried for the whole
  // opening. Every activation below compares against it; only the first one
  // that finds nothing writes.
  const active: Active = { known: retained.configuration };
  // Consumed before the turns, because that is where the first activation
  // wrote it: a run that replayed its turns without it would be offering the
  // journal a prompt where the journal holds a configuration.
  if (retained.configuration !== undefined) {
    yield* replayConfiguration(retained.configuration);
  }
  // Every turn the history already holds, offered again in its own order so
  // this run is aligned with the journal it is continuing. A retained turn
  // replays from its own record and reaches no provider.
  for (const name of retained.turns) {
    yield* replayTurn(name);
  }
  let order = retained.next;
  // What the history already established, carried forward so a turn in this
  // process is held to it as firmly as one after a reopening is.
  let established = retained.native;
  // The actual method on this execution's own handle, waited for before the
  // conversation is announced: a handle that reported itself ready and then
  // refused to evaluate would be ready for two of the three things it offers.
  const evaluate = yield* bridge.operation;
  announce(Ok(undefined));
  while (true) {
    const next = yield* jobs.next();
    if (next.done) {
      break;
    }
    const job = next.value;
    if (job.kind === "options") {
      yield* inspect(provider, request, job);
      continue;
    }
    if (job.kind === "evaluate") {
      yield* evaluated(evaluate, live, job);
      continue;
    }
    const observed: Observed = {};
    yield* deliver(
      provider,
      request,
      identity,
      established,
      observed,
      job,
      order,
      admitting(active),
    );
    // Established by the first turn the provider reported one for, and never
    // replaced afterwards: a turn naming a different one was refused before it
    // could record anything.
    established ??= observed.native;
    order += 1;
  }
  // Nothing closes this queue, and an element that returned would let the root
  // complete. The halt that ends this resource is what ends this.
  yield* suspend();
}

/**
 * Refuse an opening whose provider does not serve saved conversations, forever.
 *
 * There is no fallback to the public chain on purpose. Routing is what a
 * handler can redirect, and a conversation resolved that way would reach a
 * provider that answered its turns without ever being held to what the
 * conversation was created under — the refusal this exists to make.
 *
 * It never returns, and the loop is how that is said rather than asserted: an
 * element that returned here would let the conversation's root complete, and a
 * completed root is a finished run rather than a conversation to reopen. So it
 * waits for the halt that releases the conversation, exactly as a refused bind
 * does.
 */
function* unsupported(
  request: AgentConversationRequest,
  announce: (outcome: Result<void>) => void,
): Operation<never> {
  announce(
    Err(
      new AgentConversationError(
        `the agent provider installed for the conversation "${request.id}" does not support ` +
          "saved conversations, so there is nothing here that could resolve its sessions or " +
          "send its turns. A conversation is held to what it was created under, and holding it " +
          "there is the installed provider's own work — so this refuses rather than routing the " +
          "turns somewhere that would answer without doing it",
      ),
    ),
  );
  while (true) {
    yield* suspend();
  }
}

/**
 * What this opening knows its sessions are built under.
 *
 * One value for the conversation, not one per turn: the first turn's
 * activation commits it and every later activation compares against it, so a
 * second turn in this same process is held to it exactly as firmly as a turn
 * after a reopening is.
 */
interface Active {
  known: DurableJson | undefined;
}

/**
 * Save what this provider is building under, or refuse what differs from it.
 *
 * Bound to the issuance each turn opens, so it is reachable only through the
 * setup the coordinator delivers to the installed provider. Nothing on the
 * public chain carries it, and a request a handler copied carries no
 * requirement at all.
 *
 * The first activation writes; every later one compares. That asymmetry is the
 * whole contract: a conversation that already says what it was created under
 * is not a conversation this run gets to restate, and a difference is refused
 * here — before the provider reattaches — rather than discovered afterwards by
 * a turn that has already landed somewhere.
 */
function admitting(active: Active): AdmitProviderConfiguration {
  return function* (
    provider: string,
    agentCommand: string,
    configuration: ProviderSessionConfiguration | undefined,
  ): Operation<Result<void>> {
    const parsed = parseProviderConfiguration(configuration);
    if (!parsed.ok) {
      return Err(
        new AgentConversationError(
          `this provider did not state what it is building this conversation's session under: ` +
            `${parsed.error.message}. A retained conversation is continued only under the ` +
            `configuration it was created with, so there is nothing here to hold it to.`,
        ),
      );
    }
    const stated = parseJson({ provider, agentCommand, configuration: parsed.value });
    freezeJson(stated);
    const known = active.known;
    if (known !== undefined) {
      if (sameJson(known, stated)) {
        return Ok(undefined);
      }
      return Err(
        new AgentConversationError(
          "this conversation was created under a different provider configuration, and this " +
            "build cannot apply and verify that change on a conversation that already exists. " +
            "The conversation and what it was created under both stand, and nothing was " +
            "replaced.",
        ),
      );
    }
    // Committed before this answers, so a provider that proceeds on `Ok` is
    // proceeding on something the history already holds. An acknowledgement
    // that fails or is cancelled authorizes nothing: it leaves here as the
    // refusal it is, and the setup that asked cannot settle.
    const stored = yield createDurableOperation<DurableJson>(
      { type: CONVERSATION_CONFIGURATION, name: CONFIGURATION_NAME, input: stated },
      // deno-lint-ignore require-yield
      function* (): Operation<DurableJson> {
        return stated;
      },
    );
    const admitted = parseJson(stored);
    freezeJson(admitted);
    active.known = admitted;
    return Ok(undefined);
  };
}

/**
 * The configuration the history already holds, offered again so the turns
 * after it replay in the order they were written.
 *
 * It is consumed and nothing else: no provider is asked anything, no record is
 * appended, and what comes back is what the first activation committed. Its
 * live body refuses for the same reason a replayed turn's does — reaching it
 * means the record this offer was aligned with is not there after all.
 */
function* replayConfiguration(retained: DurableJson): Operation<void> {
  yield createDurableOperation<DurableJson>(
    { type: CONVERSATION_CONFIGURATION, name: CONFIGURATION_NAME, input: retained },
    // deno-lint-ignore require-yield
    function* (): Operation<DurableJson> {
      throw new AgentConversationError(
        "this conversation's retained provider configuration has no recorded outcome, so what " +
          "its sessions were built under cannot be read back",
      );
    },
  );
}

/**
 * Bind this history to the conversation it belongs to, once.
 *
 * Written on the first opening and replayed on every later one, so what comes
 * back is what the history was established for rather than what this caller
 * asked for. A history established for another conversation, or for another
 * agent, is refused here: a misrouted stream must not quietly reconnect the
 * wrong chat, and an established conversation never changes agent in place.
 */
function* bindConversation(request: AgentConversationRequest): Operation<Result<void>> {
  const stated = { id: request.id, agent: request.agent };
  const stored = yield createDurableOperation<DurableJson>(
    { type: CONVERSATION_IDENTITY, name: "conversation", input: stated },
    // deno-lint-ignore require-yield
    function* (): Operation<DurableJson> {
      return parseJson(stated);
    },
  );
  const retained = parseJson(stored);
  if (!isJsonObject(retained) || retained.id !== stated.id) {
    return Err(
      new AgentConversationError(
        `this history belongs to another conversation, so opening it as "${request.id}" would ` +
          "reconnect the wrong chat",
      ),
    );
  }
  if (retained.agent !== stated.agent) {
    return Err(
      new AgentConversationError(
        "this conversation was established with another agent, and an established conversation " +
          "never changes agent in place — an explicit change is a new conversation",
      ),
    );
  }
  return Ok(undefined);
}

/**
 * One turn the history already holds, offered again so replay stays aligned.
 *
 * Its live body refuses. Reaching it means the record this offer was aligned
 * with is not there after all, and asking the provider again for a turn it may
 * already have accepted is the one thing a continuation must not do.
 */
function* replayTurn(name: string): Operation<void> {
  yield* persistPrompt({ name, input: "" }, function* (): Operation<never> {
    throw new AgentConversationError(
      `the conversation's retained turn "${name}" has no recorded outcome, so continuing it ` +
        "would ask the provider for a turn it may already have accepted",
    );
  });
}

/**
 * Send one turn and answer the caller.
 *
 * The turn runs in a task of its own so that cancelling the call cancels the
 * turn: its append never lands, the position it would have taken stays free,
 * and the next turn is a new turn rather than that one resumed.
 */
function deliver(
  provider: AgentConversationProvider,
  request: AgentConversationRequest,
  identity: string,
  established: string | undefined,
  observed: Observed,
  job: PromptJob,
  order: number,
  admit: AdmitProviderConfiguration,
): Operation<void> {
  // Scoped, so the turn cannot outlive the call that asked for it however this
  // returns: a turn still running would hold its durable operation open, and
  // the next turn would be a second one open on the same sequence.
  return scoped(function* () {
    // Registered *before* the turn is spawned, which is what makes it the last
    // thing to unwind: cleanups registered later run first, so the turn — and
    // every cleanup the provider registered inside it — has finished by the
    // time this reports the turn joined. A caller waiting on this therefore
    // waits for the work, not for the request to stop being interesting.
    yield* ensure(() => {
      job.joined.resolve();
    });
    const turn = yield* spawn(() =>
      conversationTurn(provider, request, identity, established, observed, job, order, admit),
    );
    const outcome = yield* race([
      (function* (): Operation<"finished"> {
        try {
          yield* turn;
        } catch (error) {
          // The turn answers its own caller, so what can still arrive here is a
          // journal that stopped describing this run, which ends it.
          if (durabilityFailure(error) !== undefined) {
            throw error;
          }
        }
        return "finished";
      })(),
      (function* (): Operation<"cancelled"> {
        yield* job.cancelled.operation;
        return "cancelled";
      })(),
    ]);
    if (outcome === "finished") {
      return;
    }
    // Giving up on the answer is not cancelling the turn: the task is its own,
    // and halting it is what leaves its append unmade — a fact rather than a
    // suffix for the next turn to resume. Observed, because a halt that nobody
    // waited for is a turn still unwinding while the next one starts, and a
    // failure while it unwinds is an authoritative teardown failure rather
    // than this turn's answer.
    yield* turn.halt();
  });
}

/**
 * One canonical turn: put the conversation under what this turn asks, then
 * run the journaled prompt.
 *
 * A request per turn, because a request settles what it asks before it is
 * routed and is good for exactly one use. The first turn's session is new and
 * the provider creates the conversation; a later turn's exists, and the
 * provider configures it and reports what it verified — which is what makes
 * `configuration` a fact about this turn rather than a hope.
 *
 * Every one of this turn's operations goes to the conversation's own provider,
 * named explicitly. The agent is resolved through it and then passed to both
 * the session and the prompt, so one turn cannot resolve a session for one
 * agent and send it to another; and the prompt is given the exact Session this
 * request's own setup finished with, so nothing can substitute another after it
 * was checked. The request still names no agent and carries nothing public,
 * because what reads it is the setup the coordinator delivers.
 */
function conversationTurn(
  provider: AgentConversationProvider,
  request: AgentConversationRequest,
  identity: string,
  established: string | undefined,
  observed: Observed,
  job: PromptJob,
  order: number,
  admit: AdmitProviderConfiguration,
): Operation<void> {
  return (function* (): Operation<void> {
    try {
      // Resolved before anything else, and before the turn starts. It is the
      // availability boundary — an unavailable agent fails as itself rather
      // than being journaled as a failed turn — and it is also the agent both
      // of this turn's operations are given.
      const agent = yield* provider.agent(request.agent);
      yield* scoped(function* (): Operation<void> {
        // The requirement travels inside the issuance, where the provider
        // reaches it only through the setup the coordinator delivers. A
        // handler holding the request can neither read it nor put one on a
        // request of its own.
        const issuance = openSessionRequest(identity, request.id, admit);
        issuance.configure(job.configuration);
        let session: Session;
        let settled: Session | undefined;
        try {
          session = yield* provider.session(issuance.request, agent);
          // Read while the issuance is still open, because closing it is what
          // ends the one use: what this says is which Session this request's
          // own setup finished with, and only the opener can ask.
          settled = issuance.completed();
        } finally {
          issuance.close();
        }
        // Before the turn, and before the identity check below, because a
        // session this request never settled is not this conversation's to
        // check or to send to. A provider that answered with a session it
        // never put through the setup skipped the configuration this history
        // holds it to; one that settled the request and then answered with
        // something else did the check on a conversation and the turn on
        // another. Neither is a difference the native identity would show —
        // the answer may name the right conversation and still be a value
        // nothing authorized.
        if (settled === undefined || settled !== session) {
          throw new AgentConversationError(
            "this provider did not resolve this conversation's own session request: the session " +
              "it answered with is not the one settling that request produced. A retained " +
              "conversation is continued only through the request it opened, because that is " +
              "what carries the configuration it is held to.",
          );
        }
        // Before the turn starts, because this is the one point where refusing
        // costs nothing: the provider has named the conversation it resolved,
        // and one that is not the established conversation is not this
        // conversation. Replacing the identity is never the answer — the
        // history already says which conversation this is, and a turn sent
        // elsewhere would reach one this chat has never been in.
        const resolved = sessionOf(session)?.agentSessionId;
        if (established !== undefined && resolved !== undefined && resolved !== established) {
          throw new AgentConversationError(
            "this provider resolved a different native conversation from the one this history " +
              "established, so a turn sent to it would reach a conversation this chat has never " +
              "been in. An established conversation is not reattached to another identity.",
          );
        }
        const options: PromptOptions = { agent, session };
        // The same provider, the same agent and the exact session that was
        // settled and checked above. The canonical runner is the one in
        // `function-components.ts` either way — one definition of what a turn
        // is, reached by a document's `<Prompt>` through the public chain and
        // by this conversation directly.
        const direct: DirectPromptTurn = { provider, agent, session };
        const sequence = yield* AgentInternal.operations.nextPromptSequence();
        const carried: Carried = {};
        const record = yield* persistPrompt(
          { name: turnName(order), input: job.input },
          () => runPrompt(job.input, options, sequence, false, carried, direct),
          () => carried.association,
          () => carried.begun,
        );
        // A provider may name the conversation only once the turn has started,
        // which is the ordinary first-turn case. Read from the record, because
        // that is the account the journal keeps and the one a later opening
        // reconciles against.
        if (record.agentSessionId !== undefined) {
          if (established !== undefined && record.agentSessionId !== established) {
            job.answer.resolve(
              Err(
                new AgentConversationError(
                  "this turn ran in a different native conversation from the one this history " +
                    "established. The established identity stands; this turn's outcome is not " +
                    "this conversation's to continue from.",
                ),
              ),
            );
            return;
          }
          observed.native = record.agentSessionId;
        }
        const failure = promptFailureFromRecord(record);
        job.answer.resolve(failure === undefined ? Ok(record.text) : Err(failure));
      });
    } catch (error) {
      // A refusal before the turn started — an unavailable agent, an identity
      // the provider would not reattach, a conversation it put under settings
      // nobody asked for — is this turn's answer rather than the end of the
      // conversation: the host may ask again. A durability failure is not, and
      // it is the one thing that leaves here as itself.
      if (durabilityFailure(error) !== undefined) {
        throw error;
      }
      job.answer.resolve(
        Err(error instanceof Error ? error : new AgentConversationError(String(error))),
      );
    }
  })();
}

/**
 * The bound evaluator on one execution's handle, read once.
 *
 * Read off here rather than kept as the handle, so what crosses the bridge is
 * the operation alone: the element never holds the execution it is running
 * inside, and cannot observe its output or wait on its completion.
 */
function evaluatorOf(execution: HostExecution): BoundRootEvaluator {
  return (request) => execution.evaluateGeneratedXmdRoot(request);
}

/**
 * Evaluate one generated root, and let the caller cancel it.
 *
 * The same shape as a turn, for the same reasons: the cleanup that reports the
 * work joined is registered before the work starts, so it is the last thing to
 * unwind, and a cancelled call does not finish until the evaluation it asked
 * for has. The evaluation's own sequence belongs to the execution rather than
 * to this element, so what this adds is admission and joining and nothing else.
 */
function evaluated(evaluate: BoundRootEvaluator, live: Live, job: EvaluateJob): Operation<void> {
  return scoped(function* () {
    yield* ensure(() => {
      job.joined.resolve();
    });
    const served = yield* race([
      (function* (): Operation<Served> {
        try {
          return { kind: "settled", settled: { value: yield* evaluate(job.request) } };
        } catch (error) {
          // Answered *here*, at the throw, rather than after this race has
          // unwound. A failure of the run raised by this execution's own
          // evaluation runner is already tearing this element down, so an
          // answer handed over afterwards would be in a race with that
          // teardown — and the caller would be told the conversation ended
          // instead of being handed the failure that ended it.
          //
          // It is not raised again from here. The execution treats it as its
          // own outcome because the work that raised it ran in the execution's
          // own runner; a second copy thrown into this element would be one
          // failure arriving twice, each tearing the other's unwinding down.
          //
          // Remembered instead, so that releasing this conversation reports it.
          // A conversation's document is halted rather than completed, so the
          // completion the execution settled is read by nobody — without this
          // the only account of the failure would be the one the caller is free
          // to catch.
          live.fatal ??= error instanceof Error ? error : new Error(String(error));
          job.answer.resolve({ raised: error });
          return { kind: "answered" };
        }
      })(),
      (function* (): Operation<Served> {
        yield* job.cancelled.operation;
        return { kind: "cancelled" };
      })(),
    ]);
    if (served.kind === "settled") {
      job.answer.resolve(served.settled);
    }
  });
}

/** What serving one evaluation reached, and whether the caller still needs an answer. */
type Served =
  | { readonly kind: "settled"; readonly settled: Evaluated }
  | { readonly kind: "answered" }
  | { readonly kind: "cancelled" };

/**
 * Inspect the selected agent's advertised choices. Journals nothing.
 *
 * Through the conversation's own provider, like everything else this chat does:
 * what one provider advertises is not what another does, and an inspection a
 * handler could redirect would describe choices this conversation's turns will
 * never be offered.
 */
function inspect(
  provider: AgentConversationProvider,
  request: AgentConversationRequest,
  job: OptionsJob,
): Operation<void> {
  return scoped(function* () {
    yield* ensure(() => {
      job.joined.resolve();
    });
    const answered = yield* race([
      (function* (): Operation<{ readonly done: Result<AgentOptions> }> {
        try {
          return { done: Ok(yield* provider.options(request.agent, job.request)) };
        } catch (error) {
          return { done: Err(error instanceof Error ? error : new Error(String(error))) };
        }
      })(),
      (function* (): Operation<{ readonly cancelled: true }> {
        yield* job.cancelled.operation;
        return { cancelled: true };
      })(),
    ]);
    if ("cancelled" in answered) {
      return;
    }
    job.answer.resolve(answered.done);
  });
}

/**
 * What this history already holds, and whether it may be continued at all.
 *
 * Read before the execution opens, because a refusal that had opened one would
 * append a terminal to the history it refused. A turn is recognized by the
 * canonical record it committed; one that committed none was interrupted, and
 * continuing it is exactly what a continuation must not do.
 */
function* openable(request: AgentConversationRequest): Operation<Result<Retained>> {
  const events = yield* request.history.readAll();
  if (terminated(events)) {
    return Err(
      new AgentConversationError(
        "this history records its own terminal, so it is a finished run rather than a " +
          "conversation to continue",
      ),
    );
  }
  const turns: string[] = [];
  const asserted = new Set<string>();
  let highest = 0;
  let configuration: DurableJson | undefined;
  for (const event of events) {
    if (event.type !== "yield") {
      continue;
    }
    if (event.description.type === CONVERSATION_CONFIGURATION) {
      if (event.result.status !== "ok") {
        // The acknowledgement that would have said what this conversation's
        // sessions are built under did not finish. It authorized no provider
        // work, so nothing was created under it — but what this conversation
        // is held to is now unreadable, and continuing would mean choosing a
        // configuration rather than reading one.
        return Err(
          new AgentConversationError(
            "this conversation's provider configuration recorded no outcome, so what its " +
              "sessions are built under cannot be read back. Reconcile this history before " +
              "sending another turn.",
          ),
        );
      }
      configuration = event.result.value;
      continue;
    }
    if (event.description.type !== AGENT_PROMPT) {
      continue;
    }
    const { name } = event.description;
    if (event.result.status !== "ok") {
      return Err(
        new AgentConversationError(
          `this conversation's retained turn "${name}" recorded no outcome, so continuing it ` +
            "would ask the provider for a turn it may already have accepted. Reconcile that " +
            "turn against the provider's own account of it before sending another.",
        ),
      );
    }
    turns.push(name);
    highest = Math.max(highest, turnOrder(name) ?? 0);
    // The provider's own account of which conversation that turn ran in. A
    // record naming none was a turn the provider reported no identity for,
    // which establishes nothing either way.
    const record = parsePromptRecord(event.result.value);
    if (record?.agentSessionId !== undefined) {
      asserted.add(record.agentSessionId);
    }
  }
  if (asserted.size > 1) {
    // Two different identities among one conversation's own turns. There is no
    // rule for choosing between them that is not a guess, and guessing would
    // attach the next turn to whichever happened to be read last.
    return Err(
      new AgentConversationError(
        "this conversation's retained turns name more than one native conversation, so which " +
          "one it is cannot be established from its own history. Reconcile it against the " +
          "provider's own account before sending another turn.",
      ),
    );
  }
  const [native] = asserted;
  return Ok(
    Object.freeze({
      turns: Object.freeze(turns),
      next: highest + 1,
      native,
      ...(configuration === undefined ? {} : { configuration }),
    }),
  );
}

/** Whether these events hold the conversation root's own terminal. */
function terminated(events: readonly DurableEvent[]): boolean {
  return events.some((event) => event.type === "close" && event.coroutineId === "root");
}
