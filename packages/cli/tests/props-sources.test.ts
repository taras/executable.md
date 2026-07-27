/**
 * Tier PR — source resolution (specs/root-document-inputs-spec.md).
 *
 * Configliere owns precedence and provenance; these lock the behavior the
 * CLI relies on, including the two hazards that motivate the transport
 * boundary: it stores whatever a Standard Schema returns, and it selects
 * the last valid source rather than the highest-priority supplied one.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { buildBindings, extractPropsArgs, PropsError, resolveProps } from "../src/props.ts";
import type { Binding } from "../src/props.ts";

const INPUTS = {
  type: "object",
  properties: {
    name: { type: "string", description: "Person to greet" },
    count: { type: "number" },
    loud: { type: "boolean", default: false },
    tags: { type: "array", items: { type: "string" } },
    nums: { type: "array", items: { type: "number" } },
    either: { anyOf: [{ type: "string" }, { type: "number" }] },
    user: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string", default: "member" } },
      additionalProperties: false,
    },
  },
  required: ["name"],
  additionalProperties: false,
};

const bindings = buildBindings(INPUTS);

function bind(property: string): Binding {
  const binding = bindings.find((entry) => entry.property === property);
  if (!binding) {
    throw new Error(`no binding for ${property}`);
  }
  return binding;
}

function resolve(options: {
  args?: string[];
  aggregateCli?: string;
  aggregateEnv?: string;
  env?: Record<string, string>;
}) {
  const extraction = extractPropsArgs(options.args ?? [], bindings);
  const individualEnv = Object.entries(options.env ?? {}).map(([property, value]) => ({
    binding: bind(property),
    value,
  }));
  return resolveProps({
    inputs: INPUTS,
    bindings,
    individual: extraction.individual,
    aggregateCli: options.aggregateCli ?? extraction.aggregate,
    aggregateEnv: options.aggregateEnv,
    individualEnv,
  });
}

describe("Tier PR — property source resolution", () => {
  it("PR1: generates a binding per declared scalar property", function* () {
    expect(bind("name").option).toBe("--props-name");
    expect(bind("name").env).toBe("XMD_PROPS_NAME");
    expect(bind("loud").boolean).toBe(true);
    expect(bind("tags").array).toBe(true);
    // Structured properties are reached through the aggregate instead.
    expect(bindings.some((entry) => entry.property === "user")).toBe(false);
  });

  it("PR2: normalizes multi-word names and rejects a collision", function* () {
    const generated = buildBindings({
      type: "object",
      properties: { firstName: { type: "string" }, json: { type: "string" } },
    });
    expect(generated.map((entry) => entry.option)).toEqual(["--props-first-name", "--props-json"]);
    expect(generated.map((entry) => entry.env)).toEqual(["XMD_PROPS_FIRST_NAME", "XMD_PROPS_JSON"]);
    expect(() =>
      buildBindings({
        type: "object",
        properties: { firstName: { type: "string" }, first_name: { type: "string" } },
      }),
    ).toThrow(/both generate --props-first-name/);
  });

  it("PR3: applies the documented precedence per property", function* () {
    const props = resolve({
      args: ["--props-name", "ind-cli"],
      aggregateCli: '{"name":"agg-cli","count":1}',
      aggregateEnv: '{"name":"agg-env","either":"e"}',
      env: { name: "ind-env" },
    });
    expect(props.name).toBe("ind-cli");
    // Lower-priority sources still supply the properties nobody else did.
    expect(props.count).toBe(1);
    expect(props.either).toBe("e");
  });

  it("PR4: an invalid higher-priority source fails instead of falling through", function* () {
    expect(() => resolve({ args: ["--props-count", "nope"], env: { count: "5" } })).toThrow(
      /--props-count/,
    );
    expect(() => resolve({ aggregateCli: '{"count":"12"}' })).toThrow(/--props/);
  });

  it("PR5: an invalid lower-priority source is irrelevant when a higher one wins", function* () {
    const props = resolve({ args: ["--props-count", "7"], aggregateEnv: '{"count":"nope"}' });
    expect(props.count).toBe(7);
  });

  it("PR6: a property nobody supplies is omitted so defaults stay Ajv's", function* () {
    const props = resolve({ args: ["--props-name", "Ada"] });
    expect(props).toEqual({ name: "Ada" });
    expect("loud" in props).toBe(false);
  });

  it("PR7: individual text decodes, aggregate JSON keeps its exact type", function* () {
    expect(resolve({ args: ["--props-name", "007"] }).name).toBe("007");
    expect(resolve({ args: ["--props-name", "1e3"] }).name).toBe("1e3");
    expect(resolve({ args: ["--props-count", "12"] }).count).toBe(12);
    expect(resolve({ args: ["--props-either", "12"] }).either).toBe("12");
    expect(resolve({ aggregateCli: '{"name":"12"}' }).name).toBe("12");
    expect(() => resolve({ aggregateCli: '{"count":"12"}' })).toThrow();
  });

  it("PR8: booleans accept a bare flag and an explicit value, never a negated form", function* () {
    expect(resolve({ args: ["--props-loud"] }).loud).toBe(true);
    expect(resolve({ args: ["--props-loud=true"] }).loud).toBe(true);
    expect(resolve({ args: ["--props-loud=false"] }).loud).toBe(false);
    expect(() => extractPropsArgs(["--no-props-loud"], bindings)).toThrow(/no negated form/);
  });

  it("PR9: arrays repeat on the command line and are JSON in the environment", function* () {
    expect(resolve({ args: ["--props-tags", "a", "--props-tags", "b"] }).tags).toEqual(["a", "b"]);
    expect(resolve({ args: ["--props-nums", "1", "--props-nums", "2"] }).nums).toEqual([1, 2]);
    expect(resolve({ env: { tags: '["alpha","beta"]' } }).tags).toEqual(["alpha", "beta"]);
    // An aggregate array keeps its exact element types.
    expect(() => resolve({ aggregateCli: '{"nums":["1","2"]}' })).toThrow();
  });

  it("PR10: aggregate values reach validation unchanged, nested keys and all", function* () {
    const props = resolve({ aggregateCli: '{"name":"Ada","user":{"name":"Ada","extra":true}}' });
    expect(props.user).toEqual({ name: "Ada", extra: true });
    // Zod would have applied `role` here; only Ajv may.
    expect(props.user).not.toHaveProperty("role");
  });

  it("PR11: undeclared aggregate keys survive for whole-object validation", function* () {
    const props = resolve({ aggregateCli: '{"name":"Ada","nope":1}' });
    expect(props.nope).toBe(1);
  });

  it("PR12: an unknown individual option names the aggregate as the way in", function* () {
    expect(() => extractPropsArgs(["--props-extra", "1"], bindings)).toThrow(
      /--props-extra[\s\S]*--props/,
    );
    expect(() => extractPropsArgs(["--props"], bindings)).toThrow(PropsError);
  });

  it("PR13: malformed aggregate JSON fails before anything runs", function* () {
    expect(() => resolve({ aggregateCli: "{" })).toThrow(/not valid JSON/);
    expect(() => resolve({ aggregateCli: '"text"' })).toThrow(/must be a JSON object/);
  });

  it("PR15: a referenced scalar generates bindings and decodes against its target", function* () {
    for (const [keyword, pointer] of [
      ["definitions", "#/definitions/count"],
      ["$defs", "#/$defs/count"],
    ]) {
      const inputs = {
        type: "object",
        properties: {
          count: { $ref: pointer },
          counts: { type: "array", items: { $ref: pointer } },
        },
        [keyword]: { count: { type: "number" } },
      };
      const refBindings = buildBindings(inputs);
      const count = refBindings.find((entry) => entry.property === "count");
      expect(count?.option).toBe("--props-count");
      expect(count?.env).toBe("XMD_PROPS_COUNT");
      expect(count?.form).toBe("<number>");
      const counts = refBindings.find((entry) => entry.property === "counts");
      expect(counts?.array).toBe(true);
      expect(counts?.form).toBe("<number>...");

      const extraction = extractPropsArgs(
        ["--props-count", "12", "--props-counts", "1", "--props-counts", "2"],
        refBindings,
      );
      const props = resolveProps({
        inputs,
        bindings: refBindings,
        individual: extraction.individual,
        individualEnv: [],
      });
      // Decoding follows the referenced schema, not the bare `$ref`.
      expect(props.count).toBe(12);
      expect(props.counts).toEqual([1, 2]);
    }
  });

  it("PR18: only a scalar enum gets an individual binding", function* () {
    const inputs = {
      type: "object",
      properties: {
        mode: { enum: ["fast", "slow"] },
        level: { enum: [1, 2, null] },
        shape: { enum: [{ a: 1 }, { a: 2 }] },
        pair: { enum: [["a"], ["b"]] },
      },
      additionalProperties: false,
    };
    const enumBindings = buildBindings(inputs);
    expect(enumBindings.map((entry) => entry.property)).toEqual(["mode", "level"]);
    expect(enumBindings[0].form).toBe("<fast|slow>");
    expect(enumBindings[1].form).toBe("<1|2|null>");

    const extraction = extractPropsArgs(["--props-mode", "fast"], enumBindings);
    const props = resolveProps({
      inputs,
      bindings: enumBindings,
      individual: extraction.individual,
      // A structured enum has no option, so it arrives through the aggregate.
      aggregateCli: '{"shape":{"a":1},"pair":["b"]}',
      individualEnv: [],
    });
    expect(props.mode).toBe("fast");
    expect(props.shape).toEqual({ a: 1 });
    expect(props.pair).toEqual(["b"]);
  });

  it("PR16: structured properties resolve through Configliere too", function* () {
    const structured = resolve({
      aggregateCli: '{"user":{"name":"cli"}}',
      aggregateEnv: '{"user":{"name":"env"}}',
    });
    expect(structured.user).toEqual({ name: "cli" });

    // An invalid higher-priority value does not fall through...
    expect(() =>
      resolve({ aggregateCli: '{"user":{"name":12}}', aggregateEnv: '{"user":{"name":"env"}}' }),
    ).toThrow(/--props/);
    // ...and an invalid lower-priority one is irrelevant.
    expect(
      resolve({ aggregateCli: '{"user":{"name":"cli"}}', aggregateEnv: '{"user":{"name":12}}' })
        .user,
    ).toEqual({ name: "cli" });
  });

  it("PR17: a structured diagnostic names the aggregate that supplied it", function* () {
    expect(() => resolve({ aggregateEnv: '{"user":{"name":12}}' })).toThrow(/XMD_PROPS/);
    expect(() => resolve({ aggregateCli: '{"user":{"name":12}}' })).toThrow(/--props/);
  });

  it("PR14: extraction leaves every other argument alone", function* () {
    const extraction = extractPropsArgs(
      ["doc.md", "--raw", "--props-name", "Ada", "--verbose", "--", "--props-x"],
      bindings,
    );
    expect(extraction.rest).toEqual(["doc.md", "--raw", "--verbose", "--", "--props-x"]);
    expect(extraction.individual).toHaveLength(1);
  });
});
