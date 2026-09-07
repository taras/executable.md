/**
 * Issue #774 POC — the strict, read-only provider session-file observer.
 *
 * One boundary reads a coding agent's own append-only session file and reports
 * exactly three normalized things: that the exact attempted bytes were accepted
 * as a user turn, that the assistant produced output, and that an explicit
 * provider completion boundary closed the turn. Everything else the file
 * contains is either skipped or refused; nothing is inferred.
 *
 * The rules that keep it honest:
 *
 * - It locates a file by both the exact native identity and the exact temporary
 *   project identity, and it reads only header/identity records while locating —
 *   never a transcript's contents. Claude is scoped by its per-project directory
 *   and identified by file name; Codex is scoped by the `cwd` its `session_meta`
 *   declares.
 * - A relevant record's own identity, when it carries one, must equal the located
 *   identity; a mismatch refuses.
 * - The cursor advances only past a complete, strictly parsed record. A partial
 *   tail is retained and reread.
 * - Ambiguity, truncation, rotation, identity mismatch and an unsupported
 *   relevant shape each refuse, and a refusal never advances the cursor.
 * - Assistant output and completion carry the provider's own turn identity, so a
 *   completion for a different turn cannot close ours.
 * - It only ever reads. It never writes, repairs, truncates, renames or sweeps a
 *   provider-owned file.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedEvent, Provider } from "./state.ts";

/** Why an observation was refused. Each maps to a role staying safe. */
export type ObservationRefusal =
  | "not-found"
  | "identity-ambiguous"
  | "identity-mismatch"
  | "truncation"
  | "rotation"
  | "unsupported-shape";

/** One located provider file, pinned to the identity found inside it. */
export interface ObservedSource {
  readonly path: string;
  /** The exact native identity this file belongs to. */
  readonly identity: string;
  /** A file-identity token; a change in it is a rotation, not new content. */
  readonly fileKey: string;
}

/** How one provider reads its own records. The shared observer owns the rest. */
export interface ProviderParser {
  readonly provider: Provider;
  /**
   * Whether this build's format has an unambiguous completion record at all.
   *
   * A capability, not a timing observation: when it is false, the observer never
   * yields a completion and the caller reports `PROVIDER_EXCLUDED` from this
   * explicit fact rather than from a deadline elapsing.
   */
  readonly supportsCompletion: boolean;
  /** The identity a file name declares, when the provider encodes it there. */
  identityFromName(name: string): string | undefined;
  /** Read one already-parsed JSON record into a normalized classification. */
  classify(record: Record<string, unknown>): ParsedRecord;
}

/**
 * What one provider record turns out to be.
 *
 * A relevant record's `identity` is optional: some formats repeat the identity on
 * every record (Claude carries `sessionId`), and some declare it once in a header
 * and leave later records to inherit it (Codex's `session_meta`). An `undefined`
 * identity inherits the located file's; a present one is checked against it
 * exactly. `project` on the identity record scopes a shared session root, and
 * `turn` groups assistant output and completion.
 */
export type ParsedRecord =
  | { readonly kind: "identity"; readonly identity: string; readonly project?: string }
  | {
      readonly kind: "user-accepted";
      readonly identity?: string;
      readonly text: string;
      readonly turn?: string;
    }
  | {
      readonly kind: "assistant-output";
      readonly identity?: string;
      readonly text: string;
      readonly turn?: string;
    }
  | { readonly kind: "turn-completed"; readonly identity?: string; readonly turn?: string }
  /** A record with no bearing on acceptance or completion. */
  | { readonly kind: "ignore" }
  /** A relevant record whose required shape is wrong: refuse, never skip. */
  | { readonly kind: "unsupported"; readonly reason: string };

/** The result of locating a provider file for one exact identity and project. */
export type LocateOutcome =
  | { readonly outcome: "located"; readonly source: ObservedSource }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal };

/** The result of reading new records since a cursor. */
export type ReadOutcome =
  | {
      readonly outcome: "advanced";
      readonly events: readonly NormalizedEvent[];
      readonly cursor: number;
    }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal };

/**
 * Whether the events observed so far leave a turn open.
 *
 * A turn is open when a user or assistant event follows the last completion
 * boundary. Convergence reads this — never terminal wording — to decide the
 * provider is idle enough to attempt an input.
 */
export function hasOpenTurn(events: readonly NormalizedEvent[]): boolean {
  let open = false;
  for (const event of events) {
    if (event.kind === "turn-completed") {
      open = false;
    } else {
      open = true;
    }
  }
  return open;
}

/**
 * Find the one file matching `expected` identity and `expectedProject`, exactly.
 *
 * Every `.jsonl` under `directory` is a candidate; a file matches when its name
 * declares the identity (Claude, scoped by its per-project directory) or its
 * header identity record declares the identity and the expected project (Codex).
 * Zero matches is `not-found`; more than one is `identity-ambiguous`. Only
 * header/identity records are read here — never transcript contents.
 */
export function locate(
  parser: ProviderParser,
  directory: string,
  expected: string,
  expectedProject?: string,
): Operation<LocateOutcome> {
  return (function* (): Operation<LocateOutcome> {
    let names: string[];
    try {
      names = (yield* until(readdir(directory))).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return { outcome: "refused", refusal: "not-found" };
    }
    const matches: ObservedSource[] = [];
    for (const name of names) {
      const path = join(directory, name);
      const fromName = parser.identityFromName(name);
      // A file name that carries the identity is scoped by its directory; a
      // shared root is scoped by the header's own project.
      const named = fromName === expected;
      const declared = named
        ? false
        : yield* headerMatches(parser, path, expected, expectedProject);
      if (named || declared) {
        matches.push({ path, identity: expected, fileKey: yield* fileIdentity(path) });
      }
    }
    if (matches.length === 0) {
      return { outcome: "refused", refusal: "not-found" };
    }
    if (matches.length > 1) {
      return { outcome: "refused", refusal: "identity-ambiguous" };
    }
    const [source] = matches;
    if (source === undefined) {
      return { outcome: "refused", refusal: "not-found" };
    }
    return { outcome: "located", source };
  })();
}

/**
 * Whether `path`'s header declares `expected` under `expectedProject`.
 *
 * Reads only up to and including the first identity record — a transcript's user
 * and assistant content is never opened for location.
 */
function headerMatches(
  parser: ProviderParser,
  path: string,
  expected: string,
  expectedProject: string | undefined,
): Operation<boolean> {
  return (function* (): Operation<boolean> {
    // A bounded prefix read: only the header is inspected, never the whole
    // transcript body. A file whose identity record does not fall inside this
    // prefix is not treated as a header-identified match.
    let text: string;
    try {
      text = yield* readPrefix(path, HEADER_PREFIX_BYTES);
    } catch {
      return false;
    }
    // Drop a trailing partial line so a record split by the prefix boundary is
    // never parsed half-read.
    const newline = text.lastIndexOf("\n");
    const complete = newline < 0 ? "" : text.slice(0, newline);
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return false;
      }
      if (!isRecord(record)) {
        return false;
      }
      const parsed = parser.classify(record);
      if (parsed.kind !== "identity") {
        // No identity record before the first relevant/other record: this file
        // does not declare an identity header, so it is not a match here.
        continue;
      }
      if (parsed.identity !== expected) {
        return false;
      }
      // Fail closed on the project: a required project the header does not
      // declare, or declares differently, is not a match. Missing project
      // metadata refuses rather than being accepted.
      if (expectedProject !== undefined && parsed.project !== expectedProject) {
        return false;
      }
      return true;
    }
    return false;
  })();
}

/**
 * Read every complete record after `cursor`, and report the normalized events.
 *
 * The cursor is a byte offset. A trailing record with no newline is a partial
 * tail: it is retained, emits nothing, and does not move the cursor. A refusal —
 * truncation, rotation, an unsupported relevant shape, or a relevant record under
 * the wrong identity — leaves the cursor exactly where it was.
 */
export function read(
  parser: ProviderParser,
  source: ObservedSource,
  cursor: number,
): Operation<ReadOutcome> {
  return (function* (): Operation<ReadOutcome> {
    let currentKey: string;
    let bytes: Uint8Array;
    try {
      currentKey = yield* fileIdentity(source.path);
      bytes = yield* until(readFile(source.path));
    } catch {
      return { outcome: "refused", refusal: "rotation" };
    }
    if (currentKey !== source.fileKey) {
      return { outcome: "refused", refusal: "rotation" };
    }
    if (bytes.length < cursor) {
      return { outcome: "refused", refusal: "truncation" };
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const tail = decoder.decode(bytes.subarray(cursor));
    const segments = tail.split("\n");
    // The last segment has no terminating newline: it is the partial tail.
    const complete = segments.slice(0, -1);

    const events: NormalizedEvent[] = [];
    let advanced = cursor;
    for (const line of complete) {
      const lineBytes = encoder.encode(line).length + 1;
      const start = advanced;
      const end = advanced + lineBytes;
      if (line.trim().length === 0) {
        advanced = end;
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return { outcome: "refused", refusal: "unsupported-shape" };
      }
      if (!isRecord(record)) {
        return { outcome: "refused", refusal: "unsupported-shape" };
      }
      const parsed = parser.classify(record);
      const step = classifyStep(parsed, source.identity, `${source.fileKey}:${start}-${end}`);
      if (step.outcome === "refused") {
        return step;
      }
      if (step.event !== undefined) {
        events.push(step.event);
      }
      advanced = end;
    }
    return { outcome: "advanced", events, cursor: advanced };
  })();
}

/** One record's contribution, or the refusal it forces. */
type Step =
  | { readonly outcome: "kept"; readonly event: NormalizedEvent | undefined }
  | { readonly outcome: "refused"; readonly refusal: ObservationRefusal };

/** A relevant record's identity is either absent (inherit) or exact. */
function identityMatches(recorded: string | undefined, expected: string): boolean {
  return recorded === undefined || recorded === expected;
}

function classifyStep(parsed: ParsedRecord, identity: string, key: string): Step {
  switch (parsed.kind) {
    case "ignore":
      return { outcome: "kept", event: undefined };
    case "identity":
      if (parsed.identity !== identity) {
        return { outcome: "refused", refusal: "identity-mismatch" };
      }
      return { outcome: "kept", event: undefined };
    case "unsupported":
      return { outcome: "refused", refusal: "unsupported-shape" };
    case "user-accepted":
    case "assistant-output":
      if (!identityMatches(parsed.identity, identity)) {
        return { outcome: "refused", refusal: "identity-mismatch" };
      }
      return {
        outcome: "kept",
        event: {
          kind: parsed.kind,
          key,
          identity,
          text: parsed.text,
          ...(parsed.turn === undefined ? {} : { turn: parsed.turn }),
        },
      };
    case "turn-completed":
      if (!identityMatches(parsed.identity, identity)) {
        return { outcome: "refused", refusal: "identity-mismatch" };
      }
      return {
        outcome: "kept",
        event: {
          kind: "turn-completed",
          key,
          identity,
          text: "",
          ...(parsed.turn === undefined ? {} : { turn: parsed.turn }),
        },
      };
  }
}

/** How many bytes of a file's head are read to find its identity record. */
const HEADER_PREFIX_BYTES = 65_536;

/** Read at most `limit` bytes from the start of a file, as UTF-8. */
function readPrefix(path: string, limit: number): Operation<string> {
  return (function* (): Operation<string> {
    const handle = yield* until(open(path, "r"));
    const buffer = new Uint8Array(limit);
    let bytesRead = 0;
    let failure: unknown;
    try {
      ({ bytesRead } = yield* until(handle.read(buffer, 0, limit, 0)));
    } catch (error) {
      failure = error;
    }
    // Closed unconditionally after the read, never inside a finally that yields.
    yield* until(handle.close());
    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    return new TextDecoder().decode(buffer.subarray(0, bytesRead));
  })();
}

/** The file's physical byte length, including any partial tail. */
export function physicalSizeOf(path: string): Operation<number> {
  return (function* (): Operation<number> {
    try {
      const info = yield* until(stat(path));
      return info.size;
    } catch {
      return 0;
    }
  })();
}

/** A stable file-identity token; a change means the file was replaced. */
function fileIdentity(path: string): Operation<string> {
  return (function* (): Operation<string> {
    const info = yield* until(stat(path));
    return `${info.dev}:${info.ino}`;
  })();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
