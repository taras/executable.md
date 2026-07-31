/**
 * Tier CP — capture props (spec §6.5).
 *
 * A capture is a prop the engine does not resolve. The component evaluates it
 * itself, so the value arrives live: no JSON gate, no clone, and therefore an
 * operand a schema cannot describe — a RegExp, `undefined`, a specific object.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { Component, capture, hasCapture } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import type { EvalEnv, FunctionComponentDefinition, Json } from "../src/types.ts";

describe("Tier CP — capture props", () => {
  it("CP1: delivers an operand by identity, unserialized", function* () {
    const marker = { live: true };
    const re = /abc/;
    let seen: Record<string, unknown> = {};
    const def: FunctionComponentDefinition = {
      kind: "function",
      name: "Probe",
      props: { type: "object", properties: {}, additionalProperties: false },
      captures: ["actual", "expected"],
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return "";
      },
    };
    const probing: FunctionComponentDefinition = {
      ...def,
      *fn(): Operation<Json> {
        seen = {
          hasActual: yield* hasCapture("actual"),
          hasMissing: yield* hasCapture("nope"),
          actual: yield* capture("actual"),
          expected: yield* capture("expected"),
        };
        return "";
      },
    };
    yield* scoped(function* () {
      const env: EvalEnv = { values: { marker, re } };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return probing;
          },
        },
        { at: "min" },
      );
      yield* expandSegments(
        scanSegments("<Probe actual={marker} expected={re} />\n"),
        {},
        {},
        new Set(),
      );
    });
    expect(seen.hasActual).toBe(true);
    expect(seen.hasMissing).toBe(false);
    expect(seen.actual).toBe(marker);
    expect(seen.expected).toBe(re);
  });
});
