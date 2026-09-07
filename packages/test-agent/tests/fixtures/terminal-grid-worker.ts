import { main } from "effection";
import { useTempFileCompiler } from "@executablemd/core";
import { runTestAgentWorker } from "../../src/worker/run.ts";

main(function* ([command, flag, connect, ...rest]) {
  if (
    command !== "test-agent" ||
    flag !== "--connect" ||
    connect === undefined ||
    rest.length > 0
  ) {
    throw new Error("the grid worker requires test-agent --connect <controller-route>");
  }
  yield* useTempFileCompiler();
  yield* runTestAgentWorker({ connect });
});
