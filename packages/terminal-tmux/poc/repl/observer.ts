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
 * - It matches only the exact native identity the isolated launch journal
 *   retained. A relevant record under any other identity refuses observation
 *   rather than being read.
 * - The cursor advances only past a complete, strictly parsed record. A partial
 *   tail is retained and reread, so a half-written record never emits an event
 *   or moves the cursor.
 * - Ambiguity (zero or several files for one identity), truncation (the file is
 *   shorter than the cursor), rotation (the file identity changed), and an
 *   unsupported relevant shape each refuse, and a refusal never advances the
 *   cursor.
 * - It only ever reads. It never writes, repairs, truncates, renames or sweeps a
 *   provider-owned file.
 *
 * A provider supplies only how to read *its* records; this module owns the file
 * identity, the byte accounting and the refusals.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { readFile, readdir, stat } from "node:fs/promises";
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
  /** The identity a file name declares, when the provider encodes it there. */
  identityFromName(name: string): string | undefined;
  /** Read one already-parsed JSON record into a normalized classification. */
  classify(record: Record<string, unknown>): ParsedRecord;
}

/**
 * What one provider record turns out to be.
 *
 * A relevant record's `identity` is optional: some formats repeat the identity
 * on every record (Claude carries `sessionId`), and some declare it once in a
 * header and leave later records to inherit it (Codex's `session_meta`). An
 * `undefined` identity inherits the located file's; a present one is checked
 * against it exactly, and a mismatch refuses.
 */
export type ParsedRecord =
  | { readonly kind: "identity"; readonly identity: string }
  | { readonly kind: "user-accepted"; readonly identity?: string; readonly text: string }
  | { readonly kind: "assistant-output"; readonly identity?: string; readonly text: string }
  | { readonly kind: "turn-completed"; readonly identity?: string }
  /** A record with no bearing on acceptance or completion. */
  | { readonly kind: "ignore" }
  /** A relevant record whose required shape is wrong: refuse, never skip. */
  | { readonly kind: "unsupported"; readonly reason: string };

/** The result of locating a provider file for one exact identity. */
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
 * Find the one file whose native identity matches `expected`, exactly.
 *
 * Every `.jsonl` under `directory` is a candidate; a file is a match when its
 * name declares the identity or a record inside it does. Zero matches is
 * `not-found`; more than one is `identity-ambiguous`. Newest-file and
 * most-recently-modified heuristics are deliberately not used.
 */
export function locate(
  parser: ProviderParser,
  directory: string,
  expected: string,
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
      const declares = fromName === expected || (yield* declaresIdentity(parser, path, expected));
      if (declares) {
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

/** Whether any record in `path` declares `expected` as its identity. */
function declaresIdentity(
  parser: ProviderParser,
  path: string,
  expected: string,
): Operation<boolean> {
  return (function* (): Operation<boolean> {
    let bytes: Uint8Array;
    try {
      bytes = yield* until(readFile(path));
    } catch {
      return false;
    }
    const text = new TextDecoder().decode(bytes);
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(record)) {
        continue;
      }
      const parsed = parser.classify(record);
      if (parsed.kind === "identity" && parsed.identity === expected) {
        return true;
      }
    }
    return false;
  })();
}

/**
 * Read every complete record after `cursor`, and report the normalized events.
 *
 * The cursor is a byte offset. A trailing record with no newline is a partial
 * tail: it is retained, emits nothing, and does not move the cursor. A refusal
 * — truncation, rotation, an unsupported relevant shape, or a relevant record
 * under the wrong identity — leaves the cursor exactly where it was.
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
        event: { kind: parsed.kind, key, identity, text: parsed.text },
      };
    case "turn-completed":
      if (!identityMatches(parsed.identity, identity)) {
        return { outcome: "refused", refusal: "identity-mismatch" };
      }
      return {
        outcome: "kept",
        event: { kind: "turn-completed", key, identity, text: "" },
      };
  }
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
