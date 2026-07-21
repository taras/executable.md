/**
 * Prop validation for component invocations (spec §5.5, §6.5).
 *
 * A component's `inputs` is a canonical JSON Schema (draft-07). Caller props
 * are validated against it by Ajv. Runtime operation — deterministic, no
 * journal entry.
 *
 * Project contract on top of draft-07:
 * - the root input schema must declare `type: "object"`;
 * - `slot`/`as` are reserved and cannot be declared properties;
 * - schemas are self-contained with local references only (no remote `$ref`);
 * - asynchronous schemas (`$async: true`) are rejected — validation stays
 *   synchronous so it never introduces a promise into the Effection path;
 * - `format` is an annotation, not an assertion.
 *
 * Applying `default` values is an executable.md extension enabled through Ajv
 * `useDefaults`, not portable JSON Schema validation behavior.
 */

import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { parseJson } from "./json.ts";
import type { InputSchema, Json } from "./types.ts";

const RESERVED_INPUT_NAMES = ["slot", "as"];

const ajv = new Ajv({
  strict: true,
  allErrors: true,
  validateSchema: true,
  useDefaults: true,
  coerceTypes: false,
  removeAdditional: false,
  addUsedSchema: false,
  validateFormats: false,
});

/**
 * Error thrown when an input schema violates the project contract or fails
 * Ajv meta-schema validation. Raised at component-definition load time.
 */
export class InputSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputSchemaError";
  }
}

/**
 * A single normalized, JSON-safe Ajv validation issue.
 */
export interface NormalizedIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Json;
  message: string;
}

/**
 * Error thrown when caller props fail validation.
 *
 * `errors` are readable messages (the existing API). `issues` are the
 * normalized, JSON-safe structured records used for `ErrorSegment.cause`.
 */
export class PropValidationError extends Error {
  componentName: string;
  errors: string[];
  issues: NormalizedIssue[];

  constructor(componentName: string, ajvErrors: ErrorObject[]) {
    const issues = ajvErrors.map(normalizeIssue);
    const messages = issues.map((issue) => readableMessage(issue));
    super(`Prop validation failed for <${componentName} />:\n  - ${messages.join("\n  - ")}`);
    this.name = "PropValidationError";
    this.componentName = componentName;
    this.errors = messages;
    this.issues = issues;
  }
}

const compiledCache = new WeakMap<InputSchema, ValidateFunction>();

/**
 * Compile an input schema to a synchronous Ajv validator, enforcing the
 * project contract and caching by schema identity. Throws `InputSchemaError`
 * on a malformed schema, a contract violation, or an asynchronous schema.
 *
 * Called at both definition-loading boundaries (Markdown and function
 * components) to fail fast; `validateProps` reuses the cached result.
 */
export function compileInputSchema(schema: InputSchema): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) {
    return cached;
  }

  enforceRootContract(schema);
  if (schema["$async"] === true) {
    throw new InputSchemaError("asynchronous input schemas ($async: true) are not supported");
  }

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new InputSchemaError(
      `invalid input schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if ("$async" in validate && validate.$async === true) {
    throw new InputSchemaError("asynchronous input schemas are not supported");
  }

  compiledCache.set(schema, validate);
  return validate;
}

/**
 * Validate caller props against the component's input schema. Returns a clone
 * with defaults applied — Ajv's `useDefaults` mutates the validated object, so
 * the caller's environment value is never touched.
 */
export function validateProps(
  componentName: string,
  callerProps: Record<string, Json>,
  schema: InputSchema,
): Record<string, Json> {
  const validate = compileInputSchema(schema);
  const clone = structuredClone(callerProps);

  if (!validate(clone)) {
    throw new PropValidationError(componentName, validate.errors ?? []);
  }

  return clone;
}

function enforceRootContract(schema: InputSchema): void {
  if (schema["type"] !== "object") {
    throw new InputSchemaError('root input schema must declare type: "object"');
  }

  const properties = schema["properties"];
  if (properties === undefined) {
    return;
  }
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    throw new InputSchemaError('input schema "properties" must be an object');
  }
  for (const reserved of RESERVED_INPUT_NAMES) {
    if (reserved in properties) {
      throw new InputSchemaError(
        `"${reserved}" is a reserved prop name and cannot be declared as a component input`,
      );
    }
  }
}

function normalizeIssue(error: ErrorObject): NormalizedIssue {
  return {
    instancePath: error.instancePath ?? "",
    schemaPath: error.schemaPath ?? "",
    keyword: error.keyword ?? "",
    params: safeParams(error.params),
    message: error.message ?? "",
  };
}

/**
 * Parse Ajv's `params` into JSON, falling back to `{}` if it is unexpectedly
 * non-JSON. Normalization must never turn a validation failure into a
 * JSON-parsing exception.
 */
function safeParams(params: unknown): Json {
  try {
    return parseJson(params);
  } catch {
    return {};
  }
}

function readableMessage(issue: NormalizedIssue): string {
  const location = issue.instancePath ? `"${issue.instancePath}"` : "(root)";
  return `${location} ${issue.message}`.trim();
}
