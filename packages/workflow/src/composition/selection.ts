/**
 * What a component may observe about the repository it is acting on.
 *
 * A `<Git.Commit>` has to know *something* about the checkout it commits in —
 * which repository it belongs to, which directory holds it, what its initial
 * branch was called. It must not know how that checkout came to exist. A
 * workflow run's checkout is a row in a database, restored from a retained
 * Workspace under a WorkflowRun the document must never be able to name; an
 * ordinary run's checkout is a directory on the caller's own filesystem, held
 * open by an advisory lock the provider owns. The components are the same
 * components either way, so what they observe is this: plain structural data,
 * carrying the portable facts and nothing else.
 *
 * ## A selection names a target; it grants nothing
 *
 * `selection` is an opaque string the installed provider minted and only that
 * provider can read. Every operation authenticates the selection it was handed
 * against private state before it touches Git or a service, so a selection that
 * was copied, replaced or reconstructed can misname a target and cause a
 * refusal — it cannot grant access to one. That is the same rule the retained
 * Repository context has always followed, restated for a value two profiles
 * share.
 *
 * The rest is what a document can already see. The name is the one it wrote or
 * the ambient repository's own; the identity is credential-free by
 * construction; the checkout path is a place a `<Dir>` may already be standing.
 * None of it is authority, so retaining it, rendering it or handing it to a
 * child costs nothing.
 */

import type { Json } from "@executablemd/durable-streams";
import { members, optionalText, text } from "./parse.ts";
import { parseObjectFormat, type GitObjectFormat, type RepositoryRecord } from "./records.ts";

/**
 * A repository named without publishing where it came from.
 *
 * The locator is present as a fingerprint alone, so a credential that slipped
 * into a URL is not repeated here, in retained Push JSON, or in the evidence a
 * `<PullRequest>` binds. Everything else is a fact about the repository itself:
 * the commit it was selected at, the branch it started on, and the algorithm it
 * names its objects with.
 */
export interface RepositoryIdentity {
  /** Workspace-local or ambient display name. */
  readonly name: string;
  /** Stable fingerprint of the admitted credential-free locator. */
  readonly locatorFingerprint: string;
  /** The base a caller supplied, or `null` when none was. */
  readonly requestedBase: string | null;
  /** The commit this repository's identity was pinned at. */
  readonly creationCommit: string;
  /** The initial branch — a Repository's primary, an ambient one's default. */
  readonly primaryBranch: string;
  readonly objectFormat: GitObjectFormat;
}

export const REPOSITORY_IDENTITY_MEMBERS = [
  "name",
  "locatorFingerprint",
  "requestedBase",
  "creationCommit",
  "primaryBranch",
  "objectFormat",
] as const;

/**
 * One repository selected for one component invocation.
 *
 * Immutable and comparable. Two selections of the same target in one execution
 * carry the same `selection`, which is what lets a provider recognize the lease
 * it is already holding rather than acquiring a second one.
 */
export interface RepositorySelection {
  /**
   * The installed provider's own opaque name for this selection.
   *
   * Meaningful only to the provider that minted it, and never derived from
   * anything a document wrote. A provider that does not recognize one refuses.
   */
  readonly selection: string;
  /** What a document named this repository, or the ambient one's display name. */
  readonly name: string;
  /** The credential-free identity every operation and every record carries. */
  readonly identity: RepositoryIdentity;
  /** The checkout this selection points at, as the host resolves paths. */
  readonly checkoutPath: string;
}

const SELECTION_MEMBERS = ["selection", "name", "identity", "checkoutPath"] as const;

/** The retained record, filtered to the identity a selection carries. */
export function filteredRepositoryIdentity(record: RepositoryRecord): RepositoryIdentity {
  return Object.freeze({
    name: record.name,
    locatorFingerprint: record.locatorFingerprint,
    requestedBase: record.requestedBase,
    creationCommit: record.creationCommit,
    primaryBranch: record.primaryBranch,
    objectFormat: record.objectFormat,
  });
}

export function repositoryIdentityJson(identity: RepositoryIdentity): Json {
  return {
    name: identity.name,
    locatorFingerprint: identity.locatorFingerprint,
    requestedBase: identity.requestedBase,
    creationCommit: identity.creationCommit,
    primaryBranch: identity.primaryBranch,
    objectFormat: identity.objectFormat,
  };
}

/** The identity this value describes, or `undefined` when it describes none. */
export function parseRepositoryIdentity(value: unknown): RepositoryIdentity | undefined {
  const record = members(value, REPOSITORY_IDENTITY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const name = text(record.name);
  const locatorFingerprint = text(record.locatorFingerprint);
  const requestedBase = optionalText(record.requestedBase);
  const creationCommit = text(record.creationCommit);
  const primaryBranch = text(record.primaryBranch);
  const objectFormat = parseObjectFormat(record.objectFormat);
  if (
    name === undefined ||
    locatorFingerprint === undefined ||
    !/^[0-9a-f]{64}$/.test(locatorFingerprint) ||
    requestedBase === undefined ||
    creationCommit === undefined ||
    primaryBranch === undefined ||
    objectFormat === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    name,
    locatorFingerprint,
    requestedBase,
    creationCommit,
    primaryBranch,
    objectFormat,
  });
}

/** Whether two identities name the same repository. */
export function sameRepositoryIdentity(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  return REPOSITORY_IDENTITY_MEMBERS.every((member) => left[member] === right[member]);
}

/**
 * The selection this value describes, or `undefined` when it describes none.
 *
 * Total, and exact about membership, for the reason every parser in this
 * package is: a selection may arrive from a caller reaching the Api directly,
 * and a value carrying more or fewer members than the contract declares
 * describes something other than a selection.
 */
export function parseRepositorySelection(value: unknown): RepositorySelection | undefined {
  const record = members(value, SELECTION_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const selection = text(record.selection);
  const name = text(record.name);
  const identity = parseRepositoryIdentity(record.identity);
  const checkoutPath = text(record.checkoutPath);
  if (
    selection === undefined ||
    name === undefined ||
    identity === undefined ||
    checkoutPath === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ selection, name, identity, checkoutPath });
}

/** The selection a provider hands back, frozen so a holder cannot edit one. */
export function repositorySelection(
  selection: string,
  name: string,
  identity: RepositoryIdentity,
  checkoutPath: string,
): RepositorySelection {
  return Object.freeze({ selection, name, identity: Object.freeze(identity), checkoutPath });
}
