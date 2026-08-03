import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { changeSet, GitChangeError, parseNameStatus, parseUntracked } from "../lib/git-changes.ts";
import { scratchRepo } from "./scratch-repo.ts";

/** Exactly what `git diff --name-status -z -M -C` writes, NULs and all. */
function records(...fields: string[]): string {
  return `${fields.join("\0")}\0`;
}

describe("parseNameStatus", () => {
  it("reads a status and its path from separate fields", function* () {
    expect(parseNameStatus(records("M", "src/a.ts"))).toEqual([
      { path: "src/a.ts", kind: "modified" },
    ]);
  });

  it("takes both paths of a rename, and calls the old one deleted", function* () {
    expect(parseNameStatus(records("R100", "old.ts", "new.ts"))).toEqual([
      { path: "new.ts", kind: "added" },
      { path: "old.ts", kind: "deleted" },
    ]);
  });

  it("takes only the new path of a copy, because the source still exists", function* () {
    expect(parseNameStatus(records("C100", "src/a.ts", "src/copy.ts"))).toEqual([
      { path: "src/copy.ts", kind: "added" },
    ]);
  });

  it("keeps a path containing a newline in one piece", function* () {
    expect(parseNameStatus(records("A", "src/two\nlines.ts"))).toEqual([
      { path: "src/two\nlines.ts", kind: "added" },
    ]);
  });

  it("reads several records in one output", function* () {
    const output = records("A", "copy.ts", "R100", "old.ts", "new.ts", "D", "gone.ts");
    expect(parseNameStatus(output).map((change) => change.path)).toEqual([
      "copy.ts",
      "new.ts",
      "old.ts",
      "gone.ts",
    ]);
  });

  it("refuses a status it cannot classify rather than dropping the path", function* () {
    expect(() => parseNameStatus(records("U", "conflicted.ts"))).toThrow(GitChangeError);
  });

  it("refuses a rename that arrived without both paths", function* () {
    expect(() => parseNameStatus(records("R100", "old.ts"))).toThrow(GitChangeError);
  });
});

describe("parseUntracked", () => {
  it("reads NUL-delimited paths", function* () {
    expect(parseUntracked("a.ts\0b/c.ts\0")).toEqual([
      { path: "a.ts", kind: "added" },
      { path: "b/c.ts", kind: "added" },
    ]);
  });

  it("is empty for no output", function* () {
    expect(parseUntracked("")).toEqual([]);
  });
});

describe("changeSet", () => {
  it("unions committed, staged, unstaged, and untracked changes", function* () {
    const repo = yield* scratchRepo("git-changes");
    yield* repo.write("kept.ts", "export const kept = 1;\n");
    yield* repo.write("staged.ts", "export const staged = 1;\n");
    yield* repo.write("unstaged.ts", "export const unstaged = 1;\n");
    yield* repo.commit("base");
    yield* repo.git("branch", "base");

    yield* repo.write("committed.ts", "export const committed = 1;\n");
    yield* repo.commit("branch work");

    yield* repo.write("staged.ts", "export const staged = 2;\n");
    yield* repo.git("add", "staged.ts");
    yield* repo.write("unstaged.ts", "export const unstaged = 2;\n");
    yield* repo.write("untracked.ts", "export const untracked = 1;\n");

    const found = yield* changeSet(repo.root, "base");
    expect(found.changes.map((change) => change.path)).toEqual([
      "committed.ts",
      "staged.ts",
      "unstaged.ts",
      "untracked.ts",
    ]);
  });

  it("compares against the merge base, not the tip of the base branch", function* () {
    const repo = yield* scratchRepo("git-changes-base");
    yield* repo.write("shared.ts", "export const shared = 1;\n");
    yield* repo.commit("base");
    yield* repo.git("checkout", "-qb", "feature");
    yield* repo.write("feature.ts", "export const feature = 1;\n");
    yield* repo.commit("feature work");

    yield* repo.git("checkout", "-q", "main");
    yield* repo.write("main-only.ts", "export const main = 1;\n");
    yield* repo.commit("main moves on");
    yield* repo.git("checkout", "-q", "feature");

    const found = yield* changeSet(repo.root, "main");
    expect(found.changes.map((change) => change.path)).toEqual(["feature.ts"]);
  });

  it("reports both sides of a committed rename", function* () {
    const repo = yield* scratchRepo("git-changes-rename");
    yield* repo.write("site/old.ts", "export const value = 1;\n");
    yield* repo.commit("base");
    yield* repo.git("branch", "base");

    yield* repo.git("mv", "site/old.ts", "moved.ts");
    yield* repo.commit("rename out of site/");

    const found = yield* changeSet(repo.root, "base");
    expect(found.changes).toEqual([
      { path: "moved.ts", kind: "added" },
      { path: "site/old.ts", kind: "deleted" },
    ]);
  });

  it("reports a worktree deletion", function* () {
    const repo = yield* scratchRepo("git-changes-delete");
    yield* repo.write("gone.ts", "export const gone = 1;\n");
    yield* repo.commit("base");
    yield* repo.git("branch", "base");
    yield* repo.remove("gone.ts");

    const found = yield* changeSet(repo.root, "base");
    expect(found.changes).toEqual([{ path: "gone.ts", kind: "deleted" }]);
  });

  it("never reports an ignored path", function* () {
    const repo = yield* scratchRepo("git-changes-ignored");
    yield* repo.write(".gitignore", "generated/\n");
    yield* repo.commit("base");
    yield* repo.git("branch", "base");
    yield* repo.write("generated/bundle.ts", "export const bundle = 1;\n");

    const found = yield* changeSet(repo.root, "base");
    expect(found.changes).toEqual([]);
  });

  it("fails rather than reporting no changes when the base cannot be resolved", function* () {
    const repo = yield* scratchRepo("git-changes-missing-base");
    yield* repo.write("a.ts", "export const a = 1;\n");
    yield* repo.commit("base");

    let raised: unknown;
    try {
      yield* changeSet(repo.root, "origin/nope");
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(GitChangeError);
  });
});
