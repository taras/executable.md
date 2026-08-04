/**
 * A function component's printed error, observed and settled exactly once
 * (spec §6.9).
 *
 * Rescued from the expansion-hook suite, which pinned this against a claiming
 * handler. The contract belongs to the component boundary rather than to that
 * hook, so it is pinned here against a component instead — supplied through the
 * `importComponent` seam, because this drives `expandSegments` directly and
 * only `execute()` installs a provider that reads registrations.
 *
 * `raise()` is where settlement happens: it puts the segment through the
 * observation chain and applies the ambient error mode. What the component returns
 * afterwards is ordinary output, not something settled a second time.
 *
 * The two other engine behaviors that suite pinned are covered elsewhere and
 * are not duplicated here: resolution order between a registration and a
 * repository file is Tier CR (component-registration.test.ts), and what a
 * component learns about its call site — name, position, projected bindings —
 * is Tier IM (invocation-metadata.test.ts) plus the caller-bindings parity in
 * capture-props.test.ts.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { Component, raise } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import type { EvalEnv } from "../src/types.ts";

describe("a function component's printed error", () => {
  it("is observed once and settled by the engine", function* () {
    const raised: string[] = [];
    const output = yield* scoped(function* () {
      const env: EvalEnv = { values: {} };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around({
        *raise([segment], next) {
          raised.push(segment.message);
          return yield* next(segment);
        },
      });
      // Supplied through the import seam rather than the registry: this drives
      // expandSegments directly, and only execute() installs a provider that
      // reads registrations.
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return {
              kind: "function",
              name: "Broken",
              props: { type: "object", properties: {}, additionalProperties: false },
              *fn() {
                const reported = yield* raise({
                  type: "error",
                  message: "broken thing",
                  source: "Broken",
                });
                return reported.message;
              },
            };
          },
        },
        { at: "min" },
      );
      return renderSegments(yield* expandSegments(scanSegments("<Broken />"), {}, {}, new Set()));
    });

    expect(raised).toEqual(["broken thing"]);
    expect(output).toContain("broken thing");
  });
});
