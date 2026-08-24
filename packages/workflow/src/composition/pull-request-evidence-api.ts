/**
 * The request-only route a pull-request evidence read passes through
 * (specs/workflow-workspace-spec.md §7.7).
 *
 * Public middleware is entitled to know what a document is about to read, and
 * to stop it: a host that narrows which pull requests a run may look at, a test
 * that refuses the network, a policy that allows reviews and not checks. So the
 * request crosses this Api, where anything installed in scope sees it and may
 * throw, delegate to `next`, or pass it along.
 *
 * What does not cross it is the evidence. This route answers with a *request*,
 * never with a review, a comment or a check, so there is no return value here
 * that could become what a document binds or what the journal retains. A
 * handler that wants to change the answer has nothing to change it to.
 *
 * ## Why the answer is an object rather than a value
 *
 * The request an invocation issues is minted by the host and kept in an
 * owner-held set. The terminal behind this route admits only that exact object.
 * A handler may return it; a handler that returns a copy with the same members,
 * a request another invocation issued, or one it built from the retained
 * journal is returning something the terminal has no record of minting, and the
 * read is refused rather than performed under an identity nobody proved.
 *
 * Structural equality would not do. Two invocations of `<PullRequest.Reviews>`
 * on the same number in the same document produce equal requests, and a
 * middleware that held the first and returned it in place of the second would
 * be choosing which invocation's evidence the second one binds.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PullRequestReadRequest } from "./pull-request-read-records.ts";

/** The contextual name this route is reached under, across loaded copies. */
export const PULL_REQUEST_EVIDENCE_API = "executablemd.workflow.pull-request-evidence";

export interface PullRequestEvidenceApi {
  /**
   * Observe the read a document is about to perform.
   *
   * Answers with the request to perform — which is the request it was given, or
   * a refusal. It never answers with evidence.
   */
  read(request: PullRequestReadRequest): Operation<PullRequestReadRequest>;
}

export const PullRequestEvidence: Api<PullRequestEvidenceApi> = createApi<PullRequestEvidenceApi>(
  PULL_REQUEST_EVIDENCE_API,
  {
    // deno-lint-ignore require-yield
    *read(request: PullRequestReadRequest): Operation<PullRequestReadRequest> {
      return request;
    },
  },
);
