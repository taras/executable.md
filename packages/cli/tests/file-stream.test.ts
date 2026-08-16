/**
 * FileStream writes the shared NDJSON representation.
 *
 * The bytes on disk are what an inspection gate reconstructs with
 * `serializeDurableEvent`, so the two must not drift apart.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import * as path from "node:path";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { FileStream } from "../src/file-stream.ts";

const EVENTS: DurableEvent[] = [
  {
    type: "yield",
    coroutineId: "root",
    description: { type: "import_component", name: "__root__" },
    result: { status: "ok", value: { path: "README.md" } },
  },
  {
    type: "yield",
    coroutineId: "root",
    description: { type: "call", name: "stepA" },
    result: { status: "err", error: { message: "boom", name: "Error" } },
  },
  {
    type: "close",
    coroutineId: "root.0",
    result: { status: "cancelled" },
  },
  {
    type: "close",
    coroutineId: "root",
    result: { status: "ok", value: "done" },
  },
];

describe("FileStream", () => {
  it("writes exactly the bytes the shared serializer produces", function* () {
    const dir = yield* useTempDirectory("xmd-file-stream-");

    const journalPath = path.join(dir, "journal.jsonl");
    const stream = new FileStream(journalPath);

    for (const event of EVENTS) {
      yield* stream.append(event);
    }

    expect(yield* readTextFile(journalPath)).toBe(EVENTS.map(serializeDurableEvent).join(""));
  });

  it("reads back every appended event in append order", function* () {
    const dir = yield* useTempDirectory("xmd-file-stream-");

    const stream = new FileStream(path.join(dir, "journal.jsonl"));

    for (const event of EVENTS) {
      yield* stream.append(event);
    }

    expect(yield* stream.readAll()).toEqual(EVENTS);
  });
});
