/**
 * One retained agent conversation a trusted host holds open.
 *
 * A document's `<Session>` and `<Prompt>` are written where a conversation
 * belongs: inside an expansion, with an element to name the placement and a
 * journal already around them. A host that *discusses* something with an agent
 * has neither. It has a person typing into a chat, a history file that outlives
 * the process, and no document at all — and it still needs the genuine thing:
 * canonical Session placement, journaled turns, verified configuration, and an
 * identity the provider will reattach to tomorrow.
 *
 * So the conversation is an execution the host keeps open, and everything about
 * its shape follows from three facts.
 *
 * ## It is an element, because that is where a conversation can be placed
 *
 * A provider and its placement coordinator are installed inside
 * `Execution.document`. A `DurablePreparation` runs *before* that, so a
 * conversation opened there could reach neither — no provider to place a
 * session with, and no coordinator to settle the placement. The conversation is
 * therefore a host-declared identity component, written into a synthetic root
 * of core's own: canonical resolution selects it, hands its implementation this
 * execution's claimant, and the session is placed under the engine's own
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
import type { ExecutionInstallation } from "../execute.ts";
import { durabilityFailure } from "../errors.ts";
import { isJsonObject, parseJson } from "../json.ts";
import { retainedSource } from "../root-source.ts";
import { Agent } from "./agent-api.ts";
import type {
  AgentOptions,
  AgentOptionsRequest,
  PromptOptions,
  Session,
  SessionConfiguration,
} from "./agent-api.ts";
import { AgentInternal } from "./internal.ts";
import { runPrompt } from "./function-components.ts";
import type { Carried } from "./function-components.ts";
import {
  AGENT_PROMPT,
  parsePromptRecord,
  persistPrompt,
  promptFailureFromRecord,
} from "./journal.ts";
import { sessionPlacement } from "./session-request.ts";
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
type Job = PromptJob | OptionsJob;

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
}

/** The native conversation identity one turn saw the provider name. */
interface Observed {
  native?: string;
}

/** What a history already holds about the conversation it belongs to. */
interface Retained {
  /** The durable names of its turns, in the order the history holds them. */
  readonly turns: readonly string[];
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
 * Opening performs no model turn and places no session: the placement is made
 * when the first turn asks for one, which is what leaves restoring a chat pane
 * provider-free.
 */
export function useAgentConversation(
  request: AgentConversationRequest,
): Operation<Result<AgentConversation>> {
  return resource(function* (provide) {
    const jobs = createQueue<Job, never>();
    const ready = withResolvers<Result<void>>();
    const live: Live = { open: true, busy: false, closed: withResolvers<void>() };

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
    yield* spawn(() => serve(request, retained.value, jobs, ready));

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
        const settled = yield* answer.operation;
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
        const settled = yield* answer.operation;
        answered = true;
        return settled;
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
): Operation<void> {
  let announced = false;
  const announce = (outcome: Result<void>): void => {
    if (!announced) {
      announced = true;
      ready.resolve(outcome);
    }
  };
  const installation: ExecutionInstallation = {
    components: [
      {
        name: CONVERSATION_COMPONENT,
        origin: "@executablemd/core",
        props: { type: "object", properties: {}, additionalProperties: false },
        description: "Hold one agent conversation open for the host that opened it.",
        factory: (claim) =>
          function* (_props, invocation): Operation<Json> {
            yield* held(request, retained, jobs, announce, claim, invocation);
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
 * The claimant answers for this invocation and no other, so what the session is
 * placed under is the engine's own identity — derived from where the element is
 * written, not from anything the host supplied.
 */
function* held(
  request: AgentConversationRequest,
  retained: Retained,
  jobs: Queue<Job, never>,
  announce: (outcome: Result<void>) => void,
  claim: IdentityClaimant,
  invocation: ComponentInvocation,
): Operation<void> {
  const identity = yield* claim(invocation);
  // The conversation's first durable fact, so a later opening compares what
  // this history belongs to against what it is being asked for.
  const bound = yield* bindConversation(request);
  if (!bound.ok) {
    announce(Err(bound.error));
    yield* suspend();
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
  announce(Ok(undefined));
  while (true) {
    const next = yield* jobs.next();
    if (next.done) {
      break;
    }
    const job = next.value;
    if (job.kind === "options") {
      yield* inspect(request, job);
      continue;
    }
    const observed: Observed = {};
    yield* deliver(request, identity, established, observed, job, order);
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
  request: AgentConversationRequest,
  identity: string,
  established: string | undefined,
  observed: Observed,
  job: PromptJob,
  order: number,
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
      conversationTurn(request, identity, established, observed, job, order),
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
 * One canonical turn: place the conversation under what this turn asks, then
 * run the journaled prompt.
 *
 * A placement per turn, because a placement settles what it asks before it is
 * routed and is good for exactly one use. The first turn's is fresh and the
 * provider creates the conversation; a later turn's is established, and the
 * provider configures it and reports what it verified — which is what makes
 * `configuration` a fact about this turn rather than a hope.
 */
function conversationTurn(
  request: AgentConversationRequest,
  identity: string,
  established: string | undefined,
  observed: Observed,
  job: PromptJob,
  order: number,
): Operation<void> {
  return (function* (): Operation<void> {
    try {
      const issuance = sessionPlacement(identity, request.id);
      issuance.configure(job.configuration);
      let session: Session;
      try {
        session = yield* Agent.operations.session(issuance.request);
      } finally {
        issuance.close();
      }
      // Before the turn starts, because this is the one point where refusing
      // costs nothing: the provider has named the conversation it resolved, and
      // one that is not the established conversation is not this conversation.
      // Replacing the identity is never the answer — the history already says
      // which conversation this is, and a turn sent elsewhere would reach one
      // this chat has never been in.
      const resolved = sessionOf(session)?.agentSessionId;
      if (established !== undefined && resolved !== undefined && resolved !== established) {
        throw new AgentConversationError(
          "this provider resolved a different native conversation from the one this history " +
            "established, so a turn sent to it would reach a conversation this chat has never " +
            "been in. An established conversation is not reattached to another identity.",
        );
      }
      // Resolved before the turn starts, so an unavailable agent fails as
      // itself rather than being journaled as a failed turn.
      const agent = yield* Agent.operations.agent(request.agent);
      const options: PromptOptions = { agent, session };
      const sequence = yield* AgentInternal.operations.nextPromptSequence();
      const carried: Carried = {};
      const record = yield* persistPrompt(
        { name: turnName(order), input: job.input },
        () => runPrompt(job.input, options, sequence, false, carried),
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

/** Inspect the selected agent's advertised choices. Journals nothing. */
function inspect(request: AgentConversationRequest, job: OptionsJob): Operation<void> {
  return scoped(function* () {
    yield* ensure(() => {
      job.joined.resolve();
    });
    const answered = yield* race([
      (function* (): Operation<{ readonly done: Result<AgentOptions> }> {
        try {
          return { done: Ok(yield* Agent.operations.options(request.agent, job.request)) };
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
  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== AGENT_PROMPT) {
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
  return Ok(Object.freeze({ turns: Object.freeze(turns), next: highest + 1, native }));
}

/** Whether these events hold the conversation root's own terminal. */
function terminated(events: readonly DurableEvent[]): boolean {
  return events.some((event) => event.type === "close" && event.coroutineId === "root");
}
