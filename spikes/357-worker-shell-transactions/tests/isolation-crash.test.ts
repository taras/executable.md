import { ensure, type Operation, run, until } from "effection";
import {
  executeShellEffect,
  replayOrExecuteShellEffect,
} from "../host/shell.ts";
import { openWorkspace, type Workspace } from "../host/workspace.ts";

const crashHost = new URL("../dist/crash-host", import.meta.url).pathname;

function database(prefix: string): string {
  return `${Deno.makeTempDirSync({ prefix })}/workspace.db`;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function* useWorkspace(path: string): Operation<Workspace> {
  const workspace = openWorkspace(path);
  yield* ensure(() => {
    workspace.storage.close();
  });
  return workspace;
}

Deno.test("compiled host crash rolls back mutation and result; replay reruns from the pre-effect root", () =>
  run(function* () {
    const path = database("spike357-crash-");
    const child = new Deno.Command(crashHost, {
      args: [path, "effect-crash"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const reader = child.stdout.getReader();
    const ready = yield* until(reader.read());
    assert(!ready.done, "crash host exited before signaling its write");
    const signal = new TextDecoder().decode(ready.value);
    assert(
      signal.includes('"event":"write-reached"'),
      "crash host did not signal its write",
    );
    child.kill("SIGKILL");
    const status = yield* until(child.status);
    assertEquals(
      status.signal,
      "SIGKILL",
      "crash host was not killed by the parent",
    );

    const workspace = yield* useWorkspace(path);
    assertEquals(
      yield* until(workspace.fs.exists("/workspace/result.txt")),
      false,
      "SQLite recovery retained the interrupted shell write",
    );
    assertEquals(
      workspace.storage.readJournal("effect-crash"),
      undefined,
      "SQLite recovery retained an interrupted journal result",
    );

    let workerStarts = 0;
    const rerun = yield* replayOrExecuteShellEffect(
      workspace,
      "effect-crash",
      "echo rerun > result.txt",
      '{"filtered":"rerun"}',
      { onWorkerStart: () => workerStarts++ },
    );
    assertEquals(rerun.replayed, false, "interrupted effect did not rerun");
    assertEquals(
      workerStarts,
      1,
      "interrupted replay did not start one Worker",
    );
    assertEquals(
      yield* until(workspace.fs.readFile("/workspace/result.txt", "utf8")),
      "rerun\n",
      "rerun did not start from the pre-effect root",
    );
    const replay = yield* replayOrExecuteShellEffect(
      workspace,
      "effect-crash",
      "echo duplicate > result.txt",
      '{"filtered":"duplicate"}',
      { onWorkerStart: () => workerStarts++ },
    );
    assertEquals(replay.replayed, true, "committed rerun did not replay");
    assertEquals(workerStarts, 1, "committed replay started another Worker");
  }));

Deno.test("Worker Shell retains filesystem, native execution, environment and network isolation", () =>
  run(function* () {
    const workspace = yield* useWorkspace(database("spike357-isolation-"));
    yield* until(workspace.fs.mkdir("/workspace"));
    Deno.env.set("HOST_CANARY", "host-secret-canary");

    const hostFile = yield* executeShellEffect(
      workspace,
      "effect-host-file",
      "cat /etc/passwd",
      '{"filtered":"host-file-refused"}',
    );
    assert(hostFile.shell.exitCode !== 0, "shell read /etc/passwd");
    assert(
      !hostFile.shell.stdout.includes("root:x:"),
      "host file content escaped",
    );

    const native = yield* executeShellEffect(
      workspace,
      "effect-native",
      "/bin/echo native",
      '{"filtered":"native-refused"}',
    );
    assert(native.shell.exitCode !== 0, "shell launched a native executable");

    const environment = yield* executeShellEffect(
      workspace,
      "effect-environment",
      "env",
      '{"filtered":"environment"}',
      { env: { EXPLICIT_VALUE: "fabricated" } },
    );
    assertEquals(environment.shell.exitCode, 0, "env probe failed");
    assert(
      environment.shell.stdout.includes("EXPLICIT_VALUE=fabricated"),
      "explicit environment was not supplied",
    );
    assert(
      !environment.shell.stdout.includes("host-secret-canary"),
      "host environment escaped",
    );

    const network = yield* executeShellEffect(
      workspace,
      "effect-network",
      "curl https://example.com",
      '{"filtered":"network-refused"}',
    );
    assert(network.shell.exitCode !== 0, "shell had a default network route");
  }));

Deno.test("a CPU-bound shell is preempted without starving host cancellation", () =>
  run(function* () {
    const workspace = yield* useWorkspace(database("spike357-cpu-"));
    yield* until(workspace.fs.mkdir("/workspace"));
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 25);
    const started = performance.now();
    yield* ensure(() => {
      clearInterval(ticker);
    });
    const result = yield* executeShellEffect(
      workspace,
      "effect-cpu",
      "echo partial > result.txt; i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done",
      '{"filtered":"cpu-timeout"}',
      {
        timeoutMs: 500,
        maxCommandCount: 10_000_000,
        maxLoopIterations: 10_000_000,
      },
    );
    const elapsed = performance.now() - started;
    assertEquals(
      result.shell.outcome,
      "timeout",
      "CPU-bound shell ignored timeout",
    );
    assert(
      elapsed < 5_000,
      `CPU-bound Worker was not reclaimed in time: ${elapsed}ms`,
    );
    assert(
      ticks >= 10,
      `host event loop was starved: only ${ticks} timer ticks`,
    );
    assertEquals(
      yield* until(workspace.fs.exists("/workspace/result.txt")),
      false,
      "CPU timeout retained a partial mutation",
    );
    assertEquals(
      result.journal.status,
      "failed",
      "CPU timeout did not retain failed result",
    );
  }));
