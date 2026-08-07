import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import {
  ChangedPathsError,
  parseNameStatus,
  parsePorcelain,
  touches,
} from "../lib/changed-paths.ts";

/** Exactly what git writes, NULs and all. */
function records(...fields: string[]): string {
  return `${fields.join("\0")}\0`;
}

describe("parsePorcelain", () => {
  it("reads the status as a fixed prefix of the first field", function* () {
    expect(parsePorcelain(records("M  site/page.md"))).toEqual(["site/page.md"]);
  });

  it("takes both paths of a rename, new first", function* () {
    expect(parsePorcelain(records("R  moved-out.md", "site/page.md"))).toEqual([
      "moved-out.md",
      "site/page.md",
    ]);
  });

  it("takes both paths of a copy, which status.renames=copies produces", function* () {
    expect(parsePorcelain(records("C  site/copy2.md", "keep.md"))).toEqual([
      "site/copy2.md",
      "keep.md",
    ]);
  });

  it("reads a rename recorded in the worktree column", function* () {
    expect(parsePorcelain(records(" R site/page.md", "old.md"))).toEqual([
      "site/page.md",
      "old.md",
    ]);
  });

  it("reads the deletion and the untracked file an unstaged rename really produces", function* () {
    expect(parsePorcelain(records(" D site/page.md", "?? moved-out.md"))).toEqual([
      "site/page.md",
      "moved-out.md",
    ]);
  });

  it("keeps a path containing spaces whole", function* () {
    expect(parsePorcelain(records("A  site/two words.md"))).toEqual(["site/two words.md"]);
  });

  it("keeps a path containing a newline and a quote whole", function* () {
    expect(parsePorcelain(records('A  site/two\nlines".md'))).toEqual(['site/two\nlines".md']);
  });

  it("is empty for a clean worktree", function* () {
    expect(parsePorcelain("")).toEqual([]);
  });

  it("refuses a status it cannot read rather than dropping a path", function* () {
    expect(() => parsePorcelain(records("ZZ site/page.md"))).toThrow(ChangedPathsError);
  });

  it("refuses a rename that arrived without its second path", function* () {
    expect(() => parsePorcelain(records("R  moved-out.md"))).toThrow(ChangedPathsError);
  });
});

describe("parseNameStatus", () => {
  it("reads a status field and one path", function* () {
    expect(parseNameStatus(records("M", "site/page.md"))).toEqual(["site/page.md"]);
  });

  it("takes both paths of a rename, old first", function* () {
    expect(parseNameStatus(records("R100", "site/page.md", "moved-out.md"))).toEqual([
      "site/page.md",
      "moved-out.md",
    ]);
  });

  it("takes both paths of a copy", function* () {
    expect(parseNameStatus(records("C100", "site/renamed.md", "site/copy.md"))).toEqual([
      "site/renamed.md",
      "site/copy.md",
    ]);
  });

  it("reads the add and delete pair diff.renames=false produces", function* () {
    expect(parseNameStatus(records("D", "site/page.md", "A", "moved-out.md"))).toEqual([
      "site/page.md",
      "moved-out.md",
    ]);
  });

  it("reads several records in one output", function* () {
    const output = records("A", "a.md", "R100", "site/b.md", "c.md", "D", "d.md");
    expect(parseNameStatus(output)).toEqual(["a.md", "site/b.md", "c.md", "d.md"]);
  });

  it("refuses a status it cannot read", function* () {
    expect(() => parseNameStatus(records("ZZZ", "a.md"))).toThrow(ChangedPathsError);
  });

  it("refuses a rename missing its second path", function* () {
    expect(() => parseNameStatus(records("R100", "site/page.md"))).toThrow(ChangedPathsError);
  });
});

describe("touches", () => {
  it("sees a path under the directory", function* () {
    expect(touches(["site/page.md"], "site")).toBe(true);
  });

  it("does not mistake a sibling prefix for the directory", function* () {
    expect(touches(["sitemap.md", "site-notes/a.md"], "site")).toBe(false);
  });

  it("sees either side of a rename out of the directory", function* () {
    expect(touches(["moved-out.md", "site/page.md"], "site")).toBe(true);
  });
});
