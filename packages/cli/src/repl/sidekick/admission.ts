/**
 * The root's side of admitting an entry for a reply, and recovering one it did
 * not finish admitting.
 *
 * `<REPL.Submit />` asks; this is what answers. The asking lives in
 * `controls.ts` and knows nothing about the REPL's state, and the gate in
 * `gate.ts` decides and performs nothing — so this is the one place a
 * reservation becomes a durable fact, an entry, and a receipt, in that order.
 *
 * ## Why a reply's submission is written down and a person's Run is not
 *
 * A person pressing Run is present. If the process dies between their keystroke
 * and the entry, they can see what happened and decide what to do about it, and
 * nothing is waiting on an answer. A reply is not present: it asked for an
 * entry inside a response that is itself retained, and something will read that
 * response's controls back. An unanswered Submit in a chat history is therefore
 * a question the next process has to answer — did that entry happen? — and the
 * only way to answer it is to have written down what was reserved before
 * reserving it.
 *
 * So the pair is intent-then-outcome, like every other control, with the one
 * addition that Submit binds what it took: the slot's ordinal, the entry id it
 * took, the exact source, the draft revision that source came from, and —
 * separately from all of those — the entry journal it was counted in, as a
 * record count with the byte count and digest of exactly those records.
 *
 * That last one is not a restatement of the ordinal. An ordinal says *which
 * slot*; it cannot say which records preceded it, so a different valid history
 * of the same length satisfies it. Binding the retained bytes is the only thing
 * that makes "the entry after those records" mean one history.
 *
 * ## The prefix has to be acknowledged, not merely append-only
 *
 * Owning the slot stops another submitter taking it. It does not stop an append
 * already in flight from landing, and "the file only grows" says nothing about
 * whether what is in it right now is all of it. So the order is: establish the
 * session's own terms, let the writer settle, and only then bind — because a
 * prefix bound over an unacknowledged append describes a history the file is
 * already past, and the record saying so would outlive the process that wrote
 * it.
 *
 * ## The two interruptions this is shaped by
 *
 * Between acknowledging the intent and the entry's own first record, nothing
 * was admitted. Between that record and the receipt, exactly one entry was —
 * and its work is already in the entry history, so it is not repeated. Those
 * are different states that look identical from the chat history alone, which
 * is why {@link gate.resolved} is asked about the entry history rather than
 * guessed at here, and why reopening resolves before it admits anything else.
 */

import { ensure, Err, Ok } from "effection";
import type { Operation, Result } from "effection";

import { admissible, AdmissionRefused, reserve, resolved, stillAdmissible } from "./gate.ts";
import type { DraftFacts, Reservation, Reserved, Resolution, Submitter } from "./gate.ts";
import { bindRetainedPrefix, failedOutcome, measureRetainedPrefix } from "./history.ts";
import type { SidekickRecord, SidekickWriter } from "./history.ts";
import { projectSidekick } from "./model.ts";
import type { SidekickSubmitIntent } from "./model.ts";
import type { ControlJournal, SidekickOccurrence, SubmitReceipt } from "./controls.ts";
import type { ReplSubmission, StartingCheck } from "../session.ts";

/**
 * The next entry slot, and whatever submission is taking it.
 *
 * One of these for the whole command, because there is one next entry. Both
 * submitters reserve here and the loop is the only thing that clears it: a
 * reservation released by whichever work happened to finish would be a slot two
 * things could hold at once.
 *
 * `reported` is a queue rather than a callback. Submission work is spawned, so
 * it finishes somewhere the loop is not, and a child that wrote the screen's
 * state would be a second writer of it. It leaves facts here instead and the
 * loop applies them on its next pass — which is also why a slow preflight, a
 * slow append and a slow entry never hold the keyboard.
 */
export interface Admitting {
  /** The reservation a submission in flight holds, or none. */
  held: Reservation | undefined;
  /** What that work reported, for the loop to apply on its next pass. */
  readonly reported: Reported[];
}

/** One finished submission, as the work that held the slot reports it. */
export type Reported =
  | {
      readonly kind: "admitted";
      readonly held: Reservation;
      readonly submission: ReplSubmission;
    }
  | {
      readonly kind: "refused";
      readonly held: Reservation;
      readonly refusal: string;
      readonly byReadiness: boolean;
    };

/** A fresh slot, holding nothing. */
export function admitting(): Admitting {
  return { held: undefined, reported: [] };
}

/**
 * Take the slot, synchronously, or say why not.
 *
 * Nothing between the decision and the reservation suspends. That is the whole
 * guarantee: a second submitter arriving in the same turn finds the slot held
 * rather than taking it alongside, whichever of the two asked first.
 */
export function take(
  by: Submitter,
  facts: DraftFacts,
  slot: { readonly entry: string; readonly ordinal: number },
  held: Admitting,
): Result<Reservation> {
  const taken = admissible(by, facts, held.held);
  if (!taken.ok) {
    return taken;
  }
  const reservation = reserve(by, facts, slot);
  held.held = reservation;
  return Ok(reservation);
}

/** What one entry history says, as this module needs to read it. */
export interface AdmittedEntry {
  readonly key: string;
  readonly source: string;
}

/**
 * What the root needs from the session to admit an entry for a reply.
 *
 * Named rather than taking the session itself, because what this does with a
 * session is exactly three things and a reply may not reach any of the rest of
 * it: no observer, no controller, no permission authority and no history.
 */
export interface AdmittingSession {
  /**
   * The acknowledged entries, read when the reservation needs them.
   *
   * A function rather than a field, and a `Result` rather than a list, because
   * both of those are load-bearing. It is read at one exact moment — once the
   * writer has settled and the slot is about to be taken — so a value carried
   * in from earlier would name a slot against a history the file has moved
   * past. And the history is read from a file, so a reading that fails has to
   * be able to say so: an unreadable history supplies no count to guess a slot
   * from and no permission to submit.
   *
   * It is the whole acknowledged history, never the prefix a screen happens to
   * be opened at. Where somebody is reading is not what the next entry is
   * called.
   */
  entries(): Result<readonly AdmittedEntry[]>;
  /** Whether it will take an entry at all, asked without proposing one. */
  admits(): Result<void>;
  /**
   * Admit this source, and ask `starting` again when the entry actually starts.
   *
   * The check is passed through rather than applied here, because the moment it
   * has to be asked at is inside the session: preflight suspends, and the route,
   * the draft's revision and whether this request is still wanted can all move
   * while it does. A caller that answered before the preflight would be
   * answering a question nobody had asked yet.
   */
  submit(source: string, starting?: StartingCheck): Operation<Result<ReplSubmission>>;
}

/**
 * The entry writer, as a reservation needs to see it.
 *
 * Both halves matter and the second is the one that is easy to miss. The path
 * is where the bytes are; `settled` is what says the bytes are *all there*. A
 * file that only ever grows still has a moment in which a record is written and
 * not yet acknowledged, and a prefix bound in that moment describes a history
 * the file is already past.
 */
export interface EntryJournal {
  /** The file appends currently reach. */
  readonly path: string;
  /** Return once no append is in flight. */
  settled(): Operation<void>;
}

/**
 * Admit the draft for a reply, writing what was reserved before reserving it.
 *
 * The order is the point. The intent is acknowledged while the slot is held and
 * before the session is asked for anything, so a process that dies at any point
 * after this leaves a readable reservation rather than an entry nobody can
 * account for. The receipt is written last, once the entry has an outcome of its
 * own, because a receipt is an account of how it ended.
 *
 * Reported to the loop as soon as the admission is known rather than when the
 * entry finishes: the draft that became an entry should leave the screen when it
 * became one, and this call goes on waiting for the entry afterwards.
 */
export function* submitForSidekick(
  at: { readonly conversation: string; readonly response: string },
  options: {
    readonly session: AdmittingSession;
    /**
     * The root's draft facts, asked rather than carried.
     *
     * A function and not a snapshot, because this is read twice at two
     * different moments and they are different questions: what the reservation
     * is taken against, and whether that reservation is still the one anybody
     * wants by the time the entry starts. A snapshot can only answer the first,
     * and a shape that accepted one would make the second silently stale.
     */
    readonly facts: () => DraftFacts;
    readonly held: Admitting;
    readonly journal: ControlJournal;
    /** The entry writer whose acknowledged records this reservation binds. */
    readonly writer: EntryJournal;
    /** Tell the loop something happened, so it applies the report. */
    readonly woke: () => void;
    /**
     * This occurrence's own receiver, when the reply queried the receipt.
     *
     * Submit's intent binds the reservation this takes, so this is the one
     * place that can mark it — and it marks exactly one intent. The position it
     * took is filed with the receiver only after the entry reached its own
     * outcome, which is what the destination then presents against.
     */
    readonly presenting: SidekickOccurrence | undefined;
  },
): Operation<Result<SubmitReceipt>> {
  const { session, facts, held, journal, writer, woke, presenting } = options;
  // The session's own terms first, before anything is written and before
  // anything is waited for. A session that is ending, is running an entry, or
  // follows an entry that never settled refuses — and it has to refuse *here*,
  // because a refusal discovered after the intent was acknowledged leaves a
  // record claiming an attempt on terms this could have asked about. It is also
  // what keeps a busy request a refusal rather than work that queues behind the
  // entry in flight: nothing below waits for that entry to finish.
  const admits = session.admits();
  if (!admits.ok) {
    return admits;
  }
  // Then the acknowledgement. Only now, with no entry running, is there a
  // settled prefix to speak of: an append that has been issued and not yet
  // acknowledged is not in the history this process can read, so a reservation
  // bound before it lands describes a history the file is already past. Growth
  // alone does not make a prefix stable — being acknowledged does.
  yield* writer.settled();
  // Asked again, because settling suspended and the answer above was about the
  // moment it was asked. Cheap, and the alternative is binding a prefix for a
  // session that began ending while this waited.
  const still = session.admits();
  if (!still.ok) {
    return still;
  }
  // The ordinal from the settled history, so the slot it names and the prefix
  // bound below are readings of the same file. Read here and not before: this
  // is the first moment there is a settled prefix to count. Taken
  // synchronously from here on, so a competing submitter finds the slot held
  // rather than taking it alongside.
  const acknowledged = session.entries();
  if (!acknowledged.ok) {
    // Nothing is written, because nothing was decided. A history this process
    // cannot read is not a history with no entries in it, and reserving the
    // first slot on that basis would claim a slot somebody else's entry holds.
    return acknowledged;
  }
  const ordinal = acknowledged.value.length;
  // The draft as it stands now, which is the moment this reservation is about —
  // the same moment a person's Run reserves at.
  const taken = take("sidekick", facts(), { entry: entryAfter(ordinal), ordinal }, held);
  if (!taken.ok) {
    // Refused before anything was written, which is why nothing is: a
    // reservation that was never taken has no outcome to record, and a chat
    // history that noted every refused ask would be claiming attempts the
    // entry history has no trace of.
    return taken;
  }
  const reservation = taken.value;
  // Withdrawn if this call is cancelled, wherever it had got to.
  //
  // Stop is the reason this exists, and the reservation is the right place for
  // it: `live` means "the asker still wants this", and a cancelled submission
  // is the asker not wanting it. Registered here, so it covers the whole window
  // in which the slot is held and no entry has started — the preflight that
  // suspends, the import that gives the entry its position — and the entry's
  // own start is where that question is asked.
  //
  // Unconditional, because it stays true afterwards: a submission cancelled
  // once its entry had started is still an asker who stopped wanting it, and
  // the entry runs on regardless because it was already admitted. Nothing asks
  // again after that start, so there is no case to distinguish and no branch
  // here to go untested.
  yield* ensure(() => {
    reservation.live = false;
  });
  // Measured under the held slot, from the settled file. Nothing is running, so
  // no entry record can arrive; the slot is held, so no competing submission
  // can start one.
  const retained = yield* bindRetainedPrefix(writer.path);
  const order = yield* journal.began(
    { component: "REPL.Submit", arguments: {} },
    {
      ordinal: reservation.ordinal,
      entry: reservation.entry,
      source: reservation.source,
      revision: reservation.revision,
      retained,
    },
    presenting?.query === undefined ? undefined : "selected-v1",
  );

  const submitted = yield* session.submit(reservation.source, () =>
    // Asked at the entry's actual start, against this exact reservation and the
    // root's facts as they are by then — the same gate the person's own Run
    // supplies. Everything the reservation rested on can have moved while the
    // preflight suspended: somebody may have typed into the draft, walked to a
    // frozen position, or stopped the Sidekick. Admitting on the strength of
    // the earlier answer admits text nobody is asking for any more and
    // discards the edit that replaced it.
    stillAdmissible(reservation, facts()),
  );
  if (!submitted.ok) {
    held.reported.push({
      kind: "refused",
      held: reservation,
      refusal: submitted.error.message,
      byReadiness: false,
    });
    woke();
    // Resolved as refused, which is a resolution: a later process reading this
    // finds the reservation answered and does not go asking the entry history
    // about a slot nothing took.
    yield* journal.settled(order, Err(submitted.error));
    return submitted;
  }
  const submission = submitted.value;
  held.reported.push({ kind: "admitted", held: reservation, submission });
  woke();

  // That entry and no other. The handle is bound to the task this submission
  // admitted, so waiting here waits for its outcome and its teardown even
  // after something else has started.
  const outcome = yield* submission.join();
  const receipt: SubmitReceipt = {
    entry: submission.entry,
    status: outcome.ok ? "completed" : "failed",
    failure: outcome.ok ? undefined : outcome.error.message,
    read: { entry: submission.entry },
  };
  yield* journal.settled(order, outcome.ok ? Ok(undefined) : Err(outcome.error), receipt.status);
  // Filed after the entry's own outcome, against the one intent this
  // submission wrote. A submission whose entry ran and failed still produced
  // that entry's receipt, so its selection is of an answer rather than of a
  // refusal.
  presenting?.file(order);
  return Ok(receipt);
}

/** The id the entry after this many others will be given. */
function entryAfter(ordinal: number): string {
  return `entry-${ordinal + 1}`;
}

/**
 * Record one response's controls, intent before and outcome after.
 *
 * The pair is what makes an interrupted control readable: an intent with no
 * outcome is an operation that began and whose result nobody knows, and that is
 * a state the next process can act on. Writing the outcome first, or writing
 * one record carrying both, would turn every interruption into either a control
 * that never happened or one that states a result it never got.
 *
 * Order is handed in rather than counted here. It is a position within one
 * response, and this knows about one control at a time — a counter of its own
 * would be a second opinion about a response it cannot see the whole of.
 */
export function controlJournal(
  writer: SidekickWriter,
  at: { readonly conversation: string; readonly response: string },
  /** The next order to use, which is how many controls this response has. */
  from = 0,
): ControlJournal {
  let next = from;
  return {
    *began(occurrence, reserved, presentation): Operation<number> {
      const order = next;
      next += 1;
      yield* writer.append({
        kind: "control",
        conversation: at.conversation,
        response: at.response,
        order,
        component: occurrence.component,
        arguments: occurrence.arguments,
        ...(reserved === undefined ? {} : { submit: reserved }),
        ...(presentation === undefined ? {} : { presentation }),
      });
      return order;
    },
    *settled(order, outcome, observed): Operation<void> {
      yield* writer.append({
        kind: "control-outcome",
        conversation: at.conversation,
        response: at.response,
        order,
        outcome: outcome.ok ? { status: "ok" } : failedOutcome(outcome.error),
        ...(observed === undefined ? {} : { observed }),
      });
    },
    *presented(order, selected, read): Operation<void> {
      yield* writer.append({
        kind: "control-presentation",
        conversation: at.conversation,
        response: at.response,
        order,
        version: 1,
        outcome: selected.ok ? { status: "ok" } : failedOutcome(selected.error),
        ...(selected.ok ? { selected: selected.value } : {}),
        ...(selected.ok && read !== undefined ? { read } : {}),
      });
    },
  };
}

/* ------------------------------------------------- reopening a reservation */

/** A reservation a dead process left, and what became of the entry it named. */
export interface ColdReservation {
  readonly intent: SidekickSubmitIntent;
  readonly finding: Resolution;
}

/**
 * What a reopened pair has to settle before it admits anything else.
 *
 * `undefined` for the ordinary case, which is almost every case: a history whose
 * Submits all have outcomes has nothing to reconcile and this is the whole cost
 * of asking. An `Err` is a history whose two files disagree, and it stays
 * refused — reopening repairs nothing and admits nothing on top of a disagreement
 * it cannot resolve.
 *
 * Cold: a projection of records already on disk and a reading of the entry
 * history already on disk. Nothing is appended, no provider is created and no
 * conversation is opened by asking.
 */
export function* coldReservation(
  records: readonly SidekickRecord[],
  entries: readonly AdmittedEntry[],
  /** The entry journal's path, because the binding is of its bytes. */
  entriesPath: string,
): Operation<Result<ColdReservation | undefined>> {
  const reading = projectSidekick(records);
  if (!reading.ok) {
    return reading;
  }
  const intent = reading.value.submit;
  if (intent === undefined) {
    return Ok(undefined);
  }
  // The file, not a re-encoding of what was parsed out of it. Measuring the
  // records this process rebuilt would compare one valid encoding of a history
  // against another and call them the same bytes.
  const measured = yield* measureRetainedPrefix(entriesPath, intent.retained.records);
  const finding = resolved(reserved(intent), { entries, ...measured });
  if (!finding.ok) {
    return finding;
  }
  return Ok({ intent, finding: finding.value });
}

/** What the gate compares, from the intent that retained it. */
function reserved(intent: SidekickSubmitIntent): Reserved {
  return {
    ordinal: intent.ordinal,
    entry: intent.entry,
    source: intent.source,
    retained: intent.retained,
  };
}

/**
 * Write down what became of a reservation, before anything else is admitted.
 *
 * A finding nobody retained is a finding the next process has to make again,
 * and a reading that keeps rediscovering the same unanswered Submit never gets
 * past it. So the resolution is recorded as that control's own outcome — the
 * same intent/outcome pair every other control writes, answered late.
 *
 * What it never does is act on the finding. An `absent` reservation is not
 * resubmitted: the source it named was the reply's, the reply is not running,
 * and admitting work nobody is waiting for is the one thing a recovery must not
 * do. An `admitted` one is not re-run either — the entry is in the history, and
 * what it did is readable there.
 */
export function* retainResolution(writer: SidekickWriter, held: ColdReservation): Operation<void> {
  yield* writer.append({
    kind: "control-outcome",
    conversation: held.intent.conversation,
    response: held.intent.response,
    order: held.intent.order,
    outcome:
      held.finding.kind === "admitted"
        ? { status: "ok" }
        : failedOutcome(
            new AdmissionRefused(
              "this submission's entry was never admitted, so the process that asked for it " +
                "stopped before it happened.",
            ),
          ),
    observed: held.finding.kind === "admitted" ? held.finding.entry : null,
  });
}

/**
 * Why a reopened history will not admit anything yet.
 *
 * One sentence, in the terms the person is looking at: their draft is sitting
 * there and Run is doing nothing, and the reason is a previous process rather
 * than anything they did.
 */
export function blocking(error: Error): string {
  return `${error.message} Nothing can be admitted into this execution until that is resolved.`;
}
