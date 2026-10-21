/**
 * What one REPL entry's Repository and Worktree selections look like on the
 * wire.
 *
 * An entry that writes `<Repository name="project" url={..}>` selects a managed
 * checkout: a directory under the host's repository root, created once and
 * reused afterwards. Reopen the entry and that selection answers again from
 * what it recorded — the paths the checkout was found at, the identity it was
 * pinned with — without asking a selector anything, cloning, adding a worktree,
 * reading a sidecar, opening a credential or taking a lock. The checkout may
 * have been edited or removed since; a completed selection says where this
 * entry was working, which says nothing about what is there now.
 *
 * Three kinds are recorded. A **repository** selection names a managed clone, a
 * **worktree** selection names a linked checkout of one, and an
 * **ambient owner** records the Repository a root-level `<Worktree>` belongs
 * to — the checkout the person opened the session in, which a Worktree written
 * outside a lexical `<Repository>` is a worktree *of*.
 *
 * ## Identity is the request, and position is the journal's
 *
 * A record's name is the digest of the record version, the kind and the
 * normalized request. Two selections asking for exactly the same thing produce
 * the same name, and that is allowed: telling two of them apart is the durable
 * engine's own positional matching. Nothing here searches history by name, and
 * a repeated name is valid.
 *
 * The request carries what was asked for and nothing more. A Repository's
 * locator appears as its fingerprint alone, because the locator is already
 * admitted and handed to Git by the time this names it and a second copy in the
 * journal would publish a url the identity deliberately does not. A Worktree's
 * request carries its owner's repository identity, common directory and owner
 * checkout — the stable facts that say which repository this is a worktree of,
 * rather than the fresh opaque selection the provider minted for it, which
 * names nothing after the entry ends.
 *
 * ## What a result may carry
 *
 * Routing and identity: where the checkout is, which Git directory it belongs
 * to, the credential-free repository identity, the display name a document
 * sees, and the owner checkout a later Worktree would run `worktree add` in. An
 * ambient owner carries the same facts without a managed root, because nothing
 * placed it.
 *
 * Nothing else. No origin, no publication evidence, no object source, no Git
 * session, no authentication, no lock, no handle, and no opaque selection
 * identifier. A later delivery that needs one of those retains it then.
 *
 * A refusal carries the closed classification the ordinary selector refused
 * under and the fixed sentence it refused with, so a continuation reconstructs
 * the same failure the live call produced. A native exception, a stack, a
 * `stderr` line and a credential are none of those and reach no record: an
 * unrecognized condition is infrastructure, and publishing it as something the
 * document asked for is exactly what must not happen.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, optionalText, text } from "@executablemd/git";
import { parseRepositoryIdentity, repositoryIdentityJson } from "@executablemd/git";
import { type RepositoryIdentity } from "@executablemd/git";
import type { RepositoryFailureReason, WorktreeFailureReason } from "@executablemd/git";
import { digest, RECORD_PREFIX, REPL_REPOSITORY_VERSION } from "./records.ts";

/** The durable type one completed Repository or Worktree selection is journaled under. */
export const REPL_REPOSITORY_PLACEMENT = "repl_repository_placement";

/** Which selection a placement record describes. */
export type ReplPlacementKind = "repository" | "worktree" | "ambient-owner";

const PLACEMENT_KINDS: readonly ReplPlacementKind[] = ["repository", "worktree", "ambient-owner"];

/**
 * What a `<Repository>` selection asked for.
 *
 * The locator by fingerprint, because the bytes themselves are the one fact an
 * identity never publishes. The base as the caller wrote it or `null`, because
 * "no base" and "this base" select differently and a reuse compares them.
 */
export interface ReplRepositoryRequest {
  readonly kind: "repository";
  readonly name: string;
  readonly locatorFingerprint: string;
  readonly base: string | null;
}

/**
 * What a `<Worktree>` selection asked for, owner included.
 *
 * The owner is three stable facts rather than the selection the provider minted
 * for it: a fresh opaque identifier names nothing once the entry that minted it
 * is gone, and a durable name built from one would differ on every reopen of
 * the same question.
 */
export interface ReplWorktreeRequest {
  readonly kind: "worktree";
  readonly name: string;
  readonly branch: string;
  readonly base: string | null;
  /** The authenticated owner's credential-free repository identity. */
  readonly owner: RepositoryIdentity;
  /** The owner's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The owner checkout `worktree add` would run in. */
  readonly ownerCheckout: string;
}

/** What a root-level `<Worktree>` asked about the Repository it belongs to. */
export interface ReplAmbientOwnerRequest {
  readonly kind: "ambient-owner";
  /** The directory this invocation started in, which discovery starts from. */
  readonly cwd: string;
}

export type ReplPlacementRequest =
  | ReplRepositoryRequest
  | ReplWorktreeRequest
  | ReplAmbientOwnerRequest;

/**
 * Where one selected checkout is, and which repository it belongs to.
 *
 * Routing facts. Holding them is knowing where this entry was working; it is
 * not permission to work there and not evidence that anything is still on disk.
 */
export interface ReplPlacement {
  readonly kind: ReplPlacementKind;
  /**
   * The canonical managed root this placement was selected under.
   *
   * Absent for an ambient owner, which nothing placed: it is the checkout the
   * person was already standing in.
   */
  readonly managedRoot: string | undefined;
  /** The canonical root of the checkout this selection points at. */
  readonly checkoutRoot: string;
  /** The canonical common Git directory, which identifies the repository. */
  readonly commonDirectory: string;
  /** The credential-free identity every operation and record carries. */
  readonly identity: RepositoryIdentity;
  /** The name a document sees: the authored one, or an ambient checkout's own. */
  readonly displayName: string;
  /** A checkout of the owning repository, which is where `worktree add` runs. */
  readonly ownerCheckout: string;
}

/**
 * The closed classification one refused selection carries.
 *
 * Three vocabularies, each the one its own condition is already reported in. A
 * `repository` or `worktree` word is the composition vocabulary the components
 * speak, which is also what a native `GitRefusal` from a clone or a
 * `worktree add` is translated into before it is recorded. A `managed` word is
 * the managed-checkout vocabulary a shared host root adds.
 *
 * `in-use` is deliberately not one of the managed words. A slot another entry
 * holds is temporary contention, decided before the recorded selection begins,
 * and saving it would make a condition that lasts as long as somebody else's
 * work the permanent answer every later continuation replays.
 *
 * `no-repository-context` is likewise absent: there being no Repository in
 * scope is decided by `<Worktree>` before any selector is asked, so it cannot
 * arrive back through a record.
 */
export type ReplPlacementRefusalData =
  | {
      readonly vocabulary: "repository";
      readonly reason: RepositoryFailureReason;
      readonly sentence: string;
    }
  | {
      readonly vocabulary: "worktree";
      readonly reason: WorktreeFailureReason;
      readonly sentence: string;
    }
  | {
      readonly vocabulary: "managed";
      readonly reason: ReplManagedRefusalReason;
      readonly sentence: string;
    };

/**
 * The managed-checkout words a completed selection may carry.
 *
 * A subset of the provider's own vocabulary, named here because which words a
 * durable format carries is part of that format. The adapter that writes and
 * rebuilds them is where the compiler holds the two in agreement.
 */
export type ReplManagedRefusalReason =
  | "incompatible-reuse"
  | "partial-creation"
  | "unusable-checkout";

const REPOSITORY_REFUSALS: readonly RepositoryFailureReason[] = [
  "invalid-locator",
  "authentication-unavailable",
  "unresolved-base",
  "missing-remote-default",
  "incompatible-reuse",
  "unusable-repository",
];

const WORKTREE_REFUSALS: readonly WorktreeFailureReason[] = [
  "unresolved-base",
  "branch-checked-out-elsewhere",
  "incompatible-reuse",
  "unusable-repository",
];

const MANAGED_REFUSALS: readonly ReplManagedRefusalReason[] = [
  "incompatible-reuse",
  "partial-creation",
  "unusable-checkout",
];

/**
 * A refused selection, as the record carries it.
 *
 * The failure side of the internal `Result`, and never what a component sees:
 * the adapter turns this into the ordinary error its own vocabulary names, by
 * the same route on a live refusal and on a replayed one, so the two cannot
 * diverge.
 */
export class ReplPlacementRefusal extends Error {
  override name = "ReplPlacementRefusal";

  readonly refusal: ReplPlacementRefusalData;

  constructor(refusal: ReplPlacementRefusalData) {
    super(refusal.sentence);
    this.refusal = refusal;
  }
}

/** One completed selection, as a continuation reads it back. */
export interface ReplPlacementRecord {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  readonly kind: ReplPlacementKind;
  /** The digest of the version, the kind and the normalized request. */
  readonly fingerprint: string;
  readonly request: ReplPlacementRequest;
  /** The placement it selected, or the refusal it answered with. */
  readonly outcome: Result<ReplPlacement>;
}

/** The stable name one placement record is journaled under. */
export function replPlacementRecordName(record: {
  readonly kind: ReplPlacementKind;
  readonly fingerprint: string;
}): string {
  return canonicalJson([
    RECORD_PREFIX,
    "placement",
    REPL_REPOSITORY_VERSION,
    record.kind,
    record.fingerprint,
  ]);
}

/** The digest of everything one selection asks for. */
export function replPlacementFingerprint(request: ReplPlacementRequest): Operation<string> {
  return digest({
    version: REPL_REPOSITORY_VERSION,
    kind: request.kind,
    request: requestJson(request),
  });
}

/** The payload one completed selection is journaled with. */
export function replPlacementRecordJson(input: {
  readonly fingerprint: string;
  readonly request: ReplPlacementRequest;
  readonly outcome: Result<ReplPlacement>;
}): Json {
  const stated = {
    version: REPL_REPOSITORY_VERSION,
    kind: input.request.kind,
    fingerprint: input.fingerprint,
    request: requestJson(input.request),
  };
  if (input.outcome.ok) {
    return { ...stated, placement: placementJson(input.outcome.value) };
  }
  return { ...stated, refusal: refusalJson(refusalData(input.outcome.error)) };
}

/**
 * The selection this saved value describes, or `undefined`.
 *
 * Total, and exact about its members. A payload carrying anything this version
 * did not write describes something other than a selection this host made, and
 * answering a document from it would bind a path nobody selected.
 */
export function parseReplPlacementRecord(value: unknown): ReplPlacementRecord | undefined {
  const refused = members(value, ["version", "kind", "fingerprint", "request", "refusal"]);
  const selected =
    refused === undefined
      ? members(value, ["version", "kind", "fingerprint", "request", "placement"])
      : undefined;
  const read = refused ?? selected;
  if (read === undefined || read["version"] !== REPL_REPOSITORY_VERSION) {
    return undefined;
  }
  const kind = parseReplPlacementKind(read["kind"]);
  const fingerprint = text(read["fingerprint"]);
  if (kind === undefined || fingerprint === undefined) {
    return undefined;
  }
  const request = parseRequest(read["request"], kind);
  if (request === undefined) {
    return undefined;
  }
  const outcome =
    refused === undefined ? parsePlacement(read["placement"], kind) : parseRefusal(read["refusal"]);
  if (outcome === undefined) {
    return undefined;
  }
  return Object.freeze({ version: REPL_REPOSITORY_VERSION, kind, fingerprint, request, outcome });
}

/** The selection kind this value names, or `undefined`. */
export function parseReplPlacementKind(value: unknown): ReplPlacementKind | undefined {
  return PLACEMENT_KINDS.find((kind) => kind === value);
}

/**
 * The refusal data this error carries, or `undefined` when it carries none.
 *
 * What decides whether a failed selection may be written down at all: a
 * classified refusal is an answer the document asked for, and anything else is
 * a condition this host has no word for.
 */
export function replPlacementRefusalOf(error: unknown): ReplPlacementRefusalData | undefined {
  return error instanceof ReplPlacementRefusal ? error.refusal : undefined;
}

function refusalData(error: Error): ReplPlacementRefusalData {
  const data = replPlacementRefusalOf(error);
  if (data === undefined) {
    throw new TypeError("a retained placement refusal carries no closed classification");
  }
  return data;
}

function requestJson(request: ReplPlacementRequest): Json {
  if (request.kind === "repository") {
    return {
      name: request.name,
      locatorFingerprint: request.locatorFingerprint,
      base: request.base,
    };
  }
  if (request.kind === "worktree") {
    return {
      name: request.name,
      branch: request.branch,
      base: request.base,
      owner: repositoryIdentityJson(request.owner),
      commonDirectory: request.commonDirectory,
      ownerCheckout: request.ownerCheckout,
    };
  }
  return { cwd: request.cwd };
}

function placementJson(placement: ReplPlacement): Json {
  return {
    managedRoot: placement.managedRoot ?? null,
    checkoutRoot: placement.checkoutRoot,
    commonDirectory: placement.commonDirectory,
    identity: repositoryIdentityJson(placement.identity),
    displayName: placement.displayName,
    ownerCheckout: placement.ownerCheckout,
  };
}

function refusalJson(refusal: ReplPlacementRefusalData): Json {
  return {
    vocabulary: refusal.vocabulary,
    reason: refusal.reason,
    sentence: refusal.sentence,
  };
}

function parseRequest(value: unknown, kind: ReplPlacementKind): ReplPlacementRequest | undefined {
  if (kind === "repository") {
    return parseRepositoryRequest(value);
  }
  if (kind === "worktree") {
    return parseWorktreeRequest(value);
  }
  const read = members(value, ["cwd"]);
  const cwd = read === undefined ? undefined : text(read["cwd"]);
  return cwd === undefined ? undefined : Object.freeze({ kind: "ambient-owner" as const, cwd });
}

function parseRepositoryRequest(value: unknown): ReplRepositoryRequest | undefined {
  const read = members(value, ["name", "locatorFingerprint", "base"]);
  if (read === undefined) {
    return undefined;
  }
  const name = text(read["name"]);
  const locatorFingerprint = text(read["locatorFingerprint"]);
  const base = optionalText(read["base"]);
  if (
    name === undefined ||
    locatorFingerprint === undefined ||
    !/^[0-9a-f]{64}$/.test(locatorFingerprint) ||
    base === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ kind: "repository" as const, name, locatorFingerprint, base });
}

function parseWorktreeRequest(value: unknown): ReplWorktreeRequest | undefined {
  const read = members(value, [
    "name",
    "branch",
    "base",
    "owner",
    "commonDirectory",
    "ownerCheckout",
  ]);
  if (read === undefined) {
    return undefined;
  }
  const name = text(read["name"]);
  const branch = text(read["branch"]);
  const base = optionalText(read["base"]);
  const owner = parseRepositoryIdentity(read["owner"]);
  const commonDirectory = text(read["commonDirectory"]);
  const ownerCheckout = text(read["ownerCheckout"]);
  if (
    name === undefined ||
    branch === undefined ||
    base === undefined ||
    owner === undefined ||
    commonDirectory === undefined ||
    ownerCheckout === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "worktree" as const,
    name,
    branch,
    base,
    owner,
    commonDirectory,
    ownerCheckout,
  });
}

/**
 * The placement a saved success describes, or `undefined`.
 *
 * A managed root is required of exactly the two kinds a managed root places,
 * and refused for the ambient owner: a record stating one for a checkout
 * nothing placed, or omitting one for a checkout something did, disagrees with
 * the kind it is named under.
 *
 * Absence is exactly `null`, and nothing else is read as it. A value that is
 * present and is not a managed root — a number, an object, the empty string —
 * is a record this version did not write, not a record that carried no root:
 * reading the two as one answer would admit a malformed ambient placement and
 * bind a path from it.
 */
function parsePlacement(
  value: unknown,
  kind: ReplPlacementKind,
): Result<ReplPlacement> | undefined {
  const read = members(value, [
    "managedRoot",
    "checkoutRoot",
    "commonDirectory",
    "identity",
    "displayName",
    "ownerCheckout",
  ]);
  if (read === undefined) {
    return undefined;
  }
  const stated = read["managedRoot"];
  if (stated !== null && text(stated) === undefined) {
    return undefined;
  }
  const managedRoot = stated === null ? undefined : text(stated);
  if ((kind === "ambient-owner") !== (managedRoot === undefined)) {
    return undefined;
  }
  const checkoutRoot = text(read["checkoutRoot"]);
  const commonDirectory = text(read["commonDirectory"]);
  const identity = parseRepositoryIdentity(read["identity"]);
  const displayName = text(read["displayName"]);
  const ownerCheckout = text(read["ownerCheckout"]);
  if (
    checkoutRoot === undefined ||
    commonDirectory === undefined ||
    identity === undefined ||
    displayName === undefined ||
    ownerCheckout === undefined
  ) {
    return undefined;
  }
  return Ok(
    Object.freeze({
      kind,
      managedRoot,
      checkoutRoot,
      commonDirectory,
      identity,
      displayName,
      ownerCheckout,
    }),
  );
}

function parseRefusal(value: unknown): Result<never> | undefined {
  const read = members(value, ["vocabulary", "reason", "sentence"]);
  if (read === undefined) {
    return undefined;
  }
  const sentence = text(read["sentence"]);
  const stated = read["reason"];
  if (sentence === undefined) {
    return undefined;
  }
  if (read["vocabulary"] === "repository") {
    const reason = REPOSITORY_REFUSALS.find((word) => word === stated);
    return reason === undefined
      ? undefined
      : Err(new ReplPlacementRefusal({ vocabulary: "repository", reason, sentence }));
  }
  if (read["vocabulary"] === "worktree") {
    const reason = WORKTREE_REFUSALS.find((word) => word === stated);
    return reason === undefined
      ? undefined
      : Err(new ReplPlacementRefusal({ vocabulary: "worktree", reason, sentence }));
  }
  if (read["vocabulary"] !== "managed") {
    return undefined;
  }
  const reason = MANAGED_REFUSALS.find((word) => word === stated);
  return reason === undefined
    ? undefined
    : Err(new ReplPlacementRefusal({ vocabulary: "managed", reason, sentence }));
}
