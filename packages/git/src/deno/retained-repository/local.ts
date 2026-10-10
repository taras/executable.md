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

import { Err, Ok, ensure, scoped, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { createDurableOperation } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import {
  RETAINED_REPOSITORY_COMPLETION,
  RETAINED_REPOSITORY_INTENT,
  RETAINED_REPOSITORY_VERSION,
  matchesRetainedEvidence,
  parseRetainedRepositoryIntent,
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
  /**
   * Where this operation sits in its lane.
   *
   * Counted by the entry as it attempts operations, so a resume that attempts
   * the same ones in the same order arrives at the same numbers — which is
   * what lets a replayed intent carry the identity it was written under.
   */
  readonly position: number;
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
  /**
   * The intent this request left unresolved, when it left one.
   *
   * Found by the request's own fingerprint rather than by the whole record's
   * digest. The digest covers the state the operation observed, and on a resume
   * the observed state is the very thing in question — looking the saved intent
   * up by it would miss exactly the interrupted operation that already ran.
   */
  pending(fingerprint: string): RetainedRepositoryIntent | undefined;
  /**
   * The result this request already produced, when it produced one.
   *
   * A finished operation is not re-decided. Its records stand, and the state
   * they describe is the state it left *then* — a later operation has moved
   * the checkout since, and holding a finished selection to the snapshot it
   * recorded would refuse every entry that went on to do anything.
   */
  completed(fingerprint: string): CompletedOperation | undefined;
}

/** One finished operation, as its own records describe it. */
export interface CompletedOperation {
  readonly intent: RetainedRepositoryIntent;
  readonly result: Json;
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
export function retain(
  operation: RetainedOperation,
  resume: RetainedResume,
  lanes: RetainedLanes,
): Operation<Result<Json>> {
  // Scoped to this one operation, so the lane it takes is released when the
  // operation ends rather than when its caller does. A selection that held the
  // lane for the whole of the mutation it was selecting for would be waiting
  // for itself.
  return scoped(() => retained(operation, resume, lanes));
}

function* retained(
  operation: RetainedOperation,
  resume: RetainedResume,
  lanes: RetainedLanes,
): Operation<Result<Json>> {
  // Held from the first inspection through the last acknowledgement. Two
  // mutations over one shared Git directory would otherwise each predict a
  // transition from a state the other was about to leave.
  yield* lanes.enter(operation.common);

  const fingerprint = yield* retainedRepositoryRequestFingerprint({
    owner: operation.owner,
    site: operation.site,
    operation: operation.operation,
    selection: operation.selection,
    request: operation.request,
  });

  // An interrupted operation is resumed from what it saved, never from what is
  // observed now: the saved request is this request, so the preparation it
  // froze is the one already decided on. Preparing again would predict a
  // transition from whatever state the interruption left behind.
  // A finished operation replays its own records and answers with what it
  // produced. Nothing is inspected, nothing is performed, and the state it
  // recorded is not a precondition on anything that comes after it.
  const done = resume.completed(fingerprint);
  if (done !== undefined) {
    yield* record(
      RETAINED_REPOSITORY_INTENT,
      fingerprint,
      operation,
      retainedRepositoryIntentJson(done.intent),
    );
    return yield* acknowledge(
      done.intent,
      fingerprint,
      operation,
      done.result,
      done.intent.postState,
    );
  }

  const saved = resume.pending(fingerprint);
  const written =
    saved === undefined ? yield* prepared(operation) : Ok(retainedRepositoryIntentJson(saved));
  if (!written.ok) {
    return written;
  }

  // Appended whether it is new or replayed. The stream matches by position, so
  // an operation that skipped its own intent on a resume would put its
  // completion where the intent belongs.
  const stored = yield* record(RETAINED_REPOSITORY_INTENT, fingerprint, operation, written.value);
  const intent = parseRetainedRepositoryIntent(stored);
  if (intent === undefined) {
    return Err(
      new RetainedOperationError(
        `the retained intent for "${operation.operation}" is not one this host can read.`,
      ),
    );
  }

  const standing = yield* operation.inventory();
  if (!standing.ok) {
    return standing;
  }
  const transition: PreparedTransition = {
    postState: intent.postState,
    prepared: intent.prepared,
    evidence: intent.evidence,
  };

  // Its predicted state means the work already happened, which is also what a
  // selection that changes nothing looks like. Its saved state means the work
  // did not happen and may now be performed from the inputs it froze. Anything
  // else is a checkout something else has been in, and nothing here repairs it.
  if (sameRetainedFrontier(standing.value, intent.postState)) {
    return yield* acknowledge(intent, fingerprint, operation, intent.evidence, intent.postState);
  }
  if (!sameRetainedFrontier(standing.value, intent.preState)) {
    return Err(
      new FrontierError(
        `"${operation.operation}" found a state its intent neither started from nor predicted, ` +
          "so what happened to this checkout is not recorded here.",
      ),
    );
  }

  const produced = yield* operation.perform(transition);
  if (!produced.ok) {
    return produced;
  }
  // The result and the state are both proven before anything is written down:
  // a nonzero exit proves neither, and neither does a plausible-looking one.
  if (!matchesRetainedEvidence(produced.value, intent.evidence)) {
    return Err(
      new RetainedOperationError(
        `"${operation.operation}" produced a result its intent did not predict.`,
      ),
    );
  }
  const settled = yield* operation.inventory();
  if (!settled.ok) {
    return settled;
  }
  if (!sameRetainedFrontier(settled.value, intent.postState)) {
    return Err(
      new FrontierError(
        `"${operation.operation}" left the checkout in a state its intent did not predict.`,
      ),
    );
  }
  return yield* acknowledge(intent, fingerprint, operation, produced.value, settled.value);
}

/**
 * A fresh intent, decided before anything is touched.
 *
 * The preparation is held to having changed nothing, which this checks rather
 * than trusts: a prediction that moved the checkout would have moved the very
 * state its own intent is about to claim it started from.
 */
function* prepared(operation: RetainedOperation): Operation<Result<Json>> {
  const before = yield* operation.inventory();
  if (!before.ok) {
    return before;
  }
  const transition = yield* operation.prepare(before.value);
  if (!transition.ok) {
    return transition;
  }
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
  return Ok(
    retainedRepositoryIntentJson({
      version: RETAINED_REPOSITORY_VERSION,
      owner: operation.owner,
      site: operation.site,
      operation: operation.operation,
      lane: { common: operation.common, position: operation.position },
      selection: operation.selection,
      request: operation.request,
      fingerprint: yield* retainedRepositoryRequestFingerprint({
        owner: operation.owner,
        site: operation.site,
        operation: operation.operation,
        selection: operation.selection,
        request: operation.request,
      }),
      prepared: transition.value.prepared,
      preState: before.value,
      postState: transition.value.postState,
      evidence: transition.value.evidence,
    }),
  );
}

/**
 * Write the completion down, and only then answer.
 *
 * Returning before the append was acknowledged would let the document go on
 * while the only record of this mutation was still in memory.
 */
function* acknowledge(
  intent: RetainedRepositoryIntent,
  fingerprint: string,
  operation: RetainedOperation,
  result: Json,
  frontier: RetainedFrontier,
): Operation<Result<Json>> {
  const identity = yield* retainedRepositoryIntentIdentity(intent);
  yield* record(
    RETAINED_REPOSITORY_COMPLETION,
    fingerprint,
    operation,
    retainedRepositoryCompletionJson({
      version: RETAINED_REPOSITORY_VERSION,
      owner: intent.owner,
      site: intent.site,
      intent: identity,
      fingerprint: intent.fingerprint,
      result,
      frontier,
    }),
  );
  return Ok(result);
}

/**
 * One record, under a name derived from what it is a record of.
 *
 * The name is a domain-separated tuple of the owner, the request's own
 * fingerprint, the operation and the phase. The fingerprint rather than the
 * whole record's digest, because the record holds the state the operation
 * observed and a resume observes a different one — a name that moved with the
 * state would not be the name the first attempt wrote.
 */
function* record(
  phase: string,
  fingerprint: string,
  operation: RetainedOperation,
  value: Json,
): Operation<unknown> {
  const name = canonicalJson([
    "retained-repository",
    phase,
    operation.owner,
    fingerprint,
    operation.operation,
  ]);
  // Whatever comes back is journal data on a replay, so it is handed on as the
  // unknown it is and parsed by the caller.
  return yield createDurableOperation<Json>(
    { type: phase, name },
    // deno-lint-ignore require-yield
    function* () {
      return value;
    },
  );
}

/** The intents one admitted history left unresolved, by their request. */
export function retainedResume(
  pending: readonly { readonly intent: RetainedRepositoryIntent }[],
  completed: readonly {
    readonly intent: RetainedRepositoryIntent;
    readonly completion: { readonly result: Json };
  }[] = [],
): RetainedResume {
  const unresolved = new Map(pending.map((effect) => [effect.intent.fingerprint, effect.intent]));
  const finished = new Map(
    completed.map((effect) => [
      effect.intent.fingerprint,
      { intent: effect.intent, result: effect.completion.result },
    ]),
  );
  return {
    pending: (fingerprint) => unresolved.get(fingerprint),
    completed: (fingerprint) => finished.get(fingerprint),
  };
}
