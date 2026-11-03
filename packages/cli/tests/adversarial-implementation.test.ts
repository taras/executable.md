import { describe, it } from "@executablemd/test-support/bdd";
import { runCli, shellQuote } from "@executablemd/test-support/launch";
import { fileURLToPath } from "node:url";
import { readTextFile } from "@effectionx/fs";

describe("adversarial implementation example", () => {
  for (const suite of ["Workflow", "Friction", "Implementation"]) {
    it(`runs the ${suite} Markdown journeys without native models`, function* () {
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
          "run",
          "--allow-absolute",
          "--eval",
          `<Testing>\n${source}\n</Testing>`,
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
  }
});
