/**
 * Tier CF — Config Api (specs/acp-client-spec.md §Config).
 *
 * The contextual timeout: base value, scoped override, validation, and
 * the Process and Fetch operations that resolve it when a call supplies
 * no timeout of its own. Imported through @executablemd/core to exercise
 * the core re-export.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { Config, timeout } from "@executablemd/core";
import { exec, fetch } from "@executablemd/runtime";
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

  it("CF4: the contextual timeout bounds exec when the call supplies none", function* () {
    yield* Config.around({ timeout: () => 25 }, { at: "min" });
    let message = "";
    try {
      yield* exec({ command: ["sleep", "2"] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("timed out after 25ms");
  });

  it("CF5: an explicit exec timeout is used without consulting the contextual value", function* () {
    // An invalid contextual timeout is a tripwire: resolving it throws, so
    // a successful run proves the explicit value short-circuited it.
    yield* installInvalidTimeout("500");
    const result = yield* exec({ command: ["echo", "hi"], timeout: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hi");
  });

  it("CF6: fetch resolves the contextual timeout when the call supplies none", function* () {
    yield* installInvalidTimeout("500");
    let message = "";
    try {
      yield* fetch("data:text/plain,hello");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Config timeout must be a positive");
  });

  it("CF7: an explicit fetch timeout is used without consulting the contextual value", function* () {
    yield* installInvalidTimeout("500");
    const response = yield* fetch("data:text/plain,hello", { timeout: 5_000 });
    expect(response.status).toBe(200);
  });
});
