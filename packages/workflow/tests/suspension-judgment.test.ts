/**
 * Tier WAD — what a run's owner can decide about a delivered value by itself.
 *
 * A delivered value has to be judged where it is written, and a run's owner
 * cannot compile a schema or load a scanner. So both decisions are written in
 * the language itself, and what has to be true of them is different in each
 * case.
 *
 * For the schema judgment the claim is parity: on every schema it admits it
 * reaches the same verdict as the compiler the document path uses, and it
 * admits nothing it cannot judge — a schema using an unimplemented keyword is
 * refused outright rather than judged with that constraint quietly skipped.
 *
 * For the credential gate the claim is narrower and is stated as narrowly: it
 * is a floor the owner applies at the write, not a replacement for the scanner
 * the runner runs first. What it must do is match the shapes it names, leave
 * stand-ins alone, and never report what it matched.
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
import { describeCredentials, sightCredentials } from "../src/suspension/credentials.ts";

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

describe("judging an answer without a compiler", () => {
  it("reaches the compiler's verdict on every schema it admits", function* () {
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
    // The table is the evidence, so its size is part of the claim.
    expect(judged).toBeGreaterThan(70);
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

describe("the credential gate a run's owner applies at the write", () => {
  // deno-lint-ignore require-yield
  it("matches issued credentials, and reports only what kind", function* () {
    const canary = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}`;
    const sighted = sightCredentials(`{"note":"${canary}"}`);

    expect(sighted.map((sighting) => sighting.kind)).toEqual(["github-token"]);
    // The value never travels with the finding, in any field of it.
    expect(JSON.stringify(sighted)).not.toContain(canary);
    expect(describeCredentials(sighted)).toBe("github-token");
    expect(describeCredentials(sighted)).not.toContain(canary);
  });

  // deno-lint-ignore require-yield
  it("matches a bearer credential and a credential-named field", function* () {
    expect(
      sightCredentials("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345").map(
        (sighting) => sighting.kind,
      ),
    ).toContain("bearer-credential");
    expect(
      sightCredentials('{"apiKey":"AbCdEf0123456789xyz"}').map((sighting) => sighting.kind),
    ).toEqual(["credential-field"]);
    expect(
      sightCredentials('{"api_key":"AbCdEf0123456789xyz"}').map((sighting) => sighting.kind),
    ).toEqual(["credential-field"]);
  });

  // deno-lint-ignore require-yield
  it("leaves ordinary answers and stand-ins alone", function* () {
    for (const content of [
      '{"approved":true}',
      '{"note":"shipped the release"}',
      '{"apiKey":"your-api-key-here"}',
      '{"password":"example-value"}',
      '{"note":"short"}',
      "",
    ]) {
      expect([content, sightCredentials(content)]).toEqual([content, []]);
    }
  });
});
