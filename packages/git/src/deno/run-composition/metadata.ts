/**
 * The sidecar that says what a managed slot is, and what it was created from.
 *
 * A workflow run answers that question from its database. An ordinary run has
 * none, so the answer lives beside the checkout — and because it lives on a
 * filesystem several processes share, everything about it is defensive: the
 * shape is closed and versioned, every member is parsed, and the file is only
 * ever written by an exclusive temporary sibling plus an atomic rename, after
 * the checkout it describes is complete and verified.
 *
 * ## Paths are derived, never read back
 *
 * A slot's checkout path is a function of the root and the identity. It is
 * deliberately absent from the metadata: a path read out of a file somebody
 * could edit would be a path this provider then joined and followed, and the
 * whole point of digesting authored strings into slots is that no authored
 * string decides where anything is.
 *
 * ## What compatibility means
 *
 * Every member here is *creation* state: what was asked for, and what was true
 * the moment the checkout came into being. None of it is current state. HEAD,
 * the current branch, the index and the working tree are the mutable work the
 * checkout exists to preserve, and a reuse that required them to match creation
 * would refuse every checkout anybody had used.
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
