import { describe, it } from "@executablemd/test-support/bdd";
import { runCli, shellQuote } from "@executablemd/test-support/launch";
import { fileURLToPath } from "node:url";
import { readTextFile } from "@effectionx/fs";

describe("adversarial implementation example", () => {
  for (const suite of [
    "Workflow",
    "Friction",
    "Implementation",
    "LaunchPolicy",
    "Delivery",
    "ProductionRole",
    "Preparation",
  ]) {
    it(`runs the ${suite} Markdown journeys without native models`, function* () {
      const executableCommand = [
        "deno",
        "run",
        "--quiet",
        "--allow-all",
        fileURLToPath(new URL("../src/deno.ts", import.meta.url)),
      ];
      const workflowCommand = [...executableCommand, "run", "--allow-absolute"]
        .map(shellQuote)
        .join(" ");
      const workflowTestCommand = [...executableCommand, "test"].map(shellQuote).join(" ");
      const source = yield* readTextFile(
        `examples/adversarial-implementation/tests/${suite}.test.md`,
      );
      yield* runCli(
        [
          ...(["ProductionRole", "Preparation"].includes(suite)
            ? [
                "test",
                `examples/adversarial-implementation/tests/${suite}.test.md`,
                "--plugin",
                "./packages/cli/tests/fixtures/workflow-test-permissions.mjs",
              ]
            : [
                "run",
                "--allow-absolute",
                ...(suite === "LaunchPolicy"
                  ? ["--plugin", "./packages/cli/tests/fixtures/workflow-test-permissions.mjs"]
                  : []),
                "--eval",
                `<Testing>\n${source}\n</Testing>`,
              ]),
          "--include",
          ["ProductionRole", "Preparation"].includes(suite)
            ? "examples/adversarial-implementation/components"
            : "examples/adversarial-implementation/tests/components",
          "--include",
          "examples/adversarial-implementation/components",
        ],
        {
          timeout: 120_000,
          env: {
            XMD_EXAMPLE_COMMAND: workflowCommand,
            XMD_EXAMPLE_TEST_COMMAND: workflowTestCommand,
          },
        },
      ).expect();
    });
  }
});
