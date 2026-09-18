/**
 * The process that opens a pull request and is killed before it can say so.
 *
 * ```sh
 * deno run -A pull-request-crash-child.ts <root> <run-id> <locator> <endpoint> <token>
 * ```
 *
 * It stops at the one place the shared reconciliation exists for: GitHub has
 * accepted the creation and answered 201, and nothing local has been appended.
 * `SIGKILL` then runs no cleanup, so the pull request is open at the host and
 * the run's database holds no result for it — which is precisely the state the
 * next execution has to reconcile without creating a second one.
 *
 * The handshake is a line of JSON on standard output, never a sleep.
 */

import process from "node:process";
import { main, type Operation, scoped, suspend } from "effection";
import { collect, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { isGitWorkflowRunRecord, WorkflowRunStorage } from "@executablemd/workflow";
import { useWorkflowRunStorage } from "@executablemd/workflow/deno";
import { retainedWorkflowInstallation } from "../../../workflow/src/run.ts";
import { gitWorkspaceAttachment } from "../../src/deno/attachment.ts";
import { withWorkflowWorkspace } from "../../../workflow/src/deno/workspace/host.ts";
import { denoGitHubAccess } from "../../src/deno/composition/github.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../../src/deno/composition/github.ts";
import { report } from "../../../workflow/tests/support/workspace-process.ts";
import { published, pullRequest, rewriting } from "./pull-requests.ts";
import { gitHubSource } from "../../src/deno/composition/github.ts";

/** The real adapter, stopped between the host's answer and this run's record. */
function interrupted(endpoint: string): GitHubAccess {
  const inner = denoGitHubAccess(endpoint);
  return {
    endpoint,
    token: inner.token,
    *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      const response = yield* inner.send(request);
      if (request.method === "POST" && response.status === 201) {
        report({ ready: true, created: true });
        // Deno leaves when its event loop is empty, and a suspended Effection
        // task is not on it. A timer nothing clears is what keeps this process
        // alive until the signal arrives.
        setInterval(() => {}, 1_000);
        yield* suspend();
      }
      return response;
    },
  };
}

function* open(root: string, runId: string, locator: string, endpoint: string): Operation<void> {
  yield* useWorkflowRunStorage({ root });
  const opened = yield* WorkflowRunStorage.operations.lookup(runId);
  if (!opened.ok) {
    throw opened.error;
  }
  const database = opened.value;

  // This child drives a version-1 run, so its record narrows to one before the
  // installation reads a base and a pinned commit. A version-2 record has
  // neither, and a synthetic one would name a repository state no run had.
  const record = database.record;
  if (!isGitWorkflowRunRecord(record)) {
    throw new Error(`expected a Git run record, got ${record.definition.kind}`);
  }

  yield* withWorkflowWorkspace(
    database,
    scoped(function* () {
      return yield* collect(
        yield* executeInstalled(
          {
            ...inlineSource(published(...pullRequest())),
            stream: database.journal,
          },
          [
            retainedWorkflowInstallation({
              runId: record.runId,
              base: record.base,
              pinnedCommit: record.definition.objectId,
            }),
          ],
        ),
      );
    }),
    {
      attachments: [
        gitWorkspaceAttachment({
          composition: { host: rewriting(locator) },
          gitHubPullRequests: { access: gitHubSource(interrupted(endpoint)) },
        }),
      ],
    },
  );
  report({ ready: false, reason: "the pull request was recorded" });
}

main(function* () {
  // `process.argv` rather than `Deno.args`: this file is Deno-only to run, and
  // still has to typecheck under the Node project like every other source.
  const [root, runId, locator, endpoint, token] = process.argv.slice(2);
  process.env.GH_TOKEN = token;
  yield* open(root ?? "", runId ?? "", locator ?? "", endpoint ?? "");
});
