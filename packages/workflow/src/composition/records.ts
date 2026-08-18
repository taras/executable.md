/**
 * The immutable creation identity every Repository and Worktree carries.
 *
 * These records are what the workflow database retains and what the journal
 * holds. They are written once on creation and never rewritten: mutable HEAD,
 * refs, index, checkout and linked-worktree state live inside the selected
 * Workspace root instead, so a later history fork keeps one authoritative
 * frontier per Repository/Worktree identity rather than consulting an
 * unversioned "current commit" column.
 *
 * A record names no locator and no host path. The locator a caller supplied is
 * retained beside the record, where compatibility is decided; what travels
 * through the journal and back to a document is its fingerprint. A fingerprint
 * discriminates a changed locator without publishing the bytes of one, which is
 * what keeps a credential that slipped into a URL out of retained history even
 * before the journal's own filter sees it.
 *
 * Every value here is parsed on the way back in. A replayed record arrives as
 * whatever the journal holds, so `parseRepositoryRecord` is what decides it is
 * a record at all.
 */

import type { Json } from "@executablemd/durable-streams";
import { members, optionalText, text } from "./parse.ts";

export type GitObjectFormat = "sha1" | "sha256";

/** What a Repository's creation identity holds. */
export interface RepositoryRecord {
  /** Workspace-local identity. */
  readonly name: string;
  /** Stable fingerprint of the admitted credential-free locator. */
  readonly locatorFingerprint: string;
  /** The base a caller supplied, or `null` when the remote default was used. */
  readonly requestedBase: string | null;
  /** The commit pinned once at creation. */
  readonly creationCommit: string;
  /** The named branch the primary checkout was created on. */
  readonly primaryBranch: string;
  /** The object format the repository names its objects with. */
  readonly objectFormat: GitObjectFormat;
  /** Stable Workspace-relative checkout path. */
  readonly checkoutPath: string;
}

/** What a Worktree's creation identity holds. */
export interface WorktreeRecord {
  readonly repositoryName: string;
  /** Repository-local identity. */
  readonly name: string;
  readonly requestedBranch: string;
  readonly requestedBase: string | null;
  readonly creationCommit: string;
  readonly checkoutPath: string;
}

/**
 * What a Repository component invocation asks the provider to install.
 *
 * Parsed at the component boundary from the caller's props and expressions. The
 * provider receives only the bytes it acts on; the locator is still raw here,
 * because admitting it is the provider's job and refusing an unusable one is
 * one of the answers it gives.
 */
export interface RepositoryCreationRequest {
  readonly name: string;
  readonly locator: string;
  readonly base: string | undefined;
}

/**
 * What a Worktree component invocation asks the provider to install.
 *
 * The Repository name comes from the enclosing lexical context rather than from
 * props: a Worktree exists inside a Repository, and letting a document write
 * the name would let it name a Repository that is not in scope.
 */
export interface WorktreeCreationRequest {
  readonly repositoryName: string;
  readonly name: string;
  readonly branch: string;
  readonly base: string | undefined;
}

const REPOSITORY_MEMBERS = [
  "name",
  "locatorFingerprint",
  "requestedBase",
  "creationCommit",
  "primaryBranch",
  "objectFormat",
  "checkoutPath",
] as const;

const WORKTREE_MEMBERS = [
  "repositoryName",
  "name",
  "requestedBranch",
  "requestedBase",
  "creationCommit",
  "checkoutPath",
] as const;

export function parseObjectFormat(value: unknown): GitObjectFormat | undefined {
  return value === "sha1" || value === "sha256" ? value : undefined;
}

/** A 64-character lowercase hex digest, or `undefined` when it is not one. */
export function parseFingerprint(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate !== undefined && /^[0-9a-f]{64}$/.test(candidate) ? candidate : undefined;
}

/** A Workspace-relative path, which is absolute within the Workspace. */
export function parseCheckoutPath(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate !== undefined && candidate.startsWith("/") ? candidate : undefined;
}

/**
 * The Repository record this value describes, or `undefined` when it is none.
 *
 * Total, and exact about membership: a value carrying more or fewer members
 * than the record declares describes something other than a record, and reading
 * it as one would silently accept a shape a later version wrote.
 */
export function parseRepositoryRecord(value: unknown): RepositoryRecord | undefined {
  const record = members(value, REPOSITORY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const name = text(record.name);
  const locatorFingerprint = parseFingerprint(record.locatorFingerprint);
  const requestedBase = optionalText(record.requestedBase);
  const creationCommit = text(record.creationCommit);
  const primaryBranch = text(record.primaryBranch);
  const objectFormat = parseObjectFormat(record.objectFormat);
  const checkoutPath = parseCheckoutPath(record.checkoutPath);
  if (
    name === undefined ||
    locatorFingerprint === undefined ||
    requestedBase === undefined ||
    creationCommit === undefined ||
    primaryBranch === undefined ||
    objectFormat === undefined ||
    checkoutPath === undefined
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
    checkoutPath,
  });
}

/** The Worktree record this value describes, or `undefined` when it is none. */
export function parseWorktreeRecord(value: unknown): WorktreeRecord | undefined {
  const record = members(value, WORKTREE_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repositoryName = text(record.repositoryName);
  const name = text(record.name);
  const requestedBranch = text(record.requestedBranch);
  const requestedBase = optionalText(record.requestedBase);
  const creationCommit = text(record.creationCommit);
  const checkoutPath = parseCheckoutPath(record.checkoutPath);
  if (
    repositoryName === undefined ||
    name === undefined ||
    requestedBranch === undefined ||
    requestedBase === undefined ||
    creationCommit === undefined ||
    checkoutPath === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    repositoryName,
    name,
    requestedBranch,
    requestedBase,
    creationCommit,
    checkoutPath,
  });
}

export function repositoryRecordJson(record: RepositoryRecord): Json {
  return {
    name: record.name,
    locatorFingerprint: record.locatorFingerprint,
    requestedBase: record.requestedBase,
    creationCommit: record.creationCommit,
    primaryBranch: record.primaryBranch,
    objectFormat: record.objectFormat,
    checkoutPath: record.checkoutPath,
  };
}

export function worktreeRecordJson(record: WorktreeRecord): Json {
  return {
    repositoryName: record.repositoryName,
    name: record.name,
    requestedBranch: record.requestedBranch,
    requestedBase: record.requestedBase,
    creationCommit: record.creationCommit,
    checkoutPath: record.checkoutPath,
  };
}

/** Whether two Repository records describe the same creation identity. */
export function sameRepositoryRecord(left: RepositoryRecord, right: RepositoryRecord): boolean {
  return REPOSITORY_MEMBERS.every((member) => left[member] === right[member]);
}

/** Whether two Worktree records describe the same creation identity. */
export function sameWorktreeRecord(left: WorktreeRecord, right: WorktreeRecord): boolean {
  return WORKTREE_MEMBERS.every((member) => left[member] === right[member]);
}
