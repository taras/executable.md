/**
 * Foreground execution through the compiled binary (#441).
 *
 * The contract is about what a caller sees and what status they get, and only
 * the binary proves both survived `deno compile`. Two claims, each observed
 * from outside the process:
 *
 * 1. a command's output arrives while the run is still going, not at the end;
 * 2. a command that exits non-zero stops the document and the process exits
 *    non-zero, with no `<Output>` declaration anywhere.
 *
 * The first is timed against a gate rather than a duration: the document holds
 * itself open until this script sees the early bytes and releases it.
 */

import { main, suspend } from "effection";
import { call, ensure, race, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { when } from "@effectionx/converge";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BINARY = path.join(Deno.cwd(), "dist", "xmd");

function* useDirectory(): Operation<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xmd-smoke-fg-"));
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fail(claim: string): never {
  console.error(`foreground smoke: ${claim}`);
  Deno.exit(1);
}

await main(function* () {
  if (!(yield* exists(BINARY))) {
    fail(`no compiled binary at ${BINARY} — run \`deno task build\` first`);
  }

  const dir = yield* useDirectory();
  const release = path.join(dir, "release");

  // 1. Progressive output: the document cannot finish until this script has
  //    already seen its first bytes.
  yield* writeTextFile(
    path.join(dir, "progressive.md"),
    [
      "# Progressive",
      "",
      "```bash exec",
      `echo EARLY; while [ ! -f ${release} ]; do sleep 0.05; done; echo LATE`,
      "```",
      "",
    ].join("\n"),
  );

  const run = exec(BINARY, {
    arguments: ["run", path.join(dir, "progressive.md"), "--raw"],
    cwd: dir,
  });

  const early = yield* race([
    call(function* (): Operation<boolean> {
      const process = yield* run;
      let seen = "";
      yield* spawn(function* () {
        const subscription = yield* process.stdout;
        let next = yield* subscription.next();
        while (!next.done) {
          seen += next.value;
          next = yield* subscription.next();
        }
      });
      // Observed before the child could have exited: it is still waiting for
      // the file this script has not written yet.
      yield* when(function* () {
        return seen.includes("EARLY");
      });
      yield* writeTextFile(release, "go");
      const status = yield* process.join();
      if (status.code !== 0) {
        fail(`the progressive document exited ${status.code}`);
      }
      if (!seen.includes("LATE")) {
        fail("the compiled binary never forwarded the later output");
      }
      return true;
    }),
    call(function* (): Operation<boolean> {
      yield* sleep(60_000);
      fail("the compiled binary produced no output before its deadline");
      yield* suspend();
      return false;
    }),
  ]);

  if (!early) {
    fail("progressive output was not observed");
  }
  console.log("foreground smoke: output arrived while the command was still running");

  // 2. Fail-fast: no <Output> declaration anywhere in this document.
  const marker = path.join(dir, "never");
  yield* ensureDir(dir);
  yield* writeTextFile(
    path.join(dir, "failing.md"),
    [
      "# Failing",
      "",
      "```bash exec",
      "echo BEFORE; exit 4",
      "```",
      "",
      "```bash exec",
      `touch ${marker}`,
      "```",
      "",
    ].join("\n"),
  );

  const failed = yield* exec(BINARY, {
    arguments: ["run", path.join(dir, "failing.md"), "--raw"],
    cwd: dir,
  }).join();

  if (failed.code === 0) {
    fail("a failing command left the compiled binary exiting 0");
  }
  if (!failed.stdout.includes("BEFORE")) {
    fail("the output produced before the failure was lost");
  }
  if (yield* exists(marker)) {
    fail("the block after the failing one ran");
  }
  console.log(`foreground smoke: a failed command exited ${failed.code} and stopped the document`);
});
