import { main } from "effection";
import { argv } from "node:process";
import { join } from "node:path";
import { writeTextFile } from "@effectionx/fs";
import { collect, execute, useNormalizedOutput } from "@executablemd/core";
import { InMemoryStream, serializeDurableEvent } from "@executablemd/durable-streams";
import { useDenoComponentModuleLoader } from "@executablemd/core/host/deno";

import { boundedJournalResult } from "../../../test-support/subprocess-journal.ts";

main(function* () {
  const directory = argv[2];
  if (directory === undefined) {
    throw new Error("missing fixture directory");
  }
  yield* useDenoComponentModuleLoader();
  if (argv[3] === "write") {
    try {
      yield* writeTextFile(join(directory, "denied.txt"), "denied");
    } catch (error) {
      if (error instanceof Error && error.name === "NotCapable") {
        console.log("authored-write-denied");
        return;
      }
      throw error;
    }
    throw new Error("the loader granted an authored write");
  }
  yield* useNormalizedOutput();
  const stream = new InMemoryStream();
  const output = yield* collect(
    yield* execute({
      source: "<ReadOnly />",
      path: "<eval>",
      includes: [directory],
      stream,
    }),
  );
  if (argv[4] === "--capture-journal") {
    console.log(
      boundedJournalResult({ output }, [(yield* stream.readAll()).map(serializeDurableEvent)]),
    );
  } else {
    console.log(output);
  }
});
