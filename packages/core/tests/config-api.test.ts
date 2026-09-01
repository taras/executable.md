/**
 * Tier CF — Config Api (specs/acp-client-spec.md §Config).
 *
 * Three timeouts with three owners and no defaults: the run deadline, the exec
 * default, and the Fetch default. What these cases hold is that they stay
 * separate — an exec block never inherits the run's deadline, a Fetch never
 * inherits the exec default, and a field nobody configured is nothing rather
 * than a number somebody guessed.
 *
 * Contextual verbosity is the fourth field and bounds nothing. Its cases hold
 * the same separation from the other direction: it starts false, it overrides
 * and restores lexically the way a timeout does, and configuring it moves no
 * timeout — nor does configuring a timeout move it.
 *
 * The Process and Fetch cases ask which field each Api consults rather than
 * waiting for a command to be killed. Resolution happens inside each handler,
 * so an invalid configured value is the instrument: consulting it throws, and
 * completing proves it was never read. No clock takes part.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { Config, timeout, timeoutExec, timeoutFetch, verbose } from "@executablemd/core";
import { API, exec, fetch } from "@executablemd/runtime";
import { installInvalidTimeout, installInvalidVerbose } from "./invalid-config.fixture.js";

/** Every timeout an exec call was given while `body` ran. */
function* recordExec<T>(body: () => Operation<T>): Operation<(number | undefined)[]> {
  const seen: (number | undefined)[] = [];
  return yield* scoped(function* () {
    yield* API.Process.around({
      // deno-lint-ignore require-yield
      *exec([options]) {
        seen.push(options.timeout);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    yield* body();
    return seen;
  });
}

/**
 * Whether `body` completed, with an invalid configuration installed as a
 * tripwire.
 *
 * Resolution happens inside each Api's own handler, so middleware cannot see
 * the value it settled on. What it can see is whether the handler asked at
 * all: an invalid configured value throws when resolved, so completing proves
 * the field was never consulted and throwing proves it was.
 */
function* consulted(
  install: Operation<void>,
  body: Operation<unknown>,
): Operation<Error | undefined> {
  return yield* scoped(function* () {
    yield* install;
    try {
      yield* body;
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  });
}

describe("Tier CF — Config Api", () => {
  it("CF1: every timeout is absent until something configures it", function* () {
    expect(yield* timeout).toBe(undefined);
    expect(yield* timeoutExec).toBe(undefined);
    expect(yield* timeoutFetch).toBe(undefined);
  });

  it("CF2: a scoped override wins inside its scope and resets outside", function* () {
    const inner = yield* scoped(function* () {
      yield* Config.around({ timeoutExec: () => 5_000 }, { at: "min" });
      return yield* timeoutExec;
    });
    expect(inner).toBe(5_000);
    expect(yield* timeoutExec).toBe(undefined);
  });

  it("CF2a: configuring one field leaves the other two alone", function* () {
    yield* scoped(function* () {
      yield* Config.around({ timeoutExec: () => 5_000 }, { at: "min" });
      expect(yield* timeoutExec).toBe(5_000);
      expect(yield* timeout).toBe(undefined);
      expect(yield* timeoutFetch).toBe(undefined);
    });

    yield* scoped(function* () {
      yield* Config.around({ timeout: () => 1_000 }, { at: "min" });
      expect(yield* timeout).toBe(1_000);
      expect(yield* timeoutExec).toBe(undefined);
      expect(yield* timeoutFetch).toBe(undefined);
    });
  });

  it("CF2b: an omitted field inherits the enclosing value rather than clearing it", function* () {
    yield* Config.around({ timeout: () => 1_000, timeoutExec: () => 2_000 }, { at: "min" });
    yield* scoped(function* () {
      // Only timeoutFetch is written here; the other two are inherited.
      yield* Config.around({ timeoutFetch: () => 3_000 }, { at: "min" });
      expect(yield* timeout).toBe(1_000);
      expect(yield* timeoutExec).toBe(2_000);
      expect(yield* timeoutFetch).toBe(3_000);
    });
  });

  it("CF3: zero, negative, NaN, Infinity, and non-number values are rejected", function* () {
    const numeric: number[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const invalid of numeric) {
      for (const field of ["timeout", "timeoutExec", "timeoutFetch"] as const) {
        const result = yield* scoped(function* () {
          yield* Config.around({ [field]: () => invalid }, { at: "min" });
          try {
            yield* field === "timeout"
              ? timeout
              : field === "timeoutExec"
                ? timeoutExec
                : timeoutFetch;
            return undefined;
          } catch (error) {
            return error;
          }
        });
        expect(result).toBeInstanceOf(Error);
      }
    }

    // Non-number values a JavaScript consumer could supply — installed
    // through the untyped fixture, never via a TypeScript assertion.
    const nonNumber: unknown[] = ["500", null, "30s"];
    for (const invalid of nonNumber) {
      const result = yield* scoped(function* () {
        yield* installInvalidTimeout(invalid, "timeoutExec");
        try {
          yield* timeoutExec;
          return undefined;
        } catch (error) {
          return error;
        }
      });
      expect(result).toBeInstanceOf(Error);
    }
  });

  it("CF4: exec consults neither the run deadline nor the Fetch default", function* () {
    const failed = yield* consulted(
      installInvalidTimeout("500", "timeout"),
      exec({ command: ["echo", "hi"] }),
    );
    expect(failed).toBe(undefined);

    const viaFetchDefault = yield* consulted(
      installInvalidTimeout("500", "timeoutFetch"),
      exec({ command: ["echo", "hi"] }),
    );
    expect(viaFetchDefault).toBe(undefined);
  });

  it("CF4a: exec consults no configuration at all — its caller resolves the bound", function* () {
    // `timeoutExec` is what an exec *block* resolves and passes; the Api
    // itself bounds only what its caller asked for. A fallback here would
    // bound every direct `exec()` a component or script makes.
    const failed = yield* consulted(
      installInvalidTimeout("500", "timeoutExec"),
      exec({ command: ["echo", "hi"] }),
    );
    expect(failed).toBe(undefined);
  });

  it("CF5: an explicit exec timeout reaches the operation unchanged", function* () {
    const seen = yield* recordExec(() => exec({ command: ["echo", "hi"], timeout: 5_000 }));
    expect(seen).toEqual([5_000]);
  });

  it("CF5a: an explicit exec timeout is used without consulting configuration", function* () {
    // An invalid contextual value is a tripwire: resolving it throws, so a
    // successful run proves the explicit value short-circuited it.
    yield* installInvalidTimeout("500", "timeoutExec");
    const result = yield* exec({ command: ["echo", "hi"], timeout: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hi");
  });

  it("CF6: fetch resolves the Fetch default when the call supplies none", function* () {
    const failed = yield* consulted(
      installInvalidTimeout("500", "timeoutFetch"),
      fetch("data:text/plain,hello"),
    );
    expect(failed?.message).toContain("Config timeoutFetch must be a positive");
  });

  it("CF7: an explicit fetch timeout outranks the Fetch default", function* () {
    const failed = yield* consulted(
      installInvalidTimeout("500", "timeoutFetch"),
      fetch("data:text/plain,hello", { timeout: 9_000 }),
    );
    expect(failed).toBe(undefined);
  });

  it("CF8: fetch consults neither the run deadline nor the exec default", function* () {
    const viaRun = yield* consulted(
      installInvalidTimeout("500", "timeout"),
      fetch("data:text/plain,hello"),
    );
    expect(viaRun).toBe(undefined);

    const viaExecDefault = yield* consulted(
      installInvalidTimeout("500", "timeoutExec"),
      fetch("data:text/plain,hello"),
    );
    expect(viaExecDefault).toBe(undefined);
  });

  it("CF9: verbosity is false until something configures it", function* () {
    expect(yield* verbose).toBe(false);
  });

  it("CF10: a scoped verbosity override wins inside its scope and resets outside", function* () {
    const inner = yield* scoped(function* () {
      yield* Config.around({ verbose: () => true }, { at: "min" });
      return yield* verbose;
    });
    expect(inner).toBe(true);
    expect(yield* verbose).toBe(false);
  });

  it("CF10a: a nested false wins beneath an enclosing true", function* () {
    yield* Config.around({ verbose: () => true }, { at: "min" });
    const inner = yield* scoped(function* () {
      yield* Config.around({ verbose: () => false }, { at: "min" });
      return yield* verbose;
    });
    expect(inner).toBe(false);
    // The enclosing value is what the scope after the override reads.
    expect(yield* verbose).toBe(true);
  });

  it("CF10b: verbosity and the three timeouts move independently", function* () {
    yield* scoped(function* () {
      yield* Config.around({ verbose: () => true }, { at: "min" });
      expect(yield* verbose).toBe(true);
      expect(yield* timeout).toBe(undefined);
      expect(yield* timeoutExec).toBe(undefined);
      expect(yield* timeoutFetch).toBe(undefined);
    });

    yield* scoped(function* () {
      yield* Config.around({ timeoutExec: () => 5_000 }, { at: "min" });
      expect(yield* timeoutExec).toBe(5_000);
      expect(yield* verbose).toBe(false);
    });
  });

  it("CF11: a verbosity that is not a boolean is refused when it is read", function* () {
    // Truthiness is not the question a reader asked, so anything a plain
    // JavaScript consumer can install and TypeScript forbids fails here.
    for (const invalid of ["true", "false", 1, 0, null] as unknown[]) {
      const result = yield* scoped(function* () {
        yield* installInvalidVerbose(invalid);
        try {
          yield* verbose;
          return undefined;
        } catch (error) {
          return error;
        }
      });
      expect(result).toBeInstanceOf(Error);
    }
  });
});
