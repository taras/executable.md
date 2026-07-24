/**
 * The smallest controller that serves one behavior document to a
 * controller-launched `xmd test-agent` worker. Start it, then drive the
 * worker with the real ACPX CLI — see packages/test-agent/README.md.
 *
 *   deno run --allow-all packages/test-agent/examples/acpx-walkthrough.ts
 */
import { main, suspend } from "effection";
import { readTextFile } from "@executablemd/runtime";
import { useTestAgentController } from "@executablemd/test-agent";
import { join } from "node:path";

await main(function* () {
  const scenarioDir = import.meta.dirname ?? ".";
  const source = yield* readTextFile(join(scenarioDir, "review.md"));

  const controller = yield* useTestAgentController();
  const instance = controller.registerInstance({
    doc: { path: "review.md", source },
    scenarioDir,
  });

  const agent = `xmd test-agent --connect ${instance.route}`;
  console.log("Controller ready. Drive it with the ACPX CLI:\n");
  console.log(`  acpx --agent ${JSON.stringify(agent)} "Review packages/core at revision abc123"`);
  console.log(`  acpx --agent ${JSON.stringify(agent)} "Summarize packages/core"`);
  console.log("\nPress Ctrl-C to stop.");

  yield* suspend();
});
