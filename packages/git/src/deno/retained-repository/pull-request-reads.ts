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
 * here wraps that composition in a second envelope and claims it was saved. A
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
import { createDurableOperation } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { documented, formDispatcher } from "@executablemd/core";
import type { ComponentInvocation, FunctionComponent } from "@executablemd/core";
import type {
  IdentityClaimant,
  IdentityComponent,
  JournalAdmission,
} from "@executablemd/core/host";
import type { Around } from "@effectionx/context-api";
import { COMPOSITION_ORIGIN } from "../../composition/definitions.ts";
import {
  checksDocumentation,
  checksReturns,
  CHECKS_ELEMENT,
  commentsDocumentation,
  commentsReturns,
  COMMENTS_ELEMENT,
  props as pullRequestReadProps,
  pullRequestReadBinding,
  pullRequestReadTarget,
  reviewsDocumentation,
  reviewsReturns,
  REVIEWS_ELEMENT,
} from "../../composition/components/PullRequestReads.ts";
import { PullRequestReadError } from "../../composition/errors.ts";
import { PullRequestOperations } from "../../composition/pull-request-operations.ts";
import { PullRequestReadExecution } from "../../composition/pull-request-read-execution.ts";
import type {
  AdmittedPullRequestRead,
  PullRequestReadExecutionApi,
} from "../../composition/pull-request-read-execution.ts";
import {
  pullRequestReadEnvelopeJson,
  readRequest,
} from "../../composition/pull-request-read-records.ts";
import {
  admitReplPullRequestReadRequest,
  admitReplPullRequestReadResult,
  replPullRequestReadNameRefusal,
} from "../../retained-repository/pull-request-read-admission.ts";
import type {
  PullRequestReadKind,
  PullRequestReadRequest,
  PullRequestReadResult,
} from "../../composition/pull-request-read-records.ts";
import type { FirstPartyDocumentation, ReturnsSchema } from "@executablemd/core";
import {
  describePullRequestRead,
  PULL_REQUEST_READ,
  pullRequestReadElement,
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

/** The three collections, with everything their declarations differ by. */
const COLLECTIONS: readonly {
  readonly kind: PullRequestReadKind;
  readonly name: string;
  readonly element: string;
  readonly returns: ReturnsSchema;
  readonly documentation: FirstPartyDocumentation;
}[] = [
  {
    kind: "reviews",
    name: "PullRequest.Reviews",
    element: REVIEWS_ELEMENT,
    returns: reviewsReturns,
    documentation: reviewsDocumentation,
  },
  {
    kind: "comments",
    name: "PullRequest.Comments",
    element: COMMENTS_ELEMENT,
    returns: commentsReturns,
    documentation: commentsDocumentation,
  },
  {
    kind: "checks",
    name: "PullRequest.Checks",
    element: CHECKS_ELEMENT,
    returns: checksReturns,
    documentation: checksDocumentation,
  },
];

/**
 * The entry's own three evidence reads, as ordinary shadowable components.
 *
 * Each shadows the inherited bundled registration for this execution's scope
 * without touching it, so a repository-local replacement keeps its ordinary
 * precedence over both. What a replacement does not get is an identity
 * authenticator, so it names no retained read of this entry's.
 *
 * Inspection describes one component per collection — the same origin, props,
 * return contract, self-closing form and prose the bundled registrations carry.
 */
export function replPullRequestReadComponents(owner: string): IdentityComponent[] {
  return COLLECTIONS.map((collection) => ({
    name: collection.name,
    origin: COMPOSITION_ORIGIN,
    props: pullRequestReadProps,
    returns: collection.returns,
    forms: ["self-closing"] as const,
    ...documented(collection.documentation),
    factory: (claim: IdentityClaimant) =>
      // Canonical form dispatch, so the form is settled by the scan before the
      // body runs, and a paired invocation is refused with the component's own
      // sentence rather than reaching a read.
      formDispatcher({
        forms: "self-closing",
        fn: readingBody(owner, claim, collection.kind, collection.element),
        refuse: () =>
          new PullRequestReadError(
            "unexpected-content",
            collection.element,
            "it names a pull request to read and renders nothing of its own, so it is written " +
              "self-closing.",
          ),
      }),
  }));
}

function readingBody(
  owner: string,
  claim: IdentityClaimant,
  kind: PullRequestReadKind,
  element: string,
): FunctionComponent {
  return function* PullRequestRead(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<Json> {
    // The same reading of the same props the bundled component makes, and its
    // refusals are the component's own settled sentences. A URL this element
    // cannot name is refused here, before a provider is asked anything.
    const target = pullRequestReadTarget(props, element);
    const site = yield* claim(invocation);

    return yield* scoped(function* (): Operation<Json> {
      // This read's own bridge, in this read's own scope. It is gone when this
      // scope ends, which is what leaves a finished read nothing to borrow.
      const bridge: ReadBridge = { owner, site, spent: false, open: true };
      yield* PullRequestReadExecution.around(retaining(bridge, kind), { at: "min" });
      try {
        // The ordinary dispatch, so every public handler a document or a plugin
        // composed still answers, transforms, refuses and delegates. What comes
        // back is whatever composed above the provider, and it is held to the
        // collection this element asked for before any of it binds.
        return pullRequestReadBinding(
          yield* PullRequestOperations.operations.read({
            url: target.url,
            kind,
            provider: target.provider,
          }),
          kind,
          element,
        );
      } finally {
        bridge.open = false;
      }
    });
  };
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
 * The transport's own session and pagination belong to the callback, so they are
 * finished and joined before this position publishes anything. An expected
 * failure after admission is retained as this read's own and binds no partial
 * array; an interruption before acknowledgement leaves the read repeatable,
 * which is safe in the way repeating a mutation is not.
 */
function* retain(
  request: PullRequestReadRequest,
  element: string,
  transport: () => Operation<PullRequestReadResult>,
): Operation<PullRequestReadResult> {
  const description = yield* describePullRequestRead(request);
  const stored: unknown = yield createDurableOperation<Json>(description, function* () {
    const answered = yield* transport();
    if (answered.kind !== request.kind) {
      throw new PullRequestReadError(
        "protocol",
        element,
        "the selected provider answered with a different collection than the one this element " +
          "asked for.",
      );
    }
    return pullRequestReadEnvelopeJson(answered);
  });
  return retainedPullRequestRead(stored, request.kind, element);
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
      const described = yield* describePullRequestRead(request);
      if (event.description.name !== described.name) {
        throw replPullRequestReadNameRefusal();
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
