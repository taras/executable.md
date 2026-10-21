/**
 * The pull-request work a retaining host asks for, and nothing it owns.
 *
 * Two operations. One performs an admitted evidence read, handing the host its
 * own retention callback for the moment the read is admitted and no earlier.
 * The other answers with a provider for one upsert attempt. Both keep this
 * adapter's configuration, its endpoint and its credential on this side of the
 * boundary: a caller never receives a source, an access session or a token, and
 * never a configuration reader it could point somewhere else.
 *
 * ## Why the read takes a callback rather than returning a session
 *
 * Matching, URL validation and the operator's read ceiling are this adapter's
 * decisions and happen before anything is opened, so a target this host never
 * authorized leaves no trace. What happens to an *admitted* read is the host's
 * — an ordinary run performs it afresh, a workflow run retains it per run, a
 * REPL entry retains it per occurrence. Handing the host a transport instead
 * would make it decide admission too, and would put the credential in its
 * hands to do it with.
 *
 * ## One handle, one memoization, no stored callback
 *
 * The configuration and the transport resolve once per handle and stay inert
 * until something needs a session, which is the existing behavior. Neither the
 * callback nor the continuation a call supplies is kept on the handle: they
 * belong to that one call, so two concurrent reads cannot reach each other's.
 */

import type { Operation } from "effection";
import {
  gitHubPullRequestReadHandler,
  gitHubPullRequestReadResolver,
} from "./pull-request-reads.ts";
import type { AdmittedReadExecution } from "./pull-request-reads.ts";
import { denoGitHubSource } from "./github-host.ts";
import { pullRequestProvider } from "./github-pull-request.ts";
import type { PullRequestReadOptions } from "../../composition/pull-request-api.ts";
import type { PullRequestReadResult } from "../../composition/pull-request-read-records.ts";
import type { PullRequestInputs } from "../../composition/pull-request-records.ts";
import type { GitHostProvider } from "../../git-host/api.ts";

export interface DenoPullRequestOperations {
  read(
    url: string,
    options: PullRequestReadOptions,
    execute: AdmittedReadExecution,
    next: (url: string, options: PullRequestReadOptions) => Operation<PullRequestReadResult>,
  ): Operation<PullRequestReadResult>;

  provider(origin: string, inputs: PullRequestInputs): Operation<GitHostProvider>;
}

/**
 * One inert handle per installation.
 *
 * Naming it reads no configuration and opens nothing; the shipped platform
 * source is constructed on first use, inside this closure, and reaches no
 * caller.
 */
export function denoPullRequestOperations(): DenoPullRequestOperations {
  const resolved = gitHubPullRequestReadResolver({ host: denoGitHubSource });

  return {
    read(
      url: string,
      options: PullRequestReadOptions,
      execute: AdmittedReadExecution,
      next: (url: string, options: PullRequestReadOptions) => Operation<PullRequestReadResult>,
    ): Operation<PullRequestReadResult> {
      // Built for this call, so what is admitted reaches this caller's own
      // callback and nothing on the shared handle holds it.
      return gitHubPullRequestReadHandler(resolved, execute)([url, options], next);
    },

    *provider(origin: string, inputs: PullRequestInputs): Operation<GitHostProvider> {
      // Opened inside the attempt that asked, so the session ends with it.
      const access = yield* resolved.transport((yield* resolved.authorized()) ?? {}).open();
      return pullRequestProvider(access, origin, inputs);
    },
  };
}
