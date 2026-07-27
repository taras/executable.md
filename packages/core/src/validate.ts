import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { parseJson } from "./json.ts";
import type { Json, PropsSchema } from "./types.ts";

const RESERVED_PROP_NAMES = ["slot", "as"];

// `validateFormats: false` keeps `format` an annotation (no assertion, no extra
// dependency). `useDefaults` mutates the validated value to fill defaults.
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

export class PropsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropsSchemaError";
  }
}

export interface NormalizedIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Json;
  message: string;
}

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

const compiledCache = new WeakMap<PropsSchema, ValidateFunction>();

export function compilePropsSchema(schema: PropsSchema): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) {
    return cached;
  }

  enforceRootContract(schema);
  // Ajv does not reject an async schema — it compiles an async validator that
  // returns a promise. Reject it before and after compiling so validation
  // stays synchronous within the Effection path.
  if (schema["$async"] === true) {
    throw new PropsSchemaError("asynchronous props schemas ($async: true) are not supported");
  }

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new PropsSchemaError(
      `invalid props schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if ("$async" in validate && validate.$async === true) {
    throw new PropsSchemaError("asynchronous props schemas are not supported");
  }

  compiledCache.set(schema, validate);
  return validate;
}

// Validates against a clone, not `callerProps` — Ajv's `useDefaults` mutates
// the validated object, and the caller's env value must never change.
export function validateProps(
  componentName: string,
  callerProps: Record<string, Json>,
  schema: PropsSchema,
): Record<string, Json> {
  const validate = compilePropsSchema(schema);
  const clone = structuredClone(callerProps);

  if (!validate(clone)) {
    throw new PropValidationError(componentName, validate.errors ?? []);
  }

  return clone;
}

function enforceRootContract(schema: PropsSchema): void {
  if (schema["type"] !== "object") {
    throw new PropsSchemaError('root props schema must declare type: "object"');
  }

  const properties = schema["properties"];
  if (properties === undefined) {
    return;
  }
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    throw new PropsSchemaError('props schema "properties" must be an object');
  }
  for (const reserved of RESERVED_PROP_NAMES) {
    if (reserved in properties) {
      throw new PropsSchemaError(
        `"${reserved}" is a reserved prop name and cannot be declared as a component prop`,
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
  const path = preciseInstancePath(issue);
  const location = path ? `"${path}"` : "(root)";
  return `${location} ${issue.message}`.trim();
}

// Ajv reports `required` and `additionalProperties` at the container's path;
// append the offending property (as an escaped JSON Pointer token, RFC 6901)
// so the message names the exact member.
function preciseInstancePath(issue: NormalizedIssue): string {
  const params = issue.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return issue.instancePath;
  }
  if (issue.keyword === "required" && typeof params["missingProperty"] === "string") {
    return `${issue.instancePath}/${escapePointerToken(params["missingProperty"])}`;
  }
  if (
    issue.keyword === "additionalProperties" &&
    typeof params["additionalProperty"] === "string"
  ) {
    return `${issue.instancePath}/${escapePointerToken(params["additionalProperty"])}`;
  }
  return issue.instancePath;
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
