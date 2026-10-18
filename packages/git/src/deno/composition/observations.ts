/**
 * The native side of the four local Git observations: fixed reads, in a view
 * this observation owns, that change nothing.
 *
 * Never the selected checkout's own Git administration. A checkout carries a
 * `.git/config` a person — or a document — may have written, and several
 * ordinary settings in one name a *program*: `diff.external`, a textconv
 * filter, a `clean`/`process` filter, `core.fsmonitor`, a credential helper.
 * Running a read there would let repository configuration decide what else
 * runs while somebody looks at a diff.
 *
 * So each observation builds the same contained view the push transport uses: a
 * bare control repository this observation created, configured by nothing but
 * its own creation, reading the checkout's objects through a read-only
 * alternate whose whole graph has been proven to stay inside the object
 * database the provider authenticated. The checkout's configuration is not
 * consulted, no transport is attached, and lazy fetching is disabled even while
 * a revision is being resolved — a missing promisor object refuses rather than
 * reaching a remote.
 *
 * ## The index is copied, never touched
 *
 * Two of the three comparisons and the file listing are about the index, and
 * the index is a file the person at the keyboard is using. It is discovered
 * through Git's own path query rather than assumed to be `<commonDir>/index`,
 * because a linked worktree has one of its own; its bytes are copied into this
 * observation's scratch directory; and every index-dependent read runs against
 * that copy through `GIT_INDEX_FILE`. A split index is read the same way, with
 * the shared-index bytes copied beside the private copy — which is where Git
 * looks for them. Nothing refreshes, expands or repairs the source.
 *
 * ## Revisions resolve where the refs are
 *
 * The control repository holds no references, so an authored revision is
 * resolved once in the authenticated checkout — with `--verify`,
 * `--end-of-options` and `^{commit}`, so a revision that looks like a flag is
 * not read as one and a tag pointing at anything else is refused — and only
 * full object ids are used in the isolated view afterwards.
 */

import { scoped, until } from "effection";
import type { Operation } from "effection";
import { copyFile, lstat, readdir } from "@effectionx/fs";
import { utimes } from "node:fs/promises";
import {
  GitObservationError,
  GitOperationInfrastructureError,
} from "../../composition/errors.ts";
import type { GitObjectFormat } from "../../composition/records.ts";
import type { RepositoryIdentity } from "../../composition/selection.ts";
import {
  DEFAULT_RECORD_LIMIT,
  selectedChange,
  selectedByFilters,
  sortedChanges,
  type GitChange,
  type GitChangeStatus,
  type GitChangesRequest,
  type GitChangesResult,
  type GitComparison,
  type GitComparisonRequest,
  type GitDiffRequest,
  type GitDiffResult,
  type GitFileRequest,
  type GitFileResult,
  type GitFilesRequest,
  type GitFilesResult,
  type GitObservationRequest,
  type GitObservationValue,
} from "../../composition/observation-api.ts";
import {
  encodeGitObservationCursor,
  gitComparisonJson,
  gitComparisonNext,
  gitObservationQuery,
  gitRecordWindow,
  gitTextWindow,
  observationDigest,
  parseGitObservationCursor,
  sameObservationCheckout,
  type GitObservationCheckout,
  type GitObservationCursor,
  type GitPagedKind,
} from "../../composition/observation-records.ts";
import { gitSession } from "./git.ts";
import { objectSourceAt } from "./object-source.ts";
import type { RepositoryHost } from "./host.ts";

/** Where one observation reads, as the provider authenticated it. */
export interface ObservationPlace {
  /** All six members of the authenticated Repository identity. */
  readonly repository: RepositoryIdentity;
  /** The canonical root of the checkout the route selected. */
  readonly root: string;
  /** That checkout's canonical common Git directory. */
  readonly commonDirectory: string;
}

/**
 * The variables every read states, and the reason each is stated.
 *
 * Lazy fetching off, so an object the checkout does not hold refuses instead of
 * contacting a promisor remote. Optional locks off, so nothing this read does
 * writes a lock file beside somebody's index.
 */
const READ_VARIABLES: Readonly<Record<string, string>> = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
};

/** The pre-command options every read states, whatever it is reading. */
const READ_OPTIONS: readonly string[] = [
  "--literal-pathspecs",
  "--no-optional-locks",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** The patch options every diff states, so none of them is configuration's. */
const PATCH_OPTIONS: readonly string[] = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--unified=3",
  "--diff-algorithm=myers",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--find-renames=50%",
];

/** The rename and status options every comparison states. */
const STATUS_OPTIONS: readonly string[] = [
  "--name-status",
  "-z",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames=50%",
];

/** The tree every comparison uses in place of an unborn HEAD. */
const EMPTY_TREE: Readonly<Record<GitObjectFormat, string>> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

/** One observation's contained view, and the scratch it owns. */
interface IsolatedView {
  readonly host: RepositoryHost;
  readonly element: string;
  /** The scratch root this observation owns, which is also Git's `HOME`. */
  readonly scratch: string;
  /** The bare control repository the contained objects are read through. */
  readonly control: string;
  /** The authenticated checkout root. */
  readonly worktree: string;
  /** That checkout's canonical common Git directory, which holds shared state. */
  readonly commonDirectory: string;
  readonly format: GitObjectFormat;
  /** The private index copy, prepared by the first read that needs one. */
  index(): Operation<string>;
}

function refuse(view: IsolatedView, reason: Parameters<typeof refusalOf>[1], sentence: string): never {
  throw refusalOf(view.element, reason, sentence);
}

function refusalOf(
  element: string,
  reason: "invalid-revision" | "absent-path" | "nontext-blob" | "unusable-repository" | "stale-continuation",
  sentence: string,
): GitObservationError {
  return new GitObservationError(element, reason, `${element} ${sentence}`);
}

function unreadable(view: IsolatedView, what: string): never {
  return refuse(
    view,
    "unusable-repository",
    `could not read ${what} from the selected repository. Nothing was changed; check that the ` +
      "checkout is complete and readable, then read it again.",
  );
}

/** One isolated read, with standard output decoded as text. */
function* readText(
  view: IsolatedView,
  args: readonly string[],
  options: { readonly index?: string; readonly worktree?: boolean } = {},
): Operation<{ readonly code: number; readonly stdout: string }> {
  const outcome = yield* view.host.git({
    args: isolated(view, args, options.worktree === true),
    cwd: view.worktree,
    home: view.scratch,
    variables: variablesFor(options.index),
  });
  return { code: outcome.code, stdout: outcome.stdout };
}

/** One isolated read, with standard output kept as the bytes Git wrote. */
function* readBytes(
  view: IsolatedView,
  args: readonly string[],
  options: { readonly index?: string; readonly worktree?: boolean } = {},
): Operation<{ readonly code: number; readonly stdout: Uint8Array }> {
  const capture = view.host.gitBytes;
  if (capture === undefined) {
    throw new GitOperationInfrastructureError(
      view.element,
      "the installed host lends no byte-preserving capture, and a path listing, a patch and a " +
        "blob have to be decoded by this read rather than by the capture",
    );
  }
  const outcome = yield* capture({
    args: isolated(view, args, options.worktree === true),
    cwd: view.worktree,
    home: view.scratch,
    variables: variablesFor(options.index),
  });
  return { code: outcome.code, stdout: outcome.stdout };
}

function variablesFor(index: string | undefined): Readonly<Record<string, string>> {
  return index === undefined ? READ_VARIABLES : { ...READ_VARIABLES, GIT_INDEX_FILE: index };
}

/**
 * One command's complete argument list, stated rather than inherited.
 *
 * The control repository is the Git directory; the selected root is the working
 * tree only where a comparison is about the working tree, which is the one read
 * that has one. Everything else runs against objects and an index alone.
 */
function isolated(view: IsolatedView, args: readonly string[], worktree: boolean): string[] {
  return [
    ...READ_OPTIONS,
    `--git-dir=${view.control}`,
    ...(worktree ? [`--work-tree=${view.worktree}`, "-c", "core.bare=false"] : []),
    ...args,
  ];
}

/**
 * The full commit id this revision names in the authenticated checkout, or
 * `undefined` when it names none.
 *
 * In the checkout, because that is where the references are; with lazy fetching
 * disabled, so resolving one reaches no remote. Nothing a repository's
 * configuration can name runs for a `rev-parse`.
 */
function* resolveRevision(
  view: IsolatedView,
  revision: string,
): Operation<string | undefined> {
  const outcome = yield* view.host.git({
    args: [
      ...READ_OPTIONS,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${revision}^{commit}`,
    ],
    cwd: view.worktree,
    home: view.scratch,
    variables: READ_VARIABLES,
  });
  if (outcome.code !== 0) {
    return undefined;
  }
  const resolved = outcome.stdout.trim();
  return resolved === "" ? undefined : resolved;
}

/**
 * The index this checkout actually uses, copied into this observation's scratch.
 *
 * Git's own path query rather than `<commonDir>/index`: a linked worktree has
 * an index of its own, and reading the primary one would answer a question
 * about another checkout. A split index needs the shared-index bytes too, and
 * they live beside the control repository so Git finds them where it looks —
 * the source is read and never refreshed, expanded or repaired.
 */
function* copyIndex(view: IsolatedView): Operation<string> {
  const reported = yield* view.host.git({
    args: [...READ_OPTIONS, "rev-parse", "--git-path", "index"],
    cwd: view.worktree,
    home: view.scratch,
    variables: READ_VARIABLES,
  });
  const path = reported.stdout.trim();
  if (reported.code !== 0 || path === "") {
    return unreadable(view, "the location of its index");
  }
  const source = path.startsWith("/") ? path : `${view.worktree}/${path}`;
  const copy = `${view.scratch}/index`;
  // Beside the copy, not beside the control repository: Git resolves a split
  // index's shared data relative to the index file it is reading, so a copy
  // whose shared bytes sat anywhere else would be an index it cannot open. Both
  // directories are searched because a linked worktree keeps its own shared
  // index under its own administration while the primary keeps one in the
  // common directory.
  const separator = source.lastIndexOf("/");
  const directories = new Set([
    separator > 0 ? source.slice(0, separator) : view.commonDirectory,
    view.commonDirectory,
  ]);
  try {
    yield* copyIndexFile(source, copy);
    for (const directory of directories) {
      for (const name of yield* readdir(directory)) {
        if (name.startsWith("sharedindex.")) {
          yield* copyIndexFile(`${directory}/${name}`, `${view.scratch}/${name}`);
        }
      }
    }
  } catch {
    return unreadable(view, "its index");
  }
  return copy;
}

/**
 * Copy one index file, keeping the times the original carried.
 *
 * The times are part of what an index means. Git decides whether a cached
 * entry can be trusted by comparing the entry's recorded modification time
 * with the *index file's* own — an entry no older than the index it sits in is
 * "racily clean", and Git compares the file's content rather than believing the
 * cache. A copy stamped with the current time makes every such entry look
 * reliably clean, so a working-tree edit made in the same second as the commit
 * that recorded it would be reported as no change at all.
 *
 * `utimes` rather than an `@effectionx/fs` operation, which has none: the
 * promise is adapted here, in the adapter that owns the host call.
 */
function* copyIndexFile(source: string, destination: string): Operation<void> {
  const info = yield* lstat(source);
  yield* copyFile(source, destination);
  yield* until(utimes(destination, info.atime, info.mtime));
}

/**
 * The NUL-framed records this output holds, or the read's own refusal.
 *
 * A truncated response is not an empty observation. Git's `-z` output ends with
 * a separator after the last record, so bytes after it mean the command stopped
 * part way through — and answering a document with the prefix would report a
 * listing that was never complete.
 */
function framed(view: IsolatedView, output: Uint8Array, what: string): readonly string[] {
  if (output.length === 0) {
    return Object.freeze([]);
  }
  if (output[output.length - 1] !== 0) {
    return unreadable(view, `a complete ${what}`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) {
      continue;
    }
    try {
      records.push(decoder.decode(output.subarray(start, index)));
    } catch {
      return unreadable(view, `a ${what} this host can decode`);
    }
    start = index + 1;
  }
  return Object.freeze(records);
}

/** What this comparison resolves to, once, for this observation. */
function* resolveComparison(
  view: IsolatedView,
  request: GitComparisonRequest,
): Operation<GitComparison> {
  if (request.compare === "unstaged") {
    return Object.freeze({ compare: "unstaged" as const });
  }
  if (request.compare === "staged") {
    // An unborn branch has no HEAD commit, and that is ordinary Git rather than
    // a refusal: the comparison is against the empty tree and every staged path
    // is an addition. Nothing invents a commit for it.
    const head = yield* resolveRevision(view, "HEAD");
    return Object.freeze({ compare: "staged" as const, base: head ?? null });
  }
  const base = yield* resolveRevision(view, request.base);
  if (base === undefined) {
    return refuse(
      view,
      "invalid-revision",
      `was given base=${JSON.stringify(request.base)}, which names no commit in the selected ` +
        "repository. Write a revision that does, then read it again.",
    );
  }
  const head = yield* resolveRevision(view, request.head);
  if (head === undefined) {
    return refuse(
      view,
      "invalid-revision",
      `was given head=${JSON.stringify(request.head)}, which names no commit in the selected ` +
        "repository. Write a revision that does, then read it again.",
    );
  }
  return Object.freeze({ compare: "commits" as const, base, head });
}

/** The arguments one comparison's `diff` takes, beside its own output options. */
function comparisonArgs(
  view: IsolatedView,
  comparison: GitComparison,
): { readonly args: readonly string[]; readonly worktree: boolean } {
  if (comparison.compare === "unstaged") {
    // The one comparison about the working tree, so the one that names one.
    // `--ignore-submodules=dirty` keeps a tracked gitlink's changed HEAD
    // pointer visible through Git's own read while leaving the contents of a
    // nested checkout — and anything its configuration would run — alone.
    return { args: ["diff", "--ignore-submodules=dirty"], worktree: true };
  }
  if (comparison.compare === "staged") {
    return {
      args: ["diff", "--cached", comparison.base ?? EMPTY_TREE[view.format]],
      worktree: false,
    };
  }
  return { args: ["diff", comparison.base, comparison.head], worktree: false };
}

/**
 * The change records this comparison produced, complete and normalized.
 *
 * Git's own letters, with a rename's similarity score removed and its previous
 * path kept. A status this host has no letter for is not dropped: a read that
 * silently omitted one would report a comparison as smaller than it is.
 */
function* observeChanges(
  view: IsolatedView,
  comparison: GitComparison,
): Operation<readonly GitChange[]> {
  const shape = comparisonArgs(view, comparison);
  const index = comparison.compare === "commits" ? undefined : yield* view.index();
  const outcome = yield* readBytes(
    view,
    [...shape.args, ...STATUS_OPTIONS, "--"],
    { worktree: shape.worktree, ...(index === undefined ? {} : { index }) },
  );
  if (outcome.code !== 0) {
    return unreadable(view, "what this comparison changed");
  }
  const records = framed(view, outcome.stdout, "comparison");
  const changes: GitChange[] = [];
  const unmerged = new Set<string>();
  let at = 0;
  while (at < records.length) {
    const letter = records[at];
    if (letter === undefined || letter === "") {
      return unreadable(view, "a complete comparison");
    }
    const status = parseStatus(letter);
    if (status === undefined) {
      return refuse(
        view,
        "unusable-repository",
        `read a change this host has no word for in the selected comparison. Nothing was ` +
          "changed, and no part of the comparison is reported as though it were complete.",
      );
    }
    const renamed = status === "R";
    const previous = renamed ? records[at + 1] : undefined;
    const path = renamed ? records[at + 2] : records[at + 1];
    at += renamed ? 3 : 2;
    if (path === undefined || (renamed && previous === undefined)) {
      return unreadable(view, "a complete comparison");
    }
    if (status === "U") {
      unmerged.add(path);
    }
    changes.push(
      Object.freeze({ path, status, previousPath: renamed ? (previous ?? null) : null }),
    );
  }
  // One record per unmerged path. Git reports an unmerged path twice — once as
  // unmerged and once comparing a stage of it with the working tree — and a
  // document reading two records for one path would read one conflict as two
  // facts. The unmerged one is the one that describes the state.
  if (unmerged.size === 0) {
    return sortedChanges(changes);
  }
  const collapsed: GitChange[] = [];
  const reported = new Set<string>();
  for (const change of changes) {
    if (!unmerged.has(change.path)) {
      collapsed.push(change);
      continue;
    }
    if (change.status !== "U" || reported.has(change.path)) {
      continue;
    }
    reported.add(change.path);
    collapsed.push(change);
  }
  return sortedChanges(collapsed);
}

/**
 * The status this letter names, with a rename's similarity score removed.
 *
 * Copy detection and rewrite breaking are both off, so `C` and `B` are letters
 * this host does not produce and does not read back as something else.
 */
function parseStatus(letter: string): GitChangeStatus | undefined {
  const head = letter[0];
  if (head === "R") {
    return /^R[0-9]*$/.test(letter) ? "R" : undefined;
  }
  if (letter.length !== 1) {
    return undefined;
  }
  if (head === "A" || head === "M" || head === "D" || head === "T" || head === "U") {
    return head;
  }
  return undefined;
}

/** The complete patch text this comparison and these filters select. */
function* observePatch(
  view: IsolatedView,
  comparison: GitComparison,
  filters: readonly string[] | null,
): Operation<string> {
  const shape = comparisonArgs(view, comparison);
  const index = comparison.compare === "commits" ? undefined : yield* view.index();
  // The pathspecs are the literal paths the status collection actually selected,
  // both sides of a rename included. Passing the authored filters would hand a
  // directory selector to Git as a pathspec; passing none, when some were
  // written, would select everything.
  let pathspecs: readonly string[] | undefined;
  if (filters !== null) {
    const selected: string[] = [];
    for (const change of yield* observeChanges(view, comparison)) {
      if (!selectedChange(filters, change)) {
        continue;
      }
      selected.push(change.path);
      if (change.previousPath !== null) {
        selected.push(change.previousPath);
      }
    }
    if (selected.length === 0) {
      return "";
    }
    pathspecs = Object.freeze([...new Set(selected)]);
  }
  const outcome = yield* readBytes(
    view,
    [...shape.args, ...PATCH_OPTIONS, "--", ...(pathspecs ?? [])],
    { worktree: shape.worktree, ...(index === undefined ? {} : { index }) },
  );
  if (outcome.code !== 0) {
    return unreadable(view, "the patch this comparison produces");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(outcome.stdout);
  } catch {
    return unreadable(view, "a patch this host can decode");
  }
}

/** The tracked paths this checkout's index holds, sorted and deduplicated. */
function* observeTrackedPaths(view: IsolatedView): Operation<readonly string[]> {
  const index = yield* view.index();
  const outcome = yield* readBytes(
    view,
    ["ls-files", "--cached", "--full-name", "-z", "--"],
    { index },
  );
  if (outcome.code !== 0) {
    return unreadable(view, "its tracked files");
  }
  // One path per entry: an unmerged path has an index entry per stage, and a
  // listing that repeated it would report a file three times.
  const listed = new Set(framed(view, outcome.stdout, "file listing"));
  return Object.freeze([...listed].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
}

/** The checkout one cursor is built against and held to. */
function checkoutOf(place: ObservationPlace): GitObservationCheckout {
  return Object.freeze({
    repository: place.repository,
    root: place.root,
    commonDirectory: place.commonDirectory,
  });
}

/**
 * The refusal a continuation that cannot be followed raises.
 *
 * One sentence for every reason a cursor stops describing this observation —
 * changed data, a malformed or wrong-kind cursor, another checkout — because
 * what the caller does about all of them is the same thing: read again from the
 * beginning. No partial page is bound and no two observations are combined.
 */
function staleContinuation(element: string): GitObservationError {
  const restart =
    element === "<Git.Diff>"
      ? `Restart ${element} without cursor and offset={0}.`
      : `Restart ${element} without cursor.`;
  return new GitObservationError(
    element,
    "stale-continuation",
    `The Git observation changed. ${restart}`,
  );
}

/**
 * The position this read starts at, having held any cursor to this observation.
 *
 * The cursor is verified against a route and an observation this read computed
 * independently: the kind it is for, the query it asks, the checkout the
 * provider authenticated, and the digest of the complete filtered answer. None
 * of it is used to decide where to read — only whether this is a page of the
 * same answer.
 */
function* continuedPosition(
  view: IsolatedView,
  place: ObservationPlace,
  kind: GitPagedKind,
  request: GitObservationRequest,
  comparison: GitComparison | null,
  observation: string,
  cursor: string | null,
): Operation<number> {
  if (cursor === null) {
    return 0;
  }
  const parsed: GitObservationCursor | undefined = parseGitObservationCursor(cursor);
  if (parsed === undefined || parsed.kind !== kind) {
    throw staleContinuation(view.element);
  }
  const query = yield* observationDigest(gitObservationQuery(request, comparison));
  const recorded = yield* observationDigest(parsed.query);
  if (query !== recorded) {
    throw staleContinuation(view.element);
  }
  if (!sameObservationCheckout(parsed.checkout, checkoutOf(place))) {
    throw staleContinuation(view.element);
  }
  if (parsed.observation !== observation) {
    throw staleContinuation(view.element);
  }
  return parsed.position;
}

function* cursorFor(
  place: ObservationPlace,
  kind: GitPagedKind,
  request: GitObservationRequest,
  comparison: GitComparison | null,
  observation: string,
  position: number,
): Operation<string> {
  return encodeGitObservationCursor({
    version: 1,
    kind,
    query: gitObservationQuery(request, comparison),
    checkout: checkoutOf(place),
    comparison,
    observation,
    position,
  });
}

function* observeFiles(
  view: IsolatedView,
  request: GitFilesRequest,
  place: ObservationPlace,
): Operation<GitFilesResult> {
  const tracked = yield* observeTrackedPaths(view);
  const selected =
    request.prefix === null
      ? tracked
      : Object.freeze(tracked.filter((path) => path.startsWith(request.prefix ?? "")));
  const observation = yield* observationDigest({ kind: "files", paths: [...selected] });
  const start = yield* continuedPosition(view, place, "files", request, null, observation, request.cursor);
  const window = gitRecordWindow(selected, start, request.limit);
  if (window.nextIndex === null) {
    return Object.freeze({ paths: window.page, next: null });
  }
  const cursor = yield* cursorFor(place, "files", request, null, observation, window.nextIndex);
  return Object.freeze({
    paths: window.page,
    next: Object.freeze({
      ...(request.prefix === null ? {} : { prefix: request.prefix }),
      limit: request.limit,
      cursor,
    }),
  });
}

function* observeChangesPage(
  view: IsolatedView,
  request: GitChangesRequest,
  place: ObservationPlace,
): Operation<GitChangesResult> {
  const comparison = yield* resolveComparison(view, request.comparison);
  const observed = yield* observeChanges(view, comparison);
  const selected = Object.freeze(observed.filter((change) => selectedChange(request.paths, change)));
  const observation = yield* observationDigest({
    kind: "changes",
    comparison: gitComparisonJson(comparison),
    changes: selected.map((change) => ({
      path: change.path,
      status: change.status,
      previousPath: change.previousPath,
    })),
  });
  const start = yield* continuedPosition(
    view,
    place,
    "changes",
    request,
    comparison,
    observation,
    request.cursor,
  );
  const window = gitRecordWindow(selected, start, request.limit);
  if (window.nextIndex === null) {
    return Object.freeze({ comparison, changes: window.page, next: null });
  }
  const cursor = yield* cursorFor(
    place,
    "changes",
    request,
    comparison,
    observation,
    window.nextIndex,
  );
  return Object.freeze({
    comparison,
    changes: window.page,
    next: Object.freeze({
      ...gitComparisonNext(comparison),
      ...(request.paths === null ? {} : { paths: Object.freeze([...request.paths]) }),
      limit: request.limit,
      cursor,
    }),
  });
}

function* observeDiffPage(
  view: IsolatedView,
  request: GitDiffRequest,
  place: ObservationPlace,
): Operation<GitDiffResult> {
  const comparison = yield* resolveComparison(view, request.comparison);
  const patch = yield* observePatch(view, comparison, request.paths);
  const observation = yield* observationDigest({
    kind: "diff",
    comparison: gitComparisonJson(comparison),
    text: patch,
  });
  // A cursor names the offset it was issued for, so a follow-up that moved the
  // offset by hand is reading a page this continuation never described.
  const position = yield* continuedPosition(
    view,
    place,
    "diff",
    request,
    comparison,
    observation,
    request.cursor,
  );
  if (request.cursor !== null && position !== request.offset) {
    throw staleContinuation(view.element);
  }
  const window = gitTextWindow(patch, request.offset, request.limit);
  if (window.nextOffset === null) {
    return Object.freeze({
      comparison,
      text: window.text,
      offset: request.offset,
      length: window.length,
      next: null,
    });
  }
  const cursor = yield* cursorFor(
    place,
    "diff",
    request,
    comparison,
    observation,
    window.nextOffset,
  );
  return Object.freeze({
    comparison,
    text: window.text,
    offset: request.offset,
    length: window.length,
    next: Object.freeze({
      ...gitComparisonNext(comparison),
      ...(request.paths === null ? {} : { paths: Object.freeze([...request.paths]) }),
      offset: window.nextOffset,
      limit: request.limit,
      cursor,
    }),
  });
}

function* observeFile(
  view: IsolatedView,
  request: GitFileRequest,
  place: ObservationPlace,
): Operation<GitFileResult> {
  const commit = yield* resolveRevision(view, request.commit);
  if (commit === undefined) {
    return refuse(
      view,
      "invalid-revision",
      `was given commit=${JSON.stringify(request.commit)}, which names no commit in the ` +
        "selected repository. Write a revision that does, then read it again.",
    );
  }
  // The tree entry before the object, because the two questions are different:
  // whether the commit holds this path at all, and whether what it holds is a
  // file. A gitlink's commit is not in this repository's object database, so
  // asking the object first would report a path the tree does hold as absent.
  const listed = yield* readText(view, ["ls-tree", "-z", "--full-name", commit, "--", request.path]);
  if (listed.code !== 0) {
    return unreadable(view, `the tree of commit ${commit}`);
  }
  const entry = treeEntry(listed.stdout, request.path);
  if (entry.kind === "absent") {
    return refuse(
      view,
      "absent-path",
      `read commit ${commit}, which holds nothing at ${JSON.stringify(request.path)}. Read a ` +
        "path that commit holds, or list them with <Git.Files>.",
    );
  }
  if (entry.kind === "directory" || entry.type !== "blob") {
    const what = entry.kind === "directory" ? "tree" : entry.type;
    return refuse(
      view,
      "nontext-blob",
      `read commit ${commit}, where ${JSON.stringify(request.path)} is a ${what} rather ` +
        "than a file. A directory and a nested checkout's recorded commit are not text to read.",
    );
  }
  const read = yield* readBytes(view, ["cat-file", "blob", entry.object]);
  if (read.code !== 0) {
    return unreadable(view, `the file ${JSON.stringify(request.path)} at commit ${commit}`);
  }
  if (read.stdout.includes(0)) {
    return refuse(
      view,
      "nontext-blob",
      `read ${JSON.stringify(request.path)} at commit ${commit}, which holds a NUL byte, so it ` +
        "is not text this read can window.",
    );
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(read.stdout);
  } catch {
    return refuse(
      view,
      "nontext-blob",
      `read ${JSON.stringify(request.path)} at commit ${commit}, which is not valid UTF-8, so ` +
        "it is not text this read can window. Nothing was replaced or repaired.",
    );
  }
  const window = gitTextWindow(content, request.offset, request.limit);
  return Object.freeze({
    commit,
    path: request.path,
    text: window.text,
    offset: request.offset,
    length: window.length,
    next:
      window.nextOffset === null
        ? null
        : Object.freeze({
            commit,
            path: request.path,
            offset: window.nextOffset,
            limit: request.limit,
          }),
  });
}

/** What the commit holds at the exact path a read asked for. */
type TreeEntry =
  /** The entry at that path, with the object and type Git reported for it. */
  | { readonly kind: "entry"; readonly type: string; readonly object: string }
  /** A directory: the path names no entry, and entries beneath it exist. */
  | { readonly kind: "directory" }
  | { readonly kind: "absent" };

/**
 * The entry this commit holds at exactly the path that was asked for.
 *
 * Each record is `<mode> <type> <object>`, a tab, then the path. The path is
 * what decides the answer, because the argument Git received is a *pathspec*
 * rather than a lookup: `dir` matches the directory entry itself and `dir/`
 * matches the things inside it. Taking the first record would answer a read of
 * `dir/` with the blob at `dir/inside.txt` — a file the caller never named,
 * under a path the result would claim was a directory.
 *
 * So a path that matched records but is not one of them is a directory, which
 * is refused as the tree it is; a path that matched nothing is absent.
 */
function treeEntry(output: string, path: string): TreeEntry {
  let matched = false;
  for (const record of output.split("\u0000")) {
    const tab = record.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    matched = true;
    if (record.slice(tab + 1) !== path) {
      continue;
    }
    const fields = record.slice(0, tab).split(" ");
    const type = fields[1];
    const object = fields[2];
    if (type === undefined || object === undefined) {
      continue;
    }
    return { kind: "entry", type, object };
  }
  return matched ? { kind: "directory" } : { kind: "absent" };
}

/**
 * Read the selected checkout, once, and answer with the page that was asked for.
 *
 * Scoped, so the scratch directory, the control repository and every native
 * child this read started are torn down before the answer exists. The caller
 * publishes afterwards: a result that appeared while a child was still running
 * would be a completion for work that had not finished.
 */
export function performGitObservation(
  host: RepositoryHost,
  element: string,
  request: GitObservationRequest,
  place: ObservationPlace,
): Operation<GitObservationValue> {
  return scoped(function* () {
    const format = place.repository.objectFormat;
    const scratch = yield* host.useDirectory();
    const source = objectSourceAt(host, scratch, place.commonDirectory, format, element);
    // The containment proof runs before any object is read: everything Git may
    // traverse has to resolve inside the database the provider authenticated.
    const control = yield* source.ready();
    let index: string | undefined;
    const view: IsolatedView = {
      host,
      element,
      scratch,
      control,
      worktree: place.root,
      commonDirectory: place.commonDirectory,
      format,
      *index(): Operation<string> {
        if (index === undefined) {
          index = yield* copyIndex(view);
        }
        return index;
      },
    };
    if (request.kind === "files") {
      return yield* observeFiles(view, request, place);
    }
    if (request.kind === "changes") {
      return yield* observeChangesPage(view, request, place);
    }
    if (request.kind === "diff") {
      return yield* observeDiffPage(view, request, place);
    }
    return yield* observeFile(view, request, place);
  });
}
