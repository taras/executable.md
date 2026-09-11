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

export { WorkflowObjectStorageError } from "./src/cloudflare/recognition.ts";
export type { RecognitionFailure } from "./src/cloudflare/recognition.ts";

/**
 * The supported request boundary, for the Worker in front of these owners.
 *
 * A gateway routes and forwards; it does not parse a private command, verify a
 * token, or report that either was already checked. `ownerFor` selects the
 * object arithmetically from the public run id, and the owner it reaches makes
 * every decision itself.
 */
export { ownerRoute } from "./src/cloudflare/gateway.ts";

/**
 * One configured client for one run's owner, for a trusted runner.
 *
 * The minimum a host must supply is an already-selected run id, one
 * credential-free endpoint, the exact release identity, a token operation, and
 * the HTTP and WebSocket I/O to perform. Endpoint, release and token stay in
 * the client's closure; the private commands, refusal spellings and route
 * shapes stay inside the adapter.
 */
export { remoteOwnerClient } from "./src/cloudflare/configured.ts";
export type {
  OwnerHttpRequest,
  OwnerHttpResponse,
  OwnerTransport,
  OwnerUpgrade,
  OwnerUpgradeRefused,
  RemoteOwnerClient,
  RemoteOwnerConfiguration,
} from "./src/cloudflare/configured.ts";
export { OwnerEndpointError } from "./src/cloudflare/endpoint.ts";
export type { EndpointRefusal } from "./src/cloudflare/endpoint.ts";

/**
 * The socket shape a host's `connect` provides.
 *
 * Part of the transport contract rather than of the protocol: a runtime's own
 * `WebSocket` satisfies it, and what travels over it stays private.
 */
export type { OwnerSocket, SocketListener } from "./src/remote/client.ts";
