import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { join, posix, win32 } from "node:path";
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
import { exists } from "@effectionx/fs";
function withoutDiagnosticStyles(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("additional focused boundary 2", () => {
  it("allows diagnostic styling while preserving terminal-control escapes", function* () {
    const escape = String.fromCharCode(27);
    expect(withoutDiagnosticStyles(`${escape}[0m${escape}[32mDownload${escape}[0m package`)).toBe(
      "Download package",
    );
    for (const control of ["[?1049h", "[?25l", "[2J", "[H", "]0;title\u0007"]) {
      expect(withoutDiagnosticStyles(escape + control).includes(escape)).toBe(true);
    }
  });
  it("refuses invalid mount declarations before a history or terminal exists", function* () {
    const home = yield* useTempDirectory("mount-grammar-");
    const data = yield* useTempDirectory("mount-grammar-data-");
    for (const value of ["no-target", "source:/", "source:/bad/../target"]) {
      const result = yield* runCli(["repl", "--mount", value], {
        cwd: home,
        env: {
          HOME: home,
          XDG_DATA_HOME: data,
          LOCALAPPDATA: data,
          CI: "1",
          FORCE_COLOR: "1",
          TERM: "xterm-256color",
        },
        inheritEnv: false,
      }).join();
      expect(result.code).toBe(1);
      const parsed = parseWorkspaceMounts([value], home, posix);
      expect(parsed.ok).toBe(false);
      const diagnostic = withoutDiagnosticStyles(result.stderr);
      expect(diagnostic.trim().endsWith(parsed.ok ? "" : parsed.error.message)).toBe(true);
      expect(diagnostic.includes(String.fromCharCode(27))).toBe(false);
      expect(result.stdout).toBe("");
    }
    // Child runtimes may populate their own caches; application data stays absent.
    for (const root of [
      data,
      join(home, ".local", "share"),
      join(home, "Library", "Application Support"),
      join(home, "AppData", "Local"),
    ]) {
      expect(yield* exists(join(root, "xmd"))).toBe(false);
    }
    expect(yield* exists(join(home, ".xmd"))).toBe(false);
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
