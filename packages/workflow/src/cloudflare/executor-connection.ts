/**
 * One admitted executor connection, assembled for this owner.
 *
 * The provider asks its host for an acquisition; this is what a Cloudflare host
 * gives it. Both halves come from the same socket — the link that reads and
 * commits, and the lifecycle commands that move the run — because they are the
 * same authority. Reaching the socket is the host's business and stays behind
 * the `open` it is handed, so nothing here knows about tokens, releases or
 * upgrade headers.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import type { RemoteExecutorConnection } from "../remote/lifecycle-link.ts";
import { useOwnerConnection, type OwnerSocket } from "../remote/client.ts";
import { cloudflareLifecycleLink } from "./lifecycle-link.ts";
import { cloudflareReadLink, cloudflareRunLink, translate } from "./client.ts";

/**
 * How a host reaches one run's executor socket.
 *
 * Answering `already-running` is a fact about the run: another live executor
 * holds it, and that is not an error to translate but an outcome to report.
 */
export interface ExecutorAdmission {
  open(runId: string): Operation<Result<OwnerSocket | "already-running">>;
  /** Fresh correlation identities for this connection's commands. */
  ids(): () => string;
}

/**
 * Admit one connection and build both halves over it.
 *
 * The connection is a resource of the calling scope, so it closes exactly when
 * that scope ends — which is what makes the acquisition's lifetime the
 * connection's lifetime rather than a duration.
 */
export function* useExecutorConnection(
  admission: ExecutorAdmission,
  runId: string,
): Operation<Result<RemoteExecutorConnection | "already-running">> {
  const socket = yield* admission.open(runId);
  if (!socket.ok) {
    return socket;
  }
  if (socket.value === "already-running") {
    return Ok("already-running");
  }
  try {
    const connection = yield* useOwnerConnection(socket.value);
    const nextId = admission.ids();
    const reads = cloudflareReadLink(connection, nextId, runId);
    return Ok({
      link: cloudflareRunLink(connection, nextId, runId),
      lifecycle: cloudflareLifecycleLink(connection, reads, nextId),
      // deno-lint-ignore require-yield
      *close(): Operation<void> {
        // The socket is the acquisition. Ending the connection is how this
        // runner stops being the run's executor before its scope ends, and it
        // is the same teardown scope exit would reach, so the scope ending
        // afterwards finds nothing left to do.
        connection.close();
      },
    });
  } catch (error) {
    // Whatever went wrong reaching or building the connection, a caller learns
    // it as a storage failure rather than as this adapter's own vocabulary.
    return Err(translate(error));
  }
}
