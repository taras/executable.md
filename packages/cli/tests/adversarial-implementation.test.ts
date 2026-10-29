import { describe, it } from "@executablemd/test-support/bdd";
import { runCli, shellQuote } from "@executablemd/test-support/launch";
import { fileURLToPath } from "node:url";

describe("adversarial implementation example", () => {
  it("runs its Markdown journeys without native models", function* () {
    const workflowCommand = [
      "deno",
      "run",
      "--quiet",
      "--allow-all",
      fileURLToPath(new URL("../src/deno.ts", import.meta.url)),
      "run",
    ]
      .map(shellQuote)
      .join(" ");
    yield* runCli(
      [
        "test",
        "examples/adversarial-implementation/tests/Workflow.test.md",
        "--include",
        "examples/adversarial-implementation/tests/components",
        "--include",
        "examples/adversarial-implementation/components",
      ],
      {
        timeout: 120_000,
        env: { XMD_EXAMPLE_COMMAND: workflowCommand },
      },
    ).expect();
  });
});
