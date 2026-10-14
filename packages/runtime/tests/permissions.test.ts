/**
 * Tier PM — the Permissions Api.
 *
 * What is asserted here is composition, and nothing else: no filesystem, no
 * transport and no provider appears, because the rows that prove a provider
 * asks this question live beside the provider. The question these answer is
 * whether a `false` installed by one scope can be undone by another — which is
 * the whole of what a restriction is for.
 *
 * Every restriction below is installed at the default order, with no `at`
 * option, because that default is the convention a host writing one will
 * follow and it is the ordering the guarantee depends on.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { Permissions } from "../mod.ts";
import { Permissions as configured } from "../api.ts";
import type { FetchInit } from "../mod.ts";

/** One request, as a restriction saw it. */
interface Seen {
  input: string;
  init: FetchInit | undefined;
}

describe("Tier PM — Permissions", () => {
  it("PM1: both members permit when nothing is installed", function* () {
    expect(yield* Permissions.operations.files("read")).toBe(true);
    expect(yield* Permissions.operations.files("write")).toBe(true);
    expect(
      yield* Permissions.operations.fetch("https://example.invalid/", { method: "POST" }),
    ).toBe(true);
  });

  it("PM2: a restriction refuses its own class and reads the actual request", function* () {
    const seen: Seen[] = [];
    yield* scoped(function* () {
      yield* Permissions.around({
        files: ([operation], next) => (operation === "write" ? false : next(operation)),
        fetch: ([input, init], next) => {
          seen.push({ input, init });
          const method = init?.method ?? "GET";
          return method === "GET" || method === "HEAD" ? next(input, init) : false;
        },
      });

      expect(yield* Permissions.operations.files("read")).toBe(true);
      expect(yield* Permissions.operations.files("write")).toBe(false);
      expect(yield* Permissions.operations.fetch("https://example.invalid/a")).toBe(true);
      expect(
        yield* Permissions.operations.fetch("https://example.invalid/b", { method: "POST" }),
      ).toBe(false);
    });

    // The arguments the caller passed, not a copy a restriction had to
    // reconstruct: what a host narrows destinations by is the request itself.
    expect(seen).toEqual([
      { input: "https://example.invalid/a", init: undefined },
      { input: "https://example.invalid/b", init: { method: "POST" } },
    ]);
  });

  it("PM3: a descendant cannot answer true over an enclosing refusal", function* () {
    let asked = false;
    yield* scoped(function* () {
      yield* Permissions.around({
        files: ([operation], next) => (operation === "write" ? false : next(operation)),
      });

      yield* scoped(function* () {
        // What a scope that wants more than it was given would write. It never
        // runs for the refused class, because the enclosing restriction answers
        // without delegating — so this is also the control that the ordering,
        // rather than the reading, is what decides.
        yield* Permissions.around({
          files: () => {
            asked = true;
            return true;
          },
        });

        expect(yield* Permissions.operations.files("write")).toBe(false);
        expect(asked).toBe(false);

        // The permitted class still reaches it, which is how we know the
        // descendant was installed at all rather than silently dropped.
        expect(yield* Permissions.operations.files("read")).toBe(true);
        expect(asked).toBe(true);
      });
    });
  });

  it("PM4: delegated restrictions intersect, and a sibling keeps its allowance", function* () {
    yield* scoped(function* () {
      yield* Permissions.around({
        files: ([operation], next) => (operation === "write" ? false : next(operation)),
      });

      yield* scoped(function* () {
        yield* Permissions.around({
          files: ([operation], next) => (operation === "read" ? false : next(operation)),
        });

        // Neither class survives both restrictions: each refusal is the one its
        // own installer made, and delegation is what carries the other through.
        expect(yield* Permissions.operations.files("read")).toBe(false);
        expect(yield* Permissions.operations.files("write")).toBe(false);
      });

      // Leaving that scope restores the enclosing allowance. The narrower
      // restriction was never a property of the run; it was a property of the
      // region, and this is the sibling of it.
      expect(yield* Permissions.operations.files("read")).toBe(true);
      expect(yield* Permissions.operations.files("write")).toBe(false);
    });

    expect(yield* Permissions.operations.files("write")).toBe(true);
  });

  it("PM5: the root and /api exports are the same Api", function* () {
    // Installed through one entrypoint and read through the other. Two modules
    // that merely declare the same shape would each answer for themselves
    // here; the same Api answers once.
    yield* configured.around({
      files: ([operation], next) => (operation === "write" ? false : next(operation)),
    });

    expect(yield* Permissions.operations.files("write")).toBe(false);
    expect(yield* configured.operations.files("write")).toBe(false);
    expect(yield* Permissions.operations.files("read")).toBe(true);
  });
});
