/**
 * The four local Git observations: what a document asks for, and what comes
 * back.
 *
 * `<Git.Files>`, `<Git.Changes>`, `<Git.Diff>` and `<Git.File>` are read-only
 * questions about one selected checkout, and every one of them binds JSON. The
 * types here are the whole contract: a normalized request, a bounded page, and
 * a `next` object holding the complete arguments of the follow-up read. There
 * is no handle, no live cursor object and no field a provider may add.
 *
 * ## A page is bounded, and the bound is the caller's
 *
 * A list answers 100 records and a text window 4096 code points unless the
 * caller asks for more. Nothing caps what it may ask for beyond what a number
 * can represent, because the default exists to bound what a document binds and
 * a journal retains rather than to hide what Git had to read.
 *
 * Windows count Unicode code points, as the REPL's own text windows do, so a
 * character is never split across two pages — and a surrogate pair is one
 * character here even though it is two JavaScript code units.
 *
 * ## Filters are literal
 *
 * A prefix is string-prefix matching and a path filter is a repository-relative
 * file or directory. Neither is a pathspec, a glob or anything a shell would
 * expand: `*`, `?` and `[` match those characters. That is what lets a document
 * name a path containing one without quoting, and what stops a filter from
 * selecting more than it says.
 */

import type { JsonObject, PropsSchema, ReturnsSchema } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type { GitInvocationPlace } from "./git-api.ts";
import { GitObservationError } from "./errors.ts";
import { wellFormedText } from "./parse.ts";

/** Which observation a request, a record and a cursor are about. */
export type GitObservationKind = "files" | "changes" | "diff" | "file";

/** The records a list answers with when the caller names no limit. */
export const DEFAULT_RECORD_LIMIT = 100;

/** The code points a text window answers with when the caller names no limit. */
export const DEFAULT_TEXT_LIMIT = 4096;

/** The three comparisons `<Git.Changes>` and `<Git.Diff>` accept. */
export type GitCompareMode = "unstaged" | "staged" | "commits";

export const GIT_COMPARE_MODES: readonly GitCompareMode[] = ["unstaged", "staged", "commits"];

/**
 * What a document asked to compare, before anything was resolved.
 *
 * The revisions are the strings the caller wrote. Resolving one is live work
 * against a repository, and what the document asked is not.
 */
export type GitComparisonRequest =
  | { readonly compare: "unstaged" }
  | { readonly compare: "staged" }
  | { readonly compare: "commits"; readonly base: string; readonly head: string };

/**
 * What one observation actually compared.
 *
 * `staged` carries the HEAD commit it read, or `null` on an unborn branch,
 * which is ordinary Git behavior rather than a refusal. `commits` carries both
 * full object ids, so a `next` page cannot be retargeted by a branch that moved.
 */
export type GitComparison =
  | { readonly compare: "unstaged" }
  | { readonly compare: "staged"; readonly base: string | null }
  | { readonly compare: "commits"; readonly base: string; readonly head: string };

/** Git's own letter for what happened to one path. */
export type GitChangeStatus = "A" | "M" | "D" | "R" | "T" | "U";

export const GIT_CHANGE_STATUSES: readonly GitChangeStatus[] = ["A", "M", "D", "R", "T", "U"];

/** One changed path, with the path it came from when it was renamed. */
export interface GitChange {
  readonly path: string;
  readonly status: GitChangeStatus;
  /** The path a rename came from, and `null` for every other status. */
  readonly previousPath: string | null;
}

/** What one `<Git.Files>` read asks for, normalized. */
export interface GitFilesRequest {
  readonly kind: "files";
  /** The literal path prefix, or `null` for the whole selected repository. */
  readonly prefix: string | null;
  readonly limit: number;
  /** The page this read continues, or `null` for a fresh observation. */
  readonly cursor: string | null;
}

/** What one `<Git.Changes>` read asks for, normalized. */
export interface GitChangesRequest {
  readonly kind: "changes";
  readonly comparison: GitComparisonRequest;
  /** The literal filters, or `null` when the read names none. */
  readonly paths: readonly string[] | null;
  readonly limit: number;
  readonly cursor: string | null;
}

/** What one `<Git.Diff>` read asks for, normalized. */
export interface GitDiffRequest {
  readonly kind: "diff";
  readonly comparison: GitComparisonRequest;
  readonly paths: readonly string[] | null;
  readonly offset: number;
  readonly limit: number;
  readonly cursor: string | null;
}

/** What one `<Git.File>` read asks for, normalized. */
export interface GitFileRequest {
  readonly kind: "file";
  /** The revision the caller wrote, which a fresh read resolves once. */
  readonly commit: string;
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
}

export type GitObservationRequest =
  | GitFilesRequest
  | GitChangesRequest
  | GitDiffRequest
  | GitFileRequest;

/** The complete arguments of one follow-up `<Git.Files>` read. */
export interface GitFilesNext {
  readonly prefix?: string;
  readonly limit: number;
  readonly cursor: string;
}

/** The complete arguments of one follow-up `<Git.Changes>` read. */
export interface GitChangesNext {
  readonly compare: GitCompareMode;
  readonly base?: string;
  readonly head?: string;
  readonly paths?: readonly string[];
  readonly limit: number;
  readonly cursor: string;
}

/** The complete arguments of one follow-up `<Git.Diff>` read. */
export interface GitDiffNext {
  readonly compare: GitCompareMode;
  readonly base?: string;
  readonly head?: string;
  readonly paths?: readonly string[];
  readonly offset: number;
  readonly limit: number;
  readonly cursor: string;
}

/**
 * The complete arguments of one follow-up `<Git.File>` read.
 *
 * No cursor, because the input is already immutable: the commit is resolved and
 * the blob it names cannot change.
 */
export interface GitFileNext {
  readonly commit: string;
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
}

export interface GitFilesResult {
  readonly paths: readonly string[];
  readonly next: GitFilesNext | null;
}

export interface GitChangesResult {
  readonly comparison: GitComparison;
  readonly changes: readonly GitChange[];
  readonly next: GitChangesNext | null;
}

export interface GitDiffResult {
  readonly comparison: GitComparison;
  readonly text: string;
  readonly offset: number;
  /** The whole observation's length in code points, not this window's. */
  readonly length: number;
  readonly next: GitDiffNext | null;
}

export interface GitFileResult {
  /** The full object id the requested revision resolved to. */
  readonly commit: string;
  /** The repository-relative path exactly as it was admitted. */
  readonly path: string;
  readonly text: string;
  readonly offset: number;
  readonly length: number;
  readonly next: GitFileNext | null;
}

export type GitObservationValue = GitFilesResult | GitChangesResult | GitDiffResult | GitFileResult;

export interface GitFilesInvocation extends GitInvocationPlace {
  readonly request: GitFilesRequest;
}

export interface GitChangesInvocation extends GitInvocationPlace {
  readonly request: GitChangesRequest;
}

export interface GitDiffInvocation extends GitInvocationPlace {
  readonly request: GitDiffRequest;
}

export interface GitFileInvocation extends GitInvocationPlace {
  readonly request: GitFileRequest;
}

export type GitObservationInvocation =
  | GitFilesInvocation
  | GitChangesInvocation
  | GitDiffInvocation
  | GitFileInvocation;

function closed(properties: JsonObject): JsonObject {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const LIMIT: JsonObject = { type: "integer", minimum: 1 };
const OFFSET: JsonObject = { type: "integer", minimum: 0 };
const PATH_FILTERS: JsonObject = { type: "array", items: { type: "string" } };
const CURSOR: JsonObject = { type: "string", minLength: 1 };

export const filesProps: PropsSchema = {
  type: "object",
  properties: {
    prefix: { type: "string" },
    limit: LIMIT,
    cursor: CURSOR,
  },
  required: [],
  additionalProperties: false,
};

export const changesProps: PropsSchema = {
  type: "object",
  properties: {
    compare: { enum: [...GIT_COMPARE_MODES] },
    base: { type: "string", minLength: 1 },
    head: { type: "string", minLength: 1 },
    paths: PATH_FILTERS,
    limit: LIMIT,
    cursor: CURSOR,
  },
  required: ["compare"],
  additionalProperties: false,
};

export const diffProps: PropsSchema = {
  type: "object",
  properties: {
    compare: { enum: [...GIT_COMPARE_MODES] },
    base: { type: "string", minLength: 1 },
    head: { type: "string", minLength: 1 },
    paths: PATH_FILTERS,
    offset: OFFSET,
    limit: LIMIT,
    cursor: CURSOR,
  },
  required: ["compare"],
  additionalProperties: false,
};

export const fileProps: PropsSchema = {
  type: "object",
  properties: {
    commit: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    offset: OFFSET,
    limit: LIMIT,
  },
  required: ["commit", "path"],
  additionalProperties: false,
};

const COMPARISON: JsonObject = {
  oneOf: [
    closed({ compare: { const: "unstaged" } }),
    closed({ compare: { const: "staged" }, base: { type: ["string", "null"] } }),
    closed({
      compare: { const: "commits" },
      base: { type: "string" },
      head: { type: "string" },
    }),
  ],
};

/**
 * The follow-up arguments a `next` object may hold, exactly.
 *
 * Open-ended on which optional filters are present and closed on which members
 * may exist at all, because a `next` repeats only the filters the read it
 * follows actually had: an omitted prefix stays omitted rather than arriving as
 * a null a later invocation would have to interpret.
 */
function nextSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return {
    type: ["object", "null"],
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

export const filesReturns: ReturnsSchema = closed({
  paths: { type: "array", items: { type: "string" } },
  next: nextSchema({ prefix: { type: "string" }, limit: LIMIT, cursor: CURSOR }, [
    "limit",
    "cursor",
  ]),
});

const CHANGE: JsonObject = closed({
  path: { type: "string" },
  status: { enum: [...GIT_CHANGE_STATUSES] },
  previousPath: { type: ["string", "null"] },
});

const COMPARISON_NEXT: JsonObject = {
  compare: { enum: [...GIT_COMPARE_MODES] },
  base: { type: "string" },
  head: { type: "string" },
  paths: PATH_FILTERS,
};

export const changesReturns: ReturnsSchema = closed({
  comparison: COMPARISON,
  changes: { type: "array", items: CHANGE },
  next: nextSchema({ ...COMPARISON_NEXT, limit: LIMIT, cursor: CURSOR }, [
    "compare",
    "limit",
    "cursor",
  ]),
});

export const diffReturns: ReturnsSchema = closed({
  comparison: COMPARISON,
  text: { type: "string" },
  offset: OFFSET,
  length: OFFSET,
  next: nextSchema({ ...COMPARISON_NEXT, offset: OFFSET, limit: LIMIT, cursor: CURSOR }, [
    "compare",
    "offset",
    "limit",
    "cursor",
  ]),
});

export const fileReturns: ReturnsSchema = closed({
  commit: { type: "string" },
  path: { type: "string" },
  text: { type: "string" },
  offset: OFFSET,
  length: OFFSET,
  next: nextSchema(
    { commit: { type: "string" }, path: { type: "string" }, offset: OFFSET, limit: LIMIT },
    ["commit", "path", "offset", "limit"],
  ),
});

function invalid(element: string, sentence: string): never {
  throw new GitObservationError(element, "invalid-invocation", `${element} ${sentence}`);
}

/**
 * The limit this value is, or the read's own refusal.
 *
 * A positive safe integer and nothing else. A fraction, a negative, a zero and
 * a number no integer arithmetic can represent are all refused here, before a
 * provider is reached, because none of them describes a page a read could
 * answer with.
 */
function admitLimit(element: string, value: Json | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid(
      element,
      "needs limit to be a whole number of at least 1 that integer arithmetic can represent.",
    );
  }
  return value;
}

function admitOffset(element: string, value: Json | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(
      element,
      "needs offset to be a whole number of at least 0 that integer arithmetic can represent.",
    );
  }
  return value;
}

/** Whether this string holds a NUL, which no argument list carries. */
function holdsNul(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0) {
      return true;
    }
  }
  return false;
}

/**
 * The repository-relative path this string names, or the read's own refusal.
 *
 * POSIX spelling, and ordinary segments only: nothing absolute, no NUL, no
 * empty interior segment, no `.` and no `..`. Spaces, tabs, newlines and
 * Unicode are ordinary filename characters and pass through untrimmed and
 * unnormalized — what a repository holds is what a read has to be able to name.
 *
 * A backslash is an ordinary character too, on a host whose filenames may hold
 * one. It is never read as a separator, so no spelling of it reaches outside the
 * repository-relative space.
 */
export function admitObservationPath(element: string, value: string, what: string): string {
  if (value === "") {
    return invalid(element, `needs ${what} to name a path, and the empty string names none.`);
  }
  if (!wellFormedText(value)) {
    return invalid(
      element,
      `needs ${what} to be well-formed text. It holds an unpaired surrogate, which this host ` +
        "cannot hand to Git as written.",
    );
  }
  if (holdsNul(value)) {
    return invalid(element, `needs ${what} to hold no NUL character.`);
  }
  if (value.startsWith("/")) {
    return invalid(
      element,
      `needs ${what} to be relative to the repository root, and an absolute path is not.`,
    );
  }
  const trailing = value.endsWith("/");
  for (const segment of (trailing ? value.slice(0, -1) : value).split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return invalid(
        element,
        `needs every segment of ${what} to be an ordinary name, so no empty segment, "." or ` +
          '".." is accepted.',
      );
    }
  }
  return value;
}

/**
 * The literal prefix this value is, or the read's own refusal.
 *
 * Wider than a path, because a prefix may stop inside a final segment:
 * `packages/co` is a prefix of `packages/core/mod.ts`, and that is the whole
 * point of a prefix. The empty string is the whole repository, which is also
 * what omitting it means.
 */
function admitPrefix(element: string, value: Json | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return invalid(element, "needs prefix to be a string.");
  }
  if (value === "") {
    return null;
  }
  if (!wellFormedText(value)) {
    return invalid(
      element,
      "needs prefix to be well-formed text. It holds an unpaired surrogate, which this host " +
        "cannot hand to Git as written.",
    );
  }
  if (holdsNul(value)) {
    return invalid(element, "needs prefix to hold no NUL character.");
  }
  if (value.startsWith("/")) {
    return invalid(
      element,
      "needs prefix to be relative to the repository root, and an absolute path is not.",
    );
  }
  for (const segment of value.split("/").slice(0, -1)) {
    if (segment === "" || segment === "." || segment === "..") {
      return invalid(
        element,
        'needs every complete segment of prefix to be an ordinary name, so no empty segment, "." ' +
          'or ".." is accepted.',
      );
    }
  }
  return value;
}

/**
 * The path filters this value holds, or `null` when the read names none.
 *
 * An empty array is not omission. Omitting the prop means every path; writing
 * `paths={[]}` names no path at all, and the read answers with nothing — which
 * is a thing a document can say and a thing this must not quietly widen.
 */
function admitPathFilters(element: string, value: Json | undefined): readonly string[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return invalid(element, "needs paths to be an array of repository-relative paths.");
  }
  const filters: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return invalid(element, "needs every entry of paths to be a string.");
    }
    filters.push(admitObservationPath(element, entry, "every entry of paths"));
  }
  return Object.freeze(filters);
}

function admitCursor(element: string, value: Json | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    return invalid(element, "needs cursor to be the opaque string a previous next supplied.");
  }
  return value;
}

/**
 * The comparison this invocation names, or the read's own refusal.
 *
 * `base` and `head` belong to `commits` and to nothing else. Requiring both
 * there and forbidding both elsewhere is what stops a read from naming a
 * revision the comparison it asked for would silently ignore.
 */
function admitComparison(
  element: string,
  props: Record<string, Json | undefined>,
): GitComparisonRequest {
  const compare = props.compare;
  const mode = GIT_COMPARE_MODES.find((candidate) => candidate === compare);
  if (mode === undefined) {
    return invalid(element, 'needs compare to be "unstaged", "staged" or "commits".');
  }
  const base = props.base;
  const head = props.head;
  if (mode !== "commits") {
    if (base !== undefined || head !== undefined) {
      return invalid(
        element,
        `compares ${JSON.stringify(mode)}, which names no revisions, so base and head belong ` +
          'only to compare="commits".',
      );
    }
    return Object.freeze({ compare: mode });
  }
  if (typeof base !== "string" || base === "" || typeof head !== "string" || head === "") {
    return invalid(element, 'compares "commits", so it needs both base and head to name a commit.');
  }
  if (!wellFormedText(base) || !wellFormedText(head) || holdsNul(base) || holdsNul(head)) {
    return invalid(
      element,
      "needs base and head to be well-formed text with no NUL character, which is what this " +
        "host can hand to Git as written.",
    );
  }
  return Object.freeze({ compare: "commits" as const, base, head });
}

/** The `<Git.Files>` request these props ask for, copied and frozen. */
export function admitFilesRequest(
  element: string,
  props: Record<string, Json | undefined>,
): GitFilesRequest {
  return Object.freeze({
    kind: "files" as const,
    prefix: admitPrefix(element, props.prefix),
    limit: admitLimit(element, props.limit, DEFAULT_RECORD_LIMIT),
    cursor: admitCursor(element, props.cursor),
  });
}

/** The `<Git.Changes>` request these props ask for, copied and frozen. */
export function admitChangesRequest(
  element: string,
  props: Record<string, Json | undefined>,
): GitChangesRequest {
  return Object.freeze({
    kind: "changes" as const,
    comparison: admitComparison(element, props),
    paths: admitPathFilters(element, props.paths),
    limit: admitLimit(element, props.limit, DEFAULT_RECORD_LIMIT),
    cursor: admitCursor(element, props.cursor),
  });
}

/** The `<Git.Diff>` request these props ask for, copied and frozen. */
export function admitDiffRequest(
  element: string,
  props: Record<string, Json | undefined>,
): GitDiffRequest {
  return Object.freeze({
    kind: "diff" as const,
    comparison: admitComparison(element, props),
    paths: admitPathFilters(element, props.paths),
    offset: admitOffset(element, props.offset),
    limit: admitLimit(element, props.limit, DEFAULT_TEXT_LIMIT),
    cursor: admitCursor(element, props.cursor),
  });
}

/** The `<Git.File>` request these props ask for, copied and frozen. */
export function admitFileRequest(
  element: string,
  props: Record<string, Json | undefined>,
): GitFileRequest {
  const commit = props.commit;
  if (typeof commit !== "string" || commit === "") {
    return invalid(element, "needs commit to name the revision to read the file from.");
  }
  if (!wellFormedText(commit) || holdsNul(commit)) {
    return invalid(
      element,
      "needs commit to be well-formed text with no NUL character, which is what this host can " +
        "hand to Git as written.",
    );
  }
  const path = props.path;
  if (typeof path !== "string") {
    return invalid(element, "needs path to name the file to read.");
  }
  return Object.freeze({
    kind: "file" as const,
    commit,
    path: admitObservationPath(element, path, "path"),
    offset: admitOffset(element, props.offset),
    limit: admitLimit(element, props.limit, DEFAULT_TEXT_LIMIT),
  });
}

/**
 * Whether this filter selects this path.
 *
 * Literal, and by whole segments: a selector matches the path it spells, and
 * every path beneath it when the boundary is a `/`. A trailing slash selects
 * descendants and not the directory entry itself, which is the one shape where
 * the two differ.
 */
export function selectsPath(filter: string, path: string): boolean {
  if (filter.endsWith("/")) {
    return path.startsWith(filter);
  }
  return path === filter || path.startsWith(`${filter}/`);
}

/** Whether these filters select this path, with `null` selecting every one. */
export function selectedByFilters(filters: readonly string[] | null, path: string): boolean {
  if (filters === null) {
    return true;
  }
  return filters.some((filter) => selectsPath(filter, path));
}

/** Whether a change record is selected, matching both sides of a rename. */
export function selectedChange(filters: readonly string[] | null, change: GitChange): boolean {
  if (selectedByFilters(filters, change.path)) {
    return true;
  }
  return change.previousPath !== null && selectedByFilters(filters, change.previousPath);
}

/** Change records in code-point order by current path, then previous path. */
export function sortedChanges(changes: readonly GitChange[]): readonly GitChange[] {
  return Object.freeze(
    [...changes].sort((left, right) => {
      if (left.path !== right.path) {
        return left.path < right.path ? -1 : 1;
      }
      const leftPrevious = left.previousPath ?? "";
      const rightPrevious = right.previousPath ?? "";
      if (leftPrevious === rightPrevious) {
        return 0;
      }
      return leftPrevious < rightPrevious ? -1 : 1;
    }),
  );
}

/**
 * The same admission, applied to a request that arrived through the Api.
 *
 * The four above read what a document wrote; these four read what a caller
 * handed the contextual operation. Both routes end at one boundary, because the
 * Api is public: a caller reaching it directly is subject to the same limits,
 * and the copy is what stops the object it still holds from being the one a
 * provider names its record by.
 */
export function admitFilesInvocation(element: string, request: GitFilesRequest): GitFilesRequest {
  return admitFilesRequest(element, {
    ...(request.prefix === null ? {} : { prefix: request.prefix }),
    limit: request.limit,
    ...(request.cursor === null ? {} : { cursor: request.cursor }),
  });
}

export function admitChangesInvocation(
  element: string,
  request: GitChangesRequest,
): GitChangesRequest {
  return admitChangesRequest(element, {
    ...comparisonProps(request.comparison),
    ...(request.paths === null ? {} : { paths: [...request.paths] }),
    limit: request.limit,
    ...(request.cursor === null ? {} : { cursor: request.cursor }),
  });
}

export function admitDiffInvocation(element: string, request: GitDiffRequest): GitDiffRequest {
  return admitDiffRequest(element, {
    ...comparisonProps(request.comparison),
    ...(request.paths === null ? {} : { paths: [...request.paths] }),
    offset: request.offset,
    limit: request.limit,
    ...(request.cursor === null ? {} : { cursor: request.cursor }),
  });
}

export function admitFileInvocation(element: string, request: GitFileRequest): GitFileRequest {
  return admitFileRequest(element, {
    commit: request.commit,
    path: request.path,
    offset: request.offset,
    limit: request.limit,
  });
}

function comparisonProps(comparison: GitComparisonRequest): Record<string, Json> {
  if (comparison.compare === "commits") {
    return { compare: "commits", base: comparison.base, head: comparison.head };
  }
  return { compare: comparison.compare };
}
