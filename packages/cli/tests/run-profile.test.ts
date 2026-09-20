/**
 * Which commands run with the bundled Plugin, and where it sits.
 *
 * Being in `ActivePlugins` *is* having the default prefix, so a command that
 * executes no document must not carry the value at all — not even where the
 * Plugin would decline to declare anything for it. `xmd workflow` therefore
 * cannot be classified as a whole: `start`, `resume` and `fork` reach a
 * document, and `list`, `status` and the rest read runs and execute nothing.
 *
 * The assembler is exercised with a loader that **throws**. A bundled value is
 * carried, never loaded, and the reserved selector names that value rather than
 * a module — so any module load at all is the failure this suite exists to
 * catch, and nothing here needs a fixture on disk.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import {
  assembleRunProfile,
  BUNDLED_PLUGIN,
  BUNDLED_SELECTOR,
  nestedRunProfile,
} from "../src/run-profile.ts";
import { installPlugins } from "../src/plugin-host.ts";
import { Plugin } from "@executablemd/core/api";
import { scoped } from "effection";
import { selectPlugins } from "../src/plugin-selection.ts";

/** A loader that refuses: this suite never legitimately reaches a module. */
// deno-lint-ignore require-yield
function* refusing(specifier: string): Operation<unknown> {
  throw new Error(`a module was loaded: ${specifier}`);
}

/** The Plugin names one command line assembles, in installation order. */
function* profile(args: readonly string[]): Operation<string[]> {
  const assembled = yield* assembleRunProfile(selectPlugins(args), refusing);
  return assembled.map((plugin) => plugin.name);
}

const GIT = "@executablemd/git";

describe("the bundled run profile", () => {
  it("carries the bundled Plugin for the commands that reach a document", function* () {
    for (const args of [["run", "doc.md"], ["plan", "doc.md"], ["syntax"], ["doc.md"]]) {
      expect(`${args.join(" ")}: ${(yield* profile(args)).join(",")}`).toBe(
        `${args.join(" ")}: ${GIT}`,
      );
    }
  });

  it("carries it for the workflow actions that execute a document", function* () {
    for (const action of ["start", "resume", "fork"]) {
      const args = ["workflow", action, "flow.md"];
      expect(`${action}: ${(yield* profile(args)).join(",")}`).toBe(`${action}: ${GIT}`);
    }
  });

  it("carries it for no workflow action that only reads or manages runs", function* () {
    for (const action of ["list", "status", "history", "export", "answer", "cancel", "delete"]) {
      const args = ["workflow", action];
      expect(`${action}: ${(yield* profile(args)).join(",")}`).toBe(`${action}: `);
    }
  });

  it("carries it for neither the test root nor a command that runs nothing", function* () {
    for (const args of [["test"], ["test", "suite.md"], ["upgrade"], ["workflow"]]) {
      expect(`${args.join(" ")}: ${(yield* profile(args)).join(",")}`).toBe(`${args.join(" ")}: `);
    }
  });

  it("resolves the reserved selector without loading anything", function* () {
    // Once, five times, and beside an ineligible command: the selector names
    // the value this profile already holds, so it is consumed rather than
    // resolved. The refusing loader is what proves "consumed".
    expect(yield* profile(["--plugin", BUNDLED_SELECTOR, "run", "doc.md"])).toEqual([GIT]);
    expect(
      yield* profile([
        "--plugin",
        BUNDLED_SELECTOR,
        "--plugin",
        BUNDLED_SELECTOR,
        "--plugin=git",
        "run",
        "doc.md",
      ]),
    ).toEqual([GIT]);

    // And it cannot turn a command that executes nothing into one that does.
    expect(yield* profile(["--plugin", BUNDLED_SELECTOR, "workflow", "list"])).toEqual([]);
    expect(yield* profile(["--plugin", BUNDLED_SELECTOR, "test"])).toEqual([]);
  });

  it("gives a nested run child the bundled prefix without duplicating it", function* () {
    // The outer command held the bundled value itself — an operator who wrote
    // the reserved selector holds exactly this object. Prefixing it again would
    // be the host duplicating itself, so it is dropped by identity.
    expect(nestedRunProfile([BUNDLED_PLUGIN]).map((plugin) => plugin.name)).toEqual([GIT]);
    expect(nestedRunProfile([]).map((plugin) => plugin.name)).toEqual([GIT]);

    // And an unrelated Plugin keeps its place behind the prefix.
    const other = Plugin({
      name: "other",
      // deno-lint-ignore require-yield
      *install(): Operation<undefined> {
        return undefined;
      },
    });
    expect(nestedRunProfile([other]).map((plugin) => plugin.name)).toEqual([GIT, "other"]);
  });

  it("refuses an impostor claiming the bundled name rather than dropping it", function* () {
    // A distinct object that merely *says* it is `@executablemd/git`. Comparing
    // names would make it vanish — silently replaced by the trusted value,
    // which is the outcome an impostor would want. Comparing identity keeps it
    // in the list, where a name collision has always been refused.
    const impostor = Plugin({
      name: GIT,
      // deno-lint-ignore require-yield
      *install(): Operation<undefined> {
        return undefined;
      },
    });
    expect(impostor).not.toBe(BUNDLED_PLUGIN);

    const assembled = nestedRunProfile([impostor]);
    expect(assembled).toHaveLength(2);
    expect(assembled[1]).toBe(impostor);

    const failure = yield* raised(installPlugins(assembled, { command: "run", args: ["run"] }));
    expect(String(failure)).toContain(`two selected Plugins are named ${GIT}`);
  });

  it("leaves the selector's own spelling to the host, not a registry", function* () {
    // The reserved word is `git`. A module *named* `@executablemd/git` is not
    // the selector and is loaded like any other specifier — where it would then
    // meet `admitPlugins()`'s duplicate-name refusal, which is the whole point
    // of keeping idempotence to the host's own selector.
    const failure = yield* reached(["--plugin", GIT, "run", "doc.md"]);
    expect(String(failure)).toContain(`a module was loaded: ${GIT}`);
  });
});

/** What a command line raised, when reaching a module is the expected outcome. */
function* reached(args: readonly string[]): Operation<unknown> {
  try {
    yield* profile(args);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** What an operation raised, when a refusal is the expected outcome. */
function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* scoped(function* () {
      return yield* operation;
    });
    return undefined;
  } catch (error) {
    return error;
  }
}
