/**
 * Four bounded reads of one entry's saved evidence: its source, one turn's
 * text, its output and its record metadata.
 *
 * A failed entry still has to explain itself. What it ran is its admitted
 * source; what it asked and what came back are its saved turns; what it printed
 * is its retained output; and where each of those is in the file is its records.
 * Journal locates evidence and Prompt reads the selected turn, which is why
 * neither of them carries the other's body.
 *
 * Everything here is pure. It is handed the frozen entries one acknowledged
 * reading already projected and the one printing fact this process owns, and it
 * answers with plain JSON pages. There is no filesystem, no provider, no entry
 * task, and no way for a read to start, resume or wait for work.
 *
 * ## Selectors resolve once, and the answer states them absolutely
 *
 * `entry` and `prompt` are nonzero integers. A positive entry number is
 * immutable admission order and a positive prompt number is a retained
 * sequence plus one; omitted and `-1` mean the latest, and a further negative
 * counts backward. Each is resolved once, against this moment, and every
 * `previous`/`next` restates it as the exact number it resolved to — so a
 * continuation followed after another entry has been admitted still reads the
 * entry it was about.
 *
 * A prompt's absolute number is its own, never its position in the saved list:
 * two turns of one entry finish in whatever order their providers answered, and
 * a missing sequence refuses rather than being renumbered into its neighbour.
 *
 * ## Windows count what a person reads
 *
 * Text offsets and limits count Unicode code points, so a window never ends
 * halfway through a character; Journal's count records. Source and Prompt start
 * at the beginning, and Output's omitted offset is the tail — the same
 * normalization an output read has always had, because it is the same question.
 *
 * ## Absence is answered as itself
 *
 * A turn that recorded no error is `text: null`; one that recorded an empty
 * string is `""`. An entry with no retained output and no owner printing it has
 * an empty window rather than an invented one. Evidence that is not there at
 * all refuses, so nothing fabricates a page for a prompt the history never
 * held.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import type { ReplAgentTurn, ReplEntry, ReplPosition, ReplRecord } from "../model.ts";

/** Why one inspection could not be performed. */
export class EntryInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntryInspectionError";
  }
}

/** The default text window, when a read states no limit. */
export const DEFAULT_TEXT_LIMIT = 4096;

/** The default record window, when a Journal read states no limit. */
export const DEFAULT_RECORD_LIMIT = 20;

/** What one entry is doing, as every one of these reads reports it. */
export type EntryStatus = "completed" | "failed" | "cancelled" | "running" | "unfinished";

/** What one saved turn settled to. */
export type PromptStatus = "completed" | "failed" | "cancelled";

/** Which of a saved turn's three texts a Prompt read asks for. */
export type PromptField = "reply" | "request" | "error";

/** What one inspection reads: the acknowledged entries, and what is printing. */
export interface InspectedHistory {
  readonly joined?: { readonly entry: string; readonly output: string };
  readonly entries: readonly ReplEntry[];
  /**
   * The entry this process is printing, and its text so far.
   *
   * The exact owner, matched by key. An entry with no terminal evidence is
   * `running` only where it is this one; any other unsettled entry is
   * `unfinished`, because a cold reader has nobody to ask.
   */
  readonly printing: { readonly entry: string; readonly output: string } | undefined;
}

/** Where an authored element was written, as a page states it. */
type PagePosition = {
  readonly path: string | null;
  readonly generatedSource: string | null;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
};

/** The complete arguments of the Source or Output read beside this one. */
type TextContinuation = {
  readonly entry: number;
  readonly offset: number;
  readonly limit: number;
};

/** The complete arguments of the Prompt read beside this one. */
type PromptContinuation = {
  readonly entry: number;
  readonly prompt: number;
  readonly field: PromptField;
  readonly offset: number;
  readonly limit: number;
};

/** One window of an entry's admitted source, or of what it printed. */
export type EntryTextPage = {
  readonly entry: number;
  readonly status: EntryStatus;
  readonly text: string;
  readonly offset: number;
  readonly length: number;
  readonly limit: number;
  readonly previous: TextContinuation | null;
  readonly next: TextContinuation | null;
};

/** One window of one saved turn's reply, request or failure message. */
export type EntryPromptPage = {
  readonly entry: number;
  readonly status: EntryStatus;
  readonly prompt: number;
  readonly agent: string;
  readonly promptStatus: PromptStatus;
  readonly position: PagePosition | null;
  readonly field: PromptField;
  /** The saved text, or `null` where the turn recorded none at all. */
  readonly text: string | null;
  readonly offset: number;
  readonly length: number;
  readonly limit: number;
  readonly previous: PromptContinuation | null;
  readonly next: PromptContinuation | null;
};

/** One saved event, as a Journal page states it. */
type PageRecord = {
  readonly marker: string;
  readonly type: string;
  readonly name: string | null;
  readonly status: string;
  readonly position: PagePosition | null;
  readonly prompt: number | null;
  readonly agent: string | null;
};

/** How one entry's saved turns ended, counted over the whole entry. */
type PromptCounts = {
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
};

/** One window of an entry's record metadata, with what it failed at. */
export type EntryJournalPage = {
  readonly entry: number;
  readonly status: EntryStatus;
  /** The complete saved failure message, independent of the record window. */
  readonly failure: string | null;
  readonly prompts: PromptCounts;
  readonly records: PageRecord[];
  readonly offset: number;
  readonly length: number;
  readonly limit: number;
  readonly previous: TextContinuation | null;
  readonly next: TextContinuation | null;
};

/** What a Source, Output or Journal read asked for. */
export interface EntryReadRequest {
  readonly entry?: number;
  readonly offset?: number;
  readonly limit?: number;
}

/** What a Prompt read asked for. */
export interface EntryPromptRequest extends EntryReadRequest {
  readonly prompt?: number;
  readonly field?: string;
}

/**
 * One window of the exact source an entry was admitted with.
 *
 * The bytes the entry ran, without normalization or re-expansion: what a reader
 * is deciding is whether the program did what it says, and a tidied copy of it
 * is a different program.
 */
export function readEntrySource(
  request: EntryReadRequest,
  history: InspectedHistory,
): Result<EntryTextPage> {
  const limit = resolveLimit(request.limit, DEFAULT_TEXT_LIMIT);
  if (!limit.ok) {
    return limit;
  }
  const found = resolveEntry(request.entry, history.entries);
  if (!found.ok) {
    return found;
  }
  const entry = found.value;
  return Ok(
    textPage(entry, statusOf(entry, history.printing), entry.source, request.offset, limit.value, {
      tail: false,
    }),
  );
}

/**
 * One window of what an entry printed.
 *
 * Terminal evidence first: an entry that settled printed what its outcome
 * retained, whatever this process remembers. Without one, the text is this
 * process's own only where it owns that exact entry — a cold reader of an
 * unfinished entry has an empty window rather than somebody else's output.
 * A cancelled entry may use its owning Send's final joined observation without
 * changing the retained terminal.
 */
export function readEntryOutputWindow(
  request: EntryReadRequest,
  history: InspectedHistory,
): Result<EntryTextPage> {
  const limit = resolveLimit(request.limit, DEFAULT_TEXT_LIMIT);
  if (!limit.ok) {
    return limit;
  }
  const found = resolveEntry(request.entry, history.entries);
  if (!found.ok) {
    return found;
  }
  const entry = found.value;
  const printing = history.printing;
  const observed =
    entry.terminal?.status === "cancelled" && history.joined?.entry === entry.key
      ? history.joined.output
      : (entry.terminal?.output ?? (entry.key === printing?.entry ? printing.output : ""));
  return Ok(
    textPage(entry, statusOf(entry, printing), observed, request.offset, limit.value, {
      // The tail, which is what a reader of output wants almost every time.
      // Explicit zero reads from the beginning, which omission cannot express.
      tail: true,
    }),
  );
}

/**
 * One window of one saved turn's text.
 *
 * `field` chooses which of the three the turn retained: the reply it produced,
 * the request it was sent, or the complete failure message it ended with. A
 * turn that recorded no failure answers `null` rather than an empty window,
 * because "this turn did not fail" and "this turn failed saying nothing" are
 * different facts about it.
 */
export function readEntryPrompt(
  request: EntryPromptRequest,
  history: InspectedHistory,
): Result<EntryPromptPage> {
  const limit = resolveLimit(request.limit, DEFAULT_TEXT_LIMIT);
  if (!limit.ok) {
    return limit;
  }
  const field = resolveField(request.field);
  if (!field.ok) {
    return field;
  }
  const found = resolveEntry(request.entry, history.entries);
  if (!found.ok) {
    return found;
  }
  const entry = found.value;
  const selected = resolvePrompt(request.prompt, entry);
  if (!selected.ok) {
    return selected;
  }
  const turn = selected.value;
  const number = turn.sequence + 1;
  const text = textOf(turn, field.value);
  const common = {
    entry: entry.order,
    status: statusOf(entry, history.printing),
    prompt: number,
    agent: turn.agent,
    promptStatus: turn.status,
    position: pagePosition(turn.position),
    field: field.value,
  };
  if (text === undefined) {
    return Ok(
      Object.freeze({
        ...common,
        text: null,
        offset: 0,
        length: 0,
        limit: limit.value,
        previous: null,
        next: null,
      }),
    );
  }
  const window = windowOf(text, request.offset, limit.value, { tail: false });
  return Ok(
    Object.freeze({
      ...common,
      text: window.text,
      offset: window.offset,
      length: window.length,
      limit: limit.value,
      previous: promptContinuation(window.previous, entry.order, number, field.value, limit.value),
      next: promptContinuation(window.next, entry.order, number, field.value, limit.value),
    }),
  );
}

/**
 * Where one entry's evidence is, and what it failed at.
 *
 * The failure is the complete saved message whatever the record window holds,
 * because a record limit bounds records and a reader who asked for twenty of
 * them did not ask to be told half of why the entry stopped. The counts cover
 * every saved turn of the entry for the same reason.
 */
export function readEntryJournal(
  request: EntryReadRequest,
  history: InspectedHistory,
): Result<EntryJournalPage> {
  const limit = resolveLimit(request.limit, DEFAULT_RECORD_LIMIT);
  if (!limit.ok) {
    return limit;
  }
  const found = resolveEntry(request.entry, history.entries);
  if (!found.ok) {
    return found;
  }
  const entry = found.value;
  const records = entry.records;
  const offset = resolveOffset(request.offset, limit.value, records.length, { tail: false });
  const end = offset + limit.value;
  return Ok(
    Object.freeze({
      entry: entry.order,
      status: statusOf(entry, history.printing),
      failure: entry.terminal?.message ?? null,
      prompts: countPrompts(entry.turns),
      records: records.slice(offset, end).map(pageRecord),
      offset,
      length: records.length,
      limit: limit.value,
      previous: textContinuation(
        offset > 0 ? Math.max(0, offset - limit.value) : undefined,
        entry.order,
        limit.value,
      ),
      next: textContinuation(end < records.length ? end : undefined, entry.order, limit.value),
    }),
  );
}

/** One text page over an entry, with its continuations pinned to that entry. */
function textPage(
  entry: ReplEntry,
  status: EntryStatus,
  text: string,
  stated: number | undefined,
  limit: number,
  how: { readonly tail: boolean },
): EntryTextPage {
  const window = windowOf(text, stated, limit, how);
  return Object.freeze({
    entry: entry.order,
    status,
    text: window.text,
    offset: window.offset,
    length: window.length,
    limit,
    previous: textContinuation(window.previous, entry.order, limit),
    next: textContinuation(window.next, entry.order, limit),
  });
}

/** One window of text, in code points, and where the ones either side start. */
function windowOf(
  text: string,
  stated: number | undefined,
  limit: number,
  how: { readonly tail: boolean },
): {
  readonly text: string;
  readonly offset: number;
  readonly length: number;
  readonly previous: number | undefined;
  readonly next: number | undefined;
} {
  // Once, here: every position below is in code points, and splitting twice
  // would let two halves of one read disagree about how long the text is.
  const points = [...text];
  const offset = resolveOffset(stated, limit, points.length, how);
  const end = offset + limit;
  return {
    text: points.slice(offset, end).join(""),
    offset,
    length: points.length,
    previous: offset > 0 ? Math.max(0, offset - limit) : undefined,
    next: end < points.length ? end : undefined,
  };
}

function textContinuation(
  offset: number | undefined,
  entry: number,
  limit: number,
): TextContinuation | null {
  return offset === undefined ? null : Object.freeze({ entry, offset, limit });
}

function promptContinuation(
  offset: number | undefined,
  entry: number,
  prompt: number,
  field: PromptField,
  limit: number,
): PromptContinuation | null {
  return offset === undefined ? null : Object.freeze({ entry, prompt, field, offset, limit });
}

/**
 * Where a window starts, absolutely.
 *
 * A negative offset counts back from the available end and clamps at the
 * beginning, so asking for the last 4096 points of a shorter text is that text
 * rather than a refusal. A positive offset past the end is left where it is:
 * the window is then empty, which is the truth about that range. Omission is
 * the start, except for a read whose omitted offset means the tail.
 */
function resolveOffset(
  stated: number | undefined,
  limit: number,
  length: number,
  how: { readonly tail: boolean },
): number {
  if (stated === undefined) {
    return how.tail ? Math.max(0, length - limit) : 0;
  }
  // Fractions cannot name a position. Truncating toward the start keeps the
  // window inside what was asked for rather than past it.
  const whole = Number.isInteger(stated) ? stated : Math.trunc(stated);
  return whole < 0 ? Math.max(0, length + whole) : whole;
}

function resolveLimit(stated: number | undefined, fallback: number): Result<number> {
  if (stated === undefined) {
    return Ok(fallback);
  }
  if (!Number.isInteger(stated) || stated <= 0) {
    // Nonpositive and fractional limits are refused rather than rounded: a read
    // that silently became a different read is worse than one that said it
    // could not be performed.
    return Err(
      new EntryInspectionError(
        "a limit is a positive whole number, so this read cannot be performed.",
      ),
    );
  }
  return Ok(stated);
}

/**
 * Which entry one selector names.
 *
 * A positive number is immutable admission order, counting from one. Omitted
 * and `-1` are the latest, and a further negative counts backward from it.
 * Zero names nothing and a fraction names nothing, so both refuse rather than
 * being rounded into an entry somebody did not ask for.
 */
function resolveEntry(
  stated: number | undefined,
  entries: readonly ReplEntry[],
): Result<ReplEntry> {
  const latest = entries[entries.length - 1];
  if (stated === undefined) {
    if (latest === undefined) {
      return Err(new EntryInspectionError("this execution has admitted no entries to read."));
    }
    return Ok(latest);
  }
  if (!Number.isInteger(stated) || stated === 0) {
    return Err(
      new EntryInspectionError(
        "an entry is named by its admission number counting from one, or by a negative " +
          "position back from the latest, so this read cannot be performed.",
      ),
    );
  }
  const found = stated > 0 ? entries[stated - 1] : entries[entries.length + stated];
  if (found === undefined) {
    return Err(
      new EntryInspectionError(
        `this execution has no entry at ${stated}, so there is nothing to read there.`,
      ),
    );
  }
  return Ok(found);
}

/**
 * Which saved turn one selector names.
 *
 * A positive number is a retained sequence plus one, looked up by that sequence
 * rather than by position: a missing one refuses, because renumbering it into
 * the next saved turn would answer about a different turn than the reader
 * asked about. Omitted and `-1` are the last turn in canonical sequence order,
 * and a further negative counts backward through that order.
 */
function resolvePrompt(stated: number | undefined, entry: ReplEntry): Result<ReplAgentTurn> {
  const turns = entry.turns;
  if (turns.length === 0) {
    return Err(
      new EntryInspectionError(
        `entry ${entry.order} saved no agent turns, so there is no prompt to read.`,
      ),
    );
  }
  if (stated === undefined || stated === -1) {
    return Ok(turns[turns.length - 1]);
  }
  if (!Number.isInteger(stated) || stated === 0) {
    return Err(
      new EntryInspectionError(
        "a prompt is named by its saved sequence plus one, or by a negative position back from " +
          "the last, so this read cannot be performed.",
      ),
    );
  }
  if (stated < 0) {
    const found = turns[turns.length + stated];
    if (found === undefined) {
      return Err(
        new EntryInspectionError(
          `entry ${entry.order} has no prompt at ${stated}, so there is nothing to read there.`,
        ),
      );
    }
    return Ok(found);
  }
  const found = turns.find((turn) => turn.sequence + 1 === stated);
  if (found === undefined) {
    return Err(
      new EntryInspectionError(
        `entry ${entry.order} saved no prompt ${stated}, so there is nothing to read there.`,
      ),
    );
  }
  return Ok(found);
}

function resolveField(stated: string | undefined): Result<PromptField> {
  if (stated === undefined || stated === "reply") {
    return Ok("reply");
  }
  if (stated === "request" || stated === "error") {
    return Ok(stated);
  }
  return Err(
    new EntryInspectionError(
      `a prompt read is of "reply", "request" or "error", so "${stated}" cannot be read.`,
    ),
  );
}

/** The saved text one field names, or none where the turn retained none. */
function textOf(turn: ReplAgentTurn, field: PromptField): string | undefined {
  switch (field) {
    case "reply":
      return turn.text;
    case "request":
      return turn.input;
    default:
      return turn.failure;
  }
}

/**
 * What one entry is doing, as these reads report it.
 *
 * Terminal evidence wins, including while the task that produced it is still
 * unwinding. Without one, only the entry this process is actually printing is
 * running; every other unsettled entry is unfinished, which is what a history
 * ending without a close says about itself.
 */
function statusOf(entry: ReplEntry, printing: { readonly entry: string } | undefined): EntryStatus {
  switch (entry.terminal?.status) {
    case "ok":
      return "completed";
    case "err":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return entry.key === printing?.entry ? "running" : "unfinished";
  }
}

/** How one entry's saved turns ended, counted over all of them. */
function countPrompts(turns: readonly ReplAgentTurn[]): PromptCounts {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const turn of turns) {
    if (turn.status === "completed") {
      completed += 1;
      continue;
    }
    if (turn.status === "failed") {
      failed += 1;
      continue;
    }
    cancelled += 1;
  }
  return Object.freeze({ completed, failed, cancelled });
}

function pageRecord(record: ReplRecord): PageRecord {
  return Object.freeze({
    marker: record.marker,
    type: record.type,
    name: record.name ?? null,
    status: record.status,
    position: pagePosition(record.position),
    prompt: record.prompt ?? null,
    agent: record.agent ?? null,
  });
}

function pagePosition(position: ReplPosition | undefined): PagePosition | null {
  if (position === undefined) {
    return null;
  }
  return Object.freeze({
    path: position.path ?? null,
    generatedSource: position.generatedSource ?? null,
    offset: position.offset,
    line: position.line,
    column: position.column,
  });
}
