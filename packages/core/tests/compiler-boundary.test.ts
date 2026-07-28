/**
 * Tier CB — who owns compiler installation (spec §4.2).
 *
 * `execute()` neither detects the runtime nor installs a compiler. These
 * assertions pin the three consequences: a document with no eval blocks needs
 * no compiler, one with eval blocks says so plainly when none is installed,
 * and a compiler the caller installed is the one that runs.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { API } from "@executablemd/runtime";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";

function* runDoc(source: string): Operation<string> {
  yield* useStubFs({ "doc.md": source });
  return yield* collect(yield* execute({ path: "doc.md", stream: new InMemoryStream() }));
}

describe("Tier CB — compiler boundary", () => {
  it("CB1: a document without eval blocks runs with no compiler installed", function* () {
    const output = yield* runDoc("# Plain\n\nJust prose, no fences.\n");
    expect(output).toContain("Just prose, no fences.");
    expect(output).not.toContain("ERROR");
  });

  it("CB2: an eval block without compiler middleware reports that explicitly", function* () {
    const output = yield* runDoc(["# Doc", "", "```js eval", "env.x = 1;", "```", ""].join("\n"));
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

    const output = yield* runDoc(["# Doc", "", "```js eval", "env.x = 1;", "```", ""].join("\n"));
    expect(output).not.toContain("compiler not installed");
    expect(compiled).toHaveLength(1);
    expect(compiled[0]).toContain("env.x = 1;");
  });
});
