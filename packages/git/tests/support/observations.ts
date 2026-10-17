/**
 * The real repository the local Git read suites observe.
 *
 * Everything here is a real checkout, real commits and real `git`. The fixture
 * is deliberately awkward in the ways a read has to survive: a binary file, a
 * mode change, a rename, a deletion, a type change, a tracked gitlink whose
 * pointer moves, a filename holding a space, a tab, a newline and a character
 * outside ASCII, a filename holding the characters a glob would expand, an
 * untracked file, an untracked nested checkout and a sibling checkout of the
 * same origin.
 *
 * Nothing here is substituted. A suite that wants to know whether a read ran a
 * repository-defined program, or changed a byte of the repository it read,
 * needs a repository that really holds one and really could.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, lstat, readdir, readTextFile, rm } from "@effectionx/fs";
import { chmod, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import type { ComponentRegistration } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { git, gitOutput } from "./git-remotes.ts";

/** A filename holding a space, a tab, a newline and a non-ASCII character. */
export const AWKWARD_PATH = "uni/é space\ttab\nnewline.md";

/** A filename holding every character a glob would have expanded. */
export const MAGIC_PATH = "star*name[1]?.md";

/** The 256 bytes a binary file holds at the first commit. */
export const BINARY = new Uint8Array(Array.from({ length: 256 }, (_, index) => index));

/** The same bytes reversed, which is what the second commit holds. */
export const BINARY_CHANGED = new Uint8Array([...BINARY].reverse());

export interface ObservationFixture {
  /** The canonical root of the checkout a read is run in. */
  readonly root: string;
  /** The home every fixture command runs with. */
  readonly home: string;
  /** The first commit's full object id. */
  readonly c1: string;
  /** The second commit's full object id. */
  readonly c2: string;
  /** The nested repository's two commits, which the gitlink points at. */
  readonly gitlink: { readonly before: string; readonly after: string };
  /** The sibling checkout of the same repository, outside this root. */
  readonly sibling: string;
  /** Run one Git command in the checkout, trimmed. */
  run(...args: string[]): string;
  /** Run one Git command in the checkout, exactly as it printed. */
  output(...args: string[]): string;
}

function* write(root: string, path: string, content: string | Uint8Array): Operation<void> {
  const target = join(root, path);
  const separator = target.lastIndexOf("/");
  if (separator > 0) {
    yield* ensureDir(target.slice(0, separator));
  }
  yield* until(writeFile(target, content));
}

/**
 * The fixture, built commit by commit so each status has a real cause.
 *
 * The gitlink is added with `update-index --cacheinfo` rather than through
 * `submodule add`, which would write a `.gitmodules` file and ask Git to clone
 * over a protocol this suite does not enable. What a read has to survive is a
 * tracked gitlink whose recorded commit moves, and that is exactly what this
 * produces.
 */
export function* useObservationFixture(): Operation<ObservationFixture> {
  const home = yield* useTempDirectory("xmd-observations-home-");
  const parent = yield* until(realpath(yield* useTempDirectory("xmd-observations-")));
  const root = join(parent, "checkout");
  yield* ensureDir(root);
  git(["init", "--initial-branch=main", "."], root, home);
  git(["config", "user.name", "Fixture"], root, home);
  git(["config", "user.email", "fixture@example.invalid"], root, home);

  // The repository the tracked gitlink points into, with two commits of its own.
  const nested = join(root, "nested");
  yield* ensureDir(nested);
  git(["init", "--initial-branch=main", "."], nested, home);
  git(["config", "user.name", "Fixture"], nested, home);
  git(["config", "user.email", "fixture@example.invalid"], nested, home);
  yield* write(nested, "inner.txt", "inner one\n");
  git(["add", "inner.txt"], nested, home);
  git(["commit", "-m", "inner one"], nested, home);
  const gitlinkBefore = git(["rev-parse", "HEAD"], nested, home);

  yield* write(root, "src/a.ts", "export const a = 1;\n");
  yield* write(root, "src/bin.dat", BINARY);
  yield* write(root, "mode.sh", "#!/bin/sh\necho hi\n");
  yield* write(root, "doc/orig.md", `${"x".repeat(200)}\n`);
  yield* write(root, AWKWARD_PATH, "unicode\n");
  yield* write(root, MAGIC_PATH, "literal\n");
  yield* write(root, "gone.ts", "removed later\n");
  yield* write(root, "link-me.txt", "a file for now\n");
  yield* until(chmod(join(root, "mode.sh"), 0o644));
  git(["add", "--", "src", "mode.sh", "doc", "gone.ts", "link-me.txt"], root, home);
  git(["add", "--", AWKWARD_PATH, MAGIC_PATH], root, home);
  git(
    ["update-index", "--add", "--cacheinfo", `160000,${gitlinkBefore},nested`],
    root,
    home,
  );
  git(["commit", "-m", "first"], root, home);
  const c1 = git(["rev-parse", "HEAD"], root, home);

  yield* write(nested, "inner.txt", "inner two\n");
  git(["add", "inner.txt"], nested, home);
  git(["commit", "-m", "inner two"], nested, home);
  const gitlinkAfter = git(["rev-parse", "HEAD"], nested, home);

  git(["mv", "doc/orig.md", "doc/renamed.md"], root, home);
  yield* write(root, "src/bin.dat", BINARY_CHANGED);
  yield* until(chmod(join(root, "mode.sh"), 0o755));
  yield* write(root, "src/added.ts", "export const added = true;\n");
  git(["rm", "--quiet", "--", "gone.ts"], root, home);
  git(["rm", "--quiet", "--", "link-me.txt"], root, home);
  yield* until(symlink("src/a.ts", join(root, "link-me.txt")));
  git(["add", "--", "src", "mode.sh", "link-me.txt"], root, home);
  git(
    ["update-index", "--cacheinfo", `160000,${gitlinkAfter},nested`],
    root,
    home,
  );
  git(["commit", "-m", "second"], root, home);
  const c2 = git(["rev-parse", "HEAD"], root, home);

  // A sibling checkout of the same repository, outside this root, holding
  // content of its own so a read that answered from the wrong one would say so.
  const sibling = join(parent, "sibling");
  git(["clone", "--quiet", "--", root, sibling], parent, home);

  // An untracked nested checkout, which no listing may traverse into.
  const scratch = join(root, "scratch-repo");
  yield* ensureDir(scratch);
  git(["init", "--initial-branch=main", "."], scratch, home);
  git(["config", "user.name", "Fixture"], scratch, home);
  git(["config", "user.email", "fixture@example.invalid"], scratch, home);
  yield* write(scratch, "scratch.txt", "scratch\n");
  git(["add", "scratch.txt"], scratch, home);
  git(["commit", "-m", "scratch"], scratch, home);

  return {
    root,
    home,
    c1,
    c2,
    gitlink: { before: gitlinkBefore, after: gitlinkAfter },
    sibling,
    run: (...args: string[]) => git(args, root, home),
    output: (...args: string[]) => gitOutput(args, root, home),
  };
}

/** A checkout whose branch has no commit yet, with one path staged. */
export interface UnbornCheckout {
  readonly root: string;
  readonly home: string;
  run(...args: string[]): string;
}

export function* useUnbornCheckout(): Operation<UnbornCheckout> {
  const home = yield* useTempDirectory("xmd-unborn-home-");
  const parent = yield* until(realpath(yield* useTempDirectory("xmd-unborn-")));
  const root = join(parent, "checkout");
  yield* ensureDir(root);
  git(["init", "--initial-branch=main", "."], root, home);
  git(["config", "user.name", "Fixture"], root, home);
  git(["config", "user.email", "fixture@example.invalid"], root, home);
  yield* write(root, "first.ts", "export const first = true;\n");
  git(["add", "--", "first.ts"], root, home);
  return { root, home, run: (...args: string[]) => git(args, root, home) };
}

/** A checkout stopped in the middle of a merge, with one unmerged path. */
export function* useConflictedCheckout(): Operation<UnbornCheckout> {
  const home = yield* useTempDirectory("xmd-conflict-home-");
  const parent = yield* until(realpath(yield* useTempDirectory("xmd-conflict-")));
  const root = join(parent, "checkout");
  yield* ensureDir(root);
  git(["init", "--initial-branch=main", "."], root, home);
  git(["config", "user.name", "Fixture"], root, home);
  git(["config", "user.email", "fixture@example.invalid"], root, home);
  yield* write(root, "shared.txt", "base\n");
  git(["add", "--", "shared.txt"], root, home);
  git(["commit", "-m", "base"], root, home);
  git(["checkout", "--quiet", "-b", "other"], root, home);
  yield* write(root, "shared.txt", "other\n");
  git(["commit", "--quiet", "-am", "other"], root, home);
  git(["checkout", "--quiet", "main"], root, home);
  yield* write(root, "shared.txt", "main\n");
  git(["commit", "--quiet", "-am", "main"], root, home);
  // A conflicted merge left in place: the index holds several stages for the
  // path, which is the one state a comparison reports as unmerged.
  try {
    git(["merge", "--no-edit", "other"], root, home);
  } catch {
    // The conflict is the fixture.
  }
  return { root, home, run: (...args: string[]) => git(args, root, home) };
}

/** Write one file inside a fixture, creating the directories it needs. */
export function writeFixtureFile(
  root: string,
  path: string,
  content: string | Uint8Array,
): Operation<void> {
  return write(root, path, content);
}

/** A checkout holding `count` generated tracked files, for the paging cases. */
export interface GeneratedFixture {
  readonly root: string;
  readonly home: string;
  /** Every tracked path, in the order a listing answers them. */
  readonly paths: readonly string[];
  run(...args: string[]): string;
  /** Run one Git command in the checkout, exactly as it printed. */
  output(...args: string[]): string;
}

export function* useGeneratedFixture(count: number): Operation<GeneratedFixture> {
  const home = yield* useTempDirectory("xmd-generated-home-");
  const parent = yield* until(realpath(yield* useTempDirectory("xmd-generated-")));
  const root = join(parent, "checkout");
  yield* ensureDir(root);
  git(["init", "--initial-branch=main", "."], root, home);
  git(["config", "user.name", "Fixture"], root, home);
  git(["config", "user.email", "fixture@example.invalid"], root, home);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = `gen/file-${String(index).padStart(5, "0")}.txt`;
    paths.push(path);
    yield* write(root, path, `generated ${index}\n`);
  }
  git(["add", "--", "gen"], root, home);
  git(["commit", "-m", "generated"], root, home);
  return {
    root,
    home,
    paths: Object.freeze([...paths].sort((left, right) => (left < right ? -1 : 1))),
    run: (...args: string[]) => git(args, root, home),
    output: (...args: string[]) => gitOutput(args, root, home),
  };
}

/** The musical symbol whose single code point is two UTF-16 code units. */
export const ASTRAL = "\u{1D11E}";

/**
 * A blob longer than the old proposed cap, with the astral character placed so
 * that a window counted in code units would cut it in half.
 *
 * 4095 one-unit characters, then the astral one, so the default 4096-code-point
 * window ends exactly after it — and a naive `slice(0, 4096)` would end exactly
 * inside it.
 */
export const LONG_BLOB = `${"a".repeat(4095)}${ASTRAL}${"b".repeat(61442)}\n`;

/** Bytes that are not valid UTF-8 and hold no NUL. */
export const MALFORMED = new Uint8Array([0x61, 0xff, 0xfe, 0x62]);

/** Bytes holding a NUL, which no text window can carry. */
export const WITH_NUL = new Uint8Array([0x61, 0x00, 0x62]);

export interface FileFixture {
  readonly root: string;
  readonly home: string;
  /** The commit holding the long blob, which every window reads from. */
  readonly f1: string;
  /** The commit after it, which replaced the long blob. */
  readonly f2: string;
  run(...args: string[]): string;
}

/** A checkout whose first commit holds exactly the blobs a file read needs. */
export function* useFileFixture(): Operation<FileFixture> {
  const home = yield* useTempDirectory("xmd-file-home-");
  const parent = yield* until(realpath(yield* useTempDirectory("xmd-file-")));
  const root = join(parent, "checkout");
  yield* ensureDir(root);
  git(["init", "--initial-branch=main", "."], root, home);
  git(["config", "user.name", "Fixture"], root, home);
  git(["config", "user.email", "fixture@example.invalid"], root, home);
  yield* write(root, "big.txt", LONG_BLOB);
  yield* write(root, "empty.txt", "");
  yield* write(root, "bad.bin", MALFORMED);
  yield* write(root, "nul.bin", WITH_NUL);
  yield* write(root, "dir/inside.txt", "inside\n");
  yield* until(symlink("big.txt", join(root, "points-at-big")));
  git(["add", "--", "."], root, home);
  git(["commit", "-m", "first"], root, home);
  const f1 = git(["rev-parse", "HEAD"], root, home);
  yield* write(root, "big.txt", "replaced\n");
  git(["add", "--", "big.txt"], root, home);
  git(["commit", "-m", "second"], root, home);
  const f2 = git(["rev-parse", "HEAD"], root, home);
  return { root, home, f1, f2, run: (...args: string[]) => git(args, root, home) };
}

/**
 * Configure this checkout so that every program a read could be made to run is
 * one that leaves evidence.
 *
 * External diff, text conversion, a clean filter, a process filter and a
 * file-system monitor. Each is a script that appends its own name to a marker
 * file, so "no sentinel executed" is an observation rather than an assumption:
 * if a read consulted the checkout's configuration, the marker would say which
 * one it reached.
 */
export function* useSentinelConfiguration(
  root: string,
  home: string,
): Operation<{ readonly marker: string; fired(): Operation<string[]> }> {
  const marker = join(root, "..", "sentinel.log");
  const script = join(root, "..", "sentinel.sh");
  yield* until(
    writeFile(
      script,
      ["#!/bin/sh", `printf '%s\\n' "$SENTINEL_NAME" >> ${JSON.stringify(marker)}`, "exit 0", ""].join(
        "\n",
      ),
    ),
  );
  yield* until(chmod(script, 0o755));
  const named = (name: string): string => `env SENTINEL_NAME=${name} ${script}`;
  git(["config", "diff.external", named("diff-external")], root, home);
  git(["config", "diff.sentinel.textconv", named("textconv")], root, home);
  git(["config", "filter.sentinel.clean", named("filter-clean")], root, home);
  git(["config", "filter.sentinel.smudge", named("filter-smudge")], root, home);
  git(["config", "filter.sentinel.process", named("filter-process")], root, home);
  git(["config", "core.fsmonitor", named("fsmonitor")], root, home);
  git(["config", "core.hooksPath", join(root, "..", "hooks")], root, home);
  git(["config", "credential.helper", named("credential")], root, home);
  git(["config", "gpg.program", named("gpg")], root, home);
  yield* write(root, ".gitattributes", "*.txt diff=sentinel filter=sentinel\n");
  git(["add", "--", ".gitattributes"], root, home);
  git(["commit", "-m", "sentinels"], root, home);
  // The fixture's own commands ran with these settings in place, so whatever
  // they fired is the baseline. It is removed here, before any read, so what
  // the marker holds afterwards is what a read did.
  yield* rm(marker, { force: true });
  return {
    marker,
    *fired(): Operation<string[]> {
      if (!(yield* exists(marker))) {
        return [];
      }
      const content = yield* readTextFile(marker);
      return content.split("\n").filter((line) => line !== "");
    },
  };
}

/** A linked checkout of the fixture's repository, beside its primary one. */
export function* useLinkedWorktree(fixture: ObservationFixture): Operation<UnbornCheckout> {
  const root = join(fixture.root, "..", "linked");
  fixture.run("worktree", "add", "--quiet", "-b", "linked", root);
  const resolved = yield* until(realpath(root));
  return {
    root: resolved,
    home: fixture.home,
    run: (...args: string[]) => git(args, resolved, fixture.home),
  };
}

/**
 * Everything one checkout holds, as one digest.
 *
 * Every file beneath the root, the Git administration directory included, by
 * path, mode and bytes. A symbolic link contributes its target rather than
 * whatever it points at. Access times are not read at all, so a read that only
 * looked at a file cannot move this digest — and a read that wrote one byte
 * anywhere cannot help moving it.
 */
export function* fingerprintCheckout(root: string): Operation<string> {
  const digest = createHash("sha256");
  for (const path of (yield* collectPaths(root, "")).sort()) {
    const absolute = join(root, path);
    const info = yield* lstat(absolute);
    digest.update(path);
    digest.update(String(info.mode));
    if (info.isSymbolicLink()) {
      digest.update(yield* until(readlink(absolute)));
      continue;
    }
    if (info.isFile()) {
      digest.update(yield* until(readFile(absolute)));
    }
  }
  return digest.digest("hex");
}

function* collectPaths(root: string, prefix: string): Operation<string[]> {
  const found: string[] = [];
  for (const name of yield* readdir(join(root, prefix))) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const info = yield* lstat(join(root, path));
    found.push(path);
    if (info.isDirectory()) {
      found.push(...(yield* collectPaths(root, path)));
    }
  }
  return found;
}

/** The exact bytes of the primary index, a linked index and every shared one. */
export function* indexFingerprints(
  fixture: ObservationFixture,
  linked: UnbornCheckout,
): Operation<Record<string, string>> {
  const common = join(fixture.root, ".git");
  const found: Record<string, string> = {};
  const digest = function* (path: string): Operation<void> {
    if (!(yield* exists(path))) {
      return;
    }
    found[path.slice(common.length)] = createHash("sha256")
      .update(yield* until(readFile(path)))
      .digest("hex");
  };
  yield* digest(join(common, "index"));
  for (const name of yield* readdir(common)) {
    if (name.startsWith("sharedindex.")) {
      yield* digest(join(common, name));
    }
  }
  for (const name of yield* readdir(join(common, "worktrees"))) {
    yield* digest(join(common, "worktrees", name, "index"));
  }
  return found;
}

/** A component that performs one host action where a document writes it. */
export function actionProbe(
  name: string,
  run: () => Operation<void>,
): ComponentRegistration {
  return {
    name,
    origin: `test://${name.toLowerCase()}`,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<string> {
      yield* run();
      return "";
    },
  };
}

/** A component that records exactly the value a document bound and projected. */
export function capturingProbe(seen: Json[], name = "Captured"): ComponentRegistration {
  return {
    name,
    origin: `test://${name.toLowerCase()}`,
    props: {
      type: "object",
      properties: { value: {} },
      required: ["value"],
      additionalProperties: false,
    },
    // deno-lint-ignore require-yield
    *fn(props: Record<string, Json>): Operation<string> {
      seen.push(props.value ?? null);
      return "";
    },
  };
}
