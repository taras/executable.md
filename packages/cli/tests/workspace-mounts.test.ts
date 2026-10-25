import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { posix, win32 } from "node:path";
import { parseWorkspaceMounts } from "../src/workspace-mounts.ts";

describe("workspace mount table", () => {
  it("requires disjoint explicit document targets and resolves sources once", function* () {
    const parsed = parseWorkspaceMounts(
      ["../manuals:/reference/./", "fixtures:/fixtures"],
      "/work/app",
      posix,
    );
    expect(parsed.ok && parsed.value).toEqual([
      { source: "/work/app/fixtures", target: "/fixtures" },
      { source: "/work/manuals", target: "/reference" },
    ]);
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
    for (const input of [
      "source",
      "source:",
      "source:/",
      "source://root",
      "source:/a/../b",
      "source:/a\\b",
      "source:/a:b",
    ]) {
      expect(parseWorkspaceMounts([input], "/work", posix).ok).toBe(false);
    }
    for (const target of ["/a", "/a/b"]) {
      expect(parseWorkspaceMounts(["one:/a", `two:${target}`], "/work", posix).ok).toBe(false);
    }
    expect(parseWorkspaceMounts(["C:\\manuals:/reference"], "C:\\work", win32)).toEqual({
      ok: true,
      value: [{ source: "C:\\manuals", target: "/reference" }],
    });
  });
});

import { replGrammarError } from "../src/cli.ts";
describe("additional focused boundary 1", () => {
  it("admits both repeatable flag spellings before host preparation", function* () {
    expect(
      replGrammarError(
        ["repl", "--mount", "manuals:/reference", "--mount=fixtures:/fixtures"],
        undefined,
      ),
    ).toBeUndefined();
    for (const args of [["--mount"], ["--mount="], ["--unknown", "x"]]) {
      expect(replGrammarError(["repl", ...args], undefined)).toBeDefined();
    }
  });
});

import { runCli } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { readdir } from "@effectionx/fs";
describe("additional focused boundary 2", () => {
  it("refuses invalid mount declarations before a history or terminal exists", function* () {
    const home = yield* useTempDirectory("mount-grammar-");
    const before = yield* readdir(home);
    for (const value of ["no-target", "source:/", "source:/bad/../target"]) {
      const result = yield* runCli(["repl", "--mount", value], {
        cwd: home,
        env: { HOME: home },
        inheritEnv: false,
      }).join();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--mount");
    }
    expect(yield* readdir(home)).toEqual(before);
  });
});
describe("additional focused boundary 3", () => {
  it("advertises repeated explicit mount targets in real REPL help", function* () {
    const result = yield* runCli(["repl", "--help"]).join();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--mount");
    expect(result.stdout).toContain("SOURCE:TARGET");
  });
});
