/**
 * The one judgment an elicitation response is held to.
 *
 * Everything here is about the difference between a schema and the data inside
 * one, and about what a failure is allowed to say. A schema carries values —
 * under `const`, `enum`, `default`, `examples` — and declares names, and a
 * transform that treated either as a schema would change what a document
 * asked for. A failure carries a location and a rule, and one that carried the
 * rejected value would publish it into every place an issue travels: the
 * evaluation environment, a printed error, a journal.
 *
 * The judgment is the same object at every boundary, so these are the claims
 * every boundary inherits.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Json, JsonObject } from "../src/types.ts";
import { prepareResponseValidator, ResponseSchemaError } from "../src/elicitation-schema.ts";

/** One schema written as JSON, so every declared name survives the parse. */
function schemaOf(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the fixture schema is not an object");
  }
  const held: JsonObject = {};
  for (const name of Object.getOwnPropertyNames(parsed)) {
    // Re-parsed rather than asserted: what a fixture holds is JSON, and this
    // walks it as such.
    held[name] = JSON.parse(JSON.stringify(Reflect.get(parsed, name) ?? null));
  }
  return held;
}

/** Whether one value satisfies one schema, through the production preparation. */
function admits(schema: Json, value: Json): boolean {
  return prepareResponseValidator("probe", schema).judge(value).length === 0;
}

/** What the failures say, as location and rule. */
function issuesOf(schema: Json, value: Json): { at: string; keyword: string; message: string }[] {
  return prepareResponseValidator("probe", schema)
    .judge(value)
    .map((issue) => ({ at: issue.instancePath, keyword: issue.keyword, message: issue.message }));
}

describe("what a schema means, and what is data inside it", () => {
  // deno-lint-ignore require-yield
  it("omits `format` where it is a keyword, at every schema position", function* () {
    // A format annotates and never constrains, at the root, beneath a
    // combinator, and through a local reference.
    expect(admits({ type: "string", format: "email" }, "not an email")).toBe(true);
    expect(
      admits({ anyOf: [{ type: "string", format: "email" }, { type: "number" }] }, "not an email"),
    ).toBe(true);
    expect(
      admits(
        {
          definitions: { mail: { type: "string", format: "email" } },
          $ref: "#/definitions/mail",
        },
        "not an email",
      ),
    ).toBe(true);
    // And the declaration a provider is shown keeps it, because saying "this is
    // an email" is the point of writing it.
    expect(prepareResponseValidator("probe", { type: "string", format: "email" }).schema).toEqual({
      type: "string",
      format: "email",
    });
  });

  // deno-lint-ignore require-yield
  it("keeps a literal that happens to carry `format`, exactly", function* () {
    const constant = { const: { format: "email", x: 1 } };
    expect(admits(constant, { format: "email", x: 1 })).toBe(true);
    expect(admits(constant, { x: 1 })).toBe(false);
    expect(admits(constant, { format: "other", x: 1 })).toBe(false);

    const enumerated = { enum: [{ format: "email" }, { format: "uri" }] };
    expect(admits(enumerated, { format: "uri" })).toBe(true);
    expect(admits(enumerated, {})).toBe(false);
  });

  // deno-lint-ignore require-yield
  it("keeps a declared name that happens to be `format`", function* () {
    const declared = schemaOf(
      '{"type":"object","properties":{"format":{"type":"string","format":"email"}},' +
        '"required":["format"],"additionalProperties":false}',
    );

    // The property exists and its own nested annotation constrains nothing, so
    // an ordinary string is admitted and the name is not treated as additional.
    expect(admits(declared, { format: "not-email" })).toBe(true);
    expect(admits(declared, { format: 1 })).toBe(false);
    expect(admits(declared, {})).toBe(false);

    // The same through a definition reached by reference.
    const referenced = schemaOf(
      '{"definitions":{"format":{"type":"string","format":"email"}},' +
        '"type":"object","properties":{"a":{"$ref":"#/definitions/format"}}}',
    );
    expect(admits(referenced, { a: "not-email" })).toBe(true);
    expect(admits(referenced, { a: 1 })).toBe(false);
  });

  // deno-lint-ignore require-yield
  it("leaves the authored schema and the judged value alone", function* () {
    const schema = { type: "object", properties: { a: { type: "string", format: "email" } } };
    const before = JSON.stringify(schema);
    const value = { a: "x" };
    const valueBefore = JSON.stringify(value);

    expect(admits(schema, value)).toBe(true);

    expect(JSON.stringify(schema)).toBe(before);
    expect(JSON.stringify(value)).toBe(valueBefore);
  });
});

describe("what preparation refuses, before anything is asked", () => {
  // deno-lint-ignore require-yield
  it("refuses a reference whose target the schema does not define", function* () {
    const dangling: Json[] = [
      { $ref: "#/definitions/missing" },
      { type: "object", properties: { a: { $ref: "#/definitions/missing" } } },
      // Inside a branch no sampled value would visit.
      { anyOf: [{ type: "string" }, { $ref: "#/definitions/missing" }] },
    ];
    for (const schema of dangling) {
      let refused: unknown;
      try {
        prepareResponseValidator("probe", schema);
      } catch (error) {
        refused = error;
      }
      expect([JSON.stringify(schema), refused instanceof ResponseSchemaError]).toEqual([
        JSON.stringify(schema),
        true,
      ]);
      expect(String(refused)).toContain("does not define");
    }
  });

  // deno-lint-ignore require-yield
  it("resolves a reference whose pointer token is escaped", function* () {
    const schema = schemaOf(
      '{"definitions":{"a/b":{"type":"string"},"c~d":{"type":"number"}},' +
        '"type":"object","properties":{"x":{"$ref":"#/definitions/a~1b"},' +
        '"y":{"$ref":"#/definitions/c~0d"}}}',
    );

    expect(admits(schema, { x: "s", y: 1 })).toBe(true);
    expect(admits(schema, { x: 1, y: 1 })).toBe(false);
  });

  // deno-lint-ignore require-yield
  it("refuses what it always refused, and says so boundedly", function* () {
    const unusable: { schema: Json; says: string }[] = [
      { schema: { $ref: "other.json#/x" }, says: "#192" },
      { schema: schemaOf('{"properties":{"__proto__":{"type":"string"}}}'), says: "__proto__" },
      { schema: { type: "not-a-type" }, says: "not a valid draft-07" },
      { schema: { type: "object", nope: 1 }, says: "draft-07 does not" },
      { schema: { $async: true, type: "object" }, says: "asynchronous" },
      { schema: "not json at all", says: "not JSON" },
      { schema: [1, 2], says: "must be a JSON Schema object" },
    ];

    for (const { schema, says } of unusable) {
      let refused: unknown;
      try {
        prepareResponseValidator("probe", schema);
      } catch (error) {
        refused = error;
      }
      expect([says, refused instanceof ResponseSchemaError]).toEqual([says, true]);
      expect(String(refused)).toContain(says);
      expect(String(refused).length).toBeLessThan(600);
    }
  });
});

describe("a value is judged by what it holds, not what its prototype answers", () => {
  // deno-lint-ignore require-yield
  it("treats an inherited name as absent", function* () {
    for (const name of ["toString", "constructor", "valueOf"]) {
      const schema = schemaOf(
        `{"type":"object","properties":{"${name}":{"type":"string"}},` +
          `"required":["${name}"],"additionalProperties":false}`,
      );

      // `{}` inherits the name and holds none, so the required member is
      // missing — and it fails as an ordinary issue rather than by raising.
      const missing = issuesOf(schema, {});
      expect([name, missing.map((issue) => issue.keyword)]).toEqual([name, ["required"]]);
      expect(missing[0]?.message).toContain(name);

      // Holding it is what admits it.
      expect(admits(schema, JSON.parse(`{"${name}":"held"}`))).toBe(true);
      expect(admits(schema, JSON.parse(`{"${name}":1}`))).toBe(false);
    }
  });

  // deno-lint-ignore require-yield
  it("judges an ordinary property the same way", function* () {
    const schema = {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    };

    expect(admits(schema, { note: "x" })).toBe(true);
    expect(issuesOf(schema, {}).map((issue) => issue.keyword)).toEqual(["required"]);
    expect(issuesOf(schema, { note: 1 }).map((issue) => issue.keyword)).toEqual(["type"]);
  });
});

describe("what a failure reports", () => {
  // deno-lint-ignore require-yield
  it("keeps every independent failure, and drops only wrappers", function* () {
    const issues = issuesOf(
      { type: "object", minProperties: 2, properties: { a: { type: "string" } } },
      { a: 1 },
    );

    // Two rules failed at two depths, and both survive. `properties` failing
    // because `/a` failed is the wrapper, and it does not.
    expect(issues.map((issue) => [issue.at, issue.keyword])).toEqual([
      ["", "minProperties"],
      ["/a", "type"],
    ]);
  });

  // deno-lint-ignore require-yield
  it("reports a raw JSON pointer, whatever the member is named", function* () {
    const named = (name: string) =>
      schemaOf(`{"type":"object","properties":${JSON.stringify({ [name]: { type: "string" } })}}`);

    for (const [name, pointer] of [
      ["🐲", "/🐲"],
      ["a/b", "/a~1b"],
      ["c~d", "/c~0d"],
      ["100%", "/100%"],
      ["", "/"],
      ["a b", "/a b"],
    ]) {
      const issues = issuesOf(named(name), JSON.parse(JSON.stringify({ [name]: 1 })));
      expect([name, issues.map((issue) => issue.at)]).toEqual([name, [pointer]]);
    }
  });

  // deno-lint-ignore require-yield
  it("says which rule failed without repeating the value or the schema", function* () {
    const cases: { schema: Json; value: Json; keyword: string; absent: string[] }[] = [
      {
        schema: { type: "number", minimum: 100 },
        value: 42,
        keyword: "minimum",
        absent: ["42", "100"],
      },
      {
        schema: { type: "number", multipleOf: 0.1 },
        value: 0.31,
        keyword: "multipleOf",
        absent: ["0.31", "0.1"],
      },
      {
        schema: { type: "string", maxLength: 3 },
        value: "hunter2secret",
        keyword: "maxLength",
        absent: ["hunter2secret", "3"],
      },
      {
        schema: { type: "string", pattern: "^[a-z]+$" },
        value: "hunter2secret",
        keyword: "pattern",
        absent: ["hunter2secret", "[a-z]"],
      },
      {
        schema: { enum: ["approve", "reject"] },
        value: "hunter2secret",
        keyword: "enum",
        absent: ["hunter2secret", "approve", "reject"],
      },
      {
        schema: { const: "approve" },
        value: "hunter2secret",
        keyword: "const",
        absent: ["hunter2secret", "approve"],
      },
      {
        schema: { type: "object", maxProperties: 1 },
        value: { a: 1, secret: "hunter2secret" },
        keyword: "maxProperties",
        absent: ["hunter2secret", "1"],
      },
      { schema: { type: "string" }, value: 42, keyword: "type", absent: ["42", "string"] },
    ];

    for (const { schema, value, keyword, absent } of cases) {
      const issues = issuesOf(schema, value);
      expect([keyword, issues.map((issue) => issue.keyword)]).toEqual([keyword, [keyword]]);
      const reported = JSON.stringify(issues);
      for (const leaked of absent) {
        expect([keyword, leaked, reported.includes(leaked)]).toEqual([keyword, leaked, false]);
      }
    }
  });

  // deno-lint-ignore require-yield
  it("carries no library object in what it reports", function* () {
    const issues = prepareResponseValidator("probe", { type: "string" }).judge(1);

    expect(issues).toHaveLength(1);
    expect(Object.keys(issues[0] ?? {}).toSorted()).toEqual([
      "instancePath",
      "keyword",
      "message",
      "params",
      "schemaPath",
    ]);
    expect(issues[0]?.params).toEqual({});
    expect(issues[0]?.schemaPath).toBe("#/type");
  });
});
