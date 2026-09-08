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

import type { Operation } from "effection";

import { Elicitation } from "./elicitation-api.ts";
import type { ElicitationRequest } from "./elicitation-api.ts";
import { prepareResponseValidator } from "./elicitation-schema.ts";
import type { ResponseValidator } from "./elicitation-schema.ts";
import { parseJson } from "./json.ts";
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

/** A prepared question. Nothing has been asked yet. */
export interface PreparedElicitation {
  /** Normalized draft-07, as the provider will receive it. */
  schema: JsonObject;
  /**
   * What judges a response against this schema.
   *
   * The repository's own contract rather than a validator library's type: the
   * same judgment runs at every boundary that decides a response, including a
   * run's owner, and none of them may depend on which library is underneath.
   */
  validator: ResponseValidator;
  label: string;
}

/**
 * Normalize and admit a question's schema.
 *
 * Synchronous and effect-free: it either produces a question that can be asked
 * or throws, and a caller that has not yet begun anything can still stop. The
 * judgment it prepares is the one every boundary makes — a document's provider
 * answer here, a workflow answer delivered locally, and a workflow answer
 * retained by a run's owner somewhere else.
 */
// deno-lint-ignore require-yield
export function* prepareElicitation(
  schema: Json,
  label: string = DEFAULT_LABEL,
): Operation<PreparedElicitation> {
  const validator = prepareResponseValidator(label, schema);
  return { schema: validator.schema, validator, label };
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

  const issues = prepared.validator.judge(response);
  if (issues.length > 0) {
    throw new ElicitValidationError(prepared.label, issues);
  }
  return response;
}

/** Compile and ask in one step, for a host with no ordering of its own. */
export function* elicit(request: {
  message: string;
  schema: Json;
  label?: string;
}): Operation<Json> {
  return yield* runPreparedElicitation(
    yield* prepareElicitation(request.schema, request.label),
    request.message,
  );
}
