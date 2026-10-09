/**
 * How one local repository mutation is retained, performed and proven.
 *
 * The shape of every operation here is the same, and the order is the whole
 * point. Before anything is touched, the current state is read and the complete
 * transition is worked out — in disposable scratch when Git itself is needed to
 * work it out — so that what gets written down is a decision rather than a
 * hope. Only then is the intent appended, and only once that append is
 * acknowledged does the target change. The completion is appended after the
 * result and the resulting state have both been checked.
 *
 * That order is what a later open depends on. An intent with no completion is
 * an operation that may or may not have run, and the two states it froze are
 * the only ones a resume will accept: finding the one it started from means the
 * operation can be performed, finding the one it predicted means it already
 * happened and is adopted, and finding anything else is stale and fatal. There
 * is no third answer and nothing is repaired to manufacture one.
 *
 * One lane per shared Git directory serializes all of it. Two linked worktrees
 * share refs, so two mutations in flight over one common directory would each
 * predict a transition from a state the other was about to leave.
 */

import { Err, Ok, ensure, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { createDurableOperation } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import {
  RETAINED_REPOSITORY_COMPLETION,
  RETAINED_REPOSITORY_INTENT,
  RETAINED_REPOSITORY_VERSION,
  matchesRetainedEvidence,
  retainedRepositoryCompletionJson,
  retainedRepositoryIntentIdentity,
  retainedRepositoryIntentJson,
  retainedRepositoryRequestFingerprint,
  sameRetainedFrontier,
} from "../../retained-repository/records.ts";
import type {
  RetainedFrontier,
  RetainedRepositoryIntent,
  RetainedRepositoryOperation,
  RetainedRepositorySite,
} from "../../retained-repository/records.ts";
import { FrontierError } from "./frontier.ts";

/** What a retained operation could not do, having changed nothing. */
export class RetainedOperationError extends Error {
  override name = "RetainedOperationError";
}

/**
 * The state a prepared transition expects and promises.
 *
 * `evidence` is the exact result the operation will produce when it performs,
 * and it is what the completion is held to: a different result is a different
 * operation, whatever the state ended up looking like.
 */
export interface PreparedTransition {
  readonly postState: RetainedFrontier;
  readonly prepared: Json;
  readonly evidence: Json;
}

/** One mutation, as its component describes it to this protocol. */
export interface RetainedOperation {
  readonly owner: string;
  readonly site: RetainedRepositorySite;
  readonly operation: RetainedRepositoryOperation;
  /** The logical checkout this changes, and the shared directory it is in. */
  readonly checkout: string;
  readonly common: string;
  /** The selection identity retained beside the request. */
  readonly selection: Json;
  /** Exactly what the document asked for, detached. */
  readonly request: Json;
  /** Read the state of the checkout right now. */
  inventory(): Operation<Result<RetainedFrontier>>;
  /**
   * Work out the whole transition without changing the checkout.
   *
   * Free to use disposable scratch, and held to leaving the target exactly as
   * it found it — which this module verifies rather than trusts.
   */
  prepare(preState: RetainedFrontier): Operation<Result<PreparedTransition>>;
  /** Perform it once, from the frozen inputs, without reinterpreting them. */
  perform(transition: PreparedTransition): Operation<Result<Json>>;
}

/** What one entry's history already holds for this protocol to resume from. */
export interface RetainedResume {
  /** The intent this occurrence left unresolved, when it left one. */
  pending(identity: string): RetainedRepositoryIntent | undefined;
}

/** One shared Git directory's turn, held from inspection to acknowledgement. */
export interface RetainedLanes {
  enter(common: string): Operation<void>;
}

/**
 * One lane per shared Git directory, owned by the scope that made it.
 *
 * Ephemeral synchronization and nothing more: it is not a queue anybody
 * retains, and it says nothing about a second process — that is what the
 * leases are for.
 */
export function retainedLanes(): RetainedLanes {
  const tails = new Map<string, Turn>();
  return {
    *enter(common: string): Operation<void> {
      const turn = withResolvers<void>();
      // Registered before this turn is published, not after: a caller halted
      // while registering has taken nobody's place, where one halted after
      // publishing without a release would hold the lane shut for good.
      yield* ensure(() => {
        turn.resolve();
        if (tails.get(common) === turn) {
          tails.delete(common);
        }
      });
      const ahead = tails.get(common);
      tails.set(common, turn);
      if (ahead !== undefined) {
        yield* ahead.operation;
      }
    },
  };
}

/** One caller's turn in a lane: what the next one waits on, and its release. */
type Turn = ReturnType<typeof withResolvers<void>>;

/**
 * Run one operation under the retained protocol, and answer with its result.
 *
 * The result is the operation's own — the same value a live run produces and a
 * replay restores — so a caller cannot tell from it which of the two happened,
 * which is the point.
 */
export function* retain(
  operation: RetainedOperation,
  resume: RetainedResume,
  lanes: RetainedLanes,
): Operation<Result<Json>> {
  // Held from the first inspection through the last acknowledgement, and
  // released with the scope that took it. Two mutations over one shared Git
  // directory would otherwise each predict a transition from a state the other
  // was about to leave.
  yield* lanes.enter(operation.common);
  const fingerprint = yield* retainedRepositoryRequestFingerprint({
    owner: operation.owner,
    site: operation.site,
    operation: operation.operation,
    selection: operation.selection,
    request: operation.request,
  });

  const before = yield* operation.inventory();
  if (!before.ok) {
    return before;
  }
  const transition = yield* operation.prepare(before.value);
  if (!transition.ok) {
    return transition;
  }
  // The preparation is held to having changed nothing. A prediction that moved
  // the checkout would have moved the state its own intent is about to claim.
  const after = yield* operation.inventory();
  if (!after.ok) {
    return after;
  }
  if (!sameRetainedFrontier(before.value, after.value)) {
    return Err(
      new FrontierError(
        `preparing "${operation.operation}" changed the checkout it was predicting, so nothing ` +
          "here describes the state it started from.",
      ),
    );
  }

  const intent: RetainedRepositoryIntent = Object.freeze({
    version: RETAINED_REPOSITORY_VERSION,
    owner: operation.owner,
    site: operation.site,
    operation: operation.operation,
    lane: { common: operation.common, position: 0 },
    selection: operation.selection,
    request: operation.request,
    fingerprint,
    prepared: transition.value.prepared,
    preState: before.value,
    postState: transition.value.postState,
    evidence: transition.value.evidence,
  });
  const identity = yield* retainedRepositoryIntentIdentity(intent);

  // A resume for this exact occurrence: the state decides what may happen, and
  // the only two states it may be in are the ones the saved intent froze.
  const saved = resume.pending(identity);
  if (saved !== undefined) {
    const standing = yield* operation.inventory();
    if (!standing.ok) {
      return standing;
    }
    if (sameRetainedFrontier(standing.value, saved.postState)) {
      // The interrupted operation reached its own far end: adopt it rather
      // than performing anything a second time.
      return yield* acknowledge(saved, identity, saved.evidence, saved.postState);
    }
    if (!sameRetainedFrontier(standing.value, saved.preState)) {
      return Err(
        new FrontierError(
          `resuming "${operation.operation}" found a state its saved intent neither started ` +
            "from nor predicted, so what happened to this checkout is not recorded here.",
        ),
      );
    }
  }

  yield* append(intent, identity, RETAINED_REPOSITORY_INTENT, () =>
    retainedRepositoryIntentJson(intent),
  );

  const produced = yield* operation.perform(transition.value);
  if (!produced.ok) {
    return produced;
  }
  // The result and the state are both checked before anything is written down:
  // a nonzero exit proves neither, and neither does a plausible-looking one.
  if (!matchesRetainedEvidence(produced.value, transition.value.evidence)) {
    return Err(
      new RetainedOperationError(
        `"${operation.operation}" produced a result its prepared transition did not predict.`,
      ),
    );
  }
  const settled = yield* operation.inventory();
  if (!settled.ok) {
    return settled;
  }
  if (!sameRetainedFrontier(settled.value, transition.value.postState)) {
    return Err(
      new FrontierError(
        `"${operation.operation}" left the checkout in a state its prepared transition did not ` +
          "predict.",
      ),
    );
  }

  return yield* acknowledge(intent, identity, produced.value, settled.value);
}

/**
 * Write the completion down, and only then answer.
 *
 * Returning before the append was acknowledged would let the document go on
 * while the only record of this mutation was still in memory.
 */
function* acknowledge(
  intent: RetainedRepositoryIntent,
  identity: string,
  result: Json,
  frontier: RetainedFrontier,
): Operation<Result<Json>> {
  const completion = Object.freeze({
    version: RETAINED_REPOSITORY_VERSION,
    owner: intent.owner,
    site: intent.site,
    intent: identity,
    fingerprint: intent.fingerprint,
    result,
    frontier,
  });
  yield* append(intent, identity, RETAINED_REPOSITORY_COMPLETION, () =>
    retainedRepositoryCompletionJson(completion),
  );
  return Ok(result);
}

/**
 * One record, under a name derived from what it is a record of.
 *
 * The name is a domain-separated tuple of the owner, the occurrence, the
 * operation and the phase — nothing from a clock, a scheduler or the checkout's
 * current state — so the same work arrives at the same name on a later open and
 * the stream recognizes it.
 */
function* append(
  intent: RetainedRepositoryIntent,
  identity: string,
  phase: string,
  record: () => Json,
): Operation<void> {
  const name = canonicalJson([
    "retained-repository",
    phase,
    intent.owner,
    identity,
    intent.operation,
  ]);
  yield createDurableOperation<Json>({ type: phase, name }, function* () {
    return record();
  });
}

/** The intents one admitted history left unresolved, by their own identity. */
export function retainedResume(
  pending: readonly { readonly identity: string; readonly intent: RetainedRepositoryIntent }[],
): RetainedResume {
  const held = new Map(pending.map((effect) => [effect.identity, effect.intent]));
  return { pending: (identity) => held.get(identity) };
}
