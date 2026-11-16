import { it } from "./bdd.ts";
import { captureTestJournal } from "./failure-journal.ts";
import type { InMemoryStream } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Register a case that owns one fresh guarded document execution. */
export function journalCases(owner: string) {
  return (
    name: string,
    source: string,
    body: (stream: InMemoryStream) => Operation<void>,
  ): void => {
    it(name, () => captureTestJournal({ owner, name }, source, body));
  };
}

/** Attribute a real fixture file whose directory is created by the case. */
export function fileJournalCases(owner: string, directoryPrefix: string, filename: string) {
  return (
    name: string,
    body: (stream: InMemoryStream, directory: string) => Operation<void>,
  ): void => {
    it(name, () => {
      const directory = join(tmpdir(), directoryPrefix + randomUUID());
      return captureTestJournal({ owner, name }, join(directory, filename), (stream) =>
        body(stream, directory),
      );
    });
  };
}
