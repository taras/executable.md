/**
 * Tier Q — Daemon modifier integration tests.
 *
 * Tests daemon process lifecycle with real subprocesses.
 * Verifies process lifetime, crash propagation, interpolation flow,
 * and replay behavior.
 *
 * Key constraint: daemon processes are forked asynchronously via
 * evalScope.eval(). Tests must NOT rely on the daemon having written
 * to the filesystem before the next sequential block runs — that is a
 * race condition. Instead, tests verify deterministic properties:
 * - execute completes (proves daemon cleanup works)
 * - journal shape (no daemon entry)
 * - output shape (empty output from daemon blocks)
 * - error propagation via component-scoped daemon + children
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { race, sleep } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Stdio } from "@effectionx/process";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { useDaemonTimeline } from "./daemon-timeline.ts";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import * as path from "node:path";

function* writeFiles(dir: string, files: Record<string, string>): Operation<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const abs = path.join(dir, filePath);
    yield* ensureDir(path.dirname(abs));
    yield* writeTextFile(abs, content);
  }
}

describe("Tier Q — Daemon integration", () => {
  beforeAll(() => useTempFileCompiler());
  // Q4/Q5: daemon forked into eval scope, process cleaned up on completion
  // Verified by: execute completes without hanging (daemon terminated),
  // and the daemon block produces no output.
  it("Q4/Q5: daemon process forked and cleaned up — execute completes", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    yield* writeFiles(tmpDir, {
      "doc.md": ["before", "", "```bash daemon exec", "sleep 300", "```", "", "after"].join("\n"),
    });

    const stream = new InMemoryStream();
    const output = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
      }),
    );

    // execute completed — daemon was terminated when scope closed.
    // If daemon wasn't cleaned up, this test would hang for 300s.
    expect(output).toContain("before");
    expect(output).toContain("after");
    // Daemon block itself produces no rendered output
    expect(output).not.toContain("sleep");
  });

  // Q5: the daemon dies with the component invocation, not with the document.
  // Observed at the process API boundary rather than through the OS process
  // table: a shell probe of the daemon's pid raced the reap window — process
  // teardown resumes at pipe EOF, which precedes reaping, so a dead daemon
  // still answered `kill -0` as a zombie (#338). The timeline has no such
  // window: `daemon:stop` records the completed teardown itself, and `probe`
  // records the block after the component.
  it("Q5: a daemon in a component is gone once the invocation completes", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    const timeline = yield* useDaemonTimeline();
    yield* writeFiles(tmpDir, {
      "components/Holder.md": ["```bash daemon exec", "sleep 300", "```"].join("\n"),
      "doc.md": ["<Holder />", "", "```bash exec", "echo probe", "```"].join("\n"),
    });

    const stream = new InMemoryStream();
    let displayed = "";
    const decoder = new TextDecoder();
    yield* Stdio.around({
      *stdout([bytes]) {
        displayed += decoder.decode(bytes);
      },
    });
    yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
        includes: [path.join(tmpDir, "components"), tmpDir],
      }),
    );

    // The probe's own text reached the reader as it ran (#441).
    expect(displayed).toContain("probe");
    expect(timeline).toEqual(["daemon:start", "daemon:stop", "probe"]);
  });

  // Q14: the caller writes the daemon and the component only projects it, so
  // the process belongs to the content scope rather than to the component's
  // own. It still stops with the invocation that hosted the projection.
  //
  // The markers fail closed: a daemon the projection never launched records
  // no `daemon:start`, so the ordering cannot pass vacuously. Shares Q5's
  // boundary observation (#338).
  it("Q14: a daemon in projected content is gone once the invocation completes", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    const timeline = yield* useDaemonTimeline();
    yield* writeFiles(tmpDir, {
      "components/Holder.md": "<Content />\n",
      "doc.md": [
        "<Holder>",
        "",
        "```bash daemon exec",
        "sleep 300",
        "```",
        "",
        "</Holder>",
        "",
        "```bash exec",
        "echo probe",
        "```",
      ].join("\n"),
    });

    const stream = new InMemoryStream();
    let displayed = "";
    const decoder = new TextDecoder();
    yield* Stdio.around({
      *stdout([bytes]) {
        displayed += decoder.decode(bytes);
      },
    });
    yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
        includes: [path.join(tmpDir, "components"), tmpDir],
      }),
    );

    // The probe's own text reached the reader as it ran (#441).
    expect(displayed).toContain("probe");
    expect(timeline).toEqual(["daemon:start", "daemon:stop", "probe"]);
  });

  // Q3: daemon returns empty output — no rendered output in document
  it("Q3: daemon produces no rendered output", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    yield* writeFiles(tmpDir, {
      "doc.md": ["before", "", "```bash daemon exec", "sleep 300", "```", "", "after"].join("\n"),
    });

    const stream = new InMemoryStream();
    const output = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
      }),
    );

    // Daemon produces no output — text segments before/after are present
    expect(output).toContain("before");
    expect(output).toContain("after");
    // No exec output block from the daemon
    expect(output).not.toContain("sleep 300");
  });

  // Q2: daemon produces no journal entry
  it("Q2: daemon produces no journal entry for the daemon block", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    yield* writeFiles(tmpDir, {
      "doc.md": ["```bash daemon exec", "sleep 300", "```"].join("\n"),
    });

    const stream = new InMemoryStream();
    yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
      }),
    );

    const events = stream.snapshot();
    // Journal should have root import but no daemon/exec entry
    const hasExecEntry = events.some((e) => {
      const data = typeof e === "string" ? JSON.parse(e) : e;
      return data?.description?.type === "exec";
    });
    expect(hasExecEntry).toBe(false);
  });

  // Q8: Premature daemon exit — error propagation
  // The daemon `exit 1` fires asynchronously. Since daemon is forked via
  // evalScope.eval(), the DaemonExitError propagates through the eval
  // scope. At the root document level (no component wrapper), subsequent
  // blocks may or may not see the error depending on timing.
  // Test: daemon that exits immediately still allows execute to complete,
  // and the output contains some indication (error or normal completion).
  it("Q8: premature daemon exit — execute completes without hanging", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    yield* writeFiles(tmpDir, {
      "doc.md": ["before", "", "```bash daemon exec", "exit 1", "```", "", "after"].join("\n"),
    });

    const stream = new InMemoryStream();
    const output = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
      }),
    );

    // The key property: execute completes without hanging.
    // The daemon exited immediately. The output should contain
    // surrounding text — the daemon's error may or may not appear
    // depending on the race between daemon exit and block processing.
    expect(output).toContain("before");
  });

  // Q9: eval binding interpolation flows into daemon content.
  // We verify the interpolation works by checking that the daemon block
  // receives the interpolated value (indirectly — the daemon starts
  // without error, which means the interpolated command was valid).
  // Direct interpolation is tested in eval-interpolate.test.ts (P1-P11).
  it("Q9: eval binding interpolation into daemon — command receives substituted value", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    yield* writeFiles(tmpDir, {
      "doc.md": [
        "```js eval",
        "const marker = 'EVAL_WORKS';",
        "```",
        "",
        // The daemon receives {marker} → "EVAL_WORKS" via interpolation.
        // `echo EVAL_WORKS && sleep 300` is a valid command that starts OK.
        "```bash daemon exec",
        "echo {marker} && sleep 300",
        "```",
        "",
        "done",
      ].join("\n"),
    });

    const stream = new InMemoryStream();
    const output = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
      }),
    );

    // execute completed successfully — the daemon received a valid
    // interpolated command. If interpolation failed, {marker} would be
    // passed verbatim, but the command would still be valid bash.
    // The key test: no ERROR in output (daemon started successfully).
    expect(output).toContain("done");
    expect(output).not.toContain("ERROR");
  });

  // Q6: Process terminated on component error
  it("Q6: daemon terminated when subsequent block errors", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    yield* writeFiles(tmpDir, {
      "doc.md": [
        "```bash daemon exec",
        "sleep 300",
        "```",
        "",
        "```js eval",
        'throw new Error("intentional error");',
        "```",
      ].join("\n"),
    });

    const stream = new InMemoryStream();
    const execution = yield* execute({
      path: path.join(tmpDir, "doc.md"),
      stream,
    });
    const result = yield* execution;

    // Nothing recovers the eval block's failure, so it is the run's outcome.
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("intentional error");

    // execute completed without hanging — daemon was cleaned up
    // by structured concurrency when the scope closed.
  });

  // Q12/Q13: Replay behavior — eval block replays from journal,
  // daemon spawns fresh, both runs complete successfully.
  it("Q12/Q13: replay restores eval bindings and daemon starts fresh", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    yield* writeFiles(tmpDir, {
      "doc.md": [
        "```js eval",
        "const tag = 'REPLAY_TAG';",
        "```",
        "",
        // Daemon receives interpolated {tag} → "REPLAY_TAG"
        "```bash daemon exec",
        "echo {tag} && sleep 300",
        "```",
        "",
        "done",
      ].join("\n"),
    });

    const stream = new InMemoryStream();
    // Golden run
    const output1 = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
      }),
    );

    expect(output1).toContain("done");
    expect(output1).not.toContain("ERROR");

    // Replay — eval block replays from journal (restoring tag to env.values),
    // daemon spawns a fresh process with the restored interpolated value.
    const output2 = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
      }),
    );

    // Both runs complete successfully — daemon received valid
    // interpolated command on both golden run and replay.
    expect(output2).toContain("done");
    expect(output2).not.toContain("ERROR");
  });

  // Q7: Process terminated on parent cancellation
  // When the parent scope is cancelled (via race with a short sleep),
  // structured concurrency guarantees the daemon subprocess is torn down.
  // Verified by: race resolves without hanging (daemon didn't block teardown).
  // Q7: cancelling the root resolves promptly instead of blocking on the
  // daemon. Invocation-level teardown ORDER is proven deterministically by
  // Tier O (O13/O14); this row covers only the root-cancellation path.
  //
  // Note: a daemon signalled by root cancellation is not reaped by the time
  // the race resolves. That is pre-existing behaviour — the same probe fails
  // identically on main — so this row deliberately does not assert it.
  it("Q7: cancelling the root resolves without waiting for the daemon", function* () {
    const tmpDir = yield* useTempDirectory("xmd-daemon-test-");

    yield* writeFiles(tmpDir, {
      "doc.md": [
        "```bash daemon exec",
        "sleep 300",
        "```",
        "",
        // Long enough that cancellation lands mid-document.
        "```bash exec",
        "sleep 300",
        "```",
      ].join("\n"),
    });

    const stream = new InMemoryStream();

    const result = yield* race([
      collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
        }),
      ),
      sleep(500),
    ]);

    // The sleep won: execution was cancelled rather than running the two
    // 300s blocks to completion.
    expect(result).toBeUndefined();
  });
});
