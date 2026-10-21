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
 *
 * What the value *is* comes from the host: a Deno or compiled entrypoint
 * selects a configured native variant before any command is dispatched, and
 * Node and Bun leave the provider-neutral default. These rows select a distinct
 * object deliberately, and assert on identity rather than on the name, because
 * a prefix hard-coded to the statically imported default would pass every
 * name-shaped assertion while delivering the wrong host's Plugin.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import {
  assembleRunProfile,
  BUNDLED_PLUGIN,
  BUNDLED_SELECTOR,
  BundledRunPlugin,
  nestedRunProfile,
} from "../src/run-profile.ts";
import { installPlugins } from "../src/plugin-host.ts";
import { Plugin } from "@executablemd/core/api";
import type { CommandPlugins } from "../src/plugin-host.ts";
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

/** The values one command line assembles, with this host's own selection made. */
function selected(args: readonly string[]): Operation<readonly Plugin[]> {
  return scoped(function* () {
    yield* BundledRunPlugin.set(CONFIGURED);
    return yield* assembleRunProfile(selectPlugins(args), refusing);
  });
}

const GIT = "@executablemd/git";

/**
 * What a runtime entrypoint selects: the bundled Plugin, configured.
 *
 * A distinct object under the bundled name, which is what a native variant is.
 * Nothing here needs it to do anything — the question these rows ask is which
 * object arrives.
 */
const CONFIGURED: Plugin = Plugin({
  name: GIT,
  // deno-lint-ignore require-yield
  *install(): Operation<undefined> {
    return undefined;
  },
});

describe("the bundled run profile", () => {
  it("carries the bundled Plugin for the commands that reach a document", function* () {
    for (const args of [["run", "doc.md"], ["plan", "doc.md"], ["syntax"], ["doc.md"]]) {
      expect(`${args.join(" ")}: ${(yield* profile(args)).join(",")}`).toBe(
        `${args.join(" ")}: ${GIT}`,
      );
    }
  });

  it("carries it for the REPL, with this command's own entry-history admission", function* () {
    // The REPL runs a document a person typed, so the Git vocabulary is
    // available there exactly as it is to `run` — and it arrives through this
    // command's own assembly of the bundled value rather than from the bundled
    // Plugin's own predicate, which declines `repl`. The names are registered
    // by the contribution, as they are for every other command; what is this
    // command's own is the admission that reads back what an entry wrote down
    // about the checkout it was standing in.
    expect(`repl: ${(yield* profile(["repl"])).join(",")}`).toBe(`repl: ${GIT}`);

    const admissions = function* (command: string): Operation<number> {
      const installed = yield* scoped(function* (): Operation<CommandPlugins> {
        return yield* installPlugins([BUNDLED_PLUGIN], { command, args: [command] });
      });
      return installed.installations.flatMap((one) => [...(one.admissions ?? [])]).length;
    };
    // Both sides, so the third admission is specifically this command's rather
    // than something every command happens to carry: `run` gets Git's two
    // domain admissions, and `repl` gets those two with the entry-history one
    // beside them, from inside the same contribution.
    expect(`run: ${yield* admissions("run")}`).toBe("run: 2");
    expect(`repl: ${yield* admissions("repl")}`).toBe("repl: 3");
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

  it("assembles the value this host selected, and the default where it selects none", function* () {
    // The host's selection reaches the profile as the bundled prefix.
    expect(yield* selected(["run", "doc.md"])).toEqual([CONFIGURED]);
    // And with nothing selected, the provider-neutral default stands: that is
    // what Node and Bun run with.
    expect(
      yield* scoped(() => assembleRunProfile(selectPlugins(["run", "doc.md"]), refusing)),
    ).toEqual([BUNDLED_PLUGIN]);
  });

  it("resolves the reserved selector to the selected value without loading anything", function* () {
    // Once, five times, and beside an ineligible command: the selector names
    // the value this host selected, so it is consumed rather than resolved —
    // and it is that object, not the statically imported default.
    expect(yield* selected(["--plugin", BUNDLED_SELECTOR, "run", "doc.md"])).toEqual([CONFIGURED]);
    expect(
      yield* selected([
        "--plugin",
        BUNDLED_SELECTOR,
        "--plugin",
        BUNDLED_SELECTOR,
        "--plugin=git",
        "run",
        "doc.md",
      ]),
    ).toEqual([CONFIGURED]);
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

  it("gives a nested run child the captured value without duplicating it", function* () {
    // The value a child installs is the one its parent captured from the host,
    // so these are identities rather than names: a child handed the neutral
    // default where the host selected a configured variant would install the
    // wrong Plugin under the right name.
    expect(nestedRunProfile([CONFIGURED], CONFIGURED)).toEqual([CONFIGURED]);
    expect(nestedRunProfile([], CONFIGURED)).toEqual([CONFIGURED]);

    // And an unrelated Plugin keeps its place behind the prefix.
    const other = Plugin({
      name: "other",
      // deno-lint-ignore require-yield
      *install(): Operation<undefined> {
        return undefined;
      },
    });
    expect(nestedRunProfile([other], CONFIGURED)).toEqual([CONFIGURED, other]);
    // The outer list's own order is what follows the prefix.
    const third = Plugin({ name: "third" });
    expect(nestedRunProfile([other, third], CONFIGURED)).toEqual([CONFIGURED, other, third]);
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
    expect(impostor).not.toBe(CONFIGURED);

    const assembled = nestedRunProfile([impostor], CONFIGURED);
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
