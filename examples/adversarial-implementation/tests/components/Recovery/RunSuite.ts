import { API } from "@executablemd/runtime";
import { cliRuntime } from "@executablemd/test-support/launch";

export const props = { type: "object", properties: {}, additionalProperties: false };
export const returns = { type: "object" };

export default function* RunSuite() {
  const path =
    "examples/adversarial-implementation/tests/runtime/joined-response-recovery-suite.ts";
  const runtime = cliRuntime();
  const command =
    runtime === "deno"
      ? [
          "deno",
          "test",
          "--allow-all",
          "--node-modules-dir=manual",
          "--cached-only",
          "--frozen",
          path,
        ]
      : runtime === "node"
        ? ["tsx", "--tsconfig", "tsconfig.node.json", "--test", "--test-concurrency=1", path]
        : ["bun", "test", "--timeout=300000", "./" + path];
  return yield* API.Process.operations.exec({ command });
}
