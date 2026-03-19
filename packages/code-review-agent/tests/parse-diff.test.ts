/**
 * Tests for parseDiff — unified diff parser.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "expect";
import { parseDiff } from "../src/parse-diff.ts";

const META = { title: "Test PR", body: "Test body", number: "42" };

describe("parseDiff", () => {
  it("parses a simple added file", function* () {
    const rawDiff = [
      "diff --git a/src/hello.ts b/src/hello.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/hello.ts",
      "@@ -0,0 +1,3 @@",
      "+export function hello() {",
      '+  return "hello";',
      "+}",
    ].join("\n");
    const rawFiles = "A\tsrc/hello.ts";

    const pr = parseDiff(rawDiff, rawFiles, META);

    expect(pr.files).toHaveLength(1);
    expect(pr.files[0].path).toBe("src/hello.ts");
    expect(pr.files[0].status).toBe("A");
    expect(pr.files[0].language).toBe("typescript");
    expect(pr.files[0].isTest).toBe(false);
    expect(pr.files[0].isConfig).toBe(false);
    expect(pr.created).toHaveLength(1);
    expect(pr.stats.additions).toBe(3);
    expect(pr.stats.deletions).toBe(0);
    expect(pr.stats.totalFiles).toBe(1);
  });

  it("parses modified and deleted files", function* () {
    const rawDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " const x = 1;",
      "+const y = 2;",
      " export { x };",
      "diff --git a/src/b.ts b/src/b.ts",
      "deleted file mode 100644",
      "--- a/src/b.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-const old = true;",
      "-export { old };",
    ].join("\n");
    const rawFiles = "M\tsrc/a.ts\nD\tsrc/b.ts";

    const pr = parseDiff(rawDiff, rawFiles, META);

    expect(pr.files).toHaveLength(2);
    expect(pr.modified).toHaveLength(1);
    expect(pr.deleted).toHaveLength(1);
    expect(pr.stats.additions).toBe(1);
    expect(pr.stats.deletions).toBe(2);
    expect(pr.stats.totalChanges).toBe(3);
  });

  it("handles rename detection", function* () {
    const rawDiff = [
      "diff --git a/old-name.ts b/new-name.ts",
      "similarity index 100%",
      "rename from old-name.ts",
      "rename to new-name.ts",
    ].join("\n");
    const rawFiles = "R100\told-name.ts\tnew-name.ts";

    const pr = parseDiff(rawDiff, rawFiles, META);

    // Renamed files produce a file entry with R status and zero hunks
    expect(pr.files).toHaveLength(1);
    expect(pr.files[0].path).toBe("new-name.ts");
    expect(pr.files[0].status).toBe("R");
    expect(pr.files[0].hunks).toHaveLength(0);
    expect(pr.stats.totalChanges).toBe(0);
  });

  it("skips binary files", function* () {
    const rawDiff = [
      "diff --git a/image.png b/image.png",
      "new file mode 100644",
      "Binary files /dev/null and b/image.png differ",
    ].join("\n");
    const rawFiles = "A\timage.png";

    const pr = parseDiff(rawDiff, rawFiles, META);

    expect(pr.files).toHaveLength(0);
  });

  it("classifies test files", function* () {
    const rawDiff = [
      "diff --git a/src/hello.test.ts b/src/hello.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/hello.test.ts",
      "@@ -0,0 +1,1 @@",
      '+it("works", () => {});',
    ].join("\n");
    const rawFiles = "A\tsrc/hello.test.ts";

    const pr = parseDiff(rawDiff, rawFiles, META);

    expect(pr.files[0].isTest).toBe(true);
    expect(pr.added[0].isTest).toBe(true);
  });

  it("classifies config files", function* () {
    const rawDiff = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,1 +1,2 @@",
      ' { "name": "test"',
      '+, "version": "1.0.0" }',
    ].join("\n");
    const rawFiles = "M\tpackage.json";

    const pr = parseDiff(rawDiff, rawFiles, META);

    expect(pr.files[0].isConfig).toBe(true);
  });

  it("classifies type declarations", function* () {
    const rawDiff = [
      "diff --git a/types/global.d.ts b/types/global.d.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/types/global.d.ts",
      "@@ -0,0 +1,1 @@",
      "+declare const foo: string;",
    ].join("\n");
    const rawFiles = "A\ttypes/global.d.ts";

    const pr = parseDiff(rawDiff, rawFiles, META);

    expect(pr.files[0].isTypeDeclaration).toBe(true);
  });

  it("truncates diffPreview at 80K chars", function* () {
    const longLine = "x".repeat(100_000);
    const rawDiff = [
      "diff --git a/big.ts b/big.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/big.ts",
      "@@ -0,0 +1,1 @@",
      "+" + longLine,
    ].join("\n");
    const rawFiles = "A\tbig.ts";

    const pr = parseDiff(rawDiff, rawFiles, META);

    expect(pr.addedSource.length).toBe(100_000);
    expect(pr.diffPreview.length).toBe(80_000);
  });

  it("computes directories at depth 2", function* () {
    const rawDiff = [
      "diff --git a/src/components/a.ts b/src/components/a.ts",
      "--- /dev/null",
      "+++ b/src/components/a.ts",
      "@@ -0,0 +1,1 @@",
      "+const a = 1;",
      "diff --git a/src/utils/b.ts b/src/utils/b.ts",
      "--- /dev/null",
      "+++ b/src/utils/b.ts",
      "@@ -0,0 +1,1 @@",
      "+const b = 2;",
      "diff --git a/root.ts b/root.ts",
      "--- /dev/null",
      "+++ b/root.ts",
      "@@ -0,0 +1,1 @@",
      "+const c = 3;",
    ].join("\n");
    const rawFiles = "A\tsrc/components/a.ts\nA\tsrc/utils/b.ts\nA\troot.ts";

    const pr = parseDiff(rawDiff, rawFiles, META);

    expect(pr.directories.size).toBe(3);
    expect(pr.directories.has("src/components")).toBe(true);
    expect(pr.directories.has("src/utils")).toBe(true);
    expect(pr.directories.has(".")).toBe(true);
  });

  it("handles empty diff", function* () {
    const pr = parseDiff("", "", META);

    expect(pr.files).toHaveLength(0);
    expect(pr.added).toHaveLength(0);
    expect(pr.removed).toHaveLength(0);
    expect(pr.stats.totalChanges).toBe(0);
    expect(pr.meta.title).toBe("Test PR");
    expect(pr.meta.number).toBe("42");
  });

  it("preserves meta passthrough", function* () {
    const pr = parseDiff("", "", {
      title: "feat: add feature",
      body: "This PR adds a feature.\n\nFixes #123",
      number: "456",
    });

    expect(pr.meta.title).toBe("feat: add feature");
    expect(pr.meta.body).toContain("Fixes #123");
    expect(pr.meta.number).toBe("456");
  });

  it("infers languages correctly", function* () {
    const files = [
      "a.ts", "b.js", "c.py", "d.go", "e.md", "f.json",
      "g.yaml", "Dockerfile", "h.unknown",
    ];
    const rawDiff = files.map((f) => [
      `diff --git a/${f} b/${f}`,
      `--- /dev/null`,
      `+++ b/${f}`,
      `@@ -0,0 +1,1 @@`,
      `+content`,
    ].join("\n")).join("\n");
    const rawFiles = files.map((f) => `A\t${f}`).join("\n");

    const pr = parseDiff(rawDiff, rawFiles, META);

    const langs = new Map(pr.files.map((f) => [f.path, f.language]));
    expect(langs.get("a.ts")).toBe("typescript");
    expect(langs.get("b.js")).toBe("javascript");
    expect(langs.get("c.py")).toBe("python");
    expect(langs.get("d.go")).toBe("go");
    expect(langs.get("e.md")).toBe("markdown");
    expect(langs.get("f.json")).toBe("json");
    expect(langs.get("g.yaml")).toBe("yaml");
    expect(langs.get("Dockerfile")).toBe("docker");
    expect(langs.get("h.unknown")).toBe("unknown");
  });
});
