import { parseExpressionAt } from "acorn";
import type { Expression } from "acorn";
import { EvaluationCandidateError } from "./evaluation-errors.ts";
import { parseJson } from "./json.ts";
import type { Json } from "./types.ts";

type Data =
  | { kind: "literal"; value: Json }
  | { kind: "binding"; name: string }
  | { kind: "array"; entries: Data[] }
  | { kind: "object"; entries: [string, Data][] };

function refused(): never {
  throw new EvaluationCandidateError(
    "expression",
    "The generated data expression is not admitted.",
  );
}

function data(node: Expression): Data {
  switch (node.type) {
    case "Literal": {
      if (
        node.value === null ||
        typeof node.value === "string" ||
        typeof node.value === "boolean" ||
        (typeof node.value === "number" && Number.isFinite(node.value))
      ) {
        return { kind: "literal", value: node.value };
      }
      return refused();
    }
    case "Identifier":
      return { kind: "binding", name: node.name };
    case "ArrayExpression":
      return {
        kind: "array",
        entries: node.elements.map((entry) => {
          if (entry === null || entry.type === "SpreadElement") {
            return refused();
          }
          return data(entry);
        }),
      };
    case "ObjectExpression":
      return {
        kind: "object",
        entries: node.properties.map((entry): [string, Data] => {
          if (
            entry.type !== "Property" ||
            entry.kind !== "init" ||
            entry.method ||
            entry.computed
          ) {
            return refused();
          }
          const key =
            entry.key.type === "Identifier"
              ? entry.key.name
              : entry.key.type === "Literal" &&
                  (typeof entry.key.value === "string" || typeof entry.key.value === "number")
                ? String(entry.key.value)
                : refused();
          return [key, data(entry.value)];
        }),
      };
    default:
      return refused();
  }
}

/** Parse once at admission; only data nodes ever reach the interpreter. */
export function parseGeneratedData(source: string): Data {
  try {
    const node = parseExpressionAt(source, 0, { ecmaVersion: "latest" });
    if (source.slice(node.end).trim() !== "") {
      return refused();
    }
    return data(node);
  } catch (cause) {
    if (cause instanceof EvaluationCandidateError) {
      throw cause;
    }
    throw new EvaluationCandidateError(
      "expression",
      "The generated data expression cannot be parsed.",
      { cause },
    );
  }
}

export function generatedDataBindings(node: Data): string[] {
  switch (node.kind) {
    case "binding":
      return [node.name];
    case "literal":
      return [];
    case "array":
      return node.entries.flatMap(generatedDataBindings);
    case "object":
      return node.entries.flatMap(([, value]) => generatedDataBindings(value));
  }
}

export function interpretGeneratedData(node: Data, bindings: Record<string, unknown>): Json {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "array":
      return node.entries.map((entry) => interpretGeneratedData(entry, bindings));
    case "object":
      return Object.fromEntries(
        node.entries.map(([key, value]) => [key, interpretGeneratedData(value, bindings)]),
      );
    case "binding": {
      const descriptor = Object.getOwnPropertyDescriptor(bindings, node.name);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new EvaluationCandidateError(
          "binding",
          "The generated expression requires an unavailable local binding.",
        );
      }
      return parseJson(descriptor.value);
    }
  }
}

export function evaluateGeneratedData(source: string, bindings: Record<string, unknown>): Json {
  return interpretGeneratedData(parseGeneratedData(source), bindings);
}
