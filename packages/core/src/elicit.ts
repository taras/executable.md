/**
 * Asking a person a schema-constrained question, without a document.
 *
 * Two halves, because *when* compilation happens is part of the contract. A
 * schema that cannot be used must fail before the invocation content expands
 * and before any provider is contacted, so `prepareElicitation` is everything
 * that can fail cheaply and `runPreparedElicitation` is everything that reaches
 * a person. `<Elicit>` calls the halves separately for that ordering.
 *
 * `elicit` joins them for a host that has no such ordering to keep — `xmd
 * prompt` (#260) asks its approval question with no document executing, no
 * journal, and no component around it. That is why this path is a module a host
 * can call rather than something private to the component.
 *
 * Core judges the answer as well as the question. A provider returns `unknown`,
 * and the same schema that described the request decides whether what came back
 * is a response. It decides **once**: an answer that fails is a failure, not a
 * reason to ask again. Interactive correction belongs inside a provider, and
 * retry belongs in visible Markdown control flow.
 */

import type { ValidateFunction } from "ajv";
import type { Operation } from "effection";

import { Elicitation } from "./elicitation-api.ts";
import type { ElicitationRequest } from "./elicitation-api.ts";
import {
  ParseSchemaError,
  compileParseSchema,
  readParseSchema,
  validateParsed,
} from "./components/parse-schema.ts";
import { parseJson } from "./json.ts";
import { walkSchema } from "./schema-walk.ts";
import type { NameKind } from "./schema-walk.ts";
import { SchemaValidationError } from "./validate.ts";
import type { NormalizedIssue } from "./validate.ts";
import type { Json, JsonObject } from "./types.ts";

/** The label a host with no component name of its own reports. */
const DEFAULT_LABEL = "Elicit";

/** A provider's answer that the schema rejected. Raised once, never retried. */
export class ElicitValidationError extends SchemaValidationError {
  constructor(label: string, issues: NormalizedIssue[]) {
    super(label, `<${label} /> received a response that failed its schema:`, issues);
    this.name = "ElicitValidationError";
  }
}

/** A compiled question. Nothing has been asked yet. */
export interface PreparedElicitation {
  /** Normalized draft-07, as the provider will receive it. */
  schema: JsonObject;
  validate: ValidateFunction;
  label: string;
}

/**
 * Normalize and compile a question's schema.
 *
 * Synchronous and effect-free: it either produces a question that can be asked
 * or throws, and a caller that has not yet begun anything can still stop.
 */
export function prepareElicitation(
  schema: Json,
  label: string = DEFAULT_LABEL,
): PreparedElicitation {
  const declaration = readParseSchema(label, schema);

  refuseUnsupportedNames(label, declaration);
  refuseExternalReferences(label, declaration);

  return { schema: declaration, validate: compileParseSchema(label, declaration), label };
}

/** Ask the configured provider, and judge what it returns. */
export function* runPreparedElicitation(
  prepared: PreparedElicitation,
  message: string,
): Operation<Json> {
  const request: ElicitationRequest = { message, schema: prepared.schema };
  const answer = yield* Elicitation.operations.elicit(request);

  // Parsed rather than asserted: a provider is host code, and what it hands
  // back is `unknown` until this boundary has walked it.
  const response = parseJson(answer);

  const issues = validateParsed(prepared.validate, response);
  if (issues.length > 0) {
    throw new ElicitValidationError(prepared.label, issues);
  }
  return response;
}

/** Compile and ask in one step, for a host with no ordering of its own. */
export function elicit(request: {
  message: string;
  schema: Json;
  label?: string;
}): Operation<Json> {
  return runPreparedElicitation(prepareElicitation(request.schema, request.label), request.message);
}

/**
 * Refuse `__proto__` where a schema declares it as a name.
 *
 * Two reasons, and either alone would be enough. A validated response binds
 * into the evaluation environment, and a schema is how a document says it
 * expects that name — so the safest moment to say the name is unsupported is
 * before anyone is asked for a value carrying it.
 *
 * The other is that the underlying validator loses it. Ajv builds its internal
 * tables from schema keys by assignment, so `properties: { "__proto__": … }`
 * compiles and then never applies: a response carrying that key is judged as
 * though the property had never been declared, and under
 * `additionalProperties: false` it is rejected outright. `dependencies` compiles
 * and never applies; `required` is refused by strict mode. None of those is a
 * failure a document could see or work around.
 *
 * The same string as *data* — a `const`, an `enum` member, a title, a default —
 * is untouched, because nothing reads it as a key.
 */
function refuseUnsupportedNames(label: string, schema: JsonObject): void {
  walkSchema(schema, {
    subschema() {},
    declaredName(name: string, kind: NameKind, path: string) {
      if (name !== "__proto__") {
        return;
      }
      throw new ParseSchemaError(
        `<${label} /> schema declares "__proto__" as a ${kind} at ${path}, which is not ` +
          "supported: the underlying validator loses that name, so the rule would " +
          "silently not apply. Rename it, or carry the value under a different key.",
      );
    },
  });
}

/**
 * Refuse a reference that leaves the document.
 *
 * Ajv reports an unreachable external reference and a mistyped local pointer
 * with the same `can't resolve reference` message, so the two are told apart
 * here — by the shape of the reference itself — rather than by reading an error
 * string. A local pointer that does not resolve is still Ajv's to report, and
 * `compileParseSchema` names it.
 *
 * `$ref` is read only at real schema positions. An object carrying `$ref` inside
 * a `const` or an `enum` member is a JSON value the author wants matched, not a
 * reference, and Ajv never resolves it — so neither does this.
 */
function refuseExternalReferences(label: string, schema: JsonObject): void {
  walkSchema(schema, {
    subschema(subschema: JsonObject, path: string) {
      const reference = subschema["$ref"];
      if (typeof reference !== "string" || reference.startsWith("#")) {
        return;
      }
      throw new ParseSchemaError(
        `<${label} /> schema references "${reference}" at ${path}, which is outside the ` +
          "supplied schema. Only references contained within it resolve; external file " +
          "and HTTP(S) references are deferred to #192.",
      );
    },
    declaredName() {},
  });
}
