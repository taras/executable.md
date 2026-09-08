/**
 * Tier WAD — the owner's additional schema check, and what it is not.
 *
 * The settled contract is that a delivered value satisfies its wait's response
 * schema under the semantics the local host uses — `prepareElicitation` and
 * `validateParsed`, which compile with `new Function`. A deployed Worker does
 * not generate code, so a run's owner cannot run that compiler, and this module
 * is what it runs instead.
 *
 * It is **not** equivalent to that compiler and this file does not claim it is.
 * A table of agreements is not a proof of equivalence, and there is at least
 * one supported schema they disagree about: `{ type: "number", multipleOf: 0.1 }`
 * accepts `0.3` here and refuses it there. That disagreement is asserted below
 * rather than avoided, so nothing reads this table as parity.
 *
 * What it is for is refusing early and refusing more: the values it rejects are
 * values the compiler rejects too, on the schemas it admits, and a schema whose
 * keywords it does not implement is refused outright rather than judged with
 * that constraint quietly skipped.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { prepareElicitation, validateParsed } from "@executablemd/core";
import {
  judgeAgainstSchema,
  requireJudgeableSchema,
  UnjudgeableSchemaError,
} from "../src/suspension/judgment.ts";

/** One schema, and the values a caller might offer it. */
interface Case {
  readonly name: string;
  readonly schema: Json;
  readonly values: readonly Json[];
}

const CASES: readonly Case[] = [
  {
    name: "an approval object",
    schema: {
      type: "object",
      properties: { approved: { type: "boolean" }, note: { type: "string" } },
      required: ["approved"],
      additionalProperties: false,
    },
    values: [
      { approved: true },
      { approved: true, note: "shipped" },
      { approved: "yes" },
      { note: "shipped" },
      { approved: true, extra: 1 },
      [],
      "approved",
      null,
    ],
  },
  {
    name: "a bounded string",
    schema: { type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" },
    values: ["ab", "abcde", "a", "abcdef", "AB", "ab1", 12, null],
  },
  {
    name: "a bounded number",
    schema: { type: "number", minimum: 0, exclusiveMaximum: 10, multipleOf: 0.5 },
    values: [0, 9.5, 10, -1, 0.25, 3, true],
  },
  {
    name: "an integer",
    schema: { type: "integer", minimum: 1 },
    values: [1, 0, 1.5, 2, "1"],
  },
  {
    name: "a list of unique items",
    schema: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    },
    values: [["a"], ["a", "b"], [], ["a", "a"], ["a", "b", "c", "d"], [1], "a"],
  },
  {
    name: "a tuple with extra items",
    schema: {
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
      additionalItems: false,
      minItems: 2,
      maxItems: 2,
    },
    values: [["a", 1], ["a"], ["a", 1, true], [1, "a"]],
  },
  {
    name: "an enumeration",
    schema: { enum: ["yes", "no", null] },
    values: ["yes", "no", null, "maybe", 1],
  },
  {
    name: "a constant",
    schema: { const: { kind: "approval" } },
    values: [{ kind: "approval" }, { kind: "approval", extra: 1 }, "approval"],
  },
  {
    name: "alternatives",
    schema: { anyOf: [{ type: "string" }, { type: "number", minimum: 0 }] },
    values: ["a", 1, -1, true, null],
  },
  {
    name: "exactly one alternative",
    schema: {
      oneOf: [
        { type: "number", minimum: 0 },
        { type: "number", maximum: 10 },
      ],
    },
    values: [-1, 11, 5, "a"],
  },
  {
    name: "everything at once",
    schema: {
      type: "object",
      allOf: [
        { type: "object" },
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      ],
      properties: { id: { type: "string", minLength: 1 } },
    },
    values: [{ id: "a" }, { id: "" }, {}, "a"],
  },
  {
    name: "an exclusion",
    schema: { not: { type: "string" } },
    values: ["a", 1, null, {}],
  },
  {
    name: "a nullable member",
    schema: {
      type: "object",
      properties: { note: { type: ["string", "null"] } },
      additionalProperties: true,
    },
    values: [{ note: "a" }, { note: null }, { note: 1 }, { other: 1 }],
  },
  {
    name: "bounded property counts",
    schema: { type: "object", minProperties: 1, maxProperties: 2 },
    values: [{}, { a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }],
  },
  {
    name: "constrained property names",
    schema: { type: "object", propertyNames: { type: "string", pattern: "^[a-z]+$" } },
    values: [{ ok: 1 }, { NotOk: 1 }, {}],
  },
  {
    name: "a nested object",
    schema: {
      type: "object",
      properties: {
        who: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      required: ["who"],
    },
    values: [{ who: { name: "a" } }, { who: {} }, { who: { name: 1 } }, { who: "a" }, {}],
  },
];

/** What the compiler the document path uses says about one value. */
function* compiled(schema: Json, value: Json): Operation<boolean> {
  const prepared = yield* prepareElicitation(schema, "parity");
  return validateParsed(prepared.validate, value).length === 0;
}

describe("the owner's additional schema check", () => {
  it("agrees with the compiler across this table, which is not equivalence", function* () {
    const disagreed: string[] = [];
    let judged = 0;
    for (const example of CASES) {
      requireJudgeableSchema(example.schema);
      for (const value of example.values) {
        judged += 1;
        const expected = yield* compiled(example.schema, value);
        const found = judgeAgainstSchema(example.schema, value).length === 0;
        if (expected !== found) {
          disagreed.push(
            `${example.name}: ${JSON.stringify(value)} — compiler ${expected}, judgment ${found}`,
          );
        }
      }
    }

    expect(disagreed).toEqual([]);
    // The table's size is part of what it is worth, and its worth is bounded:
    // agreement on these cases says nothing about the cases not in it.
    expect(judged).toBeGreaterThan(70);
  });

  it("is not equivalent to the compiler, and here is where they differ", function* () {
    // A supported schema an ordinary wait can retain, and a value the two
    // reach opposite verdicts on. Asserted rather than avoided: this is the
    // exact gap that keeps the owner from being the settled authority.
    const schema: Json = { type: "number", multipleOf: 0.1 };
    requireJudgeableSchema(schema);

    expect(yield* compiled(schema, 0.3)).toBe(false);
    expect(judgeAgainstSchema(schema, 0.3).length === 0).toBe(true);
  });

  // deno-lint-ignore require-yield
  it("refuses a schema whose constraints it cannot apply", function* () {
    const unjudgeable: Json[] = [
      { $ref: "#/definitions/other" },
      { if: { type: "string" }, else: { minLength: 1 } },
      { type: "object", patternProperties: { "^a": { type: "string" } } },
      { type: "object", dependencies: { a: ["b"] } },
      { type: "array", contains: { type: "string" } },
      { type: "object", unevaluatedProperties: false },
      { type: "wrong" },
      { type: "object", properties: { a: { $ref: "#" } } },
      { anyOf: [] },
      { pattern: "([" },
      { minLength: -1 },
      { multipleOf: 0 },
    ];

    for (const schema of unjudgeable) {
      let refused: unknown;
      try {
        requireJudgeableSchema(schema);
      } catch (error) {
        refused = error;
      }
      expect([JSON.stringify(schema), refused instanceof UnjudgeableSchemaError]).toEqual([
        JSON.stringify(schema),
        true,
      ]);
    }

    // And an admitted schema stays admitted, so the refusal is about the
    // keyword rather than about being cautious.
    expect(() => requireJudgeableSchema({ type: "object", title: "fine" })).not.toThrow();
  });
});
