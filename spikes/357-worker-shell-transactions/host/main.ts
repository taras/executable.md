import { ensure, exit, main, until } from "effection";
import { executeShellEffect, replayOrExecuteShellEffect } from "./shell.ts";
import { openWorkspace } from "./workspace.ts";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

main(function* () {
  const [dbPath, action, effectId, command, ...rest] = Deno.args;
  if (dbPath === undefined || action === undefined || effectId === undefined) {
    yield* exit(
      2,
      "usage: proof <db> <effect|replay|inspect> <effect-id> [command]",
    );
  }
  const workspace = openWorkspace(dbPath);
  yield* ensure(() => {
    workspace.storage.close();
  });

  if (action === "inspect") {
    console.log(
      JSON.stringify({ journal: workspace.storage.readJournal(effectId) }),
    );
    return;
  }
  if (command === undefined) {
    yield* exit(2, "effect and replay require a command");
  }
  if (!(yield* until(workspace.fs.exists("/workspace")))) {
    yield* until(workspace.fs.mkdir("/workspace"));
  }

  const controller = new AbortController();
  const cancelAfter = flag(rest, "--cancel-after");
  const cancelTimer = cancelAfter === undefined
    ? undefined
    : setTimeout(() => controller.abort(), Number(cancelAfter));
  yield* ensure(() => {
    if (cancelTimer !== undefined) {
      clearTimeout(cancelTimer);
    }
  });
  const timeout = flag(rest, "--timeout");
  const terminateAfter = flag(rest, "--terminate-after");
  const maxCommands = flag(rest, "--max-commands");
  const maxLoops = flag(rest, "--max-loops");
  const payload = flag(rest, "--payload") ?? '{"filtered":true}';
  const options = {
    signal: controller.signal,
    timeoutMs: timeout === undefined ? undefined : Number(timeout),
    terminateAfterMs: terminateAfter === undefined
      ? undefined
      : Number(terminateAfter),
    maxCommandCount: maxCommands === undefined
      ? undefined
      : Number(maxCommands),
    maxLoopIterations: maxLoops === undefined ? undefined : Number(maxLoops),
  };

  if (action === "effect") {
    const result = yield* executeShellEffect(
      workspace,
      effectId,
      command,
      payload,
      options,
    );
    console.log(JSON.stringify(result));
    return;
  }
  if (action === "replay") {
    let workerStarts = 0;
    const result = yield* replayOrExecuteShellEffect(
      workspace,
      effectId,
      command,
      payload,
      {
        ...options,
        onWorkerStart: () => {
          workerStarts++;
        },
      },
    );
    console.log(JSON.stringify({ ...result, workerStarts }));
    return;
  }
  yield* exit(2, `unknown action: ${action}`);
});
