import { ensure, exit, main, until } from "effection";
import { executeShellEffect } from "./shell.ts";
import { openWorkspace } from "./workspace.ts";

main(function* () {
  const [dbPath, effectId] = Deno.args;
  if (dbPath === undefined || effectId === undefined) {
    yield* exit(2, "usage: crash-host <db> <effect-id>");
  }
  const workspace = openWorkspace(dbPath);
  yield* ensure(() => {
    workspace.storage.close();
  });
  if (!(yield* until(workspace.fs.exists("/workspace")))) {
    yield* until(workspace.fs.mkdir("/workspace"));
  }
  yield* executeShellEffect(
    workspace,
    effectId,
    "echo partial > result.txt; sleep 300",
    '{"filtered":"must-not-publish"}',
    {
      timeoutMs: 310_000,
      onMutation(operation) {
        if (operation === "writeFile") {
          console.log(JSON.stringify({ event: "write-reached", effectId }));
        }
      },
    },
  );
});
