import {
  ensure,
  type Operation,
  run,
  spawn,
  until,
  withResolvers,
} from "effection";
import { EffectFsRouter } from "../host/router.ts";
import {
  executeShellEffect,
  replayOrExecuteShellEffect,
} from "../host/shell.ts";
import { openWorkspace, type Workspace } from "../host/workspace.ts";

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

function* expectRejection(
  operation: Operation<unknown>,
  pattern: RegExp,
): Operation<void> {
  let observed: Error | undefined;
  try {
    yield* operation;
  } catch (error) {
    observed = error instanceof Error ? error : new Error(String(error));
  }
  if (observed === undefined || !pattern.test(observed.message)) {
    throw new Error(
      `expected rejection ${pattern}, got ${observed?.message ?? "success"}`,
    );
  }
}

Deno.test("success hides filesystem and journal until one outer commit", () =>
  run(function* () {
    const path = database("spike357-success-");
    const writer = yield* useWorkspace(path);
    let reader = openWorkspace(path);
    yield* ensure(() => {
      reader.storage.close();
    });
    yield* until(writer.fs.mkdir("/workspace"));
    yield* until(writer.fs.writeFile("/workspace/delete.txt", "delete me"));
    yield* until(writer.fs.writeFile("/workspace/source.txt", "rename me"));

    const beforeCommit = withResolvers<void>("before effect commit");
    const allowCommit = withResolvers<void>("allow effect commit");
    const task = yield* spawn(function* () {
      return yield* executeShellEffect(
        writer,
        "effect-success",
        [
          "echo written > written.txt",
          "rm delete.txt",
          "mv source.txt renamed.txt",
          "chmod 600 renamed.txt",
          "ln -s /workspace/renamed.txt link.txt",
        ].join("; "),
        '{"filtered":"success"}',
        {
          beforeCommit: function* () {
            beforeCommit.resolve();
            yield* allowCommit.operation;
          },
        },
      );
    });

    yield* beforeCommit.operation;
    assertEquals(
      yield* until(reader.fs.exists("/workspace/written.txt")),
      false,
      "an outside reader saw a write before commit",
    );
    assertEquals(
      yield* until(reader.fs.exists("/workspace/delete.txt")),
      true,
      "an outside reader saw a delete before commit",
    );
    assertEquals(
      yield* until(reader.fs.exists("/workspace/source.txt")),
      true,
      "an outside reader saw a rename before commit",
    );
    assertEquals(
      reader.storage.readJournal("effect-success"),
      undefined,
      "an outside reader saw the journal before commit",
    );

    allowCommit.resolve();
    const result = yield* task;
    reader.storage.close();
    reader = openWorkspace(path);
    assertEquals(result.journal.status, "ok", "success journal status");
    assertEquals(
      yield* until(reader.fs.readFile("/workspace/written.txt", "utf8")),
      "written\n",
      "write did not publish",
    );
    assertEquals(
      yield* until(reader.fs.exists("/workspace/delete.txt")),
      false,
      "delete did not publish",
    );
    assertEquals(
      yield* until(reader.fs.exists("/workspace/source.txt")),
      false,
      "rename source remained",
    );
    const renamed = yield* until(reader.fs.stat("/workspace/renamed.txt"));
    assertEquals(renamed.mode, 0o600, "mode did not publish");
    assertEquals(
      yield* until(reader.fs.readlink("/workspace/link.txt")),
      "/workspace/renamed.txt",
      "symlink did not publish",
    );
    assertEquals(
      reader.storage.readJournal("effect-success")?.payload,
      '{"filtered":"success"}',
      "journal did not publish",
    );
    assertEquals(
      result.transaction.effectTransactionsBegun,
      1,
      "success opened more than one effect transaction",
    );
    assertEquals(
      result.transaction.effectCommits,
      1,
      "success did not commit once",
    );
    assertEquals(
      result.transaction.effectRollbacks,
      0,
      "success rolled back outer transaction",
    );
    assert(
      result.transaction.nestedDofsTransactions >= 5,
      "DOFS calls did not nest under the outer effect transaction",
    );
  }));

const failureCases = [
  {
    name: "nonzero exit",
    command: "echo partial > result.txt; false",
    expected: "exit",
    options: {},
  },
  {
    name: "interpreter error",
    command: "echo partial > result.txt; echo fail > missing/result.txt",
    expected: "interpreter-error",
    options: {},
  },
  {
    name: "timeout",
    command: "echo partial > result.txt; sleep 10",
    expected: "timeout",
    options: { timeoutMs: 100 },
  },
  {
    name: "explicit cancellation",
    command: "echo partial > result.txt; sleep 10",
    expected: "cancelled",
    options: { cancelAfterMs: 100 },
  },
  {
    name: "Worker.terminate()",
    command: "echo partial > result.txt; sleep 10",
    expected: "terminated",
    options: { terminateAfterMs: 100 },
  },
];

for (const probe of failureCases) {
  Deno.test(`${probe.name} rolls mutations back and commits one failed result`, () =>
    run(function* () {
      const path = database(`spike357-${probe.name.replaceAll(" ", "-")}-`);
      const workspace = yield* useWorkspace(path);
      yield* until(workspace.fs.mkdir("/workspace"));
      const controller = new AbortController();
      const cancelAfter = "cancelAfterMs" in probe.options
        ? probe.options.cancelAfterMs
        : undefined;
      const timer = cancelAfter === undefined
        ? undefined
        : setTimeout(() => controller.abort(), cancelAfter);
      yield* ensure(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      const result = yield* executeShellEffect(
        workspace,
        `effect-${probe.name}`,
        probe.command,
        `{"filtered":"${probe.name}"}`,
        {
          signal: controller.signal,
          timeoutMs: "timeoutMs" in probe.options
            ? probe.options.timeoutMs
            : 5_000,
          terminateAfterMs: "terminateAfterMs" in probe.options
            ? probe.options.terminateAfterMs
            : undefined,
        },
      );
      assertEquals(
        result.shell.outcome,
        probe.expected,
        `${probe.name} outcome`,
      );
      assertEquals(
        result.journal.status,
        "failed",
        `${probe.name} journal status`,
      );
      assertEquals(
        yield* until(workspace.fs.exists("/workspace/result.txt")),
        false,
        `${probe.name} retained a partial file`,
      );
      assertEquals(
        result.transaction.effectTransactionsBegun,
        1,
        `${probe.name} opened a second top-level transaction`,
      );
      assertEquals(
        result.transaction.effectCommits,
        1,
        `${probe.name} did not commit the failed result`,
      );
      assertEquals(
        result.transaction.effectRollbacks,
        0,
        `${probe.name} rolled back the outer transaction`,
      );
      assertEquals(
        result.transaction.journalAppendsInEffect,
        1,
        `${probe.name} did not append inside the effect transaction`,
      );
    }));
}

Deno.test("filesystem RPCs reject missing, foreign, stale, completed and cancelled identities", () =>
  run(function* () {
    const workspace = yield* useWorkspace(database("spike357-fencing-"));
    yield* until(workspace.fs.mkdir("/workspace"));
    const transaction = workspace.storage.beginEffect("effect-current");
    yield* ensure(() => {
      transaction.abort();
    });
    const router = new EffectFsRouter(
      workspace.fs,
      transaction,
      "invocation-current",
    );
    const call = {
      kind: "fs-call",
      id: 1,
      effectId: "effect-current",
      invocationId: "invocation-current",
      operation: "writeFile",
      arguments: ["/workspace/fenced.txt", "forbidden"],
    };
    const missing = {
      kind: call.kind,
      id: call.id,
      invocationId: call.invocationId,
      operation: call.operation,
      arguments: call.arguments,
    };
    yield* expectRejection(
      router.route(missing),
      /missing its effect identity/,
    );
    yield* expectRejection(
      router.route({ ...call, effectId: "effect-foreign" }),
      /foreign effect identity/,
    );
    yield* expectRejection(
      router.route({ ...call, invocationId: "invocation-stale" }),
      /stale invocation/,
    );
    router.complete();
    yield* expectRejection(router.route(call), /completed/);

    const cancelled = new EffectFsRouter(
      workspace.fs,
      transaction,
      "invocation-current",
    );
    cancelled.cancel();
    yield* expectRejection(cancelled.route(call), /cancelled/);
    assertEquals(
      yield* until(workspace.fs.exists("/workspace/fenced.txt")),
      false,
      "a fenced message mutated the workspace",
    );
  }));

Deno.test("a committed result replays without starting a Worker", () =>
  run(function* () {
    const workspace = yield* useWorkspace(database("spike357-replay-"));
    yield* until(workspace.fs.mkdir("/workspace"));
    let workerStarts = 0;
    const first = yield* replayOrExecuteShellEffect(
      workspace,
      "effect-replay",
      "echo original > replay.txt",
      '{"filtered":"original"}',
      { onWorkerStart: () => workerStarts++ },
    );
    assertEquals(
      first.replayed,
      false,
      "first execution unexpectedly replayed",
    );
    assertEquals(workerStarts, 1, "first execution did not start one Worker");
    const replay = yield* replayOrExecuteShellEffect(
      workspace,
      "effect-replay",
      "echo duplicate > replay.txt",
      '{"filtered":"duplicate"}',
      { onWorkerStart: () => workerStarts++ },
    );
    assertEquals(replay.replayed, true, "committed result did not replay");
    assertEquals(workerStarts, 1, "replay started a Worker");
    assertEquals(
      yield* until(workspace.fs.readFile("/workspace/replay.txt", "utf8")),
      "original\n",
      "replay reran the shell mutation",
    );
  }));
