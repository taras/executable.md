import process from "node:process";
import { durableRun, type Json, type Workflow } from "@executablemd/durable-streams";
import { main, type Operation, suspend } from "effection";
import { WorkflowRunStorage } from "../../mod.ts";
import { useWorkflowRunStorage } from "../../deno.ts";

const DEFINITION = {
  version: 1,
  kind: "git",
  objectFormat: "sha1",
  objectId: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  rootDocumentPath: "workflows/release.md",
} as const;

main(function* () {
  const [root] = process.argv.slice(2);
  yield* useWorkflowRunStorage({ root });
  const opened = yield* WorkflowRunStorage.operations.create({
    runId: "release-1.4",
    definition: DEFINITION,
    base: "main",
    props: { channel: "stable" },
  });
  if (!opened.ok) {
    throw opened.error;
  }
  const database = opened.value;

  function* work(): Workflow<Json> {
    yield database.workspace.effect(
      { type: "workspace", name: "killed" },
      function* (filesystem): Operation<Json> {
        yield* filesystem.writeFile("/uncommitted.txt", "killed before publication");
        console.log("XMD_UNCOMMITTED_WORKSPACE_WRITE");
        yield* suspend();
        return null;
      },
    );
    return null;
  }

  yield* durableRun(work, { stream: database.journal });
});
