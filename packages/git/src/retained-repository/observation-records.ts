/**
 * What one REPL entry's local Git observation looks like on the wire.
 *
 * An entry that lists tracked files, compares changes, reads a patch window or
 * reads a committed file records the page it produced. Reopen the entry and the
 * saved page answers again — the same paths, the same statuses, the same
 * resolved commit, the same complete `next`, and no `git`. That is what lets an
 * entry interrupted at a question be continued rather than repeated, and it is
 * why a saved page describes the repository as it was then rather than as it is
 * now.
 *
 * ## Identity is the request, and position is the journal's
 *
 * A record's name is the digest of the record version, the read kind and the
 * whole normalized request: the authenticated Repository identity, the checkout
 * that selection named, its common Git directory, the working directory as
 * received, and the query itself. Two equal reads produce one name, and that is
 * allowed — telling two of them apart is the durable engine's own positional
 * matching, and nothing here searches history by name.
 *
 * The working directory is named as it arrived, and a revision as the document
 * wrote it. Resolving either is live work against a repository, so a replay that
 * had to resolve one to recognize its own record would be asking today's
 * repository what yesterday's question was.
 *
 * ## What a result may carry
 *
 * The exact page the read answered with, including its complete `next`. Nothing
 * else: no Git output, no credential, no handle, no live selection identifier
 * and no second copy of the observation the page was cut from.
 *
 * A refusal carries a word from the closed observation vocabulary and the
 * sentence this host wrote for it, so a continuation raises the same refusal the
 * live read raised. The sentence is this host's own prose about what the
 * document asked for — nothing a repository or a Git command printed reaches a
 * record.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, optionalText, text } from "../composition/parse.ts";
import { GitObservationError } from "../composition/errors.ts";
import type { GitObservationReason } from "../composition/errors.ts";
import {
  parseRepositoryIdentity,
  repositoryIdentityJson,
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "../composition/selection.ts";
import type { ReplPlacement } from "./placement-records.ts";
import {
  GIT_COMPARE_MODES,
  type GitComparisonRequest,
  type GitObservationKind,
  type GitObservationRequest,
  type GitObservationValue,
} from "../composition/observation-api.ts";
import {
  gitObservationValueJson,
  parseGitObservationValue,
} from "../composition/observation-records.ts";
import { digest, RECORD_PREFIX, REPL_REPOSITORY_VERSION } from "./records.ts";

/** The durable type one completed local Git observation is journaled under. */
export const REPL_REPOSITORY_OBSERVATION = "repl_repository_observation";

const OBSERVATION_KINDS: readonly GitObservationKind[] = ["files", "changes", "diff", "file"];

/**
 * The words an observation may be refused under and retained as.
 *
 * Narrower than the component vocabulary on purpose: an invalid invocation and
 * a paired form are decided before a provider is reached, so no observation
 * happened and there is nothing to write down.
 */
const RETAINABLE: readonly GitObservationReason[] = [
  "invalid-revision",
  "absent-path",
  "nontext-blob",
  "unusable-repository",
  "stale-continuation",
];

/** Where one observation ran, as the entry authenticated it. */
export interface ReplObservationPlace {
  /** All six members of the authenticated Repository identity. */
  readonly repository: RepositoryIdentity;
  /** The checkout root the authenticated selection named. */
  readonly selectionCheckout: string;
  /** That selection's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The working directory exactly as it was received, uncanonicalized. */
  readonly workingDirectory: string;
}

/** What one observation asked for, as the record names it. */
export interface ReplObservationRequest extends ReplObservationPlace {
  readonly query: GitObservationRequest;
}

/** The checkout the route reached, as the provider resolved it. */
export interface ReplObservationCheckout {
  readonly root: string;
  readonly commonDirectory: string;
  readonly repositoryName: string;
  /** The Worktree's name, or `null` for a repository's own checkout. */
  readonly worktreeName: string | null;
}

/** One completed observation, as a continuation reads it back. */
export interface ReplObservationRecord {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  readonly operation: GitObservationKind;
  /** The digest of the version, the kind and the normalized request. */
  readonly fingerprint: string;
  readonly request: ReplObservationRequest;
  readonly checkout: ReplObservationCheckout;
  /** The page it answered with, or the refusal it answered with. */
  readonly outcome: Result<GitObservationValue>;
}

/**
 * A refused observation, as the record carries it.
 *
 * The failure side of the internal `Result`, and never what a document sees:
 * the adapter rebuilds the ordinary `GitObservationError` by the same route on
 * a live refusal and on a replayed one, so the two cannot diverge.
 */
export class ReplObservationRefusal extends Error {
  override name = "ReplObservationRefusal";

  readonly element: string;
  readonly reason: GitObservationReason;

  constructor(element: string, reason: GitObservationReason, sentence: string) {
    super(sentence);
    this.element = element;
    this.reason = reason;
  }
}

/** The stable name one observation's record is journaled under. */
export function replObservationRecordName(record: {
  readonly operation: GitObservationKind;
  readonly fingerprint: string;
}): string {
  return canonicalJson([
    RECORD_PREFIX,
    "observation",
    REPL_REPOSITORY_VERSION,
    record.operation,
    record.fingerprint,
  ]);
}

/** The digest of everything one observation asks for. */
export function replObservationFingerprint(request: ReplObservationRequest): Operation<string> {
  return digest({
    version: REPL_REPOSITORY_VERSION,
    operation: request.query.kind,
    request: requestJson(request),
  });
}

/** The payload one completed observation is journaled with. */
export function replObservationRecordJson(input: {
  readonly fingerprint: string;
  readonly request: ReplObservationRequest;
  readonly checkout: ReplObservationCheckout;
  readonly outcome: Result<GitObservationValue>;
}): Json {
  return {
    version: REPL_REPOSITORY_VERSION,
    operation: input.request.query.kind,
    fingerprint: input.fingerprint,
    request: requestJson(input.request),
    checkout: checkoutJson(input.checkout),
    outcome: outcomeJson(input.request.query.kind, input.outcome),
  };
}

/**
 * The observation this saved value describes, or `undefined`.
 *
 * Total, and exact about every member. A payload carrying anything this version
 * did not write describes something other than an observation this host made,
 * and answering a document from it would bind a page nobody read.
 */
export function parseReplObservationRecord(value: unknown): ReplObservationRecord | undefined {
  const read = members(value, [
    "version",
    "operation",
    "fingerprint",
    "request",
    "checkout",
    "outcome",
  ]);
  if (read === undefined || read["version"] !== REPL_REPOSITORY_VERSION) {
    return undefined;
  }
  const operation = parseReplObservationKind(read["operation"]);
  const fingerprint = sha256(read["fingerprint"]);
  if (operation === undefined || fingerprint === undefined) {
    return undefined;
  }
  const request = parseRequest(read["request"], operation);
  const checkout = parseCheckout(read["checkout"]);
  if (request === undefined || checkout === undefined) {
    return undefined;
  }
  const outcome = parseOutcome(read["outcome"], request.query);
  if (outcome === undefined) {
    return undefined;
  }
  return Object.freeze({
    version: REPL_REPOSITORY_VERSION,
    operation,
    fingerprint,
    request,
    checkout,
    outcome,
  });
}

/** The read kind this value names, or `undefined`. */
export function parseReplObservationKind(value: unknown): GitObservationKind | undefined {
  return OBSERVATION_KINDS.find((kind) => kind === value);
}

/**
 * The refusal data this error carries, or `undefined` when it carries none.
 *
 * What decides whether a failed observation may be written down at all: a
 * refusal in the closed vocabulary is an answer the document asked for, and
 * anything else describes a condition this host has no word for.
 */
export function replObservationRefusalOf(
  error: unknown,
): { readonly reason: GitObservationReason; readonly sentence: string } | undefined {
  // Both sides of the one round trip. A live read raises the component's own
  // `GitObservationError`; the record's failure side carries this module's
  // refusal; and the same classification has to be read out of either, because
  // the record is written from the first and read back as the second.
  if (!(error instanceof GitObservationError) && !(error instanceof ReplObservationRefusal)) {
    return undefined;
  }
  const reason = RETAINABLE.find((word) => word === error.reason);
  return reason === undefined ? undefined : { reason, sentence: error.message };
}

function requestJson(request: ReplObservationRequest): Json {
  return {
    repository: repositoryIdentityJson(request.repository),
    selectionCheckout: request.selectionCheckout,
    commonDirectory: request.commonDirectory,
    workingDirectory: request.workingDirectory,
    query: queryJson(request.query),
  };
}

function comparisonJson(comparison: GitComparisonRequest): Json {
  if (comparison.compare === "commits") {
    return { compare: "commits", base: comparison.base, head: comparison.head };
  }
  return { compare: comparison.compare };
}

/**
 * The query as the document asked it, with every optional member stated.
 *
 * Absence is written as `null` rather than omitted, because this is the value a
 * fingerprint is computed over: a record whose request omitted a member and one
 * whose request held `null` for it would otherwise be the same name for two
 * different questions.
 */
function queryJson(query: GitObservationRequest): Json {
  if (query.kind === "files") {
    return { kind: "files", prefix: query.prefix, limit: query.limit, cursor: query.cursor };
  }
  if (query.kind === "file") {
    return {
      kind: "file",
      commit: query.commit,
      path: query.path,
      offset: query.offset,
      limit: query.limit,
    };
  }
  const shared = {
    comparison: comparisonJson(query.comparison),
    paths: query.paths === null ? null : [...query.paths],
    limit: query.limit,
    cursor: query.cursor,
  };
  if (query.kind === "changes") {
    return { kind: "changes", ...shared };
  }
  return { kind: "diff", ...shared, offset: query.offset };
}

function checkoutJson(checkout: ReplObservationCheckout): Json {
  return {
    root: checkout.root,
    commonDirectory: checkout.commonDirectory,
    repositoryName: checkout.repositoryName,
    worktreeName: checkout.worktreeName,
  };
}

function outcomeJson(kind: GitObservationKind, outcome: Result<GitObservationValue>): Json {
  if (!outcome.ok) {
    const data = replObservationRefusalOf(outcome.error);
    if (data === undefined) {
      throw new TypeError("a retained Git observation refusal carries no closed classification");
    }
    return { ok: false, error: { reason: data.reason, sentence: data.sentence } };
  }
  return { ok: true, value: gitObservationValueJson(kind, outcome.value) };
}

const PLACE_MEMBERS = [
  "repository",
  "selectionCheckout",
  "commonDirectory",
  "workingDirectory",
  "query",
] as const;

function parseRequest(
  value: unknown,
  operation: GitObservationKind,
): ReplObservationRequest | undefined {
  const read = members(value, [...PLACE_MEMBERS]);
  if (read === undefined) {
    return undefined;
  }
  const repository = parseRepositoryIdentity(read["repository"]);
  const selectionCheckout = text(read["selectionCheckout"]);
  const commonDirectory = text(read["commonDirectory"]);
  const workingDirectory = text(read["workingDirectory"]);
  const query = parseQuery(read["query"], operation);
  if (
    repository === undefined ||
    selectionCheckout === undefined ||
    commonDirectory === undefined ||
    workingDirectory === undefined ||
    query === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    repository,
    selectionCheckout,
    commonDirectory,
    workingDirectory,
    query,
  });
}

function parseCheckout(value: unknown): ReplObservationCheckout | undefined {
  const read = members(value, ["root", "commonDirectory", "repositoryName", "worktreeName"]);
  if (read === undefined) {
    return undefined;
  }
  const root = text(read["root"]);
  const commonDirectory = text(read["commonDirectory"]);
  const repositoryName = text(read["repositoryName"]);
  const worktreeName = optionalText(read["worktreeName"]);
  if (
    root === undefined ||
    commonDirectory === undefined ||
    repositoryName === undefined ||
    worktreeName === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ root, commonDirectory, repositoryName, worktreeName });
}

function parseComparison(value: unknown): GitComparisonRequest | undefined {
  const live = members(value, ["compare"]);
  if (live !== undefined) {
    const mode = GIT_COMPARE_MODES.find((candidate) => candidate === live["compare"]);
    if (mode === undefined || mode === "commits") {
      return undefined;
    }
    return Object.freeze({ compare: mode });
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

function parseQuery(
  value: unknown,
  operation: GitObservationKind,
): GitObservationRequest | undefined {
  if (operation === "files") {
    const read = members(value, ["kind", "prefix", "limit", "cursor"]);
    if (read === undefined || read["kind"] !== "files") {
      return undefined;
    }
    const prefix = nullableText(read["prefix"]);
    const limit = positive(read["limit"]);
    const cursor = nullableText(read["cursor"]);
    if (prefix === undefined || limit === undefined || cursor === undefined) {
      return undefined;
    }
    return Object.freeze({ kind: "files" as const, prefix, limit, cursor });
  }
  if (operation === "file") {
    const read = members(value, ["kind", "commit", "path", "offset", "limit"]);
    if (read === undefined || read["kind"] !== "file") {
      return undefined;
    }
    const commit = text(read["commit"]);
    const path = text(read["path"]);
    const offset = count(read["offset"]);
    const limit = positive(read["limit"]);
    if (commit === undefined || path === undefined || offset === undefined || limit === undefined) {
      return undefined;
    }
    return Object.freeze({ kind: "file" as const, commit, path, offset, limit });
  }
  const own =
    operation === "changes"
      ? ["kind", "comparison", "paths", "limit", "cursor"]
      : ["kind", "comparison", "paths", "limit", "cursor", "offset"];
  const read = members(value, own);
  if (read === undefined || read["kind"] !== operation) {
    return undefined;
  }
  const comparison = parseComparison(read["comparison"]);
  const paths = nullablePaths(read["paths"]);
  const limit = positive(read["limit"]);
  const cursor = nullableText(read["cursor"]);
  if (
    comparison === undefined ||
    paths === undefined ||
    limit === undefined ||
    cursor === undefined
  ) {
    return undefined;
  }
  if (operation === "changes") {
    return Object.freeze({ kind: "changes" as const, comparison, paths, limit, cursor });
  }
  const offset = count(read["offset"]);
  return offset === undefined
    ? undefined
    : Object.freeze({ kind: "diff" as const, comparison, paths, offset, limit, cursor });
}

function parseOutcome(
  value: unknown,
  query: GitObservationRequest,
): Result<GitObservationValue> | undefined {
  const refused = members(value, ["ok", "error"]);
  if (refused !== undefined) {
    if (refused["ok"] !== false) {
      return undefined;
    }
    const data = members(refused["error"], ["reason", "sentence"]);
    if (data === undefined) {
      return undefined;
    }
    const reason = RETAINABLE.find((word) => word === data["reason"]);
    const sentence = text(data["sentence"]);
    if (reason === undefined || sentence === undefined) {
      return undefined;
    }
    return Err(new ReplObservationRefusal(elementOf(query.kind), reason, sentence));
  }
  const succeeded = members(value, ["ok", "value"]);
  if (succeeded === undefined || succeeded["ok"] !== true) {
    return undefined;
  }
  const page = parseGitObservationValue(succeeded["value"], query);
  return page === undefined ? undefined : Ok(page);
}

/** The component name one read kind is written and refused as. */
export function elementOf(kind: GitObservationKind): string {
  if (kind === "files") {
    return "<Git.Files>";
  }
  if (kind === "changes") {
    return "<Git.Changes>";
  }
  return kind === "diff" ? "<Git.Diff>" : "<Git.File>";
}

function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : text(value);
}

function nullablePaths(value: unknown): readonly string[] | null | undefined {
  if (value === null) {
    return null;
  }
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

function sha256(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate !== undefined && /^[0-9a-f]{64}$/.test(candidate) ? candidate : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  const parsed = count(value);
  return parsed === undefined || parsed < 1 ? undefined : parsed;
}

/**
 * The route one historical placement authorizes.
 *
 * Derived from the placement exactly as the live provider derives a registered
 * checkout from it, so what admission compares a record against is the same
 * relationship the runtime enforces — read out of history rather than out of
 * today's registry.
 */
export function observationRouteOf(placement: ReplPlacement): ReplObservationCheckout {
  return Object.freeze({
    root: placement.checkoutRoot,
    commonDirectory: placement.commonDirectory,
    repositoryName: placement.identity.name,
    worktreeName: placement.kind === "worktree" ? placement.displayName : null,
  });
}

/**
 * Whether one of these historical placements authorizes this recorded route.
 *
 * Every member, under the whole Repository identity the request names. A route
 * matching on a root while naming another repository, worktree or Git directory
 * is a route no placement in this history ever selected.
 */
export function routedByPlacement(
  placements: readonly ReplPlacement[],
  repository: RepositoryIdentity,
  checkout: ReplObservationCheckout,
): boolean {
  return placements.some((placement) => {
    if (!sameRepositoryIdentity(placement.identity, repository)) {
      return false;
    }
    const route = observationRouteOf(placement);
    return (
      route.root === checkout.root &&
      route.commonDirectory === checkout.commonDirectory &&
      route.repositoryName === checkout.repositoryName &&
      route.worktreeName === checkout.worktreeName
    );
  });
}

/**
 * Whether one of these historical placements is the selection this read named.
 *
 * The request carries the checkout the authenticated selection pointed at and
 * that selection's common Git directory. A record naming a selection no
 * placement in this history made describes a read this entry never routed.
 */
export function selectedByPlacement(
  placements: readonly ReplPlacement[],
  request: ReplObservationRequest,
): boolean {
  return placements.some(
    (placement) =>
      sameRepositoryIdentity(placement.identity, request.repository) &&
      placement.checkoutRoot === request.selectionCheckout &&
      placement.commonDirectory === request.commonDirectory,
  );
}
