/**
 * @module
 *
 * The Cloudflare host's workflow-run owner.
 *
 * Keeping this behind its own entrypoint is what lets the shared package stay
 * provider-neutral, exactly as `./deno` does for the local host. Durable
 * Objects, the runtime's SQLite, WebSocket acquisition and OIDC admission live
 * here and nowhere above; `@executablemd/workflow` names none of them, so the
 * Deno host is unaffected by this module existing and neither host has to know
 * the other does.
 *
 * What an operator assembles is the owner and its policy:
 *
 * ```ts
 * import { WorkflowOwnerObject } from "@executablemd/workflow/cloudflare";
 *
 * export class WorkflowOwner extends WorkflowOwnerObject {
 *   protected configuration() {
 *     return { policy: POLICY };
 *   }
 *   protected perform(socket, runId, command) {
 *     // …
 *   }
 * }
 * ```
 *
 * Provider endpoints, OIDC tokens, credentials, private message shapes,
 * storage handles and acquisition evidence are deliberately absent from what
 * this publishes. They are host closure state, and a value a document or a
 * runner could name would be authority a document or a runner could hold.
 */

export { WorkflowOwnerObject, refusalOf } from "./src/cloudflare/owner.ts";
export type { AdmissionRequest, OwnerConfiguration } from "./src/cloudflare/owner.ts";

export { AdmissionError } from "./src/cloudflare/admission.ts";
export type { AdmissionPolicy, AdmissionRefusal } from "./src/cloudflare/admission.ts";

export { ReleaseIdentityError } from "./src/cloudflare/release.ts";
export type { ReleaseRefusal } from "./src/cloudflare/release.ts";

export { admitRunId, ownerFor, RunIdError } from "./src/cloudflare/routing.ts";
export type { OwnerNamespace, RunIdRefusal } from "./src/cloudflare/routing.ts";

export {
  AcquisitionError,
  acquisitionHolders,
  EXECUTOR_TAG,
} from "./src/cloudflare/acquisition.ts";
export type { AcquisitionAttachment, AcquisitionRefusal } from "./src/cloudflare/acquisition.ts";

export { CommandError } from "./src/cloudflare/commands.ts";
export type { CommandRefusal, CommandResult, RunnerCommand } from "./src/cloudflare/commands.ts";

export {
  OwnerTransactionClosedError,
  OwnerTransactionNestedError,
  OwnerTransactions,
} from "./src/cloudflare/owner-transaction.ts";

export { WorkflowObjectStorageError } from "./src/cloudflare/recognition.ts";
export type { RecognitionFailure } from "./src/cloudflare/recognition.ts";
