/**
 * What a document is waiting for, and who may end the wait.
 *
 * A suspension is a durable wait: the run stops, the executor lock is released,
 * and a later execution reaches the same wait rather than starting over. Two
 * values describe it. The **request** says what is awaited, in whatever shape
 * the waiting document chose. The **response schema** says what a value must
 * look like to end that wait, so a host offering one can be refused before the
 * document ever sees it.
 *
 * ## Identity is position, not a name
 *
 * A caller supplies neither an identifier nor authority. The trusted execution
 * derives one suspension ID from the run and the exact durable coroutine
 * position, which is what makes the wait a document reaches at one point in a
 * procedure the same wait it reaches there after a resume — and what keeps two
 * different waits from receiving each other's input. A caller that could name
 * its own would be a caller that could claim another wait's answer.
 *
 * ## The controller is the authority
 *
 * Publication and authority are separate. Publishing the request is an ordinary
 * durable Yield and proves only that the request was retained. Ending the
 * execution is a lifecycle act, and only the execution-owned controller may
 * begin it. Context selects which provider answers; it authorizes nothing. The
 * controller accepts one exact private capability, issued for one execution and
 * one suspension ID, so a value shaped like a suspension notice moves nothing.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { Json, JsonObject } from "@executablemd/core";
import { WorkflowStorageError } from "../storage/errors.ts";

/** What one durable wait is for, and what may end it. */
export interface WorkflowSuspensionRequest {
  readonly request: Json;
  readonly responseSchema: JsonObject;
}

/**
 * The private capability one execution holds for one suspension.
 *
 * Deliberately opaque and deliberately not constructible outside the host that
 * issues it: authority here is object identity, exactly as the executor lock's
 * is. The suspension ID travels beside it rather than inside it, so a
 * capability cannot be presented for a wait it was not issued for.
 */
export interface SuspensionCapability {
  readonly suspensionId: string;
}

/** A request whose shape this run will not retain. */
export class WorkflowSuspensionRequestError extends WorkflowStorageError {
  override name = "WorkflowSuspensionRequestError";
}

/** No suspension controller is installed, so no wait can be entered. */
export class WorkflowSuspensionProviderError extends WorkflowStorageError {
  override name = "WorkflowSuspensionProviderError";

  constructor() {
    super(
      "no suspension controller is installed, so a durable wait cannot be entered. A workflow " +
        "host installs one for the execution it owns.",
    );
  }
}

export interface WorkflowSuspensionApi {
  /**
   * Report this execution's suspension to whoever owns its executor lock.
   *
   * Returns the value that ends the wait. With no delivered input it does not
   * return at all: the wait is what the operation is, and the owner ends the
   * execution around it.
   */
  enter(capability: SuspensionCapability, request: WorkflowSuspensionRequest): Operation<Json>;
}

export const WorkflowSuspension: Api<WorkflowSuspensionApi> = createApi<WorkflowSuspensionApi>(
  "executablemd.workflow.suspension",
  {
    // deno-lint-ignore require-yield
    *enter(): Operation<Json> {
      throw new WorkflowSuspensionProviderError();
    },
  },
);

/**
 * The request this value is, or a refusal naming what is wrong with it.
 *
 * Refused before anything is published, because a request that cannot be
 * retained must not become a durable event, and a schema that cannot describe a
 * response must not be the thing a later host validates against. Both halves
 * are ordinary document input and neither has been checked by anyone else.
 */
export function parseSuspensionRequest(value: unknown): WorkflowSuspensionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowSuspensionRequestError(
      "a suspension takes an object with a request and a responseSchema.",
    );
  }
  const request = Reflect.get(value, "request");
  const responseSchema = Reflect.get(value, "responseSchema");

  if (request === undefined) {
    throw new WorkflowSuspensionRequestError(
      "a suspension request says what is awaited, and this one says nothing.",
    );
  }
  const retainable = retainableJson(request);
  if (retainable === undefined) {
    throw new WorkflowSuspensionRequestError(
      "a suspension request is retained in the journal, so it must be JSON this run can store.",
    );
  }
  const schema = retainableJson(responseSchema);
  if (
    schema === undefined ||
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema)
  ) {
    throw new WorkflowSuspensionRequestError(
      "a suspension's responseSchema describes the value that may end the wait, so it must be a " +
        "JSON object.",
    );
  }
  return Object.freeze({ request: retainable, responseSchema: schema });
}

/**
 * The value, if every part of it is JSON this run can retain.
 *
 * `JSON.stringify` is the test rather than a structural walk, because what is
 * being asked is exactly whether the journal can hold it. A value carrying a
 * function, a symbol or a cycle answers here rather than at the append.
 */
function retainableJson(value: unknown): Json | undefined {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (encoded === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(encoded);
  return isJson(parsed) ? parsed : undefined;
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return true;
  }
  if (typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isJson);
  }
  return false;
}
