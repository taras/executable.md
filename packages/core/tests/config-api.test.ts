/**
 * Tier CF — Config Api tests.
 *
 * The contextual timeout: base value, scoped overrides, validation, and
 * precedence of explicit operation timeouts over the contextual value.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import { API, Config, exec, timeout } from "@executablemd/runtime";

describe("Tier CF — Config Api", () => {
  it("CF1: base contextual timeout is 120 seconds", function* () {
    expect(yield* timeout).toBe(120_000);
  });

  it("CF2: scoped override wins inside its scope and resets outside", function* () {
    const inner = yield* scoped(function* () {
      yield* Config.around({ timeout: () => 5_000 }, { at: "min" });
      return yield* timeout;
    });
    expect(inner).toBe(5_000);
    expect(yield* timeout).toBe(120_000);
  });

  it("CF3: non-positive or non-finite contextual values are rejected", function* () {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = yield* scoped(function* () {
        yield* Config.around({ timeout: () => invalid }, { at: "min" });
        try {
          yield* timeout;
          return undefined;
        } catch (error) {
          return error;
        }
      });
      expect(result).toBeInstanceOf(Error);
    }
  });

  it("CF4: contextual timeout bounds exec when no explicit timeout is given", function* () {
    const outcome = yield* scoped(function* () {
      yield* Config.around({ timeout: () => 25 }, { at: "min" });
      try {
        yield* exec({ command: ["sleep", "2"] });
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(outcome).toBeInstanceOf(Error);
    if (outcome instanceof Error) {
      expect(outcome.message).toContain("timed out after 25ms");
    }
  });

  it("CF5: an explicit exec timeout takes precedence over the contextual value", function* () {
    const observed: number[] = [];
    yield* API.Process.around({
      *exec([options], next) {
        observed.push(options.timeout ?? -1);
        return yield* next(options);
      },
    });
    yield* scoped(function* () {
      yield* Config.around({ timeout: () => 10 }, { at: "min" });
      const result = yield* exec({ command: ["echo", "ok"], timeout: 5_000 });
      expect(result.exitCode).toBe(0);
    });
    expect(observed).toEqual([5_000]);
  });
});
