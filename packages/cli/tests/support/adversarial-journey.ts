import { runCli, shellQuote } from "@executablemd/test-support/launch";
import { fileURLToPath } from "node:url";
import { readTextFile } from "@effectionx/fs";

export function* runAdversarialJourney(suite: string) {
  const workflowCommand = [
    "deno",
    "run",
    "--quiet",
    "--allow-all",
    fileURLToPath(new URL("../../src/deno.ts", import.meta.url)),
    "run",
    "--allow-absolute",
  ]
    .map(shellQuote)
    .join(" ");
  const source = yield* readTextFile(`examples/adversarial-implementation/tests/${suite}.test.md`);
  yield* runCli(
    [
      ...(suite === "ProductionRole"
        ? [
            "test",
            `examples/adversarial-implementation/tests/${suite}.test.md`,
            "--plugin",
            "./packages/cli/tests/fixtures/workflow-test-permissions.mjs",
          ]
        : ["run", "--allow-absolute", "--eval", `<Testing>\n${source}\n</Testing>`]),
      "--include",
      suite === "ProductionRole"
        ? "examples/adversarial-implementation/components"
        : "examples/adversarial-implementation/tests/components",
      "--include",
      "examples/adversarial-implementation/components",
    ],
    {
      timeout: 120_000,
      env: { XMD_EXAMPLE_COMMAND: workflowCommand },
    },
  ).expect();
}
