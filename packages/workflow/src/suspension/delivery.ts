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
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/core";
import { WorkflowStorageError } from "../storage/errors.ts";

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
