/**
 * What a retained Workspace root *is*, independent of who stored it.
 *
 * A root is a canonical JSON manifest and the content-addressed objects its
 * entries name. Its identity is the SHA-256 of a domain-separated encoding of
 * that manifest, so two hosts holding the same bytes hold the same root and
 * neither has to be asked.
 *
 * Two adapters retain roots — the Deno host in a SQLite file, the Cloudflare
 * owner in the storage of one Durable Object — and a second copy of these rules
 * under a second adapter would be the place they stopped agreeing. Whichever
 * one is looser decides what the other must accept, and the looser one is
 * always the newer one. So the rules live here once.
 *
 * Nothing here opens a database, hashes anything, or names a runtime. Hashing
 * is deliberately absent: each host has its own primitive for it, and this
 * module has no business choosing between them. What it decides is whether a
 * sequence of bytes is a canonically encoded manifest at all, and what that
 * manifest says.
 *
 * A caller supplies `reject`, because the same disagreement is reported very
 * differently depending on who found it: a path names the file the Deno host
 * refused, a Durable Object has no path to name, and a sealed artifact is not a
 * run database at all.
 */

/** The only root format this build reads or writes. */
export const WORKSPACE_ROOT_FORMAT = 1;

/**
 * What a root identity is taken over, before the manifest itself.
 *
 * Domain separation, so a digest of a Workspace root can never collide with a
 * digest of anything else this system hashes.
 */
export const WORKSPACE_ROOT_DOMAIN = "xmd-workspace-root\0v1\0";

/** A lowercase SHA-256 identity, which is the only spelling any of this uses. */
export const SHA256 = /^[0-9a-f]{64}$/;

/** How a reader says these bytes are not a root it can accept. */
export type WorkspaceRejection = (reason: string) => never;

/** One directory in a root. */
export interface WorkspaceDirectoryEntry {
  readonly path: string;
  readonly kind: "directory";
  readonly mode: number;
  readonly mtime: number;
}

/** One file in a root, named by the DOFS manifest holding its bytes. */
export interface WorkspaceFileEntry {
  readonly path: string;
  readonly kind: "file";
  readonly mode: number;
  readonly mtime: number;
  readonly size: number;
  readonly manifest: string;
  readonly hardlink: string | null;
}

/** One symbolic link in a root. */
export interface WorkspaceSymlinkEntry {
  readonly path: string;
  readonly kind: "symlink";
  readonly mode: number;
  readonly mtime: number;
  readonly target: string;
}

export type WorkspaceRootEntry =
  | WorkspaceDirectoryEntry
  | WorkspaceFileEntry
  | WorkspaceSymlinkEntry;

export interface WorkspaceRootManifest {
  readonly format: typeof WORKSPACE_ROOT_FORMAT;
  readonly entries: readonly WorkspaceRootEntry[];
}

/** One DOFS manifest: the ordered chunks one file's bytes are stored as. */
export interface DofsChunkReference {
  readonly hash: string;
  readonly size: number;
}

export interface DofsManifest {
  readonly size: number;
  readonly chunks: readonly DofsChunkReference[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Compare two paths by their UTF-8 bytes.
 *
 * Byte order rather than `String` order, because a root's canonical ordering is
 * a property of its encoding: two hosts that sorted differently would disagree
 * about whether the same entries are the same root.
 */
export function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const first = a[index] ?? 0;
    const second = b[index] ?? 0;
    if (first !== second) {
      return first < second ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** The directory one canonical path sits in. */
export function parentPath(path: string): string {
  const boundary = path.lastIndexOf("/");
  return boundary === 0 ? "/" : path.slice(0, boundary);
}

/** Depth first, then byte order — the order a restore creates entries in. */
export function parentFirst(left: WorkspaceRootEntry, right: WorkspaceRootEntry): number {
  const depth = left.path.split("/").length - right.path.split("/").length;
  return depth === 0 ? compareUtf8(left.path, right.path) : depth;
}

/**
 * Whether text contains a code unit that is not part of a valid pair.
 *
 * An unpaired surrogate survives a round trip through JSON and does not survive
 * one through UTF-8, so a manifest carrying one is a manifest whose bytes
 * cannot be reproduced.
 */
export function hasUnpairedSurrogate(value: string): boolean {
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

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function members(value: unknown): Map<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return new Map(Object.entries(value));
}

/**
 * Whether an object declares exactly these members and no others.
 *
 * A manifest is compared with its own re-encoding further down, so an extra
 * member would already be caught. It is refused here as well because the reason
 * matters: an unknown member is a manifest this build does not understand,
 * which is a different thing from bytes that were laid out differently.
 */
function declares(found: Map<string, unknown>, expected: readonly string[]): boolean {
  if (found.size !== expected.length) {
    return false;
  }
  return expected.every((name) => found.has(name));
}

function mode(value: unknown): boolean {
  return isSafeInteger(value) && value >= 0 && value <= 0o7777;
}

/**
 * Read one entry, in the exact member order this build writes.
 *
 * The order matters and is not a style choice: a manifest is compared with its
 * own re-encoding, and a re-encoding that named the same members in a different
 * order would be refused as noncanonical. So each branch builds its object
 * literally rather than by spreading a shared prefix.
 */
function entryOf(value: unknown): WorkspaceRootEntry | undefined {
  const found = members(value);
  if (found === undefined) {
    return undefined;
  }
  const path = found.get("path");
  const kind = found.get("kind");
  const entryMode = found.get("mode");
  const mtime = found.get("mtime");
  if (
    typeof path !== "string" ||
    !mode(entryMode) ||
    !isSafeInteger(entryMode) ||
    !isSafeInteger(mtime)
  ) {
    return undefined;
  }

  if (kind === "directory") {
    return declares(found, ["path", "kind", "mode", "mtime"])
      ? { path, kind, mode: entryMode, mtime }
      : undefined;
  }
  if (kind === "symlink") {
    const target = found.get("target");
    if (typeof target !== "string") {
      return undefined;
    }
    return declares(found, ["path", "kind", "mode", "mtime", "target"])
      ? { path, kind, mode: entryMode, mtime, target }
      : undefined;
  }
  if (kind !== "file") {
    return undefined;
  }
  const size = found.get("size");
  const manifest = found.get("manifest");
  const hardlink = found.get("hardlink");
  if (!isSafeInteger(size) || size < 0 || typeof manifest !== "string" || !SHA256.test(manifest)) {
    return undefined;
  }
  if (hardlink !== null && (typeof hardlink !== "string" || !/^h[0-9]+$/.test(hardlink))) {
    return undefined;
  }
  return declares(found, ["path", "kind", "mode", "mtime", "size", "manifest", "hardlink"])
    ? { path, kind, mode: entryMode, mtime, size, manifest, hardlink }
    : undefined;
}

/**
 * Read one root manifest out of the exact text a store retained.
 *
 * Three separate questions, in order: is it JSON, is it a manifest this build
 * declares, and are these the exact bytes this build would have written for
 * that manifest. The last one is what makes the identity meaningful — a root ID
 * is a digest of these bytes, so a manifest that means the same thing and is
 * spelled differently is a different root and must not be admitted as this one.
 */
export function parseWorkspaceRootManifest(
  manifest: string,
  reject: WorkspaceRejection,
): WorkspaceRootManifest {
  let offered: unknown;
  try {
    offered = JSON.parse(manifest);
  } catch {
    reject("one of its retained Workspace roots is not JSON");
  }
  const found = members(offered);
  const declared = found !== undefined && declares(found, ["format", "entries"]);
  const entries = found?.get("entries");
  if (!declared || found?.get("format") !== WORKSPACE_ROOT_FORMAT || !Array.isArray(entries)) {
    reject("one of its retained Workspace roots has an invalid manifest");
  }
  const parsed: WorkspaceRootEntry[] = [];
  for (const entry of entries) {
    const admitted = entryOf(entry);
    if (admitted === undefined) {
      reject("one of its retained Workspace roots has an invalid manifest");
    }
    parsed.push(admitted);
  }
  const root: WorkspaceRootManifest = { format: WORKSPACE_ROOT_FORMAT, entries: parsed };
  validateWorkspaceRootEntries(parsed, reject);
  if (JSON.stringify(root) !== manifest) {
    reject("one of its retained Workspace roots is not canonically encoded");
  }
  return root;
}

/**
 * Whether these entries describe a Workspace at all.
 *
 * Shape is not enough. A root is a tree, and its manifest is a flat list, so
 * the tree lives in these rules: the list starts at the root directory, every
 * path is canonical, order is total and by bytes, every entry has a parent that
 * was already declared, and a hardlink group is numbered in the order it first
 * appears and agrees with itself.
 */
export function validateWorkspaceRootEntries(
  entries: readonly WorkspaceRootEntry[],
  reject: WorkspaceRejection,
): void {
  if (entries.length === 0 || entries[0]?.path !== "/" || entries[0]?.kind !== "directory") {
    reject("a Workspace root does not begin with its root directory");
  }

  let previous: string | undefined;
  let nextHardlink = 0;
  const directories = new Set<string>();
  const hardlinkMembers = new Map<string, number>();
  const hardlinkFirst = new Map<string, WorkspaceFileEntry>();

  for (const entry of entries) {
    validateCanonicalWorkspacePath(entry.path, reject);
    if (previous !== undefined && compareUtf8(previous, entry.path) >= 0) {
      reject("a Workspace root's paths are duplicated or out of canonical order");
    }
    previous = entry.path;

    if (entry.path !== "/" && !directories.has(parentPath(entry.path))) {
      reject("a Workspace root contains an entry without a parent directory");
    }
    if (entry.kind === "directory") {
      directories.add(entry.path);
    }
    if (
      entry.kind === "symlink" &&
      (entry.target.includes("\0") || hasUnpairedSurrogate(entry.target))
    ) {
      reject("a Workspace root contains an invalid symbolic-link target");
    }
    if (entry.kind === "file" && entry.hardlink !== null) {
      const first = hardlinkFirst.get(entry.hardlink);
      if (first === undefined) {
        if (entry.hardlink !== `h${nextHardlink}`) {
          reject("a Workspace root's hardlinks are not canonically numbered");
        }
        nextHardlink += 1;
        hardlinkFirst.set(entry.hardlink, entry);
      } else if (
        first.mode !== entry.mode ||
        first.mtime !== entry.mtime ||
        first.size !== entry.size ||
        first.manifest !== entry.manifest
      ) {
        reject("a Workspace root's hardlink group has inconsistent metadata");
      }
      hardlinkMembers.set(entry.hardlink, (hardlinkMembers.get(entry.hardlink) ?? 0) + 1);
    }
  }

  for (const count of hardlinkMembers.values()) {
    if (count < 2) {
      reject("a Workspace root contains a one-member hardlink group");
    }
  }
}

/** One absolute path with no traversal, no empty component and no surprises. */
export function validateCanonicalWorkspacePath(value: string, reject: WorkspaceRejection): void {
  if (value === "/") {
    return;
  }
  if (
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value)
  ) {
    reject("a Workspace root contains a noncanonical path");
  }
  for (const part of value.slice(1).split("/")) {
    if (part === "" || part === "." || part === "..") {
      reject("a Workspace root contains a noncanonical path component");
    }
  }
}

/**
 * The DOFS manifest one encoding describes, without a store to look anything up
 * in.
 *
 * The same bytes are validated in more than one place — by a live run reading
 * its own content store, by a reader checking a detached copy, and by an owner
 * about to send a copy to a runner. What is decided here is only whether these
 * bytes are a canonically encoded DOFS manifest at all, and what size the
 * chunks it names add up to. That the chunks exist is whoever called's to prove.
 */
export function decodeDofsManifest(encoded: Uint8Array, reject: WorkspaceRejection): DofsManifest {
  let text: string;
  let offered: unknown;
  try {
    text = decoder.decode(encoded);
    offered = JSON.parse(text);
  } catch {
    reject("a DOFS manifest is not canonical UTF-8 JSON");
  }
  const found = members(offered);
  const chunks = found?.get("chunks");
  if (
    found === undefined ||
    !declares(found, ["version", "chunks"]) ||
    found.get("version") !== 1 ||
    !Array.isArray(chunks)
  ) {
    reject("a DOFS manifest is not canonically encoded");
  }
  const references: DofsChunkReference[] = [];
  for (const chunk of chunks) {
    const entry = members(chunk);
    const hash = entry?.get("hash");
    const size = entry?.get("size");
    if (
      entry === undefined ||
      !declares(entry, ["hash", "size"]) ||
      typeof hash !== "string" ||
      !SHA256.test(hash) ||
      !isSafeInteger(size) ||
      size < 1
    ) {
      // A zero-length chunk names no bytes, so a manifest that lists one is
      // describing content it does not have.
      reject("a DOFS manifest is not canonically encoded");
    }
    references.push({ hash, size });
  }
  if (JSON.stringify({ version: 1, chunks: references }) !== text) {
    reject("a DOFS manifest is not canonically encoded");
  }
  const total = references.reduce((sum, chunk) => sum + chunk.size, 0);
  if (!Number.isSafeInteger(total)) {
    reject("a DOFS manifest names more bytes than a size can hold");
  }
  return Object.freeze({ size: total, chunks: Object.freeze(references) });
}
