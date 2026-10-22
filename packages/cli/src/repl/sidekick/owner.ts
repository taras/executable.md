import type { ReplTesting } from "./testing.ts";
/**
 * The conversation this execution owns, and the one cycle it runs at a time.
 *
 * The logical Sidekick belongs to the REPL *execution*, not to a pane, a tab, a
 * reading position or a process. Reopening restores its conversation and its
 * chat, and reopening asks a provider for nothing: this owner holds no handle
 * until a person explicitly does something — says something, reads what their
 * agent offers, asks for a model, changes agent — which is what keeps restoring
 * a chat free of provider work, free of writes and free of model turns.
 *
 * ## The three things a Sidekick runs under, and where each is decided
 *
 * Which **agent** answers is the conversation's own, settled when it was opened
 * and never changed in place — so continuing one uses the agent it records,
 * whatever this process was started with, and choosing another explicitly
 * starts another conversation. Which **model and effort** it runs under is a
 * request this history holds and the next turn puts into effect, because an
 * agent can only be asked for a configuration on a turn. What a person may
 * **choose between** is the agent's own answer, asked for only when they ask:
 * nothing in this repository says what a model is called.
 *
 * ## What one explicit message does, in order
 *
 * Establish storage, resolve the conversation, open it, deliver the
 * orientation if this conversation has not had one, write down what the person
 * said, send one saved turn, and evaluate what came back. Every step that
 * can be read back later is written before the work it describes, for the
 * reason the Submit reservation is: a process that stops in the middle leaves a
 * readable account of what it was doing rather than an absence.
 *
 * ## The reply is evaluated, and only its Output is chat
 *
 * A successful complete response is an XMD root. It is evaluated through *this
 * conversation's own* execution — so `<Syntax />` answers from the vocabulary
 * this reply actually admitted and the documentation this execution captured —
 * under the ceiling `profile.ts` builds from the requests the root answers. The
 * evaluation is a separate durable sequence from the turn that produced it:
 * sending and running are different acts, and a host that meant to run what
 * came back says so.
 *
 * What the person sees is the root's `<Output>` and nothing else. A response
 * that only performed reads renders nothing and is not padded with a fallback;
 * a response whose provider turn failed executes no control at all, and what it
 * had streamed is taken from the canonical record rather than from anything
 * this process remembers.
 *
 * ## One at a time, and canonical facts only
 *
 * `prompt`, `options` and `evaluateGeneratedXmdRoot` share one mailbox inside
 * the conversation, so an overlapping call refuses rather than queueing. Above
 * that, this owner runs one message at a time for the same reason the entry
 * slot is one: two cycles writing one chat history is two accounts of one
 * conversation.
 *
 * Everything this states about a turn is checked against the canonical records.
 * A turn ordinal comes from the names Core retained, a reply is published only
 * for a turn the journal says completed, and the text of a failed turn is the
 * text the canonical record holds. Nothing here is established by this process
 * having remembered it.
 */

import {
  createSignal,
  ensure,
  Err,
  Ok,
  resource,
  scoped,
  spawn,
  suspend,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream, Task } from "effection";
import {
  AGENT_PROMPT,
  GeneratedXmdRootError,
  parsePromptRecord,
  previewGeneratedXmdRoot,
  useAgentPromptPublisher,
} from "@executablemd/core/host";
import type {
  AgentPromptHandle,
  AgentPromptPublisher,
  ExecutionInstallation,
  GeneratedXmdRootResult,
} from "@executablemd/core/host";
import { serializeError } from "@executablemd/durable-streams";
import { useAgentConversation } from "@executablemd/core/host";
import type { AgentConversation } from "@executablemd/core/host";
import type { AgentOptions, AgentOptionsRequest, SessionConfiguration } from "@executablemd/core";
import { parseDurableEvent } from "@executablemd/durable-streams";

import { ReplHost } from "../host.ts";
import { API } from "@executablemd/runtime";
import { conversationStream, failedOutcome } from "./history.ts";
import type { SidekickRecord, SidekickWriter } from "./history.ts";
import { projectSidekick, requestsFromHistory } from "./model.ts";
import type { SidekickReading } from "./model.ts";
import { controlJournal } from "./admission.ts";
import {
  responseSurface,
  sidekickCeilingInstallation,
  sidekickResponseCeiling,
} from "./profile.ts";
import { sidekickRequests } from "./requests.ts";
import type { RootReading } from "./requests.ts";
import type { ControlJournal, SubmitReceipt } from "./controls.ts";
import { useSidekickQuestions } from "./questions.ts";
import type { ReplElicitations } from "../elicitation.ts";
import {
  designatedResults,
  orientationChanged,
  recoveredWork,
  sealedFeedback,
  turnContext,
  turnRequest,
} from "./feedback.ts";
import type { TurnContext } from "./feedback.ts";
import type { PairedChatStorage } from "./repository.ts";

/** Why one explicit message could not be taken, or could not finish. */
export class SidekickOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidekickOwnerError";
  }
}

/** What the Sidekick's own conversations run under. */
export interface SidekickAssembly {
  /** The agent a new conversation is opened with. */
  readonly agent: string;
  /**
   * What a conversation's execution installs.
   *
   * Deliberately not the entry profile's. A response is evaluated under the
   * ceiling handed to the evaluation, and native tool permission defaults to
   * `deny-all` — so an entry permission flag grants a Sidekick turn nothing,
   * by this list not carrying one rather than by a rule written somewhere.
   */
  readonly installations: readonly ExecutionInstallation[];
}

/**
 * What one turn is being sent, and on whose behalf.
 *
 * Two kinds, because they are written down differently and only one of them is
 * ever oriented: a person's message is retained as a message, and a delivery of
 * one response's results is retained as feedback naming that response.
 */
type Sending =
  | {
      readonly kind: "message";
      readonly text: string;
      /**
       * The message revision this was asked for at.
       *
       * Carried rather than read where the record is written: by then the
       * storage may have been established and the person may have typed again,
       * and the revision this message is recorded under has to be the one that
       * was true when they sent it.
       */
      readonly revision: number;
    }
  | { readonly kind: "feedback"; readonly of: string; readonly text: string };

/** One turn's own outcome, and what the turn after it owes. */
interface Responded {
  readonly held: SidekickTurn;
  /**
   * Whether a response was evaluated at all.
   *
   * False when the provider did not finish the turn, which is a different thing
   * from a response that ran and failed: nothing was evaluated, so this turn
   * answered nobody. It is what decides which turn of an exchange is the one
   * the person was answered by.
   */
  readonly answered: boolean;
  /**
   * The exact text the next turn is to be sent, or none to stop.
   *
   * None means the exchange is over: the reply asked for nothing and failed at
   * nothing a correction could fix, so the next move is the person's.
   */
  readonly next: string | undefined;
}

/**
 * The one live turn this owner is watching, and everything it knows about it.
 *
 * Mutable and private: the getters above project frozen readings out of it, and
 * nothing outside this module holds it. One at a time, because one cycle is —
 * a follow-up registers its own and the one before it is retired by being
 * replaced.
 */
interface Watching {
  readonly at: ResponseAt;
  /** The agent and request this turn is being asked on behalf of. */
  readonly agent: string;
  readonly asked: "person" | "automatic";
  readonly title: string | undefined;
  /** Whether the canonical boundary has begun this turn. */
  begun: boolean;
  /** Whether its provider turn answered and its root is being run. */
  evaluating: boolean;
  /** The key this turn's own publication association named, or none. */
  sessionKey: string | undefined;
  shown: string;
  incomplete: boolean;
  revoked: boolean;
  /** The saved turn this became, once this request's records say so. */
  turn: number | null;
}

/** Which response a control belongs to, as the history addresses it. */
export interface ResponseAt {
  readonly conversation: string;
  readonly response: string;
}

/** One finished cycle, as the root reads it. */
export interface SidekickTurn {
  readonly conversation: string;
  /**
   * The turn this cycle became, or none where none is retained.
   *
   * None when the cycle failed before a canonical outcome was recorded for its
   * request. It is never a prediction: an ordinal this host guessed would be a
   * statement about whichever turn the conversation happened to be on.
   */
  readonly turn: number | null;
  readonly response: string;
  /** What the evaluated root rendered for the person, partial included. */
  readonly output: string;
  /** Whether the root selected person-facing chat at all. */
  readonly hasOutput: boolean;
  /** Why the cycle did not complete, when it did not. */
  readonly failure: string | undefined;
}

/**
 * What the response being generated has said so far, as a screen may show it.
 *
 * Process-local and detached: it is not in the chat history, it names no turn
 * and it survives nothing. The source it came from is already gone — what is
 * here is the literal Output the pure preview reader projected from a prefix
 * the execution cleared, and nothing a host, a writer or an append could be
 * reached through.
 */
export interface SidekickPreview {
  readonly conversation: string;
  /**
   * The response this belongs to, which is also what the acknowledged reply
   * will be addressed by. One item on the screen, from the first word of
   * generation to the evaluated reply that replaces it.
   */
  readonly response: string;
  /** The literal Output projected from what has arrived, which may be none. */
  readonly output: string;
  /**
   * The saved turn this attempt actually became, where one was acknowledged.
   *
   * None while the turn is in flight and none where nothing was saved for it:
   * a response is registered before the request is handed over and a turn is
   * numbered by Core, and the two are independent facts. Read from this
   * request's own records rather than guessed, so an attempt associated with a
   * turn is associated with the turn that really failed.
   *
   * It says which saved attempt this item is showing, not what the item is
   * called. The response above remains that, from the first word of generation
   * through the saved account that replaces it — which is the only thing this
   * association is for: a reader with no live item of its own addresses that
   * saved attempt by the turn it was.
   */
  readonly turn: number | null;
  /**
   * Generation ended without a saved outcome, so this is all there will be.
   *
   * A Stop can leave no Prompt record at all. What was on the screen is still
   * true — the agent did say it — so it stays, as an attempt that did not
   * finish rather than as a reply or as a turn anybody can name.
   */
  readonly incomplete: boolean;
}

/**
 * The turn this owner is running right now, as the Sessions reading shows it.
 *
 * Beside {@link SidekickPreview} rather than inside it, because the two answer
 * different questions. A preview is the text a response is saying, and exists
 * only while it is saying something; this is the *turn*, which exists from the
 * moment the canonical boundary began it — a turn that produces no Output is
 * still a turn somebody asked for, and a Sessions list that showed it only once
 * words arrived would lose the work that never says anything.
 *
 * Every member is a fact this owner actually observed. There is no `started`
 * here, because the provider does not report one to this publisher; and the
 * phase says what the owner is doing rather than what a record holds, because a
 * saved Prompt and an evaluated reply are separate facts.
 */
export interface SidekickLiveTurn {
  readonly conversation: string;
  /**
   * The response this turn is addressed by, from its first word to its reply.
   *
   * Registered before the request was handed over, so the acknowledged account
   * takes this row's place by being in it rather than beside it.
   */
  readonly response: string;
  /** The agent this conversation is held with. */
  readonly agent: string;
  /** What this turn was asked on behalf of, which this owner is the one asking. */
  readonly asked: "person" | "automatic";
  /** The exact message a person sent, for a person's turn. */
  readonly title: string | undefined;
  /**
   * How far this owner has actually got.
   *
   * `pending` is a request assembled and not yet begun canonically, `generating`
   * is a turn the canonical boundary began, and `evaluating` is a provider turn
   * that answered and whose root is being run. None of them names a saved
   * record: progress and recording are separate facts.
   */
  readonly phase: "pending" | "generating" | "evaluating";
  /**
   * The provider conversation an exact publication association named, or none.
   *
   * Its own publication's, for its own row, and only where the provider
   * actually supplied one. It establishes a filter this turn belongs to; it
   * does not make the turn saved.
   */
  readonly sessionKey: string | undefined;
  /** The saved turn this became, once this request's own records say so. */
  readonly turn: number | null;
  /** The literal Output projected from what has arrived, which may be none. */
  readonly output: string;
  /** Generation ended with no saved outcome, so this is all there will be. */
  readonly incomplete: boolean;
}

/** What the owner needs, and nothing it could reach the rest of the root with. */
export interface SidekickOwnerInput {
  readonly test?: ReplTesting;
  readonly workspace?: string;
  readonly assembly: SidekickAssembly;
  /** This execution's chat storage as it stands, which may hold nothing yet. */
  readonly chat: { readonly form: "legacy" } | PairedChatStorage;
  /**
   * Establish that storage for writing.
   *
   * The root's, because publishing a pair for an execution still held in the
   * older single file replaces the execution the root owns. Called by an
   * explicit instruction and by nothing else, which is what keeps reopening a chat
   * free of writes.
   */
  establish(): Operation<Result<PairedChatStorage>>;
  /** What a reply may read, and the shared draft it may fill. */
  readonly root: RootReading;
  /**
   * Admit the draft for one response, which the root performs.
   *
   * Handed in rather than performed here: a submission binds a reservation the
   * root owns the slot for, and this owner owns a conversation.
   */
  submit(at: ResponseAt, journal: ControlJournal): Operation<Result<SubmitReceipt>>;
  /** The chat revision this message clears, read when the message is sent. */
  revision(): number;
  /**
   * Say that this exact message has been saved, and wait for the root to apply it.
   *
   * Asked once the person's message is physically in the history and before
   * anything is prompted or evaluated, because the two halves belong together:
   * the box a person typed into is cleared because what they typed is now in
   * the file, and clearing it before the append landed would be clearing it on
   * a promise. The root queues the acknowledgement with its other reports and
   * answers when it has applied it, so a provider that completes immediately
   * cannot race that transition.
   *
   * `revision` is the message revision captured when the message was asked for.
   * Nothing newer is cleared: a person who typed again while the append was in
   * flight keeps what they typed.
   */
  acknowledge(revision: number): Operation<void>;
  /**
   * The shared entry draft as it stands.
   *
   * Read when a turn is assembled rather than carried: a reply revising a draft
   * it was shown several turns ago is revising something else. It is the loop's
   * state, like the revision above, so it is asked for rather than held.
   */
  draft(): string;
}

/** The conversation this execution owns, for as long as the caller holds it. */
export interface SidekickOwner {
  /**
   * Every change to what this owner would answer about itself.
   *
   * A notification and nothing more: it carries no reading, no authority and no
   * work. Whoever is drawing reads {@link SidekickOwner.reading} and
   * {@link SidekickOwner.busy} afresh when it fires, because a snapshot sent
   * through a stream is a snapshot that can arrive after the one that replaced
   * it.
   *
   * It exists because a chat moves while nobody is typing. A reply arrives, an
   * automatic follow-up starts, a cycle fails, a Stop joins — and a screen
   * drawn only when the terminal produced an event would show none of it until
   * the person happened to press a key.
   */
  readonly changes: Stream<void, never>;
  /**
   * The question this Sidekick is waiting on, and every change to it.
   *
   * Its own, not the session's. A reply may write canonical `<Elicit>`, and the
   * provider that presents it is installed in this owner's scope — so a
   * Sidekick question and an entry's question are two pending questions with
   * two answers, and answering either one leaves the other exactly where it
   * was. Whoever draws them reads two handles for that reason.
   */
  readonly questions: ReplElicitations;
  /**
   * What this history says, as it stands.
   *
   * A `Result`, because a chat history this version cannot read is a refusal
   * rather than an empty conversation: showing somebody no chat for a file that
   * holds one is the one answer that cannot be corrected later.
   */
  readonly reading: Result<SidekickReading>;
  /** Whether a cycle is running, so a second one refuses rather than queueing. */
  readonly busy: boolean;
  /**
   * What the response in flight has said so far, where one is saying anything.
   *
   * Outside {@link SidekickOwner.reading} deliberately: that is a projection of
   * the acknowledged history, and live text is acknowledged by nobody. It
   * changes through {@link SidekickOwner.changes} like everything else here, so
   * a screen showing it needs no keystroke to learn that more has arrived.
   */
  readonly previewing: SidekickPreview | undefined;
  /**
   * The turn this owner is running, where it is running one.
   *
   * Announced from the canonical boundary that begins the turn, so a Sessions
   * row exists for work that has said nothing yet. It is replaced by the saved
   * account of that turn once there is one, which is why it carries its own
   * response rather than a predicted ordinal.
   */
  readonly live: SidekickLiveTurn | undefined;
  /**
   * The provider conversations this owner has actually observed, earliest first.
   *
   * Kept for this owner's lifetime, because a filter somebody selected must not
   * become a guessed empty conversation when the attempt that established it
   * stops. It supplies no saved turn: a cold reopening of a location naming an
   * exclusively ephemeral key refuses, because the files establish no such
   * conversation.
   */
  readonly observed: readonly string[];
  /**
   * The agent this Sidekick would open a conversation with right now.
   *
   * Derived rather than remembered: it is the agent the active conversation was
   * opened with, because an established conversation never changes agent in
   * place — which is also how a reopened Sidekick keeps a selection this
   * process never made. Only with no conversation at all is it this command's
   * own selection.
   */
  readonly agent: string;
  /**
   * What the selected agent advertises right now.
   *
   * Explicit interaction only, and it sends no prompt: the provider inspects
   * the agent through a session of its own and gives it up, so nothing a person
   * reads in Configure costs them a turn. `model` and `effort` are `null` for a
   * setting the agent does not offer at all, which is a different answer from
   * offering choices none of which are the one asked for.
   *
   * Pass a model to read *that* model's effort levels: effort belongs to a
   * model, so the levels a person chooses between change with the model they
   * just selected and not at the turn after.
   */
  options(request?: AgentOptionsRequest): Operation<Result<AgentOptions>>;
  /**
   * Ask this conversation to run under this model and effort from now on.
   *
   * Recorded here and applied by the next turn, which is where an agent can
   * actually be asked and where a refusal costs nothing: a configuration is put
   * into effect before a turn's prompt is sent, so an agent that refuses one
   * leaves the turn unsent rather than half-done.
   *
   * The whole of what was asked for, every time, and never a patch. A
   * configuration that omits a setting asks for *no change* to it: the agent
   * stays on whatever it is already using, and nothing resets it to a default.
   * So an omitted effort neither carries a previous model's choice over nor
   * gives the setting back.
   *
   * Saving is not inspecting, so it works while this Sidekick is busy. It
   * opens no handle, asks the provider nothing and sends no turn — the turn
   * already running keeps the settings it was handed, and the next one reads
   * this. It needs an active conversation to belong to: during a first setup
   * that has not produced one yet there is nothing for it to be about, and it
   * refuses rather than attaching itself to whichever setup wins.
   */
  configure(desired: SessionConfiguration): Operation<Result<void>>;
  /**
   * Run this Sidekick's work under a different agent from now on.
   *
   * Explicitly a new conversation, because an established one never changes
   * agent in place: the chat a person has read stays exactly where it is and
   * the new conversation records which association it replaced. It becomes the
   * active one only once it is set up and the agent has answered for itself —
   * so a switch to an agent that cannot be reached is refused with that
   * agent's own reason, and the conversation a person was in is still theirs.
   * Nothing falls back to another agent, and nothing is sent.
   */
  select(agent: string): Operation<Result<void>>;
  /** Send one explicit message, and run the turn it produces. */
  message(text: string): Operation<Result<SidekickTurn>>;
  /**
   * Stop whatever this Sidekick is doing, and join it.
   *
   * Everything it had already done stands: the chat, the drafts, the records
   * and — above all — an entry it admitted, which belongs to the session and
   * goes on running on its own terms. What stops is the asking: the generation
   * in flight, the controls of the response being evaluated, the wait for an
   * entry's outcome, and any automatic turn that would have followed.
   *
   * Returns once all of that has come down. A Stop that returned early would
   * tell a person their Sidekick had stopped while it was still writing to
   * their history.
   */
  stop(): Operation<void>;
}

/** Which response this conversation's captured controls are answering for. */
interface ServingResponse {
  readonly test?: ReplTesting;
  readonly journal: ControlJournal;
  /** Admit the draft for this response, recording a refusal that wrote nothing. */
  submit(): Operation<Result<SubmitReceipt>>;
}

/** What a captured control refuses with when no response is running. */
const NO_RESPONSE_SERVING =
  "this control belongs to a Sidekick response that has finished, so there is nothing for it to " +
  "do: a control is admitted for the response that asked for it, and an answer filed after that " +
  "response joined would belong to whichever one came next.";

export function useSidekickOwner(input: SidekickOwnerInput): Operation<SidekickOwner> {
  return resource(function* (provide) {
    const { assembly, root } = input;
    /**
     * This owner's own scope, which is what a held conversation belongs to.
     *
     * Captured rather than inherited from whoever calls. `spawn` attaches to
     * the scope that is running, so a conversation opened from inside a message
     * would be held by *that message* — and released the moment it finished, or
     * the moment Stop halted it, leaving the next message with a handle naming
     * a conversation that had been closed. The conversation belongs to the
     * execution, so it is held here and released only when this owner is.
     */
    const mine = yield* useScope();
    /**
     * The response this conversation's controls are answering for, right now.
     *
     * A root is admitted from the selection its *execution* captured, so this
     * conversation's controls are installed and captured once, when the
     * conversation is opened, and not rebuilt per turn. What is still per
     * response is where a control's pair is filed and which slot a Submit
     * binds — so that travels through here instead of through the ceiling.
     *
     * Set for the duration of one response and cleared only after that
     * response's work and every cleanup it registered have joined, which is
     * what keeps one reply's controls out of another reply's records. Absent
     * means no response is running, and a control invoked then is a definition
     * somebody kept: it refuses rather than filing its pair under whichever
     * response happened to be next.
     */
    let serving: ServingResponse | undefined;
    function servingNow(): ServingResponse {
      const current = serving;
      if (current === undefined) {
        throw new Error(NO_RESPONSE_SERVING);
      }
      return current;
    }
    /**
     * The controls this conversation owns, built once against that indirection.
     *
     * Every control's body is the one the capture sealed; what it reads at
     * invocation is which response it belongs to. Two conversations are two
     * owners and therefore two sets of controls, so a reply in one still
     * cannot reach the other one's root.
     */
    const ceiling = sidekickResponseCeiling(
      sidekickRequests(
        root,
        function* (): Operation<Result<SubmitReceipt>> {
          return yield* servingNow().submit();
        },
        function* (path) {
          const test = servingNow().test;
          return test === undefined
            ? Err(new Error("this REPL host has no test runner"))
            : yield* test(path);
        },
      ),
      {
        *began(occurrence, reserved): Operation<number> {
          return yield* servingNow().journal.began(occurrence, reserved);
        },
        *settled(order, outcome, observed): Operation<void> {
          yield* servingNow().journal.settled(order, outcome, observed);
        },
      },
    );
    /** How this conversation's execution captures those controls, once. */
    const capturing = sidekickCeilingInstallation(ceiling);
    /**
     * Run one evaluation with this response named, and give the name back.
     *
     * `ensure` is registered before the work, so it unwinds after it: the
     * response stays named through the evaluation's own cleanup, which is where
     * a control's last pair can still be written. Clearing it earlier would
     * leave a settling control with nowhere to file.
     */
    function servingThrough<T>(response: ServingResponse, work: () => Operation<T>): Operation<T> {
      return scoped(function* () {
        const previous = serving;
        serving = response;
        yield* ensure(() => {
          serving = previous;
        });
        return yield* work();
      });
    }
    /**
     * This Sidekick's own questions.
     *
     * Installed here, in the scope the held conversation runs in, which is what
     * makes a reply's question *this owner's*: the root is evaluated inside the
     * conversation's own execution, so the provider it finds is the one
     * installed above it. An entry's questions keep reaching the session's
     * provider, in the session's scope, and nothing routes between them.
     */
    const asking = yield* useSidekickQuestions();
    /**
     * The storage this owner writes to, once something explicit established it.
     *
     * A message is the usual thing that does, and an explicit configuration of
     * an execution nobody has said anything in does too — what matters is that
     * acquiring the owner, drawing a frame or reopening establishes nothing.
     */
    let storage: PairedChatStorage | undefined =
      input.chat.form === "paired" ? input.chat : undefined;
    /**
     * The agent a *new* conversation would be opened with.
     *
     * Only ever consulted when there is no conversation to continue, because a
     * conversation carries its own agent. So this is the command's selection
     * for an execution that has never said anything, and what an agent change
     * leaves behind for the next one it opens.
     */
    let chosen = assembly.agent;
    /** The conversation handle being held open, and the task holding it. */
    let held:
      | {
          readonly conversation: string;
          readonly handle: AgentConversation;
          readonly task: Task<void>;
        }
      | undefined;
    /**
     * Where a change to this owner's own answers is announced.
     *
     * Owned here and closed with this owner, the way a session's own signals
     * are: a subscriber is a drawer waiting to be told to look again, and one
     * that outlived the thing it was watching would be waiting on a chat
     * nobody holds.
     */
    const changed = createSignal<void, never>();
    /** Announce that `reading` or `busy` would answer differently now. */
    function moved(): void {
      changed.send();
    }
    let busy = false;
    /** The cycle in flight, for Stop to halt and for its caller to wait on. */
    let working:
      | {
          readonly task: Task<void>;
          readonly answer: { resolve(answer: Result<SidekickTurn>): void };
          readonly operation: Operation<Result<SidekickTurn>>;
        }
      | undefined;
    let reading: Result<SidekickReading> = Ok(EMPTY);
    /**
     * The response whose generation this process is watching, where one is.
     *
     * One at a time, because one cycle is: a follow-up registers its own and
     * the one before it is retired by being replaced. `shown` is what has
     * actually been projected for a screen; a turn that has said nothing yet
     * has a slot and no preview.
     */
    let watching: Watching | undefined;
    /**
     * Every provider conversation this owner has genuinely been told about.
     *
     * An insertion-ordered set, because the order a filter offers these in is
     * the order they were observed and a list that reordered itself would move
     * the control somebody was reaching for.
     */
    const observed = new Set<string>();
    /**
     * The registration the next canonical turn's `begin()` is to consume.
     *
     * Set synchronously, immediately before the request is handed over, and
     * taken by the first turn that begins afterwards. It is not a correlation
     * by text, recency or ordinal: `begin()` turns it into a handle, and
     * everything after that is addressed by that exact object.
     */
    let registering: ResponseAt | undefined;
    /** Which response each begun turn belongs to, by the handle it began with. */
    const begun = new WeakMap<object, ResponseAt>();

    /**
     * The turn a Sessions reading would draw, or none because none is running.
     *
     * Unlike the preview below, an empty body is not an absence: the row exists
     * because the turn does.
     */
    function liveTurn(): SidekickLiveTurn | undefined {
      if (watching === undefined || watching.revoked) {
        return undefined;
      }
      return Object.freeze({
        conversation: watching.at.conversation,
        response: watching.at.response,
        agent: watching.agent,
        asked: watching.asked,
        title: watching.title,
        phase: watching.evaluating ? "evaluating" : watching.begun ? "generating" : "pending",
        sessionKey: watching.sessionKey,
        turn: watching.turn,
        output: watching.shown,
        incomplete: watching.incomplete,
      });
    }

    /** The preview a screen would draw, or none because nothing is being said. */
    function previewing(): SidekickPreview | undefined {
      if (watching === undefined || watching.revoked || watching.shown === "") {
        return undefined;
      }
      return Object.freeze({
        conversation: watching.at.conversation,
        response: watching.at.response,
        output: watching.shown,
        incomplete: watching.incomplete,
        turn: watching.turn,
      });
    }

    /**
     * Take the live slot down, because what it was watching is over.
     *
     * Called where the acknowledged history has taken over — a reply or a saved
     * failed turn is now the thing on the screen — and where a new explicit
     * cycle replaces it. A revoked slot is told nothing further: a notification
     * for it changes no screen.
     */
    function unwatch(): void {
      if (watching === undefined) {
        return;
      }
      watching.revoked = true;
      watching = undefined;
      moved();
    }

    /**
     * Keep what was shown, as an attempt that did not finish.
     *
     * For a generation that ended with nothing saved: the agent did say this,
     * and saying so states no turn, no acceptance and no failure anybody
     * recorded. A slot with nothing shown simply goes.
     *
     * A saved turn is passed where this request's own records establish one,
     * and passing none leaves whatever was already established alone. That
     * matters because this runs twice for one failure — once where the records
     * are read, and again as the response unwinds — and a cleanup that forgot
     * the association would hand the acknowledged attempt back to the history's
     * own identity while this item is still the one on the screen.
     */
    function interrupted(turn?: number): void {
      if (watching === undefined) {
        return;
      }
      if (watching.shown === "") {
        unwatch();
        return;
      }
      watching.incomplete = true;
      if (turn !== undefined) {
        // Which saved attempt this item is now showing, where this request's
        // own records establish one. It does not rename the item: the response
        // the slot was registered under is still what the row is addressed by,
        // and this is what lets the saved account take the place of the live
        // one inside it rather than beside it.
        watching.turn = turn;
      }
      moved();
    }

    /**
     * This conversation's own publisher: it begins each turn, is shown what the
     * turn says, and appends the record that ends it.
     *
     * Installed inside the conversation's execution rather than around
     * `message()`, because the turn runs there. Its `publish` appends exactly
     * what it was handed, once: a live observation cannot acknowledge a turn,
     * and this host never substitutes a record of its own.
     */
    const publisher: AgentPromptPublisher = {
      *begin(): Operation<AgentPromptHandle> {
        const slot = registering;
        registering = undefined;
        // A fresh object every turn, even for identical input: identity is the
        // whole mechanism, so two turns that look alike are still two turns.
        const handle = {};
        if (slot !== undefined) {
          begun.set(handle, slot);
        }
        if (slot !== undefined && watching !== undefined && watching.at === slot) {
          // The turn exists now, so the Sessions row does. Announced here and
          // not at the first delta, because a turn that produces no Output is
          // still work this execution did — and the preview's empty-text rule
          // cannot be the test for whether a turn happened.
          watching.begun = true;
          moved();
        }
        return handle;
      },
      *observe({ begun: handle, text }): Operation<void> {
        const slot = typeof handle === "object" && handle !== null ? begun.get(handle) : undefined;
        if (slot === undefined || watching === undefined || watching.at !== slot) {
          // A turn this process is no longer watching: stopped, replaced, or
          // already answered. It changes nothing.
          return;
        }
        if (text === null) {
          // Withdrawn. What was on the screen goes, and nothing further about
          // this turn will arrive.
          watching.shown = "";
          moved();
          return;
        }
        // The pure reader, on a prefix the execution already cleared. A refusal
        // takes the body away rather than showing source: a preview that cannot
        // be read as a root is not something to put in front of somebody.
        const read = previewGeneratedXmdRoot(text);
        const shown = read.ok ? read.value.output : "";
        if (shown === watching.shown) {
          return;
        }
        watching.shown = shown;
        moved();
      },
      *publish(publication): Operation<void> {
        const slot =
          typeof publication.begun === "object" && publication.begun !== null
            ? begun.get(publication.begun)
            : undefined;
        const key = publication.association?.sessionKey;
        // This publication's own association, for the exact row it began. A
        // key established here makes that live turn a member of its provider
        // conversation before anything is acknowledged; it does not make the
        // turn saved, and it says nothing about any other row.
        if (
          slot !== undefined &&
          watching !== undefined &&
          watching.at === slot &&
          key !== undefined &&
          key.length > 0
        ) {
          watching.sessionKey = key;
          observed.add(key);
          // Said before the append is waited on: a filter somebody selected
          // while the record is still in flight has a turn to show.
          moved();
        }
        yield* publication.append();
      },
    };

    /** Install that publisher, as one of the conversation's installations. */
    function* watcher(): Operation<void> {
      yield* useAgentPromptPublisher(publisher);
    }

    /**
     * Re-read this history.
     *
     * From the writer rather than from the snapshot the storage was opened
     * with, because the writer is what knows the file: it accumulates what this
     * process appended on top of what it read, and a projection of the opening
     * snapshot would describe the history as it was before this process said
     * anything.
     */
    function* refresh(): Operation<void> {
      reading = projectSidekick(storage === undefined ? [] : yield* storage.writer.readAll());
      // Every re-read is a change somebody may be looking at: a message landing,
      // a reply, a failed turn and a configuration all come through here.
      moved();
    }

    // Once, at acquisition, so a reopened Sidekick knows its conversation and
    // its chat before anybody says anything — and knows them without a write,
    // a provider or a turn.
    yield* refresh();

    /**
     * Hold one conversation open for as long as this owner has it.
     *
     * Acquired in a task of its own, which is what makes "open" a lifetime
     * rather than a call: the handle is live until that task is halted, and the
     * task belongs to *this owner's* scope rather than to whichever message
     * happened to open it — so releasing the owner closes the conversation and
     * joins whatever it was running, and a message ending or being stopped
     * leaves it open for the next one.
     */
    function* open(
      conversation: string,
      agent: string,
      writer: SidekickWriter,
      records: readonly SidekickRecord[],
    ): Operation<Result<AgentConversation>> {
      const ready = withResolvers<Result<AgentConversation>>();
      const task = mine.run(function* (): Operation<void> {
        const directory = input.workspace;
        if (directory !== undefined) {
          yield* API.Env.around(
            {
              *cwd() {
                return directory;
              },
            },
            { at: "min" },
          );
        }
        const opened = yield* useAgentConversation({
          history: conversationStream(writer, conversation, records),
          id: conversation,
          agent,
          // This conversation's own publisher, beside what the assembly
          // installs. It goes inside the conversation's execution because that
          // is where its turns run: installed around `message()` instead, it
          // would be in a scope the saved conversation does not execute in.
          installations: [...assembly.installations, capturing, { install: () => watcher() }],
        });
        ready.resolve(opened);
        if (!opened.ok) {
          return;
        }
        // Held. The resource stays acquired until this task is halted, which is
        // what the caller does when the conversation changes and what this
        // owner's own teardown does when it ends.
        yield* suspend();
      });
      const opened = yield* ready.operation;
      if (!opened.ok) {
        yield* task.halt();
        return opened;
      }
      held = { conversation, handle: opened.value, task };
      return opened;
    }

    /**
     * This history as it stands, read rather than remembered.
     *
     * Every refresh replaces it, so a guard earlier in an operation says
     * nothing about the reading after one — which is a fact about the value and
     * not only about how it narrows.
     */
    function history(): Result<SidekickReading> {
      return reading;
    }

    /**
     * Let go of the conversation being held open, if one is.
     *
     * Cleared before it is halted, so nothing that runs during the halt reads a
     * handle naming a conversation that is already closing.
     */
    function* release(): Operation<void> {
      const taken = held;
      if (taken === undefined) {
        return;
      }
      // Whatever was being shown belonged to this conversation. A replacement
      // starts somewhere else, and one conversation's candidate is not a thing
      // to leave on the screen in front of another's.
      unwatch();
      held = undefined;
      yield* taken.task.halt();
    }

    /** The agent one of this history's conversations was opened with. */
    function agentOf(known: SidekickReading, conversation: string): string {
      // Falls back to the selection for a conversation this reading does not
      // hold, which cannot happen for one it just named active — and if it
      // ever did, opening it under this command's agent is the only answer
      // there is.
      return known.conversations.find((one) => one.id === conversation)?.agent ?? chosen;
    }

    /** The agent this Sidekick would open a conversation with right now. */
    function selection(): string {
      if (!reading.ok) {
        return chosen;
      }
      const active = reading.value.active;
      return active === undefined ? chosen : agentOf(reading.value, active);
    }

    /** The conversation an explicit message continues, opening one if needed. */
    function* conversing(
      paired: PairedChatStorage,
      known: SidekickReading,
    ): Operation<Result<{ readonly id: string; readonly handle: AgentConversation }>> {
      const active = known.active;
      if (held !== undefined && held.conversation === active) {
        return Ok({ id: held.conversation, handle: held.handle });
      }
      // A different conversation is active than the one being held, so the held
      // one is released before another is opened: one conversation at a time,
      // and the handle that is no longer current must not stay open.
      yield* release();
      const records = yield* paired.writer.readAll();
      if (active !== undefined) {
        // Under the agent *that conversation* was opened with, which is not
        // necessarily this command's selection: a conversation never changes
        // agent in place, so continuing one under a flag's agent would continue
        // somebody else's conversation under a name it never had.
        const opened = yield* open(active, agentOf(known, active), paired.writer, records);
        return opened.ok ? Ok({ id: active, handle: opened.value }) : opened;
      }
      // A fresh conversation. Prepared before it is opened, because setup can
      // fail and a preparation nobody wrote down is a conversation that cannot
      // be told apart from one that never began.
      const agent = selection();
      const id = yield* ReplHost.operations.identify();
      yield* paired.writer.append({
        kind: "conversation",
        conversation: id,
        agent,
        phase: "prepared",
      });
      const opened = yield* open(id, agent, paired.writer, records);
      if (!opened.ok) {
        // Failed setup activates no replacement, and the association that
        // preceded it — there is none here, and there will be when an agent
        // change opens one — stays exactly as it was.
        yield* paired.writer.append({
          kind: "conversation",
          conversation: id,
          agent,
          phase: "failed",
          error: serializeError(opened.error),
        });
        yield* refresh();
        return opened;
      }
      yield* paired.writer.append({
        kind: "conversation",
        conversation: id,
        agent,
        phase: "activated",
      });
      yield* refresh();
      return Ok({ id, handle: opened.value });
    }

    function* message(text: string): Operation<Result<SidekickTurn>> {
      if (busy) {
        return Err(
          new SidekickOwnerError(
            "the Sidekick is already working on a message. One conversation takes one turn at a " +
              "time.",
          ),
        );
      }
      if (!reading.ok) {
        // An unreadable history is raised, never answered. Sending a turn on
        // top of one would add to an account nobody can read.
        return reading;
      }
      busy = true;
      // Said before anything suspends, because busy is what the screen draws
      // while this runs: a notification sent only once the provider answered
      // would leave the person looking at an idle screen for the whole turn.
      moved();
      // Read now, not when the record is written. Establishing storage for a
      // legacy execution publishes a pair, and a person typing while that
      // happens has a newer message than the one they sent — so the revision
      // this message is recorded under and later cleared by is the one that was
      // true when they asked for it.
      const revision = input.revision();
      // Spawned, so Stop has something to halt. The cycle suspends in three
      // places a person may want out of — provider generation, a response's
      // controls, and a Submit waiting for its entry — and none of them can be
      // interrupted by a flag read between them. A task can be halted wherever
      // it happens to be, and halting joins its teardown.
      //
      // In this caller's scope rather than the owner's, so work nobody is
      // waiting for cannot outlive the thing that asked for it.
      const answer = withResolvers<Result<SidekickTurn>>();
      const task = yield* spawn(function* (): Operation<void> {
        answer.resolve(yield* cycle(text, revision));
      });
      const held = { task, answer, operation: answer.operation };
      working = held;
      try {
        return yield* answer.operation;
      } finally {
        // Only if this cycle is still the one in flight. Stop releases the
        // owner itself, so by the time this runs a new message may already have
        // taken it — and clearing then would be clearing somebody else's.
        if (working === held) {
          working = undefined;
          busy = false;
          // However this ended — answered, refused or halted — the screen is
          // no longer showing work in flight.
          moved();
        }
      }
    }

    function* stop(): Operation<void> {
      const held = working;
      if (held === undefined) {
        // Nothing is running, so there is nothing to stop — and nothing is
        // undone either. Stop is not a way to discard a conversation.
        return;
      }
      // Halting cancels the generation, the controls and the wait wherever the
      // cycle is, and returns only once all of it has come down — so a person
      // who pressed Stop is not left with work still running behind a screen
      // that says it stopped.
      //
      // Revocation comes with it rather than before it. A reservation this
      // Sidekick holds withdraws itself as its own submission unwinds, because
      // `live` means "the asker still wants this" and a cancelled submission is
      // the asker not wanting it — so it is answered by the thing that owns the
      // reservation instead of by a separate call that has to be sequenced
      // correctly. Teardown finishes before this returns, so the withdrawal is
      // in place by the time Stop answers.
      //
      // The entry is not among what comes down. An admitted entry belongs to
      // the session's own task, and this was only ever waiting for it; what
      // stops here is the waiting.
      yield* held.task.halt();
      // Re-read, because the cycle was writing to this history when it stopped
      // and its own refresh never ran. What the root shows after Stop has to be
      // what is on disk — including the intent of a submission that began and
      // whose result nobody knows, which is exactly the state Stop leaves.
      yield* refresh();
      // Released here rather than left to the caller's own return. A person who
      // has stopped the Sidekick can say something to it immediately, and the
      // caller of the stopped message has not necessarily been scheduled yet —
      // so waiting for its own bookkeeping would refuse the next message for
      // reasons nobody can see.
      if (working === held) {
        working = undefined;
        busy = false;
      }
      held.answer.resolve(
        Err(
          new SidekickOwnerError(
            "the Sidekick was stopped. Nothing it had already done was undone, and an entry it " +
              "admitted is still running.",
          ),
        ),
      );
    }

    /**
     * Establish this execution's storage for writing, if it is not already.
     *
     * The first explicit *anything* is what upgrades an execution still held in
     * the older single file — a message, a configuration read, a model a person
     * asked for. What keeps reopening free of writes is that none of those
     * happen until a person does something, not that only a message counts.
     */
    function* established(): Operation<Result<PairedChatStorage>> {
      if (storage !== undefined) {
        return Ok(storage);
      }
      const made = yield* input.establish();
      if (!made.ok) {
        return made;
      }
      storage = made.value;
      yield* refresh();
      const settled = history();
      return settled.ok ? Ok(made.value) : settled;
    }

    /** One conversation, established and open, for an explicit interaction to use. */
    function* holding(): Operation<
      Result<{
        readonly paired: PairedChatStorage;
        readonly id: string;
        readonly handle: AgentConversation;
      }>
    > {
      const paired = yield* established();
      if (!paired.ok) {
        return paired;
      }
      const known = history();
      if (!known.ok) {
        return known;
      }
      const opened = yield* conversing(paired.value, known.value);
      return opened.ok
        ? Ok({ paired: paired.value, id: opened.value.id, handle: opened.value.handle })
        : opened;
    }

    function* options(request?: AgentOptionsRequest): Operation<Result<AgentOptions>> {
      if (busy) {
        // The conversation runs one thing at a time, and an inspection is one
        // of them. Refused here rather than at the mailbox so the reason names
        // the Sidekick a person is looking at.
        return Err(
          new SidekickOwnerError(
            "the Sidekick is working on a message, and one conversation does one thing at a " +
              "time. Stop it to read what its agent offers.",
          ),
        );
      }
      const ready = yield* holding();
      if (!ready.ok) {
        return ready;
      }
      // Through the conversation, because that is where this host's provider is
      // reachable from — the provider is installed around a live document, and
      // this conversation's execution is the one holding it open. It is still
      // an inspection: the provider takes a session of its own for it, sends no
      // prompt and journals nothing.
      return yield* ready.value.handle.options(request);
    }

    function* configure(desired: SessionConfiguration): Operation<Result<void>> {
      // Saving is not inspecting. A preference is a record in this history and
      // nothing else: it opens no handle, asks the provider nothing and sends no
      // turn, so there is nothing about a running cycle that it has to wait for.
      // What it needs is a conversation to belong to.
      //
      // Captured before anything suspends, and bound to *that* conversation:
      // the append below may wait behind another write, and whichever
      // conversation happens to be active by then is not the one the person was
      // looking at when they chose this.
      const held = reading.ok ? reading.value.active : undefined;
      const requested: SessionConfiguration = {
        ...(desired.model === undefined ? {} : { model: desired.model }),
        ...(desired.effort === undefined ? {} : { effort: desired.effort }),
      };
      if (held !== undefined) {
        if (!reading.ok) {
          // An unreadable history is raised rather than answered: adding to an
          // account nobody can read is how one history becomes two.
          return reading;
        }
        const paired = yield* established();
        if (!paired.ok) {
          return paired;
        }
        return yield* saving(paired.value, held, requested);
      }
      if (busy) {
        // Working, and no conversation active yet — so this is a first setup
        // somewhere in flight, and there is nothing for the save to belong to.
        // Refused rather than queued: attaching it afterwards to whichever
        // setup won would be saving a preference for a conversation the person
        // never saw.
        return Err(
          new SidekickOwnerError(
            "the Sidekick is still opening its first conversation, so there is nothing yet for " +
              "this setting to belong to. Ask again once it has said something.",
          ),
        );
      }
      // Idle and with nothing active: the first explicit configuration
      // establishes the conversation it is for, exactly as it did before.
      const ready = yield* holding();
      if (!ready.ok) {
        return ready;
      }
      return yield* saving(ready.value.paired, ready.value.id, requested);
    }

    /**
     * Write one complete preference down, for the conversation it was asked of.
     *
     * `null` for a setting this asks nothing for, because the record is the
     * whole of what a person asked for: a member that is simply absent would
     * make "leave the effort alone" and "I never said" the same entry. An
     * omitted setting asks for no change to it and resets nothing — the native
     * setting stays whatever the agent is already on.
     */
    function* saving(
      paired: PairedChatStorage,
      conversation: string,
      requested: SessionConfiguration,
    ): Operation<Result<void>> {
      yield* paired.writer.append({
        kind: "preferences",
        conversation,
        model: requested.model ?? null,
        effort: requested.effort ?? null,
      });
      yield* refresh();
      const settled = history();
      return settled.ok ? Ok(undefined) : settled;
    }

    function* select(agent: string): Operation<Result<void>> {
      if (busy) {
        return Err(
          new SidekickOwnerError(
            "the Sidekick is working on a message. Stop it before changing agent, so what it " +
              "was doing comes down before another conversation starts.",
          ),
        );
      }
      if (!reading.ok) {
        // An unreadable history is raised rather than answered. Opening a
        // conversation on top of one would add to an account nobody can read.
        return reading;
      }
      if (agent === selection()) {
        // Already this agent, so there is nothing to replace. Starting a
        // conversation anyway would discard the one a person is in to arrive
        // where they already are.
        return Ok(undefined);
      }
      const paired = yield* established();
      if (!paired.ok) {
        return paired;
      }
      const known = history();
      if (!known.ok) {
        return known;
      }
      // Read before anything is released, because this is the association a
      // failure has to leave standing.
      const previous = known.value.active;
      chosen = agent;
      // One conversation at a time. The handle goes; the *association* is what
      // survives a failed replacement, and that is what the history says rather
      // than what this process is holding open.
      yield* release();
      const records = yield* paired.value.writer.readAll();
      const id = yield* ReplHost.operations.identify();
      yield* paired.value.writer.append({
        kind: "conversation",
        conversation: id,
        agent,
        phase: "prepared",
        ...(previous === undefined ? {} : { previous }),
      });
      const opened = yield* open(id, agent, paired.value.writer, records);
      // Set up, and then asked to answer for itself. Opening a conversation
      // reaches no agent — it places no session and performs no turn — so a
      // replacement that was only opened would activate under an agent nobody
      // has heard from, and every message afterwards would fail while the
      // conversation a person could still have used had been given up. An
      // inspection is the one thing that reaches an agent without asking it for
      // a turn, so it is what "set up" means here.
      const answered: Result<unknown> = opened.ok ? yield* opened.value.options() : opened;
      if (!answered.ok) {
        // The replacement that did not answer is let go of rather than left
        // open: it is not this Sidekick's conversation, and nothing will use it.
        yield* release();
        yield* paired.value.writer.append({
          kind: "conversation",
          conversation: id,
          agent,
          phase: "failed",
          error: serializeError(answered.error),
        });
        yield* refresh();
        // Said in the agent's own words, with no substitution: a Sidekick that
        // quietly carried on under the previous agent would answer as something
        // other than what a person selected.
        return answered;
      }
      yield* paired.value.writer.append({
        kind: "conversation",
        conversation: id,
        agent,
        phase: "activated",
      });
      yield* refresh();
      const settled = history();
      return settled.ok ? Ok(undefined) : settled;
    }

    function* cycle(text: string, revision: number): Operation<Result<SidekickTurn>> {
      const known = history();
      if (!known.ok) {
        return known;
      }
      // Refused before anything is placed, written or sent. A delivery this
      // history cannot establish means a turn the provider may already have
      // accepted and whose outcome nobody recorded — so continuing would
      // either resend work that was taken or carry on as though it never was,
      // and both are guesses about a turn that really happened. The reading
      // keeps reporting it; nothing here resolves it by choosing.
      const unresolved = known.value.unestablished.filter(
        (one) => one.conversation === known.value.active,
      );
      if (unresolved.length > 0) {
        return Err(
          new SidekickOwnerError(
            "this conversation holds feedback whose acceptance cannot be established: a turn " +
              "carrying it may have been taken and its outcome was never recorded. Sending " +
              "another would either repeat work the agent already has or continue as though it " +
              "never happened, and this history cannot tell which.",
          ),
        );
      }
      const ready = yield* holding();
      if (!ready.ok) {
        return ready;
      }
      const { paired, id: conversation, handle } = ready.value;

      // One message, then as many turns as the reply's own operations ask for.
      // No cap: each pass costs a provider turn, a response that asked for
      // nothing ends it, and a provider failure pauses — so what bounds this is
      // the conversation itself rather than a number chosen here.
      let sending: Sending = { kind: "message", text, revision };
      let last: SidekickTurn | undefined;
      while (true) {
        const responded: Result<Responded> = yield* respond(paired, conversation, handle, sending);
        if (!responded.ok) {
          // A turn that could not be sent at all. Whatever an earlier response
          // in this exchange answered stands, so that is the answer; with none,
          // the refusal is.
          return last === undefined ? responded : Ok(last);
        }
        const settled: SidekickTurn = responded.value.held;
        if (!responded.value.answered) {
          // The provider did not finish this turn, so it answered nobody. An
          // earlier response in this exchange may have, and that is what the
          // person was answered by; the attempt itself is in the chat either
          // way.
          return Ok(last ?? settled);
        }
        last = settled;
        if (responded.value.next === undefined) {
          return Ok(settled);
        }
        sending = { kind: "feedback", of: settled.response, text: responded.value.next };
      }
    }

    /**
     * Send one turn, run what it answers with, and say what the next turn owes.
     *
     * Everything that belongs to one turn is here, which is why the ordinal,
     * the response identity and the journal are all established inside it: two
     * turns are two responses, and a journal shared between them would file one
     * reply's controls under the other's response.
     *
     * The *ceiling* is not among them any more. A root is admitted from the
     * selection its execution captured, so the controls were installed and
     * sealed when this conversation opened; what one turn still establishes is
     * which response they answer for, which travels through `serving`.
     */
    function* respond(
      paired: PairedChatStorage,
      conversation: string,
      handle: AgentConversation,
      sending: Sending,
    ): Operation<Result<Responded>> {
      // Re-read, because the turn before this one wrote to the history: the
      // ordinal and whether this conversation has been oriented are both facts
      // about the file as it stands now.
      const current = reading;
      if (!current.ok) {
        return current;
      }
      const turn = nextTurn(current.value, conversation);
      const response = `response:${turn}`;
      const at: ResponseAt = { conversation, response };
      const written = controlJournal(paired.writer, at);
      /**
       * Refusals that produced no record, and where they happened.
       *
       * A Submit refused before it reserved anything writes nothing, and that
       * is right: a reservation that was never taken has no outcome to record,
       * and a chat history noting every refused ask would assert attempts the
       * entry history has no trace of. The reply still has to be told, so the
       * refusal is carried here instead — with the order the next pair takes,
       * which is where it happened.
       */
      const refused: { order: number; component: string; reason: string }[] = [];
      let pairs = 0;
      const journal: ControlJournal = {
        *began(occurrence, reserved): Operation<number> {
          pairs += 1;
          return yield* written.began(occurrence, reserved);
        },
        *settled(order, outcome, observed): Operation<void> {
          yield* written.settled(order, outcome, observed);
        },
      };
      /**
       * What this turn's controls file under, and the slot its Submit binds.
       *
       * The controls themselves were captured when the conversation opened, so
       * this is the whole of what is still this response's: its journal, and a
       * submission that records a refusal which produced no record.
       */
      const responding: ServingResponse = {
        journal,
        ...(input.test === undefined ? {} : { test: input.test }),
        *submit(): Operation<Result<SubmitReceipt>> {
          const taken = pairs;
          const answer = yield* input.submit(at, journal);
          if (!answer.ok && pairs === taken) {
            refused.push({
              order: taken,
              component: "REPL.Submit",
              reason: answer.error.message,
            });
          }
          return answer;
        },
      };

      let request = sending.text;
      /**
       * Where this request's records begin, once its first record is written.
       *
       * The owner writes that record before it asks the provider for anything,
       * so its position is what bounds the lookup below: the turn this request
       * became is the one saved among its own records, and nowhere else.
       */
      let began: number | undefined;
      /**
       * The response whose recovered work this turn is carrying, when it is.
       *
       * A message turn can carry an interrupted response's account the way a
       * feedback turn carries a finished one's results, so what it states
       * afterwards is the same statement and is established the same way.
       */
      let carried: string | undefined;
      if (sending.kind === "message") {
        // Orientation goes with a turn when this conversation has no
        // canonically completed turn — the only fact that establishes an agent
        // has been told anything. An ordinal is not evidence, and neither is a
        // record of this CLI's own.
        const known = current.value.conversations.find((one) => one.id === conversation);
        const first = (known?.completed.length ?? 0) === 0;
        let context: TurnContext | undefined;
        // Assembled whenever there is something to compare against, which is
        // every turn after the first: the assets and the ceiling are fixed for
        // the life of one build, so what this costs is three reads and three
        // digests, and what it buys is noticing that a *newer* build would
        // orient this agent differently.
        const assembled =
          first || known?.oriented !== undefined
            ? yield* turnContext({
                admitted: new Set(
                  ceiling.controls.filter((one) => one.effect === "read").map((one) => one.name),
                ),
                surface: responseSurface(ceiling),
              })
            : undefined;
        if (assembled !== undefined && !assembled.ok) {
          // A first turn cannot go without its orientation: an agent asked to
          // write a response it was never told the vocabulary of is being asked
          // to guess. A later turn can — it keeps the orientation it already
          // has, which is what it had a moment ago — so an unreadable asset
          // refuses the one and skips the refresh for the other.
          if (first) {
            return assembled;
          }
        } else if (
          assembled !== undefined &&
          (first || orientationChanged(assembled.value.versions, known?.oriented))
        ) {
          context = assembled.value;
          yield* paired.writer.append({
            kind: "reference",
            conversation,
            turn,
            bootstrap: context.bootstrap,
            index: context.index,
            surface: context.surface,
            versions: context.versions,
          });
        }
        // What an interrupted response of this conversation actually did, when
        // one is still unaccounted for. Composed from the retained records
        // rather than from anything this process remembers, because this
        // process is not the one that was interrupted.
        const held = yield* unaccounted(paired, current.value, conversation);
        const recovered =
          held === undefined ? undefined : recoveredWork(yield* paired.writer.readAll(), held);
        request = turnRequest({
          context,
          recovered,
          draft: input.draft(),
          message: sending.text,
        });
        if (held !== undefined && recovered !== undefined) {
          carried = held.response;
          // Retained before it is sent, and asserting nothing — the same
          // feedback text a feedback turn writes, for the same reason: an
          // interrupted process
          // leaves a readable account of what it was sending and no assertion
          // that any turn took it. It holds the whole request, because that is
          // what the turn is sent and what its canonical record can be
          // compared against.
          yield* paired.writer.append({
            kind: "feedback",
            conversation,
            response: held.response,
            turn: null,
            text: request,
          });
        }
        yield* paired.writer.append({
          kind: "message",
          conversation,
          turn,
          revision: sending.revision,
          text: sending.text,
        });
        // The message begins this request's records, superseding any feedback
        // text written just before it: the turn that follows is the person's
        // request, and the recovered account travels with it.
        began = (yield* paired.writer.readAll()).length - 1;
        // Now the message is in the file, and only now. The box it was typed
        // into is cleared because the history holds it — so this waits for the
        // root to have applied that, before a prompt is sent and before a reply
        // that came back immediately could report anything of its own.
        yield* refresh();
        yield* input.acknowledge(sending.revision);
      } else {
        // Claimed before it is sent, and claiming nothing: an interrupted
        // process left a readable "this was composed" and no assertion that any
        // turn took it. What a turn carried is established by the canonical
        // record of that turn, never by this CLI having meant to send it.
        yield* paired.writer.append({
          kind: "feedback",
          conversation,
          response: sending.of,
          turn: null,
          text: request,
        });
        began = (yield* paired.writer.readAll()).length - 1;
      }

      /**
       * This turn's own live slot, and the registration its `begin()` consumes.
       *
       * Placed here rather than immediately above the call: the preference read
       * below must be the last thing before the handoff, and registering is
       * local bookkeeping that nothing between can consume — one conversation
       * runs one turn at a time, so the next canonical `begin()` in this
       * execution is this request's.
       *
       * Its cleanup is established before anything suspends, and it names this
       * exact slot: a follow-up turn registers its own, and a stale cleanup
       * must not take down the screen the next turn is drawing.
       */
      const live: Watching = {
        at,
        // This conversation's own agent, read from the history rather than from
        // whichever agent this command was started with: a conversation never
        // changes agent in place, so its row says what answered in it.
        agent: agentOf(current.value, conversation),
        asked: sending.kind === "message" ? ("person" as const) : ("automatic" as const),
        // A person's own words, and nothing for a delivery of a response's
        // results: that request is this host's account of what a reply did, and
        // it is not something anybody said.
        title: sending.kind === "message" ? sending.text : undefined,
        begun: false,
        evaluating: false,
        sessionKey: undefined,
        shown: "",
        incomplete: false,
        revoked: false,
        turn: null,
      };
      watching = live;
      registering = at;
      yield* ensure(() => {
        if (watching === live) {
          // Cancelled or unwound before anything saved the outcome. What was
          // shown stays, as an attempt that did not finish.
          interrupted();
        }
      });

      // Under what this conversation was asked to run under, every turn of it.
      // A preference is a standing fact about the conversation rather than a
      // one-shot: the provider writes nothing for a setting already selected,
      // and a turn that carried the request only once would leave a later one
      // running under whatever a restarted agent came up on.
      //
      // Read *here*, from the records as they stand, rather than from the
      // snapshot this response started with. Everything above suspended — the
      // orientation, the retained message, the root's acknowledgement of it —
      // and somebody may have saved a setting while it did. The snapshot still
      // supplies the ordinal and what this conversation has been told, which a
      // preference write does not change; it cannot supply this.
      const settings = projectSidekick(yield* paired.writer.readAll());
      if (!settings.ok) {
        // An unreadable history refuses rather than falling back to an older
        // preference: sending a turn under settings this history cannot
        // establish is the one outcome nobody can correct afterwards.
        return settings;
      }
      // And handed over immediately. Nothing between this choice and the call
      // may suspend: a save acknowledged in that gap belongs to the next turn,
      // and a turn that picked up a setting after Core had its request would be
      // running under one thing while the history says another.
      const replied = yield* handle.prompt(request, desired(settings.value, conversation));
      if (!replied.ok) {
        // No control runs: a partial, failed or cancelled response is source
        // nobody completed, and evaluating it would perform effects from a
        // program the agent did not finish writing.
        //
        // And nothing is appended. A `response` record is the outcome of a
        // *completed* turn — the projection refuses one whose owning turn the
        // canonical journal does not hold, and rightly, because publishing a
        // reply for a turn that never completed would show somebody a
        // conversation the provider never had. The account of a failed attempt
        // is already on disk: the saved turn holds its status and
        // whatever it streamed, and the projection reads it as the incomplete
        // attempt it is.
        //
        // It also ends the exchange. A provider that failed is not a reply to
        // correct, so the next move is a person's.
        yield* refresh();
        const attempted = yield* turnForRequest(paired, began, conversation);
        // Kept as an attempt that did not finish, told which turn this
        // request's own records say it became. With none, it claims no turn, no
        // acceptance and no recorded failure; with one, the saved account of
        // that turn is shown inside this item rather than beside it, so the
        // screen holds one account of one failure.
        interrupted(attempted?.turn);
        return Ok({
          held: {
            conversation,
            // No prediction. A failure before anything was retained for this
            // request claims no saved turn, because none is its to claim.
            turn: attempted?.turn ?? null,
            response,
            output: attempted?.text ?? "",
            hasOutput: false,
            failure: replied.error.message,
          },
          answered: false,
          next: undefined,
        });
      }
      // Which turn this actually was, from Core's own record of it among this
      // request's own records. Everything below states something about that
      // turn — a reply belongs to it, a delivery was carried by it — and a
      // statement made against a predicted ordinal is a statement about
      // whichever turn the conversation happened to be on.
      const settled = yield* turnForRequest(paired, began, conversation);
      if (settled === undefined) {
        // The provider answered and this request retained no saved turn.
        // There is nothing to publish a reply against: a response belongs to a
        // turn, and the only candidate here would be an ordinal this host made
        // up. So it is refused rather than attributed, and what the provider
        // said is still on disk for a later reading to account for.
        return Err(
          new SidekickOwnerError(
            "this turn's canonical record is not in this history, so the reply it produced " +
              "belongs to no turn this conversation can name. It is not published against a " +
              "guessed one.",
          ),
        );
      }
      const actual = settled.turn;
      if (watching === live) {
        // Which saved turn this row is showing, and that the root is now being
        // run. Said together because they became true together: the provider
        // finished its turn, its record is in this history, and what happens
        // next is the evaluation — which is a different fact from the turn
        // having been saved and is reported as one.
        live.turn = actual;
        live.evaluating = true;
        moved();
      }
      const delivering = sending.kind === "feedback" ? sending.of : carried;
      if (delivering !== undefined) {
        // The turn accepted it, so now the claim can be made — and it names the
        // exact text, because a delivery is established by a completed turn
        // having been sent *this*.
        yield* paired.writer.append({
          kind: "feedback",
          conversation,
          response: delivering,
          turn: actual,
          text: request,
        });
      }

      // Questions asked while this root runs belong to this response, so they
      // are filed under its journal. Established around the call rather than
      // inside the provider, because the root runs in the conversation's own
      // execution rather than in this scope — there is no lexical position
      // around the asking for this turn's journal to be in.
      //
      // It also ends with the call. A question is only pending while the root
      // that asked it is suspended, so once this returns — answered, failed or
      // halted and joined — there is nothing left that could be filed.
      const evaluated = yield* asking.answering(journal, () =>
        // Named for the length of this one evaluation, and given up only once
        // the evaluation and everything it registered have joined — so the
        // controls that ran file their pairs under this response and a control
        // kept past it reaches no response at all. The request carries no
        // table: what this root may write is the selection its execution
        // captured when the conversation opened.
        servingThrough(responding, () =>
          handle.evaluateGeneratedXmdRoot({
            id: response,
            source: replied.value,
            allow: [...ceiling.allow],
          }),
        ),
      );
      // A failed evaluation still rendered whatever it had, and the controls it
      // ran before failing happened. Both are retained: the reply a person
      // reads is what the root actually produced, and the operations are already
      // in their own records. The rendering comes from Core — an ordinary root
      // failure carries exactly what it had rendered when the failure reached
      // it — rather than being recomputed or blanked here. An admission refusal
      // carries none, because it performed nothing, and nothing is invented for
      // it.
      const rendered = evaluated.ok ? evaluated.value : partialOf(evaluated.error);
      const hasOutput = rendered?.hasOutput ?? false;
      // Only an explicit Output region is chat. A root that declared none still
      // rendered its body — the chapter a read returned, the receipt a Submit
      // was given — and that rendering is the reply's own working, not
      // something the person asked to see. Publishing it would be a fallback
      // chat message nobody wrote, and it would show an agent's scratch work as
      // though it were an answer.
      const output = hasOutput ? (rendered?.output ?? "") : "";
      yield* paired.writer.append({
        kind: "response",
        conversation,
        turn: actual,
        response,
        outcome: evaluated.ok ? { status: "ok" } : failedOutcome(evaluated.error),
        hasOutput,
        output,
      });
      yield* refresh();
      // The acknowledged reply is the item now. Taken down after the refresh,
      // so the row that replaces this one is already in the reading a screen
      // would draw — there is no frame in between showing neither.
      unwatch();

      // What this response asked for, in the order it asked, read back out of
      // the records it wrote. Plus its own failure when it had one a reply can
      // act on: an ordinary failure is a correction the agent can make, and
      // sending it is how the agent gets to make it.
      const results = designatedResults(yield* paired.writer.readAll(), at, refused);
      const next = sealedFeedback(results, evaluated.ok ? undefined : evaluated.error.message);
      return Ok({
        held: {
          conversation,
          turn: actual,
          response,
          output,
          hasOutput,
          failure: evaluated.ok ? undefined : evaluated.error.message,
        },
        answered: true,
        next,
      });
    }

    yield* provide({
      get reading(): Result<SidekickReading> {
        return reading;
      },
      get busy(): boolean {
        return busy;
      },
      get previewing(): SidekickPreview | undefined {
        return previewing();
      },
      get live(): SidekickLiveTurn | undefined {
        return liveTurn();
      },
      get observed(): readonly string[] {
        return Object.freeze([...observed]);
      },
      get agent(): string {
        return selection();
      },
      questions: asking.questions,
      changes: changed,
      options,
      configure,
      select,
      message,
      stop,
    });
  });
}

/**
 * What an ordinary root failure had rendered, when it had rendered anything.
 *
 * Core's own partial, by its own type. A failure of some other kind — a
 * durability, Files, secret-policy or teardown failure — keeps its
 * classification and is not a root that rendered something, so it answers with
 * nothing rather than being mined for a field it does not have.
 */
function partialOf(error: Error): GeneratedXmdRootResult | undefined {
  return error instanceof GeneratedXmdRootError ? error.partial : undefined;
}

/** A history nobody has written to, which is what a legacy execution reads as. */
const EMPTY: SidekickReading = Object.freeze({
  submits: Object.freeze([]),
  conversations: Object.freeze([]),
  active: undefined,
  chat: Object.freeze([]),
  turns: Object.freeze([]),
  operations: Object.freeze([]),
  preferences: undefined,
  unfinished: Object.freeze([]),
  submit: undefined,
  delivered: Object.freeze([]),
  unestablished: Object.freeze([]),
  answers: Object.freeze([]),
});

/**
 * The ID this process gives its next message.
 *
 * An ID of this host's own, not a saved turn, and the distinction is
 * load-bearing. Core keeps its own count of the turns an open conversation has
 * created, and that count advances when a turn is *created* rather than when
 * its record lands — so a turn interrupted before it retained anything has
 * taken its number as far as the conversation is concerned, while nothing in
 * the file says so. This cannot predict that and does not try to.
 *
 * What it does is stay monotonic over what the history already holds: the
 * canonical attempts it can see, and the message IDs it has already given. Two
 * messages must not be written down under one ID, whatever became of the
 * first. It reads those IDs rather than the canonical association beside them,
 * which is unknown for exactly the message that was interrupted.
 *
 * Which saved turn a message's request became is read from the records for
 * that request instead — see {@link turnForRequest}.
 */
/**
 * The interrupted response of this conversation that nothing has accounted for.
 *
 * A response with an operation that began and never answered is a response a
 * later turn still owes an account of. Which one is settled by the records
 * rather than by this process: the first such response, in the order the
 * history holds them, that this history has never composed a delivery for.
 *
 * "Never composed" and not "never delivered", because a composition that was
 * made and whose acceptance cannot be established must not be made again — a
 * turn may already have carried it, and sending it twice would tell a reply
 * about the same interruption as though it had happened twice. Feedback text
 * whose delivery is unresolved is reported by the reading; it is not re-sent
 * from here.
 */
function* unaccounted(
  paired: PairedChatStorage,
  known: SidekickReading,
  conversation: string,
): Operation<{ readonly conversation: string; readonly response: string } | undefined> {
  const waiting = known.unfinished.filter((one) => one.conversation === conversation);
  if (waiting.length === 0) {
    return undefined;
  }
  const composed = new Set<string>();
  for (const record of yield* paired.writer.readAll()) {
    if (record.kind === "feedback" && record.conversation === conversation) {
      composed.add(record.response);
    }
  }
  for (const one of waiting) {
    if (!composed.has(one.response)) {
      return { conversation, response: one.response };
    }
  }
  return undefined;
}

/**
 * What one conversation was asked to run under, as a turn asks for it.
 *
 * Nothing at all when nobody asked, because an empty configuration and no
 * configuration are the same request and the shorter one says so. A `null`
 * setting is a setting this history asked nothing for, so it is left off — an
 * absent member leaves a conversation on what it is already using, which is
 * exactly what "I never said" means.
 */
function desired(known: SidekickReading, conversation: string): SessionConfiguration | undefined {
  const asked = known.preferences;
  if (asked === undefined || asked.conversation !== conversation) {
    return undefined;
  }
  const request: SessionConfiguration = {
    ...(asked.model === null ? {} : { model: asked.model }),
    ...(asked.effort === null ? {} : { effort: asked.effort }),
  };
  return request.model === undefined && request.effort === undefined ? undefined : request;
}

function nextTurn(known: SidekickReading, conversation: string): number {
  const attempted = known.conversations.find((one) => one.id === conversation)?.attempted ?? [];
  const given = known.chat
    .filter((item) => item.conversation === conversation)
    .flatMap((item) => (item.kind === "person" ? [item.message] : []));
  return Math.max(0, ...attempted, ...given) + 1;
}

/**
 * The turn recorded for this request, as Core saved it.
 *
 * Bounded by the request's own records: from the record that began it, up to
 * but excluding the next record that begins one in the same conversation. The
 * turn saved there is the turn this request became, and a turn saved outside
 * those records belongs to a different request however its text reads. Two
 * requests may carry identical text, and an unbounded search for the latest
 * matching input would hand this one whichever turn was written last.
 *
 * Nothing is predicted. The number this host writes beforehand is a message ID,
 * and Core's own count advances when a turn is created rather than when its
 * record lands — so a request whose records hold no turn has none to report,
 * which is what an interruption leaves behind.
 *
 * Refuses when the request's records hold more than one turn, because one
 * request is one turn and choosing between them would attribute a reply to
 * whichever was read last.
 */
function* turnForRequest(
  paired: PairedChatStorage,
  began: number | undefined,
  conversation: string,
): Operation<
  { readonly turn: number; readonly status: string; readonly text: string } | undefined
> {
  if (began === undefined) {
    return undefined;
  }
  const records = yield* paired.writer.readAll();
  // The same boundary the detached reading uses, read from the same records, so
  // the live answer and a later one cannot disagree about which turn this was.
  const requests = requestsFromHistory(records);
  if (!requests.ok) {
    throw requests.error;
  }
  const held = requests.value.find((one) => one.at === began && one.conversation === conversation);
  if (held?.turn === undefined) {
    return undefined;
  }
  // Its saved input and outcome, from the record that turn is saved in.
  for (const record of records) {
    if (record.kind !== "event" || record.conversation !== conversation) {
      continue;
    }
    const parsed = parseDurableEvent(record.event);
    if (!parsed.ok || parsed.value.type !== "yield") {
      continue;
    }
    const description = parsed.value.description;
    if (description.type !== AGENT_PROMPT || turnOrder(description.name) !== held.turn) {
      continue;
    }
    if (parsed.value.result.status !== "ok") {
      continue;
    }
    const saved = parsePromptRecord(parsed.value.result.value);
    if (saved !== undefined) {
      return { turn: held.turn, status: saved.status, text: saved.text };
    }
  }
  return undefined;
}

/**
 * Which turn a durable name Core writes refers to.
 *
 * Read rather than guessed at: a name this CLI does not recognize belongs to
 * work it did not do.
 */
function turnOrder(name: string): number | undefined {
  const match = /^turn:([1-9][0-9]*)$/.exec(name);
  return match === null ? undefined : Number(match[1]);
}
