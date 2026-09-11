/**
 * Finding and creating a run whose storage is somewhere else.
 *
 * The local provider answers "where is this run" with a path and then opens a
 * file. Here the question is already answered before a command is sent: the
 * connection was admitted for one run, so the owner on the other end of it *is*
 * that run's storage. What is left is the same pair of questions the local
 * provider asks — is there a run here, and is it this run — asked of the owner
 * in one command so the answer cannot be assembled from two moments.
 *
 * `lookup()` creates nothing. `create()` is lookup-or-create, and repeating a
 * byte-compatible creation returns the run that is already there rather than
 * making a second one. Neither hands back the link, the connection or the
 * acquisition: what a caller receives is the same scope-owned
 * `WorkflowRunDatabase` the local provider returns.
 *
 * One argument, deliberately. Opening a run and operating on it are the same
 * authority; an opener admitted for one owner paired with another owner's link
 * would authorize a create against the first and return a database backed by
 * the second, and matching run ids would make that look correct.
 */

import { Ok, type Operation, type Result } from "effection";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import { WorkflowRunStorage } from "../storage/api.ts";
import { checkRunId, parseCreateRequest } from "../storage/create-request.ts";
import { useRemoteRunDatabase, type RemoteWorkspaceLink } from "./database.ts";

/**
 * Install `WorkflowRunStorage` over one admitted owner.
 *
 * The link is the one the connection created, so every run this provider can
 * open is the run that connection was admitted for. There is no registry and
 * nothing to route: a request naming another run is refused by the owner,
 * which is the only thing that knows what it holds.
 */
export function useRemoteRunStorage(link: RemoteWorkspaceLink): Operation<void> {
  return WorkflowRunStorage.around(
    {
      *create([request]): Operation<Result<WorkflowRunDatabase>> {
        // Checked here as well as on the owner. A request this build would not
        // send is not one it asks an owner to refuse.
        const checked = parseCreateRequest(request);
        if (!checked.ok) {
          return checked;
        }
        // The parsed value, never the object it came from. A getter could
        // answer one identity while this validates and another while the
        // request is serialized, and the owner reparsing the second one would
        // retain a run nothing here admitted.
        const opened = yield* link.open(checked.value.runId, checked.value);
        if (!opened.ok) {
          return opened;
        }
        // Built from that exact answer. A second frontier read would assemble
        // the handle from two owner observations, and could fail outside the
        // `Result` this interface promises.
        return Ok(yield* useRemoteRunDatabase(link, opened.value));
      },

      *lookup([runId]): Operation<Result<WorkflowRunDatabase>> {
        const checked = checkRunId(runId);
        if (!checked.ok) {
          return checked;
        }
        const opened = yield* link.open(checked.value, null);
        if (!opened.ok) {
          return opened;
        }
        return Ok(yield* useRemoteRunDatabase(link, opened.value));
      },
    },
    { at: "min" },
  );
}
