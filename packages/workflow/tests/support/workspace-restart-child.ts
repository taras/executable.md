import process from "node:process";
import { main } from "effection";
import { WorkflowRunStorage } from "../../mod.ts";
import { useWorkflowRunStorage } from "../../deno.ts";

main(function* () {
  const [root] = process.argv.slice(2);
  yield* useWorkflowRunStorage({ root });
  const opened = yield* WorkflowRunStorage.operations.lookup("release-1.4");
  if (!opened.ok) {
    throw opened.error;
  }
  const database = opened.value;
  const events = yield* database.readJournalEntries();
  if (!events.ok) {
    throw events.error;
  }
  const rootId = yield* database.workspace.currentRoot();
  if (!rootId.ok) {
    throw rootId.error;
  }

  console.log(
    JSON.stringify({
      rootId: rootId.value,
      events: events.value.map((entry) =>
        entry.event.type === "yield" ? entry.event.description.name : "close",
      ),
    }),
  );
});
