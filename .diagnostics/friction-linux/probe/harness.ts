import { main } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { runCli, shellQuote } from "../source/packages/test-support/launch.ts";

await main(function* (arguments_) {
  const suite = arguments_[0] ?? "";
  if (!["Workflow", "Sanity", "Friction"].includes(suite)) {
    throw new Error("Expected Workflow, Sanity or Friction");
  }
  const source = fileURLToPath(new URL("../source/", import.meta.url));
  const result = fileURLToPath(new URL(`../result/${suite}/`, import.meta.url));
  const executable = ["deno", "run", "--quiet", "--allow-all", `${source}/packages/cli/src/deno.ts`];
  const body = suite === "Sanity"
    ? '<Test name="observer-sanity" timeout="10s">\n```bash exec as="value"\nprintf timing-sanity\n```\n<AssertEquals actual={value.stdout} expected="timing-sanity" />\n</Test>'
    : yield* readTextFile(`${source}/examples/adversarial-implementation/tests/${suite}.test.md`);
  const argv = ["run", "--allow-absolute", "--eval", `<Testing>\n${body}\n</Testing>`,
    "--include", "examples/adversarial-implementation/tests/components",
    "--include", "examples/adversarial-implementation/components",
    ...(suite === "Workflow" ? [] : ["--journal", `${result}journal.jsonl`, "--plugin", fileURLToPath(new URL("timing-plugin.mjs", import.meta.url))])];
  const limitMs = suite === "Sanity" ? 15000 : 120000;
  const env = {
    XMD_EXAMPLE_COMMAND: [...executable, "run", "--allow-absolute"].map(shellQuote).join(" "),
    XMD_EXAMPLE_TEST_COMMAND: [...executable, "test"].map(shellQuote).join(" "),
  };
  const start = performance.now();
  yield* writeTextFile(`${result}intent.json`, JSON.stringify({ suite, argv, source, env, limitMs,
    sourceCommit: "f5538fa5c1c63e95cb05b624a12d4cfb6846d006", automaticRetries: 0 }, null, 2));
  try {
    const outcome = yield* runCli(argv, { cwd: source, timeout: limitMs, env }).expect();
    yield* writeTextFile(`${result}outcome.json`, JSON.stringify({ outcome,
      elapsedMs: performance.now() - start, helperReturned: true }, null, 2));
  } catch (error) {
    yield* writeTextFile(`${result}first-failure.txt`, error instanceof Error ? error.stack ?? String(error) : String(error));
    yield* writeTextFile(`${result}failure.json`, JSON.stringify({
      elapsedMs: performance.now() - start, helperThrew: true, automaticRetry: false }, null, 2));
    throw error;
  }
});
