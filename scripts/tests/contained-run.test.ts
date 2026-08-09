import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn } from "effection";
import type { Operation } from "effection";
import { rm } from "@effectionx/fs";
import { when } from "@effectionx/converge";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { containedRun } from "../lib/contained-run.ts";

const CWD = new URL("../../", import.meta.url).pathname;

/** A directory of the calling operation's own, gone when that operation shuts down. */
function* scratchDirectory(prefix: string): Operation<string> {
  // @effectionx/fs has no mkdtemp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  yield* ensure(() => rm(base, { recursive: true, force: true }));
  return base;
}

describe("contained-run", () => {
  it("returns the exit status and captured stderr of a failed command", function* () {
    const exit = yield* containedRun(
      Deno.execPath(),
      ["eval", "console.error('boom'); Deno.exit(3);"],
      { cwd: CWD },
    );

    expect(exit.code).toBe(3);
    expect(exit.stderr).toContain("boom");
  });

  it("completes a successful command", function* () {
    const exit = yield* containedRun(Deno.execPath(), ["eval", "Deno.exit(0);"], { cwd: CWD });

    expect(exit).toEqual({ code: 0, signal: null, stderr: "" });
  });

  /**
   * The property `bundleClient` stands on: cleanup registered before the
   * command starts must observe the command's whole process tree already
   * gone — a grandchild included, because the bundler's own grandchild is
   * the esbuild service that writes the output file.
   *
   * The grandchild inherits the child's piped stderr and would run forever,
   * so the scope releasing at all proves the terminate reached the whole
   * group, and the marker it writes while shutting down proves the join
   * finished before the earlier-registered cleanup ran.
   */
  it("terminates and joins the whole tree before earlier-registered cleanup runs", function* () {
    const base = yield* scratchDirectory("contained-run-");
    const ready = path.join(base, "ready");
    const terminated = path.join(base, "terminated");
    const grandchild = `
      Deno.writeTextFileSync(${JSON.stringify(ready)}, "ready");
      Deno.addSignalListener("SIGTERM", () => {
        Deno.writeTextFileSync(${JSON.stringify(terminated)}, "terminated");
        Deno.exit(0);
      });
      setInterval(() => {}, 1000);
    `;
    const child = `
      const grandchild = new Deno.Command(Deno.execPath(), {
        args: ["eval", ${JSON.stringify(grandchild)}],
        stdin: "null",
        stdout: "null",
        stderr: "inherit",
      }).spawn();
      await grandchild.status;
    `;
    const observed: string[] = [];

    yield* scoped(function* () {
      yield* ensure(() => {
        observed.push(fs.existsSync(terminated) ? "tree gone" : "tree still alive");
      });
      yield* spawn(function* () {
        yield* containedRun(Deno.execPath(), ["eval", child], { cwd: CWD });
      });
      yield* when(
        function* () {
          if (!fs.existsSync(ready)) {
            throw new Error("the fixture tree has not started");
          }
        },
        { timeout: 30_000 },
      );
    });

    expect(observed).toEqual(["tree gone"]);
  });
});
