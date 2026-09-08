/**
 * Judging one answer against the schema its wait retained, anywhere.
 *
 * A delivered value must satisfy the response schema the wait published before
 * it enters durable state, and the place that decides that has to be the place
 * that writes — otherwise a caller with delivery admission decides for itself.
 * A run's owner is where the write happens, and a run's owner cannot compile a
 * schema: `ajv` builds validators with `new Function`, and a Cloudflare Worker
 * refuses code generation from strings. So the judgment lives here, in the
 * language itself, and both the runner that offers a value and the owner that
 * retains it run this exact module.
 *
 * ## Closed, not lenient
 *
 * Every keyword this understands is listed. A schema using anything else is not
 * judged leniently — it is refused, and the delivery with it. That is the whole
 * safety property: an unimplemented constraint can never be silently skipped,
 * so a value this accepts is a value every constraint its schema states was
 * actually checked against.
 *
 * `format` is the one exception and it matches the compiler the document path
 * uses, which is configured with `validateFormats: false`: a format annotation
 * constrains nothing on either side.
 *
 * ## What it is not
 *
 * Not a JSON Schema implementation, and not a second dialect. It is one
 * predicate over a bounded subset, held to the compiler's own verdicts by a
 * parity table, and it refuses everything outside that subset rather than
 * guessing.
 */

import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "../storage/record.ts";

/** Why one value is not an answer to one wait. */
export interface JudgmentIssue {
  /** Where in the value, as a JSON pointer fragment. */
  readonly at: string;
  /** What is wrong with it, in the schema's own vocabulary. */
  readonly reason: string;
}

/** A schema this module will not judge a value against. */
export class UnjudgeableSchemaError extends Error {
  override name = "UnjudgeableSchemaError";
}

/** Keywords that say nothing about whether a value is admitted. */
const ANNOTATIONS = new Set([
  "$schema",
  "$comment",
  "title",
  "description",
  "examples",
  "default",
  "readOnly",
  "writeOnly",
  "deprecated",
  // Configured off in the document path's compiler, so it constrains nothing
  // there either. Accepting it and applying nothing is agreement, not leniency.
  "format",
  // Inert without `$ref`, which is refused, so a definition nothing can reach
  // constrains nothing.
  "definitions",
  "$defs",
]);

/** Keywords this understands, beyond the ones that say nothing. */
const SUPPORTED = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "items",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
]);

const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

/**
 * Whether this schema is one this module can judge a value against.
 *
 * Walked whole, before any value is looked at, so a schema carrying a keyword
 * this does not implement is refused rather than partly applied. Raises with
 * what it could not read; the caller decides what to say about it.
 */
export function requireJudgeableSchema(schema: Json, at = "#"): void {
  if (typeof schema === "boolean") {
    return;
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new UnjudgeableSchemaError(`the schema at ${at} is not a schema object`);
  }
  for (const [keyword, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) {
      continue;
    }
    if (!SUPPORTED.has(keyword)) {
      throw new UnjudgeableSchemaError(`the schema at ${at} uses ${keyword}, which is not judged`);
    }
    walkKeyword(keyword, value, at);
  }
}

function walkKeyword(keyword: string, value: Json, at: string): void {
  if (keyword === "type") {
    const named = Array.isArray(value) ? value : [value];
    for (const name of named) {
      if (typeof name !== "string" || !TYPES.has(name)) {
        throw new UnjudgeableSchemaError(`the schema at ${at} names a type this does not know`);
      }
    }
    return;
  }
  if (keyword === "properties" || keyword === "propertyNames") {
    if (keyword === "propertyNames") {
      requireJudgeableSchema(value, `${at}/propertyNames`);
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares malformed properties`);
    }
    for (const [name, member] of Object.entries(value)) {
      requireJudgeableSchema(member, `${at}/properties/${name}`);
    }
    return;
  }
  if (keyword === "additionalProperties" || keyword === "additionalItems" || keyword === "not") {
    requireJudgeableSchema(value, `${at}/${keyword}`);
    return;
  }
  if (keyword === "items") {
    if (Array.isArray(value)) {
      value.forEach((member, index) => requireJudgeableSchema(member, `${at}/items/${index}`));
      return;
    }
    requireJudgeableSchema(value, `${at}/items`);
    return;
  }
  if (keyword === "allOf" || keyword === "anyOf" || keyword === "oneOf") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares a malformed ${keyword}`);
    }
    value.forEach((member, index) => requireJudgeableSchema(member, `${at}/${keyword}/${index}`));
    return;
  }
  if (keyword === "required") {
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares a malformed required`);
    }
    return;
  }
  if (keyword === "enum") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares a malformed enum`);
    }
    return;
  }
  if (keyword === "pattern") {
    if (typeof value !== "string" || !compiled(value)) {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares a pattern this cannot read`);
    }
    return;
  }
  if (
    keyword === "minProperties" ||
    keyword === "maxProperties" ||
    keyword === "minItems" ||
    keyword === "maxItems" ||
    keyword === "minLength" ||
    keyword === "maxLength"
  ) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares a malformed ${keyword}`);
    }
    return;
  }
  if (
    keyword === "minimum" ||
    keyword === "maximum" ||
    keyword === "exclusiveMinimum" ||
    keyword === "exclusiveMaximum" ||
    keyword === "multipleOf"
  ) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares a malformed ${keyword}`);
    }
    if (keyword === "multipleOf" && value <= 0) {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares a malformed multipleOf`);
    }
    return;
  }
  if (keyword === "uniqueItems") {
    if (typeof value !== "boolean") {
      throw new UnjudgeableSchemaError(`the schema at ${at} declares a malformed uniqueItems`);
    }
    return;
  }
  // `const` admits any JSON value, and nothing about it can be malformed.
}

function compiled(pattern: string): boolean {
  try {
    expression(pattern);
    return true;
  } catch {
    return false;
  }
}

function expression(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return new RegExp(pattern);
  }
}

/**
 * Judge one value against one schema, and say what is wrong with it.
 *
 * The schema must already have been admitted by `requireJudgeableSchema`. An
 * empty result is the value satisfying every constraint the schema states.
 */
export function judgeAgainstSchema(schema: Json, value: Json, at = ""): JudgmentIssue[] {
  const issues: JudgmentIssue[] = [];
  judge(schema, value, at === "" ? "" : at, issues);
  return issues;
}

function judge(schema: Json, value: Json, at: string, issues: JudgmentIssue[]): void {
  if (typeof schema === "boolean") {
    if (!schema) {
      issues.push({ at, reason: "is not admitted here" });
    }
    return;
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    issues.push({ at, reason: "has no schema to be judged by" });
    return;
  }

  const named = schema["type"];
  if (named !== undefined) {
    const types = Array.isArray(named) ? named : [named];
    if (!types.some((type) => typeof type === "string" && isType(type, value))) {
      issues.push({ at, reason: `must be ${types.join(" or ")}` });
      return;
    }
  }

  const constant = schema["const"];
  if (constant !== undefined && !same(constant, value)) {
    issues.push({ at, reason: "must equal the constant this schema declares" });
  }

  const admitted = schema["enum"];
  if (Array.isArray(admitted) && !admitted.some((entry) => same(entry, value))) {
    issues.push({ at, reason: "must be one of the values this schema enumerates" });
  }

  judgeCombinators(schema, value, at, issues);

  if (typeof value === "string") {
    judgeString(schema, value, at, issues);
  }
  if (typeof value === "number") {
    judgeNumber(schema, value, at, issues);
  }
  if (Array.isArray(value)) {
    judgeArray(schema, value, at, issues);
  } else if (value !== null && typeof value === "object") {
    judgeObject(schema, value, at, issues);
  }
}

function judgeCombinators(
  schema: Record<string, Json>,
  value: Json,
  at: string,
  issues: JudgmentIssue[],
): void {
  const all = schema["allOf"];
  if (Array.isArray(all)) {
    for (const member of all) {
      judge(member, value, at, issues);
    }
  }
  const any = schema["anyOf"];
  if (
    Array.isArray(any) &&
    !any.some((member) => judgeAgainstSchema(member, value, at).length === 0)
  ) {
    issues.push({ at, reason: "must satisfy one of the alternatives this schema allows" });
  }
  const one = schema["oneOf"];
  if (Array.isArray(one)) {
    const matched = one.filter((member) => judgeAgainstSchema(member, value, at).length === 0);
    if (matched.length !== 1) {
      issues.push({
        at,
        reason: "must satisfy exactly one of the alternatives this schema allows",
      });
    }
  }
  const refused = schema["not"];
  if (refused !== undefined && judgeAgainstSchema(refused, value, at).length === 0) {
    issues.push({ at, reason: "must not be what this schema excludes" });
  }
}

function judgeString(
  schema: Record<string, Json>,
  value: string,
  at: string,
  issues: JudgmentIssue[],
): void {
  const length = [...value].length;
  const least = schema["minLength"];
  if (typeof least === "number" && length < least) {
    issues.push({ at, reason: `must be at least ${least} characters` });
  }
  const most = schema["maxLength"];
  if (typeof most === "number" && length > most) {
    issues.push({ at, reason: `must be at most ${most} characters` });
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string" && !expression(pattern).test(value)) {
    issues.push({ at, reason: "must match the pattern this schema declares" });
  }
}

function judgeNumber(
  schema: Record<string, Json>,
  value: number,
  at: string,
  issues: JudgmentIssue[],
): void {
  const least = schema["minimum"];
  if (typeof least === "number" && value < least) {
    issues.push({ at, reason: `must be at least ${least}` });
  }
  const most = schema["maximum"];
  if (typeof most === "number" && value > most) {
    issues.push({ at, reason: `must be at most ${most}` });
  }
  const above = schema["exclusiveMinimum"];
  if (typeof above === "number" && value <= above) {
    issues.push({ at, reason: `must be greater than ${above}` });
  }
  const below = schema["exclusiveMaximum"];
  if (typeof below === "number" && value >= below) {
    issues.push({ at, reason: `must be less than ${below}` });
  }
  const multiple = schema["multipleOf"];
  if (typeof multiple === "number") {
    const quotient = value / multiple;
    if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      issues.push({ at, reason: `must be a multiple of ${multiple}` });
    }
  }
}

function judgeArray(
  schema: Record<string, Json>,
  value: readonly Json[],
  at: string,
  issues: JudgmentIssue[],
): void {
  const least = schema["minItems"];
  if (typeof least === "number" && value.length < least) {
    issues.push({ at, reason: `must have at least ${least} items` });
  }
  const most = schema["maxItems"];
  if (typeof most === "number" && value.length > most) {
    issues.push({ at, reason: `must have at most ${most} items` });
  }
  if (schema["uniqueItems"] === true) {
    const seen = new Set(value.map((entry) => canonicalJson(entry)));
    if (seen.size !== value.length) {
      issues.push({ at, reason: "must not repeat an item" });
    }
  }

  const items = schema["items"];
  if (Array.isArray(items)) {
    value.forEach((entry, index) => {
      const member = items[index];
      if (member !== undefined) {
        judge(member, entry, `${at}/${index}`, issues);
        return;
      }
      const extra = schema["additionalItems"];
      if (extra !== undefined) {
        judge(extra, entry, `${at}/${index}`, issues);
      }
    });
    return;
  }
  if (items !== undefined) {
    value.forEach((entry, index) => judge(items, entry, `${at}/${index}`, issues));
  }
}

function judgeObject(
  schema: Record<string, Json>,
  value: Record<string, Json>,
  at: string,
  issues: JudgmentIssue[],
): void {
  const names = Object.keys(value);
  const least = schema["minProperties"];
  if (typeof least === "number" && names.length < least) {
    issues.push({ at, reason: `must have at least ${least} properties` });
  }
  const most = schema["maxProperties"];
  if (typeof most === "number" && names.length > most) {
    issues.push({ at, reason: `must have at most ${most} properties` });
  }

  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === "string" && !Object.hasOwn(value, name)) {
        issues.push({ at, reason: `must have the property ${JSON.stringify(name)}` });
      }
    }
  }

  const properties = schema["properties"];
  const declared =
    properties !== null && typeof properties === "object" && !Array.isArray(properties)
      ? properties
      : undefined;

  const nameSchema = schema["propertyNames"];
  if (nameSchema !== undefined) {
    for (const name of names) {
      judge(nameSchema, name, `${at}/${name}`, issues);
    }
  }

  for (const name of names) {
    const member = declared?.[name];
    if (member !== undefined) {
      judge(member, value[name] ?? null, `${at}/${name}`, issues);
      continue;
    }
    const extra = schema["additionalProperties"];
    if (extra === undefined) {
      continue;
    }
    judge(extra, value[name] ?? null, `${at}/${name}`, issues);
  }
}

function isType(type: string, value: Json): boolean {
  if (type === "null") {
    return value === null;
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  if (type === "string") {
    return typeof value === "string";
  }
  if (type === "number") {
    return typeof value === "number";
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether two retained values are the same value, by canonical encoding. */
function same(left: Json, right: Json): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/** What a refusal says about a value, without repeating the value. */
export function describeJudgment(issues: readonly JudgmentIssue[]): string {
  return issues
    .map((issue) => `${issue.at === "" ? "the value" : issue.at} ${issue.reason}`)
    .join("; ");
}
