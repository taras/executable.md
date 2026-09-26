/**
 * Durable records in, a closed semantic vocabulary out.
 *
 * The Journal is the append-only durable record of what one REPL execution
 * did. It is not the Execution History: History is the UI projection built
 * from these records, and the two names are kept apart everywhere here.
 *
 * A record arrives as untrusted text — architecture.md's rule is that the
 * journal is parsed, never trusted, and an unreadable record is refused rather
 * than coerced. So this module takes `unknown` and answers a `Result`. Nothing
 * downstream ever sees a record: the projector reads `SemanticEvent`, which is
 * a closed union of nine kinds and carries only strings, numbers and arrays of
 * strings.
 *
 * That closure is the mechanism, not a convention. A record naming a kind this
 * vocabulary does not list is refused, and so is a record carrying a field the
 * kind does not declare — which is what stops a pause controller, a held
 * continuation, a callback, a renderer handle or a terminal cell being written
 * into the durable stream and read back out as though it were an execution
 * fact. The pause controller is process-local (#841) and has nothing to say
 * here.
 *
 * A record's marker is its own opaque identity, never its position. Position
 * orders replay; `id` is what a URL names.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

/** The nine things one REPL execution durably records. */
export const SEMANTIC_KINDS = [
  "entry.submitted",
  "entry.settled",
  "entry.failed",
  "scope.opened",
  "scope.completed",
  "binding.published",
  "suspension.opened",
  "suspension.answered",
  "outcome.recorded",
] as const;

export type SemanticKind = (typeof SEMANTIC_KINDS)[number];

/**
 * The kinds that mint a semantic History marker.
 *
 * Openings mint and closings update: a user-visible scope opening creates one
 * marker, and its completion updates that marker's outcome without creating a
 * closing one. A binding publication and a recorded outcome have no closing
 * half, so each mints its own.
 */
export const MARKER_KINDS: readonly SemanticKind[] = [
  "entry.submitted",
  "scope.opened",
  "binding.published",
  "suspension.opened",
  "outcome.recorded",
];

export function mintsMarker(kind: SemanticKind): boolean {
  return MARKER_KINDS.includes(kind);
}

/** What every record carries: its opaque identity, its position, its time. */
interface Recorded {
  /** The record's opaque durable identity. A marker is one of these. */
  readonly id: string;
  /** Append position, starting at 1. It orders replay and names nothing. */
  readonly seq: number;
  /** Recorded seconds, which is what the Execution History band measures. */
  readonly at: number;
}

export type SemanticEvent =
  | (Recorded & {
      readonly kind: "entry.submitted";
      readonly entry: string;
      readonly title: string;
    })
  | (Recorded & { readonly kind: "entry.settled"; readonly entry: string })
  | (Recorded & { readonly kind: "entry.failed"; readonly entry: string; readonly reason: string })
  | (Recorded & {
      readonly kind: "scope.opened";
      readonly entry: string;
      /** The parent path inside the entry, outermost first. */
      readonly scope: readonly string[];
      readonly name: string;
      /** The scope's ordinal in its parent's body. Concurrent siblings open out of it. */
      readonly source: number;
    })
  | (Recorded & {
      readonly kind: "scope.completed";
      readonly entry: string;
      readonly scope: readonly string[];
      readonly name: string;
    })
  | (Recorded & {
      readonly kind: "binding.published";
      readonly entry: string;
      readonly name: string;
      readonly value: string;
    })
  | (Recorded & {
      readonly kind: "suspension.opened";
      readonly entry: string;
      readonly scope: readonly string[];
      readonly wait: string;
      readonly prompt: string;
    })
  | (Recorded & {
      readonly kind: "suspension.answered";
      readonly entry: string;
      readonly scope: readonly string[];
      readonly wait: string;
    })
  | (Recorded & {
      readonly kind: "outcome.recorded";
      readonly entry: string;
      readonly scope: readonly string[];
      readonly label: string;
    });

/** A record the durable stream holds that this vocabulary cannot read. */
export class JournalParseError extends Error {
  /** The record's append position in the supplied journal, starting at 0. */
  readonly index: number;
  /** The field that refused, or `record` when the record itself did. */
  readonly field: string;

  constructor(index: number, field: string, message: string) {
    super(`record ${index}: ${message}`);
    this.name = "JournalParseError";
    this.index = index;
    this.field = field;
  }
}

/** The fields each kind declares, beyond the envelope. A record carries these and no others. */
const FIELDS: Record<SemanticKind, readonly string[]> = {
  "entry.submitted": ["entry", "title"],
  "entry.settled": ["entry"],
  "entry.failed": ["entry", "reason"],
  "scope.opened": ["entry", "scope", "name", "source"],
  "scope.completed": ["entry", "scope", "name"],
  "binding.published": ["entry", "name", "value"],
  "suspension.opened": ["entry", "scope", "wait", "prompt"],
  "suspension.answered": ["entry", "scope", "wait"],
  "outcome.recorded": ["entry", "scope", "label"],
};

/** The fields that are a path inside an entry rather than a name. */
const PATHS: readonly string[] = ["scope"];

/** The fields that are a number rather than text. */
const NUMBERS: readonly string[] = ["source"];

/** The fields whose text may be empty, because empty is a value they can hold. */
const MAY_BE_EMPTY: readonly string[] = ["reason", "prompt", "value"];

const ENVELOPE: readonly string[] = ["id", "seq", "at", "kind"];

function isRecordObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSemanticKind(value: unknown): value is SemanticKind {
  return typeof value === "string" && SEMANTIC_KINDS.some((kind) => kind === value);
}

function text(index: number, field: string, value: unknown): Result<string> {
  if (typeof value !== "string") {
    return Err(new JournalParseError(index, field, `${field} is not text`));
  }
  if (value === "" && !MAY_BE_EMPTY.includes(field)) {
    return Err(new JournalParseError(index, field, `${field} is empty`));
  }
  return Ok(value);
}

function path(index: number, field: string, value: unknown): Result<readonly string[]> {
  if (!Array.isArray(value)) {
    return Err(new JournalParseError(index, field, `${field} is not a path`));
  }
  const segments: string[] = [];
  for (const segment of value) {
    if (typeof segment !== "string" || segment === "") {
      return Err(new JournalParseError(index, field, `${field} has a segment that is not a name`));
    }
    segments.push(segment);
  }
  return Ok(segments);
}

function ordinal(index: number, field: string, value: unknown): Result<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return Err(new JournalParseError(index, field, `${field} is not a source ordinal`));
  }
  return Ok(value);
}

/**
 * One durable record, read.
 *
 * Every declared field is required and every undeclared one refuses, so a
 * record is complete or it is a refusal. A record cut short — the truncated
 * case — is missing a field it declares, and says which.
 */
function parseRecord(index: number, raw: unknown, seen: Set<string>): Result<SemanticEvent> {
  if (!isRecordObject(raw)) {
    return Err(new JournalParseError(index, "record", "a journal record is a plain object"));
  }
  if (!isSemanticKind(raw.kind)) {
    return Err(
      new JournalParseError(
        index,
        "kind",
        `${JSON.stringify(raw.kind)} is not a semantic kind; the kinds are ${SEMANTIC_KINDS.join(", ")}`,
      ),
    );
  }
  const kind = raw.kind;

  const declared = [...ENVELOPE, ...FIELDS[kind]];
  const extra = Object.keys(raw).find((key) => !declared.includes(key));
  if (extra !== undefined) {
    return Err(
      new JournalParseError(
        index,
        extra,
        `${JSON.stringify(extra)} is not part of a ${kind} record`,
      ),
    );
  }

  const id = text(index, "id", raw.id);
  if (!id.ok) {
    return id;
  }
  if (seen.has(id.value)) {
    return Err(new JournalParseError(index, "id", `${JSON.stringify(id.value)} is recorded twice`));
  }
  seen.add(id.value);

  if (typeof raw.seq !== "number" || raw.seq !== index + 1) {
    return Err(
      new JournalParseError(
        index,
        "seq",
        `seq ${JSON.stringify(raw.seq)} is not append position ${index + 1}; the journal is truncated or reordered`,
      ),
    );
  }
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < 0) {
    return Err(new JournalParseError(index, "at", "at is not a recorded time"));
  }

  const fields: Record<string, string | number | readonly string[]> = {};
  for (const field of FIELDS[kind]) {
    if (!(field in raw)) {
      return Err(new JournalParseError(index, field, `a ${kind} record declares ${field}`));
    }
    const value = raw[field];
    const read = PATHS.includes(field)
      ? path(index, field, value)
      : NUMBERS.includes(field)
        ? ordinal(index, field, value)
        : text(index, field, value);
    if (!read.ok) {
      return read;
    }
    fields[field] = read.value;
  }

  // Building the event by spreading the parsed fields over the parsed envelope
  // keeps one definition of what each kind carries: the field table above.
  const event: unknown = { id: id.value, seq: raw.seq, at: raw.at, kind, ...fields };
  if (!isSemanticEvent(event)) {
    return Err(new JournalParseError(index, "record", `a ${kind} record did not read as one`));
  }
  return Ok(event);
}

function isSemanticEvent(value: unknown): value is SemanticEvent {
  if (!isRecordObject(value) || !isSemanticKind(value.kind)) {
    return false;
  }
  return FIELDS[value.kind].every((field) => field in value);
}

/**
 * A whole journal, read in append order, or the first record that refused.
 *
 * Nothing partial comes back. A journal with one unreadable record is a
 * journal this vocabulary cannot describe, and answering with the records
 * before it would be exactly the plausible partial view #842 refuses.
 */
export function parseJournal(records: readonly unknown[]): Result<readonly SemanticEvent[]> {
  const events: SemanticEvent[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of records.entries()) {
    const event = parseRecord(index, raw, seen);
    if (!event.ok) {
      return event;
    }
    events.push(event.value);
  }
  return Ok(events);
}
