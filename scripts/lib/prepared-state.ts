/**
 * Everything a build must leave alone, in one comparable value.
 *
 * A build reads two dependency layouts and a lockfile and writes to none of
 * them (AGENTS.md). Proving that needs a fingerprint that moves when *any* byte
 * or mode under them moves — a shallow listing would miss a package's contents
 * changing inside a store, and a stat-based one would miss a rewrite that
 * preserved size and time.
 *
 * Three parts, and the third is easy to forget: the installed tree, the
 * dependency content of the Deno cache the run is using, and `deno.lock`.
 *
 * ## The cache roots are asked for, not assumed
 *
 * `deno info --json` reports where the pinned runtime keeps each cache, and
 * only three of those hold fetched bytes: `npmCache`, `modulesCache`, and
 * `registryCache`. `typescriptCache` (`gen/`) is generated code, `originStorage`
 * is runtime state, and `webCacheStorage` is not even inside `DENO_DIR`. The
 * SQLite analysis and V8 code caches, their `-wal`/`-shm` companions, `dl/`,
 * and `latest.txt` are derived too, and an ordinary offline run rewrites them —
 * so a fingerprint over the whole directory would fail on every honest build.
 *
 * Reading the paths from the runtime rather than naming them means a Deno that
 * relocates a root is followed rather than silently skipped, and a run whose
 * `deno info` stops reporting one of the three fails loudly.
 *
 * ## Every read and every hash is synchronous
 *
 * `until()` stops Effection *observing* a promise; it does not cancel the work
 * behind it. A fingerprint built on `Deno.readFile` and `crypto.subtle.digest`
 * would therefore keep reading and hashing after its task was halted — a
 * hundred-and-fifty-thousand-file walk that ignores cancellation.
 *
 * That rules out `@effectionx/fs` at this one boundary. Version 0.3.0 —
 * the version this repository vendors — implements every operation as
 * `until(fsp.…)` over `node:fs/promises` (`node_modules/@effectionx/fs/api.ts`),
 * so `readdir`, `lstat`, and `readTextFile` are exactly the uncancellable
 * adapters this module cannot use. Everywhere else in these scripts
 * `@effectionx/fs` remains the way to touch the filesystem; the direct
 * `Deno.*Sync` calls stop here.
 *
 * So the reads are `Deno.readFileSync`, `readLinkSync`, `readDirSync`, and
 * `lstatSync`, and the digest is `node:crypto`'s synchronous SHA-256 — no less
 * trustworthy than `crypto.subtle`'s, and it returns rather than resolving.
 *
 * Synchronous work still has to be interruptible, so the walk yields to the
 * scheduler every `YIELD_EVERY` entries. A halt lands on one of those yields,
 * and nothing after it reads or hashes anything.
 */

import { createContext, sleep, until } from "effection";
import type { Context, Operation } from "effection";
import { lstat, readdir } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

/** The roots that hold fetched bytes, by the key `deno info --json` reports them under. */
const CONTENT_ROOTS = ["npmCache", "modulesCache", "registryCache"];

/**
 * The roots this repository's prepared graph actually fills. The third,
 * `registryCache`, stays absent after a real preparation, and its absence is
 * compared like any other state rather than being required.
 */
export const POPULATED_ROOTS = ["npmCache", "modulesCache"];

/**
 * Derived state Deno writes *inside* a content root: an empty marker recording
 * that it already warned about a package's build scripts. An ordinary offline
 * run creates them, so they are bookkeeping rather than dependency content, and
 * excluding them by name is the only way — they sit beside the package's files.
 */
const DERIVED_MARKER = ".scripts-warned-";

export interface Fingerprint {
  /** One entry per path, sorted: `<path> <mode> <kind> <digest-or-target>`. */
  entries: string[];
  /** The roots that were present, by `deno info` key. */
  roots: string[];
}

export interface PreparedState {
  tree: Fingerprint;
  cache: Fingerprint;
  lock: string;
}

/** The repository-owned half, with no cache in it to begin with. */
export interface HostState {
  tree: Fingerprint;
  lock: string;
}

const FINGERPRINTED: ("tree" | "cache")[] = ["tree", "cache"];

/** How many entries the walk covers before giving the scheduler a chance to halt it. */
export const YIELD_EVERY = 256;

/**
 * Reading a file's bytes. The seam a cancellation test counts through.
 *
 * An operation, so the walk suspends at every file it reads and a halt lands
 * between them. `until()` does not cancel the host call already in flight — the
 * contract this seam keeps is narrower and is what the tests hold it to: once
 * the walk is halted, no further read begins.
 */
export type ReadFile = (path: string) => Operation<Uint8Array>;

export const FileReads: Context<ReadFile> = createContext<ReadFile>(
  "prepared-state.file-reads",
  (path) => until(readFile(path)),
);

/**
 * SHA-256, because a fingerprint two different files can share is not one, and
 * synchronous, so a halted walk leaves nothing hashing behind it.
 */
export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Whether `path` is `parent` or lies beneath it, compared by path segment.
 *
 * A prefix test would call `/tmp/cache-evil` a child of `/tmp/cache`, letting a
 * root outside the run's own directory into the fingerprint.
 */
export function contains(parent: string, path: string): boolean {
  const from = resolve(parent);
  const target = resolve(path);
  return target === from || target.startsWith(from.endsWith(sep) ? from : `${from}${sep}`);
}

function* exists(path: string): Operation<boolean> {
  try {
    yield* lstat(path);
    return true;
  } catch {
    return false;
  }
}

function* fingerprint(roots: Record<string, string>, read: ReadFile): Operation<Fingerprint> {
  const entries: string[] = [];
  const present: string[] = [];
  let covered = 0;

  function* walk(root: string): Operation<void> {
    const names = yield* readdir(root);
    for (const name of names.sort()) {
      if (name.startsWith(DERIVED_MARKER)) {
        continue;
      }
      if (++covered % YIELD_EVERY === 0) {
        yield* sleep(0);
      }
      const path = `${root}/${name}`;
      const info = yield* lstat(path);
      const mode = (info.mode ?? 0) & 0o777;
      if (info.isSymbolicLink()) {
        entries.push(`${path} ${mode} link ${yield* until(readlink(path))}`);
        continue;
      }
      if (info.isDirectory()) {
        entries.push(`${path} ${mode} dir`);
        yield* walk(path);
        continue;
      }
      entries.push(`${path} ${mode} file ${digest(yield* read(path))}`);
    }
  }

  for (const [name, root] of Object.entries(roots)) {
    const present_ = yield* exists(root);
    entries.push(`${name} ${present_ ? "present" : "absent"}`);
    if (present_) {
      present.push(name);
      yield* walk(root);
    }
  }
  entries.sort();
  return { entries, roots: present };
}

/**
 * The cache roots of `denoDir`, as the pinned runtime reports them.
 *
 * A root outside `denoDir` belongs to the machine rather than to this run —
 * `webCacheStorage` is one — and fingerprinting it would compare state no
 * build owns.
 */
export function* cacheRoots(denoDir: string): Operation<Record<string, string>> {
  // `--no-config`, so asking where the caches are cannot load a workspace and
  // sync somebody's `node_modules` as a side effect of the question.
  const info = yield* exec(Deno.execPath(), {
    arguments: ["info", "--json", "--no-config"],
    env: { ...Deno.env.toObject(), DENO_DIR: denoDir },
  }).expect();
  const reported = JSON.parse(info.stdout);

  const roots: Record<string, string> = {};
  for (const name of CONTENT_ROOTS) {
    const path = reported[name];
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error(`deno info reported no absolute ${name}; the cache layout changed`);
    }
    if (!contains(denoDir, path)) {
      throw new Error(`deno info reported ${name} outside ${denoDir}: ${path}`);
    }
    roots[name] = path;
  }
  return roots;
}

/**
 * Every byte a build must leave alone: the tree, the cache's content, the lock.
 *
 * The roots are passed in rather than discovered here, so a test can fingerprint
 * a fixture and `preparedState` can fingerprint what the runtime reports.
 */
export function* stateOf(root: string, roots: Record<string, string>): Operation<PreparedState> {
  const read = yield* FileReads.expect();
  return {
    tree: yield* fingerprint({ node_modules: `${root}/node_modules` }, read),
    cache: yield* fingerprint(roots, read),
    lock: digest(yield* read(`${root}/deno.lock`)),
  };
}

/** `stateOf`, against the cache roots the pinned runtime reports for `denoDir`. */
export function* preparedState(root: string, denoDir: string): Operation<PreparedState> {
  return yield* stateOf(root, yield* cacheRoots(denoDir));
}

/**
 * What this repository owns: the installed tree and the lockfile. No cache.
 *
 * Not "the prepared state with the cache filtered out afterwards" — this takes
 * no `denoDir`, never calls `cacheRoots`, and so has nothing to discover, walk,
 * or hash beyond `node_modules` and `deno.lock`. That is the difference the
 * #279 contract turns on: verification may populate the runtime-owned cache, so
 * a comparison that walked it would be measuring state its subject is allowed
 * to change — and paying to hash tens of thousands of files to discard the
 * result.
 */
export function* hostState(root: string): Operation<HostState> {
  const read = yield* FileReads.expect();
  return {
    tree: yield* fingerprint({ node_modules: `${root}/node_modules` }, read),
    lock: digest(yield* read(`${root}/deno.lock`)),
  };
}

/** What moved between two host snapshots, named part by part. */
export function hostStateChanges(before: HostState, after: HostState): string[] {
  return describe({ ...before, cache: EMPTY_FINGERPRINT }, { ...after, cache: EMPTY_FINGERPRINT }, [
    "tree",
  ]);
}

const EMPTY_FINGERPRINT: Fingerprint = { entries: [], roots: [] };

/**
 * What moved in the host's own state: the installed tree and the lock, ignoring
 * the cache.
 *
 * Target preparation is *supposed* to add to the cache — that is its job — while
 * leaving `node_modules` and `deno.lock` exactly as they were. Comparing the
 * whole snapshot there would flag the work it was asked to do.
 */
export function hostChanges(before: PreparedState, after: PreparedState): string[] {
  return describe(before, after, ["tree"]);
}

/** What moved between two snapshots, named part by part, with a sample of the paths. */
export function changes(before: PreparedState, after: PreparedState): string[] {
  return describe(before, after, FINGERPRINTED);
}

function describe(
  before: PreparedState,
  after: PreparedState,
  parts: ("tree" | "cache")[],
): string[] {
  const moved: string[] = [];
  if (before.lock !== after.lock) {
    moved.push("deno.lock changed");
  }
  for (const part of parts) {
    const previous = new Set(before[part].entries);
    const current = new Set(after[part].entries);
    const gone = before[part].entries.filter((entry) => !current.has(entry));
    const added = after[part].entries.filter((entry) => !previous.has(entry));
    if (gone.length > 0 || added.length > 0) {
      moved.push(
        `${part}: ${gone.length} removed, ${added.length} added` +
          `\n  ${[...gone.slice(0, 3), ...added.slice(0, 3)].join("\n  ")}`,
      );
    }
  }
  return moved;
}
