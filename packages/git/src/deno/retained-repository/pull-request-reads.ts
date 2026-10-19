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
import { createDurableOperation, serializeError } from "@executablemd/durable-streams";
import type {
  AbandonedRetainedHistory,
  ActivateDurabilityFailure,
  DurableEvent,
  Json,
  JournalProvenance,
  LiveDurableOperationCoordinator,
  Result as DurableResult,
} from "@executablemd/durable-streams";

import type { JournalAdmission } from "@executablemd/core/host";
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
import {
  parsePullRequestReadResult,
  PULL_REQUEST_READ,
  pullRequestReadEnvelopeJson,
  pullRequestReadHeadsAgree,
  readRequest,
} from "../../composition/pull-request-read-records.ts";

import {
  admitReplPullRequestReadRequest,
  admitReplPullRequestReadResult,
  replPullRequestReadConfigurationRefusal,
  replPullRequestReadNameRefusal,
} from "../../retained-repository/pull-request-read-admission.ts";

import type {
  PullRequestReadKind,
  PullRequestReadRequest,
  PullRequestReadResult,
} from "../../composition/pull-request-read-records.ts";
import {
  describePullRequestRead,
  pullRequestReadElement,
  pullRequestReadName,
  retainedPullRequestRead,
} from "../composition/pull-request-operations.ts";

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
      const answered = yield* PullRequestOperations.operations.read(invocation);
      return validRead(answered, invocation.kind, pullRequestReadElement(invocation.kind)).result;
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

      return yield* retain(
        // Owner in the run, and the authenticated invocation in the expansion,
        // which is the existing request shape. The question is the one that was
        // *admitted*: a handler that rewrote the URL or the discriminator before
        // the adapter matched it changed which read this is, and the record says
        // so.
        readRequest(admitted.url, admitted.kind, admitted.provider, bridge.owner, bridge.site),
        element,
        transport,
      );
    },
  };
}

/**
 * Retain this admitted read, or restore what is already retained.
 *
 * One durable position, described and named by the existing algorithm so a
 * journal a fork reads keeps saying the same thing. The whole envelope is
 * validated before it is appended and again when it is read back: a value that
 * is not the evidence this read produces is refused rather than bound, and only
 * `items` ever becomes the component's binding.
 *
 * An expected failure after admission is retained as this read's own and binds
 * no partial array; an interruption before acknowledgement leaves the read
 * repeatable, which is safe in the way repeating a mutation is not.
 */
function* retain(
  request: PullRequestReadRequest,
  element: string,
  transport: () => Operation<PullRequestReadResult>,
): Operation<PullRequestReadResult> {
  const description = yield* describePullRequestRead(request);
  // One attempt per read, reachable only from the two halves of this operation.
  // Nothing a provider, a handler or a document holds can put an answer in it.
  const attempt: ReadAttempt = {};
  const stored: unknown = yield createDurableOperation<Json>(
    description,
    function* (): Operation<Json> {
      try {
        const answered = yield* transport();
        return validRead(answered, request.kind, element).envelope;
      } catch (error) {
        // Reported rather than raised. An expected read failure is this read's
        // own answer, and raising it would carry it out through the same
        // channel that reports a scope which failed to close — where no
        // inspection of the error could tell one of those from the other. A
        // refusal has no envelope, and the value it returns is never read.
        attempt.refusal = { error };
        return null;
      }
    },
    { coordinator: readCoordinator(attempt) },
  );
  return restoredRead(stored, request.kind, element);
}

/**
 * What one read's own attempt reported, as only this operation can see it.
 *
 * Present and holding the failure when the admitted read raised instead of
 * answering, and absent otherwise — boxed, so a read that raised something
 * undefined still reports a refusal. It is written before the attempt's scope
 * begins to close and read only after that scope has closed, which is what
 * keeps it an account of the read rather than of the unwinding.
 */
interface ReadAttempt {
  refusal?: { readonly error: unknown };
}

/**
 * This read's attempt boundary: finish, tear down, join, then acknowledge.
 *
 * A read opens things — an authenticated session, a page walk, whatever a
 * provider acquires to answer. Publishing while those are still open would
 * acknowledge an answer the attempt that produced it has not finished
 * producing, and a reopen would then restore a read whose first run was still
 * unwinding when the journal said it was done. So the attempt runs in a scope
 * of its own and the scope is closed before either outcome is published.
 *
 * The attempt reports its own outcome rather than raising it, so a scope that
 * returns at all is a scope that closed, and that return is what admits an
 * outcome to publication. Nothing about the exception a failure arrives as
 * takes part in the decision. An expected read failure is this read's answer
 * and is retained as one; a throw reaching here is the boundary itself failing
 * — a cleanup that threw while the attempt unwound, or any failure nobody here
 * authored, including one indistinguishable from the read's own — and it
 * publishes nothing and activates the run's existing fail-stop state, because a
 * live operation that appended nothing would otherwise leave the next one to
 * append at this one's position. An interruption publishes nothing at all.
 */
function readCoordinator(attempt: ReadAttempt): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: DurableResult) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
      _journalProvenance: JournalProvenance | undefined,
      _abandoned: AbandonedRetainedHistory,
    ): Operation<DurableResult> {
      let answered: T;
      try {
        answered = yield* scoped(execute);
      } catch (error) {
        throw activateFailure(
          error instanceof Error ? error : new Error("the evidence read boundary failed"),
        );
      }
      // The scope returned, so the attempt and everything it opened are closed,
      // and what the attempt reported is now this read's outcome.
      const refusal = attempt.refusal;
      const result: DurableResult =
        refusal === undefined
          ? { status: "ok", value: answered }
          : { status: "err", error: serializeError(errorOf(refusal.error)) };
      yield* publish(result);
      return result;
    },
  };
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error("the evidence read failed");
}

/**
 * The envelope this answer retains, or this read's own refusal that it is none.
 *
 * Held to the whole contract before a success may be published, and held to it
 * through the codec that writes the record rather than over the object in hand:
 * what has to be the evidence that read produces is the value this position
 * would append. An item shape no reader can parse and a checks collection
 * describing a commit other than the head it was read at are both answers whose
 * meaning is unknown, and an unknown answer is not one to acknowledge.
 */
function validRead(
  answered: PullRequestReadResult,
  kind: PullRequestReadKind,
  element: string,
): { readonly result: PullRequestReadResult; readonly envelope: Json } {
  if (answered.kind !== kind) {
    throw new PullRequestReadError(
      "protocol",
      element,
      "the selected provider answered with a different collection than the one this element " +
        "asked for.",
    );
  }
  const envelope = pullRequestReadEnvelopeJson(answered);
  const parsed = parsePullRequestReadResult(envelope);
  if (parsed === undefined || parsed.kind !== kind) {
    throw new PullRequestReadError(
      "protocol",
      element,
      "the answer it received is not the evidence that read produces, so nothing was retained " +
        "for it.",
    );
  }
  if (!pullRequestReadHeadsAgree(parsed)) {
    throw new PullRequestReadError(
      "protocol",
      element,
      "the checks it received include one about a commit other than the head they were read " +
        "at, so what they say about that commit is unknown and nothing was retained for it.",
    );
  }
  return { result: parsed, envelope };
}

/** The retained value this read restores, held to the same whole contract. */
function restoredRead(
  stored: unknown,
  kind: PullRequestReadKind,
  element: string,
): PullRequestReadResult {
  const result = retainedPullRequestRead(stored, kind, element);
  if (!pullRequestReadHeadsAgree(result)) {
    throw new PullRequestReadError(
      "protocol",
      element,
      "what this entry retained for it includes a check about a commit other than the head it " +
        "recorded, so what it says about that commit is unknown.",
    );
  }
  return result;
}

/**
 * What this entry requires of the evidence reads its history holds.
 *
 * The record, the owner and the retained collection are the neutral
 * admission's questions; what is asked here is the one it cannot ask, because
 * the read's name is a synchronous native digest that belongs to this half of
 * the package.
 */
export function replPullRequestReadAdmission(owner: string): JournalAdmission {
  return function* (retained: readonly DurableEvent[]): Operation<void> {
    for (const event of retained) {
      if (event.type !== "yield" || event.description.type !== PULL_REQUEST_READ) {
        continue;
      }
      const request = admitReplPullRequestReadRequest(owner, event.description["input"]);
      // The name and the configuration, but not the whole description: this
      // runs over a retained history before any element is expanding, and the
      // source position a description also carries is only available there.
      const named = pullRequestReadName(request);
      if (event.description.name !== named.name) {
        throw replPullRequestReadNameRefusal();
      }
      if (event.description.configuration !== named.configuration) {
        throw replPullRequestReadConfigurationRefusal();
      }

      if (event.result.status !== "ok") {
        // A refused read retains no result of its own: its outcome is the
        // durable operation's failed result, and there is nothing in it to hold
        // to a collection. Its description was still held to this entry above.
        continue;
      }
      admitReplPullRequestReadResult(request, event.result.value);
    }
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
