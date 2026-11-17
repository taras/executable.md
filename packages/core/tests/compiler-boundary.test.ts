/**
 * Tier CB — who owns compiler installation (spec §4.2).
 *
 * `execute()` neither detects the runtime nor installs a compiler. These
 * assertions pin the three consequences: a document with no eval blocks needs
 * no compiler, one with eval blocks says so plainly when none is installed,
 * and a compiler the caller installed is the one that runs.
 */
import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import type { InMemoryStream } from "@executablemd/durable-streams";
import { journalBeforeEach, useJournalStream } from "@executablemd/test-support/failure-journal";
import { useStubFs } from "@executablemd/runtime/test";
import { API } from "@executablemd/runtime";
import { asText, completion } from "./helpers.ts";
const OWNER = "packages/core/tests/compiler-boundary.test.ts";

/** What the run said: its rendered text, or the failure it reported. */
function* runDoc(stream: InMemoryStream | undefined, source: string): Operation<string> {
  yield* useStubFs({ "doc.md": source });
  const result = yield* completion({
    path: "doc.md",
    stream: stream ?? (yield* useJournalStream("doc.md")),
  });
  return result.ok ? asText(result.value) : result.error.message;
}

describe("Tier CB — compiler boundary", () => {
  beforeEach(journalBeforeEach(OWNER));

  it("CB1: a document without eval blocks runs with no compiler installed", function* () {
    const output = yield* runDoc(undefined, "# Plain\n\nJust prose, no fences.\n");
    expect(output).toContain("Just prose, no fences.");
    expect(output).not.toContain("ERROR");
  });

  it("CB2: an eval block without compiler middleware reports that explicitly", function* () {
    const output = yield* runDoc(
      undefined,
      ["# Doc", "", "```js eval", "env.x = 1;", "```", ""].join("\n"),
    );
    expect(output).toContain("compiler not installed");
    expect(output).toContain("API.Env.around()");
  });

  it("CB3: execute() uses the caller's compiler rather than shadowing it", function* () {
    const compiled: string[] = [];
    yield* API.Env.around(
      {
        *compile([source]) {
          compiled.push(source);
          return function* () {
            return undefined;
          };
        },
      },
      { at: "min" },
    );

    const output = yield* runDoc(
      undefined,
      ["# Doc", "", "```js eval", "env.x = 1;", "```", ""].join("\n"),
    );
    expect(output).not.toContain("compiler not installed");
    expect(compiled).toHaveLength(1);
    expect(compiled[0]).toContain("env.x = 1;");
  });
});
