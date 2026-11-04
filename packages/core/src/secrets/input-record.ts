import { isJsonObject, parseJson } from "../json.ts";
import type { Json } from "../types.ts";

export interface InputField {
  readonly coroutine: string;
  readonly index: number;
  readonly field: string;
}

export type RecordedInputValue =
  | Readonly<{ kind: "json"; value: Json }>
  | Readonly<{ kind: "input"; field: InputField }>
  | Readonly<{ kind: "array"; items: readonly RecordedInputValue[] }>
  | Readonly<{ kind: "object"; members: Readonly<Record<string, RecordedInputValue>> }>;

export function parseInputRecord(input: unknown): RecordedInputValue {
  const value = parseJson(input);
  if (!isJsonObject(value)) {
    throw new Error("Invalid protected-input history.");
  }
  if (value.kind === "json" && Object.keys(value).length === 2 && "value" in value) {
    return { kind: "json", value: value.value };
  }
  if (value.kind === "input" && Object.keys(value).length === 2 && isJsonObject(value.field)) {
    const field = value.field;
    if (
      Object.keys(field).length === 3 &&
      typeof field.coroutine === "string" &&
      typeof field.index === "number" &&
      Number.isSafeInteger(field.index) &&
      field.index >= 0 &&
      typeof field.field === "string"
    ) {
      return {
        kind: "input",
        field: { coroutine: field.coroutine, index: field.index, field: field.field },
      };
    }
  }
  if (value.kind === "array" && Object.keys(value).length === 2 && Array.isArray(value.items)) {
    return { kind: "array", items: value.items.map(parseInputRecord) };
  }
  if (value.kind === "object" && Object.keys(value).length === 2 && isJsonObject(value.members)) {
    return {
      kind: "object",
      members: Object.fromEntries(
        Object.entries(value.members).map(([key, member]) => [key, parseInputRecord(member)]),
      ),
    };
  }
  throw new Error("Invalid protected-input history.");
}
