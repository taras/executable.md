import { main } from "effection";
import { argv } from "node:process";
import { join } from "node:path";
import { writeTextFile } from "@effectionx/fs";
import { collect, execute, useNormalizedOutput } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useDenoComponentModuleLoader } from "@executablemd/core/host/deno";

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
  console.log(
    yield* collect(
      yield* execute({
        source: "<ReadOnly />",
        path: "<eval>",
        includes: [directory],
        stream: new InMemoryStream(),
      }),
    ),
  );
});
