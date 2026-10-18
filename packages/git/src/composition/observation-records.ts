/**
 * What a local Git observation looks like as JSON, and how a continuation is
 * carried.
 *
 * Two jobs, and they share one contract. A result is written here and parsed
 * here, so the page a document binds and the page a journal restores are the
 * same object; and the opaque `cursor` a `next` carries is built here and
 * verified here, so what a follow-up read is held to is what the first read
 * described.
 *
 * ## A cursor is data, not permission
 *
 * It names the read kind, the normalized query, the authenticated checkout, the
 * resolved comparison, a digest of the complete filtered observation, and the
 * position the next page starts at. It carries no content, no credential, no
 * callable, no live selection identifier and no grant. A provider authenticates
 * and routes independently of it, and then verifies that the cursor describes
 * the checkout that route reached — the cursor's own root is never a
 * destination.
 *
 * The digest is what makes continuation honest. A follow-up recomputes the
 * whole filtered observation and compares; an answer that has changed cannot be
 * paged over, so the read refuses and says to start again. A change elsewhere in
 * the repository that does not alter this observation changes no digest and
 * needs no restart. Changing `limit` is safe for the same reason: a limit is how
 * much of an answer to return, not which answer it is.
 *
 * ## Windows are code points
 *
 * `offset`, `limit`, `length` and a next offset all count Unicode code points,
 * which is what the REPL's own text windows count. A surrogate pair is one code
 * point, so no page ever ends half way through a character.
 */

import { until } from "effection";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, text } from "./parse.ts";
import {
  parseRepositoryIdentity,
  repositoryIdentityJson,
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "./selection.ts";
import {
  GIT_CHANGE_STATUSES,
  GIT_COMPARE_MODES,
  type GitChange,
  type GitChangeStatus,
  type GitChangesNext,
  type GitChangesRequest,
  type GitChangesResult,
  type GitCompareMode,
  type GitComparison,
  type GitDiffNext,
  type GitDiffRequest,
  type GitDiffResult,
  type GitFileNext,
  type GitFileRequest,
  type GitFileResult,
  type GitFilesNext,
  type GitFilesRequest,
  type GitFilesResult,
  type GitObservationKind,
  type GitObservationRequest,
  type GitObservationValue,
} from "./observation-api.ts";

/** The cursor payload shape this host writes and the only one it reads. */
export const GIT_OBSERVATION_CURSOR_VERSION = 1;

/** The SHA-256 digest of one canonical value, lowercase. */
export function* observationDigest(value: Json): Operation<string> {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  const computed = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return [...new Uint8Array(computed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** How many code points this string holds. */
export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) {
        index += 1;
      }
    }
    count += 1;
  }
  return count;
}

/**
 * The code-unit index the given code point starts at.
 *
 * Walked rather than materialized: a 64-kilocharacter blob is an ordinary input
 * here, and an array of its code points would be an allocation per read for an
 * answer two indices already give.
 */
function unitIndexOf(value: string, codePoint: number): number {
  let seen = 0;
  let index = 0;
  while (index < value.length && seen < codePoint) {
    const unit = value.charCodeAt(index);
    index += 1;
    if (unit >= 0xd800 && unit <= 0xdbff && index < value.length) {
      const following = value.charCodeAt(index);
      if (following >= 0xdc00 && following <= 0xdfff) {
        index += 1;
      }
    }
    seen += 1;
  }
  return index;
}

/** One text window: the characters it holds, the whole length, and what follows. */
export interface GitTextWindow {
  readonly text: string;
  /** The whole observation's length in code points. */
  readonly length: number;
  /** The absolute code-point offset the next window starts at, or `null`. */
  readonly nextOffset: number | null;
}

/**
 * The window this offset and limit select.
 *
 * An offset at or past the end is an empty window at the offset that was asked
 * for, with the whole length and no next read — reading past the end of a file
 * is an answer rather than a refusal. Nothing is trimmed and no newline is
 * dropped: the window is the bytes the observation held, decoded.
 */
export function gitTextWindow(value: string, offset: number, limit: number): GitTextWindow {
  const length = codePointLength(value);
  if (offset >= length) {
    return Object.freeze({ text: "", length, nextOffset: null });
  }
  // Subtraction rather than `offset + limit`, which a safe-integer limit can
  // carry past what integer arithmetic represents.
  const taken = Math.min(limit, length - offset);
  const start = unitIndexOf(value, offset);
  const end = unitIndexOf(value, offset + taken);
  const reached = offset + taken;
  return Object.freeze({
    text: value.slice(start, end),
    length,
    nextOffset: reached < length ? reached : null,
  });
}

/** One page of records: the entries it holds, and the index that follows it. */
export interface GitRecordWindow<T> {
  readonly page: readonly T[];
  readonly nextIndex: number | null;
}

export function gitRecordWindow<T>(
  records: readonly T[],
  offset: number,
  limit: number,
): GitRecordWindow<T> {
  if (offset >= records.length) {
    return Object.freeze({ page: Object.freeze([]), nextIndex: null });
  }
  const taken = Math.min(limit, records.length - offset);
  const reached = offset + taken;
  return Object.freeze({
    page: Object.freeze(records.slice(offset, reached)),
    nextIndex: reached < records.length ? reached : null,
  });
}

export function gitComparisonJson(comparison: GitComparison): Json {
  if (comparison.compare === "unstaged") {
    return { compare: "unstaged" };
  }
  if (comparison.compare === "staged") {
    return { compare: "staged", base: comparison.base };
  }
  return { compare: "commits", base: comparison.base, head: comparison.head };
}

/** The comparison this value describes, or `undefined`. */
export function parseGitComparison(value: unknown): GitComparison | undefined {
  const unstaged = members(value, ["compare"]);
  if (unstaged !== undefined) {
    return unstaged["compare"] === "unstaged" ? Object.freeze({ compare: "unstaged" }) : undefined;
  }
  const staged = members(value, ["compare", "base"]);
  if (staged !== undefined) {
    if (staged["compare"] !== "staged") {
      return undefined;
    }
    const base = staged["base"];
    if (base === null) {
      return Object.freeze({ compare: "staged" as const, base: null });
    }
    const resolved = text(base);
    return resolved === undefined
      ? undefined
      : Object.freeze({ compare: "staged" as const, base: resolved });
  }
  const commits = members(value, ["compare", "base", "head"]);
  if (commits === undefined || commits["compare"] !== "commits") {
    return undefined;
  }
  const base = text(commits["base"]);
  const head = text(commits["head"]);
  if (base === undefined || head === undefined) {
    return undefined;
  }
  return Object.freeze({ compare: "commits" as const, base, head });
}

export function gitChangeJson(change: GitChange): Json {
  return { path: change.path, status: change.status, previousPath: change.previousPath };
}

/** The status this value names, or `undefined`. */
export function parseGitChangeStatus(value: unknown): GitChangeStatus | undefined {
  return GIT_CHANGE_STATUSES.find((status) => status === value);
}

function parseGitChange(value: unknown): GitChange | undefined {
  const record = members(value, ["path", "status", "previousPath"]);
  if (record === undefined) {
    return undefined;
  }
  const path = text(record["path"]);
  const status = parseGitChangeStatus(record["status"]);
  const previous = record["previousPath"];
  if (path === undefined || status === undefined) {
    return undefined;
  }
  // A rename is the one status with a previous path, and the only one. A record
  // pairing them any other way describes a change this host does not produce.
  if (status !== "R") {
    return previous === null ? Object.freeze({ path, status, previousPath: null }) : undefined;
  }
  const previousPath = text(previous);
  return previousPath === undefined ? undefined : Object.freeze({ path, status, previousPath });
}

function paths(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: string[] = [];
  for (const entry of value) {
    const path = text(entry);
    if (path === undefined) {
      return undefined;
    }
    entries.push(path);
  }
  return Object.freeze(entries);
}

function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function positive(value: unknown): number | undefined {
  const parsed = count(value);
  return parsed === undefined || parsed < 1 ? undefined : parsed;
}

/**
 * The follow-up props for a list or text read, with omitted filters omitted.
 *
 * A `next` is the complete arguments of one more read, so what is present in it
 * is exactly what the read it follows had: a prefix nobody wrote stays absent
 * rather than arriving as a null the next invocation would have to interpret.
 */
function comparisonNextJson(comparison: GitComparison): Record<string, Json> {
  if (comparison.compare === "commits") {
    return { compare: "commits", base: comparison.base, head: comparison.head };
  }
  return { compare: comparison.compare };
}

export function gitFilesNextJson(next: GitFilesNext): Json {
  return {
    ...(next.prefix === undefined ? {} : { prefix: next.prefix }),
    limit: next.limit,
    cursor: next.cursor,
  };
}

export function gitChangesNextJson(next: GitChangesNext): Json {
  return {
    compare: next.compare,
    ...(next.base === undefined ? {} : { base: next.base }),
    ...(next.head === undefined ? {} : { head: next.head }),
    ...(next.paths === undefined ? {} : { paths: [...next.paths] }),
    limit: next.limit,
    cursor: next.cursor,
  };
}

export function gitDiffNextJson(next: GitDiffNext): Json {
  return {
    compare: next.compare,
    ...(next.base === undefined ? {} : { base: next.base }),
    ...(next.head === undefined ? {} : { head: next.head }),
    ...(next.paths === undefined ? {} : { paths: [...next.paths] }),
    offset: next.offset,
    limit: next.limit,
    cursor: next.cursor,
  };
}

export function gitFileNextJson(next: GitFileNext): Json {
  return { commit: next.commit, path: next.path, offset: next.offset, limit: next.limit };
}

export function gitFilesResultJson(result: GitFilesResult): Json {
  return {
    paths: [...result.paths],
    next: result.next === null ? null : gitFilesNextJson(result.next),
  };
}

export function gitChangesResultJson(result: GitChangesResult): Json {
  return {
    comparison: gitComparisonJson(result.comparison),
    changes: result.changes.map(gitChangeJson),
    next: result.next === null ? null : gitChangesNextJson(result.next),
  };
}

export function gitDiffResultJson(result: GitDiffResult): Json {
  return {
    comparison: gitComparisonJson(result.comparison),
    text: result.text,
    offset: result.offset,
    length: result.length,
    next: result.next === null ? null : gitDiffNextJson(result.next),
  };
}

export function gitFileResultJson(result: GitFileResult): Json {
  return {
    commit: result.commit,
    path: result.path,
    text: result.text,
    offset: result.offset,
    length: result.length,
    next: result.next === null ? null : gitFileNextJson(result.next),
  };
}

export function gitObservationValueJson(
  kind: GitObservationKind,
  value: GitObservationValue,
): Json {
  if (kind === "files" && "paths" in value) {
    return gitFilesResultJson(value);
  }
  if (kind === "changes" && "changes" in value) {
    return gitChangesResultJson(value);
  }
  if (kind === "diff" && "text" in value && !("commit" in value)) {
    return gitDiffResultJson(value);
  }
  if (kind === "file" && "commit" in value) {
    return gitFileResultJson(value);
  }
  throw new TypeError(`a retained ${kind} observation carries no ${kind} result`);
}

function parseFilesNext(value: unknown): GitFilesNext | null | undefined {
  if (value === null) {
    return null;
  }
  const withPrefix = members(value, ["prefix", "limit", "cursor"]);
  const bare = withPrefix === undefined ? members(value, ["limit", "cursor"]) : undefined;
  const read = withPrefix ?? bare;
  if (read === undefined) {
    return undefined;
  }
  const limit = positive(read["limit"]);
  const cursor = text(read["cursor"]);
  if (limit === undefined || cursor === undefined) {
    return undefined;
  }
  if (withPrefix === undefined) {
    return Object.freeze({ limit, cursor });
  }
  const prefix = text(read["prefix"]);
  return prefix === undefined ? undefined : Object.freeze({ prefix, limit, cursor });
}

/**
 * The comparison and filter members a list or text `next` repeats.
 *
 * Read by presence, because presence is the contract: a `commits` follow-up
 * names both revisions, every other mode names none, and a read with no path
 * filter repeats none.
 */
function parseComparisonNext(
  read: Record<string, unknown>,
):
  | { compare: GitCompareMode; base?: string; head?: string; paths?: readonly string[] }
  | undefined {
  const compare = GIT_COMPARE_MODES.find((mode) => mode === read["compare"]);
  if (compare === undefined) {
    return undefined;
  }
  const hasBase = Object.hasOwn(read, "base");
  const hasHead = Object.hasOwn(read, "head");
  if (compare === "commits" ? !hasBase || !hasHead : hasBase || hasHead) {
    return undefined;
  }
  const filters = Object.hasOwn(read, "paths") ? paths(read["paths"]) : undefined;
  if (Object.hasOwn(read, "paths") && filters === undefined) {
    return undefined;
  }
  if (compare !== "commits") {
    return filters === undefined ? { compare } : { compare, paths: filters };
  }
  const base = text(read["base"]);
  const head = text(read["head"]);
  if (base === undefined || head === undefined) {
    return undefined;
  }
  return filters === undefined ? { compare, base, head } : { compare, base, head, paths: filters };
}

/** Every member a comparison `next` may hold, as the parser enumerates them. */
function comparisonNextMembers(
  value: unknown,
  own: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const permitted = new Set(["compare", "base", "head", "paths", ...own]);
  for (const key of Object.keys(record)) {
    if (!permitted.has(key)) {
      return undefined;
    }
  }
  for (const key of own) {
    if (!Object.hasOwn(record, key)) {
      return undefined;
    }
  }
  return Object.hasOwn(record, "compare") ? record : undefined;
}

function parseChangesNext(value: unknown): GitChangesNext | null | undefined {
  if (value === null) {
    return null;
  }
  const read = comparisonNextMembers(value, ["limit", "cursor"]);
  if (read === undefined) {
    return undefined;
  }
  const shared = parseComparisonNext(read);
  const limit = positive(read["limit"]);
  const cursor = text(read["cursor"]);
  if (shared === undefined || limit === undefined || cursor === undefined) {
    return undefined;
  }
  return Object.freeze({ ...shared, limit, cursor });
}

function parseDiffNext(value: unknown): GitDiffNext | null | undefined {
  if (value === null) {
    return null;
  }
  const read = comparisonNextMembers(value, ["offset", "limit", "cursor"]);
  if (read === undefined) {
    return undefined;
  }
  const shared = parseComparisonNext(read);
  const offset = count(read["offset"]);
  const limit = positive(read["limit"]);
  const cursor = text(read["cursor"]);
  if (shared === undefined || offset === undefined || limit === undefined || cursor === undefined) {
    return undefined;
  }
  return Object.freeze({ ...shared, offset, limit, cursor });
}

function parseFileNext(value: unknown): GitFileNext | null | undefined {
  if (value === null) {
    return null;
  }
  const read = members(value, ["commit", "path", "offset", "limit"]);
  if (read === undefined) {
    return undefined;
  }
  const commit = text(read["commit"]);
  const path = text(read["path"]);
  const offset = count(read["offset"]);
  const limit = positive(read["limit"]);
  if (commit === undefined || path === undefined || offset === undefined || limit === undefined) {
    return undefined;
  }
  return Object.freeze({ commit, path, offset, limit });
}

/**
 * The result this saved value describes for this request, or `undefined`.
 *
 * Total about members and exact about the request: a page describing another
 * query is not this read's answer, so a replay that found one refuses rather
 * than binding it. The comparison a result carries is the resolved one, which
 * the request's authored mode has to agree with.
 */
export function parseGitObservationValue(
  value: unknown,
  request: GitObservationRequest,
): GitObservationValue | undefined {
  if (request.kind === "files") {
    return parseFilesResult(value, request);
  }
  if (request.kind === "changes") {
    return parseChangesResult(value, request);
  }
  if (request.kind === "diff") {
    return parseDiffResult(value, request);
  }
  return parseFileResult(value, request);
}

function parseFilesResult(value: unknown, request: GitFilesRequest): GitFilesResult | undefined {
  const read = members(value, ["paths", "next"]);
  if (read === undefined) {
    return undefined;
  }
  const listed = paths(read["paths"]);
  const next = parseFilesNext(read["next"]);
  if (listed === undefined || next === undefined) {
    return undefined;
  }
  if (listed.length > request.limit) {
    return undefined;
  }
  if (next !== null && (next.prefix ?? null) !== request.prefix) {
    return undefined;
  }
  return Object.freeze({ paths: listed, next });
}

function sameFilters(
  left: readonly string[] | undefined,
  right: readonly string[] | null,
): boolean {
  if (left === undefined) {
    return right === null;
  }
  if (right === null) {
    return false;
  }
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Whether a next page's comparison repeats the mode the request asked for. */
function sameMode(
  next: { compare: GitCompareMode },
  request: { comparison: { compare: GitCompareMode } },
): boolean {
  return next.compare === request.comparison.compare;
}

function parseChangesResult(
  value: unknown,
  request: GitChangesRequest,
): GitChangesResult | undefined {
  const read = members(value, ["comparison", "changes", "next"]);
  if (read === undefined) {
    return undefined;
  }
  const comparison = parseGitComparison(read["comparison"]);
  const next = parseChangesNext(read["next"]);
  if (comparison === undefined || next === undefined) {
    return undefined;
  }
  if (comparison.compare !== request.comparison.compare) {
    return undefined;
  }
  if (!Array.isArray(read["changes"])) {
    return undefined;
  }
  const changes: GitChange[] = [];
  for (const entry of read["changes"]) {
    const change = parseGitChange(entry);
    if (change === undefined) {
      return undefined;
    }
    changes.push(change);
  }
  if (changes.length > request.limit) {
    return undefined;
  }
  if (next !== null && (!sameMode(next, request) || !sameFilters(next.paths, request.paths))) {
    return undefined;
  }
  return Object.freeze({ comparison, changes: Object.freeze(changes), next });
}

function parseDiffResult(value: unknown, request: GitDiffRequest): GitDiffResult | undefined {
  const read = members(value, ["comparison", "text", "offset", "length", "next"]);
  if (read === undefined) {
    return undefined;
  }
  const comparison = parseGitComparison(read["comparison"]);
  const patch = read["text"];
  const offset = count(read["offset"]);
  const length = count(read["length"]);
  const next = parseDiffNext(read["next"]);
  if (
    comparison === undefined ||
    typeof patch !== "string" ||
    offset === undefined ||
    length === undefined ||
    next === undefined
  ) {
    return undefined;
  }
  if (comparison.compare !== request.comparison.compare || offset !== request.offset) {
    return undefined;
  }
  if (codePointLength(patch) > request.limit) {
    return undefined;
  }
  if (next !== null && (!sameMode(next, request) || !sameFilters(next.paths, request.paths))) {
    return undefined;
  }
  return Object.freeze({ comparison, text: patch, offset, length, next });
}

function parseFileResult(value: unknown, request: GitFileRequest): GitFileResult | undefined {
  const read = members(value, ["commit", "path", "text", "offset", "length", "next"]);
  if (read === undefined) {
    return undefined;
  }
  const commit = text(read["commit"]);
  const path = text(read["path"]);
  const content = read["text"];
  const offset = count(read["offset"]);
  const length = count(read["length"]);
  const next = parseFileNext(read["next"]);
  if (
    commit === undefined ||
    path === undefined ||
    typeof content !== "string" ||
    offset === undefined ||
    length === undefined ||
    next === undefined
  ) {
    return undefined;
  }
  if (path !== request.path || offset !== request.offset) {
    return undefined;
  }
  if (codePointLength(content) > request.limit) {
    return undefined;
  }
  // The continuation stays on the commit this read resolved. A next page naming
  // another commit would read a different file under the same question.
  if (next !== null && (next.commit !== commit || next.path !== path)) {
    return undefined;
  }
  return Object.freeze({ commit, path, text: content, offset, length, next });
}

/**
 * The checkout one cursor was built against, as the provider authenticated it.
 *
 * The whole Repository identity, the checkout root and the common Git
 * directory. A follow-up read authenticates and routes on its own terms and
 * then checks that this is the checkout it reached; a cursor naming another one
 * describes a different observation and is not a page of this one.
 */
export interface GitObservationCheckout {
  readonly repository: RepositoryIdentity;
  readonly root: string;
  readonly commonDirectory: string;
}

/** Which reads page, and therefore which reads carry a cursor. */
export type GitPagedKind = "files" | "changes" | "diff";

/** One continuation, as the opaque string a `next` carries decodes to. */
export interface GitObservationCursor {
  readonly version: typeof GIT_OBSERVATION_CURSOR_VERSION;
  readonly kind: GitPagedKind;
  /** The normalized query, which a follow-up has to ask again exactly. */
  readonly query: Json;
  readonly checkout: GitObservationCheckout;
  /** The comparison the first page resolved, or `null` for a file listing. */
  readonly comparison: GitComparison | null;
  /** SHA-256 of the complete filtered observation this cursor pages over. */
  readonly observation: string;
  /** The record index or absolute code-point offset the next page starts at. */
  readonly position: number;
}

export function gitObservationCheckoutJson(checkout: GitObservationCheckout): Json {
  return {
    repository: repositoryIdentityJson(checkout.repository),
    root: checkout.root,
    commonDirectory: checkout.commonDirectory,
  };
}

function parseObservationCheckout(value: unknown): GitObservationCheckout | undefined {
  const read = members(value, ["repository", "root", "commonDirectory"]);
  if (read === undefined) {
    return undefined;
  }
  const repository = parseRepositoryIdentity(read["repository"]);
  const root = text(read["root"]);
  const commonDirectory = text(read["commonDirectory"]);
  if (repository === undefined || root === undefined || commonDirectory === undefined) {
    return undefined;
  }
  return Object.freeze({ repository, root, commonDirectory });
}

/** Whether two cursors describe the same authenticated checkout. */
export function sameObservationCheckout(
  left: GitObservationCheckout,
  right: GitObservationCheckout,
): boolean {
  return (
    left.root === right.root &&
    left.commonDirectory === right.commonDirectory &&
    sameRepositoryIdentity(left.repository, right.repository)
  );
}

/**
 * The normalized query one observation pages over.
 *
 * It holds what decides *which* answer this is and nothing about how much of it
 * to return, which is why a caller may raise `limit` between pages without
 * restarting. A commit comparison contributes the resolved full object ids, so
 * the query a follow-up computes from the `next` it was handed is the query the
 * first page recorded — and a branch that moved cannot retarget a later page.
 */
export function gitObservationQuery(
  request: GitObservationRequest,
  comparison: GitComparison | null,
): Json {
  if (request.kind === "files") {
    return { kind: "files", prefix: request.prefix };
  }
  if (request.kind === "file") {
    return { kind: "file", commit: request.commit, path: request.path };
  }
  const resolved: Json =
    comparison !== null && comparison.compare === "commits"
      ? { compare: "commits", base: comparison.base, head: comparison.head }
      : { compare: request.comparison.compare };
  return {
    kind: request.kind,
    comparison: resolved,
    paths: request.paths === null ? null : [...request.paths],
  };
}

/** The comparison members a follow-up `next` repeats for this comparison. */
export function gitComparisonNext(comparison: GitComparison): {
  readonly compare: GitCompareMode;
  readonly base?: string;
  readonly head?: string;
} {
  if (comparison.compare === "commits") {
    return Object.freeze({
      compare: "commits" as const,
      base: comparison.base,
      head: comparison.head,
    });
  }
  return Object.freeze({ compare: comparison.compare });
}

const BASE64_URL_UNSAFE: ReadonlyMap<string, string> = new Map([
  ["+", "-"],
  ["/", "_"],
]);

/**
 * The cursor, as the opaque string a result carries.
 *
 * Base64url of the canonical JSON payload. The encoding is private: a caller
 * passes the string back and nothing else is promised about it, which is what
 * keeps the payload's shape this module's to change.
 */
export function encodeGitObservationCursor(cursor: GitObservationCursor): string {
  const payload = canonicalJson({
    version: cursor.version,
    kind: cursor.kind,
    query: cursor.query,
    checkout: gitObservationCheckoutJson(cursor.checkout),
    comparison: cursor.comparison === null ? null : gitComparisonJson(cursor.comparison),
    observation: cursor.observation,
    position: cursor.position,
  });
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/[+/]/g, (character) => BASE64_URL_UNSAFE.get(character) ?? character)
    .replace(/=+$/, "");
}

/** The continuation this opaque string describes, or `undefined`. */
export function parseGitObservationCursor(encoded: string): GitObservationCursor | undefined {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  let payload: string;
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    payload = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const read = members(decoded, [
    "version",
    "kind",
    "query",
    "checkout",
    "comparison",
    "observation",
    "position",
  ]);
  if (read === undefined || read["version"] !== GIT_OBSERVATION_CURSOR_VERSION) {
    return undefined;
  }
  const kind = PAGED_KINDS.find((candidate) => candidate === read["kind"]);
  const checkout = parseObservationCheckout(read["checkout"]);
  const observation = text(read["observation"]);
  const position = count(read["position"]);
  if (
    kind === undefined ||
    checkout === undefined ||
    observation === undefined ||
    !/^[0-9a-f]{64}$/.test(observation) ||
    position === undefined
  ) {
    return undefined;
  }
  const comparison = read["comparison"] === null ? null : parseGitComparison(read["comparison"]);
  if (comparison === undefined) {
    return undefined;
  }
  const query = jsonValue(read["query"]);
  if (query === undefined) {
    return undefined;
  }
  return Object.freeze({
    version: GIT_OBSERVATION_CURSOR_VERSION,
    kind,
    query,
    checkout,
    comparison,
    observation,
    position,
  });
}

const PAGED_KINDS: readonly GitPagedKind[] = ["files", "changes", "diff"];

/**
 * This value, once it is ordinary JSON.
 *
 * The cursor's query is compared as canonical JSON rather than interpreted, so
 * what it has to be is a value this host can canonicalize again — not a shape
 * this module decided in advance.
 */
function jsonValue(value: unknown): Json | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const entries: Json[] = [];
    for (const entry of value) {
      const parsed = jsonValue(entry);
      if (parsed === undefined) {
        return undefined;
      }
      entries.push(parsed);
    }
    return entries;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const object: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = jsonValue(entry);
    if (parsed === undefined) {
      return undefined;
    }
    object[key] = parsed;
  }
  return object;
}
