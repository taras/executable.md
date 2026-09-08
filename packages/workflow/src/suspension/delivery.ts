/**
 * Offering one typed value to one durable wait.
 *
 * Delivery is not execution. A run that is waiting has no workflow executor, and
 * handing it an answer must not start one: nothing here acquires the executor
 * lock, fetches a definition, attaches a Workspace, records a document
 * execution, appends a journal event or moves the run's status. What it does is
 * retain the value, correlated to the exact wait it answers, so the next
 * explicit resume finds it.
 *
 * ## Why the value is checked before it is retained
 *
 * The wait retained a response schema, and that schema is the whole description
 * of what may end it. A value that does not satisfy it could never be given to
 * the document, so retaining it would leave a run holding an answer it can
 * never use — and a later resume would fail at a point far from the delivery
 * that caused it. The same reasoning puts secret detection here: a credential
 * that reaches retained state has already leaked, whatever the resume does
 * next.
 *
 * ## Installing a provider
 *
 * ```ts
 * yield* useWorkflowInputDelivery({ root: join(homedir(), ".xmd", "runs") });
 * ```
 *
 * The default handler throws rather than reporting a refusal. A host that
 * forgot to install a provider has not refused a delivery; it has failed to be
 * a host, and answering "no such wait" would say the run is at fault.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { Err, Ok, type Operation, type Result } from "effection";
import type { Json } from "@executablemd/core";
import { checkRunId } from "../storage/create-request.ts";
import { WorkflowRequestError, WorkflowStorageError } from "../storage/errors.ts";

/** One typed value offered to one retained durable wait. */
export interface WorkflowAnswerDelivery {
  /** The public id of the run that is waiting. */
  readonly runId: string;
  /** The wait this value answers, as the run derived it. */
  readonly suspensionId: string;
  /** The value itself, still to be judged against the retained response schema. */
  readonly value: Json;
  /** Whether the retained state crosses the secret gate before it is written. */
  readonly secretDetection: boolean;
}

/** What one accepted delivery left behind. */
export interface WorkflowAnswerRetention {
  readonly runId: string;
  readonly suspensionId: string;
}

/**
 * A delivery this run will not retain.
 *
 * The rejected value is never carried on the error, and neither is anything a
 * secret scan matched: a diagnostic that quoted either would publish, in a
 * place nothing filters, exactly what the refusal exists to keep out of
 * retained state.
 */
export class WorkflowAnswerDeliveryError extends WorkflowStorageError {
  override name = "WorkflowAnswerDeliveryError";
}

/** No delivery provider is installed in this scope. Raised before anything is read. */
export class WorkflowInputDeliveryProviderError extends WorkflowStorageError {
  override name = "WorkflowInputDeliveryProviderError";

  constructor() {
    super(
      "no workflow input delivery provider is configured, so deliver() cannot answer — a " +
        "host installs one for the runs it keeps, such as " +
        'yield* useWorkflowInputDelivery({ root }) from "@executablemd/workflow/deno".',
    );
  }
}

export interface WorkflowInputDeliveryApi {
  /**
   * Retain one value for one wait, or report why this run will not.
   *
   * A refusal leaves the run exactly as it was found: no pending state, no
   * journal event, no status change and no document execution.
   */
  deliver(request: WorkflowAnswerDelivery): Operation<Result<WorkflowAnswerRetention>>;
}

export const WorkflowInputDelivery: Api<WorkflowInputDeliveryApi> =
  createApi<WorkflowInputDeliveryApi>("executablemd.workflow.input.delivery", {
    // deno-lint-ignore require-yield
    *deliver(_request: WorkflowAnswerDelivery): Operation<Result<WorkflowAnswerRetention>> {
      throw new WorkflowInputDeliveryProviderError();
    },
  });

/** A delivery whose every member has been checked rather than believed. */
export interface CheckedAnswerDelivery {
  readonly runId: string;
  readonly suspensionId: string;
  readonly value: Json;
  readonly secretDetection: boolean;
}

const DELIVERY_MEMBERS = ["runId", "suspensionId", "value", "secretDetection"];

/**
 * The whole request, parsed as a closed shape before any member is read.
 *
 * The type describes what a caller meant; what arrives is whatever the language
 * allows. A suspension id is opaque and every character of it is part of it, so
 * the only thing asked of it is that it is a non-empty string this run could
 * have derived.
 */
export function parseAnswerDelivery(
  offered: WorkflowAnswerDelivery,
): Result<CheckedAnswerDelivery> {
  if (typeof offered !== "object" || offered === null || Array.isArray(offered)) {
    return Err(new WorkflowRequestError("a delivery takes an object describing one answer."));
  }
  const names = new Set(Object.keys(offered));
  const missing = DELIVERY_MEMBERS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    return Err(new WorkflowRequestError(`the delivery is missing ${missing.join(", ")}.`));
  }

  const runId = checkRunId(Reflect.get(offered, "runId"));
  if (!runId.ok) {
    return runId;
  }

  const suspensionId = Reflect.get(offered, "suspensionId");
  if (typeof suspensionId !== "string" || suspensionId === "") {
    return Err(
      new WorkflowRequestError(
        "a delivery names the wait it answers, and a suspension id is a non-empty string.",
      ),
    );
  }

  const secretDetection = Reflect.get(offered, "secretDetection");
  if (typeof secretDetection !== "boolean") {
    return Err(
      new WorkflowRequestError("a delivery says whether it crosses the secret gate, as a boolean."),
    );
  }

  const value = retainableJson(Reflect.get(offered, "value"));
  if (value === undefined) {
    return Err(
      new WorkflowRequestError(
        "an answer is retained in this run's storage, so it must be JSON this run can store.",
      ),
    );
  }

  return Ok({ runId: runId.value, suspensionId, value, secretDetection });
}

/** The value, if every part of it is JSON this run can retain. */
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
