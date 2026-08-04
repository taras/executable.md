/**
 * Schema handling shared by `<Parse>` and `<SafeParse>`
 * (specs/executable-mdx-spec.md §6.12).
 *
 * Parsing validates without changing what it validated. `validate.ts` compiles
 * with `useDefaults`, because a component's props and returns are contracts the
 * schema may complete; a parsed value is evidence, and filling a default,
 * coercing a type, or dropping a property would report something the document
 * never produced. That difference is why parsing has its own Ajv rather than
 * sharing the one next door.
 */

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { createContext, Err, Ok } from "effection";
import type { Context, Operation, Result } from "effection";
import { SchemaValidationError, normalizeIssues } from "../validate.ts";
import type { NormalizedIssue } from "../validate.ts";
import { parseJson, parseJsonObject } from "../json.ts";
import type { Json, JsonObject } from "../types.ts";

function createParseCompiler(): Ajv {
  return new Ajv({
    strict: true,
    allErrors: true,
    validateSchema: true,
    useDefaults: false,
    coerceTypes: false,
    removeAdditional: false,
    addUsedSchema: false,
    validateFormats: false,
  });
}

/**
 * The compiler one execution parses with.
 *
 * Scoped for the same reason the props compiler is (see `validate.ts`): Ajv
 * remembers every compile in a `Map` keyed by the schema object, so an instance
 * that outlived a run would accumulate a run's worth of schemas per run and
 * answer a mutated schema object with the previous run's validator. A document
 * brings fresh schema objects every time.
 */
const ParseCompiler: Context<Ajv | undefined> = createContext<Ajv | undefined>(
  "component.parseCompiler",
  undefined,
);

/** Open the parse compiler for one execution. */
export function* useParseCompiler(): Operation<Ajv> {
  const compiler = createParseCompiler();
  yield* ParseCompiler.set(compiler);
  return compiler;
}

/** A schema that could not be read or compiled. Raised before any child runs. */
export class ParseSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseSchemaError";
  }
}

/**
 * Content a document produced that could not become a value: malformed JSON,
 * or JSON the schema rejected. A `SchemaValidationError`, so the printed error
 * names the component and carries its issues structurally rather than only in
 * prose — the same issues `<SafeParse>` hands to a document.
 */
export class ParseValidationError extends SchemaValidationError {
  constructor(componentName: string, issues: NormalizedIssue[]) {
    super(componentName, headline(componentName, issues), issues);
    this.name = "ParseValidationError";
  }
}

function headline(componentName: string, issues: NormalizedIssue[]): string {
  if (issues.length === 1 && issues[0].keyword === "parse") {
    return `<${componentName} /> content is not JSON:`;
  }
  return `<${componentName} /> content failed its schema:`;
}

/**
 * Compile the `schema` prop, in either accepted form.
 *
 * Captured JSON text and an already structured value normalize to the same
 * draft-07 compilation, so a document can hold its schema in a code fence or in
 * a binding and get identical behavior.
 */
export function* compileParseSchema(
  componentName: string,
  schema: Json,
): Operation<ValidateFunction> {
  const declaration = readSchema(componentName, schema);
  // Without a run there is nothing to reclaim: the compiler lives exactly as
  // long as this call.
  const ajv = (yield* ParseCompiler.get()) ?? createParseCompiler();

  // Ajv does not reject an async schema — it compiles a validator that returns
  // a promise. Reject it before and after compiling so validation stays
  // synchronous, as props and returns do.
  if (declaration["$async"] === true) {
    throw new ParseSchemaError(
      `<${componentName} /> does not support an asynchronous schema ($async: true).`,
    );
  }

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(declaration);
  } catch (error) {
    throw new ParseSchemaError(schemaFailure(componentName, error));
  }

  if ("$async" in validate && validate.$async === true) {
    throw new ParseSchemaError(
      `<${componentName} /> does not support an asynchronous schema ($async: true).`,
    );
  }

  return validate;
}

/**
 * Validate parsed content, returning the issues rather than raising them.
 *
 * `<Parse>` turns a non-empty result into a `ParseValidationError`;
 * `<SafeParse>` puts it in a failed result. Both read the same issues.
 */
export function validateParsed(validate: ValidateFunction, value: Json): NormalizedIssue[] {
  if (validate(value)) {
    return [];
  }
  return normalizeIssues(validate.errors ?? []);
}

/**
 * The issues as the JSON a document binds. `NormalizedIssue` is an interface,
 * so it crosses into `Json` by being parsed rather than asserted — the same
 * boundary every produced value passes.
 */
export function issuesAsJson(issues: NormalizedIssue[]): Json {
  return parseJson(issues);
}

/** Read rendered content as JSON. */
export function parseText(text: string): Result<Json> {
  try {
    return Ok(JSON.parse(text));
  } catch (error) {
    return Err(error);
  }
}

/**
 * A failed `parseText` as one issue in the same normalized shape a schema
 * failure uses, distinguished only by `keyword: "parse"`, so a document reads
 * both kinds of failure the same way.
 */
export function parseIssue(error: Error): NormalizedIssue {
  return {
    instancePath: "",
    schemaPath: "",
    keyword: "parse",
    params: {},
    message: error.message,
  };
}

/**
 * Read the `schema` prop into a normalized object, in either accepted form.
 *
 * Exported because a caller may need the normalized declaration itself and not
 * only a validator: `<Elicit>` hands its schema to a provider, and inspects it
 * for names and references it cannot support, before compiling.
 */
export function readParseSchema(componentName: string, schema: Json): JsonObject {
  return readSchema(componentName, schema);
}

function readSchema(componentName: string, schema: Json): Record<string, Json> {
  if (typeof schema === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(schema);
    } catch (error) {
      throw new ParseSchemaError(
        `<${componentName} /> schema text is not JSON: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return asSchemaObject(componentName, parsed);
  }
  return asSchemaObject(componentName, schema);
}

function asSchemaObject(componentName: string, value: unknown): Record<string, Json> {
  try {
    return parseJsonObject(value);
  } catch {
    throw new ParseSchemaError(
      `<${componentName} /> schema must be a JSON Schema object or JSON text describing one.`,
    );
  }
}

/**
 * Ajv reports an unreachable `$ref` the same way it reports a malformed
 * keyword, so the limit reads like a defect unless the printed error names it.
 * Only a self-contained schema resolves today; #192 tracks file and HTTP(S)
 * references.
 */
function schemaFailure(componentName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("can't resolve reference")) {
    return (
      `<${componentName} /> could not resolve a schema reference: ${message}. ` +
      "Only references contained within the supplied schema resolve; external " +
      "file and HTTP(S) references are tracked in #192."
    );
  }
  return `<${componentName} /> schema is not a valid draft-07 JSON Schema: ${message}`;
}
