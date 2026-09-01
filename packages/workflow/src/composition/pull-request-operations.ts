/**
 * The profile-level pull-request Api: what the four components ask, before any
 * transport hears about it.
 *
 * `PullRequestAPI` is the transport surface — GitHub's middleware matches the
 * URLs it recognizes, holds a read to the host's ceiling, reconciles a create
 * or an update, and normalizes what comes back. This is the layer above it, and
 * what it owns is *lifecycle and authority*: whether an answer is retained,
 * what proves this run published the branch a pull request would name, and what
 * a second execution inherits.
 *
 * The two profiles answer differently, which is why the seam exists.
 *
 * A workflow run retains a read as a durable effect and reconciles an upsert as
 * a Git-host effect, both keyed by its WorkflowRun and expansion, and it proves
 * publication by scanning its own journal for the matching successful
 * `<Git.Push>` record. A replayed run reaches nothing.
 *
 * An ordinary `xmd run` retains nothing. It reads afresh every execution, and
 * it proves publication from evidence its own provider instance stored when it
 * verified a Push — held in the provider's closure, for this invocation only.
 * Copying a Context value, a component result or a previous `--journal` file
 * grants nothing, because none of them is where the evidence lives.
 *
 * The default handler throws, so a host that installed neither profile is
 * distinguishable from one whose pull request is merely unreachable.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PullRequestInput } from "./pull-request-api.ts";
import type { PullRequestReadKind, PullRequestReadResult } from "./pull-request-read-records.ts";
import type { PullRequestResult } from "./pull-request-records.ts";
import type { RepositorySelection } from "./selection.ts";

/** The stable name every loaded copy composes through. */
export const PULL_REQUEST_OPERATIONS = "executablemd.workflow.composition.pull-request-operations";

/** Which collection a read wants, and where it may be sent. */
export interface PullRequestReadInvocation {
  /** The canonical pull-request URL. */
  readonly url: string;
  /** Which of the three collections this read is for. */
  readonly kind: PullRequestReadKind;
  /** The explicit discriminator, for a self-hosted or non-standard URL. */
  readonly provider: string | undefined;
}

/**
 * Where the pull request goes, and what the provider needs to get it there.
 *
 * Unlike a read, an upsert is about a branch in a checkout this run holds, so
 * the Repository selection and the working directory the component observed
 * travel with it. They are what the selected provider authenticates before it
 * publishes anything.
 */
export interface PullRequestUpsertInvocation {
  readonly pullRequest: PullRequestInput;
  readonly repository: RepositorySelection;
  readonly workingDirectory: string;
}

/** No profile installed a pull-request lifecycle in this scope. */
export class PullRequestOperationsProviderError extends Error {
  override name = "PullRequestOperationsProviderError";

  constructor(operation: string) {
    super(
      `no pull-request provider is installed, so ${operation} cannot answer. The Deno and ` +
        "compiled `xmd run` entrypoints install the ordinary one; a workflow host installs the " +
        "retained one for a live or partial execution.",
    );
  }
}

export interface PullRequestOperationsApi {
  /** Read one collection the pull request this invocation names already holds. */
  read(invocation: PullRequestReadInvocation): Operation<PullRequestReadResult>;

  /**
   * Create or bring up to date one pull request for the selected checkout.
   *
   * Answers with the identity #295 settled, unchanged by this surface: the
   * filtered Repository identity, the provider's own stable identity, the
   * number, the URL, the open state, and the head and base commits the
   * reconciliation finished at.
   */
  upsert(invocation: PullRequestUpsertInvocation): Operation<PullRequestResult>;
}

export const PullRequestOperations: Api<PullRequestOperationsApi> =
  createApi<PullRequestOperationsApi>(PULL_REQUEST_OPERATIONS, {
    // deno-lint-ignore require-yield
    *read(invocation: PullRequestReadInvocation): Operation<PullRequestReadResult> {
      throw new PullRequestOperationsProviderError(
        `a <PullRequest.${collection(invocation.kind)}>`,
      );
    },
    // deno-lint-ignore require-yield
    *upsert(_invocation: PullRequestUpsertInvocation): Operation<PullRequestResult> {
      throw new PullRequestOperationsProviderError("<PullRequest>");
    },
  });

/** The element name a read of this collection is written as. */
function collection(kind: PullRequestReadKind): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}
