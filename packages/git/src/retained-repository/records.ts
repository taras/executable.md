/**
 * What one REPL entry retains about repository work, and what names it.
 *
 * A retained repository effect is read back out of an ordinary JSONL journal on
 * a later open, so nothing here is this package's own word by the time it is
 * read. Each record is therefore parsed exactly: a value carrying more or fewer
 * members than its shape declares describes something other than that shape,
 * and reading it as one would accept whatever a later version — or another
 * entry — put there.
 *
 * The protocol is closed and version 1. There is no forward-compatible member
 * bag, because an unknown member in a record that decides whether a mutation
 * already happened is not a feature to ignore: continuation fails closed and the
 * person is told, rather than replaying against a history this code cannot
 * fully read.
 *
 * Two kinds of record exist. An **intent** is written before a mutation and
 * freezes everything the mutation will use, including the state it expects to
 * find and the state it will leave. A **completion** is written after the
 * mutation is verified and carries what it produced. An intent with no
 * completion is pending work that a later open reconciles or refuses; it is
 * never evidence that the mutation happened.
 *
 * Nothing operational is retained. A record holds detached JSON — never a
 * credential, a live handle, a function or a private selection token — so a
 * copied record is descriptive data and grants nothing.
 *
 * The frontier shape is what makes "the state I expected" decidable. It carries
 * semantic Git state and a content-and-mode worktree inventory, and it
 * deliberately has no member for a stat cache, a pack layout or a reflog time:
 * those differ between two checkouts that are semantically identical, so a
 * shape that held them would refuse honest work. Git's own administrative
 * directory is outside the worktree inventory for the same reason, and its
 * identity and relationships are proven by {@link RetainedAdministration}
 * instead.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { parseFileWriteFailure, parseFilesFailure } from "@executablemd/runtime";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, text } from "../composition/parse.ts";
import type {
  GitFailureReason,
  RepositoryFailureReason,
  WorktreeFailureReason,
} from "../composition/errors.ts";

/** The durable type an intent is journaled under. */
export const RETAINED_REPOSITORY_INTENT = "retained_repository_intent";

/** The durable type a local completion is journaled under. */
export const RETAINED_REPOSITORY_COMPLETION = "retained_repository_completion";

/** The one version of this protocol that exists. */
export const RETAINED_REPOSITORY_VERSION = 1;

/**
 * The entry that owns a retained effect.
 *
 * The execution and the entry together, because one execution admits entries in
 * order and each of them owns its own effects. Neither half alone identifies an
 * owner: two entries of one execution share the execution, and two executions
 * can reach the same entry key.
 */
export interface RetainedRepositoryOwnerIdentity {
  readonly executionId: string;
  readonly entryKey: string;
}

/**
 * How that pair is spelled in a record.
 *
 * A prefix and canonical JSON of the pair, so the spelling is stable across
 * runtimes and cannot be confused with a workflow run id. Existing Git-host and
 * Issue records keep their own `runId` spelling; this is a third owner, not a
 * replacement for either.
 */
export function retainedRepositoryOwner(identity: RetainedRepositoryOwnerIdentity): string {
  return `repl:v1:${canonicalJson([identity.executionId, identity.entryKey])}`;
}

/**
 * Where in the document one effect was asked for.
 *
 * The occurrence is the engine's own invocation identity, which separates two
 * iterations of a loop and an authored element from a generated one. The source
 * is the admitted document or generated source it was written in, so a record
 * never answers for the same occurrence in a different source.
 */
export interface RetainedRepositorySite {
  readonly source: string;
  readonly occurrence: string;
}

/**
 * The state lane one mutation advances, and where in that lane it sits.
 *
 * Keyed by the canonical common Git directory, because that is what two linked
 * worktrees share: serializing per checkout would let two of them move the same
 * refs at once. The position orders a lane's records and nothing else — it is
 * not a count of anything and not a position in the journal.
 */
export interface RetainedRepositoryLane {
  readonly common: string;
  readonly position: number;
}

/** What one retained effect does. */
export type RetainedRepositoryOperation =
  | "repository"
  | "worktree"
  | "ambient"
  | "switch"
  | "add"
  | "commit"
  | "file-write"
  | "file-delete"
  | "dir-ensure"
  | "push"
  | "pull-request"
  | "issue";

/** Every operation this protocol has, in canonical order. */
export const RETAINED_REPOSITORY_OPERATIONS: readonly RetainedRepositoryOperation[] = Object.freeze(
  [
    "repository",
    "worktree",
    "ambient",
    "switch",
    "add",
    "commit",
    "file-write",
    "file-delete",
    "dir-ensure",
    "push",
    "pull-request",
    "issue",
  ],
);

/**
 * The operations that establish a checkout rather than change one.
 *
 * A lane's first record is one of these: a mutation written before anything
 * selected a checkout has no baseline to be held to, and admitting it would
 * mean trusting its own account of the state it started from.
 */
const SELECTIONS: ReadonlySet<string> = new Set(["repository", "worktree", "ambient"]);

/** Whether this operation establishes a checkout. */
export function establishesCheckout(operation: RetainedRepositoryOperation): boolean {
  return SELECTIONS.has(operation);
}

/** Which commit HEAD names, and whether it does so through a ref. */
export type RetainedHead =
  | { readonly kind: "symbolic"; readonly ref: string; readonly oid: string | null }
  | { readonly kind: "detached"; readonly oid: string };

/** One ref and what it points at. */
export interface RetainedRef {
  readonly name: string;
  readonly oid: string;
}

/** One index entry, with the stage and flags that make it semantic. */
export interface RetainedIndexEntry {
  readonly path: string;
  readonly stage: number;
  readonly oid: string;
  readonly mode: string;
  readonly flags: readonly string[];
}

/**
 * One path in the worktree, including untracked and ignored content.
 *
 * A file carries its bytes as base64 rather than text: a frontier that compared
 * decoded text would call two different files equal whenever the difference was
 * not valid UTF-8. A directory is listed so an empty one is part of the state,
 * and a symlink carries its target rather than what the target holds.
 */
export type RetainedWorktreeEntry =
  | { readonly kind: "file"; readonly path: string; readonly mode: string; readonly bytes: string }
  | { readonly kind: "directory"; readonly path: string; readonly mode: string }
  | { readonly kind: "symlink"; readonly path: string; readonly target: string };

/** Which Git directories a checkout has, and how they relate. */
export interface RetainedAdministration {
  readonly common: string;
  /** The linked worktree's own administrative directory; absent for a primary checkout. */
  readonly worktree: string | null;
  readonly role: "primary" | "linked";
}

/** The saved state one accepted record establishes for one checkout. */
export interface RetainedFrontier {
  readonly checkout: string;
  readonly administration: RetainedAdministration;
  readonly objectFormat: "sha1" | "sha256";
  readonly head: RetainedHead;
  readonly refs: readonly RetainedRef[];
  readonly index: readonly RetainedIndexEntry[];
  readonly worktree: readonly RetainedWorktreeEntry[];
}

/**
 * What one mutation froze before it ran.
 *
 * `request` is what the document authored and `prepared` is what preparation
 * resolved from it, kept apart on purpose: a replay compares the authored
 * request with the saved one and then uses the saved prepared values, so a
 * resumed commit does not re-resolve HEAD, a branch base, the clock or an
 * identity. `evidence` is what the operation's own result must match.
 */
export interface RetainedRepositoryIntent {
  readonly version: typeof RETAINED_REPOSITORY_VERSION;
  readonly owner: string;
  readonly site: RetainedRepositorySite;
  readonly operation: RetainedRepositoryOperation;
  readonly lane: RetainedRepositoryLane;
  readonly selection: Json;
  readonly request: Json;
  readonly fingerprint: string;
  readonly prepared: Json;
  readonly preState: RetainedFrontier;
  readonly postState: RetainedFrontier;
  readonly evidence: Json;
}

/**
 * What one verified mutation produced.
 *
 * It names the intent it completes and repeats that intent's request
 * fingerprint, so a completion cannot be read as the answer to a different
 * question that happens to sit at the same position.
 */
export interface RetainedRepositoryCompletion {
  readonly version: typeof RETAINED_REPOSITORY_VERSION;
  readonly owner: string;
  readonly site: RetainedRepositorySite;
  readonly intent: string;
  readonly fingerprint: string;
  readonly result: Json;
  readonly frontier: RetainedFrontier;
}

const SITE_MEMBERS = ["source", "occurrence"] as const;
const LANE_MEMBERS = ["common", "position"] as const;
const ADMINISTRATION_MEMBERS = ["common", "worktree", "role"] as const;
const SYMBOLIC_HEAD_MEMBERS = ["kind", "ref", "oid"] as const;
const DETACHED_HEAD_MEMBERS = ["kind", "oid"] as const;
const REF_MEMBERS = ["name", "oid"] as const;
const INDEX_MEMBERS = ["path", "stage", "oid", "mode", "flags"] as const;
const FILE_MEMBERS = ["kind", "path", "mode", "bytes"] as const;
const DIRECTORY_MEMBERS = ["kind", "path", "mode"] as const;
const SYMLINK_MEMBERS = ["kind", "path", "target"] as const;
const FRONTIER_MEMBERS = [
  "checkout",
  "administration",
  "objectFormat",
  "head",
  "refs",
  "index",
  "worktree",
] as const;
const INTENT_MEMBERS = [
  "version",
  "owner",
  "site",
  "operation",
  "lane",
  "selection",
  "request",
  "fingerprint",
  "prepared",
  "preState",
  "postState",
  "evidence",
] as const;
const COMPLETION_MEMBERS = [
  "version",
  "owner",
  "site",
  "intent",
  "fingerprint",
  "result",
  "frontier",
] as const;

/**
 * A detached, deeply frozen copy of the JSON this value describes.
 *
 * A copy rather than the value itself: whatever handed it over keeps its own
 * object, and nothing it does to that object afterwards changes what admission
 * accepted. `undefined` is the single answer for "this is not JSON", which is
 * why a member that is literally `undefined` is refused rather than dropped — a
 * shape with a missing member is not that shape with a hole in it.
 */
function json(value: unknown, ancestors: Set<object>): Json | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  if (ancestors.has(value)) {
    return undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: Json[] = [];
      for (let index = 0; index < value.length; index += 1) {
        // A hole is not a member. `[1, , 3]` reads its middle element as
        // `undefined`, which JSON cannot express and this must not invent.
        if (!Object.hasOwn(value, index)) {
          return undefined;
        }
        const item = json(Reflect.get(value, index), ancestors);
        if (item === undefined) {
          return undefined;
        }
        items.push(item);
      }
      Object.freeze(items);
      return items;
    }
    const detached: Record<string, Json> = {};
    for (const key of Object.keys(value)) {
      const member = json(Reflect.get(value, key), ancestors);
      if (member === undefined) {
        return undefined;
      }
      // Defined rather than assigned: `detached[key] = …` reaches
      // `Object.prototype`'s setter for `__proto__` and drops the key on Node
      // and Bun, so a payload declaring that name would detach differently
      // depending on where it ran.
      Object.defineProperty(detached, key, {
        value: member,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    Object.freeze(detached);
    return detached;
  } finally {
    ancestors.delete(value);
  }
}

/** The detached JSON this value describes, or `undefined` when it describes none. */
export function detachedJson(value: unknown): Json | undefined {
  try {
    return json(value, new Set<object>());
  } catch {
    return undefined;
  }
}

function version(value: unknown): typeof RETAINED_REPOSITORY_VERSION | undefined {
  return value === RETAINED_REPOSITORY_VERSION ? RETAINED_REPOSITORY_VERSION : undefined;
}

function wholeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function list<T>(
  value: unknown,
  parse: (member: unknown) => T | undefined,
): readonly T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return undefined;
    }
    const member = parse(Reflect.get(value, index));
    if (member === undefined) {
      return undefined;
    }
    parsed.push(member);
  }
  return Object.freeze(parsed);
}

/** The site this value describes, or `undefined`. */
export function parseRetainedRepositorySite(value: unknown): RetainedRepositorySite | undefined {
  const read = members(value, SITE_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const source = text(read["source"]);
  const occurrence = text(read["occurrence"]);
  if (source === undefined || occurrence === undefined) {
    return undefined;
  }
  return Object.freeze({ source, occurrence });
}

/** The lane position this value describes, or `undefined`. */
export function parseRetainedRepositoryLane(value: unknown): RetainedRepositoryLane | undefined {
  const read = members(value, LANE_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const common = text(read["common"]);
  const position = wholeNumber(read["position"]);
  if (common === undefined || position === undefined) {
    return undefined;
  }
  return Object.freeze({ common, position });
}

function parseAdministration(value: unknown): RetainedAdministration | undefined {
  const read = members(value, ADMINISTRATION_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const common = text(read["common"]);
  const role = read["role"];
  const worktree = read["worktree"] === null ? null : text(read["worktree"]);
  if (common === undefined || worktree === undefined) {
    return undefined;
  }
  if (role !== "primary" && role !== "linked") {
    return undefined;
  }
  // A primary checkout's administration *is* the common directory, and a linked
  // one has its own beside it. Either shape without the other's relationship
  // describes a checkout that cannot exist.
  if ((role === "primary") !== (worktree === null)) {
    return undefined;
  }
  return Object.freeze({ common, worktree, role });
}

function parseHead(value: unknown): RetainedHead | undefined {
  const kind = kindOf(value);
  if (kind === "symbolic") {
    const read = members(value, SYMBOLIC_HEAD_MEMBERS);
    if (read === undefined) {
      return undefined;
    }
    const ref = text(read["ref"]);
    const oid = read["oid"] === null ? null : text(read["oid"]);
    if (ref === undefined || oid === undefined) {
      return undefined;
    }
    return Object.freeze({ kind, ref, oid });
  }
  if (kind !== "detached") {
    return undefined;
  }
  const read = members(value, DETACHED_HEAD_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const oid = text(read["oid"]);
  if (oid === undefined) {
    return undefined;
  }
  return Object.freeze({ kind, oid });
}

/**
 * The word a value uses for its own kind, read on its own.
 *
 * The kind selects which members the value must carry exactly, so it has to be
 * read before that membership is decided.
 */
function kindOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, "kind");
}

function parseRef(value: unknown): RetainedRef | undefined {
  const read = members(value, REF_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const name = text(read["name"]);
  const oid = text(read["oid"]);
  if (name === undefined || oid === undefined) {
    return undefined;
  }
  return Object.freeze({ name, oid });
}

function parseIndexEntry(value: unknown): RetainedIndexEntry | undefined {
  const read = members(value, INDEX_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const path = text(read["path"]);
  const stage = wholeNumber(read["stage"]);
  const oid = text(read["oid"]);
  const mode = text(read["mode"]);
  const flags = list(read["flags"], text);
  if (
    path === undefined ||
    stage === undefined ||
    oid === undefined ||
    mode === undefined ||
    flags === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ path, stage, oid, mode, flags });
}

function parseWorktreeEntry(value: unknown): RetainedWorktreeEntry | undefined {
  const kind = kindOf(value);
  if (kind === "file") {
    const read = members(value, FILE_MEMBERS);
    if (read === undefined) {
      return undefined;
    }
    const path = text(read["path"]);
    const mode = text(read["mode"]);
    const bytes = base64(read["bytes"]);
    if (path === undefined || mode === undefined || bytes === undefined) {
      return undefined;
    }
    return Object.freeze({ kind, path, mode, bytes });
  }
  if (kind === "directory") {
    const read = members(value, DIRECTORY_MEMBERS);
    if (read === undefined) {
      return undefined;
    }
    const path = text(read["path"]);
    const mode = text(read["mode"]);
    if (path === undefined || mode === undefined) {
      return undefined;
    }
    return Object.freeze({ kind, path, mode });
  }
  if (kind !== "symlink") {
    return undefined;
  }
  const read = members(value, SYMLINK_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const path = text(read["path"]);
  const target = text(read["target"]);
  if (path === undefined || target === undefined) {
    return undefined;
  }
  return Object.freeze({ kind, path, target });
}

/**
 * The base64 this value is, or `undefined`.
 *
 * Empty is a real answer here — an empty file has no bytes — so this is the one
 * string member that is not required to be non-empty.
 */
function base64(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ? value
    : undefined;
}

/** The frontier this value describes, or `undefined`. */
export function parseRetainedFrontier(value: unknown): RetainedFrontier | undefined {
  const read = members(value, FRONTIER_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const checkout = text(read["checkout"]);
  const administration = parseAdministration(read["administration"]);
  const objectFormat = read["objectFormat"];
  const head = parseHead(read["head"]);
  const refs = list(read["refs"], parseRef);
  const index = list(read["index"], parseIndexEntry);
  const worktree = list(read["worktree"], parseWorktreeEntry);
  if (
    checkout === undefined ||
    administration === undefined ||
    head === undefined ||
    refs === undefined ||
    index === undefined ||
    worktree === undefined
  ) {
    return undefined;
  }
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    return undefined;
  }
  return Object.freeze({
    checkout,
    administration,
    objectFormat,
    head,
    refs,
    index,
    worktree,
  });
}

/**
 * The operation this value names, or `undefined`.
 *
 * Found in the canonical list rather than asserted: the list is the union, so
 * finding the string in it is what proves it is one of them.
 */
function parseOperation(value: unknown): RetainedRepositoryOperation | undefined {
  return RETAINED_REPOSITORY_OPERATIONS.find((operation) => operation === value);
}

/** The intent this value describes, or `undefined` when it describes none. */
export function parseRetainedRepositoryIntent(
  value: unknown,
): RetainedRepositoryIntent | undefined {
  const read = members(value, INTENT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const parsed = {
    version: version(read["version"]),
    owner: text(read["owner"]),
    site: parseRetainedRepositorySite(read["site"]),
    operation: parseOperation(read["operation"]),
    lane: parseRetainedRepositoryLane(read["lane"]),
    selection: detachedJson(read["selection"]),
    request: detachedJson(read["request"]),
    fingerprint: text(read["fingerprint"]),
    prepared: detachedJson(read["prepared"]),
    preState: parseRetainedFrontier(read["preState"]),
    postState: parseRetainedFrontier(read["postState"]),
    evidence: detachedJson(read["evidence"]),
  };
  if (
    parsed.version === undefined ||
    parsed.owner === undefined ||
    parsed.site === undefined ||
    parsed.operation === undefined ||
    parsed.lane === undefined ||
    parsed.selection === undefined ||
    parsed.request === undefined ||
    parsed.fingerprint === undefined ||
    parsed.prepared === undefined ||
    parsed.preState === undefined ||
    parsed.postState === undefined ||
    parsed.evidence === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    version: parsed.version,
    owner: parsed.owner,
    site: parsed.site,
    operation: parsed.operation,
    lane: parsed.lane,
    selection: parsed.selection,
    request: parsed.request,
    fingerprint: parsed.fingerprint,
    prepared: parsed.prepared,
    preState: parsed.preState,
    postState: parsed.postState,
    evidence: parsed.evidence,
  });
}

/** The completion this value describes, or `undefined` when it describes none. */
export function parseRetainedRepositoryCompletion(
  value: unknown,
): RetainedRepositoryCompletion | undefined {
  const read = members(value, COMPLETION_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const parsed = {
    version: version(read["version"]),
    owner: text(read["owner"]),
    site: parseRetainedRepositorySite(read["site"]),
    intent: text(read["intent"]),
    fingerprint: text(read["fingerprint"]),
    result: detachedJson(read["result"]),
    frontier: parseRetainedFrontier(read["frontier"]),
  };
  if (
    parsed.version === undefined ||
    parsed.owner === undefined ||
    parsed.site === undefined ||
    parsed.intent === undefined ||
    parsed.fingerprint === undefined ||
    parsed.result === undefined ||
    parsed.frontier === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    version: parsed.version,
    owner: parsed.owner,
    site: parsed.site,
    intent: parsed.intent,
    fingerprint: parsed.fingerprint,
    result: parsed.result,
    frontier: parsed.frontier,
  });
}

/** The frontier as the journal holds it. */
export function retainedFrontierJson(frontier: RetainedFrontier): Json {
  return {
    checkout: frontier.checkout,
    administration: {
      common: frontier.administration.common,
      worktree: frontier.administration.worktree,
      role: frontier.administration.role,
    },
    objectFormat: frontier.objectFormat,
    head:
      frontier.head.kind === "symbolic"
        ? { kind: "symbolic", ref: frontier.head.ref, oid: frontier.head.oid }
        : { kind: "detached", oid: frontier.head.oid },
    refs: frontier.refs.map((ref) => ({ name: ref.name, oid: ref.oid })),
    index: frontier.index.map((entry) => ({
      path: entry.path,
      stage: entry.stage,
      oid: entry.oid,
      mode: entry.mode,
      flags: [...entry.flags],
    })),
    worktree: frontier.worktree.map(worktreeEntryJson),
  };
}

function worktreeEntryJson(entry: RetainedWorktreeEntry): Json {
  if (entry.kind === "file") {
    return { kind: "file", path: entry.path, mode: entry.mode, bytes: entry.bytes };
  }
  if (entry.kind === "directory") {
    return { kind: "directory", path: entry.path, mode: entry.mode };
  }
  return { kind: "symlink", path: entry.path, target: entry.target };
}

/** The intent as the journal holds it. */
export function retainedRepositoryIntentJson(intent: RetainedRepositoryIntent): Json {
  return {
    version: intent.version,
    owner: intent.owner,
    site: { source: intent.site.source, occurrence: intent.site.occurrence },
    operation: intent.operation,
    lane: { common: intent.lane.common, position: intent.lane.position },
    selection: intent.selection,
    request: intent.request,
    fingerprint: intent.fingerprint,
    prepared: intent.prepared,
    preState: retainedFrontierJson(intent.preState),
    postState: retainedFrontierJson(intent.postState),
    evidence: intent.evidence,
  };
}

/** The completion as the journal holds it. */
export function retainedRepositoryCompletionJson(completion: RetainedRepositoryCompletion): Json {
  return {
    version: completion.version,
    owner: completion.owner,
    site: { source: completion.site.source, occurrence: completion.site.occurrence },
    intent: completion.intent,
    fingerprint: completion.fingerprint,
    result: completion.result,
    frontier: retainedFrontierJson(completion.frontier),
  };
}

/**
 * The words a Repository refusal retains, as a complete map of its vocabulary.
 *
 * A `Record` keyed by the union rather than a list, so the compiler refuses
 * both a missing word and an invented one. A list would silently reject a
 * refusal somebody added to the vocabulary later.
 */
const REPOSITORY_REFUSALS: Readonly<Record<RepositoryFailureReason, true>> = Object.freeze({
  "invalid-locator": true,
  "authentication-unavailable": true,
  "unresolved-base": true,
  "missing-remote-default": true,
  "incompatible-reuse": true,
  "unusable-repository": true,
});

/** The words a Worktree refusal retains. */
const WORKTREE_REFUSALS: Readonly<Record<WorktreeFailureReason, true>> = Object.freeze({
  "no-repository-context": true,
  "unresolved-base": true,
  "branch-checked-out-elsewhere": true,
  "incompatible-reuse": true,
  "unusable-repository": true,
});

/** The words a Git operation's refusal retains. */
const GIT_REFUSALS: Readonly<Record<GitFailureReason, true>> = Object.freeze({
  "invalid-invocation": true,
  "invalid-branch": true,
  "unresolved-base": true,
  "branch-checked-out-elsewhere": true,
  "overwrites-local-changes": true,
  "unmatched-pathspec": true,
  "ignored-pathspec": true,
  "outside-checkout-pathspec": true,
  "invalid-pathspec-magic": true,
  "empty-index": true,
  "unnamed-branch": true,
});

/**
 * The retained result as the runtime's own Files parsers read one.
 *
 * Those parsers answer for an error carrying failure data, because that is how
 * the data reaches every other consumer. Here it has come back out of a journal
 * as plain JSON, so it is handed over the same way rather than re-implemented:
 * the vocabulary of operations, phases, reasons and write targets stays the
 * runtime's single definition of it.
 */
function filesOutcome(result: Json): Error {
  return Object.assign(new Error("Files operation failed"), { data: result });
}

/**
 * Whether this result is a refusal `operation` is allowed to retain unchanged
 * state for.
 *
 * Positively parsed, never inferred from disagreeing with the frozen evidence:
 * a different valid success is evidence disagreement, and reading it as a
 * refusal would let a write that happened be retained as one that did not.
 *
 * A file write is held to more than a well-formed failure. Its data says what
 * became of the target, and only `unchanged` and `rolled-back` are states
 * nothing was left in — `commit-unknown` is the runtime's word for not knowing,
 * which is exactly what cannot be retained as proof that nothing changed.
 *
 * An operation with no closed local refusal vocabulary retains none. Ambient
 * selection and the three external operations fail the run or complete through
 * their own existing records instead, and a managed-placement refusal arrives
 * with the provider that owns those words.
 */
export function retainedRepositoryRefusal(
  operation: RetainedRepositoryOperation,
  result: Json,
): boolean {
  if (operation === "file-write") {
    const failure = parseFileWriteFailure(filesOutcome(result));
    if (failure === undefined) {
      return false;
    }
    return failure.target === "unchanged" || failure.target === "rolled-back";
  }
  if (operation === "file-delete" || operation === "dir-ensure") {
    return parseFilesFailure(filesOutcome(result)) !== undefined;
  }
  if (operation === "repository") {
    return refusedWith(result, REPOSITORY_REFUSALS);
  }
  if (operation === "worktree") {
    return refusedWith(result, WORKTREE_REFUSALS);
  }
  if (operation === "switch" || operation === "add" || operation === "commit") {
    return refusedWith(result, GIT_REFUSALS);
  }
  return false;
}

/**
 * Whether this result is one word from `vocabulary`, and nothing else.
 *
 * The word is the only part of one of these refusals that is safe to retain:
 * the sentence beside it is written for the person reading the document, and
 * the component that produced it deliberately keeps everything the platform
 * said out of both.
 */
function refusedWith(result: Json, vocabulary: Readonly<Record<string, true>>): boolean {
  const read = members(result, ["reason"]);
  if (read === undefined) {
    return false;
  }
  const reason = text(read["reason"]);
  return reason !== undefined && Object.hasOwn(vocabulary, reason);
}

/**
 * Whether a completion's result is the one its intent froze as evidence.
 *
 * This is what tells a performed operation from a refusal without a second
 * member to disagree with: an intent freezes the exact result its operation
 * will produce, so a completion carrying that result is the operation having
 * produced it, and a completion carrying anything else did not. Which of the
 * two it is decides which frozen state the completion is allowed to stand at.
 */
export function matchesRetainedEvidence(result: Json, evidence: Json): boolean {
  return canonicalJson(result) === canonicalJson(evidence);
}

/** Whether two frontiers describe the same saved state. */
export function sameRetainedFrontier(left: RetainedFrontier, right: RetainedFrontier): boolean {
  return canonicalJson(retainedFrontierJson(left)) === canonicalJson(retainedFrontierJson(right));
}

/**
 * The same frontier with the shared Git directory's refs replaced.
 *
 * Refs belong to the common directory rather than to one checkout, so work in a
 * linked worktree moves them for every checkout that shares it. HEAD, the index
 * and the worktree inventory stay this checkout's own: only the worktree that
 * has a branch checked out can move it, so a sibling's commit changes what the
 * ref list says without changing where this checkout stands.
 */
export function withSharedRefs(
  frontier: RetainedFrontier,
  refs: readonly RetainedRef[],
): RetainedFrontier {
  return Object.freeze({
    checkout: frontier.checkout,
    administration: frontier.administration,
    objectFormat: frontier.objectFormat,
    head: frontier.head,
    refs: Object.freeze([...refs]),
    index: frontier.index,
    worktree: frontier.worktree,
  });
}

/**
 * What one authored request asks, as a stable name.
 *
 * The owner and the site are in it, so the same text written at two occurrences
 * — two iterations of one loop, or the same line in two entries — asks two
 * different questions. What preparation resolved is not in it: a resumed
 * operation compares what the document asked with what the record saved, and
 * then uses the saved resolution.
 */
export function* retainedRepositoryRequestFingerprint(request: {
  readonly owner: string;
  readonly site: RetainedRepositorySite;
  readonly operation: RetainedRepositoryOperation;
  readonly selection: Json;
  readonly request: Json;
}): Operation<string> {
  const encoded = new TextEncoder().encode(
    canonicalJson({
      owner: request.owner,
      site: { source: request.site.source, occurrence: request.site.occurrence },
      operation: request.operation,
      selection: request.selection,
      request: request.request,
    }),
  );
  const digest = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The name one intent record is identified by.
 *
 * A digest of the whole intent, so a completion naming it cannot be satisfied
 * by an intent that differs anywhere — including in the state it expected to
 * find or the state it predicted.
 */
export function* retainedRepositoryIntentIdentity(
  intent: RetainedRepositoryIntent,
): Operation<string> {
  const encoded = new TextEncoder().encode(canonicalJson(retainedRepositoryIntentJson(intent)));
  const digest = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
