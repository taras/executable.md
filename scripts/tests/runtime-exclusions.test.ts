/**
 * The runtime scope is derived, so nothing here asserts which files run. These
 * cover the two things that can silently shrink coverage instead: discovery
 * drifting, and an exclusion outliving its reason.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists } from "@effectionx/fs";
import { listTestFiles } from "../lib/test-files.ts";
import { exclusions } from "../runtime-test-exclusions.ts";
import { exitCode } from "../lib/runtime-tests.ts";

const ROOT = new URL("../../", import.meta.url);
const RUNTIMES = ["node", "bun"];

describe("test discovery", () => {
  it("returns sorted repository-relative paths", function* () {
    const files = yield* listTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    for (const file of files) {
      expect(file.startsWith("/")).toBe(false);
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

describe("runtime exclusions", () => {
  it("names only runtimes the launcher runs", function* () {
    expect(Object.keys(exclusions).sort()).toEqual([...RUNTIMES].sort());
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
    for (const runtime of RUNTIMES) {
      for (const entry of exclusions[runtime]) {
        expect(entry.reason.trim().length).toBeGreaterThan(0);
        expect(entry.issue).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/);
      }
    }
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
