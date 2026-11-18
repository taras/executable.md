import { main, exit } from "effection";
import { useQuietProcessOutput } from "@executablemd/runtime";
import { runCli } from "@executablemd/test-support/launch";

await main(function* (args) {
  yield* useQuietProcessOutput();
  const result = yield* runCli(args, { timeout: 120_000 }).join();
  console.log(result.stdout);
  console.error(result.stderr);
  yield* exit(result.code ?? 1);
});
