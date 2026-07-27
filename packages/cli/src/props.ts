/**
 * Root document properties — the bridge from a document's declared
 * `inputs` schema to command-line and environment configuration sources
 * (specs/root-document-inputs-spec.md).
 *
 * Configliere owns precedence, provenance, and diagnostics. This module
 * supplies it with sources.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createContext, field, object } from "configliere";
import type { Parser } from "configliere";
import type { Json } from "@executablemd/durable-streams";
import { z } from "zod";

export interface Binding {
  property: string;
  option: string;
  env: string;
  boolean: boolean;
  array: boolean;
  form: string;
  required: boolean;
  description?: string;
  default?: unknown;
}

export const AGGREGATE_OPTION = "--props";
export const AGGREGATE_ENV = "XMD_PROPS";

export class PropsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropsError";
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

interface SchemaLike {
  type?: unknown;
  properties?: Record<string, unknown>;
  items?: unknown;
  required: string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  union?: unknown[];
  ref?: string;
}

function readSchema(value: unknown): SchemaLike {
  const record = readRecord(value);
  if (!record) {
    return { required: [] };
  }
  const union = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : undefined;
  return {
    type: record.type,
    properties: readRecord(record.properties),
    items: record.items,
    required: Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : [],
    description: typeof record.description === "string" ? record.description : undefined,
    default: record.default,
    enum: Array.isArray(record.enum) ? record.enum : undefined,
    union,
    ref: typeof record.$ref === "string" ? record.$ref : undefined,
  };
}

/**
 * Follow a local reference to the subschema it names. Classification and
 * help both need the referenced shape, and a `$ref` alone carries none of
 * it. Both draft keywords appear because Ajv resolves either pointer.
 */
function deref(value: unknown, root: unknown, seen: Set<string> = new Set()): unknown {
  const schema = readSchema(value);
  const { ref } = schema;
  if (!ref || !ref.startsWith("#/") || seen.has(ref)) {
    return value;
  }
  seen.add(ref);
  let target: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    const record = readRecord(target);
    if (!record) {
      return value;
    }
    target = record[segment];
  }
  return target === undefined ? value : deref(target, root, seen);
}

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);

function typeNames(schema: SchemaLike): string[] {
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/**
 * Whether a property has a scalar command-line representation. Objects,
 * nested arrays, and schemas whose type cannot be determined are reached
 * through the aggregate sources instead, so the CLI never invents dotted
 * options for nested structure.
 */
function isScalar(value: unknown, root: unknown): boolean {
  const schema = readSchema(deref(value, root));
  if (schema.enum) {
    return true;
  }
  const names = typeNames(schema);
  if (names.length > 0 && names.every((name) => SCALAR_TYPES.has(name))) {
    return true;
  }
  if (schema.union) {
    return schema.union.every((member) => isScalar(member, root));
  }
  return false;
}

function isScalarArray(value: unknown, root: unknown): boolean {
  const schema = readSchema(deref(value, root));
  return (
    typeNames(schema).includes("array") &&
    schema.items !== undefined &&
    isScalar(schema.items, root)
  );
}

function valueForm(value: unknown, root: unknown): string {
  const schema = readSchema(deref(value, root));
  if (schema.enum) {
    return `<${schema.enum.join("|")}>`;
  }
  if (isScalarArray(value, root)) {
    return `<${typeNames(readSchema(deref(schema.items, root))).join("|") || "value"}>...`;
  }
  const names = typeNames(schema);
  if (names.length === 0 && schema.union) {
    const members = schema.union.flatMap((member) => typeNames(readSchema(deref(member, root))));
    return `<${members.join("|") || "value"}>`;
  }
  return `<${names.join("|") || "value"}>`;
}

/**
 * Ajv enforces `additionalProperties`, so the schema handed to Zod is
 * loosened: a strict Zod object would reject a nested unknown key before
 * whole-object validation ever sees it, and the diagnostic would come
 * from the wrong layer.
 */
function loosen(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(loosen);
  }
  const record = readRecord(value);
  if (!record) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = key === "additionalProperties" && entry === false ? true : loosen(entry);
  }
  return result;
}

type JsonSchemaInput = Parameters<typeof z.fromJSONSchema>[0];

function isJsonSchemaInput(value: unknown): value is JsonSchemaInput {
  return typeof value === "boolean" || readRecord(value) !== undefined;
}

function isStandardSchema(value: unknown): value is StandardSchemaV1<unknown> {
  if (typeof value !== "object" || value === null || !("~standard" in value)) {
    return false;
  }
  const standard = value["~standard"];
  return (
    typeof standard === "object" &&
    standard !== null &&
    "validate" in standard &&
    typeof standard.validate === "function"
  );
}

function defType(value: object): string | undefined {
  if (!("def" in value)) {
    return undefined;
  }
  const { def } = value;
  if (typeof def !== "object" || def === null || !("type" in def)) {
    return undefined;
  }
  return typeof def.type === "string" ? def.type : undefined;
}

/**
 * The element schema of an array property, taken from the converted root
 * so a referenced item keeps the definitions it points at. An optional
 * property arrives wrapped, and the array itself also answers `unwrap`,
 * so the walk stops at the array rather than following it to the element.
 */
function elementOf(value: unknown): StandardSchemaV1<unknown> | undefined {
  let current: unknown = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (defType(current) === "array" && "element" in current) {
      const { element } = current;
      return isStandardSchema(element) ? element : undefined;
    }
    if (!("unwrap" in current)) {
      return undefined;
    }
    const { unwrap } = current;
    if (typeof unwrap !== "function") {
      return undefined;
    }
    current = unwrap.call(current);
  }
  return undefined;
}

/**
 * `fromJSONSchema` resolves `#/definitions/…` under draft-7 and `#/$defs/…`
 * under draft-2020-12, while Ajv resolves either as a plain JSON pointer.
 * Converting the whole root once keeps every local reference resolvable.
 */
function convertRoot(inputs: unknown): Record<string, StandardSchemaV1<unknown>> {
  const loosened = loosen(inputs);
  if (!isJsonSchemaInput(loosened)) {
    throw new PropsError("the document's declared inputs must be an object schema");
  }

  let root: unknown;
  try {
    root = z.fromJSONSchema(loosened, { defaultTarget: "draft-7" });
  } catch {
    try {
      root = z.fromJSONSchema(loosened, { defaultTarget: "draft-2020-12" });
    } catch (error) {
      throw new PropsError(`cannot read the document's declared inputs: ${describeError(error)}`);
    }
  }

  if (typeof root !== "object" || root === null || !("shape" in root)) {
    throw new PropsError("the document's declared inputs must be an object schema");
  }
  const shape = readRecord(root.shape);
  if (!shape) {
    throw new PropsError("the document's declared inputs must be an object schema");
  }

  const converted: Record<string, StandardSchemaV1<unknown>> = {};
  for (const [property, entry] of Object.entries(shape)) {
    if (isStandardSchema(entry)) {
      converted[property] = entry;
    }
  }
  return converted;
}

const TRANSPORT = Symbol("xmd.transport");

interface TaggedText {
  [TRANSPORT]: "text";
  value: string;
}

interface TaggedTextArray {
  [TRANSPORT]: "text-array";
  value: string[];
}

function tagText(value: string): TaggedText {
  return { [TRANSPORT]: "text", value };
}

function tagTextArray(value: string[]): TaggedTextArray {
  return { [TRANSPORT]: "text-array", value };
}

function readTagged(value: unknown): TaggedText | TaggedTextArray | undefined {
  if (typeof value !== "object" || value === null || !(TRANSPORT in value)) {
    return undefined;
  }
  const tag = value[TRANSPORT];
  if (!("value" in value)) {
    return undefined;
  }
  const { value: carried } = value;
  if (tag === "text" && typeof carried === "string") {
    return { [TRANSPORT]: "text", value: carried };
  }
  if (tag === "text-array" && Array.isArray(carried)) {
    return {
      [TRANSPORT]: "text-array",
      value: carried.filter((entry): entry is string => typeof entry === "string"),
    };
  }
  return undefined;
}

function validate(
  schema: StandardSchemaV1<unknown>,
  input: unknown,
): StandardSchemaV1.Result<unknown> {
  const result = schema["~standard"].validate(input);
  if (result instanceof Promise) {
    throw new PropsError("asynchronous validation is not supported");
  }
  return result;
}

/**
 * Decode transport text against a property's schema. The original string
 * wins whenever it validates, so `007` stays a string for a string
 * property and `12` stays a string for `string | number`; otherwise the
 * JSON interpretation is used, which turns `12` into a number for a
 * number-only property and `false` into a boolean.
 */
function decodeText(
  native: StandardSchemaV1<unknown>,
  text: string,
): StandardSchemaV1.Result<unknown> {
  const direct = validate(native, text);
  if (!direct.issues) {
    return { value: text };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return direct;
  }
  return validate(native, decoded);
}

/**
 * Validate through Zod but keep the caller's value. Configliere stores
 * whatever a Standard Schema returns, so returning Zod's output would
 * hand Ajv a value with nested unknown keys stripped and nested defaults
 * already applied. Only tagged transport text is transformed.
 */
function lossless(
  native: StandardSchemaV1<unknown>,
  item: StandardSchemaV1<unknown> | undefined,
): StandardSchemaV1<unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "xmd",
      validate(input: unknown): StandardSchemaV1.Result<unknown> {
        const tagged = readTagged(input);
        if (tagged?.[TRANSPORT] === "text") {
          return decodeText(native, tagged.value);
        }
        if (tagged?.[TRANSPORT] === "text-array") {
          const values: unknown[] = [];
          for (const text of tagged.value) {
            const decoded = item ? decodeText(item, text) : { value: text };
            if (decoded.issues) {
              return decoded;
            }
            values.push(decoded.value);
          }
          return { value: values };
        }
        const result = validate(native, input);
        return result.issues ? { issues: result.issues } : { value: input };
      },
    },
  };
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function constantCase(name: string): string {
  return kebab(name).replace(/-/g, "_").toUpperCase();
}

export function declaredProperties(inputs: unknown): string[] {
  return Object.keys(readSchema(inputs).properties ?? {});
}

export function buildBindings(inputs: unknown): Binding[] {
  const schema = readSchema(inputs);
  const required = new Set(schema.required);
  const bindings: Binding[] = [];

  for (const [property, raw] of Object.entries(schema.properties ?? {})) {
    const scalar = isScalar(raw, inputs);
    const scalarArray = isScalarArray(raw, inputs);
    if (!scalar && !scalarArray) {
      continue;
    }
    const resolved = readSchema(deref(raw, inputs));
    const names = typeNames(resolved);
    bindings.push({
      property,
      option: `--props-${kebab(property)}`,
      env: `XMD_PROPS_${constantCase(property)}`,
      boolean: names.length === 1 && names[0] === "boolean",
      array: scalarArray,
      form: valueForm(raw, inputs),
      required: required.has(property),
      description: readSchema(raw).description ?? resolved.description,
      default: readSchema(raw).default ?? resolved.default,
    });
  }

  const byOption = new Map<string, string>();
  const byEnv = new Map<string, string>();
  for (const binding of bindings) {
    const option = byOption.get(binding.option);
    if (option) {
      throw new PropsError(
        `properties "${option}" and "${binding.property}" both generate ${binding.option}`,
      );
    }
    byOption.set(binding.option, binding.property);
    const env = byEnv.get(binding.env);
    if (env) {
      throw new PropsError(
        `properties "${env}" and "${binding.property}" both generate ${binding.env}`,
      );
    }
    byEnv.set(binding.env, binding.property);
  }

  return bindings;
}

export interface Extraction {
  individual: { binding: Binding; value: string | string[] }[];
  aggregate?: string;
  rest: string[];
}

/**
 * Remove `--props` and `--props-*` tokens from argv, keeping their
 * original text. Configliere's own option matching coerces every value
 * through `Number()`, which would turn `--props-name 007` into `7`.
 * Only the generated bindings are recognized, so this stays a source
 * adapter rather than a second argument parser.
 */
export function extractPropsArgs(args: string[], bindings: Binding[]): Extraction {
  const byOption = new Map(bindings.map((binding) => [binding.option, binding]));
  const collected = new Map<string, string[]>();
  const individual: { binding: Binding; value: string | string[] }[] = [];
  const rest: string[] = [];
  let aggregate: string | undefined;
  let index = 0;

  const record = (binding: Binding, value: string) => {
    const existing = collected.get(binding.option);
    if (existing) {
      existing.push(value);
      return;
    }
    collected.set(binding.option, [value]);
  };

  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      rest.push(...args.slice(index));
      break;
    }
    if (!token.startsWith("--props") && !token.startsWith("--no-props")) {
      rest.push(token);
      index += 1;
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

    if (name.startsWith("--no-props")) {
      throw new PropsError(
        `unrecognized option: ${name} — document properties have no negated form, use ${name.replace(
          "--no-props",
          "--props",
        )}=false`,
      );
    }

    if (name === AGGREGATE_OPTION) {
      if (inlineValue !== undefined) {
        aggregate = inlineValue;
        index += 1;
        continue;
      }
      const next = args[index + 1];
      if (next === undefined) {
        throw new PropsError(`${AGGREGATE_OPTION} requires a JSON object`);
      }
      aggregate = next;
      index += 2;
      continue;
    }

    const binding = byOption.get(name);
    if (!binding) {
      throw new PropsError(
        `unrecognized option: ${name} — the document declares no such property; supply additional properties with ${AGGREGATE_OPTION}`,
      );
    }

    if (inlineValue !== undefined) {
      record(binding, inlineValue);
      index += 1;
      continue;
    }
    if (binding.boolean) {
      record(binding, "true");
      index += 1;
      continue;
    }
    const next = args[index + 1];
    if (next === undefined) {
      throw new PropsError(`${binding.option} requires a value`);
    }
    record(binding, next);
    index += 2;
  }

  for (const binding of bindings) {
    const values = collected.get(binding.option);
    if (!values) {
      continue;
    }
    individual.push({
      binding,
      value: binding.array ? values : values[values.length - 1],
    });
  }

  return { individual, aggregate, rest };
}

function parseAggregate(source: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PropsError(`${source} is not valid JSON: ${describeError(error)}`);
  }
  const record = readRecord(value);
  if (!record) {
    throw new PropsError(`${source} must be a JSON object`);
  }
  return record;
}

function toJson(value: unknown, source: string): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJson(entry, source));
  }
  const record = readRecord(value);
  if (record) {
    const result: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (entry !== undefined) {
        result[key] = toJson(entry, source);
      }
    }
    return result;
  }
  throw new PropsError(`${source} supplied a value that is not JSON`);
}

interface Source {
  sourceName: string;
  sourceType: string;
  issues?: readonly StandardSchemaV1.Issue[];
}

interface FieldView {
  sources: Source[];
  value?: unknown;
  ok: boolean;
}

function readSources(value: unknown): Source[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sources: Source[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    if (!("sourceName" in entry) || !("sourceType" in entry)) {
      continue;
    }
    const { sourceName, sourceType } = entry;
    if (typeof sourceName !== "string" || typeof sourceType !== "string") {
      continue;
    }
    const issues = "issues" in entry && Array.isArray(entry.issues) ? entry.issues : undefined;
    sources.push({ sourceName, sourceType, issues });
  }
  return sources;
}

function readField(info: unknown): FieldView | undefined {
  if (typeof info !== "object" || info === null || !("result" in info)) {
    return undefined;
  }
  const { result } = info;
  if (typeof result !== "object" || result === null || !("ok" in result)) {
    return undefined;
  }
  const sources = "sources" in info ? readSources(info.sources) : [];
  const ok = result.ok === true;
  return { sources, ok, value: ok && "value" in result ? result.value : undefined };
}

export interface ResolveOptions {
  inputs: unknown;
  bindings: Binding[];
  individual: { binding: Binding; value: string | string[] }[];
  aggregateCli?: string;
  aggregateEnv?: string;
  individualEnv: { binding: Binding; value: string }[];
}

/**
 * Resolve every declared property through Configliere, then hand the
 * result to core for authoritative validation.
 *
 * Sources are supplied in ascending priority, one sparse entry per
 * individual binding so a diagnostic names the exact option or variable
 * that supplied the offending value.
 */
export function resolveProps(options: ResolveOptions): Record<string, Json> {
  const { inputs, bindings, individual, aggregateCli, aggregateEnv, individualEnv } = options;
  const shape = convertRoot(inputs);
  const schema = readSchema(inputs);
  const properties = schema.properties ?? {};
  const arrayBindings = new Map(bindings.map((binding) => [binding.property, binding]));

  const attrs: Record<string, Partial<Parser<unknown>>> = {};
  for (const property of Object.keys(properties)) {
    const native = shape[property];
    if (!native) {
      continue;
    }
    const binding = arrayBindings.get(property);
    const item = binding?.array ? elementOf(native) : undefined;
    attrs[property] = { ...field(lossless(native, item)) };
  }

  const values: { name: string; value: unknown }[] = [];
  const aggregates: Record<string, unknown>[] = [];

  if (aggregateEnv !== undefined) {
    const parsed = parseAggregate(AGGREGATE_ENV, aggregateEnv);
    aggregates.push(parsed);
    values.push({ name: AGGREGATE_ENV, value: parsed });
  }
  for (const entry of individualEnv) {
    values.push({
      name: entry.binding.env,
      value: { [entry.binding.property]: tagText(entry.value) },
    });
  }
  if (aggregateCli !== undefined) {
    const parsed = parseAggregate(AGGREGATE_OPTION, aggregateCli);
    aggregates.push(parsed);
    values.push({ name: AGGREGATE_OPTION, value: parsed });
  }
  for (const entry of individual) {
    values.push({
      name: entry.binding.option,
      value: {
        [entry.binding.property]: Array.isArray(entry.value)
          ? tagTextArray(entry.value)
          : tagText(entry.value),
      },
    });
  }

  const parser = object<Record<string, unknown>>(attrs);
  const info = parser.inspect(createContext({ args: [], values }));
  const props: Record<string, Json> = {};

  // Undeclared keys never reach a field, so they are merged first and
  // then overwritten by anything a declared field resolved. Whole-object
  // validation decides whether `additionalProperties` accepts them.
  for (const aggregate of aggregates) {
    for (const [key, value] of Object.entries(aggregate)) {
      if (!(key in properties)) {
        props[key] = toJson(value, AGGREGATE_OPTION);
      }
    }
  }

  for (const property of Object.keys(properties)) {
    const child = readField(info.attrs[property]);
    if (!child) {
      continue;
    }
    const supplied = child.sources.filter(
      (source) => source.sourceType !== "none" && source.sourceType !== "default",
    );
    if (supplied.length === 0) {
      continue;
    }
    // Configliere selects the last valid source, so an invalid
    // higher-priority value would otherwise disappear behind a valid
    // lower-priority one.
    const highest = supplied[supplied.length - 1];
    if (highest.issues) {
      const detail = highest.issues.map((issue) => issue.message).join("; ");
      throw new PropsError(`${highest.sourceName}: ${detail}`);
    }
    if (child.ok) {
      props[property] = toJson(child.value, highest.sourceName);
    }
  }

  return props;
}

/**
 * Render the document-property section of `xmd run <document> --help`.
 * Everything shown is declarative — accepted bindings, descriptions,
 * requiredness, defaults, and value forms — so help never reports what
 * the current command line or environment happens to hold.
 */
export function formatProperties(documentPath: string, bindings: Binding[]): string {
  const lines = [`Properties declared by ${documentPath}`, ""];

  for (const binding of bindings) {
    const option = binding.boolean
      ? `${binding.option}[=${binding.form}]`
      : `${binding.option} ${binding.form}`;
    lines.push(`  ${option}`);
    if (binding.description) {
      lines.push(`      ${binding.description}`);
    }
    lines.push(`      Environment: ${binding.env}`);
    if (binding.required) {
      lines.push("      Required");
    }
    if (binding.default !== undefined) {
      lines.push(`      Default: ${JSON.stringify(binding.default)}`);
    }
    lines.push("");
  }

  lines.push(`  ${AGGREGATE_OPTION} <json>`);
  lines.push("      Set document properties as a JSON object");
  lines.push(`      Environment: ${AGGREGATE_ENV}`);

  return lines.join("\n");
}
