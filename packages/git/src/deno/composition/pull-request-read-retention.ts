/**
 * What one admitted pull-request evidence read retains, and when it may say so
 * (specs/workflow-workspace-spec.md §7.7).
 *
 * The caller has already admitted the read — matched the request, held the
 * target to the host ceiling, and parsed the URL — so everything here describes
 * a question this run was permitted to ask. What this module owns is the rest:
 * the effect's description, the attempt the transport runs in, and the boundary
 * at which an answer becomes history.
 *
 * It is handed the normalized request, the source position its diagnostic
 * carries, and the operation that would perform the read. It obtains no owner
 * and performs no admission: who the read belongs to is the installing
 * profile's, which is what lets one recipe serve the Workflow policy that
 * derives its pair from a run and expansion and a caller that derives one
 * elsewhere.
 *
 * ## Validation is of what arrived
 *
 * The complete value the provider answered with is read before it is
 * serialized, because serializing first projects an envelope out of it and a
 * member the contract does not name would be dropped on the way rather than
 * refused. So the received object crosses the ordinary JSON boundary and the
 * record parser, and only the value that passed is written down.
 *
 * ## Publication follows teardown
 *
 * The transport opens an authentication session for the collection it reads,
 * and acknowledging the read before that session has closed would record work
 * whose resources were still open. The attempt therefore runs in a child scope
 * and its outcome is *held* across that scope's teardown: a success and a
 * failure alike are published once the child has finished unwinding, so the
 * journal describes work that is actually over.
 *
 * **What the body raised is the read's answer, whatever kind of error it is.**
 * Once the ceiling has admitted the read, a failure from here is this read's
 * own: the vocabulary's refusal, and equally an ordinary `Error` from the
 * credential operation or from opening the session. Each is retained as a
 * failed read, because the journal is where a continuation restores that answer
 * from — withholding it would let a resumed execution open the session and ask
 * the host again. The retained outcome is not restricted to one error class.
 *
 * Two failures are not answers. Teardown that fails raises from the child
 * instead, before anything held is acted on, so it activates the run's existing
 * fail-stop state and publishes neither the success nor the failure the attempt
 * had already decided. And a durability failure — recognized by class against
 * the failure types durable-streams exports — says the journal no longer
 * describes this execution, so it keeps that state and its first cause rather
 * than becoming a read outcome. Cancellation stays cancellation: a halted child
 * unwinds without raising, so nothing is held and nothing is published.
 */

import {
  ContinuePastCloseDivergenceError,
  createDurableOperation,
  DivergenceError,
  DurablePersistenceError,
  serializeError,
  StaleInputError,
  TerminalDivergenceError,
} from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  EffectDescription,
  Json as DurableJson,
  LiveDurableOperationCoordinator,
  Result as DurableResult,
} from "@executablemd/durable-streams";
import { Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { sourceDescription } from "@executablemd/core";
import type { SourcePosition } from "@executablemd/core";
import { PullRequestReadError } from "../../composition/errors.ts";
import {
  parseCompletePullRequestReadResult,
  pullRequestReadEnvelopeJson,
  pullRequestReadRequestJson,
} from "../../composition/pull-request-read-records.ts";
import type {
  PullRequestReadKind,
  PullRequestReadRequest,
  PullRequestReadResult,
} from "../../composition/pull-request-read-records.ts";
import { gitOperationFingerprint } from "./operations.ts";

/** The durable effect type one evidence read is retained under. */
export const PULL_REQUEST_READ = "pull_request_read";

/** Which element a refusal names, by the collection it was reading. */
const ELEMENT: Readonly<Record<PullRequestReadKind, string>> = Object.freeze({
  reviews: "<PullRequest.Reviews>",
  comments: "<PullRequest.Comments>",
  checks: "<PullRequest.Checks>",
});

/**
 * The effect one question reduces to.
 *
 * The run is in the retained request, and deliberately not in this fingerprint.
 * A fork is a different run reaching the same position with the same question,
 * and a name that carried the run would make every inherited read a different
 * effect — which is to say, unforkable. What the name has to separate is
 * different *questions*, and the four members below are what a question is made
 * of.
 */
function describeRead(
  request: PullRequestReadRequest,
  position: Readonly<SourcePosition> | undefined,
): EffectDescription {
  const configuration = gitOperationFingerprint([
    request.operation,
    request.url,
    request.provider,
    request.kind,
  ]);
  return {
    type: PULL_REQUEST_READ,
    name: `${request.expansionId}:${configuration}`,
    input: pullRequestReadRequestJson(request),
    configuration,
    ...sourceDescription(position),
  };
}

/**
 * Retain one admitted read, or restore what is already retained.
 *
 * Everything from here is durable: a transport or evidence failure retains the
 * failed read, and a completed one restores its snapshot without opening a
 * session or reaching the network.
 */
export function retainPullRequestRead(
  request: PullRequestReadRequest,
  position: Readonly<SourcePosition> | undefined,
  transport: () => Operation<PullRequestReadResult>,
): Operation<PullRequestReadResult> {
  const element = ELEMENT[request.kind];

  return scoped(function* () {
    const stored = yield createDurableOperation<DurableJson>(
      describeRead(request, position),
      function* (): Operation<DurableJson> {
        // The whole value the provider answered with, read before anything
        // projects an envelope out of it.
        return pullRequestReadEnvelopeJson(
          validated(
            yield* transport(),
            request.kind,
            element,
            "the selected provider answered with a value that is not the evidence that read " +
              "produces.",
          ),
        );
      },
      { coordinator: joinedReadCoordinator },
    );

    return validated(
      stored,
      request.kind,
      element,
      "what this run retained for it is not the evidence that read produces.",
    );
  });
}

/** The complete evidence this value describes, or the refusal it is not. */
function validated(
  value: unknown,
  kind: PullRequestReadKind,
  element: string,
  sentence: string,
): PullRequestReadResult {
  const result = parseCompletePullRequestReadResult(value, kind);
  if (result === undefined) {
    throw new PullRequestReadError("protocol", element, sentence);
  }
  return result;
}

/**
 * The live boundary one retained read publishes through.
 *
 * The default coordinator publishes from the same task the body ran in, so the
 * session the transport opened is still open when the append is acknowledged.
 * Here the body runs in a child scope and its outcome is held across that
 * scope's teardown, so an acknowledged read describes work whose resources have
 * finished.
 *
 * **A failure the body raised is this read's own outcome.** Whatever an admitted
 * transport raises after the ceiling has let it through — the read vocabulary's
 * own refusal, and equally an ordinary `Error` from the credential operation or
 * from opening the session — is a failed read, held across cleanup and then
 * published as one. The journal is what a continuation restores that answer
 * from, so withholding it would let a resumed execution reacquire the session
 * and ask again.
 *
 * Only a durability failure is treated otherwise, and it is recognized the way
 * every durability failure is: by class, against the failure types
 * durable-streams exports. Such a failure says the journal no longer describes
 * this execution, so it keeps the existing fail-stop state and its first cause
 * rather than being serialized as a refusal the provider never gave.
 */
const joinedReadCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends DurableJson>(
    execute: () => Operation<T>,
    publish: (result: DurableResult) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
  ): Operation<DurableResult> {
    let held: Result<T>;
    try {
      held = yield* scoped(function* (): Operation<Result<T>> {
        return yield* trapped(execute);
      });
    } catch (error) {
      // The child raised rather than returning, so this is its teardown and not
      // an answer: every cleanup failure is fatal and publishes nothing.
      throw activateFailure(error);
    }

    if (!held.ok) {
      const fatal = durabilityFailure(held.error);
      if (fatal !== undefined) {
        throw activateFailure(fatal);
      }
      const refused: DurableResult = { status: "err", error: serializeError(held.error) };
      yield* publish(refused);
      return refused;
    }

    const answered: DurableResult = { status: "ok", value: held.value };
    yield* publish(answered);
    return answered;
  },
};

/**
 * The durability failure this body error carries, or `undefined` for a read
 * outcome.
 *
 * The classes are durable-streams' own exported failure types, and the search
 * reaches causes and aggregate members because a persistence failure arrives
 * wrapped in its own cause: nothing a failure is wrapped in may keep one from
 * being found.
 *
 * **The read's own refusal is excluded from the selection, not from the walk.**
 * `PullRequestReadError` extends `StaleInputError` so that an ambient printing
 * boundary cannot render unread evidence as an empty review, and that
 * inheritance is a statement about rendering rather than about whether the
 * journal still describes this execution — so selecting it would make every
 * ordinary refusal fatal. Treating it as a leaf is the opposite mistake: a
 * refusal that carries a genuine durability failure as its cause would publish
 * as an ordinary failed read and discard the cause before anything could find
 * it. So the node is skipped for selection and its descendants are still
 * enqueued, wherever in the graph it appears.
 */
function durabilityFailure(error: Error): Error | undefined {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.shift();
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (
      !(current instanceof PullRequestReadError) &&
      (current instanceof DurablePersistenceError ||
        current instanceof StaleInputError ||
        current instanceof DivergenceError ||
        current instanceof TerminalDivergenceError ||
        current instanceof ContinuePastCloseDivergenceError)
    ) {
      return current;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return undefined;
}

/**
 * The attempt's own outcome as a value, so teardown happens before it is acted
 * on.
 *
 * Only a raised failure is caught. Cancellation unwinds a coroutine rather than
 * raising into it, so a halted attempt produces no held outcome at all and this
 * never returns.
 */
function* trapped<T>(execute: () => Operation<T>): Operation<Result<T>> {
  try {
    return Ok(yield* execute());
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}
