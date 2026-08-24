/**
 * The runtime scope is derived, so nothing here asserts which files run. These
 * cover discovery drift and malformed exclusions. Whether an exclusion is still
 * necessary is not something they can determine — see the manifest.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists } from "@effectionx/fs";
import { applicableTestFiles, listTestFiles, relativeWithin } from "../lib/test-files.ts";
import { exclusions, parseRuntime, RUNTIMES } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";
import { exitCode, oneFileCommand } from "../lib/runtime-tests.ts";

const ROOT = new URL("../../", import.meta.url);

/** The runtimes that record exclusions; Deno records none by design. */
const EXCLUDING: Runtime[] = ["node", "bun"];

describe("test discovery", () => {
  it("returns sorted repository-relative paths", function* () {
    const files = yield* listTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    for (const file of files) {
      expect(file.startsWith("/")).toBe(false);
      // A Windows drive letter is absolute too, and would otherwise slip past.
      expect(file).not.toMatch(/^[A-Za-z]:/);
      expect(file).toContain("/tests/");
      expect(file.endsWith(".test.ts")).toBe(true);
    }
  });

  it("returns the same list on repeated calls", function* () {
    expect(yield* listTestFiles(ROOT)).toEqual(yield* listTestFiles(ROOT));
  });

  it("finds this file", function* () {
    expect(yield* listTestFiles(ROOT)).toContain("scripts/tests/runtime-exclusions.test.ts");
  });

  it("leaves the deliberately malformed fixtures out", function* () {
    const files = yield* listTestFiles(ROOT);
    expect(files.some((file) => file.includes("/fixtures/"))).toBe(false);
  });
});

describe("path normalization", () => {
  it("relativizes a POSIX path", function* () {
    expect(
      relativeWithin("/repo/packages/core/tests/", "/repo/packages/core/tests/a.test.ts"),
    ).toBe("a.test.ts");
  });

  it("relativizes a Windows path against the base @effectionx/fs reports", function* () {
    // toPath() yields C:/repo/... while walk() yields C:\repo\...; comparing a
    // URL pathname instead would leave the result absolute.
    expect(
      relativeWithin("C:/repo/packages/core/tests", "C:\\repo\\packages\\core\\tests\\a.test.ts"),
    ).toBe("a.test.ts");
  });

  it("keeps nested directories", function* () {
    expect(relativeWithin("/repo/tests/", "/repo/tests/deep/b.test.ts")).toBe("deep/b.test.ts");
  });

  it("refuses an entry outside the walked directory", function* () {
    expect(() => relativeWithin("/repo/tests/", "/elsewhere/c.test.ts")).toThrow();
    // A sibling sharing the prefix is still outside it.
    expect(() => relativeWithin("/repo/tests/", "/repo/tests-extra/d.test.ts")).toThrow();
  });
});

describe("runtime exclusions", () => {
  it("keys every supported runtime, and Deno excludes only the binary's suite", function* () {
    expect(Object.keys(exclusions).sort()).toEqual([...RUNTIMES].sort());

    // Deno's list is not empty and not portability-shaped. The shards run
    // source; one suite's subject is the compiled `dist/xmd`, which only the
    // `smoke` job builds. Anything else appearing here means a Deno test was
    // dropped for a reason this manifest has not stated.
    expect(exclusions.deno.map((entry) => entry.path)).toEqual([
      "scripts/tests/component-form-dispatch.test.ts",
    ]);
  });

  it("lists each path once per runtime", function* () {
    for (const runtime of RUNTIMES) {
      const paths = exclusions[runtime].map((entry) => entry.path);
      expect(paths).toEqual([...new Set(paths)]);
    }
  });

  it("excludes only files that exist and that discovery finds", function* () {
    const discovered = new Set(yield* listTestFiles(ROOT));
    for (const runtime of RUNTIMES) {
      for (const entry of exclusions[runtime]) {
        expect(yield* exists(new URL(entry.path, ROOT))).toBe(true);
        expect(discovered.has(entry.path)).toBe(true);
      }
    }
  });

  it("gives every exclusion a reason and an issue", function* () {
    for (const runtime of EXCLUDING) {
      expect(exclusions[runtime].length).toBeGreaterThan(0);
      for (const entry of exclusions[runtime]) {
        expect(entry.reason.trim().length).toBeGreaterThan(0);
        expect(entry.issue).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/);
      }
    }
  });

  it("names nothing that is not a supported runtime", function* () {
    for (const runtime of Object.keys(exclusions)) {
      expect(parseRuntime(runtime)).toEqual(runtime);
    }
    expect(parseRuntime("node22")).toBeUndefined();
    expect(parseRuntime("")).toBeUndefined();
  });
});

describe("the applicable corpus", () => {
  it("is discovery minus exactly that runtime's manifest, still sorted", function* () {
    const discovered = yield* listTestFiles(ROOT);

    for (const runtime of RUNTIMES) {
      const excluded = new Set(exclusions[runtime].map((entry) => entry.path));
      const applicable = yield* applicableTestFiles(runtime, ROOT);

      expect(applicable).toEqual(discovered.filter((file) => !excluded.has(file)));
      expect(applicable).toEqual([...applicable].sort());
      expect(applicable.filter((file) => excluded.has(file))).toEqual([]);
    }
  });

  it("gives Deno the whole discovered corpus but its own manifest", function* () {
    const excluded = new Set(exclusions.deno.map((entry) => entry.path));
    expect(yield* applicableTestFiles("deno", ROOT)).toEqual(
      (yield* listTestFiles(ROOT)).filter((file) => !excluded.has(file)),
    );
  });

  /**
   * Every runtime derives from one discovered set, so a file can only be missing
   * from a runtime by being named in that runtime's manifest.
   */
  it("drops a file from a runtime only through the manifest", function* () {
    const discovered = yield* listTestFiles(ROOT);

    for (const runtime of RUNTIMES) {
      const applicable = new Set(yield* applicableTestFiles(runtime, ROOT));
      const dropped = discovered.filter((file) => !applicable.has(file));

      expect(dropped).toEqual(exclusions[runtime].map((entry) => entry.path).sort());
    }
  });
});

describe("the one-file runner commands", () => {
  it("runs a single file alone under each runtime", function* () {
    expect(oneFileCommand("deno", "packages/core/tests/a.test.ts")).toEqual({
      command: "deno",
      arguments: ["test", "--allow-all", "--frozen", "packages/core/tests/a.test.ts"],
    });
    expect(oneFileCommand("node", "packages/core/tests/a.test.ts")).toEqual({
      command: "tsx",
      arguments: [
        "--tsconfig",
        "tsconfig.node.json",
        "--test",
        "--test-concurrency=1",
        "packages/core/tests/a.test.ts",
      ],
    });
    expect(oneFileCommand("bun", "packages/core/tests/a.test.ts")).toEqual({
      command: "bun",
      arguments: ["test", "--timeout=300000", "packages/core/tests/a.test.ts"],
    });
  });
});

describe("launcher exit status", () => {
  it("propagates the child's code", function* () {
    expect(exitCode({ code: 0 })).toBe(0);
    expect(exitCode({ code: 1 })).toBe(1);
    expect(exitCode({ code: 7 })).toBe(7);
  });

  it("reports failure when a signal left no code", function* () {
    expect(exitCode({ code: null })).toBe(1);
    expect(exitCode({})).toBe(1);
  });
});
