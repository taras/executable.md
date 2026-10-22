import { readTextFile, writeTextFile } from "@effectionx/fs";
import { main } from "effection";
import {
  parseDurableEvent,
  serializeDurableEvent,
  InMemoryStream,
} from "@executablemd/durable-streams";
import { collect, execute, registerComponents, useNormalizedOutput } from "@executablemd/core";
import { join } from "node:path";
import { argv } from "node:process";
import { useComponentModuleLoader } from "@executablemd/test-support/host";

main(function* () {
  yield* useComponentModuleLoader();
  const directory = argv[2];
  if (directory === undefined) {
    throw new Error("missing fixture project");
  }
  const events = (yield* readTextFile(join(directory, "journal.jsonl")))
    .trim()
    .split("\n")
    .map((line) => {
      const parsed = parseDurableEvent(line);
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    });
  const stream = new InMemoryStream(events);
  yield* useNormalizedOutput();
  yield* registerComponents([
    {
      name: "Gate",
      props: { type: "object", properties: {}, additionalProperties: false },
      fn: function* () {
        return "continued";
      },
      origin: "materialization-fixture",
    },
  ]);
  const result = yield* collect(
    yield* execute({
      path: join(directory, "doc.md"),
      includes: [join(directory, "components")],
      stream,
    }),
  );
  yield* writeTextFile(join(directory, "result.json"), JSON.stringify(result));
  yield* writeTextFile(
    join(directory, "continued.jsonl"),
    stream.snapshot().map(serializeDurableEvent).join(""),
  );
});
