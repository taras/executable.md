import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { createContext } from "effection";
import type { Context, Operation } from "effection";
import { JsonParseError, parseJson } from "./json.ts";
import type { Json, PropsSchema, ReturnsSchema } from "./types.ts";

const RESERVED_PROP_NAMES = ["slot", "as"];

// `validateFormats: false` keeps `format` an annotation (no assertion, no extra
// dependency). `useDefaults` mutates the validated value to fill defaults.
function createPropsCompiler(): Ajv {
  return new Ajv({
    strict: true,
    allErrors: true,
    validateSchema: true,
    useDefaults: true,
    coerceTypes: false,
    removeAdditional: false,
    addUsedSchema: false,
    validateFormats: false,
  });
}

/**
 * The compiler one execution validates props and return values with.
 *
 * Ajv keeps every compile in a `Map` of its own, keyed by the schema object it
 * was handed and never evicted, so a single instance would hold one entry per
 * schema per run for the life of the process — and a schema object mutated
 * between runs would get the first run's validator. The compiler therefore
 * belongs to the run: created when a run installs it, reclaimed with everything
 * it compiled when the run's scope ends. That `Map` is also the whole cache
 * this module needs, which is why there is no second one beside it.
 */
const PropsCompiler: Context<Ajv | undefined> = createContext<Ajv | undefined>(
  "component.propsCompiler",
  undefined,
);

/** Open the props and returns compiler for one execution. */
export function* usePropsCompiler(): Operation<Ajv> {
  const compiler = createPropsCompiler();
  yield* PropsCompiler.set(compiler);
  return compiler;
}

/**
 * The run's compiler, or one that lives exactly as long as this call.
 *
 * Compiling outside a run — a host describing a component, a test — has nothing
 * to reclaim and nothing to share, so it gets an instance of its own rather
 * than reaching for one that would outlive it.
 */
function* compiler(): Operation<Ajv> {
  return (yield* PropsCompiler.get()) ?? createPropsCompiler();
}

export class PropsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropsSchemaError";
  }
}

export class ReturnSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReturnSchemaError";
  }
}

export interface NormalizedIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Json;
  message: string;
}

/**
 * A value that failed its declared schema, carrying the component it belongs
 * to and the normalized issues. Props and returns raise distinct subclasses so
 * a printed error names the contract it broke, while segment conversion reads the
 * shape once.
 */
export class SchemaValidationError extends Error {
  componentName: string;
  errors: string[];
  issues: NormalizedIssue[];

  constructor(componentName: string, headline: string, issues: NormalizedIssue[]) {
    const messages = issues.map((issue) => readableMessage(issue));
    super(`${headline}\n  - ${messages.join("\n  - ")}`);
    this.name = "SchemaValidationError";
    this.componentName = componentName;
    this.errors = messages;
    this.issues = issues;
  }
}

export class PropValidationError extends SchemaValidationError {
  constructor(componentName: string, ajvErrors: ErrorObject[]) {
    super(
      componentName,
      `Prop validation failed for <${componentName} />:`,
      ajvErrors.map(normalizeIssue),
    );
    this.name = "PropValidationError";
  }
}

export class ReturnValidationError extends SchemaValidationError {
  constructor(componentName: string, issues: NormalizedIssue[]) {
    super(componentName, `Return validation failed for <${componentName} />:`, issues);
    this.name = "ReturnValidationError";
  }
}

// Props and returns enforce different root contracts, and each is checked on
// every call rather than remembered. Ajv memoizes the compile itself, keyed by
// the schema object, so a table here would only add the question of which
// contract a remembered validator was compiled under — and answering it wrong
// is how a schema first compiled as a return would hand `compilePropsSchema` a
// validator that never met the object-root contract.
export function* compilePropsSchema(schema: PropsSchema): Operation<ValidateFunction> {
  enforceRootContract(schema);
  // Ajv does not reject an async schema — it compiles an async validator that
  // returns a promise. Reject it before and after compiling so validation
  // stays synchronous within the Effection path.
  if (schema["$async"] === true) {
    throw new PropsSchemaError("asynchronous props schemas ($async: true) are not supported");
  }

  const ajv = yield* compiler();
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

  return validate;
}

/**
 * Compile a return schema. A return value is any JSON value, so the schema
 * root carries no object contract — only the same asynchronous-schema
 * rejection that keeps validation synchronous within the Effection path.
 */
export function* compileReturnsSchema(schema: ReturnsSchema): Operation<ValidateFunction> {
  if (schema["$async"] === true) {
    throw new ReturnSchemaError("asynchronous return schemas ($async: true) are not supported");
  }

  const ajv = yield* compiler();
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new ReturnSchemaError(
      `invalid return schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if ("$async" in validate && validate.$async === true) {
    throw new ReturnSchemaError("asynchronous return schemas are not supported");
  }

  return validate;
}

/**
 * Validate a produced return value at the component boundary and return the
 * validated JSON.
 *
 * The value crosses the JSON boundary first: `parseJson` rejects everything
 * that could not survive capture and replay, and yields a clone. Ajv validates
 * — and fills defaults into — that clone, so the producer's own object is
 * never mutated and only JSON reaches the caller.
 */
export function* validateReturnValue(
  componentName: string,
  value: unknown,
  schema: ReturnsSchema,
): Operation<Json> {
  let json: Json;
  try {
    json = parseJson(value);
  } catch (error) {
    if (error instanceof JsonParseError) {
      throw new ReturnValidationError(componentName, [
        {
          instancePath: "",
          schemaPath: "",
          keyword: "json",
          params: {},
          message: `is not JSON: ${error.message}`,
        },
      ]);
    }
    throw error;
  }

  const validate = yield* compileReturnsSchema(schema);
  if (!validate(json)) {
    throw new ReturnValidationError(componentName, (validate.errors ?? []).map(normalizeIssue));
  }

  return json;
}

// Validates against a clone, not `callerProps` — Ajv's `useDefaults` mutates
// the validated object, and the caller's env value must never change.
export function* validateProps(
  componentName: string,
  callerProps: Record<string, Json>,
  schema: PropsSchema,
): Operation<Record<string, Json>> {
  const validate = yield* compilePropsSchema(schema);
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

/**
 * Ajv's errors in the shape every consumer reads. Exported because parsing
 * (§6.12) reports the same issues from its own Ajv instance, and a second copy
 * of this shape would be free to drift from the one printed errors already carry.
 */
export function normalizeIssues(errors: readonly ErrorObject[]): NormalizedIssue[] {
  return errors.map(normalizeIssue);
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
