/**
 * Retain managed-slot creation identity in a closed, versioned sidecar.
 * Every member is parsed. Publication uses an exclusive temporary sibling and an
 * atomic rename only after the checkout is complete and verified.
 *
 * Checkout paths are derived from the host root and identity, never read from this
 * editable metadata. Members describe creation, not current HEAD, branch, index or
 * working-tree state; reuse must preserve work done since creation.
 */

import { members, optionalText, text } from "../../composition/parse.ts";
import { parseObjectFormat, type GitObjectFormat } from "../../composition/records.ts";

/** The one shape this version writes and the only one it reads. */
export const METADATA_VERSION = 1;

export interface ManagedRepositoryMetadata {
  readonly kind: "repository";
  readonly version: typeof METADATA_VERSION;
  readonly name: string;
  /** The admitted, credential-free locator this checkout was cloned from. */
  readonly locator: string;
  readonly locatorFingerprint: string;
  readonly requestedBase: string | null;
  readonly creationCommit: string;
  readonly primaryBranch: string;
  readonly objectFormat: GitObjectFormat;
  /** The canonical common Git directory this checkout's own worktrees key on. */
  readonly commonDirectory: string;
}

export interface ManagedWorktreeMetadata {
  readonly kind: "worktree";
  readonly version: typeof METADATA_VERSION;
  /** The canonical common Git directory of the repository this belongs to. */
  readonly owner: string;
  readonly name: string;
  readonly requestedBranch: string;
  readonly requestedBase: string | null;
  readonly creationCommit: string;
  readonly objectFormat: GitObjectFormat;
}

export type ManagedMetadata = ManagedRepositoryMetadata | ManagedWorktreeMetadata;

const REPOSITORY_MEMBERS = [
  "kind",
  "version",
  "name",
  "locator",
  "locatorFingerprint",
  "requestedBase",
  "creationCommit",
  "primaryBranch",
  "objectFormat",
  "commonDirectory",
] as const;

const WORKTREE_MEMBERS = [
  "kind",
  "version",
  "owner",
  "name",
  "requestedBranch",
  "requestedBase",
  "creationCommit",
  "objectFormat",
] as const;

/** The repository sidecar this value describes, or `undefined` when it is none. */
export function parseRepositoryMetadata(value: unknown): ManagedRepositoryMetadata | undefined {
  const record = members(value, REPOSITORY_MEMBERS);
  if (record === undefined || record.kind !== "repository" || record.version !== METADATA_VERSION) {
    return undefined;
  }
  const name = text(record.name);
  const locator = text(record.locator);
  const locatorFingerprint = text(record.locatorFingerprint);
  const requestedBase = optionalText(record.requestedBase);
  const creationCommit = text(record.creationCommit);
  const primaryBranch = text(record.primaryBranch);
  const objectFormat = parseObjectFormat(record.objectFormat);
  const commonDirectory = text(record.commonDirectory);
  if (
    name === undefined ||
    locator === undefined ||
    locatorFingerprint === undefined ||
    !/^[0-9a-f]{64}$/.test(locatorFingerprint) ||
    requestedBase === undefined ||
    creationCommit === undefined ||
    primaryBranch === undefined ||
    objectFormat === undefined ||
    commonDirectory === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "repository" as const,
    version: METADATA_VERSION,
    name,
    locator,
    locatorFingerprint,
    requestedBase,
    creationCommit,
    primaryBranch,
    objectFormat,
    commonDirectory,
  });
}

/** The worktree sidecar this value describes, or `undefined` when it is none. */
export function parseWorktreeMetadata(value: unknown): ManagedWorktreeMetadata | undefined {
  const record = members(value, WORKTREE_MEMBERS);
  if (record === undefined || record.kind !== "worktree" || record.version !== METADATA_VERSION) {
    return undefined;
  }
  const owner = text(record.owner);
  const name = text(record.name);
  const requestedBranch = text(record.requestedBranch);
  const requestedBase = optionalText(record.requestedBase);
  const creationCommit = text(record.creationCommit);
  const objectFormat = parseObjectFormat(record.objectFormat);
  if (
    owner === undefined ||
    name === undefined ||
    requestedBranch === undefined ||
    requestedBase === undefined ||
    creationCommit === undefined ||
    objectFormat === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "worktree" as const,
    version: METADATA_VERSION,
    owner,
    name,
    requestedBranch,
    requestedBase,
    creationCommit,
    objectFormat,
  });
}

/** The bytes one sidecar is written as. Member order is an implementation detail. */
export function metadataBytes(metadata: ManagedMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}
