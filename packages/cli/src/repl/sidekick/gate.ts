/**
 * The one gate an entry is admitted through, whoever asked for it.
 *
 * A person pressing Run and a reply writing `<REPL.Submit />` are asking for
 * the same thing, and there is exactly one next entry slot to give. So there is
 * one gate rather than two code paths that each believe they own the draft: two
 * submitters deciding separately is how an entry gets admitted twice, how a
 * person's edit is overwritten by work that started before it, and how a reply
 * waits forever for an entry somebody else took.
 *
 * ## Revisions, one per thing that can be typed into
 *
 * The shared draft and the Sidekick's chat box are both editable while work is
 * in flight, and each has a monotonic revision of its own. A revision is what
 * makes "the thing I admitted" nameable after the fact: admission clears the
 * revision it admitted and no other, so a person who typed while a slow
 * preflight was running still has what they typed. Two counters rather than
 * one, because clearing a chat message must not discard a draft edit — they are
 * different texts with different owners.
 *
 * ## Human takeover is a fact, not a race
 *
 * A person editing the shared draft takes it over. From then on the Sidekick's
 * automatic replacement and submission are paused until the next explicit
 * instruction — not refused forever, and not silently resumed either. The
 * alternative is a reply overwriting what somebody is in the middle of typing,
 * which is the one thing a shared draft must never do.
 *
 * ## Liveness is rechecked where it matters, not where it was asked
 *
 * Preflight can suspend — a component read, an import, a provider — so every
 * guard this gate applies is applied *again* at the moment the entry actually
 * starts. The checks are cheap and the window is real: route, readiness, the
 * draft revision and whether the request is still wanted can all have changed
 * while the preflight was waiting, and admitting on the strength of the earlier
 * answer is admitting something nobody asked for any more.
 *
 * Nothing here performs anything. It decides, and the root performs — which is
 * what keeps a slow preflight, a slow append and a slow entry out of the input
 * loop.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

/** Why one request was not admitted. */
export class AdmissionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionRefused";
  }
}

/** Who asked for the next entry slot. */
export type Submitter = "person" | "sidekick";

/** What the gate knows about the things that can be typed into. */
export interface Revisions {
  /** The shared entry draft's revision, raised by every edit. */
  readonly draft: number;
  /** The Sidekick chat box's revision, raised by every edit. */
  readonly message: number;
}

/**
 * What the screen's own state answers, and the session is not asked about.
 *
 * Separated because the two callers know different things. The reduction knows
 * the route, the draft and who last touched it, and answers a keystroke with
 * it immediately; whether the session will take an entry at all is the
 * session's and is asked once, at the root. Splitting the facts rather than the
 * decision is what keeps one implementation: both callers run the same checks
 * over the part they can see, in the same order.
 */
export interface DraftFacts {
  /** Whether the live head is selected. A frozen position admits nothing. */
  readonly live: boolean;
  readonly revisions: Revisions;
  /**
   * Whether a person has taken the shared draft over since the Sidekick last
   * had an explicit instruction.
   */
  readonly takenOver: boolean;
  /** The draft, as it stands. */
  readonly draft: string;
}

/** One reservation of the next entry slot, held until it resolves. */
export interface Reservation {
  readonly by: Submitter;
  /** The entry this reservation will become. */
  readonly entry: string;
  /** How many entries preceded it, which is what names the slot. */
  readonly ordinal: number;
  /** The exact source reserved, immutable from here. */
  readonly source: string;
  /** The draft revision this source came from. */
  readonly revision: number;
  /** False once the asker stopped wanting it — Stop, or a withdrawn request. */
  live: boolean;
  /**
   * Whether Pause has been asked for this submission and not yet taken effect.
   *
   * On the reservation rather than beside it, because what Pause means is "stop
   * *this* entry before it expands anything". A flag held one place per screen
   * would be a request a refused submission could leave behind for whichever
   * entry started next, which is the one thing a request naming an exact entry
   * must not do: it goes when the reservation does.
   *
   * Process-local, like the rest of the reservation. Nothing durable carries a
   * pause request, and a cold reopen starts no submission to have one.
   */
  pausing: boolean;
}

/**
 * Decide what the screen's own state already decides.
 *
 * The same checks for both submitters, in the same order, because the
 * difference between them is not what makes a draft submittable. Two
 * differences remain, and both are about the Sidekick rather than about the
 * slot: a reply may not submit an empty draft it did not write, and a reply may
 * not submit at all while a person has the draft.
 *
 * Answerable from a reduction, which is why it is separate: a person pressing
 * Run on a frozen position or an empty draft is owed that sentence on the next
 * frame rather than after a round trip through the session.
 */
export function submittable(by: Submitter, facts: DraftFacts): Result<void> {
  if (!facts.live) {
    return Err(
      new AdmissionRefused(
        "this view is frozen at an earlier history position. Return to the live head to submit.",
      ),
    );
  }
  if (facts.draft.length === 0) {
    // Named rather than implied. This sentence is read by a person looking at
    // the empty draft, for whom either wording is true, *and* by a reply being
    // told why its submission did not happen — for which "nothing to submit"
    // does not say what to do next and "the draft is empty" does.
    return Err(
      new AdmissionRefused("the shared entry draft is empty, so there is nothing to submit yet."),
    );
  }
  if (by === "sidekick" && facts.takenOver) {
    // Paused rather than refused forever: the next explicit instruction clears
    // the takeover. What this prevents is a reply submitting a draft a person
    // is in the middle of editing.
    return Err(
      new AdmissionRefused(
        "the draft has been edited by hand, so automatic submission is paused until you ask " +
          "again.",
      ),
    );
  }
  return Ok(undefined);
}

/**
 * Decide whether this request may take the next entry slot.
 *
 * Everything {@link submittable} decides, and then what only the session can
 * answer: whether it is ending, whether it will take an entry at all, whether
 * one is already running, and whether somebody already holds the slot.
 */
export function admissible(
  by: Submitter,
  facts: DraftFacts,
  held: Reservation | undefined,
): Result<void> {
  // The screen's own checks first, and the same ones the reduction already
  // applied: a keystroke answered there is answered here identically, and a
  // request arriving straight at the root is not answered on fewer terms.
  const drafted = submittable(by, facts);
  if (!drafted.ok) {
    return drafted;
  }
  if (held !== undefined) {
    // The slot is taken, and by whom matters only for what to say: either way
    // there is one next entry and somebody already has it.
    return Err(
      new AdmissionRefused(
        held.by === by
          ? "this request already reserved the next entry, and one request takes one slot."
          : "another submitter already reserved the next entry.",
      ),
    );
  }
  return Ok(undefined);
}

/**
 * Whether a reply may replace the shared draft right now.
 *
 * One rule, and it is not the submission's. Filling the draft starts nothing,
 * so a frozen position and an empty draft have no bearing on it — what does is
 * whether somebody is typing into it. A person who has taken the draft over has
 * paused automatic replacement until they ask the Sidekick for something, and
 * overwriting what they are in the middle of writing is the one thing a shared
 * draft must never do.
 *
 * Structural, like {@link cleared}'s facts: this is a decision about one flag,
 * and the holder of that flag may ask without assembling the rest.
 */
export function fillable(facts: { readonly takenOver: boolean }): Result<void> {
  if (facts.takenOver) {
    return Err(
      new AdmissionRefused(
        "a person has taken the shared draft over, so it was not replaced. They release it by " +
          "asking the Sidekick for something next.",
      ),
    );
  }
  return Ok(undefined);
}

/**
 * Reserve the next slot for this request.
 *
 * Taken before the Sidekick's admission is acknowledged, so no competing
 * request can take the slot while the first is unresolved — and so a crash
 * between the reservation and the entry can be reconciled against something
 * exact. The ordinal, the source, the revision and the entry id are all recorded
 * together because any one of them alone would match the wrong thing: a slot
 * with no reserved entry means not admitted, and that slot followed by the
 * exact reserved entry identifies the one that was. What history the slot was
 * counted in is bound separately, where the reservation is written down.
 */
export function reserve(
  by: Submitter,
  facts: DraftFacts,
  slot: { readonly entry: string; readonly ordinal: number },
): Reservation {
  return {
    by,
    entry: slot.entry,
    ordinal: slot.ordinal,
    source: facts.draft,
    revision: facts.revisions.draft,
    live: true,
    // Nobody has asked this one to stop yet. Pause is offered from here on,
    // which is the whole point of reserving before the slow part begins.
    pausing: false,
  };
}

/**
 * Check the reservation again, at the moment the entry would actually start.
 *
 * This is the whole reason the gate is two functions. Preflight suspends, and
 * everything the first decision rested on can have moved while it was waiting:
 * a person may have navigated to a frozen position, typed into the draft,
 * pressed Stop, or begun leaving. Admitting on the strength of the earlier
 * answer admits something nobody is asking for any more.
 */
export function stillAdmissible(held: Reservation, facts: DraftFacts): Result<void> {
  if (!held.live) {
    return Err(new AdmissionRefused("this request was withdrawn before its entry started."));
  }
  if (!facts.live) {
    return Err(
      new AdmissionRefused(
        "the session moved away from the live head before this entry started, so it did not.",
      ),
    );
  }
  if (facts.revisions.draft !== held.revision) {
    // The draft moved under a suspended preflight. The reserved source is still
    // exactly what was reserved, and submitting it now would submit something
    // other than what the draft says — while discarding the edit.
    return Err(
      new AdmissionRefused(
        "the draft changed while this submission was being prepared, so the prepared one was " +
          "not submitted.",
      ),
    );
  }
  return Ok(undefined);
}

/**
 * What the draft and the chat box hold after an admission.
 *
 * Only the revision that was admitted is cleared. A person who typed while a
 * slow preflight ran has a newer revision, and that edit survives — which is
 * the difference between clearing "the draft" and clearing "the draft I
 * admitted".
 */
export function cleared(
  held: Reservation,
  /** Only the two things being cleared, so any holder of them may ask. */
  facts: { readonly draft: string; readonly revisions: Revisions },
): { readonly draft: string; readonly revisions: Revisions } {
  const stale = facts.revisions.draft !== held.revision;
  return {
    draft: stale ? facts.draft : "",
    revisions: facts.revisions,
  };
}

/**
 * The revisions one explicit instruction to the Sidekick was asked for at.
 *
 * Both, because the instruction decides two different things and they can move
 * independently while it is in flight: the message box is cleared because the
 * text it held is now in the chat history, and the shared draft is handed back
 * because asking for something is how a person unpauses automatic submission.
 * A newer edit to either one is somebody still working on it.
 */
export interface Instruction {
  /** The message revision whose text was sent. */
  readonly message: number;
  /** The draft revision standing when it was sent. */
  readonly draft: number;
  /**
   * Where the text this instruction carried came from.
   *
   * `composer` is somebody's own Send: the box held what was sent, so the box
   * is cleared by the record that saved it. `saved` is a failed request being
   * asked again — its text came out of the history, and the box held something
   * else entirely, which was neither sent nor consumed. Both still release a
   * draft takeover under the same rule, because both are explicit instructions.
   *
   * Said rather than inferred from a revision. Encoding "nothing to clear" as a
   * number no revision can equal would be a sentinel: a reader would have to
   * know which numbers are real before it could tell the two apart.
   */
  readonly from: "composer" | "saved";
}

/**
 * What the chat box and the takeover hold once an instruction is acknowledged.
 *
 * The same rule `cleared` applies to the draft, applied to the two things an
 * instruction settles — and applied late, because this acknowledgement arrives
 * after the message has physically been saved rather than at the keystroke. A
 * person typing in that window keeps what they typed, and one who went back to
 * the draft keeps the draft.
 */
export function clearedMessage(
  held: Instruction,
  facts: {
    readonly message: string;
    readonly revisions: Revisions;
    readonly takenOver: boolean;
  },
): {
  readonly message: string;
  readonly revisions: Revisions;
  readonly takenOver: boolean;
} {
  // A retry never held the box's text, so there is nothing of the box for it to
  // clear. Only an instruction that *came from* the composer settles it.
  const stale = held.from === "saved" || facts.revisions.message !== held.message;
  const reclaimed = facts.revisions.draft !== held.draft;
  return {
    message: stale ? facts.message : "",
    // Raised only when something was actually cleared, so a revision still
    // names one text.
    revisions: stale ? facts.revisions : edited(facts.revisions, "message"),
    // A person who edited the draft after sending this message owns it again,
    // and this instruction is not the thing that hands it back.
    takenOver: reclaimed ? facts.takenOver : false,
  };
}

/** Raise one revision. Monotonic, so a revision never names two texts. */
export function edited(revisions: Revisions, which: keyof Revisions): Revisions {
  return which === "draft"
    ? { draft: revisions.draft + 1, message: revisions.message }
    : { draft: revisions.draft, message: revisions.message + 1 };
}

/** The revisions a new execution starts with. */
export function initialRevisions(): Revisions {
  return { draft: 0, message: 0 };
}

/* --------------------------------------------- reconciling a cold reservation */

/**
 * What a retained Submit intent reserved, as this decision reads it.
 *
 * Structural, like {@link cleared}'s facts, so the chat projection can be
 * asked without this module importing it: what is being compared is three
 * values, and a reservation that arrived from a file is the same question as
 * one that arrived from memory.
 */
export interface Reserved {
  /**
   * How many entries preceded the reservation, which names the slot.
   *
   * An ordinal, and nothing more. It says which slot was taken and says
   * nothing about the history it was taken against — a different valid
   * history of the same length has the same ordinal — which is why the binding
   * below is a separate fact rather than a restatement of this one.
   */
  readonly ordinal: number;
  readonly entry: string;
  readonly source: string;
  /** How many records the entry journal held, and which records those were. */
  readonly retained: {
    readonly records: number;
    readonly bytes: number;
    readonly sha256: string;
  };
}

/**
 * What the entry journal says, as this decision reads it.
 *
 * Both the admitted entries and a measurement of the file's own bytes, because
 * the two answer different halves: the entries say what took the slot, and only
 * the bytes say whether the history that slot was counted in is still the
 * history in front of us.
 */
export interface EntryHistory {
  /** The entries the file admits, in admission order. */
  readonly entries: readonly { readonly key: string; readonly source: string }[];
  /** How many terminated records the file holds now. */
  readonly records: number;
  /**
   * The fingerprint of the first `held.retained.records` of them, or none when
   * the file does not hold that many.
   */
  readonly measured: { readonly bytes: number; readonly sha256: string } | undefined;
}

/**
 * What the entry history says became of a reservation nobody resolved.
 *
 * Two answers and no third. Either the slot it named is occupied by the entry
 * it named, or nothing took it — and anything else is not an answer, because a
 * slot held by something *else* means the two files disagree about what
 * happened and no reading of them establishes which is right.
 */
export type Resolution =
  | { readonly kind: "admitted"; readonly entry: string }
  | { readonly kind: "absent" };

/**
 * Decide what became of a reservation a dead process left behind.
 *
 * A process can stop between acknowledging a Submit intent and the entry that
 * intent reserved, or between that entry and the receipt saying so. Both leave
 * a readable reservation with no outcome, and they are *different* states: the
 * first admitted nothing and the second admitted exactly one entry whose work
 * is already recorded. Reopening has to tell them apart before it lets anything
 * else take the slot, because resubmitting the first one's source would be
 * admitting work nobody asked for twice over, and discarding the second one's
 * finding would lose the entry it actually produced.
 *
 * Checked in two stages, and the first one is the whole correction this module
 * exists to carry. *Which history* comes first: the reservation was taken
 * against a journal whose records it counted and whose bytes it measured, and
 * if those bytes are not what the file begins with any more then the slot it
 * counted is a slot in a history nobody has. Only once that holds does *what
 * took the slot* mean anything — and that is found by ordinal *and* identity
 * *and* source, because an id at the right position under other bytes is the
 * one reading that looks correct from both and is not.
 *
 * Verified before either answer. An `absent` finding is as much an assertion about
 * this history as an `admitted` one, so a changed prefix refuses rather than
 * reporting that nothing took a slot it cannot locate.
 *
 * Asked once, cold, with no capability and nothing appended. The caller retains
 * what this answers before it allows another admission.
 */
export function resolved(held: Reserved, history: EntryHistory): Result<Resolution> {
  if (history.measured === undefined) {
    // Fewer records than the reservation was taken against. A history shorter
    // than the one it counted is not a later state of that history, and nothing
    // here can say which of the two files is wrong — so this refuses.
    return Err(
      new AdmissionRefused(
        `this chat reserved its entry against ${held.retained.records} records, and the entry ` +
          `history holds only ${history.records}, so what became of that reservation cannot be ` +
          "established.",
      ),
    );
  }
  if (
    history.measured.bytes !== held.retained.bytes ||
    history.measured.sha256 !== held.retained.sha256
  ) {
    // Same number of records, different records. This is the reading an ordinal
    // alone cannot tell apart: the slot is where it was counted, the entry
    // there may even be the one that was reserved, and the history it followed
    // is not the history it was reserved after.
    return Err(
      new AdmissionRefused(
        "this execution's entry history no longer begins with the records this chat reserved " +
          "its entry against, so which history that reservation belongs to cannot be " +
          "established here.",
      ),
    );
  }
  const entries = history.entries;
  if (entries.length < held.ordinal) {
    return Err(
      new AdmissionRefused(
        `this chat reserved the entry after ${held.ordinal} others, and the entry history holds ` +
          `only ${entries.length}, so what became of that reservation cannot be established.`,
      ),
    );
  }
  const took = entries[held.ordinal];
  if (took === undefined) {
    // The slot is still empty: the process stopped after acknowledging the
    // intent and before the entry it reserved existed. Nothing was admitted,
    // and nothing about this is repaired by admitting it now.
    return Ok({ kind: "absent" });
  }
  if (took.key !== held.entry) {
    return Err(
      new AdmissionRefused(
        `this chat reserved \`${held.entry}\` as the entry after ${held.ordinal} others, and ` +
          `\`${took.key}\` is the entry there, so the reservation names an entry this history ` +
          "does not have.",
      ),
    );
  }
  if (took.source !== held.source) {
    return Err(
      new AdmissionRefused(
        `this chat reserved \`${held.entry}\` under a source the entry history does not hold ` +
          "for it, so what that entry ran cannot be established as what was reserved.",
      ),
    );
  }
  return Ok({ kind: "admitted", entry: took.key });
}
