/**
 * What a Sidekick history says, read without running anything.
 *
 * Reopening a chat is the ordinary case, and the only thing it is allowed to do
 * is *read*. This module is the whole of that: a pure function from the records
 * a pair holds to an immutable reading of them. It opens no Core conversation,
 * creates no provider, appends no reconciliation record and starts no question.
 * A person who reopens a REPL sees what their conversation actually got to, and
 * nothing happens until they say something.
 *
 * ## Published chat is derived, never a second copy
 *
 * The chat a person reads is built from what was *acknowledged*: their own
 * admitted messages, and the output of responses that actually rendered. It is
 * not a replay of provider deltas and not a mutable transcript kept beside the
 * journal — a second copy of a conversation is a second account of it, and the
 * two disagree the first time a process dies between them.
 *
 * ## An unfinished operation is a fact, not a gap
 *
 * A control writes its intent before it runs and its outcome once it has one.
 * An intent with no outcome is therefore a real, readable state: an operation
 * that began and whose result nobody knows. The reading reports those rather
 * than hiding them, because the host's next step depends on which they are —
 * an interrupted question has to be shown as interrupted, not re-asked, and an
 * unresolved Submit has to be reconciled against the entry journal before
 * anything else is admitted.
 *
 * Nothing here exposes a provider capability. The reading is data: ids, text,
 * statuses and counts. Which conversation may be prompted, under which native
 * identity and whose identity holder, stays a canonical Core and provider matter.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import { AGENT_PROMPT, parsePromptRecord, previewGeneratedXmdRoot } from "@executablemd/core/host";
import type { SessionConfiguration } from "@executablemd/core";
import type { PromptRecord } from "@executablemd/core/host";
import { parseDurableEvent } from "@executablemd/durable-streams";

import type {
  ConversationRecord,
  ControlRecord,
  ResponseRecord,
  RetainedPrefix,
  SidekickRecord,
} from "./history.ts";

/** What a Sidekick history could not be read as, and nothing of what it held. */
export class SidekickProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidekickProjectionError";
  }
}

/** One conversation this history has held, in the order it was prepared. */
export interface SidekickConversation {
  readonly id: string;
  readonly agent: string;
  /**
   * How far its setup got.
   *
   * `activated` is the only phase that may be prompted. A `prepared` one was
   * interrupted during setup and an explicit continuation decides what to do
   * with it; a `failed` one preserved the association that preceded it.
   */
  readonly phase: ConversationRecord["phase"];
  /** The association it replaces, when it replaces one. */
  readonly previous: string | undefined;
  /** Why setup failed, for a failed one. */
  readonly failure: string | undefined;
  /** How many canonical records this conversation's own sequence holds. */
  readonly events: number;
  /**
   * The orientation this conversation's agent has actually been given, by
   * digest, or none when none has been established.
   *
   * *Established*, not asserted. A `reference` record is written before the turn
   * that carries it, so by itself it says only what this host meant to deliver
   * — and a turn that failed delivered nothing. What establishes it is the same
   * thing that establishes a feedback delivery: a canonically **completed**
   * turn whose retained input actually carried that text. An ordinal alone
   * would credit whatever turn happened to be in that position, and a local
   * record alone would let a failed refresh suppress the next one.
   *
   * It is how a later process notices that the orientation it would give
   * differs from the one this agent is holding — which only a *newer build* can
   * be, since the assets and the admitted ceiling are fixed for the life of one
   * run.
   */
  readonly oriented: Readonly<Record<string, string>> | undefined;
  /**
   * Every turn this conversation has a canonical record for, in order.
   *
   * Attempted rather than completed: a turn the provider refused, failed or
   * cancelled is still a turn that happened and still occupies its ordinal, so
   * this is what says which ordinal the next one takes. Read from the canonical
   * names, so it agrees with Core's own bookkeeping rather than counting
   * alongside it.
   */
  readonly attempted: readonly number[];
  /**
   * The turns this conversation canonically completed, in order.
   *
   * Read from the saved turns themselves through Core's own reader, because
   * a turn is a canonical fact and this file holds the canonical records. Every
   * chat assertion about a turn is checked against these: an ordinal is not
   * evidence that a turn happened, and a record of this CLI's own is not
   * evidence that a provider accepted one.
   */
  readonly completed: readonly number[];
  /**
   * What this conversation was last actually running under, or none.
   *
   * Read from Core's own saved `PromptRecord.configuration`, which it writes
   * only once the provider said the turn started. So this is the one fact that
   * says a setting *was applied*, as distinct from a preference, which says
   * only what somebody asked for, and from an inspection's selected value,
   * which says what the agent happened to be on while it was being read.
   *
   * The latest turn that carries one wins. A turn that started and then failed
   * still ran under exactly these settings, so it qualifies; one that failed
   * while they were still being applied carries no member and supplies none.
   */
  readonly verified: SessionConfiguration | undefined;
}

/**
 * The settings the newest turn that carries any ran under.
 *
 * By turn rather than by record position: the records of one conversation are
 * written in turn order, but what a reader wants is the last turn that got far
 * enough to be configured, and a later turn that never started carries nothing
 * to prefer over it.
 */
function lastVerified(
  held: ReadonlyMap<number, SessionConfiguration>,
): SessionConfiguration | undefined {
  let latest: number | undefined;
  for (const turn of held.keys()) {
    if (latest === undefined || turn > latest) {
      latest = turn;
    }
  }
  if (latest === undefined) {
    return undefined;
  }
  const settings = held.get(latest)!;
  // Copied, because a projection hands out frozen facts and the record it came
  // from is the caller's to read rather than to hold a reference into.
  return Object.freeze({
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.effort === undefined ? {} : { effort: settings.effort }),
  });
}

/** One thing a person reads in the chat, in the order it was acknowledged. */
export type SidekickChatItem =
  | {
      readonly kind: "person";
      readonly conversation: string;
      /**
       * The retained message ID, independent of saved turn numbering.
       *
       * This CLI's own identity for the message, written before the turn and
       * never rewritten. It is scoped to the conversation and is not promised
       * to be contiguous — a message whose turn left no record keeps its ID,
       * and the next one takes a later number.
       */
      readonly message: number;
      /**
       * The turn among the records for this message's request, or none.
       *
       * None is *unknown*, not unsent: a turn whose canonical record never
       * landed may well have been accepted. Equality between the ID above and
       * some saved turn number establishes nothing.
       */
      readonly turn: number | null;
      readonly text: string;
    }
  | {
      /**
       * A turn the provider did not complete, and what it had streamed.
       *
       * Distinct from a `reply` on purpose, and the distinction is the whole
       * point: a reply is a root this host evaluated, and this is source nobody
       * finished writing. It performed no control, so it is a preview of an
       * attempt rather than an account of one — and it is read from the
       * canonical Prompt record, which is the only thing that knows what the
       * provider produced before it stopped.
       */
      readonly kind: "incomplete";
      readonly conversation: string;
      readonly turn: number;
      /** Exactly what that turn streamed, which may be nothing. */
      readonly text: string;
      /** Why it did not complete, in the terms the record holds. */
      readonly failure: string;
    }
  | {
      /**
       * A saved turn whose reply nobody recorded, as something to land on.
       *
       * A saved Prompt says the provider finished its turn and nothing about
       * the program it returned having been evaluated — so this is the turn,
       * inert, in the place its record holds. It is not a reply rebuilt from
       * source, not a person's message and not a record of its own: a reader
       * who opens this chat at this turn has to find the turn there, and the
       * only truthful thing it can say is that it was saved.
       */
      readonly kind: "saved";
      readonly conversation: string;
      readonly turn: number;
      /** Whether it carried a previous response's results rather than a message. */
      readonly automatic: boolean;
      /** What this turn says about itself, which is that nothing replied. */
      readonly status: string;
    }
  | {
      readonly kind: "reply";
      readonly conversation: string;
      readonly turn: number;
      readonly response: string;
      /** What the response actually rendered, partial renderings included. */
      readonly text: string;
      /** Whether the root selected person-facing chat at all. */
      readonly hasOutput: boolean;
      /** Why it failed, when it did. A failed reply still shows what it had. */
      readonly failure: string | undefined;
    };

/**
 * One saved Sidekick turn, as a reading of the work this execution has done.
 *
 * Detached from the chat it sits in, because the two answer different
 * questions: a chat item is what one conversation said, and this is one unit of
 * agent work that a person browsing everything their Sidekick has done may
 * select. So it names its own chat and agent rather than whichever conversation
 * is current, and it carries nothing a caller could reach a provider, a writer
 * or a generated program through — ids, text, a status and a key.
 *
 * Every member is read from the canonical record and this history's own
 * records for that turn's request. Nothing is predicted: a turn with no
 * established request has no title, and one with no evaluated response has no
 * reply rather than a reconstructed one.
 */
export interface SidekickSavedTurn {
  /** The CLI conversation whose records hold this turn. */
  readonly conversation: string;
  /** The agent that conversation was opened with, from that conversation. */
  readonly agent: string;
  /** Its canonical ordinal, read from the name Core retained. */
  readonly turn: number;
  /** That canonical name, exactly as Core wrote it. */
  readonly name: string;
  /**
   * The provider conversation this turn named, or none.
   *
   * Parsed from this turn's own nonempty `PromptRecord.sessionKey`, a failed or
   * cancelled record included. An earlier turn's key is not substituted: a turn
   * with no key of its own has no provider filter membership.
   */
  readonly sessionKey: string | undefined;
  /** How the provider turn itself ended, as its record holds it. */
  readonly status: PromptRecord["status"];
  /**
   * What this turn was asked on behalf of, where its request establishes it.
   *
   * `person` carries the exact saved message as {@link title}. `automatic` is a
   * delivery of a previous response's results, which is agent work rather than
   * something a person said — so its machine input never becomes a title.
   * None is unknown: a turn whose request this history cannot bound is a turn
   * without one, and the most recent message is not an answer.
   */
  readonly asked: "person" | "automatic" | undefined;
  /** The exact saved message this turn carried, for a person's request. */
  readonly title: string | undefined;
  /**
   * The evaluated response this turn produced, where one was recorded.
   *
   * None is the inert case: a saved Prompt is not evidence that the program it
   * returned was evaluated, so a completed turn without one is readable as
   * exactly that rather than as a reply nobody recorded.
   */
  readonly reply:
    | {
        readonly response: string;
        /** What the evaluated root rendered for a person, partials included. */
        readonly output: string;
        /** Whether that root selected person-facing chat at all. */
        readonly hasOutput: boolean;
        /** Why the evaluation failed, when it did. */
        readonly failure: string | undefined;
      }
    | undefined;
  /**
   * What a turn the provider did not complete had streamed, and why it stopped.
   *
   * The literal Output the pure preview reader projects from the canonical
   * record, never its source: a turn nobody finished writing has a preview of
   * an attempt and no account of one.
   */
  readonly incomplete: { readonly output: string; readonly failure: string } | undefined;
}

/** One control a response ran, and what became of it. */
export interface SidekickOperation {
  readonly conversation: string;
  readonly response: string;
  readonly order: number;
  readonly component: string;
  /**
   * `unfinished` is the one that matters: the intent is retained and no outcome
   * ever was, so this operation began and its result is unknown.
   */
  readonly status: "ok" | "failed" | "unfinished";
  readonly failure: string | undefined;
}

/** A Submit whose reservation the entry journal still has to be asked about. */
export interface SidekickSubmitIntent {
  readonly conversation: string;
  readonly response: string;
  readonly order: number;
  /** How many entries preceded the reservation, which names the slot. */
  readonly ordinal: number;
  readonly entry: string;
  readonly source: string;
  readonly revision: number;
  /**
   * The entry journal this reservation was taken against.
   *
   * Carried through as the record holds it, because the ordinal above names a
   * slot and only this names the history that slot was counted in.
   */
  readonly retained: RetainedPrefix;
  /** Whether its own outcome was retained. */
  readonly settled: boolean;
}

/** The model and effort this history last asked for. */
export interface SidekickPreferences {
  readonly conversation: string;
  readonly model: string | null;
  readonly effort: string | null;
}

/** Everything a reopened Sidekick knows before anybody says anything. */
export interface SidekickReading {
  readonly conversations: readonly SidekickConversation[];
  /**
   * The conversation an explicit continuation would use.
   *
   * The last one that actually activated. A later preparation that never
   * activated does not displace it, and neither does a failed setup — which is
   * the whole of "a failed setup preserves the previous active association".
   */
  readonly active: string | undefined;
  readonly chat: readonly SidekickChatItem[];
  /**
   * Every saved turn this history holds, across every conversation, in file
   * order.
   *
   * Beside {@link chat} rather than derived from it, because they are two
   * readings: the chat is one conversation's transcript, and this is the work
   * this execution's Sidekick has done — which outlives an agent change and is
   * what a person browsing their sessions selects from. The order is the
   * history's own, which is the only order these files establish.
   */
  readonly turns: readonly SidekickSavedTurn[];
  readonly operations: readonly SidekickOperation[];
  readonly preferences: SidekickPreferences | undefined;
  /**
   * Operations that began and never answered, in record order.
   *
   * Reported rather than resumed. A question among them is shown as waiting
   * and is never re-asked, because asking again is asking a second question.
   */
  readonly unfinished: readonly SidekickOperation[];
  /** The one Submit intent still to be reconciled, when there is one. */
  readonly submit: SidekickSubmitIntent | undefined;
  /**
   * Feedback whose acceptance a saved turn establishes, per conversation.
   *
   * Only canonically accepted deliveries appear here. A feedback record is this
   * CLI's own marker that it sent something; what proves a next turn carried it
   * is that turn existing and having completed.
   */
  readonly delivered: readonly { readonly conversation: string; readonly turn: number }[];
  /**
   * Feedback this history states it sent and cannot establish.
   *
   * Reported rather than dropped or trusted. A process interrupted between a
   * turn's acceptance and its own marker leaves exactly this, and the host's
   * next step turns on it: resending blindly would send a turn the provider may
   * already have taken, so an unestablished delivery is reconciled and never
   * assumed either way.
   */
  readonly unestablished: readonly {
    readonly conversation: string;
    /**
     * The turn the acknowledgement named, or `null` where none did.
     *
     * An acknowledgement naming a turn whose canonical record carried
     * something else is one kind of unresolved fact; feedback text this
     * history retained and whose turn it cannot find is the other. Both are
     * reported, and neither is rounded to delivered or dropped.
     */
    readonly turn: number | null;
  }[];
}

/**
 * One request this history holds, and the saved turn its records own.
 *
 * The records for a request begin at the record that started asking the
 * provider for something and stop before the next such record in the same
 * conversation. A person's message begins one; so does a feedback record that
 * names no turn, which is what this host writes before a turn carrying a
 * response's results. Nothing else does — a conversation selection and a
 * reference record are written among a request's records rather than beginning
 * one, and a feedback acknowledgement naming its turn is written after a
 * request's records have ended.
 *
 * The turn among those records is the turn that request became. It is
 * an ownership boundary and not a text match: two requests may carry identical
 * text, and identical text must never move an outcome from one to the other.
 * Nor is it ordinal equality — a message ID and a saved turn number mean
 * different things, and happening to agree establishes nothing.
 */
export interface SidekickRequest {
  readonly conversation: string;
  /** Which kind of record began it. */
  readonly kind: "message" | "feedback";
  /** Where that record sits in this history. */
  readonly at: number;
  /**
   * The message ID the beginning record carried, where it was a message.
   *
   * This CLI's own numbering, written before the turn and never rewritten. It
   * does not identify a turn, and is not compared with one.
   */
  readonly message: number | undefined;
  /**
   * The turn among this request's records, or none.
   *
   * None means unknown rather than unsent: a turn whose canonical record never
   * landed was very possibly accepted. A record that reports *failure* still
   * establishes the association — what it settles is how the turn ended, not
   * whether this request was the one that ran it.
   */
  readonly turn: number | undefined;
}

/**
 * The exact text of one saved failed request, or why it cannot be sent again.
 *
 * Resolved by conversation and message ID, which is what names one saved
 * request: two requests may read identically, so matching text names nothing,
 * and an absent turn is unknown rather than unsent.
 *
 * Four things are refused rather than retried, and each for the same reason —
 * sending again would be guessing about a turn that really happened:
 *
 * - a message this history does not hold, which has nothing to retry;
 * - one whose turn association is unknown, because the provider may already
 *   have taken it;
 * - one whose turn completed, which was answered rather than failed;
 * - one belonging to a conversation this history is not continuing.
 *
 * What comes back is the literal text that was saved. The caller sends it
 * through the ordinary message path, which allocates a new message ID and its
 * own turn association: the old attempt stays exactly where it is.
 */
export function retryable(
  known: SidekickReading,
  conversation: string,
  message: number,
): Result<string> {
  if (known.active !== conversation) {
    return Err(
      new SidekickProjectionError(
        "that request belongs to a conversation this Sidekick is no longer continuing, so " +
          "asking again would be asking somebody else.",
      ),
    );
  }
  const asked = known.chat.find(
    (item) =>
      item.kind === "person" && item.conversation === conversation && item.message === message,
  );
  if (asked === undefined || asked.kind !== "person") {
    return Err(
      new SidekickProjectionError("this chat history holds no such request to ask again."),
    );
  }
  if (asked.turn === null) {
    // Unknown, which is not unsent. A turn whose canonical record never landed
    // may well have been accepted, and sending again would either repeat work
    // the agent already has or carry on as though it never happened.
    return Err(
      new SidekickProjectionError(
        "this history cannot establish whether that request was taken, so it is not offered " +
          "again: the agent may already have it.",
      ),
    );
  }
  const failed = known.chat.some(
    (item) =>
      item.kind === "incomplete" && item.conversation === conversation && item.turn === asked.turn,
  );
  if (!failed) {
    return Err(
      new SidekickProjectionError(
        "that request's turn did not fail, so there is nothing to ask again.",
      ),
    );
  }
  // Superseded, if anything this person asked for afterwards actually worked.
  // An older failure is still in the history and still readable, but it is no
  // longer the thing to ask again: the conversation has moved on, and resending
  // a request from behind a reply would put it out of order with what the agent
  // has already been told.
  const answered = known.chat.some(
    (item) =>
      item.kind === "person" &&
      item.conversation === conversation &&
      item.message > message &&
      item.turn !== null &&
      known.chat.some(
        (reply) =>
          reply.kind === "reply" && reply.conversation === conversation && reply.turn === item.turn,
      ),
  );
  if (answered) {
    return Err(
      new SidekickProjectionError(
        "something asked after that request has since been answered, so it is not offered " +
          "again: this conversation has moved past it.",
      ),
    );
  }
  return Ok(asked.text);
}

/**
 * Every request this history holds, in record order.
 *
 * One implementation for both readers. A cold projection and the live owner ask
 * the same question — which turn did this request become — and two answers to
 * it would be two accounts of one history.
 *
 * Refuses a request whose records hold more than one saved turn. One
 * request is one prompt, so two outcomes among one request's records is a
 * history describing something this grammar cannot produce, and choosing
 * between them would attach a reply to whichever was read last.
 */
export function requestsFromHistory(
  records: readonly SidekickRecord[],
): Result<readonly SidekickRequest[]> {
  const requests: {
    conversation: string;
    kind: "message" | "feedback";
    at: number;
    message: number | undefined;
    turn: number | undefined;
    outcomes: number;
  }[] = [];
  /** The request whose records are still being read, per conversation. */
  const current = new Map<string, (typeof requests)[number]>();
  for (const [index, record] of records.entries()) {
    if (record.kind === "message" || (record.kind === "feedback" && record.turn === null)) {
      const began = {
        conversation: record.conversation,
        kind: record.kind === "message" ? ("message" as const) : ("feedback" as const),
        at: index,
        message: record.kind === "message" ? record.turn : undefined,
        turn: undefined,
        outcomes: 0,
      };
      requests.push(began);
      // Only this conversation's. A request in one conversation says nothing
      // about where another conversation's records end.
      current.set(record.conversation, began);
      continue;
    }
    if (record.kind !== "event") {
      continue;
    }
    const parsed = parseDurableEvent(record.event);
    if (!parsed.ok || parsed.value.type !== "yield") {
      continue;
    }
    const description = parsed.value.description;
    if (description.type !== AGENT_PROMPT) {
      continue;
    }
    const turn = turnOrder(description.name);
    if (turn === undefined) {
      continue;
    }
    const holding = current.get(record.conversation);
    if (holding === undefined) {
      // A saved turn with no request begun before it. Nothing owns it, and
      // nothing is invented to.
      continue;
    }
    holding.outcomes += 1;
    if (holding.outcomes > 1) {
      return Err(
        new SidekickProjectionError(
          `this chat history records two saved turns for one request (record ` +
            `${index + 1}), and one request is one turn — so which turn it became is not ` +
            "something its own records can say.",
        ),
      );
    }
    holding.turn = turn;
  }
  return Ok(
    Object.freeze(
      requests.map((held) =>
        Object.freeze({
          conversation: held.conversation,
          kind: held.kind,
          at: held.at,
          message: held.message,
          turn: held.turn,
        }),
      ),
    ),
  );
}

/**
 * The last orientation a completed turn of this conversation actually carried.
 *
 * Two conditions, and neither is sufficient alone. The turn it names has to
 * have *completed* canonically — a refresh whose turn failed delivered nothing,
 * and treating its record as delivered would suppress the refresh the next
 * message owes. And that turn's retained input has to have *carried* the text —
 * an ordinal with the wrong context is a record about a different turn, and
 * crediting it would establish a delivery nobody made.
 *
 * The last such, because orientation is cumulative: what an agent holds is
 * whatever it was told most recently and provably.
 */
function established(
  referenced: readonly {
    message: number;
    versions: Readonly<Record<string, string>>;
    carried: readonly string[];
  }[],
  completed: Map<number, string>,
  /** The turn each message ID's own request became. */
  owned: Map<number, number>,
): Readonly<Record<string, string>> | undefined {
  let held: Readonly<Record<string, string>> | undefined;
  for (const proposed of referenced) {
    // The message this orientation went with, then the turn that message's
    // request actually became. Reading the message ID as a canonical key would
    // credit whichever turn happened to share its number.
    const turn = owned.get(proposed.message);
    const input = turn === undefined ? undefined : completed.get(turn);
    if (input === undefined) {
      continue;
    }
    if (proposed.carried.every((piece) => input.includes(piece))) {
      held = proposed.versions;
    }
  }
  return held;
}

/**
 * Why one turn did not complete, as a person reads it.
 *
 * The record's own reason first, then the stop reason the provider gave, then
 * the status itself — in that order, because each is more specific than the one
 * after it and a turn that carries none of the first two still has to say
 * something true. Phrased here rather than taken from Core's error object: this
 * is chat, and what belongs in chat is a sentence.
 */
function incompleteFailure(record: PromptRecord): string {
  if (record.error?.message !== undefined) {
    return record.error.message;
  }
  if (record.stopReason !== undefined) {
    return `the agent stopped early (${record.stopReason}).`;
  }
  return `the agent's turn ${record.status}.`;
}

/**
 * What a saved turn said, as the literal Output its source projects.
 *
 * Through the pure preview reader, on a prefix the execution already cleared,
 * so what comes out is person-facing chat or nothing — never generated source,
 * a control argument or a feedback envelope. A source that will not read as a
 * root has no body rather than a body of its own machinery.
 */
function literalOutput(source: string): string {
  const read = previewGeneratedXmdRoot(source);
  return read.ok ? read.value.output : "";
}

/**
 * What a completed turn with no evaluated response says about itself.
 *
 * A saved Prompt establishes that the provider finished its turn, and nothing
 * about the program it returned having been evaluated. So the turn is readable
 * as exactly that: an inert account of work the history holds, rather than a
 * reply nobody recorded or a replay of its source.
 */
export const SAVED_WITHOUT_REPLY = "Turn saved; no evaluated reply recorded.";

/**
 * The input a canonical description carries, as text.
 *
 * Core writes a Prompt's input beside its name, and for a conversation turn it
 * is the string that turn was sent. Anything else is a description this CLI did
 * not write and cannot compare against.
 */
function canonicalInput(input: unknown): string {
  return typeof input === "string" ? input : "";
}

/**
 * Which turn a canonical durable name is, or nothing when it is not one.
 *
 * The same spelling `useAgentConversation` writes, read rather than guessed at:
 * a name this CLI does not recognize belongs to work it did not do.
 */
function turnOrder(name: string): number | undefined {
  const match = /^turn:([1-9][0-9]*)$/.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/**
 * One control's position, as a key no component name can collide with.
 *
 * NUL-separated because the three parts are free text a conversation chose, and
 * a separator one of them could contain would make two positions one.
 */
function slot(conversation: string, response: string, at: number): string {
  return `${conversation}\u0000${response}\u0000${at}`;
}

/**
 * Project one Sidekick history.
 *
 * Refusals are for histories that cannot be read as one conversation's own
 * account: an outcome for a control nobody recorded, two intents at one
 * position, a record naming a conversation this history never prepared. Each of
 * those is a file describing something that did not happen, and rounding it to
 * the nearest readable shape would show somebody a conversation they never had.
 */
export function projectSidekick(records: readonly SidekickRecord[]): Result<SidekickReading> {
  // The request boundaries first, by the same rules the live owner reads them
  // by. Everything below that associates a message, a reply or an orientation
  // with a saved turn asks these rather than comparing numbers.
  const requests = requestsFromHistory(records);
  if (!requests.ok) {
    return requests;
  }
  /** Each request by the record that began it. */
  const began = new Map<number, SidekickRequest>(
    requests.value.map((request) => [request.at, request]),
  );
  /** The turn each conversation's message IDs became. */
  const owned = new Map<string, Map<number, number>>();
  for (const request of requests.value) {
    if (request.kind !== "message" || request.message === undefined) {
      continue;
    }
    let held = owned.get(request.conversation);
    if (held === undefined) {
      held = new Map<number, number>();
      owned.set(request.conversation, held);
    }
    if (request.turn !== undefined) {
      // The last such, because orientation is cumulative and an ID reused
      // after an interrupted turn names the later message.
      held.set(request.message, request.turn);
    }
  }
  const conversations = new Map<
    string,
    {
      agent: string;
      phase: ConversationRecord["phase"];
      previous: string | undefined;
      failure: string | undefined;
      events: number;
      /**
       * Every orientation this history proposed, in the order it proposed them.
       *
       * Kept whole rather than reduced as it goes, because whether one was
       * delivered depends on a canonical record that appears *after* it: the
       * turn it names has to have completed, carrying that text. So the
       * question is answered once the whole history has been read.
       */
      referenced: {
        /** The message ID this reference text names, not a saved turn. */
        message: number;
        versions: Readonly<Record<string, string>>;
        carried: readonly string[];
      }[];
      /** Every turn ordinal this conversation holds a canonical record for. */
      attempted: Set<number>;
      /**
       * The input each completed turn canonically carried, by turn.
       *
       * The input and not only the ordinal, because an ordinal is what a
       * delivery assertion cannot be established from: a completed turn at that
       * position proves a turn happened, and the only thing that proves it
       * carried a particular request is the request the canonical record says
       * it was sent.
       */
      completed: Map<number, string>;
      /**
       * Where each completed turn's canonical record sits in this history.
       *
       * The anchor retained feedback text is reconciled against. That text is
       * written immediately before the turn that carries it, so the turn which
       * owns it is the first completed turn whose record appears *after* it —
       * which an ordinal cannot say and a local marker must not be trusted for.
       */
      at: Map<number, number>;
      /**
       * What each turn that actually started was running under.
       *
       * Keyed by turn, because the newest turn that reached its settings is
       * what a reader wants: a later turn that never started carries nothing to
       * prefer over it.
       */
      verified: Map<number, SessionConfiguration>;
    }
  >();
  const order: string[] = [];
  let active: string | undefined;
  const chat: SidekickChatItem[] = [];
  /**
   * Where each chat item's own record sits, one per item.
   *
   * Kept beside the items rather than inside them, because it is not a fact
   * about the conversation: it is how the inert anchors below are put back in
   * the order the file establishes. A saved turn whose reply nobody recorded
   * pushes nothing as the records are read — the question is answered only once
   * the whole file has been — so its place has to be reconstructed, and the
   * record it is saved in is the one place it can be.
   */
  const chatAt: number[] = [];
  /**
   * Every canonical turn this history holds a readable Prompt record for.
   *
   * Collected where the record sits, so the order is the file's own. A turn
   * whose canonical outcome the journal does not hold is not here: it has no
   * status, no key and no text, so there is nothing it could say.
   */
  const saved: {
    conversation: string;
    /** Where its canonical record sits, which is where its anchor belongs. */
    at: number;
    turn: number;
    name: string;
    sessionKey: string | undefined;
    status: PromptRecord["status"];
    incomplete: { output: string; failure: string } | undefined;
  }[] = [];
  /** Each conversation's evaluated responses, by the turn they belong to. */
  const replies = new Map<string, ResponseRecord>();
  const intents = new Map<string, { record: ControlRecord; index: number }>();
  const operations: SidekickOperation[] = [];
  const settled = new Set<string>();
  let preferences: SidekickPreferences | undefined;
  const delivered = new Map<string, number>();
  const unestablished: { conversation: string; turn: number | null }[] = [];
  /**
   * Feedback text this history retained and never acknowledged, in record order.
   *
   * Resolved after the whole file is read, because the turn that establishes it
   * appears after it.
   */
  const retainedFeedback: {
    conversation: string;
    response: string;
    text: string;
    at: number;
  }[] = [];

  for (const [index, record] of records.entries()) {
    const position = index + 1;
    // Every record but the publication names a conversation, and it has to be
    // one this history prepared: a record for an unknown conversation is a
    // record from somewhere else.
    if (record.kind !== "owner" && record.kind !== "ready" && record.kind !== "conversation") {
      if (!conversations.has(record.conversation)) {
        return Err(
          new SidekickProjectionError(
            `this chat history records work for a conversation it never opened (record ` +
              `${position}).`,
          ),
        );
      }
    }
    switch (record.kind) {
      case "owner":
      case "ready":
        break;
      case "conversation": {
        const held = conversations.get(record.conversation);
        if (held === undefined) {
          conversations.set(record.conversation, {
            agent: record.agent,
            phase: record.phase,
            previous: record.previous,
            failure: record.error?.message,
            events: 0,
            referenced: [],
            attempted: new Set<number>(),
            completed: new Map<number, string>(),
            at: new Map<number, number>(),
            verified: new Map<number, SessionConfiguration>(),
          });
          order.push(record.conversation);
        } else {
          if (held.agent !== record.agent) {
            return Err(
              new SidekickProjectionError(
                `this chat history gives one conversation two agents (record ${position}), and ` +
                  "an established conversation never changes agent in place.",
              ),
            );
          }
          held.phase = record.phase;
          held.previous = record.previous ?? held.previous;
          held.failure = record.error?.message ?? held.failure;
        }
        if (record.phase === "activated") {
          active = record.conversation;
        }
        break;
      }
      case "preferences":
        preferences = {
          conversation: record.conversation,
          model: record.model,
          effort: record.effort,
        };
        break;
      case "reference":
        // Retained as the orientation a turn was *offered*. It is not chat and
        // not an operation; what it is for is proving what an agent knew — and
        // that proof is completed below, by the saved turn that carried it.
        conversations.get(record.conversation)!.referenced.push({
          // The ID of the message this orientation went with. Which canonical
          // turn that was is established below, through that message's own
          // request — never by reading this number as a turn.
          message: record.turn,
          versions: record.versions,
          carried: [record.bootstrap, record.index, record.surface],
        });
        break;
      case "message":
        chatAt.push(index);
        chat.push({
          kind: "person",
          conversation: record.conversation,
          // Its own ID, and the saved turn its own request became — which
          // is unknown when that request's records hold no saved turn.
          message: record.turn,
          turn: began.get(index)?.turn ?? null,
          text: record.text,
        });
        break;
      case "event": {
        const held = conversations.get(record.conversation)!;
        held.events += 1;
        const parsed = parseDurableEvent(record.event);
        if (!parsed.ok) {
          return Err(
            new SidekickProjectionError(
              `this chat history holds a canonical record this version cannot read (record ` +
                `${position}).`,
            ),
          );
        }
        const canonical = parsed.value;
        if (canonical.type !== "yield" || canonical.description.type !== AGENT_PROMPT) {
          break;
        }
        const turn = turnOrder(canonical.description.name);
        if (turn !== undefined) {
          // Recorded whatever became of it. The ordinal is taken even by a turn
          // that failed, so the next turn is past it.
          held.attempted.add(turn);
        }
        if (turn === undefined || canonical.result.status !== "ok") {
          // A turn whose outcome the journal does not hold is an unfinished
          // fact rather than a completed turn. It establishes nothing.
          break;
        }
        const prompt = parsePromptRecord(canonical.result.value);
        if (prompt === undefined) {
          break;
        }
        // What the conversation was actually running under, as Core saved it.
        // Present only once the provider said the turn started — a prompt that
        // failed while its settings were still being applied ran under none —
        // so this is evidence of application rather than of a request. A turn
        // that started and then failed carries it just as a completed one does,
        // which is why it is read before the branch below.
        if (prompt.configuration !== undefined) {
          held.verified.set(turn, prompt.configuration);
        }
        // This turn as a unit of work, whatever became of it. A failed or
        // cancelled turn is still a turn somebody did, and its own record is
        // the only thing that knows its key, its status and what it streamed.
        saved.push({
          conversation: record.conversation,
          at: index,
          turn,
          name: canonical.description.name,
          // Its own, and nonempty: a record naming no conversation establishes
          // no membership, and an earlier turn's key is not substituted for it.
          sessionKey: prompt.sessionKey.length === 0 ? undefined : prompt.sessionKey,
          status: prompt.status,
          incomplete:
            prompt.status === "completed"
              ? undefined
              : { output: literalOutput(prompt.text), failure: incompleteFailure(prompt) },
        });
        if (prompt.status === "completed") {
          // The description's input is what this turn was actually sent. Core
          // writes it beside the name when it persists the Prompt, so it is the
          // canonical account rather than anything this CLI remembered.
          held.completed.set(turn, canonicalInput(canonical.description.input));
          held.at.set(turn, index);
          break;
        }
        // A turn that failed or was cancelled. The canonical record is the
        // account of it — nothing else knows what the provider streamed — and it
        // is shown as the incomplete attempt it is rather than as a reply,
        // because no root was evaluated and no control ran. Pushed here, where
        // the record sits, so it keeps its place in the chronology.
        chatAt.push(index);
        chat.push({
          kind: "incomplete",
          conversation: record.conversation,
          turn,
          text: prompt.text,
          failure: incompleteFailure(prompt),
        });
        break;
      }
      case "response": {
        // A response is the outcome of one canonical completed turn, and that
        // turn is what makes it one. Publishing a reply whose owning turn this
        // history does not hold would show somebody a conversation the provider
        // never had: provider deltas, and a record written before the turn
        // settled, are not an admitted response.
        if (!conversations.get(record.conversation)!.completed.has(record.turn)) {
          return Err(
            new SidekickProjectionError(
              `this chat history holds a reply for a turn it never completed (record ` +
                `${position}).`,
            ),
          );
        }
        replies.set(`${record.conversation}\u0000${record.turn}`, record);
        chatAt.push(index);
        chat.push({
          kind: "reply",
          conversation: record.conversation,
          turn: record.turn,
          response: record.response,
          text: record.output,
          hasOutput: record.hasOutput,
          failure: record.outcome.status === "err" ? record.outcome.error.message : undefined,
        });
        break;
      }
      case "control": {
        const key = slot(record.conversation, record.response, record.order);
        if (intents.has(key)) {
          return Err(
            new SidekickProjectionError(
              `this chat history records two operations at one position (record ${position}).`,
            ),
          );
        }
        intents.set(key, { record, index });
        break;
      }
      case "control-outcome": {
        const key = slot(record.conversation, record.response, record.order);
        const intent = intents.get(key);
        if (intent === undefined) {
          return Err(
            new SidekickProjectionError(
              `this chat history records what an operation answered without recording the ` +
                `operation (record ${position}).`,
            ),
          );
        }
        if (settled.has(key)) {
          return Err(
            new SidekickProjectionError(
              `this chat history answers one operation twice (record ${position}).`,
            ),
          );
        }
        settled.add(key);
        operations.push({
          conversation: record.conversation,
          response: record.response,
          order: record.order,
          component: intent.record.component,
          status: record.outcome.status === "ok" ? "ok" : "failed",
          failure: record.outcome.status === "err" ? record.outcome.error.message : undefined,
        });
        break;
      }
      case "feedback":
        if (record.turn === null) {
          // Feedback text retained before its turn: composed for that response
          // and about to be sent. By itself it asserts nothing — which is why
          // it names no turn — but dropping it would lose the only record of
          // what a process was sending when it stopped. So it is held and
          // reconciled below, against the saved turn that carried it.
          retainedFeedback.push({
            conversation: record.conversation,
            response: record.response,
            text: record.text,
            at: index,
          });
          break;
        }
        // The marker says this CLI sent exactly this into that turn. What
        // establishes the claim is the canonical record of that turn saying it
        // was sent the same thing: an ordinal alone would count a delivery
        // against whatever turn happened to be in that position, and a turn
        // that carried something else did not carry this.
        if (conversations.get(record.conversation)!.completed.get(record.turn) === record.text) {
          delivered.set(record.conversation, record.turn);
        } else {
          unestablished.push({ conversation: record.conversation, turn: record.turn });
        }
        break;
    }
  }

  // Every retained feedback text, reconciled against the conversation's turns.
  //
  // What establishes a delivery is a canonically completed turn that was sent
  // exactly this text, and the turn that owns a given text is the first such
  // one whose record appears after it. The record order is the anchor because
  // the text is written immediately before the turn that carries it: an
  // ordinal would have to be guessed, a local marker is this CLI's own word,
  // and an earlier turn that happened to carry the same text is a different
  // turn.
  //
  // What cannot be established is retained as unresolved rather than rounded
  // either way. Turning unknown into delivered would let a host carry on as
  // though an agent had been told something it may never have been sent, and
  // dropping it would lose the fact that a turn may already have been accepted
  // — which is exactly the state a blind resend must not be argued from.
  for (const feedback of retainedFeedback) {
    const held = conversations.get(feedback.conversation)!;
    let owner: number | undefined;
    let owningAt = Number.POSITIVE_INFINITY;
    for (const [turn, input] of held.completed) {
      const at = held.at.get(turn);
      if (at === undefined || at < feedback.at || input !== feedback.text) {
        continue;
      }
      if (at < owningAt) {
        owner = turn;
        owningAt = at;
      }
    }
    if (owner === undefined) {
      unestablished.push({ conversation: feedback.conversation, turn: null });
      continue;
    }
    delivered.set(feedback.conversation, owner);
  }

  // Intents with no outcome, in the order they were written. These are the
  // operations an explicit continuation has to account for, and the reason the
  // family is two records.
  const unfinished: SidekickOperation[] = [];
  for (const [key, held] of intents) {
    if (settled.has(key)) {
      continue;
    }
    unfinished.push({
      conversation: held.record.conversation,
      response: held.record.response,
      order: held.record.order,
      component: held.record.component,
      status: "unfinished",
      failure: undefined,
    });
  }
  unfinished.sort((left, right) => left.order - right.order);

  // The one Submit still to be reconciled. More than one unresolved
  // reservation is not a history this version can continue: the entry journal
  // holds one next slot, and two intents claiming it cannot both be true.
  const reservations = [...intents.values()].filter((held) => held.record.submit !== undefined);
  const unresolved = reservations.filter(
    (held) => !settled.has(slot(held.record.conversation, held.record.response, held.record.order)),
  );
  if (unresolved.length > 1) {
    return Err(
      new SidekickProjectionError(
        "this chat history holds more than one unresolved entry reservation, so which entry it " +
          "was waiting for cannot be established here.",
      ),
    );
  }
  const reserved = unresolved[0] ?? undefined;

  // Which request each saved turn belongs to, through the same boundaries the
  // chat is built from. One request is one turn, so this is a lookup rather
  // than a choice: a turn no request bounds is a turn this history cannot say
  // what was asked in, and nothing is substituted for it.
  const owning = new Map<string, SidekickRequest>();
  for (const request of requests.value) {
    if (request.turn === undefined) {
      continue;
    }
    owning.set(`${request.conversation}\u0000${request.turn}`, request);
  }
  // A saved turn whose reply nobody recorded, put back where its record sits.
  //
  // One anchor per such turn and never beside a reply: a turn that produced an
  // evaluated response already has a row in this chat, and a second one would
  // be the same turn read twice. A failed or cancelled turn has its own
  // incomplete account for the same reason, so neither gets one either.
  for (const one of saved) {
    if (one.status !== "completed" || replies.has(`${one.conversation}\u0000${one.turn}`)) {
      continue;
    }
    const request = owning.get(`${one.conversation}\u0000${one.turn}`);
    chatAt.push(one.at);
    chat.push({
      kind: "saved",
      conversation: one.conversation,
      turn: one.turn,
      automatic: request?.kind === "feedback",
      status: SAVED_WITHOUT_REPLY,
    });
  }
  // The file's own order, restored. Sorted by where each item's record sits
  // rather than by when this projection happened to push it, because the
  // anchors above were resolved after the whole history had been read.
  const ordered = chat
    .map((item, at) => ({ item, at: chatAt[at] }))
    .sort((left, right) => left.at - right.at)
    .map((held) => held.item);

  const turns: SidekickSavedTurn[] = saved.map((one) => {
    const key = `${one.conversation}\u0000${one.turn}`;
    const request = owning.get(key);
    // The record that began this turn's request, which is where a person's own
    // words are. A feedback turn's request holds a machine input, and that is
    // not a title: it is this host's account of one response's results.
    const beginning = request === undefined ? undefined : records[request.at];
    const reply = replies.get(key);
    return Object.freeze({
      conversation: one.conversation,
      agent: conversations.get(one.conversation)!.agent,
      turn: one.turn,
      name: one.name,
      sessionKey: one.sessionKey,
      status: one.status,
      asked:
        request === undefined
          ? undefined
          : request.kind === "message"
            ? ("person" as const)
            : ("automatic" as const),
      title:
        request?.kind === "message" && beginning?.kind === "message" ? beginning.text : undefined,
      reply:
        reply === undefined
          ? undefined
          : Object.freeze({
              response: reply.response,
              output: reply.output,
              hasOutput: reply.hasOutput,
              failure: reply.outcome.status === "err" ? reply.outcome.error.message : undefined,
            }),
      incomplete: one.incomplete === undefined ? undefined : Object.freeze(one.incomplete),
    });
  });

  return Ok(
    Object.freeze({
      conversations: Object.freeze(
        order.map((id): SidekickConversation => {
          const held = conversations.get(id)!;
          return Object.freeze({
            id,
            agent: held.agent,
            phase: held.phase,
            previous: held.previous,
            failure: held.failure,
            events: held.events,
            oriented: established(
              held.referenced,
              held.completed,
              owned.get(id) ?? new Map<number, number>(),
            ),
            attempted: Object.freeze([...held.attempted].sort((left, right) => left - right)),
            completed: Object.freeze(
              [...held.completed.keys()].sort((left, right) => left - right),
            ),
            verified: lastVerified(held.verified),
          });
        }),
      ),
      active,
      chat: Object.freeze(ordered.map((item) => Object.freeze(item))),
      turns: Object.freeze(turns),
      operations: Object.freeze(operations.map((held) => Object.freeze(held))),
      preferences: preferences === undefined ? undefined : Object.freeze(preferences),
      unfinished: Object.freeze(unfinished.map((held) => Object.freeze(held))),
      submit:
        reserved === undefined
          ? undefined
          : Object.freeze({
              conversation: reserved.record.conversation,
              response: reserved.record.response,
              order: reserved.record.order,
              ordinal: reserved.record.submit!.ordinal,
              entry: reserved.record.submit!.entry,
              source: reserved.record.submit!.source,
              revision: reserved.record.submit!.revision,
              retained: reserved.record.submit!.retained,
              settled: false,
            }),
      delivered: Object.freeze(
        [...delivered].map(([conversation, turn]) => Object.freeze({ conversation, turn })),
      ),
      unestablished: Object.freeze(unestablished.map((held) => Object.freeze(held))),
    }),
  );
}
