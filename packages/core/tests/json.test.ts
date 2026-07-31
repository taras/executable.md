import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { parseJson, parseJsonObject } from "../src/json.ts";

describe("parseJson", () => {
  it("accepts nested JSON values", function* () {
    expect(parseJson({ a: [1, "x", true, null], b: {} })).toEqual({
      a: [1, "x", true, null],
      b: {},
    });
  });

  it("rejects a root sparse array", function* () {
    expect(() => parseJson(new Array(1))).toThrow("missing array element");
  });

  it("rejects a sparse array nested in object data", function* () {
    const holed = ["x"];
    holed[2] = "y"; // index 1 is a hole
    expect(() => parseJson({ list: holed })).toThrow("missing array element");
  });

  it("still rejects explicit undefined elements and values", function* () {
    expect(() => parseJson([undefined])).toThrow("non-JSON undefined");
    expect(() => parseJson({ a: undefined })).toThrow("undefined value");
  });

  it("rejects functions, non-finite numbers, and cycles", function* () {
    expect(() => parseJson(() => {})).toThrow("non-JSON function");
    expect(() => parseJson(Infinity)).toThrow("non-finite");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => parseJson(cyclic)).toThrow("circular");
  });

  /**
   * `JSON.parse` makes `__proto__` an own property, so this arrives here from
   * any parsed text — including a value a provider or an agent produced.
   * Writing it back with `result[key] = value` reaches `Object.prototype`'s
   * inherited setter instead of defining anything, and what that does depends
   * on the engine: V8 under Node and JavaScriptCore under Bun replace the
   * object's prototype and drop the key, while Deno keeps it. So the assertion
   * is both halves — the key survives *and* the prototype is untouched — on
   * every runtime, or the same document parses to different objects depending
   * on where it ran.
   */
  it("keeps a __proto__ key as data without rewriting the prototype", function* () {
    const parsed = parseJson(JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}'));

    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed as object).sort()).toEqual(["__proto__", "ok"]);
    expect((parsed as Record<string, unknown>)["__proto__"]).toEqual({ polluted: true });
  });

  it("keeps a nested __proto__ key, and pollutes nothing above it", function* () {
    const parsed = parseJson(JSON.parse('{"outer": {"__proto__": {"polluted": true}}}'));
    const outer = (parsed as Record<string, Record<string, unknown>>).outer;

    expect(Object.prototype.hasOwnProperty.call(outer, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(outer)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
  });
});

describe("parseJsonObject", () => {
  it("requires a plain object root", function* () {
    expect(() => parseJsonObject([1, 2])).toThrow("JSON object");
    expect(() => parseJsonObject("x")).toThrow("JSON object");
    expect(parseJsonObject({ a: 1 })).toEqual({ a: 1 });
  });
});
