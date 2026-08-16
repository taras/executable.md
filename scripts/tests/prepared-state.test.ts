import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
// `node:fs/promises` only where `@effectionx/fs` has no equivalent.
import { chmod, readFile, symlink } from "node:fs/promises";
import path from "node:path";

import {
  cacheRoots,
  changes,
  contains,
  digest,
  FileReads,
  hostState,
  hostStateChanges,
  stateOf,
  YIELD_EVERY,
} from "../lib/prepared-state.ts";
import type { PreparedState } from "../lib/prepared-state.ts";

/**
 * A prepared tree in miniature: the shapes the real one has — a store with a
 * package inside it, a link into that store, an executable, and a lockfile —
 * small enough to mutate precisely.
 */
function* prepared(): Operation<{ root: string; denoDir: string }> {
  const base = yield* useTempDirectory("prepared-state-");

  const root = path.join(base, "repo");
  for (const store of [".deno/pkg@1.0.0/node_modules/pkg", ".pnpm/pkg@1.0.0/node_modules/pkg"]) {
    yield* ensureDir(path.join(root, "node_modules", store));
    yield* writeTextFile(
      path.join(root, "node_modules", store, "package.json"),
      `{"name":"pkg","version":"1.0.0"}\n`,
    );
    yield* writeTextFile(path.join(root, "node_modules", store, "cli.js"), "#!/usr/bin/env node\n");
    yield* until(chmod(path.join(root, "node_modules", store, "cli.js"), 0o755));
  }
  yield* until(
    symlink(
      path.join(root, "node_modules", ".deno/pkg@1.0.0/node_modules/pkg"),
      path.join(root, "node_modules", "pkg"),
    ),
  );
  yield* writeTextFile(path.join(root, "deno.lock"), `{"version":"5","specifiers":{}}\n`);

  // The cache stands in for what `deno info` reports: content roots beside
  // derived ones, in one directory.
  const denoDir = path.join(base, "cache");
  yield* ensureDir(path.join(denoDir, "npm", "registry.npmjs.org", "pkg"));
  yield* writeTextFile(path.join(denoDir, "npm", "registry.npmjs.org", "pkg", "index.js"), "one\n");
  // The shape Deno leaves beside a package's own files, empty and named for a
  // hash of the run: bookkeeping inside a content root.
  yield* writeTextFile(
    path.join(denoDir, "npm", "registry.npmjs.org", "pkg", ".scripts-warned-6306123456964501041"),
    "",
  );
  yield* ensureDir(path.join(denoDir, "remote", "https"));
  yield* writeTextFile(path.join(denoDir, "remote", "https", "mod.ts"), "export {};\n");

  return { root, denoDir };
}

/** The three roots `deno info --json` reports for content, pointed at the fixture. */
function roots(denoDir: string): Record<string, string> {
  return {
    npmCache: path.join(denoDir, "npm"),
    modulesCache: path.join(denoDir, "remote"),
    registryCache: path.join(denoDir, "registries"),
  };
}

/**
 * The fixture's roots stand in for what `deno info` reports; `cacheRoots` is
 * covered separately, against the real runtime.
 */
function fixtureState(fixture: { root: string; denoDir: string }): Operation<PreparedState> {
  return stateOf(fixture.root, roots(fixture.denoDir));
}

describe("preparedState", () => {
  it("moves when a byte changes inside either store", function* () {
    const fixture = yield* prepared();
    const before = yield* fixtureState(fixture);

    for (const store of [".deno", ".pnpm"]) {
      const manifest = path.join(
        fixture.root,
        "node_modules",
        store,
        "pkg@1.0.0/node_modules/pkg/package.json",
      );
      yield* writeTextFile(manifest, `{"name":"pkg","version":"1.0.0","sideEffects":false}\n`);

      expect(changes(before, yield* fixtureState(fixture))).not.toEqual([]);
      yield* writeTextFile(manifest, `{"name":"pkg","version":"1.0.0"}\n`);
    }

    expect(changes(before, yield* fixtureState(fixture))).toEqual([]);
  });

  it("moves when only an executable bit changes", function* () {
    const fixture = yield* prepared();
    const before = yield* fixtureState(fixture);

    for (const store of [".deno", ".pnpm"]) {
      const script = path.join(
        fixture.root,
        "node_modules",
        store,
        "pkg@1.0.0/node_modules/pkg/cli.js",
      );
      yield* until(chmod(script, 0o644));

      expect(changes(before, yield* fixtureState(fixture))).not.toEqual([]);
      yield* until(chmod(script, 0o755));
    }

    expect(changes(before, yield* fixtureState(fixture))).toEqual([]);
  });

  it("moves when cached dependency content changes", function* () {
    const fixture = yield* prepared();
    const before = yield* fixtureState(fixture);

    yield* writeTextFile(
      path.join(fixture.denoDir, "npm", "registry.npmjs.org", "pkg", "index.js"),
      "two\n",
    );

    expect(changes(before, yield* fixtureState(fixture))).not.toEqual([]);
  });

  /** The part the plan lost once already: the lock is carried *and* compared. */
  it("moves when deno.lock changes", function* () {
    const fixture = yield* prepared();
    const before = yield* fixtureState(fixture);

    yield* writeTextFile(
      path.join(fixture.root, "deno.lock"),
      `{"version":"5","specifiers":{"npm:pkg@1":"1.0.0"}}\n`,
    );

    expect(changes(before, yield* fixtureState(fixture))).toEqual(["deno.lock changed"]);
  });

  /**
   * The bookkeeping Deno writes *inside* a package directory, and the content
   * beside it. Excluding the marker must not blind the fingerprint to the
   * package it sits in.
   */
  it("ignores a scripts-warned marker while still watching its neighbours", function* () {
    const fixture = yield* prepared();
    const pkg = path.join(fixture.denoDir, "npm", "registry.npmjs.org", "pkg");
    const before = yield* fixtureState(fixture);

    yield* writeTextFile(path.join(pkg, ".scripts-warned-6306123456964501041"), "");
    yield* writeTextFile(path.join(pkg, ".scripts-warned-99999999999999"), "");
    expect(changes(before, yield* fixtureState(fixture))).toEqual([]);

    yield* writeTextFile(path.join(pkg, "index.js"), "two\n");
    expect(changes(before, yield* fixtureState(fixture))).not.toEqual([]);
  });

  /**
   * The disproof of whole-directory immutability, as a test: an ordinary
   * offline run rewrites the analysis and V8 caches and regenerates `gen/`, and
   * none of that is dependency content.
   */
  it("ignores derived cache churn", function* () {
    const fixture = yield* prepared();
    const before = yield* fixtureState(fixture);

    yield* ensureDir(path.join(fixture.denoDir, "gen", "data"));
    yield* writeTextFile(path.join(fixture.denoDir, "gen", "data", "x.js"), "transpiled\n");
    for (const derived of ["v8_code_cache_v2", "v8_code_cache_v2-wal", "dep_analysis_cache_v2"]) {
      yield* writeTextFile(path.join(fixture.denoDir, derived), "sqlite\n");
    }
    yield* writeTextFile(path.join(fixture.denoDir, "latest.txt"), "2.9.1\n");

    expect(changes(before, yield* fixtureState(fixture))).toEqual([]);
  });

  it("records an absent content root rather than requiring it", function* () {
    const fixture = yield* prepared();

    const state = yield* fixtureState(fixture);

    expect(state.cache.roots).toEqual(["npmCache", "modulesCache"]);
    expect(state.cache.entries).toContain("registryCache absent");
  });

  it("notices a root appearing where there was none", function* () {
    const fixture = yield* prepared();
    const before = yield* fixtureState(fixture);

    yield* ensureDir(path.join(fixture.denoDir, "registries", "https"));
    yield* writeTextFile(path.join(fixture.denoDir, "registries", "https", "meta.json"), "{}\n");

    expect(changes(before, yield* fixtureState(fixture))).not.toEqual([]);
  });
});

describe("cacheRoots", () => {
  /** Against the real pinned runtime, not a fixture: the keys and their location. */
  it("takes the content roots the runtime reports, inside the given directory", function* () {
    const denoDir = yield* useTempDirectory("cache-roots-");

    const reported = yield* cacheRoots(denoDir);

    expect(Object.keys(reported)).toEqual(["npmCache", "modulesCache", "registryCache"]);
    expect(Object.values(reported).every((root) => root.startsWith(denoDir))).toBe(true);
    expect(reported.npmCache).toEqual(`${denoDir}/npm`);
    expect(reported.modulesCache).toEqual(`${denoDir}/remote`);
  });
});

describe("digest", () => {
  it("separates contents that differ by one byte", function* () {
    const encoder = new TextEncoder();

    expect(digest(encoder.encode("a"))).not.toEqual(digest(encoder.encode("b")));
    expect(digest(encoder.encode("same"))).toEqual(digest(encoder.encode("same")));
  });

  it("is SHA-256, not a hash two files can share", function* () {
    expect(digest(new TextEncoder().encode("abc"))).toEqual(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("contains", () => {
  /** A prefix test calls this one a child, and it is not. */
  it("treats a sibling with a longer name as outside", function* () {
    expect(contains("/tmp/cache", "/tmp/cache-evil")).toBe(false);
    expect(contains("/tmp/cache", "/tmp/cache-evil/npm")).toBe(false);
  });

  it("accepts the directory itself and what is under it", function* () {
    expect(contains("/tmp/cache", "/tmp/cache")).toBe(true);
    expect(contains("/tmp/cache", "/tmp/cache/npm")).toBe(true);
    expect(contains("/tmp/cache/", "/tmp/cache/npm")).toBe(true);
  });

  it("resolves before comparing, so a traversal does not sneak out", function* () {
    expect(contains("/tmp/cache", "/tmp/cache/../cache-evil")).toBe(false);
    expect(contains("/tmp/cache", "/tmp/cache/npm/../remote")).toBe(true);
  });
});

/**
 * A tree big enough that a walk is still going when the halt arrives. Small
 * files: the point is the count of reads, not their size.
 */
function* manyFiles(count: number): Operation<{ root: string; roots: Record<string, string> }> {
  const base = yield* useTempDirectory("prepared-state-halt-");

  const root = path.join(base, "repo");
  yield* ensureDir(path.join(root, "node_modules", "pkg"));
  for (let index = 0; index < count; index++) {
    yield* writeTextFile(path.join(root, "node_modules", "pkg", `file-${index}.js`), `${index}\n`);
  }
  yield* writeTextFile(path.join(root, "deno.lock"), `{"version":"5"}\n`);
  return { root, roots: {} };
}

describe("cancelling a fingerprint", () => {
  /**
   * Every read is an operation, so a halt lands between two of them — and
   * after that the walk starts nothing further, permanently.
   *
   * The halt is triggered by handshake rather than by a timer: the reader
   * itself says when it has begun a known number of files, so the test halts at
   * the same point on a fast disk and a slow one. Counting starts rather than
   * completions is what makes "begins no further read" observable: `until()`
   * does not cancel the host call already in flight, and this seam never
   * claimed it did.
   */
  it("begins no further read once its task is halted", function* () {
    const files = 4000;
    const partway = 300;
    const fixture = yield* manyFiles(files);

    const reached = withResolvers<void>();
    const begun: string[] = [];

    function* counting(file: string): Operation<Uint8Array> {
      begun.push(file);
      if (begun.length === partway) {
        reached.resolve();
      }
      return yield* until(readFile(file));
    }

    const task = yield* spawn(() =>
      FileReads.with(counting, () => stateOf(fixture.root, fixture.roots)),
    );
    yield* reached.operation;
    yield* task.halt();
    const atHalt = begun.length;

    // Long enough that anything still in flight would have landed.
    yield* sleep(250);

    expect(begun.length).toBe(atHalt);
    // Non-vacuous on both sides: it had read, and it had not finished.
    expect(atHalt).toBeGreaterThanOrEqual(partway);
    expect(atHalt).toBeLessThan(files);
    // And it stopped where the handshake put it rather than wherever it
    // happened to be. Without suspending per read it runs to completion and
    // this is 4001.
    expect(atHalt).toBeLessThanOrEqual(partway + YIELD_EVERY);
  });

  /**
   * The half a counting test cannot show: the walk no longer owns the
   * interpreter. A read held open parks the fingerprint alone, and unrelated
   * Effection work runs to completion beside it.
   */
  it("holds a read without blocking unrelated work", function* () {
    const fixture = yield* manyFiles(4);

    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    let held = false;

    function* holding(file: string): Operation<Uint8Array> {
      if (!held) {
        held = true;
        reached.resolve();
        yield* release.operation;
      }
      return yield* until(readFile(file));
    }

    const walk = yield* spawn(() =>
      FileReads.with(holding, () => stateOf(fixture.root, fixture.roots)),
    );
    yield* reached.operation;

    let ticks = 0;
    const unrelated = yield* spawn(function* () {
      for (let index = 0; index < 5; index++) {
        yield* sleep(0);
        ticks++;
      }
    });
    yield* unrelated;

    // The fingerprint is parked on its read and has produced nothing.
    expect(ticks).toBe(5);

    release.resolve();
    const state = yield* walk;
    expect(state.tree.entries.length).toBeGreaterThan(0);
  });
});

/**
 * The host-only snapshot, and the property that matters about it.
 *
 * #279 does not say "ignore cache differences" — it says verification must not
 * fingerprint the cache at all. A snapshot that walked the cache and discarded
 * the result would satisfy every assertion about its *return value*, so the
 * reader it is given fails on anything outside the two paths it may read.
 */
describe("hostState", () => {
  it("reads node_modules and the lockfile, and nothing else", function* () {
    const { root } = yield* prepared();
    const state = yield* hostState(root);

    expect(state.lock.length).toBe(64);
    expect(state.tree.entries.length).toBeGreaterThan(0);
    expect(state.tree.roots).toEqual(["node_modules"]);
  });

  it("cannot reach the cache: a reader that refuses it still succeeds", function* () {
    const { root, denoDir } = yield* prepared();
    const permitted = [path.join(root, "node_modules"), path.join(root, "deno.lock")];
    const refused: string[] = [];

    function* guarded(target: string): Operation<Uint8Array> {
      if (!permitted.some((allowed) => contains(allowed, target))) {
        refused.push(target);
        throw new Error(`read outside the host's own state: ${target}`);
      }
      return yield* until(readFile(target));
    }

    // The fixture's cache is populated, so a snapshot that walked it would read
    // a file and be refused. Succeeding is the assertion.
    expect((yield* cacheRoots(denoDir)).npmCache.length).toBeGreaterThan(0);

    yield* FileReads.set(guarded);
    const state = yield* hostState(root);

    expect(refused).toEqual([]);
    expect(state.tree.entries.length).toBeGreaterThan(0);
  });

  it("names what moved in the tree and the lock", function* () {
    const { root } = yield* prepared();
    const before = yield* hostState(root);

    yield* writeTextFile(path.join(root, "deno.lock"), `{"version":"5","specifiers":{"a":"1"}}\n`);
    const moved = hostStateChanges(before, yield* hostState(root));

    expect(moved.join("\n")).toContain("deno.lock changed");
  });
});
