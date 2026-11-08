import { runCli, shellQuote } from "@executablemd/test-support/launch";
import { fileURLToPath } from "node:url";
import { env } from "@executablemd/runtime";
import { readTextFile } from "@effectionx/fs";

const testedSuites = ["ProductionRole", "Preparation"];

export function* runAdversarialJourney(suite: string) {
  const retainedEvidence = suite.startsWith("ArtifactReturn")
    ? yield* env("XMD_ARTIFACT_RETURN_EVIDENCE")
    : undefined;
  const executableCommand = [
    "deno",
    "run",
    "--quiet",
    "--allow-all",
    "--node-modules-dir=manual",
    "--cached-only",
    "--frozen",
    fileURLToPath(new URL("../../src/deno.ts", import.meta.url)),
  ];
  const workflowCommand = [...executableCommand, "run", "--allow-absolute"]
    .map(shellQuote)
    .join(" ");
  const workflowTestCommand = [...executableCommand, "test"].map(shellQuote).join(" ");
  const source = yield* readTextFile(`examples/adversarial-implementation/tests/${suite}.test.md`);
  const preparationAdapterTimeout = 180_000 + 120_000 + 30_000;
  const preparationTimeout = preparationAdapterTimeout + 3 * 20_000 + 30_000;
  yield* runCli(
    [
      ...(testedSuites.includes(suite)
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
      testedSuites.includes(suite)
        ? "examples/adversarial-implementation/components"
        : "examples/adversarial-implementation/tests/components",
      "--include",
      "examples/adversarial-implementation/components",
    ],
    {
      timeout:
        suite === "Preparation"
          ? preparationTimeout
          : suite === "Friction" || suite === "Implementation"
            ? 180_000
            : suite === "Delivery" || suite === "DecisionResolution"
              ? 300_000
              : 120_000,
      env: {
        XMD_EXAMPLE_COMMAND: workflowCommand,
        XMD_EXAMPLE_TEST_COMMAND: workflowTestCommand,
        ...(retainedEvidence === undefined
          ? {}
          : { XMD_ARTIFACT_RETURN_EVIDENCE: retainedEvidence }),
      },
    },
  ).expect();
}
