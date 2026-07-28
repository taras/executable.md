/**
 * Tier XC — `API.Env.command`, the invocation of the running xmd.
 *
 * The contract is asserted where it is observable: through the operation
 * itself, and through an entrypoint that has to relaunch a real worker. The
 * per-host argument order lives inside each entrypoint's own middleware and is
 * proven by that relaunch succeeding, not by inspecting an array.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
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
  it("XC1: with no adapter installed, command reports that rather than guessing", function* () {
    let message = "";
    try {
      yield* command(["test-agent"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("xmd command not installed");
  });

  it("XC2: an adapter appends the arguments it is given", function* () {
    yield* API.Env.around(
      {
        *command([args = []]) {
          return ["stub-xmd", ...args];
        },
      },
      { at: "min" },
    );
    expect(yield* command(["test-agent"])).toEqual(["stub-xmd", "test-agent"]);
    expect(yield* command()).toEqual(["stub-xmd"]);
  });

  it("XC3: ordinary middleware wraps the entrypoint's base provider", function* () {
    const seen: string[][] = [];
    yield* API.Env.around(
      {
        *command([args = []]) {
          return ["base-xmd", ...args];
        },
      },
      { at: "min" },
    );
    yield* API.Env.around({
      *command([args = []], next) {
        seen.push(args);
        return yield* next(args);
      },
    });
    expect(yield* command(["test-agent"])).toEqual(["base-xmd", "test-agent"]);
    expect(seen).toEqual([["test-agent"]]);
  });

  it("XC4: the Deno entrypoint relaunches a worker from another directory", function* () {
    // Argument placement is proven by the worker actually starting: the
    // relaunch command is what spawns it. Running from a scratch directory
    // also exercises the entry path, which comes from import.meta.url and so
    // stays valid wherever the CLI was started.
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
