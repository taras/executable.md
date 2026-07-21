import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
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
});

describe("parseJsonObject", () => {
  it("requires a plain object root", function* () {
    expect(() => parseJsonObject([1, 2])).toThrow("JSON object");
    expect(() => parseJsonObject("x")).toThrow("JSON object");
    expect(parseJsonObject({ a: 1 })).toEqual({ a: 1 });
  });
});
