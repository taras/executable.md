/**
 * Tier PL — the Plugin value and what admits one.
 *
 * A Plugin is plain structural data, so the whole of what makes one is the
 * shape: a non-empty name and, optionally, a callable `install`. These rows
 * hold that the constructor adds nothing to it, and that admission — the
 * decision a loader makes about a value an untyped module exported — refuses
 * everything that is not one and names what failed.
 *
 * Admission lives here rather than at the loader because the same rule has to
 * answer for a value built with `Plugin({…})` and for one an external module
 * wrote out by hand. Two copies of the rule would be two rules.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { Plugin } from "../api.ts";
import type { PluginInstallation } from "../api.ts";
// Admission is the host boundary: a distribution decides what it will install.
import { parsePluginValue } from "../host.ts";

/** The message an admission refused with, or the name it admitted. */
function admitted(value: unknown): string {
  const result = parsePluginValue(value);
  return result.ok ? `ok:${result.value.name}` : result.error.message;
}

/** An install that contributes nothing, written the way a Plugin writes one. */
// deno-lint-ignore require-yield
function* inert(): Operation<PluginInstallation | undefined> {
  return undefined;
}

describe("PL1 — the constructor is type-preserving and nothing else", () => {
  // deno-lint-ignore require-yield
  it("returns the value it was given, unchanged", function* () {
    const input = { name: "example", install: inert };
    const plugin = Plugin(input);
    expect(plugin).toBe(input);
    expect(plugin.name).toBe("example");
    // No version, no package identity, no capability bag: what a Plugin
    // carries is what its author wrote.
    expect(Object.keys(plugin).sort()).toEqual(["install", "name"]);
  });

  // deno-lint-ignore require-yield
  it("accepts a Plugin that installs nothing", function* () {
    expect(Plugin({ name: "inert" }).install).toBe(undefined);
  });
});

describe("PL2 — admission reads an untyped export structurally", () => {
  // deno-lint-ignore require-yield
  it("admits a value carrying a name and a callable install", function* () {
    expect(admitted({ name: "ok", install: inert })).toBe("ok:ok");
  });

  // deno-lint-ignore require-yield
  it("admits a value carrying only a name", function* () {
    expect(admitted({ name: "ok" })).toBe("ok:ok");
    expect(admitted({ name: "ok", install: undefined })).toBe("ok:ok");
  });

  // deno-lint-ignore require-yield
  it("refuses a value that is not an object", function* () {
    for (const value of [undefined, null, "plugin", 7, true]) {
      expect(admitted(value)).toContain("is a Plugin value; this module exports none");
    }
  });

  // deno-lint-ignore require-yield
  it("refuses a value whose name is missing, empty or not text", function* () {
    for (const value of [{}, { name: "" }, { name: 7 }, { name: null }]) {
      expect(admitted(value)).toContain("carries a non-empty string `name`");
    }
  });

  // deno-lint-ignore require-yield
  it("refuses a value whose install is not callable, and says what it found", function* () {
    expect(admitted({ name: "broken", install: "yes" })).toBe(
      "a Plugin module's default export carries a callable `install`, and broken carries string",
    );
  });

  it("admits the value itself, so members this boundary does not read survive", function* () {
    const module = { name: "carries-more", version: "3.1.4", helper: () => "kept" };
    const plugin = parsePluginValue(module);
    if (!plugin.ok) {
      throw new Error("the module was not admitted as a Plugin");
    }
    // Identity, because a copy is the defect: a Plugin's own configuration, its
    // helpers and whatever else its package publishes beside the contract are
    // not this boundary's to drop.
    expect(plugin.value).toBe(module);
    expect(Reflect.get(plugin.value, "version")).toBe("3.1.4");
  });

  it("keeps the receiver an install was written against", function* () {
    // A Plugin written as an object literal with a method reads `this` for its
    // own state. Rebinding or wrapping `install` would hand it a different
    // receiver and the state would be gone — silently, at install time.
    const module = {
      name: "reads-this",
      label: "mine",
      *install(): Operation<PluginInstallation | undefined> {
        seen.push(Reflect.get(this, "label"));
        return undefined;
      },
    };
    const seen: unknown[] = [];
    const plugin = parsePluginValue(module);
    if (!plugin.ok || plugin.value.install === undefined) {
      throw new Error("the module was not admitted as a Plugin");
    }
    expect(plugin.value.install).toBe(module.install);
    yield* plugin.value.install({ command: "run", args: [] });
    expect(seen).toEqual(["mine"]);
  });

  it("calls the admitted install rather than a copy of it", function* () {
    const seen: string[] = [];
    const module = {
      name: "records",
      // deno-lint-ignore require-yield
      *install(): Operation<PluginInstallation | undefined> {
        seen.push("called");
        return undefined;
      },
    };
    const plugin = parsePluginValue(module);
    if (!plugin.ok || plugin.value.install === undefined) {
      throw new Error("the module was not admitted as a Plugin");
    }
    expect(yield* plugin.value.install({ command: "run", args: [] })).toBe(undefined);
    expect(seen).toEqual(["called"]);
  });
});
