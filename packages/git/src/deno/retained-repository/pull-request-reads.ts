/**
 * One REPL entry's `<PullRequest.Reviews>`, `.Comments` and `.Checks`: read
 * once, and answered from what the service said that time.
 *
 * `pull-request.ts` beside this opens the pull request; these three read what
 * it has collected since. They are the cheapest of the entry's retained
 * operations and the least like the others: a read needs no Repository, no
 * working directory, no managed root, no Git session and no native hold. It
 * needs a URL. So these identities are declared and installed even for an entry
 * that holds no checkout at all, and an entry whose document only reads
 * evidence acquires nothing.
 *
 * ## Where retention begins, and what is deliberately outside it
 *
 * The GitHub adapter decides three things before anything is retained: whether
 * it recognizes the request, whether this deployment's allowed list authorizes
 * the target, and whether the URL names a pull request it can read. None of
 * those is a lifecycle question and none of them may leave a record — a target
 * this host never authorized is a question the entry was not permitted to ask,
 * not a read that failed.
 *
 * Those three run on *every* execution, including the one that reopens an entry
 * whose read is already saved. That is the accepted contract rather than an
 * accident: remove the repository from the allowed list and reopening refuses
 * to continue, even though the reviews were saved an hour ago. The saved record
 * is not erased by that refusal; it simply is not reachable while the ceiling
 * says so. An allowed completed read opens no session and sends nothing.
 *
 * ## What is retained is what the provider answered
 *
 * Retention begins at the admitted-read seam and holds exactly the normalized
 * answer produced inside it. A URL or provider transformation *before*
 * admission changes the question that was recorded, because it changed which
 * read was admitted. A transformation *after* delegation is outside the
 * snapshot: it is ordinary composition, it runs again on continuation, and it
 * may produce a different array from the same saved provider answer. Nothing
 * here wraps that composition in a second envelope and presents it as saved. A
 * handler that answers without ever reaching the seam has retained nothing at
 * all.
 *
 * ## One bridge per read
 *
 * The adapter's seam carries only the question — a URL, a collection and a
 * discriminator. Who is asking is this entry's business and travels nowhere
 * public: each authored read installs a bridge in a scope of its own, holding
 * the owner and the invocation it authenticated, and that bridge permits
 * exactly one admitted handoff before it is spent.
 *
 * Installing it in the read's own scope is what makes nesting and concurrency
 * work without any coordination between reads. A nested authored read installs
 * a deeper bridge, so the deeper one wins for the invocation inside it and
 * cannot consume its parent's handoff; two concurrent reads finishing in either
 * order each keep their own URL, collection, owner and invocation; and a read
 * that has ended has no bridge left to borrow. An entry-wide pointer at the
 * provider, a value on `next` or a Context identity would each have to be
 * correct about an ordering nothing guarantees.
 */

import { scoped } from "effection";
import type { Operation } from "effection";

import type { Around } from "@effectionx/context-api";
import type { BindOperations } from "../../composition/invocation-binding.ts";
import { PullRequestReadError } from "../../composition/errors.ts";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import { PullRequestOperations } from "../../composition/pull-request-operations.ts";
import type {
  PullRequestOperationsApi,
  PullRequestReadInvocation,
} from "../../composition/pull-request-operations.ts";
import { PullRequestReadExecution } from "../../composition/pull-request-read-execution.ts";
import type {
  AdmittedPullRequestRead,
  PullRequestReadExecutionApi,
} from "../../composition/pull-request-read-execution.ts";
import { readRequest } from "../../composition/pull-request-read-records.ts";

import type {
  PullRequestReadKind,
  PullRequestReadResult,
} from "../../composition/pull-request-read-records.ts";
import {
  pullRequestReadElement,
  retainPullRequestRead,
} from "../../composition/pull-request-read-retention.ts";

/** What one authored read carries that nothing public may name. */
interface ReadBridge {
  readonly owner: string;
  readonly site: string;
  /** Whether the one admitted handoff this bridge permits has been taken. */
  spent: boolean;
  /** Whether the read that installed it is still running. */
  open: boolean;
}

export function replPullRequestReadPolicy(
  owner: string,
): BindOperations<PullRequestOperationsApi["read"]> {
  return (site) => (invocation) => read(owner, site, invocation);
}

function* read(
  owner: string,
  site: string,
  invocation: PullRequestReadInvocation,
): Operation<PullRequestReadResult> {
  return yield* scoped(function* () {
    const bridge: ReadBridge = { owner, site, spent: false, open: true };
    yield* PullRequestReadExecution.around(retaining(bridge, invocation.kind), { at: "min" });
    try {
      return yield* PullRequestOperations.operations.read(invocation);
    } finally {
      bridge.open = false;
    }
  });
}

/**
 * Retain one admitted read under this entry's identity.
 *
 * Installed at the implementation slot, so it is the innermost policy and the
 * adapter reaches it only after it has admitted the read. It consumes the one
 * handoff its bridge permits: a second admitted read under the same bridge, and
 * one reaching a bridge whose read has finished, each refuse before a record or
 * a session exists.
 */
function retaining(
  bridge: ReadBridge,
  kind: PullRequestReadKind,
): Partial<Around<PullRequestReadExecutionApi>> {
  return {
    *perform([admitted, transport]: [
      AdmittedPullRequestRead,
      () => Operation<PullRequestReadResult>,
    ]): Operation<PullRequestReadResult> {
      const element = pullRequestReadElement(admitted.kind);
      if (!bridge.open) {
        throw new PullRequestReadError(
          "protocol",
          element,
          "the read it belongs to has finished, so this dispatch names no invocation. Nothing " +
            "was asked of the Git host.",
        );
      }
      if (bridge.spent) {
        throw new PullRequestReadError(
          "protocol",
          element,
          "this read was already admitted once. A second admitted read under one element would " +
            "retain two answers under one identity, so nothing was asked of the Git host.",
        );
      }
      if (admitted.kind !== kind) {
        throw new PullRequestReadError(
          "protocol",
          element,
          "the admitted read is for a different collection than the element that owns this " +
            "dispatch, so it is not this read's answer to retain.",
        );
      }
      bridge.spent = true;

      return yield* retainPullRequestRead(
        // Owner in the run, and the authenticated invocation in the expansion,
        // which is the existing request shape. The question is the one that was
        // *admitted*: a handler that rewrote the URL or the discriminator before
        // the adapter matched it changed which read this is, and the record says
        // so.
        readRequest(admitted.url, admitted.kind, admitted.provider, bridge.owner, bridge.site),
        transport,
      );
    },
  };
}

/**
 * Forward this entry's profile-level reads to the transport surface.
 *
 * The profile surface's own default refuses, which is what distinguishes a host
 * that installed no pull-request lifecycle from one whose pull request is
 * merely unreachable. An entry has installed one, so its reads have to reach
 * the adapter beneath — and they reach it straight through, because the
 * adapter is what decides when a read is admitted and retention begins after
 * that. Wrapping the dispatch here would put the ceiling and the URL refusals
 * inside a durable effect.
 *
 * Upsert is deliberately not forwarded. Its retention is identity-bearing and
 * belongs to the authored component's own invocation-local defaults, so a
 * standalone `PullRequestOperations.upsert(...)` keeps the absent-provider
 * refusal rather than acquiring this entry's lifecycle.
 */
export function useReplPullRequestReadOperations(): Operation<void> {
  return PullRequestOperations.around(
    {
      *read([invocation]: [PullRequestReadInvocation]): Operation<PullRequestReadResult> {
        return yield* PullRequestAPI.operations.read(invocation.url, {
          kind: invocation.kind,
          ...(invocation.provider === undefined ? {} : { provider: invocation.provider }),
        });
      },
    },
    { at: "min" },
  );
}
