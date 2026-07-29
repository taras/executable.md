/**
 * Tier GA — the Fs Api's `glob` operation.
 *
 * `<Glob>` (Tier GB) is one caller and `resolveTestTarget` is another, so what
 * this operation guarantees is tested here rather than through either. Every
 * test calls `glob()` directly: no component runs, so nothing a component could
 * do afterwards can make one of these pass.
 *
 * What matters most is the difference between **filtering** and **pruning**.
 * Filtering decides whether one candidate is reported; pruning decides not to
 * look at a whole subtree, and is only sound when every path beneath it is
 * excluded. The tests that count directory reads are the ones that tell those
 * apart — a result set alone cannot, because a correctly filtered walk and an
 * over-eager prune can agree on the answer and disagree on the work.
 *
 * `mkdtemp`, `realpath`, and `symlink` have no `@effectionx/fs` equivalent;
 * everything else goes through it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, FsApi, rm, writeTextFile } from "@effectionx/fs";
import { glob } from "@executablemd/runtime";
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary tree holding `paths`, each file containing its own path. */
function useTree(paths: string[]): Operation<string> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "ga-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    for (const path of paths) {
      const target = join(root, path);
      yield* ensureDir(join(target, ".."));
      yield* writeTextFile(target, path);
    }

    yield* provide(root);
  });
}

/** The matched paths, sorted so a test states a set rather than a walk order. */
function* find(root: string, patterns: string[], exclude?: string[]): Operation<string[]> {
  const matched = yield* glob({ root, patterns, exclude });
  return matched.map((entry) => entry.path).sort();
}

/**
 * The same search, plus the directories it actually read.
 *
 * Relative to `root`, with the root itself as `.`, because a test about pruning
 * is a test about which directories were opened — and an absolute path would
 * make the expectation depend on the temporary directory's name.
 */
function* findAndRead(
  root: string,
  patterns: string[],
  exclude?: string[],
): Operation<{ paths: string[]; read: string[] }> {
  return yield* scoped(function* () {
    const read: string[] = [];
    yield* FsApi.around({
      *readdirDirents([path], next) {
        const seen = String(path);
        if (seen === root || seen.startsWith(`${root}/`)) {
          read.push(seen === root ? "." : seen.slice(root.length + 1));
        }
        return yield* next(path);
      },
    });

    const paths = yield* find(root, patterns, exclude);
    return { paths, read: read.sort() };
  });
}

const ALL_MARKDOWN = ["**/*.md"];

describe("Tier GA — Fs Api glob", () => {
  // GA1: patterns are matched against the path relative to the root. Handing
  // them to a walk that tests absolute paths instead is the shape of bug that
  // makes an exclusion silently do nothing: an anchored `.git/**` cannot match
  // `/tmp/xxx/.git/config`.
  it("GA1: exclusions are matched against the relative path", function* () {
    const root = yield* useTree([".git/config", "keep.md", ".git/hooks/pre-commit"]);

    expect(yield* find(root, ["**/*"])).toEqual([
      ".git/config",
      ".git/hooks/pre-commit",
      "keep.md",
    ]);
    expect(yield* find(root, ["**/*"], [".git/**"])).toEqual(["keep.md"]);
  });

  // GA2: `*` may match nothing but never crosses a separator, so `foo/*` selects
  // the direct children of `foo` and nothing deeper. Skipping `foo` because the
  // pattern matches `foo/` would drop a file the exclusion never named.
  it("GA2: an exclusion that stops at a separator keeps deeper files", function* () {
    const root = yield* useTree(["foo/direct.md", "foo/deep/keep.md"]);

    expect(yield* find(root, ALL_MARKDOWN, ["foo/*"])).toEqual(["foo/deep/keep.md"]);
  });

  // GA2b: and the walk has to happen for that to be possible — `foo` and
  // `foo/deep` are both read. This is the half a result set cannot show.
  it("GA2b: a partial exclusion still walks the subtree", function* () {
    const root = yield* useTree(["foo/direct.md", "foo/deep/keep.md"]);

    const { paths, read } = yield* findAndRead(root, ALL_MARKDOWN, ["foo/*"]);

    expect(paths).toEqual(["foo/deep/keep.md"]);
    expect(read).toEqual([".", "foo", "foo/deep"]);
  });

  // GA3: a directory is not a candidate — it is never reported — so an exclusion
  // matching its own path has nothing to act on, and says nothing about what is
  // beneath it.
  it("GA3: an exclusion naming only a directory removes nothing below it", function* () {
    const root = yield* useTree(["vendor/direct.md", "vendor/deep/keep.md", "keep.md"]);

    expect(yield* find(root, ALL_MARKDOWN, ["vendor"])).toEqual([
      "keep.md",
      "vendor/deep/keep.md",
      "vendor/direct.md",
    ]);
  });

  // GA4: a trailing `/**` does cover every descendant at any depth, so the
  // subtree is skipped. `vendor` is never opened — which is the point of
  // pruning, and is not observable from the result alone.
  it("GA4: a full-subtree exclusion prunes instead of walking", function* () {
    const root = yield* useTree(["vendor/direct.md", "vendor/deep/keep.md", "keep.md"]);

    const { paths, read } = yield* findAndRead(root, ALL_MARKDOWN, ["vendor/**"]);

    expect(paths).toEqual(["keep.md"]);
    expect(read).toEqual(["."]);
  });

  // GA4b: the prefix before `/**` is itself a pattern, so a `**` inside it
  // prunes wherever it matches — which is what makes `**/node_modules/**` cheap
  // in a real repository.
  it("GA4b: a wildcard prefix prunes wherever it matches", function* () {
    const root = yield* useTree([
      "node_modules/a/index.md",
      "packages/core/node_modules/b/index.md",
      "packages/core/src/keep.md",
    ]);

    const { paths, read } = yield* findAndRead(root, ALL_MARKDOWN, ["**/node_modules/**"]);

    expect(paths).toEqual(["packages/core/src/keep.md"]);
    expect(read).toEqual([".", "packages", "packages/core", "packages/core/src"]);
  });

  // GA5: `**/*` matches every path at any depth, so it excludes everything —
  // but it ends at a single `*`, so it earns no pruning. The answer is the same
  // and the work is not, which is exactly the distinction being preserved:
  // pruning is an optimization that must never change the result.
  it("GA5: an exclusion can be total without being prunable", function* () {
    const root = yield* useTree(["a.md", "one/b.md"]);

    const starStar = yield* findAndRead(root, ALL_MARKDOWN, ["**/*"]);
    expect(starStar.paths).toEqual([]);
    expect(starStar.read).toEqual([".", "one"]);

    // `**` alone does cover the whole tree, so nothing below the root is read.
    const bare = yield* findAndRead(root, ALL_MARKDOWN, ["**"]);
    expect(bare.paths).toEqual([]);
    expect(bare.read).toEqual(["."]);
  });

  // GA6: exclusions win over an include that names a file outright, and several
  // compose. One that matches nothing removes nothing.
  it("GA6: exclusions compose and beat an exactly named include", function* () {
    const root = yield* useTree(["a.md", "b.md", "c.md"]);

    expect(yield* find(root, ["a.md", "b.md", "c.md"], ["a.md", "c.md", "absent.md"])).toEqual([
      "b.md",
    ]);
  });

  // GA7: a symlink is reported by its own path with `isFile: false`, and a link
  // to a directory is not descended into — so traversal cannot leave the root
  // and cannot cycle. `escape` is a link to the root's own parent.
  it("GA7: symlinks are reported but never followed", function* () {
    const root = yield* useTree(["a.md", "real/b.md"]);
    yield* until(symlink(join(root, "real"), join(root, "alias")));
    yield* until(symlink(join(root, ".."), join(root, "escape")));

    const { read } = yield* findAndRead(root, ["**/*"]);
    const matched = yield* glob({ root, patterns: ["**/*"] });

    expect(read).toEqual([".", "real"]);
    expect(
      matched
        .filter((entry) => entry.isFile)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["a.md", "real/b.md"]);
    expect(
      matched
        .filter((entry) => !entry.isFile)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["alias", "escape"]);
  });

  // GA8: a directory read that fails must throw where `glob` was called. Driving
  // the walk from a spawned task instead makes the failure tear down the
  // surrounding scope as an unhandled rejection, which no caller can report.
  it("GA8: a failed directory read throws at the call site", function* () {
    const root = yield* useTree(["a.md", "one/b.md"]);

    const failure = yield* scoped(function* () {
      yield* FsApi.around({
        *readdirDirents([path], next) {
          if (String(path).endsWith("one")) {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
          return yield* next(path);
        },
      });

      try {
        yield* find(root, ALL_MARKDOWN);
        return undefined;
      } catch (error) {
        return error;
      }
    });

    expect(failure).toBeInstanceOf(Error);
  });

  // GA9: an uncompilable pattern surfaces from `glob` rather than matching
  // nothing, so a caller can report it as the authoring error it is.
  it("GA9: an uncompilable pattern throws a SyntaxError", function* () {
    const root = yield* useTree(["a.md"]);

    const include = yield* attempt(find(root, ["[bad"]));
    expect(include).toBeInstanceOf(SyntaxError);

    const exclude = yield* attempt(find(root, ALL_MARKDOWN, ["[bad"]));
    expect(exclude).toBeInstanceOf(SyntaxError);
  });

  // GA10: an empty tree and a pattern that selects nothing are both an empty
  // array, not a failure.
  it("GA10: no matches is an empty array", function* () {
    const empty = yield* useTree([]);
    expect(yield* find(empty, ["**/*"])).toEqual([]);

    const root = yield* useTree(["a.md"]);
    expect(yield* find(root, ["**/*.txt"])).toEqual([]);
  });
});

/** Whatever an operation threw, or `undefined` when it did not throw. */
function* attempt(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}
