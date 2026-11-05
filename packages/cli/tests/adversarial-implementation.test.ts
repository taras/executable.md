import { describe, it } from "@executablemd/test-support/bdd";
import { runCli, shellQuote } from "@executablemd/test-support/launch";
import { fileURLToPath } from "node:url";
import { env } from "@executablemd/runtime";
import { readTextFile } from "@effectionx/fs";

for (const suite of [
  "ArtifactReturn",
  "ArtifactReturnRecovery",
  "Workflow",
  "Friction",
  "Implementation",
  "LaunchPolicy",
  "Delivery",
  "ProductionRole",
]) {
  describe(`runs the ${suite} Markdown journeys without native models`, () => {
    it(`runs the ${suite} Markdown journeys without native models`, function* () {
      const retainedEvidence = suite.startsWith("ArtifactReturn")
        ? yield* env("XMD_ARTIFACT_RETURN_EVIDENCE")
        : undefined;
      const workflowCommand = [
        "deno",
        "run",
        "--quiet",
        "--allow-all",
        fileURLToPath(new URL("../src/deno.ts", import.meta.url)),
        "run",
        "--allow-absolute",
      ]
        .map(shellQuote)
        .join(" ");
      const source = yield* readTextFile(
        `examples/adversarial-implementation/tests/${suite}.test.md`,
      );
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
          env: {
            XMD_EXAMPLE_COMMAND: workflowCommand,
            ...(retainedEvidence === undefined
              ? {}
              : { XMD_ARTIFACT_RETURN_EVIDENCE: retainedEvidence }),
          },
        },
      ).expect();
    });
  });
}
