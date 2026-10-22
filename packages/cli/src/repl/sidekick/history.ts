/**
 * One execution's Sidekick history, beside the entry history it belongs to.
 *
 * The entry file holds exactly what it holds today — serialized DurableEvents,
 * one per line, with its own root-import grammar, entry ids and History markers
 * — and this feature adds not one record to it. Chat is not entry work: a
 * conversation outlives every entry in it, survives a History selection that
 * freezes the entry projection, and has facts of its own (which agent, which
 * conversation, which turn carried which feedback) that no entry's journal has
 * a place for. So an execution that has a Sidekick owns a *pair* of files, and
 * the pair is the unit: `v1/<execution>/entries.jsonl` beside
 * `v1/<execution>/sidekick.jsonl`.
 *
 * Reading is hostile in exactly the way `journal.ts` is hostile, and for the
 * same reason. A record this version cannot read, a line that is not a record,
 * a final line with no newline, a required file that is missing or is not a
 * regular file, an owner naming another execution — each is a refusal that
 * changes nothing. A refusal never truncates the file, never repairs it, never
 * falls back to the older single-file format and never opens a replacement
 * conversation: a history half-read is somebody's work, and the one thing worse
 * than refusing to show it is showing a prefix as the whole of it. Diagnostics
 * say what is wrong and quote none of it back.
 *
 * ## Publication is a fact, not a state to be inferred
 *
 * A published pair holds two records before anything else: an `owner`, which
 * names the format version, the execution and — when this pair grew out of an
 * older single-file history — the exact origin it was copied from, and a
 * `ready`, which acknowledges that both files are established. Both records and
 * both files are required. A directory with one of the four is *not* a pair
 * that can be repaired into one; it is an interrupted publication, and the
 * older file it came from is still the recoverable history. That is why the
 * origin is fingerprinted rather than merely named: a pair names a specific
 * byte count and digest, and an older file that no longer matches is a
 * conflict, not an alternate writer to continue from.
 *
 * An older `<execution>.jsonl` stays readable forever and is never converted by
 * being opened. The upgrade happens on the first explicit Sidekick message and
 * nowhere else, which is what keeps reopening a chat free of provider work and
 * free of writes.
 *
 * ## The writer is a facade, because the destination moves once
 *
 * An entry already running when its execution is upgraded must not be
 * restarted, and must not keep appending to the file the pair has just
 * superseded. Both are true only if what that entry holds is not a file but a
 * `movableWriter` — one stable object every `EntrySegmentStream` keeps, whose
 * physical destination is switched exactly once, by the root, inside the
 * handoff. A task holding the facade therefore cannot retain a writer to the
 * old path, because it never had one.
 *
 * The handoff's order is the whole of its safety: hold admissions, wait for the
 * append already in flight, copy and fingerprint the exact acknowledged prefix,
 * write `owner` and `ready`, then switch the destination — with no suspension
 * between acknowledging publication and selecting the writer, so no event can
 * reach the old path after the published prefix was chosen.
 */

import { ensureDir, exists, readTextFile, stat } from "@effectionx/fs";
import { join } from "node:path";
import {
  parseDurableEvent,
  serializeDurableEvent,
  serializeError,
} from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, SerializedError } from "@executablemd/durable-streams";
import { call, ensure, scoped, withResolvers } from "effection";
import type { Operation } from "effection";

import { ReplHost } from "../host.ts";
import { readRecords, RetainedReplStream } from "../journal.ts";
import type { MovableWriter, RetainedStream } from "../journal.ts";
import { isOpaqueExecution } from "../route.ts";

/** What the Sidekick history could not be read or written as, and nothing it held. */
export class SidekickHistoryError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "SidekickHistoryError";
  }
}

/** The only format version this CLI writes, and the only one it reads. */
export const SIDEKICK_VERSION = 1;

/** The directory one version's paired executions live under. */
export const PAIRED_DIRECTORY = "v1";

/** The two files a published pair is made of. */
export const ENTRIES_FILE = "entries.jsonl";
export const SIDEKICK_FILE = "sidekick.jsonl";

/** An outcome retained the way the repository serializes one. */
export type RetainedOutcome =
  | { readonly status: "ok" }
  | { readonly status: "err"; readonly error: SerializedError };

/** What an older single-file history was, exactly, when a pair grew out of one. */
export interface RetainedOrigin {
  /** The byte count of the file this pair was published from. */
  readonly bytes: number;
  /** Its SHA-256, so a changed origin is a conflict rather than a fallback. */
  readonly sha256: string;
  /** How many records of it were copied as this pair's entry prefix. */
  readonly records: number;
}

/**
 * Exactly what an entry journal held, at a record boundary.
 *
 * The same three facts a {@link RetainedOrigin} keeps, and for the same reason:
 * a count says how many records, and the encoded byte count and digest say
 * *which* records. A reservation that kept only the count would be naming an
 * ordinal, and a different valid history of the same length would satisfy it —
 * so what the reader compares is the bytes.
 *
 * Measured off the file rather than off parsed records. Re-encoding a parsed
 * record rebuilds its envelope in this process's member order, which is a valid
 * encoding of the same history and not the same bytes, so a fingerprint of one
 * establishes nothing about the other.
 */
export interface RetainedPrefix {
  /** How many terminated records the prefix holds. */
  readonly records: number;
  /** The byte count of exactly those records, encoded as UTF-8. */
  readonly bytes: number;
  /** Their SHA-256, so a changed prefix is a refusal rather than a fallback. */
  readonly sha256: string;
}

/**
 * One line of a Sidekick history.
 *
 * The families are the ones the storage contract requires, and the shapes are
 * this CLI's own: nothing here is a public protocol, and nothing here grants
 * authority. An owner id correlates records; it is not an identity holder, a native
 * session, an admission permission or a configuration decision. Those are
 * canonical Core and provider facts, and they stay there.
 */
export type SidekickRecord =
  | OwnerRecord
  | ReadyRecord
  | ConversationRecord
  | PreferencesRecord
  | ReferenceRecord
  | MessageRecord
  | EventRecord
  | ResponseRecord
  | ControlRecord
  | ControlOutcomeRecord
  | FeedbackRecord;

/** Ownership: which execution this history belongs to, and what it came from. */
export interface OwnerRecord {
  readonly kind: "owner";
  readonly version: number;
  readonly execution: string;
  /** Present only for a pair published from an older single-file history. */
  readonly origin?: RetainedOrigin;
}

/** Publication: both files are established, so this pair may be used. */
export interface ReadyRecord {
  readonly kind: "ready";
}

/** Which conversation is selected, under which agent, and what preceded it. */
export interface ConversationRecord {
  readonly kind: "conversation";
  readonly conversation: string;
  readonly agent: string;
  /**
   * `prepared` before setup, `activated` only once setup succeeded, `failed`
   * when it did not. A failure activates no replacement, and every earlier
   * conversation stays retained.
   */
  readonly phase: "prepared" | "activated" | "failed";
  /** The association this one replaces, when it replaces one. */
  readonly previous?: string;
  /** Why setup failed, for a `failed` phase. */
  readonly error?: SerializedError;
}

/** The model and effort a person asked this conversation for. */
export interface PreferencesRecord {
  readonly kind: "preferences";
  readonly conversation: string;
  readonly model: string | null;
  readonly effort: string | null;
}

/**
 * The exact orientation a particular turn was given.
 *
 * Retained rather than recomputed, because "what did this agent actually know"
 * is a fact about that turn. Full chapter bodies are not here: they arrive only
 * when read, and a read is retained as its own control outcome. An index
 * version is not proof that a chapter was ever delivered.
 */
export interface ReferenceRecord {
  readonly kind: "reference";
  readonly conversation: string;
  /**
   * The message ID this orientation went with — not a saved turn.
   *
   * Named `turn` because these bytes are already written and their schema is
   * not migrated. Which saved turn carried this orientation is established
   * through that message's own request, never by reading this number as one.
   */
  readonly turn: number;
  readonly bootstrap: string;
  readonly index: string;
  readonly surface: string;
  readonly versions: Readonly<Record<string, string>>;
}

/** Exactly what a person sent, and which chat revision it cleared. */
export interface MessageRecord {
  readonly kind: "message";
  readonly conversation: string;
  /**
   * This message's ID — it does not identify a turn.
   *
   * This host's own numbering, written before the turn and never rewritten
   * afterwards, scoped to the conversation and not promised to be contiguous.
   * It keeps the name `turn` because these bytes are already written and their
   * schema is not migrated. Which saved turn this message's request became
   * is established from the records for that request, and the two numbers
   * happening to agree establishes nothing.
   */
  readonly turn: number;
  readonly revision: number;
  readonly text: string;
}

/**
 * One canonical Core event, unchanged, in the conversation that owns it.
 *
 * The event is the canonical record exactly as Core wrote it. The conversation
 * and sequence around it are this file's own addressing, which is what lets one
 * physical file hold several conversations while each adapter below exposes one
 * of them — and only one — to Core.
 */
export interface EventRecord {
  readonly kind: "event";
  readonly conversation: string;
  readonly sequence: number;
  readonly event: string;
}

/** What a completed turn's response actually rendered to. */
export interface ResponseRecord {
  readonly kind: "response";
  readonly conversation: string;
  readonly turn: number;
  readonly response: string;
  readonly outcome: RetainedOutcome;
  /** Whether the evaluated root selected person-facing chat. */
  readonly hasOutput: boolean;
  /** The actual rendered text, partial renderings included. */
  readonly output: string;
}

/**
 * One control a response is about to run, and what it was given.
 *
 * Written *before* the control runs, and its outcome is a record of its own.
 * Two records rather than one because the gap between them is a fact somebody
 * has to be able to read: a conversation interrupted after a control began and
 * before it answered holds an intent with no outcome, and that is exactly what
 * cold projection must report — an operation that was started and whose result
 * nobody knows. Folded into one record, an interrupted control would be
 * indistinguishable from one that never began.
 */
export interface ControlRecord {
  readonly kind: "control";
  readonly conversation: string;
  readonly response: string;
  /** Its position among that response's controls, in admission order. */
  readonly order: number;
  readonly component: string;
  readonly arguments: unknown;
  /** Submit alone binds the slot it reserved, so a crash can be reconciled. */
  readonly submit?: {
    /**
     * How many entries preceded the reservation, which names the slot.
     *
     * Separate from `retained`, and a different number: one entry writes many
     * journal records, so this counts admitted entries and that counts lines.
     * The ordinal says which slot was taken; only `retained` says which
     * history it was taken against.
     */
    readonly ordinal: number;
    readonly entry: string;
    readonly source: string;
    readonly revision: number;
    readonly workspace?: true;
    /** The exact entry journal this reservation was taken against. */
    readonly retained: RetainedPrefix;
  };
}

/** What one control answered, written once it has answered. */
export interface ControlOutcomeRecord {
  readonly kind: "control-outcome";
  readonly conversation: string;
  readonly response: string;
  /** The intent this answers, by the order that intent was written under. */
  readonly order: number;
  readonly outcome: RetainedOutcome;
  /** The retained observation, for a read whose answer is its own fact. */
  readonly observed?: unknown;
}

/**
 * The ordered operation facts one next turn was given, and that turn's identity.
 *
 * `text` is the **exact input that turn was sent** — the ordered operation
 * facts and the context that went with them, as one request, because that is
 * what the contract's feedback family retains and what a canonical record can
 * be compared against.
 *
 * Retaining a formatted fragment instead would be useless here: a completed
 * turn at some ordinal proves a turn happened, and the only thing that proves
 * it carried *this* is its own canonical input. A projector comparing a
 * fragment to a whole request could establish nothing, so what is retained is
 * the whole request. Anything a turn carries that is not in this text is not
 * something this record may state was delivered.
 */
export interface FeedbackRecord {
  readonly kind: "feedback";
  readonly conversation: string;
  readonly response: string;
  /**
   * The turn this feedback was delivered into, once one accepted it.
   *
   * `null` while nothing has: the text was retained before the turn that would
   * carry it, so it asserts only what this host was sending. A reader
   * reconciles it against the saved turn among the records for that
   * request rather than taking this record's word for a delivery.
   */
  readonly turn: number | null;
  /** Exactly what that turn was sent, which its canonical record must match. */
  readonly text: string;
}

/* ---------------------------------------------------------------- protocol */

/**
 * One record as a line, terminated.
 *
 * The newline is part of the record, exactly as it is for
 * `serializeDurableEvent`: a file whose last line has none is a write that did
 * not finish, and that is only a readable signal if a finished write always
 * ends in one.
 */
export function serializeSidekickRecord(record: SidekickRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * One line as a record, or nothing when this version cannot read it.
 *
 * Every record is *constructed* from members this function has checked, never
 * asserted into shape. The difference is the whole of the protocol's
 * strictness: a cast accepts whatever the file happens to hold and hands a
 * typed value to code that then trusts it, so a `null` where a serialized error
 * belongs becomes a `ResponseRecord` nobody can read rather than a refusal at
 * the boundary. Undeclared members are refused too — a record carrying one is a
 * record some other version wrote.
 */
export function parseSidekickRecord(line: string): SidekickRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!plain(value)) {
    return undefined;
  }
  switch (value.kind) {
    case "owner":
      return ownerOf(value);
    case "ready":
      return exactly(value, ["kind"]) ? { kind: "ready" } : undefined;
    case "conversation":
      return conversationOf(value);
    case "preferences":
      return preferences(value);
    case "reference":
      return reference(value);
    case "message":
      return message(value);
    case "event":
      return eventRecord(value);
    case "response":
      return response(value);
    case "control":
      return control(value);
    case "control-outcome":
      return controlOutcome(value);
    case "feedback":
      return feedback(value);
    default:
      return undefined;
  }
}

/** A JSON object and nothing else: not an array, not null, not a primitive. */
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether this object's members are exactly the declared ones. */
function exactly(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const declared = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!declared.has(key)) {
      return false;
    }
  }
  return required.every((key) => Object.hasOwn(record, key));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A serialized error the repository's own conventions would produce. */
function serialized(value: unknown): SerializedError | undefined {
  if (!plain(value) || !exactly(value, ["message"], ["name", "stack"])) {
    return undefined;
  }
  const held = str(value.message);
  if (held === undefined) {
    return undefined;
  }
  const name = Object.hasOwn(value, "name") ? str(value.name) : undefined;
  const stack = Object.hasOwn(value, "stack") ? str(value.stack) : undefined;
  if (
    (Object.hasOwn(value, "name") && name === undefined) ||
    (Object.hasOwn(value, "stack") && stack === undefined)
  ) {
    return undefined;
  }
  return {
    message: held,
    ...(name === undefined ? {} : { name }),
    ...(stack === undefined ? {} : { stack }),
  };
}

function outcomeOf(value: unknown): RetainedOutcome | undefined {
  if (!plain(value)) {
    return undefined;
  }
  if (value.status === "ok") {
    return exactly(value, ["status"]) ? { status: "ok" } : undefined;
  }
  if (value.status !== "err" || !exactly(value, ["status", "error"])) {
    return undefined;
  }
  const error = serialized(value.error);
  return error === undefined ? undefined : { status: "err", error };
}

/** A map of strings to strings, which is what a version table is. */
function versionsOf(value: unknown): Record<string, string> | undefined {
  if (!plain(value)) {
    return undefined;
  }
  const held: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    const text = str(member);
    if (text === undefined) {
      return undefined;
    }
    held[key] = text;
  }
  return held;
}

function ownerOf(value: Record<string, unknown>): OwnerRecord | undefined {
  if (!exactly(value, ["kind", "version", "execution"], ["origin"])) {
    return undefined;
  }
  const version = whole(value.version);
  const execution = str(value.execution);
  if (version === undefined || execution === undefined) {
    return undefined;
  }
  if (!Object.hasOwn(value, "origin")) {
    return { kind: "owner", version, execution };
  }
  if (!plain(value.origin) || !exactly(value.origin, ["bytes", "sha256", "records"])) {
    return undefined;
  }
  const bytes = whole(value.origin.bytes);
  const sha256 = str(value.origin.sha256);
  const records = whole(value.origin.records);
  if (bytes === undefined || sha256 === undefined || records === undefined) {
    return undefined;
  }
  return { kind: "owner", version, execution, origin: { bytes, sha256, records } };
}

function conversationOf(value: Record<string, unknown>): ConversationRecord | undefined {
  if (!exactly(value, ["kind", "conversation", "agent", "phase"], ["previous", "error"])) {
    return undefined;
  }
  const held = str(value.conversation);
  const agent = str(value.agent);
  const phase = value.phase;
  if (
    held === undefined ||
    agent === undefined ||
    (phase !== "prepared" && phase !== "activated" && phase !== "failed")
  ) {
    return undefined;
  }
  let previous: string | undefined;
  if (Object.hasOwn(value, "previous")) {
    previous = str(value.previous);
    if (previous === undefined) {
      return undefined;
    }
  }
  let error: SerializedError | undefined;
  if (Object.hasOwn(value, "error")) {
    error = serialized(value.error);
    if (error === undefined) {
      return undefined;
    }
  }
  return {
    kind: "conversation",
    conversation: held,
    agent,
    phase,
    ...(previous === undefined ? {} : { previous }),
    ...(error === undefined ? {} : { error }),
  };
}

function preferences(value: Record<string, unknown>): PreferencesRecord | undefined {
  if (!exactly(value, ["kind", "conversation", "model", "effort"])) {
    return undefined;
  }
  const held = str(value.conversation);
  if (held === undefined) {
    return undefined;
  }
  const model = value.model === null ? null : str(value.model);
  const effort = value.effort === null ? null : str(value.effort);
  if (model === undefined || effort === undefined) {
    return undefined;
  }
  return { kind: "preferences", conversation: held, model, effort };
}

function reference(value: Record<string, unknown>): ReferenceRecord | undefined {
  if (
    !exactly(value, ["kind", "conversation", "turn", "bootstrap", "index", "surface", "versions"])
  ) {
    return undefined;
  }
  const held = str(value.conversation);
  const turn = whole(value.turn);
  const bootstrap = str(value.bootstrap);
  const index = str(value.index);
  const surface = str(value.surface);
  const versions = versionsOf(value.versions);
  if (
    held === undefined ||
    turn === undefined ||
    bootstrap === undefined ||
    index === undefined ||
    surface === undefined ||
    versions === undefined
  ) {
    return undefined;
  }
  return {
    kind: "reference",
    conversation: held,
    turn,
    bootstrap,
    index,
    surface,
    versions,
  };
}

function message(value: Record<string, unknown>): MessageRecord | undefined {
  if (!exactly(value, ["kind", "conversation", "turn", "revision", "text"])) {
    return undefined;
  }
  const held = str(value.conversation);
  const turn = whole(value.turn);
  const revision = whole(value.revision);
  const text = str(value.text);
  if (held === undefined || turn === undefined || revision === undefined || text === undefined) {
    return undefined;
  }
  return { kind: "message", conversation: held, turn, revision, text };
}

function eventRecord(value: Record<string, unknown>): EventRecord | undefined {
  if (!exactly(value, ["kind", "conversation", "sequence", "event"])) {
    return undefined;
  }
  const held = str(value.conversation);
  const sequence = whole(value.sequence);
  const event = str(value.event);
  if (held === undefined || sequence === undefined || event === undefined) {
    return undefined;
  }
  // The canonical record it carries has to be one, or this line is describing a
  // turn nobody can read back.
  if (!parseDurableEvent(event).ok) {
    return undefined;
  }
  return { kind: "event", conversation: held, sequence, event };
}

function response(value: Record<string, unknown>): ResponseRecord | undefined {
  if (
    !exactly(value, ["kind", "conversation", "turn", "response", "outcome", "hasOutput", "output"])
  ) {
    return undefined;
  }
  const held = str(value.conversation);
  const turn = whole(value.turn);
  const named = str(value.response);
  const outcome = outcomeOf(value.outcome);
  const output = str(value.output);
  if (
    held === undefined ||
    turn === undefined ||
    named === undefined ||
    outcome === undefined ||
    typeof value.hasOutput !== "boolean" ||
    output === undefined
  ) {
    return undefined;
  }
  return {
    kind: "response",
    conversation: held,
    turn,
    response: named,
    outcome,
    hasOutput: value.hasOutput,
    output,
  };
}

function control(value: Record<string, unknown>): ControlRecord | undefined {
  if (
    !exactly(
      value,
      ["kind", "conversation", "response", "order", "component", "arguments"],
      ["submit"],
    )
  ) {
    return undefined;
  }
  const held = str(value.conversation);
  const named = str(value.response);
  const order = whole(value.order);
  const component = str(value.component);
  if (held === undefined || named === undefined || order === undefined || component === undefined) {
    return undefined;
  }
  let submit: ControlRecord["submit"];
  if (Object.hasOwn(value, "submit")) {
    if (
      !plain(value.submit) ||
      !exactly(value.submit, ["ordinal", "entry", "source", "revision", "retained"], ["workspace"])
    ) {
      return undefined;
    }
    const ordinal = whole(value.submit.ordinal);
    const entry = str(value.submit.entry);
    const source = str(value.submit.source);
    const revision = whole(value.submit.revision);
    if (Object.hasOwn(value.submit, "workspace") && value.submit.workspace !== true) {
      return undefined;
    }
    // Required, not optional. A Submit without it cannot be reconciled against
    // anything, and reading one as though the ordinal were the binding is how
    // the ordinal came to be treated as a prefix in the first place — so a
    // record missing it is not a record this grammar has.
    const retained = retainedPrefix(value.submit.retained);
    if (
      ordinal === undefined ||
      entry === undefined ||
      source === undefined ||
      revision === undefined ||
      retained === undefined
    ) {
      return undefined;
    }
    submit = {
      ordinal,
      entry,
      source,
      revision,
      retained,
      ...(value.submit.workspace === true ? { workspace: true } : {}),
    };
  }
  return {
    kind: "control",
    conversation: held,
    response: named,
    order,
    component,
    arguments: value.arguments,
    ...(submit === undefined ? {} : { submit }),
  };
}

function retainedPrefix(value: unknown): RetainedPrefix | undefined {
  if (!plain(value) || !exactly(value, ["records", "bytes", "sha256"])) {
    return undefined;
  }
  const records = whole(value.records);
  const bytes = whole(value.bytes);
  const sha256 = str(value.sha256);
  if (records === undefined || bytes === undefined || sha256 === undefined) {
    return undefined;
  }
  return { records, bytes, sha256 };
}

function controlOutcome(value: Record<string, unknown>): ControlOutcomeRecord | undefined {
  if (!exactly(value, ["kind", "conversation", "response", "order", "outcome"], ["observed"])) {
    return undefined;
  }
  const held = str(value.conversation);
  const named = str(value.response);
  const order = whole(value.order);
  const outcome = outcomeOf(value.outcome);
  if (held === undefined || named === undefined || order === undefined || outcome === undefined) {
    return undefined;
  }
  return {
    kind: "control-outcome",
    conversation: held,
    response: named,
    order,
    outcome,
    ...(Object.hasOwn(value, "observed") ? { observed: value.observed } : {}),
  };
}

function feedback(value: Record<string, unknown>): FeedbackRecord | undefined {
  if (!exactly(value, ["kind", "conversation", "response", "turn", "text"])) {
    return undefined;
  }
  const held = str(value.conversation);
  const named = str(value.response);
  const text = str(value.text);
  const turn = value.turn === null ? null : whole(value.turn);
  if (held === undefined || named === undefined || text === undefined || turn === undefined) {
    return undefined;
  }
  return { kind: "feedback", conversation: held, response: named, turn, text };
}

/** An outcome from a thrown failure, the way the repository serializes one. */
export function failedOutcome(error: unknown): RetainedOutcome {
  return {
    status: "err",
    error: serializeError(error instanceof Error ? error : new Error(String(error))),
  };
}

/* -------------------------------------------------------------- locations */

/** Where one paired execution's two files live. */
export interface PairedLocation {
  readonly directory: string;
  readonly entries: string;
  readonly sidekick: string;
}

/** The pair's paths for this execution, with the identifier checked first. */
export function pairedLocation(root: string, execution: string): PairedLocation {
  if (!isOpaqueExecution(execution)) {
    // Before the join, never after: an identifier that could address a parent
    // directory must not become a path at all.
    throw new SidekickHistoryError(
      "an execution is named by the opaque identifier the REPL created for it",
    );
  }
  const directory = join(root, PAIRED_DIRECTORY, execution);
  return {
    directory,
    entries: join(directory, ENTRIES_FILE),
    sidekick: join(directory, SIDEKICK_FILE),
  };
}

/* ------------------------------------------------------------------ reading */

/** Every record a Sidekick file holds, in append order. */
export function* readSidekickRecords(path: string): Operation<SidekickRecord[]> {
  if (!(yield* exists(path))) {
    throw new SidekickHistoryError("this execution's chat history is missing from its pair.");
  }
  const target = yield* stat(path);
  if (!target.isFile()) {
    throw new SidekickHistoryError("this execution's chat history is not a file.");
  }
  const body = yield* readTextFile(path);
  if (body.length === 0) {
    return [];
  }
  if (!body.endsWith("\n")) {
    throw new SidekickHistoryError(
      "this execution's chat history ends in a record that was never finished writing.",
    );
  }
  const records: SidekickRecord[] = [];
  for (const line of body.slice(0, -1).split("\n")) {
    const parsed = parseSidekickRecord(line);
    if (parsed === undefined) {
      // Its text stays out of this. What is in one of these files is a
      // conversation somebody had.
      throw new SidekickHistoryError(
        `this execution's chat history holds a record this version cannot read (record ` +
          `${records.length + 1}).`,
      );
    }
    records.push(parsed);
  }
  return records;
}

/**
 * The records of a pair that is actually published, for this execution.
 *
 * The two leading records are the publication, so they are checked as
 * publication rather than searched for: a file whose first record is not an
 * owner was not published by this CLI, and one whose owner names another
 * execution is a directory that does not belong to this history.
 */
export function* readPublishedPair(
  location: PairedLocation,
  execution: string,
): Operation<{ owner: OwnerRecord; records: SidekickRecord[] }> {
  if (!(yield* exists(location.entries))) {
    throw new SidekickHistoryError("this execution's entry history is missing from its pair.");
  }
  const entries = yield* stat(location.entries);
  if (!entries.isFile()) {
    throw new SidekickHistoryError("this execution's entry history is not a file.");
  }
  const records = yield* readSidekickRecords(location.sidekick);
  const owner = records[0];
  if (owner === undefined || owner.kind !== "owner") {
    throw new SidekickHistoryError(
      "this execution's chat history does not begin with the record that publishes it, so this " +
        "is an interrupted publication rather than a history to continue.",
    );
  }
  if (owner.version !== SIDEKICK_VERSION) {
    throw new SidekickHistoryError(
      `this execution's chat history is version ${owner.version}, which this build does not ` +
        "read. A newer CLI wrote it.",
    );
  }
  if (owner.execution !== execution) {
    throw new SidekickHistoryError(
      "this chat history belongs to another execution, so reading it here would join two " +
        "histories into one.",
    );
  }
  if (records[1]?.kind !== "ready") {
    throw new SidekickHistoryError(
      "this execution's chat history was never acknowledged as ready, so its pair is an " +
        "interrupted publication rather than a history to continue.",
    );
  }
  // The publication is the first two records and only the first two. A later
  // `owner` is a second claim on one history — conflicting ownership, whether
  // it names this execution or another — and a later `ready` would make
  // publication something a file could reopen. Checked across the whole file
  // rather than at the front, because what a reader does with the front is
  // decide whether to trust the rest of it.
  for (const [index, record] of records.entries()) {
    if (index < 2 || (record.kind !== "owner" && record.kind !== "ready")) {
      continue;
    }
    throw new SidekickHistoryError(
      `this execution's chat history claims its ownership twice (record ${index + 1}), so which ` +
        "execution it belongs to cannot be established here.",
    );
  }
  return { owner, records };
}

/**
 * Check that the origin an owner record names is still the file it named.
 *
 * An older file that matches is this pair's retained origin and nothing else —
 * never a current writer, and never a history to fall back to. One that no
 * longer matches is a conflict: something other than this feature wrote it, and
 * guessing which of the two is current is exactly the guess that would lose
 * somebody's work.
 */
export function* verifyRetainedOrigin(origin: RetainedOrigin, path: string): Operation<void> {
  if (!(yield* exists(path))) {
    // Gone is not a conflict. The pair is the history; the origin was a
    // courtesy, and this feature never deleted it.
    return;
  }
  const body = yield* readTextFile(path);
  const measured = yield* fingerprint(body);
  if (measured.bytes !== origin.bytes || measured.sha256 !== origin.sha256) {
    throw new SidekickHistoryError(
      "the older history this execution was published from has changed since, so which of the " +
        "two is current cannot be established here.",
    );
  }
}

/**
 * The terminated lines one JSON-lines body holds, each keeping its newline.
 *
 * Terminated, because a prefix is measured in bytes: dropping the newlines and
 * rejoining would give a different count than the file holds, and what an owner
 * record names is a digest of the file's own bytes.
 */
export function terminatedLines(body: string): string[] {
  if (body.length === 0) {
    return [];
  }
  if (!body.endsWith("\n")) {
    throw new SidekickHistoryError(
      "this execution's history ends in a record that was never finished writing.",
    );
  }
  return body
    .slice(0, -1)
    .split("\n")
    .map((line) => `${line}\n`);
}

/** Every durable event one body holds, parsed for validity. */
export function parseEntryRecords(body: string): DurableEvent[] {
  const events: DurableEvent[] = [];
  for (const line of terminatedLines(body)) {
    const parsed = parseDurableEvent(line);
    if (!parsed.ok) {
      throw new SidekickHistoryError(
        `this execution's entry history holds a record this version cannot read (record ` +
          `${events.length + 1}).`,
      );
    }
    events.push(parsed.value);
  }
  return events;
}

/**
 * Check that a pair's entry file still begins with the origin it declares.
 *
 * The owner record names a specific prefix — so many records, so many bytes,
 * one digest — and a pair whose entry file no longer begins with it is not the
 * pair that record describes. Compared at a record boundary rather than at a
 * byte offset, because a prefix cut mid-record would make the next record's own
 * bytes part of what the digest is compared against.
 *
 * Records after it are allowed and expected: the execution carries on appending
 * past the copy, which is the whole point of having made it.
 */
export function* verifyCopiedPrefix(origin: RetainedOrigin, entriesPath: string): Operation<void> {
  const lines = terminatedLines(yield* readTextFile(entriesPath));
  if (lines.length < origin.records) {
    throw new SidekickHistoryError(
      "this execution's entry history holds fewer records than the prefix it was published " +
        "with, so it is not the history that pair describes.",
    );
  }
  const claimed = lines.slice(0, origin.records).join("");
  const measured = yield* fingerprint(claimed);
  if (measured.bytes !== origin.bytes || measured.sha256 !== origin.sha256) {
    throw new SidekickHistoryError(
      "this execution's entry history no longer begins with the records it was published with, " +
        "so which history this chat belongs to cannot be established here.",
    );
  }
}

/**
 * Bind the entry journal exactly as it stands, at a record boundary.
 *
 * Every terminated record in the file, which is the whole of what has been
 * acknowledged: an unterminated last line is a write that did not finish, and
 * binding it would bind bytes no reader is going to measure the same way.
 *
 * Read off the file. The caller holds the slot while this suspends, and entry
 * journals only ever grow, so what this measures cannot be changed underneath
 * it by anything that is allowed to happen — only by something that is not,
 * which is exactly what the reader has to refuse.
 */
export function* bindRetainedPrefix(entriesPath: string): Operation<RetainedPrefix> {
  const lines = terminatedLines(yield* readTextFile(entriesPath));
  const measured = yield* fingerprint(lines.join(""));
  return { records: lines.length, bytes: measured.bytes, sha256: measured.sha256 };
}

/**
 * Measure what a bound prefix names, against the file as it now stands.
 *
 * `measured` is absent when the file holds fewer records than the binding
 * names, which is a refusal rather than a mismatch to describe: a history
 * shorter than the one a reservation was taken against is not a later state of
 * it. Records after the bound prefix are ordinary — the entry the reservation
 * reserved is one of them.
 */
export function* measureRetainedPrefix(
  entriesPath: string,
  claimed: number,
): Operation<{
  /** How many terminated records the file holds now. */
  readonly records: number;
  readonly measured: { readonly bytes: number; readonly sha256: string } | undefined;
}> {
  const lines = terminatedLines(yield* readTextFile(entriesPath));
  if (lines.length < claimed) {
    return { records: lines.length, measured: undefined };
  }
  return { records: lines.length, measured: yield* fingerprint(lines.slice(0, claimed).join("")) };
}

/**
 * The byte count and digest of exactly this text.
 *
 * Web Crypto, which every runtime this CLI ships on has, so the fingerprint
 * needs nothing from the host boundary. The byte count is of the encoded UTF-8
 * rather than of the string's code units, because the count an owner record
 * names has to be the count a later reader measures off the file.
 */
export function* fingerprint(body: string): Operation<{ bytes: number; sha256: string }> {
  const bytes = new TextEncoder().encode(body);
  const digest = yield* call(() => crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { bytes: bytes.length, sha256: hex };
}

/* ------------------------------------------------------------------ writing */

/**
 * An append-only Sidekick writer over one file.
 *
 * Append reaches the file first and is remembered only then, which is the same
 * order `RetainedReplStream` keeps and for the same reason: a local record of a
 * write that was never retained describes a history the file does not hold.
 *
 * ## One append at a time, for every caller
 *
 * The write and the remembering are one operation, and a second caller waits
 * for both. Several things write to this one file now — a person's message, a
 * reply's feedback and controls, the wrapped canonical events of a turn, and a
 * preference somebody saves while all of that is running — and without one
 * order two of them can interleave at the host and arrive in the file in an
 * order neither caller chose. The acknowledged records would then describe a
 * history the file does not hold, which is the one thing reading them is for:
 * the preference a turn takes is the last one *acknowledged*, so memory and
 * disk disagreeing is a turn sent under settings nobody asked for.
 *
 * It is held for exactly that long. A prompt, a response's evaluation, a
 * question, a wait for an entry, an inspection and an agent setup all happen
 * outside it — a save meant to coexist with a running cycle must not queue
 * behind the cycle it is coexisting with.
 */
export class SidekickWriter {
  readonly path: string;
  private records: SidekickRecord[];
  /** Whether some caller owns the writer right now. */
  private writing = false;
  /**
   * Whether a record is between this writer and the file right now.
   *
   * A fact rather than something to wait on. Waiting is the caller's: the task
   * that asked for the append is the only thing that can be *joined*, and a
   * promise this writer resolved in its own teardown would say "finished" for a
   * write that was abandoned halfway. So whoever is leaving reads this to tell
   * a caller that has reached the file from one still waiting its turn, and
   * then joins or cancels that caller accordingly.
   */
  private reaching: SidekickRecord["kind"] | undefined;
  /**
   * The callers waiting for it, oldest first.
   *
   * A queue of turns rather than a chain of waits, because leaving the queue
   * and giving up ownership are different things. A caller cancelled while it
   * waits takes only its own place out of the line; the one holding the writer
   * goes on holding it, and the caller behind the cancelled one still waits for
   * *that* caller rather than being let past it.
   */
  private readonly queued: Turn[] = [];

  constructor(path: string, retained: readonly SidekickRecord[] = []) {
    this.path = path;
    this.records = [...retained];
  }

  /** Every record retained so far, in append order. */
  // deno-lint-ignore require-yield
  *readAll(): Operation<SidekickRecord[]> {
    return [...this.records];
  }

  *append(record: SidekickRecord): Operation<void> {
    // A scope of its own, so the handoff below is *this* append's destructor
    // rather than its caller's. `ensure` inside a generator reached by `yield*`
    // belongs to the frame that is running, and nearly every caller here
    // appends more than once in one scope — the second append would then be
    // waiting for a writer the first one had not let go of yet.
    yield* scoped(() => this.ordered(record));
  }

  /**
   * The kind of record between this writer and the file right now, or none.
   *
   * The kind rather than a flag, because what a command that is leaving has to
   * know is whether *its own* work is the thing in flight: the message cycle
   * writes here too, and joining a save that is still waiting its turn would
   * let it append after everything else had been let go of. One that has
   * reached the file has to be joined — its bytes and this writer's memory of
   * them are not yet both there — and one still waiting has written nothing, so
   * cancelling it publishes nothing. This writer cannot do the joining itself:
   * only the task that asked for the append can be joined.
   */
  get appending(): SidekickRecord["kind"] | undefined {
    return this.reaching;
  }

  private *ordered(record: SidekickRecord): Operation<void> {
    // One turn object, so what this caller is — waiting, or holding — is a fact
    // the handoff below can set rather than something the caller has to be
    // resumed to notice. A caller cancelled between being handed ownership and
    // waking up would otherwise leave the writer owned by nobody.
    const turn: Turn = { owning: false, ready: withResolvers<void>() };
    // Established before the writer is taken, and the only path that gives it
    // up: however this ends — written, failed, or cancelled while waiting or
    // while holding — exactly one of "leave the queue" and "hand the writer on"
    // happens.
    yield* ensure(() => {
      if (turn.owning) {
        this.pass();
        return;
      }
      const at = this.queued.indexOf(turn);
      if (at !== -1) {
        this.queued.splice(at, 1);
      }
    });
    // Taken synchronously: two callers reaching this in one turn of the loop
    // take their places in the order they arrived rather than in the order the
    // scheduler happens to resume them.
    if (this.writing) {
      this.queued.push(turn);
      yield* turn.ready.operation;
    }
    this.writing = true;
    turn.owning = true;
    // Said before the bytes go, so whoever is leaving can tell a caller that
    // has reached the file from one still waiting its turn.
    this.reaching = record.kind;
    try {
      // The write and the remembering together. A caller that read the records
      // between the two would see a history the file already had and this
      // writer did not.
      yield* ReplHost.operations.appendRecord(this.path, serializeSidekickRecord(record));
      this.records.push(record);
    } finally {
      this.reaching = undefined;
    }
  }

  /**
   * Hand the writer to whoever has waited longest, or let it go.
   *
   * Ownership passes directly rather than being released and re-taken: nothing
   * between the two moments can take it, so a caller that arrives in that
   * window queues behind the one being woken instead of overtaking it.
   */
  private pass(): void {
    const next = this.queued.shift();
    if (next === undefined) {
      this.writing = false;
      return;
    }
    next.owning = true;
    next.ready.resolve();
  }
}

/** One caller's place in the writer's queue, and whether it holds the writer. */
interface Turn {
  owning: boolean;
  readonly ready: { readonly operation: Operation<void>; resolve(): void };
}

/* --------------------------------------------------------------- adapters */

/**
 * The one conversation a Core owner may see, as a `DurableStream`.
 *
 * Core is handed a canonical sequence and nothing else: not the file, not the
 * other conversations in it, and not this CLI's own records. Reading answers
 * with this conversation's events in order; appending wraps the canonical event
 * unchanged and acknowledges only once the physical append has.
 */
export function conversationStream(
  writer: SidekickWriter,
  conversation: string,
  retained: readonly SidekickRecord[] = [],
): DurableStream {
  let sequence = retained.filter(
    (record) => record.kind === "event" && record.conversation === conversation,
  ).length;
  return {
    *readAll(): Operation<DurableEvent[]> {
      const events: DurableEvent[] = [];
      for (const record of yield* writer.readAll()) {
        if (record.kind !== "event" || record.conversation !== conversation) {
          continue;
        }
        const parsed = parseDurableEvent(record.event);
        if (!parsed.ok) {
          throw new SidekickHistoryError(
            `this conversation holds a canonical record this version cannot read (record ` +
              `${events.length + 1}).`,
          );
        }
        events.push(parsed.value);
      }
      return events;
    },
    *append(event: DurableEvent): Operation<void> {
      yield* writer.append({
        kind: "event",
        conversation,
        sequence: sequence,
        event: serializeDurableEvent(event),
      });
      sequence += 1;
    },
  };
}

/* ------------------------------------------------------------- publication */

/** What one upgrade or creation published, for the root that asked for it. */
export interface Publication {
  readonly location: PairedLocation;
  /** The entry writer the root must switch to, before releasing the handoff. */
  readonly entries: RetainedStream;
  readonly sidekick: SidekickWriter;
}

/**
 * Publish a pair for an execution that has none, copying an exact prefix.
 *
 * The order is the contract. Both files are created exclusively, the copied
 * prefix is appended record by record so the new entry file holds exactly the
 * records the old one held, the owner naming that exact origin is written, and
 * `ready` is written last — so a crash anywhere before `ready` leaves a
 * directory that refuses rather than a pair that looks usable, and leaves the
 * original recoverable and untouched.
 *
 * Nothing here executes a copied record. They are a person's history, not a
 * migration script.
 */
export function* publishPair(
  root: string,
  execution: string,
  prefix: {
    /**
     * The acknowledged bytes to copy, exactly as the older file holds them.
     *
     * The bytes rather than the events, because re-encoding parsed events is
     * not copying them: `parseDurableEvent` rebuilds an envelope in its own
     * member order and `serializeDurableEvent` preserves whatever order it is
     * handed, so a round trip produces *a* valid encoding of the same history
     * and not the encoding the origin's digest describes. The events beside it
     * are that same snapshot parsed, for the retained stream to answer reads.
     */
    readonly body: string;
    readonly events: readonly DurableEvent[];
    readonly origin?: RetainedOrigin;
  },
): Operation<Publication> {
  const location = pairedLocation(root, execution);
  yield* ensureDir(location.directory);
  yield* ensureDir(join(location.directory, "components"));

  if ((yield* exists(location.entries)) || (yield* exists(location.sidekick))) {
    throw new SidekickHistoryError(
      "this execution already has a paired history, so publishing a second one would leave two " +
        "histories for one chat.",
    );
  }
  try {
    yield* ReplHost.operations.createExclusive(location.entries);
    yield* ReplHost.operations.createExclusive(location.sidekick);
  } catch (error) {
    throw new SidekickHistoryError("this execution's paired history could not be created.", {
      cause: error,
    });
  }

  if (prefix.body.length > 0) {
    // One append of the whole snapshot. Every record it holds is already
    // terminated, so the copy is byte-for-byte what the origin's digest covers.
    yield* ReplHost.operations.appendRecord(location.entries, prefix.body);
  }
  const sidekick = new SidekickWriter(location.sidekick);
  yield* sidekick.append({
    kind: "owner",
    version: SIDEKICK_VERSION,
    execution,
    ...(prefix.origin === undefined ? {} : { origin: prefix.origin }),
  });
  yield* sidekick.append({ kind: "ready" });

  return { location, entries: pairedEntryStream(location.entries, prefix.events), sidekick };
}

/**
 * The entry stream of a published pair, over the records it already holds.
 *
 * The same class the single-file format uses, because the records are the same
 * records: publication changed where they live and nothing about what they are.
 */
export function pairedEntryStream(path: string, retained: readonly DurableEvent[]): RetainedStream {
  return new RetainedReplStream(path, retained);
}

/** Open a pair that is already published, with both of its histories. */
export function* openPair(
  root: string,
  execution: string,
  legacyPath: string,
): Operation<{
  location: PairedLocation;
  owner: OwnerRecord;
  entries: RetainedStream;
  sidekick: SidekickWriter;
  records: SidekickRecord[];
}> {
  const location = pairedLocation(root, execution);
  const { owner, records } = yield* readPublishedPair(location, execution);
  if (owner.origin === undefined) {
    // A pair that grew out of nothing claims no origin, so an older file beside
    // it is not this history's past — it is a second history for one execution,
    // and nothing here can say which of them is current.
    if (yield* exists(legacyPath)) {
      throw new SidekickHistoryError(
        "an older history exists beside a pair that was not published from one, so which of " +
          "the two this execution is cannot be established here.",
      );
    }
  } else {
    yield* verifyRetainedOrigin(owner.origin, legacyPath);
    yield* verifyCopiedPrefix(owner.origin, location.entries);
  }
  const events = yield* readRecords(location.entries);
  return {
    location,
    owner,
    entries: pairedEntryStream(location.entries, events),
    sidekick: new SidekickWriter(location.sidekick, records),
    records,
  };
}

/**
 * Upgrade a legacy execution to a published pair, in the one order that is safe.
 *
 * Called by the root, which has already stopped admitting entries and paused
 * its own appends: this is the mechanism, not the policy. The order is the
 * contract, and each step is here because of what the step after it would
 * otherwise be allowed to do.
 *
 * Waiting for the in-flight append comes first, because a prefix copied while a
 * record was still being written would be a prefix the file does not hold.
 * Fingerprinting the exact bytes comes next, so the published pair names the
 * origin it actually grew out of and a later reader can tell that origin from
 * an unrelated file. `ready` is written last of the four writes, so a crash
 * anywhere earlier leaves a directory that refuses rather than a pair that
 * looks usable — and leaves the original the recoverable history it still is.
 *
 * Then the writer is redirected with no suspension in between. That is the
 * whole reason `redirect` is synchronous: between acknowledging publication and
 * selecting the new destination there is no point at which another coroutine
 * could append to the path whose prefix was just declared final.
 */
export function* upgradeExecution(
  root: string,
  execution: string,
  legacyPath: string,
  writer: MovableWriter,
): Operation<Publication> {
  // A scope of its own, so the release below is this handoff's own destructor
  // rather than its caller's: `ensure` inside a `yield*`-ed generator belongs to
  // the frame that is running, and the hold has to end when the handoff does.
  return yield* scoped(function* (): Operation<Publication> {
    // Registered *before* the hold is taken, not around the work that follows
    // it. `hold()` marks the writer held and then waits for the record already
    // in flight, so a cancellation arriving during that wait leaves a writer
    // nothing would ever release — and the entry's next record would wait
    // forever. Cleanup before acquisition covers that interval too.
    //
    // It releases to whichever target the handoff left: the published pair's
    // entry file once the writer has moved, and the original when the
    // publication failed, was refused, or never got that far.
    yield* ensure(() => {
      writer.release();
    });
    // Held for the whole handoff, not merely waited on at the start of it. An
    // entry that is still running keeps writing through this facade, and a
    // record it writes after the bytes below have been copied would reach the
    // superseded file alone — leaving the published pair without it and the
    // retained origin no longer matching the fingerprint taken from it, which
    // is what makes the execution refuse to reopen at all.
    yield* writer.hold();
    // One snapshot, read once: what is fingerprinted, what is parsed for
    // validity and what is copied are the same bytes. Reading the file a second
    // time would let a record land between the reads and leave the owner record
    // describing neither of them.
    const body = yield* readTextFile(legacyPath);
    const measured = yield* fingerprint(body);
    const events = parseEntryRecords(body);
    const publication = yield* publishPair(root, execution, {
      body,
      events,
      origin: { bytes: measured.bytes, sha256: measured.sha256, records: events.length },
    });

    writer.redirect(publication.entries);
    return publication;
  });
}
