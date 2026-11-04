import {
  compileReturnsSchema,
  ReturnValidationError,
  normalizeIssues,
  validateReturnValue,
} from "../validate.ts";
import type { ReturnsSchema } from "../types.ts";
import { createContext, Err, Ok, ensure } from "effection";
import type { Operation, Result } from "effection";
import { API } from "@executablemd/runtime";
import type { ProcessExecOptions, ProcessOutcome } from "@executablemd/runtime";
import { parseJson } from "../json.ts";
import type { Json } from "../types.ts";
import { buildCommand } from "../modifiers.ts";
import { INPUT_REPLACEMENT } from "./input-schema.ts";
import type { InputField, RecordedInputValue } from "./input-record.ts";

export class SecretInputOwner {
  declare private readonly opaque: never;
}

export type ProtectedInput = object;

export interface InputCommand {
  readonly language: string;
  readonly parts: readonly (string | ProtectedInput)[];
}
export type InputExecOptions = Pick<ProcessExecOptions, "cwd" | "timeout">;
export interface InputText {
  write(text: string): string;
  finish(): string;
}
export interface InputValues {
  protect(field: InputField, value: string): object;
  record(value: unknown): Result<RecordedInputValue>;
  restore(record: RecordedInputValue): Result<unknown>;
  display(value: unknown): Result<Json>;
  contains(value: unknown): boolean;
  validate(value: unknown, name: string, schema: ReturnsSchema): Operation<unknown>;
  text(): InputText;
  flushOutput(): Operation<void>;
  exec(input: InputCommand, options: InputExecOptions): Operation<ProcessOutcome>;
}

const CurrentInputs = createContext<InputValues>("executablemd.secret-input.values");
export function inputValues(): Operation<InputValues | undefined> {
  return CurrentInputs.get();
}

const CONVERSION =
  "This elicited field is protected and cannot be converted to text or JSON. Pass it directly with {answer.field} in a built-in exec block, use a capture or Let value, or render a redacted view with Json.";
const ATTACH = "executablemd.secret-input.attach";

export function* createInputOwner(
  flushOutput: () => Operation<void> = function* () {},
): Operation<SecretInputOwner> {
  const owner = new SecretInputOwner();
  const fields = new Map<string, object>();
  let leaves = new WeakMap<object, { field: InputField; value: string }>();
  const known = new Set<string>();
  let candidates: string[] = [];
  const streams = new Set<() => void>();
  let disposed = false;
  let attached = false;
  const alive = () => {
    if (disposed) {
      throw new Error("Protected input owner is disposed.");
    }
  };
  const key = (field: InputField) => JSON.stringify([field.coroutine, field.index, field.field]);
  const projectText = (text: string) => {
    alive();
    let result = text;
    for (const value of candidates) {
      if (value.length > 0) {
        result = result.replaceAll(value, INPUT_REPLACEMENT);
      }
    }
    return result;
  };
  function contains(value: unknown, seen = new Set<object>()): boolean {
    if (value === null || typeof value !== "object" || seen.has(value)) {
      return false;
    }
    if (leaves.has(value)) {
      return true;
    }
    seen.add(value);
    return Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => "value" in descriptor && contains(descriptor.value, seen),
    );
  }
  function encode(value: unknown, seen = new Set<object>()): RecordedInputValue {
    alive();
    if (value !== null && typeof value === "object") {
      const leaf = leaves.get(value);
      if (leaf !== undefined) {
        return { kind: "input", field: leaf.field };
      }
      if (seen.has(value)) {
        throw new Error("Protected-input value is circular.");
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return { kind: "array", items: Array.from(value, (member) => encode(member, seen)) };
        }
        if (
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null
        ) {
          throw new Error("Unsupported protected-input value.");
        }
        return {
          kind: "object",
          members: Object.fromEntries(
            Object.entries(value).map(([name, member]) => [name, encode(member, seen)]),
          ),
        };
      } finally {
        seen.delete(value);
      }
    }
    return {
      kind: "json",
      value: typeof value === "string" ? projectText(value) : parseJson(value),
    };
  }
  function original(value: unknown): unknown {
    if (value !== null && typeof value === "object") {
      const leaf = leaves.get(value);
      if (leaf !== undefined) {
        return leaf.value;
      }
      if (Array.isArray(value)) {
        return value.map(original);
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [key, original(member)]),
      );
    }
    return value;
  }
  function decode(record: RecordedInputValue, display: boolean): unknown {
    if (record.kind === "json") {
      return record.value;
    }
    if (record.kind === "input") {
      if (display) {
        return INPUT_REPLACEMENT;
      }
      const held = fields.get(key(record.field));
      if (held === undefined) {
        throw new Error(
          "Protected-input history requires fresh live input from its owning elicitation.",
        );
      }
      return held;
    }
    if (record.kind === "array") {
      return record.items.map((member) => decode(member, display));
    }
    return Object.fromEntries(
      Object.entries(record.members).map(([name, member]) => [name, decode(member, display)]),
    );
  }
  function attempt<T>(body: () => T): Result<T> {
    try {
      alive();
      return Ok(body());
    } catch {
      return Err(
        new Error(
          "Protected-input data cannot be safely projected or restored; its value is withheld.",
        ),
      );
    }
  }
  const values: InputValues = {
    protect(field, value) {
      alive();
      const leaf = new Proxy(Object.freeze({}), {
        get() {
          throw new Error(CONVERSION);
        },
        ownKeys() {
          throw new Error(CONVERSION);
        },
        set() {
          throw new Error(CONVERSION);
        },
        defineProperty() {
          throw new Error(CONVERSION);
        },
      });
      leaves.set(leaf, { field: Object.freeze({ ...field }), value });
      fields.set(key(field), leaf);
      known.add(value);
      candidates = [...known]
        .filter((entered) => entered.length > 0)
        .sort((left, right) => right.length - left.length);
      return leaf;
    },
    record: (value) => attempt(() => encode(value)),
    restore: (record) => attempt(() => decode(record, false)),
    display: (value) => attempt(() => parseJson(decode(encode(value), true))),
    contains,
    *validate(value, name, schema) {
      alive();
      const validator = yield* compileReturnsSchema(schema);
      if (!validator(original(value))) {
        throw new ReturnValidationError(name, normalizeIssues(validator.errors ?? []));
      }
      return value;
    },
    *flushOutput() {
      alive();
      yield* flushOutput();
    },
    text() {
      alive();
      let pending = "";
      let sealed = false;
      const release = () => {
        pending = "";
        sealed = true;
      };
      streams.add(release);
      return {
        write(text) {
          alive();
          if (sealed) {
            throw new Error("Protected output channel is finished.");
          }
          if (candidates.length === 0) {
            return text;
          }
          const received = pending + text;
          let output = "";
          let cursor = 0;
          let start = 0;
          while (cursor < received.length) {
            const remaining = received.length - cursor;
            if (
              candidates.some(
                (value) => value.length > remaining && value.startsWith(received.slice(cursor)),
              )
            ) {
              break;
            }
            const match = candidates.find((value) => received.startsWith(value, cursor));
            if (match === undefined) {
              cursor++;
            } else {
              output += received.slice(start, cursor) + INPUT_REPLACEMENT;
              cursor += match.length;
              start = cursor;
            }
          }
          output += received.slice(start, cursor);
          pending = received.slice(cursor);
          return output;
        },
        finish() {
          alive();
          if (sealed) {
            return "";
          }
          sealed = true;
          streams.delete(release);
          const tail = pending.length === 0 ? "" : INPUT_REPLACEMENT;
          pending = "";
          return tail;
        },
      };
    },
    *exec(input, options) {
      alive();
      const program = input.parts
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          const leaf = leaves.get(part);
          if (leaf === undefined) {
            throw new Error("Protected command contains an input from another execution.");
          }
          return leaf.value;
        })
        .join("");
      try {
        const outcome = yield* API.Process.operations.exec({
          command: buildCommand(input.language, program),
          ...options,
          retain: false,
        });
        return {
          exitCode: outcome.exitCode,
          stdout: outcome.stdout === undefined ? undefined : projectText(outcome.stdout),
          stderr: outcome.stderr === undefined ? undefined : projectText(outcome.stderr),
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? projectText(error.message)
            : "The process provider failed; its operand is withheld.";
        if (
          error instanceof Error &&
          message === error.message &&
          !(
            error.cause instanceof Error && projectText(error.cause.message) !== error.cause.message
          )
        ) {
          throw error;
        }
        const cause =
          error instanceof Error && error.cause instanceof Error
            ? new Error(projectText(error.cause.message))
            : undefined;
        throw new Error(message, cause === undefined ? undefined : { cause });
      }
    },
  };
  Object.freeze(values);
  Object.defineProperty(owner, ATTACH, {
    value: (claim = true) => {
      alive();
      if (claim && attached) {
        throw new Error("Protected-input owner is already attached to an execution.");
      }
      if (claim) {
        attached = true;
      }
      return values;
    },
  });
  Object.freeze(owner);
  yield* ensure(() => {
    disposed = true;
    for (const release of streams) {
      release();
    }
    streams.clear();
    fields.clear();
    leaves = new WeakMap();
    known.clear();
    candidates = [];
  });
  return owner;
}

export function* attachInputOwner(owner: SecretInputOwner): Operation<InputValues> {
  const attach: unknown = Reflect.get(owner, ATTACH);
  if (typeof attach !== "function") {
    throw new Error("Invalid protected-input owner.");
  }
  const values: InputValues = attach();
  yield* CurrentInputs.set(values);
  return values;
}

export function inspectInputOwner(owner: SecretInputOwner): InputValues {
  const inspect: unknown = Reflect.get(owner, ATTACH);
  if (typeof inspect !== "function") {
    throw new Error("Invalid protected-input owner.");
  }
  return inspect(false);
}

export function* validateLiveReturnValue(
  name: string,
  value: unknown,
  schema: ReturnsSchema,
): Operation<unknown> {
  const inputs = yield* inputValues();
  if (inputs?.contains(value)) {
    return yield* inputs.validate(value, name, schema);
  }
  return yield* validateReturnValue(name, value, schema);
}
