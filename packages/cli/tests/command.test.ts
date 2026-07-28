/**
 * Tier XC — how each runtime re-invokes this CLI (`API.Env.command`).
 *
 * The builders are asserted directly because the entrypoints that use them
 * are scripts: importing one runs the CLI. Each entrypoint's own wiring is
 * covered end-to-end by the test-agent suites, which relaunch a real worker.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { API, command } from "@executablemd/runtime";
import { bunCommand, compiledCommand, denoCommand, nodeCommand } from "../src/commands.ts";

const ENTRY = "/abs/path/to/entry.ts";

/** Inherit the environment so the child resolves the same Deno install. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

describe("Tier XC — the xmd command", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("XC1: every runtime places supplied arguments after its entry module", function* () {
    expect(denoCommand("/bin/deno", ENTRY, ["test-agent"])).toEqual([
      "/bin/deno",
      "run",
      "--allow-all",
      ENTRY,
      "test-agent",
    ]);
    expect(nodeCommand("/bin/node", [], ENTRY, ["test-agent"])).toEqual([
      "/bin/node",
      ENTRY,
      "test-agent",
    ]);
    expect(bunCommand("/bin/bun", ENTRY, ["test-agent"])).toEqual([
      "/bin/bun",
      ENTRY,
      "test-agent",
    ]);
    // The binary carries its own entry module, so there is no path to name.
    expect(compiledCommand("/bin/xmd", ["test-agent"])).toEqual(["/bin/xmd", "test-agent"]);
  });

  it("XC2: the base invocation carries no subcommand", function* () {
    expect(denoCommand("/bin/deno", ENTRY, [])).toEqual(["/bin/deno", "run", "--allow-all", ENTRY]);
    expect(compiledCommand("/bin/xmd", [])).toEqual(["/bin/xmd"]);
  });

  it("XC3: `test-agent` appears exactly once in the worker invocation", function* () {
    const worker = denoCommand("/bin/deno", ENTRY, ["test-agent"]);
    expect(worker.filter((segment) => segment === "test-agent")).toHaveLength(1);
  });

  it("XC4: node keeps its loader flags but drops --inspect", function* () {
    const worker = nodeCommand(
      "/bin/node",
      ["--import", "tsx", "--inspect=9229", "--inspect-brk"],
      ENTRY,
      ["test-agent"],
    );
    expect(worker).toEqual(["/bin/node", "--import", "tsx", ENTRY, "test-agent"]);
  });

  it("XC5: with no adapter installed, command reports that rather than guessing", function* () {
    let message = "";
    try {
      yield* command(["test-agent"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("xmd command not installed");
  });

  it("XC6: middleware can override the command", function* () {
    yield* API.Env.around({
      *command([args = []], next) {
        void next;
        return ["stub-xmd", ...args];
      },
    });
    expect(yield* command(["test-agent"])).toEqual(["stub-xmd", "test-agent"]);
    expect(yield* command()).toEqual(["stub-xmd"]);
  });

  it("XC7: the worker launches when xmd runs from another directory", function* () {
    // The entrypoint path comes from import.meta.url, so it stays valid
    // wherever the CLI was started. Running from a scratch directory — with
    // both the entry module and the document named absolutely — exercises
    // that end to end: a relaunch command built from a working-directory
    // relative path would fail to spawn here.
    const elsewhere = path.join(os.tmpdir(), `xmd-xc-${randomUUID()}`);
    yield* ensureDir(elsewhere);
    yield* ensure(() => rm(elsewhere, { recursive: true, force: true }));

    const result = yield* timebox<ProcessResult>(180_000, function* () {
      return yield* exec("deno", {
        arguments: [
          "run",
          "--allow-all",
          path.resolve("packages/cli/src/deno.ts"),
          "test",
          path.resolve("smoke-test/test-agent/README.md"),
        ],
        cwd: elsewhere,
        env: cliEnv(),
      }).join();
    });
    if (result.timeout) {
      throw new Error("the CLI timed out");
    }
    expect(result.value.code).toBe(0);
    expect(result.value.stdout).toContain("The review of **packages/core** passed.");
  });
});
