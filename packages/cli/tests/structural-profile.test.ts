/**
 * Tier PF — which profile installs the structural syntax (§6.21, §8).
 *
 * Installing it is an assembly decision a host states, not something the engine
 * carries everywhere. `xmd run` and an explicit `<Execution host="run">` child
 * install it; the `xmd test` root and every workflow execution do not. What
 * decides that is the profile the command states, never the runtime it happens
 * to be on — so these rows run under Deno, Node and Bun alike and expect the
 * same answers from all three.
 *
 * A profile is proved by what a document can write in it, not by reading the
 * assembly back: each row runs a grid and asks whether the name resolved.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, retainedSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { terminalGridInstallation } from "@executablemd/terminal/xmd";

import { syntaxSymbols } from "../src/syntax.ts";

const GRID = [
  "<Terminal.Grid columns={2}>",
  '<Terminal title="Agent">Instructions.</Terminal>',
  '<Terminal title="Shell" />',
  "</Terminal.Grid>",
  "",
].join("\n");

/** Run one grid document under exactly these installations, and report why it ended. */
function runGrid(installations: readonly ExecutionInstallation[]): Operation<string> {
  return scoped(function* () {
    try {
      yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource("root.md", GRID),
            stream: new InMemoryStream(),
            includes: [],
          },
          [...installations],
        ),
      );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
  });
}

/** What an ordinary run of any supported runtime installs at this layer. */
function runProfile(): readonly ExecutionInstallation[] {
  return [terminalGridInstallation()];
}

describe("Tier PF — an ordinary run has the syntax", () => {
  it("PF1: a valid grid reaches the preserved no-provider refusal", function* () {
    const outcome = yield* runGrid(runProfile());

    // The name resolved as installed syntax, the layout was derived, and the
    // run stopped exactly where a terminal provider would have been asked for
    // one — which is the whole of the behavior at this layer, on every runtime.
    expect(outcome).toContain("no terminal provider opened this grid");
  });

  it("PF1: an invalid grid is refused by the installed declarations", function* () {
    const outcome = yield* scoped(function* () {
      try {
        yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource(
                "root.md",
                '<Terminal.Grid columns={0}><Terminal title="A" /></Terminal.Grid>\n',
              ),
              stream: new InMemoryStream(),
              includes: [],
            },
            runProfile(),
          ),
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    });

    expect(outcome).toContain("positive integer");
  });
});

describe("Tier PF — a profile that installs none has none", () => {
  it("PF1: without the installation the grid resolves no component at all", function* () {
    // The `xmd test` root and every workflow execution are assembled this way:
    // no declarations and no provider, so the name is not syntax and nothing
    // supplies it either.
    const outcome = yield* runGrid([]);

    expect(outcome).toContain("Cannot resolve component: Terminal.Grid");
    expect(outcome).not.toContain("no terminal provider");
  });

  it("PF1: installing an unrelated profile does not bring the syntax with it", function* () {
    const unrelated: ExecutionInstallation = {
      // deno-lint-ignore require-yield
      *install(): Operation<void> {},
    };

    const outcome = yield* runGrid([unrelated]);

    expect(outcome).toContain("Cannot resolve component: Terminal.Grid");
  });
});

describe("Tier PF — one execution's installation is its own", () => {
  it("PF1: each execution is given a fresh record, and two runs share none", function* () {
    const first = terminalGridInstallation();
    const second = terminalGridInstallation();

    expect(first).not.toBe(second);
    expect(first.declarations).not.toBe(second.declarations);
    // Declaring the same names twice in *one* execution is a configuration
    // failure; two executions each declaring them is ordinary, and this is what
    // makes the second run's installation its own rather than the first's.
    expect(yield* runGrid([first])).toContain("no terminal provider");
    expect(yield* runGrid([second])).toContain("no terminal provider");
  });

  it("PF1: a sibling execution that installs none is unaffected by one that does", function* () {
    const installed = yield* runGrid(runProfile());
    const bare = yield* runGrid([]);
    const installedAgain = yield* runGrid(runProfile());

    expect(installed).toContain("no terminal provider");
    expect(bare).toContain("Cannot resolve component");
    expect(installedAgain).toContain("no terminal provider");
  });

  it("PF1: two installations of the same syntax in one execution are refused", function* () {
    const outcome = yield* runGrid([terminalGridInstallation(), terminalGridInstallation()]);

    expect(outcome).toContain("was declared twice");
  });
});

describe("Tier PF — what `xmd syntax` describes", () => {
  it("PF2: the symbols come from the run profile's own factory", function* () {
    let built = 0;
    const factory = () => {
      built++;
      return terminalGridInstallation();
    };

    const symbols = yield* syntaxSymbols([], factory);
    const structural = symbols.categories[0].entries.map((entry) => entry.name);

    expect(built).toBe(1);
    expect(structural).toContain("Terminal.Grid");
    expect(structural).toContain("Terminal");
  });

  it("PF2: describing the profile installs nothing and expands nothing", function* () {
    let installs = 0;
    let expansions = 0;
    const declared = terminalGridInstallation();
    const factory = (): ExecutionInstallation => ({
      declarations: declared.declarations,
      // deno-lint-ignore require-yield
      *install(): Operation<void> {
        installs++;
      },
      // deno-lint-ignore require-yield
      *expand(): Operation<void> {
        expansions++;
      },
    });

    yield* syntaxSymbols([], factory);

    // Inspection reads declarations. A profile that opened a terminal to
    // describe one would have moved these.
    expect(installs).toBe(0);
    expect(expansions).toBe(0);
  });

  it("PF2: a profile that installs none describes none", function* () {
    const symbols = yield* syntaxSymbols([]);
    const structural = symbols.categories[0].entries.map((entry) => entry.name);

    expect(structural).not.toContain("Terminal.Grid");
    expect(structural).not.toContain("Terminal");
  });
});
