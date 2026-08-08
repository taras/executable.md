import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkflowDatabaseCorruptError } from "../../storage/errors.ts";

export const WORKSPACE_ROOT_FORMAT = 1;
export const WORKSPACE_ROOT_DOMAIN = "xmd-workspace-root\0v1\0";

const SHA256 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

const directoryEntrySchema = z
  .object({
    path: z.string(),
    kind: z.literal("directory"),
    mode: z.number().int().min(0).max(0o7777),
    mtime: z.number().int().safe(),
  })
  .strict();

const fileEntrySchema = z
  .object({
    path: z.string(),
    kind: z.literal("file"),
    mode: z.number().int().min(0).max(0o7777),
    mtime: z.number().int().safe(),
    size: z.number().int().safe().nonnegative(),
    manifest: z.string().regex(SHA256),
    hardlink: z
      .string()
      .regex(/^h[0-9]+$/)
      .nullable(),
  })
  .strict();

const symlinkEntrySchema = z
  .object({
    path: z.string(),
    kind: z.literal("symlink"),
    mode: z.number().int().min(0).max(0o7777),
    mtime: z.number().int().safe(),
    target: z.string(),
  })
  .strict();

const rootManifestSchema = z
  .object({
    format: z.literal(WORKSPACE_ROOT_FORMAT),
    entries: z.array(
      z.discriminatedUnion("kind", [directoryEntrySchema, fileEntrySchema, symlinkEntrySchema]),
    ),
  })
  .strict();

export type WorkspaceRootEntry = z.infer<typeof rootManifestSchema>["entries"][number];
export type WorkspaceRootManifest = z.infer<typeof rootManifestSchema>;

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
): WorkspaceRootManifest {
  let offered: unknown;
  try {
    offered = JSON.parse(manifest);
  } catch {
    corrupt(databasePath, "one of its retained Workspace roots is not JSON");
  }
  const parsed = rootManifestSchema.safeParse(offered);
  if (!parsed.success) {
    corrupt(databasePath, "one of its retained Workspace roots has an invalid manifest");
  }
  validateWorkspaceEntries(parsed.data.entries, databasePath);
  if (JSON.stringify(parsed.data) !== manifest) {
    corrupt(databasePath, "one of its retained Workspace roots is not canonically encoded");
  }
  return parsed.data;
}

export function validateWorkspaceEntries(
  entries: readonly WorkspaceRootEntry[],
  databasePath: string,
): void {
  if (entries.length === 0 || entries[0]?.path !== "/" || entries[0]?.kind !== "directory") {
    corrupt(databasePath, "a Workspace root does not begin with its root directory");
  }

  let previous: string | undefined;
  let nextHardlink = 0;
  const directories = new Set<string>();
  const hardlinkMembers = new Map<string, number>();
  const hardlinkFirst = new Map<string, WorkspaceRootEntry & { kind: "file" }>();

  for (const entry of entries) {
    validateCanonicalPath(entry.path, databasePath);
    if (previous !== undefined && compareUtf8(previous, entry.path) >= 0) {
      corrupt(databasePath, "a Workspace root's paths are duplicated or out of canonical order");
    }
    previous = entry.path;

    if (entry.path !== "/" && !directories.has(parentPath(entry.path))) {
      corrupt(databasePath, "a Workspace root contains an entry without a parent directory");
    }
    if (entry.kind === "directory") {
      directories.add(entry.path);
    }
    if (
      entry.kind === "symlink" &&
      (entry.target.includes("\0") || hasUnpairedSurrogate(entry.target))
    ) {
      corrupt(databasePath, "a Workspace root contains an invalid symbolic-link target");
    }
    if (entry.kind === "file" && entry.hardlink !== null) {
      const first = hardlinkFirst.get(entry.hardlink);
      if (first === undefined) {
        if (entry.hardlink !== `h${nextHardlink}`) {
          corrupt(databasePath, "a Workspace root's hardlinks are not canonically numbered");
        }
        nextHardlink += 1;
        hardlinkFirst.set(entry.hardlink, entry);
      } else if (
        first.mode !== entry.mode ||
        first.mtime !== entry.mtime ||
        first.size !== entry.size ||
        first.manifest !== entry.manifest
      ) {
        corrupt(databasePath, "a Workspace root's hardlink group has inconsistent metadata");
      }
      hardlinkMembers.set(entry.hardlink, (hardlinkMembers.get(entry.hardlink) ?? 0) + 1);
    }
  }

  for (const count of hardlinkMembers.values()) {
    if (count < 2) {
      corrupt(databasePath, "a Workspace root contains a one-member hardlink group");
    }
  }
}

export function validateCanonicalPath(value: string, databasePath: string): void {
  if (value === "/") {
    return;
  }
  if (
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value)
  ) {
    corrupt(databasePath, "a Workspace root contains a noncanonical path");
  }
  for (const part of value.slice(1).split("/")) {
    if (part === "" || part === "." || part === "..") {
      corrupt(databasePath, "a Workspace root contains a noncanonical path component");
    }
  }
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

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(encoder.encode(left), encoder.encode(right));
}

export function parentFirst(left: WorkspaceRootEntry, right: WorkspaceRootEntry): number {
  const depth = left.path.split("/").length - right.path.split("/").length;
  return depth === 0 ? compareUtf8(left.path, right.path) : depth;
}

export function parentPath(path: string): string {
  const boundary = path.lastIndexOf("/");
  return boundary === 0 ? "/" : path.slice(0, boundary);
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

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
