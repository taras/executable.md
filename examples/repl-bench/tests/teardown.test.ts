import { readTextFile, stat } from "@effectionx/fs";
import { ensure, run, sleep, spawn, until } from "effection";
import assert from "node:assert/strict";
import { join } from "node:path";
import process from "node:process";
import { denoCommand, root } from "../lib/run.ts";

const decoder = new TextDecoder();
const expectedFailures = [
  "test timed out after 8 seconds",
  'Timed out waiting for "only-in-draft-1248" in sidekick-composer',
  'Timed out waiting for "false-history-drawer" in history',
];
const scriptedFailures = [
  'Scripted Sidekick prompt "Unexpected prompt.": prompt did not match the active stage.',
  'Timed out waiting for "fail-with-a-pending-acp-question" in viewport',
  'Scripted Sidekick prompt "Unexpected path prompt.": prompt did not match the active stage.',
  'Timed out waiting for "fail-with-a-pending-path-question" in viewport',
];

function* assertReaped(log: string, reason: string, workers: Map<number, Set<number>>) {
  const directory = log.slice(log.indexOf(reason)).match(/^Evidence: (.+)$/m)?.[1];
  assert.ok(directory, `Missing evidence for ${reason}`);
  const pid = Number((yield* readTextFile(join(directory, "pid"))).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `Invalid REPL PID in ${directory}`);
  assert.ok((yield* stat(join(directory, "screen.txt"))).size > 0);
  assert.ok((yield* stat(join(directory, "terminal.ansi"))).size > 0);
  const closed = JSON.parse(yield* readTextFile(join(directory, "closed.json")));
  assert.equal(closed.pid, pid);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `REPL ${pid} survived`);
  const children = workers.get(pid);
  assert.ok(children?.size, `No scripted Sidekick worker observed for REPL ${pid}`);
  for (const worker of children) {
    assert.throws(() => process.kill(worker, 0), { code: "ESRCH" }, `Worker ${worker} survived`);
  }
}

function* verifyTeardown() {
  let child: Deno.ChildProcess | undefined;
  let settled = false;
  yield* ensure(function* () {
    if (child !== undefined && !settled) {
      child.kill();
      yield* until(child.status);
    }
  });
  const [command, ...args] = denoCommand([
    "test",
    "examples/repl-bench/journeys/timeout-controls.md",
  ]);
  assert.ok(command);
  child = new Deno.Command(command, {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const workers = new Map<number, Set<number>>();
  const workerCommand = `${join(root, "packages/cli/src/deno.ts")} test-agent --connect `;
  const poll = yield* spawn(function* () {
    const ps = new Deno.Command("ps", { args: ["-ww", "-axo", "pid=,ppid=,command="] });
    while (!settled) {
      const snapshot = yield* until(ps.output());
      assert.equal(snapshot.code, 0, decoder.decode(snapshot.stderr));
      for (const line of decoder.decode(snapshot.stdout).split("\n")) {
        const row = line.match(/^\s*(\d+)\s+(\d+)\s+\S*\bdeno run /);
        if (row === null || !line.includes(workerCommand)) {
          continue;
        }
        const parent = Number(row[2]);
        const pids = workers.get(parent) ?? new Set<number>();
        pids.add(Number(row[1]));
        workers.set(parent, pids);
      }
      yield* sleep(200);
    }
  });
  const result = yield* until(child.output());
  settled = true;
  yield* poll;
  const log = decoder.decode(result.stderr) + "\n" + decoder.decode(result.stdout);
  try {
    assert.equal(result.code, 1, "The intentional failures must exit with status 1");
    const failures = [...expectedFailures, ...scriptedFailures];
    assert.ok(log.includes(`tests failed: ${failures.length} of ${failures.length} tests failed`));
    for (const reason of failures) {
      assert.ok(log.includes(reason), `Missing test failure: ${reason}`);
    }
    for (const reason of scriptedFailures) {
      yield* assertReaped(log, reason, workers);
    }
  } catch (error) {
    process.stderr.write(log);
    throw error;
  }
}

Deno.test("failed journeys keep evidence and reap the REPL and scripted Sidekick", () =>
  run(verifyTeardown));
