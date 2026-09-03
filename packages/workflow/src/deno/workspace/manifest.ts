import { createHash } from "node:crypto";
import { WorkflowDatabaseCorruptError } from "../../storage/errors.ts";
import {
  hasUnpairedSurrogate,
  parseWorkspaceRootManifest,
  SHA256,
  validateCanonicalWorkspacePath,
  validateWorkspaceRootEntries,
  WORKSPACE_ROOT_DOMAIN,
  WORKSPACE_ROOT_FORMAT,
  type WorkspaceRejection,
  type WorkspaceRootEntry,
  type WorkspaceRootManifest,
} from "../../workspace/root-manifest.ts";

export {
  compareUtf8,
  hasUnpairedSurrogate,
  parentFirst,
  parentPath,
  WORKSPACE_ROOT_DOMAIN,
  WORKSPACE_ROOT_FORMAT,
} from "../../workspace/root-manifest.ts";
export type {
  WorkspaceRejection,
  WorkspaceRootEntry,
  WorkspaceRootManifest,
} from "../../workspace/root-manifest.ts";

/**
 * How a caller other than a live run reports a Workspace root it cannot accept.
 *
 * The default names the run database the root was read from, which is what
 * every live caller is holding. A sealed XMD artifact is not a run database and
 * says so in its own words, so it supplies one of these rather than borrowing a
 * sentence that would tell an operator to restore a run from a backup.
 */
function rejecting(databasePath: string): WorkspaceRejection {
  return (reason: string) => corrupt(databasePath, reason);
}

export interface StoredWorkspaceRoot {
  readonly rootId: string;
  readonly manifest: string;
  readonly manifestHashes: readonly string[];
  readonly blobHashes: readonly string[];
}

export const EMPTY_WORKSPACE_MANIFEST =
  '{"format":1,"entries":[{"path":"/","kind":"directory","mode":493,"mtime":0}]}';

export const EMPTY_WORKSPACE_ROOT = workspaceRoot(EMPTY_WORKSPACE_MANIFEST, [], []);
export const EMPTY_WORKSPACE_ROOT_ID = EMPTY_WORKSPACE_ROOT.rootId;

export function workspaceRoot(
  manifest: string,
  manifestHashes: readonly string[],
  blobHashes: readonly string[],
): StoredWorkspaceRoot {
  const hash = createHash("sha256");
  hash.update(WORKSPACE_ROOT_DOMAIN, "utf8");
  hash.update(manifest, "utf8");
  return Object.freeze({
    rootId: hash.digest("hex"),
    manifest,
    manifestHashes: Object.freeze([...manifestHashes]),
    blobHashes: Object.freeze([...blobHashes]),
  });
}

export function workspaceRootId(manifest: string): string {
  return workspaceRoot(manifest, [], []).rootId;
}

export function encodeWorkspaceManifest(
  entries: readonly WorkspaceRootEntry[],
  databasePath: string,
): string {
  const manifest = { format: WORKSPACE_ROOT_FORMAT, entries: [...entries] };
  validateWorkspaceEntries(manifest.entries, databasePath);
  return JSON.stringify(manifest);
}

export function parseWorkspaceManifest(
  manifest: string,
  databasePath: string,
  reject: WorkspaceRejection = rejecting(databasePath),
): WorkspaceRootManifest {
  return parseWorkspaceRootManifest(manifest, reject);
}

export function validateWorkspaceEntries(
  entries: readonly WorkspaceRootEntry[],
  databasePath: string,
  reject: WorkspaceRejection = rejecting(databasePath),
): void {
  validateWorkspaceRootEntries(entries, reject);
}

export function validateCanonicalPath(
  value: string,
  databasePath: string,
  reject: WorkspaceRejection = rejecting(databasePath),
): void {
  validateCanonicalWorkspacePath(value, reject);
}

export function validatePathName(name: string, databasePath: string): void {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0") ||
    hasUnpairedSurrogate(name)
  ) {
    corrupt(databasePath, "its live Workspace contains a noncanonical name");
  }
}

export function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

export function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function fromHex(value: string, databasePath: string, label: string): Uint8Array {
  if (!SHA256.test(value)) {
    corrupt(databasePath, `${label} is not a lowercase SHA-256 identity`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

export function bytes(value: unknown, databasePath: string, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    corrupt(databasePath, `${label} is not bytes`);
  }
  return value;
}

export function integer(value: unknown, databasePath: string, label: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    corrupt(databasePath, `${label} is not a safe integer`);
  }
  return parsed;
}

export function nonnegative(value: unknown, databasePath: string, label: string): number {
  const parsed = integer(value, databasePath, label);
  if (parsed < 0) {
    corrupt(databasePath, `${label} is negative`);
  }
  return parsed;
}

export function mode(value: unknown, databasePath: string): number {
  const parsed = integer(value, databasePath, "Workspace mode");
  if (parsed < 0 || parsed > 0o7777) {
    corrupt(databasePath, "a Workspace node has an invalid mode");
  }
  return parsed;
}

export function corrupt(databasePath: string, reason: string): never {
  throw new WorkflowDatabaseCorruptError(databasePath, reason);
}
