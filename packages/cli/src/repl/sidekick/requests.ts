/**
 * What the root actually does when a reply asks, and where each answer comes from.
 *
 * `controls.ts` turns an element into a semantic request and waits. This is the
 * other side of that wait. Nothing here decides admission, holds a slot or owns
 * a conversation: it resolves every read against state the root already has,
 * and hands the two writes to the things that own them.
 *
 * ## The reads answer about the history, not about the screen
 *
 * A person can be standing at an earlier history position, inside a nested
 * scope, or on either tab, and none of that changes what a reply is told. The
 * projection a read answers from is the **acknowledged head** — what the file
 * says right now — because the alternative makes a reply's answer depend on
 * where somebody happens to be looking. A reply that was handed the selected
 * prefix would write an entry against bindings that were replaced three entries
 * ago, and nothing in the response would say so.
 *
 * That is also why the bindings read goes through the projection's own record
 * projection rather than the Bindings pane: the pane is a view with a position,
 * a filter and a width, and a reply needs the values.
 *
 * ## A read performs nothing, including waiting
 *
 * No read starts an entry, resumes one or waits for one. The output reads in
 * particular answer from what has been observed *so far* — a running entry's
 * snapshot is a truthful snapshot of a running entry, not a promise that more
 * is coming — which is what keeps a reply that wants to watch an entry reading
 * again instead of blocking a response on work it did not admit. An inspection
 * of saved evidence never opens an entry, contacts the provider that produced
 * it, or writes to what it read.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/core";

import type { EntryVocabulary } from "../../repl-profile.ts";
import type { ReplModel } from "../model.ts";
import type { ReplHostFact } from "../host.ts";
import type { ReplPrinting, ReplSession } from "../session.ts";
import type { GuideChapter, SidekickRequests, SubmitReceipt } from "./controls.ts";
import { replEnvironment } from "./environment.ts";
import { readGuideChapter } from "./guide.ts";
import { readEntryOutput } from "./output.ts";
import type { ObservedEntry, OutputRead, OutputReadRequest } from "./output.ts";
import {
  readEntryJournal,
  readEntryOutputWindow,
  readEntryPrompt,
  readEntrySource,
} from "./entry-inspection.ts";
import type {
  EntryJournalPage,
  EntryPromptPage,
  EntryPromptRequest,
  EntryReadRequest,
  EntryTextPage,
  InspectedHistory,
} from "./entry-inspection.ts";

/**
 * What the root holds, as a reply's requests need to see it.
 *
 * Named members rather than the session, the repository or the loop's state,
 * because what a reply reaches has to be listable: there is no observer here, no
 * controller, no permission authority, no route and no terminal, and a request
 * cannot grow one by being handed something that has it.
 */
export interface RootReading {
  /**
   * The acknowledged head of this execution's history, however it is navigated.
   *
   * A `Result`, because a file this process can no longer read refuses the read
   * rather than answering from a stale projection. Asked per request, so two
   * reads in one response that straddle an append see the file either side of
   * it rather than one copy taken when the response started.
   */
  acknowledged(): Result<ReplModel>;
  /**
   * The entry running in this process and what it has printed, or none.
   *
   * Separate from the projection because plain output is exactly what the
   * Journal does not record: a running entry's text lives in this process, and
   * a read that only projected would report a running entry as silent. It
   * carries the entry's key rather than a position, so the text is credited to
   * the entry producing it and not to whichever entry happens to be last.
   */
  printing(): ReplPrinting | undefined;
  /**
   * The root data as it stands, from the file and from the entry running now.
   *
   * Separate from {@link acknowledged} for the same reason {@link printing} is:
   * a running entry's values are not in the file yet, and a read that only
   * projected would tell a reply that a name its own entry had just bound does
   * not exist. The execution that owns that entry's root answers, through its
   * own disclosure policy, so a value it may not disclose refuses the read.
   *
   * Asked per request, like the projection beside it, so two reads in one
   * response that straddle an append or a settlement each see their own moment.
   */
  bindings(): Operation<Result<Readonly<Record<string, Json>>>>;
  /** What an entry may write under this command's profile. */
  readonly vocabulary: EntryVocabulary;
  /** The facts this command knows and the host does not. */
  readonly session: readonly ReplHostFact[];
  /**
   * Put exactly this source in the shared draft, or say why not.
   *
   * It starts nothing. Filling the draft is the same act as typing into it, and
   * a reply that wanted an entry writes `<REPL.Submit />` as a separate
   * request — which is also what makes a reply that only filled inspectable as
   * a reply that admitted nothing.
   *
   * Returns once the draft actually holds the source, because the root applies
   * it and the root is not this call. A fill that answered before it landed
   * would let the submission after it reserve the text that was there before.
   */
  fill(source: string): Operation<Result<void>>;
}

/** The reads, which answer from the history and need nothing of the loop's. */
export type RootReads = Omit<RootReading, "fill">;

/**
 * The reads, over one open session and the profile it runs under.
 *
 * The narrowing seam, and the reason it is a function rather than the session
 * itself: what comes back can observe the history and describe the profile, and
 * there is no observer on it, no controller, no permission authority, no route
 * and no terminal. A request cannot grow one of those by being handed this.
 *
 * The head is asked for explicitly on every read. A session opened at a
 * historical position keeps that position for the screen and answers `reading()`
 * for any other, so a reply is told what the file says while a person reads
 * what they navigated to.
 */
export function rootReads(
  session: ReplSession,
  profile: {
    readonly includes: readonly string[];
    readonly permissionMode: string;
    readonly plugins: readonly string[];
    readonly vocabulary: EntryVocabulary;
  },
): RootReads {
  return {
    acknowledged(): Result<ReplModel> {
      const read = session.reading(undefined);
      return read.ok ? Ok(read.value.model) : read;
    },
    printing(): ReplPrinting | undefined {
      // The process's fact, not the overlay. The overlay answers at the
      // position this session was opened at, so a session opened at a
      // historical location would report that prefix's retained text as the
      // output of the entry running now.
      return session.printing;
    },
    bindings(): Operation<Result<Readonly<Record<string, Json>>>> {
      // The session's own read, for the same reason `printing` is: the live
      // half belongs to the entry running in this process, and only the
      // session knows which entry that is and whether it is still that one
      // when the read answers.
      return session.bindings();
    },
    vocabulary: profile.vocabulary,
    // What this command knows and the host does not: where a declared name is
    // looked for, which Plugins are active, and how a permission request is
    // answered here. All three are facts about the invocation rather than about
    // the machine, so they are reported after the host's own.
    //
    // An empty list is reported as `none` rather than as an absent fact. A
    // command that installed no Plugin has *said* something about what an entry
    // may write, and leaving the line out would make it indistinguishable from
    // a host that could not tell — which is exactly the difference this
    // snapshot exists to keep.
    session: Object.freeze([
      Object.freeze({
        label: "component includes",
        value: profile.includes.length === 0 ? "none" : profile.includes.join(", "),
      }),
      Object.freeze({
        label: "active plugins",
        value: profile.plugins.length === 0 ? "none" : profile.plugins.join(", "),
      }),
      Object.freeze({ label: "agent permission requests", value: profile.permissionMode }),
    ]),
  };
}

/**
 * Admitting the draft, which the conversation that asked for it owns.
 *
 * Separate from {@link RootReading} because its answer is written down. A
 * submission binds a reservation into the chat history that asked for it, so it
 * needs the response that asked — and a response is the owner's, not the loop's.
 */
export type SubmitForReply = () => Operation<Result<SubmitReceipt>>;

/**
 * Build the requests one response is answered by.
 *
 * Per response rather than per process: `submit` closes over the response that
 * asked, which is what makes a reservation readable afterwards as that reply's.
 * The reads are stateless over the root, so they cost a response that does not
 * use them nothing.
 */
export function sidekickRequests(root: RootReading, submit: SubmitForReply): SidekickRequests {
  return {
    *bindings(): Operation<Result<Json>> {
      // The root data as it stands: the retained head for every entry that has
      // settled, and the current root of the entry running now on top of it.
      // In the record shape the trusted-host entrypoint takes, detached and
      // frozen by the readings it came from.
      //
      // The live half is what makes this answerable at all for a reply whose
      // own entry is held at a question: those values are in no record yet, so
      // a read that only projected would report them as absent while the entry
      // that bound them is waiting to be told about them.
      const read = yield* root.bindings();
      return read.ok ? Ok(read.value as Json) : read;
    },
    *entrySyntax(names?: readonly string[]): Operation<Result<string>> {
      try {
        return Ok(
          names === undefined || names.length === 0
            ? yield* root.vocabulary.symbols()
            : yield* root.vocabulary.documentation(names),
        );
      } catch (error) {
        // A name the vocabulary does not document refuses *this operation*. The
        // response goes on: a reply that asked about the wrong spelling may well
        // ask about the right one next.
        return Err(error instanceof Error ? error : new Error(String(error)));
      }
    },
    guide(chapter: GuideChapter): Operation<Result<string>> {
      return readGuideChapter(chapter);
    },
    environment(): Operation<Result<string>> {
      return replEnvironment(root.session);
    },
    fillDraft(source: string): Operation<Result<void>> {
      return root.fill(source);
    },
    submit(): Operation<Result<SubmitReceipt>> {
      return submit();
    },
    // deno-lint-ignore require-yield
    *entryOutput(request: OutputReadRequest): Operation<Result<OutputRead>> {
      const head = root.acknowledged();
      if (!head.ok) {
        return head;
      }
      return readEntryOutput(request, observedEntries(head.value, root.printing()));
    },
    // deno-lint-ignore require-yield
    *inspectSource(request: EntryReadRequest): Operation<Result<EntryTextPage>> {
      const read = inspected(root);
      return read.ok ? readEntrySource(request, read.value) : read;
    },
    // deno-lint-ignore require-yield
    *inspectPrompt(request: EntryPromptRequest): Operation<Result<EntryPromptPage>> {
      const read = inspected(root);
      return read.ok ? readEntryPrompt(request, read.value) : read;
    },
    // deno-lint-ignore require-yield
    *inspectOutput(request: EntryReadRequest): Operation<Result<EntryTextPage>> {
      const read = inspected(root);
      return read.ok ? readEntryOutputWindow(request, read.value) : read;
    },
    // deno-lint-ignore require-yield
    *inspectJournal(request: EntryReadRequest): Operation<Result<EntryJournalPage>> {
      const read = inspected(root);
      return read.ok ? readEntryJournal(request, read.value) : read;
    },
  };
}

/**
 * The saved evidence one inspection reads, taken once.
 *
 * One acknowledged head and one printing fact per read, like every other read
 * here: two inspections in one response that straddle an append see the file
 * either side of it rather than one copy taken when the response started. An
 * unreadable file refuses rather than answering from a stale projection.
 */
function inspected(root: RootReading): Result<InspectedHistory> {
  const head = root.acknowledged();
  if (!head.ok) {
    return head;
  }
  return Ok({ entries: head.value.entries, printing: root.printing() });
}

/**
 * What each entry has printed, and how it ended.
 *
 * Two sources for one list, and which one answers depends on whether the entry
 * is over. A settled entry's output is the outcome the history retained — the
 * authority on what it printed, whatever this process happens to remember. An
 * unsettled one has no outcome yet, so its text is whatever this process has
 * observed for *that* entry.
 *
 * Matched by key rather than by position. Attributing the live text to the last
 * entry in the list would be right by accident most of the time and wrong
 * exactly when it matters: the text belongs to the task producing it, and that
 * task names its own entry.
 */
export function observedEntries(
  head: ReplModel,
  printing: ReplPrinting | undefined,
): readonly ObservedEntry[] {
  return Object.freeze(
    head.entries.map((entry) =>
      Object.freeze({
        id: entry.key,
        output: entry.terminal?.output ?? (entry.key === printing?.entry ? printing.output : ""),
        status: statusOf(entry.terminal?.status),
      }),
    ),
  );
}

/** How one entry ended, in the words a read answers with. */
function statusOf(terminal: "ok" | "err" | "cancelled" | undefined): ObservedEntry["status"] {
  switch (terminal) {
    case "ok":
      return "completed";
    case "err":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      // No outcome recorded, which for the entry a history ends on means it is
      // still going. A read says so rather than reporting it as finished with
      // whatever it has printed so far.
      return "running";
  }
}
