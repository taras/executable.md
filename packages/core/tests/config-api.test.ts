/**
 * Tier CF — Config Api (specs/acp-client-spec.md §Config).
 *
 * The contextual timeout: base value, scoped override, and validation.
 * Imported through @executablemd/core to exercise the core re-export.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import { Config, timeout } from "@executablemd/core";
import { installInvalidTimeout } from "./invalid-config.fixture.js";

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

  it("CF3: zero, negative, NaN, Infinity, and non-number values are rejected", function* () {
    // Numeric-but-invalid values are rejected (typed, no assertion).
    const numeric: number[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const invalid of numeric) {
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

    // Non-number values a JavaScript consumer could supply — installed
    // through the untyped fixture, never via a TypeScript assertion.
    const nonNumber: unknown[] = ["500", null, undefined];
    for (const invalid of nonNumber) {
      const result = yield* scoped(function* () {
        yield* installInvalidTimeout(invalid);
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
});
