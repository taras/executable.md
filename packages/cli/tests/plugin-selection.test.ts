/**
 * Tier PS — the `--plugin` grammar, and what it leaves for every other scanner.
 *
 * A pure function over argv. What these rows hold is that selection reads the
 * command line the caller wrote, removes exactly the tokens that selected a
 * Plugin, and hands every existing scanner an argv that looks as though the
 * option had never been written — including the separator, after which a
 * document reference or a request keeps the meaning it already had.
 *
 * The frozen original argv is the other half: an install request carries the
 * command line as the caller wrote it, so a Plugin whose decision the top-level
 * command cannot carry reads that rather than somebody else's parsed values.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { selectPlugins } from "../src/plugin-selection.ts";

describe("PS1 — both spellings, in the order they were written", () => {
  // deno-lint-ignore require-yield
  it("reads the separated and the assigned form alike", function* () {
    const selection = selectPlugins(["run", "--plugin", "./a.mjs", "--plugin=./b.mjs", "doc.md"]);
    expect(selection.specifiers).toEqual(["./a.mjs", "./b.mjs"]);
    expect(selection.rest).toEqual(["run", "doc.md"]);
    expect(selection.error).toBe(undefined);
  });

  // deno-lint-ignore require-yield
  it("keeps occurrence order rather than sorting or deduplicating", function* () {
    const selection = selectPlugins(["--plugin=z", "--plugin=a", "--plugin=z"]);
    expect(selection.specifiers).toEqual(["z", "a", "z"]);
  });

  // deno-lint-ignore require-yield
  it("retains the original argv, frozen, whatever it removed from the rest", function* () {
    const written = ["run", "--plugin", "./a.mjs", "doc.md"];
    const selection = selectPlugins(written);
    expect(selection.args).toEqual(written);
    expect(Object.isFrozen(selection.args)).toBe(true);
    expect(selection.rest).toEqual(["run", "doc.md"]);
    // And the caller's own array is untouched.
    expect(written).toEqual(["run", "--plugin", "./a.mjs", "doc.md"]);
  });
});

describe("PS2 — the separator ends the scan", () => {
  // deno-lint-ignore require-yield
  it("leaves every token after `--` exactly where it was written", function* () {
    const selection = selectPlugins(["run", "--", "--plugin", "./a.mjs"]);
    expect(selection.specifiers).toEqual([]);
    expect(selection.rest).toEqual(["run", "--", "--plugin", "./a.mjs"]);
  });

  // deno-lint-ignore require-yield
  it("still reads what was written before the separator", function* () {
    const selection = selectPlugins(["run", "--plugin=./a.mjs", "--", "-"]);
    expect(selection.specifiers).toEqual(["./a.mjs"]);
    expect(selection.rest).toEqual(["run", "--", "-"]);
  });
});

describe("PS3 — a selection that names nothing is refused before anything loads", () => {
  // deno-lint-ignore require-yield
  it("refuses a trailing --plugin with no value", function* () {
    expect(selectPlugins(["run", "--plugin"]).error).toContain("names a module to load");
  });

  // deno-lint-ignore require-yield
  it("refuses an empty assigned value", function* () {
    expect(selectPlugins(["run", "--plugin="]).error).toContain("names a module to load");
  });

  // deno-lint-ignore require-yield
  it("refuses a separated value that reads as another option, and says how to write it", function* () {
    const selection = selectPlugins(["run", "--plugin", "--verbose"]);
    expect(selection.error).toContain("--plugin=--verbose");
  });
});

describe("PS4 — the command a Plugin is told about", () => {
  // deno-lint-ignore require-yield
  it("normalizes the shorthand document form to run", function* () {
    expect(selectPlugins(["doc.md"]).command).toBe("run");
    expect(selectPlugins([]).command).toBe("run");
    expect(selectPlugins(["--verbose", "doc.md"]).command).toBe("run");
    expect(selectPlugins(["--plugin=./a.mjs", "doc.md"]).command).toBe("run");
  });

  // deno-lint-ignore require-yield
  it("reports each public command by its own name", function* () {
    for (const command of ["run", "plan", "test", "syntax", "upgrade", "workflow"]) {
      expect(selectPlugins([command]).command).toBe(command);
      expect(selectPlugins(["--plugin=./a.mjs", command]).command).toBe(command);
    }
  });
});

describe("PS5 — describing a command line loads nothing", () => {
  // deno-lint-ignore require-yield
  it("installs no Plugin for help, version or the internal worker mode", function* () {
    expect(selectPlugins(["run", "--help"]).loads).toBe(false);
    expect(selectPlugins(["-h"]).loads).toBe(false);
    expect(selectPlugins(["--version"]).loads).toBe(false);
    expect(selectPlugins(["-v"]).loads).toBe(false);
    // `-V` is `--verbose`, which configures a run rather than describing one.
    expect(selectPlugins(["-V", "doc.md"]).loads).toBe(true);
    expect(selectPlugins(["test-agent", "--connect", "x"]).loads).toBe(false);
    expect(selectPlugins(["test-agent"]).command).toBe("test-agent");
  });

  // deno-lint-ignore require-yield
  it("installs them for every command that can run a document", function* () {
    for (const command of ["run", "plan", "test", "syntax", "upgrade", "workflow"]) {
      expect(`${command}: ${selectPlugins([command]).loads}`).toBe(`${command}: true`);
    }
  });

  // deno-lint-ignore require-yield
  it("reads a help flag written after the separator as an ordinary token", function* () {
    expect(selectPlugins(["run", "--", "--help"]).loads).toBe(true);
  });
});
