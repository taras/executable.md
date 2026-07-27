/**
 * Root document properties — the bridge from a document's declared
 * `inputs` schema to command-line and environment configuration sources
 * (specs/root-document-inputs-spec.md).
 *
 * Configliere owns precedence, provenance, and diagnostics. This module
 * supplies it with sources: it recovers the original text of individual
 * options from argv, because the parser's own option matching coerces
 * every value through `Number()` and would turn `--props-name 007` into
 * `7`. Recovered text is tagged so an individual `"12"` can be decoded
 * to a number while an aggregate `{"count":"12"}` stays an exact JSON
 * string.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createContext, field, object } from "configliere";
import type { Parser } from "configliere";
import type { Json } from "@executablemd/durable-streams";
import { z } from "zod";

export interface Binding {
  /** Property name exactly as the schema declares it. */
  property: string;
  /** Generated command-line option, e.g. `--props-name`. */
  option: string;
  /** Generated environment variable, e.g. `XMD_PROPS_NAME`. */
  env: string;
  /** True when the option is a bare switch that takes no value. */
  boolean: boolean;
  /** True when repeated options accumulate into an array. */
  array: boolean;
  /** Rendered form of an accepted value, e.g. `<string>`. */
  form: string;
  required: boolean;
  description?: string;
  default?: unknown;
}

export interface PropsResolution {
  props: Record<string, Json>;
}

export const AGGREGATE_OPTION = "--props";
export const AGGREGATE_ENV = "XMD_PROPS";

const TRANSPORT = Symbol("xmd.transport");

interface Tagged {
  [TRANSPORT]: "text" | "text-array";
  value: string | string[];
}

function tagText(value: string): Tagged {
  return { [TRANSPORT]: "text", value };
}

function tagTextArray(value: string[]): Tagged {
  return { [TRANSPORT]: "text-array", value };
}

function tagOf(value: unknown): "text" | "text-array" | undefined {
  if (typeof value === "object" && value !== null && TRANSPORT in value) {
    return (value as Tagged)[TRANSPORT];
  }
  return undefined;
}

export class PropsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropsError";
  }
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

interface SchemaLike {
  type?: unknown;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
  required?: string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  anyOf?: SchemaLike[];
  oneOf?: SchemaLike[];
  $ref?: string;
}

function asSchema(value: unknown): SchemaLike {
  return typeof value === "object" && value !== null ? (value as SchemaLike) : {};
}

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);

function typeNames(schema: SchemaLike): string[] {
  const { type } = schema;
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/**
 * Whether a property has a scalar command-line representation. Objects,
 * nested arrays, and schemas whose type cannot be determined are reached
 * through the aggregate sources instead, so the CLI never invents dotted
 * options for nested structure.
 */
function isScalar(schema: SchemaLike): boolean {
  if (schema.enum) {
    return true;
  }
  const names = typeNames(schema);
  if (names.length > 0 && names.every((name) => SCALAR_TYPES.has(name))) {
    return true;
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    return union.every((member) => isScalar(asSchema(member)));
  }
  return false;
}

function isScalarArray(schema: SchemaLike): boolean {
  return typeNames(schema).includes("array") && !!schema.items && isScalar(asSchema(schema.items));
}

function valueForm(schema: SchemaLike): string {
  if (schema.enum) {
    return `<${schema.enum.join("|")}>`;
  }
  if (isScalarArray(schema)) {
    return `<${typeNames(asSchema(schema.items)).join("|") || "value"}>...`;
  }
  const names = typeNames(schema);
  const union = schema.anyOf ?? schema.oneOf;
  if (names.length === 0 && union) {
    return `<${union.flatMap((member) => typeNames(asSchema(member))).join("|") || "value"}>`;
  }
  return `<${names.join("|") || "value"}>`;
}

/**
 * Ajv enforces `additionalProperties`, so the schema handed to Zod is
 * loosened: a strict Zod object would reject a nested unknown key before
 * whole-object validation ever sees it, and the resulting diagnostic
 * would come from the wrong layer.
 */
function loosen(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(loosen);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "additionalProperties" && entry === false) {
      result[key] = true;
      continue;
    }
    result[key] = loosen(entry);
  }
  return result;
}

/**
 * `fromJSONSchema` resolves `#/definitions/...` under draft-7 and
 * `#/$defs/...` under draft-2020-12, while Ajv resolves either as a plain
 * JSON pointer. Converting the whole root once keeps every local
 * reference resolvable; the second attempt covers documents that use the
 * newer keyword.
 */
function convertRoot(inputs: unknown): Record<string, StandardSchemaV1<unknown>> {
  const loosened = loosen(inputs);
  let root: unknown;
  try {
    root = z.fromJSONSchema(loosened as never, { defaultTarget: "draft-7" });
  } catch {
    try {
      root = z.fromJSONSchema(loosened as never, { defaultTarget: "draft-2020-12" });
    } catch (error) {
      throw new PropsError(
        `cannot read the document's declared inputs: ${(error as Error).message}`,
      );
    }
  }
  const shape = (root as { shape?: Record<string, StandardSchemaV1<unknown>> }).shape;
  if (!shape) {
    throw new PropsError("the document's declared inputs must be an object schema");
  }
  return shape;
}

function parseJsonScalar(text: string): unknown {
  return JSON.parse(text);
}

/**
 * Decode transport text against a property's schema. The original string
 * wins whenever it validates, so `007` stays a string for a string
 * property and `12` stays a string for `string | number`; otherwise the
 * JSON interpretation is used, which is what turns `12` into a number for
 * a number-only property and `false` into a boolean.
 */
function decodeText(
  native: StandardSchemaV1<unknown>,
  text: string,
): StandardSchemaV1.Result<unknown> {
  const direct = native["~standard"].validate(text);
  if (direct instanceof Promise) {
    throw new PropsError("asynchronous validation is not supported");
  }
  if (!direct.issues) {
    return { value: text };
  }
  let decoded: unknown;
  try {
    decoded = parseJsonScalar(text);
  } catch {
    return direct;
  }
  const parsed = native["~standard"].validate(decoded);
  if (parsed instanceof Promise) {
    throw new PropsError("asynchronous validation is not supported");
  }
  return parsed;
}

/**
 * Validate through Zod but keep the caller's value. Configliere stores
 * whatever a Standard Schema returns, so returning Zod's output would
 * hand Ajv a value with nested unknown keys stripped and nested defaults
 * already applied. Only transport text is transformed.
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
        const tag = tagOf(input);
        if (tag === "text") {
          return decodeText(native, (input as Tagged).value as string);
        }
        if (tag === "text-array") {
          const texts = (input as Tagged).value as string[];
          const values: unknown[] = [];
          for (const text of texts) {
            const decoded = item ? decodeText(item, text) : { value: text };
            if (decoded.issues) {
              return decoded;
            }
            values.push(decoded.value);
          }
          return { value: values };
        }
        const result = native["~standard"].validate(input);
        if (result instanceof Promise) {
          throw new PropsError("asynchronous validation is not supported");
        }
        if (result.issues) {
          return { issues: result.issues };
        }
        return { value: input };
      },
    },
  };
}

export function buildBindings(inputs: unknown): Binding[] {
  const schema = asSchema(inputs);
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const bindings: Binding[] = [];

  for (const [property, raw] of Object.entries(properties)) {
    const propertySchema = asSchema(raw);
    const scalar = isScalar(propertySchema);
    const scalarArray = isScalarArray(propertySchema);
    if (!scalar && !scalarArray) {
      continue;
    }
    bindings.push({
      property,
      option: `--props-${kebab(property)}`,
      env: `XMD_PROPS_${constantCase(property)}`,
      boolean: typeNames(propertySchema).length === 1 && typeNames(propertySchema)[0] === "boolean",
      array: scalarArray,
      form: valueForm(propertySchema),
      required: required.has(property),
      description: propertySchema.description,
      default: propertySchema.default,
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
  /** Raw text per individual option, in binding order. */
  individual: { binding: Binding; value: string | string[] }[];
  /** Raw JSON text supplied through `--props`, when present. */
  aggregate?: string;
  /** argv with every props token removed. */
  rest: string[];
}

/**
 * Remove `--props` and `--props-*` tokens from argv, keeping their
 * original text. Only the generated bindings are recognized, so this
 * stays a source adapter rather than a second argument parser.
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
    if (binding.array) {
      individual.push({ binding, value: values });
      continue;
    }
    individual.push({ binding, value: values[values.length - 1] });
  }

  return { individual, aggregate, rest };
}

function parseAggregate(source: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PropsError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PropsError(`${source} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export interface ResolveOptions {
  inputs: unknown;
  bindings: Binding[];
  individual: { binding: Binding; value: string | string[] }[];
  aggregateCli?: string;
  aggregateEnv?: string;
  individualEnv: { binding: Binding; value: string }[];
}

interface Source {
  sourceName: string;
  sourceType: string;
  issues?: readonly StandardSchemaV1.Issue[];
}

interface FieldView {
  sources?: Source[];
  result: { ok: true; value: unknown } | { ok: false };
}

/**
 * Read the provenance Configliere records for a field. The info tree is
 * typed by the parser's value shape, which a dynamically built parser
 * cannot express, so the parts this module reads are narrowed here.
 */
function readField(info: unknown): FieldView | undefined {
  if (typeof info !== "object" || info === null || !("result" in info)) {
    return undefined;
  }
  const { result, sources } = info as { result: unknown; sources?: unknown };
  if (typeof result !== "object" || result === null || !("ok" in result)) {
    return undefined;
  }
  return {
    sources: Array.isArray(sources) ? (sources as Source[]) : undefined,
    result: result as FieldView["result"],
  };
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
  const schema = asSchema(inputs);

  const attrs: Record<string, Partial<Parser<unknown>>> = {};
  for (const binding of bindings) {
    const native = shape[binding.property];
    if (!native) {
      continue;
    }
    const itemSchema = binding.array
      ? convertItem(asSchema(asSchema(schema.properties?.[binding.property]).items))
      : undefined;
    attrs[binding.property] = { ...field(lossless(native, itemSchema)) };
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
    const tagged = Array.isArray(entry.value) ? tagTextArray(entry.value) : tagText(entry.value);
    values.push({
      name: entry.binding.option,
      value: { [entry.binding.property]: tagged },
    });
  }

  const parser = object<Record<string, unknown>>(attrs);
  const info = parser.inspect(createContext({ args: [], values }));
  const declared: Record<string, unknown> = {};

  for (const binding of bindings) {
    const child = readField(info.attrs[binding.property]);
    if (!child) {
      continue;
    }
    const supplied = (child.sources ?? []).filter(
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
    if (child.result.ok) {
      declared[binding.property] = child.result.value;
    }
  }

  // Undeclared keys never reach a field, so they are merged back in
  // aggregate precedence order. Whole-object validation decides whether
  // `additionalProperties` accepts them.
  const props: Record<string, unknown> = {};
  const declaredNames = new Set(Object.keys(asSchema(inputs).properties ?? {}));
  for (const aggregate of aggregates) {
    for (const [key, value] of Object.entries(aggregate)) {
      if (!declaredNames.has(key)) {
        props[key] = value;
      }
    }
  }
  for (const aggregate of aggregates) {
    for (const [key, value] of Object.entries(aggregate)) {
      if (declaredNames.has(key) && !(key in declared)) {
        props[key] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(declared)) {
    props[key] = value;
  }

  return props as Record<string, Json>;
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

function convertItem(item: SchemaLike): StandardSchemaV1<unknown> | undefined {
  try {
    return z.fromJSONSchema(loosen(item) as never, {
      defaultTarget: "draft-7",
    }) as unknown as StandardSchemaV1<unknown>;
  } catch {
    return undefined;
  }
}
