import { it } from "./bdd.ts";
import { captureTestJournal } from "./failure-journal.ts";
import type { InMemoryStream } from "@executablemd/durable-streams";
import type { Operation } from "effection";

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
