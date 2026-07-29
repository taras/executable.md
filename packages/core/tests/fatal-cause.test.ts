/**
 * Tier FA — fatal error discovery (spec §6.11).
 *
 * `fatalCause` decides whether a failure ends the execution or becomes a
 * diagnostic, and it runs from every generic catch in expansion. A cause graph
 * is arbitrary — nothing stops one from pointing back at itself — so the
 * traversal has to survive whatever it is handed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import { InvocationTeardownError } from "../src/invocation.ts";
import { DocumentationError, fatalCause } from "../src/errors.ts";
import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";

function stale(): StaleInputError {
  return new StaleInputError("journal entry no longer describes this run");
}

describe("Tier FA — Fatal error discovery", () => {
  it("FA1: an error that is its own cause terminates the search", function* () {
    const error = new Error("ordinary");
    error.cause = error;

    expect(fatalCause(error)).toBeUndefined();
  });

  it("FA2: two errors causing each other terminate the search", function* () {
    const first = new Error("first");
    const second = new Error("second");
    first.cause = second;
    second.cause = first;

    expect(fatalCause(first)).toBeUndefined();
  });

  it("FA3: a cyclic aggregate terminates the search", function* () {
    const inner = new Error("inner");
    const aggregate = new AggregateError([inner], "aggregate");
    inner.cause = aggregate;

    expect(fatalCause(aggregate)).toBeUndefined();
  });

  it("FA4: a cyclic teardown graph terminates the search", function* () {
    const inner = new Error("inner");
    const teardown = new InvocationTeardownError([inner]);
    inner.cause = teardown;

    expect(fatalCause(teardown)).toBeUndefined();
  });

  // FA5: cycle safety must not cost discovery — the reason the traversal
  // exists is that a fatal error arrives wrapped.
  it("FA5: a fatal error is still found inside a wrapper", function* () {
    const fatal = stale();

    expect(fatalCause(new InvocationTeardownError([fatal]))).toBe(fatal);
    expect(fatalCause(new AggregateError([new Error("other"), fatal]))).toBe(fatal);
    expect(fatalCause(new Error("wrapper", { cause: fatal }))).toBe(fatal);
  });

  it("FA6: a fatal error survives a wrapper that is also cyclic", function* () {
    const fatal = stale();
    const noise = new Error("noise");
    const teardown = new InvocationTeardownError([noise, fatal]);
    noise.cause = teardown;

    expect(fatalCause(teardown)).toBe(fatal);
  });

  it("FA7: a documentation failure is found the same way", function* () {
    const fatal = new DocumentationError({ type: "error", message: "boom", source: "x" });

    expect(fatalCause(new InvocationTeardownError([fatal]))).toBe(fatal);
  });

  // FA8: the whole point, end to end. A cyclic ordinary error reaches
  // expansion's catch, is collected as a diagnostic, and the next block runs —
  // rather than overflowing the stack on the way to that decision.
  it("FA8: a cyclic ordinary error is collected and later content still runs", function* () {
    const expanded = yield* scoped(function* () {
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *applyModifiers([_modifiers, block], _next) {
            if (block.content.includes("boom")) {
              const error = new Error("ordinary cyclic failure");
              error.cause = error;
              throw error;
            }
            return { output: "second block ran", exitCode: 0, stderr: "" };
          },
        },
        { at: "min" },
      );
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      return yield* expandSegments(
        scanSegments("```sh exec\nboom\n```\n\n```sh exec\nok\n```"),
        {},
        {},
        new Set(),
      );
    });

    const output = renderSegments(expanded);
    expect(output).toContain("ordinary cyclic failure");
    expect(output).toContain("second block ran");
  });
});
