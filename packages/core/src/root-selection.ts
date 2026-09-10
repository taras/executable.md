/**
 * The retained root-import protocol (spec §7).
 *
 * One recorded event decides what a resumed or replayed run is allowed to be a
 * continuation of, and reading it is not shape checking. The record has to say
 * which document was selected, and the recorded document has to agree: markdown
 * that no parser accepts, a target the document does not offer, and a recorded
 * failure the same selector would not produce are each a record no execution
 * wrote, not a record with a missing field.
 *
 * It lives on its own because two callers depend on the same answer. Canonical
 * execution admits a partial history through it, and a host that reads a
 * retained journal — the workflow package, which decides from the same events
 * whether a run may publish an outcome or be replayed — reaches it through
 * `@executablemd/core/host`. A second reading of the same durable value would
 * be a second, weaker protocol, and the day the two stopped agreeing is the day
 * a forged selection became executable.
 *
 * Everything here is synchronous and pure. Nothing an Effection scope owns
 * passes through, so no cancellation and no durability failure can be swallowed
 * by a parse.
 */

import type { Yield } from "@executablemd/durable-streams";
import { isJsonObject, parseJson } from "./json.ts";
import { documentOutline } from "./definition.ts";
import {
  asDocumentTargetError,
  findTarget,
  isCanonicalTarget,
  recordedDocumentTargetFailure,
  sameDocumentTargetFailure,
} from "./document-targets.ts";
import type { DocumentOutline, DocumentTargetFailure } from "./document-targets.ts";

/**
 * What one run's selector decided: the whole document, one exact section, or a
 * failure that named none.
 *
 * Selection is compared as an outcome rather than as a target string, because a
 * failed selection is an outcome too. Without the third case a journal written
 * by one selector that matched nothing would answer a later request for a
 * section that does exist.
 */
export type SelectionOutcome =
  | { kind: "whole" }
  | { kind: "exact"; target: string }
  | { kind: "failed"; failure: DocumentTargetFailure };

/**
 * What a recorded event turned out to be.
 *
 * "Not the root import" and "the root import, malformed" are deliberately
 * different answers. Collapsing them into one absent value is what would let a
 * corrupted record fall through to the recorded terminal result, which is the
 * failure this distinction exists to prevent.
 */
export type RootImportRecord =
  | { kind: "unrelated" }
  | { kind: "malformed" }
  | {
      kind: "read";
      /** The document the record is about, as its own parsed copy. */
      path: string;
      content: string;
      outline: DocumentOutline;
      selection: SelectionOutcome;
    };

export const UNRELATED: RootImportRecord = { kind: "unrelated" };
export const MALFORMED: RootImportRecord = { kind: "malformed" };

/**
 * Read a value that may refuse to be read.
 *
 * Every value this boundary touches comes from the journal, and a journal is
 * data: a property may be an accessor that throws, a key list may come from a
 * Proxy that refuses, and content may be markdown whose frontmatter no parser
 * accepts. None of those is a failure of this run — they are ways of saying the
 * record cannot be read — so none of them may travel as an error of its own.
 *
 * Synchronous throughout, so nothing an Effection scope owns passes through
 * here: this cannot swallow a cancellation or a durability failure, because
 * neither can arise inside a synchronous parse.
 */
export function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Parse a recorded root import as a closed protocol.
 *
 * Two selection shapes are supported and nothing else: a repository selection
 * with an optional canonical target, and a failed selection with an exact
 * failure record. An unknown kind, a missing or mistyped member, an extra
 * member, a noncanonical target, and failure data that no selection could have
 * produced are each malformed rather than absent.
 *
 * A result that is not `ok` is left alone. A root import can fail for reasons
 * that have nothing to do with selection — an unreadable file — and those
 * recorded failures are not this protocol's to interpret.
 */
/**
 * A value the journal refused to produce.
 *
 * Distinct from `undefined`, which is an ordinary absent value. Reading a
 * member and finding nothing there, and reading a member that will not say what
 * is there, are different facts about a record, and one of them is a refusal:
 * conflating them is how "the root import will not say what it settled to"
 * became "this is not the root import" and fell through to terminal-result
 * reuse.
 */
export const UNREADABLE: unique symbol = Symbol("unreadable");

/** One read of journal-controlled data: its value, or a refusal. */
export function read<T>(get: () => T): T | typeof UNREADABLE {
  try {
    return get();
  } catch {
    return UNREADABLE;
  }
}

/** The settlements the protocol recognizes as an ordinary failed root import. */
const SETTLED_FAILURES: readonly string[] = ["err", "cancelled"];

export function recordedRootImport(event: Yield): RootImportRecord {
  // Identification first. An event that will not say what it is cannot be
  // claimed as the root import, so it stays unrelated.
  const description = read(() => event.description);
  if (description === UNREADABLE) {
    return UNRELATED;
  }
  const type = read(() => description.type);
  const name = read(() => description.name);
  if (type !== "import_component" || name !== "__root__") {
    return UNRELATED;
  }

  // Identified. From here the event owes this protocol an answer, and every way
  // of not giving one is malformed — except the ordinary failed settlement,
  // which is a root import that failed for reasons selection knows nothing
  // about.
  const result = read(() => event.result);
  if (result === UNREADABLE || typeof result !== "object" || result === null) {
    return MALFORMED;
  }
  const status = read(() => result.status);
  if (status !== "ok") {
    return typeof status === "string" && SETTLED_FAILURES.includes(status) ? UNRELATED : MALFORMED;
  }
  const value = read(() => ("value" in result ? result.value : undefined));
  if (value === UNREADABLE || value === undefined) {
    return MALFORMED;
  }
  return attempt(() => readRootSelection(value)) ?? MALFORMED;
}

function readRootSelection(value: unknown): RootImportRecord {
  // Parsed rather than read in place. `parseJson` walks every property once and
  // rebuilds the record, so a trap that throws or a value that is not JSON is
  // discovered here — and every read below is of this run's own copy rather
  // than of an object the journal still controls.
  const record = parseJson(value);
  if (!isJsonObject(record)) {
    return MALFORMED;
  }
  const content = record["content"];
  const path = record["path"];
  if (typeof content !== "string" || typeof path !== "string") {
    return MALFORMED;
  }
  const kind = record["kind"];
  const members = Object.keys(record).length;
  // Parsing the recorded content is part of reading the record, for every
  // shape. It is what the verification below compares against, and doing it
  // here means a later read of the same content cannot be the first to
  // discover that it does not parse.
  const outline = documentOutline(path, content);

  if (kind === "repository") {
    const target = record["target"];
    if (target === undefined) {
      return members === 3
        ? { kind: "read", path, content, outline, selection: { kind: "whole" } }
        : MALFORMED;
    }
    if (members !== 4 || typeof target !== "string" || !isCanonicalTarget(target)) {
      return MALFORMED;
    }
    // The recorded content is here, so the target is verified against it rather
    // than merely parsed: a well-formed target the recorded document does not
    // offer describes a selection that never happened.
    const resolved = findTarget(outline, target);
    if (!resolved.ok || resolved.value.target !== target) {
      return MALFORMED;
    }
    return { kind: "read", path, content, outline, selection: { kind: "exact", target } };
  }

  if (kind === "target-failure") {
    const failure = recordedDocumentTargetFailure(record["failure"]);
    if (members !== 4 || failure === undefined) {
      return MALFORMED;
    }
    // Same standard for a failure: the recorded selector must fail against the
    // recorded content in exactly the way the record claims. That verifies the
    // catalog and the matches too, which no amount of shape checking could.
    const rederived = findTarget(outline, failure.selector);
    if (rederived.ok) {
      return MALFORMED;
    }
    const actual = asDocumentTargetError(rederived.error);
    if (actual === undefined || !sameDocumentTargetFailure(actual.data, failure)) {
      return MALFORMED;
    }
    return { kind: "read", path, content, outline, selection: { kind: "failed", failure } };
  }

  return MALFORMED;
}
