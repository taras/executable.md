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
import { join, resolve } from "node:path";

await main(function* () {
  const rootDir = import.meta.dirname ?? ".";
  const source = yield* readTextFile(join(rootDir, "review.md"));

  const controller = yield* useTestAgentController();
  const scenario = yield* controller.useScenario({
    document: { path: "review.md", source },
    rootDir,
  });

  // ACPX reparses the agent string, so the absolute path is single-quoted to
  // survive a checkout path containing spaces.
  const cli = resolve(rootDir, "../../../packages/cli/src/cli.ts");
  const agent = `deno run --allow-all '${cli}' test-agent --connect ${scenario.route}`;
  console.log("Controller ready. Drive the worker with ACPX in another terminal:\n");
  console.log(
    `  acpx --agent ${JSON.stringify(agent)} exec "Review packages/core at revision abc123"`,
  );
  console.log(`  acpx --agent ${JSON.stringify(agent)} exec "Summarize packages/core"`);
  console.log("\nPress Ctrl-C to stop.");

  yield* suspend();
});
