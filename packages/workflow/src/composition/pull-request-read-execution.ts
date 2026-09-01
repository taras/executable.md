/**
 * What happens to a pull-request read *after* the transport has admitted it.
 *
 * The GitHub adapter decides three things that belong to it alone: whether the
 * request is one it recognizes, whether the host ceiling authorizes the target,
 * and whether the URL names a pull request it can read. None of those is a
 * question about lifecycle, and none of them may leave a trace — a target this
 * host never authorized is a question the run was not permitted to ask, not a
 * read that failed.
 *
 * Once those three are answered, what to *do* with the admitted read is the
 * profile's business and no longer the adapter's. That is this boundary. The
 * adapter hands over the admitted read and the operation that would perform it;
 * the installed policy decides whether performing it is retained.
 *
 * The base performs it afresh, which is both the ordinary profile's behaviour
 * and the honest default: a host that installed no lifecycle policy still reads
 * the collection, it simply keeps nothing. A workflow run composes middleware
 * here that wraps the same operation in one durable effect, so a completed one
 * replays without a session and a failure after admission is retained as this
 * read's own.
 *
 * The admitted read carries only what identifies the question — no run, no
 * expansion, no database. Those are the workflow profile's to add, from context
 * it has and the adapter does not, which is what lets one adapter serve both
 * profiles without importing either one's authority.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PullRequestReadKind, PullRequestReadResult } from "./pull-request-read-records.ts";

/** The stable name every loaded copy composes through. */
export const PULL_REQUEST_READ_EXECUTION =
  "executablemd.workflow.composition.pull-request-read-execution";

/** One read a transport has decided to answer, as its identity alone. */
export interface AdmittedPullRequestRead {
  /** The canonical pull-request URL the transport admitted. */
  readonly url: string;
  /** Which of the three collections this read is for. */
  readonly kind: PullRequestReadKind;
  /** The explicit discriminator, when the element carried one. */
  readonly provider: string | undefined;
}

export interface PullRequestReadExecutionApi {
  /**
   * Perform one admitted read under this profile's lifecycle.
   *
   * `transport` is the adapter's own work — opening its session and reading the
   * collection — and is called at most once. A policy that retains may skip it
   * entirely when it already holds the answer.
   */
  perform(
    admitted: AdmittedPullRequestRead,
    transport: () => Operation<PullRequestReadResult>,
  ): Operation<PullRequestReadResult>;
}

/**
 * Fresh execution, which is the ordinary profile's whole lifecycle.
 *
 * Unlike the surfaces whose default refuses, this one performs: an adapter that
 * has admitted a read has already established that this host authorizes the
 * target, and refusing here would make reading depend on a lifecycle policy
 * that only one profile installs.
 */
export const PullRequestReadExecution: Api<PullRequestReadExecutionApi> =
  createApi<PullRequestReadExecutionApi>(PULL_REQUEST_READ_EXECUTION, {
    *perform(
      _admitted: AdmittedPullRequestRead,
      transport: () => Operation<PullRequestReadResult>,
    ): Operation<PullRequestReadResult> {
      return yield* transport();
    },
  });
