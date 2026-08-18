/**
 * Ending a durable wait with a value somebody delivered.
 *
 * A wait has two durable halves. The request says what is awaited and is
 * published the moment the document asks; the **answer** says what ended it and
 * is published only when one really did. Both are ordinary journal events, so a
 * resumed execution that already received its answer replays it rather than
 * asking for a second one — which is what makes an answered wait a step in a
 * procedure rather than a question repeated at every resume.
 *
 * ## Why the answer is its own durable operation
 *
 * The alternative — enter the wait, then append an event afterwards — has no
 * position in the journal, so replay could not tell an answered wait from an
 * unanswered one. As a durable operation it has a position of its own, directly
 * behind the request, and replay restores its recorded value without reaching
 * the live controller at all.
 *
 * ## Publication is the provider's, inside the provider's transaction
 *
 * Retained delivery state and the answer event have to move together: an answer
 * consumed without an event would be lost, and an event published without the
 * consumption could be delivered twice. Neither is something this module can
 * arrange, because only the host that keeps the run has its transaction. So the
 * live path hands the publication to whoever owns that state and returns only
 * what came back through it — the same shape the Workspace effect uses, without
 * the Workspace.
 *
 * The route to that owner is a private registration rather than a contextual
 * value anybody can read. A name is selection, and a publication capability
 * reachable by name would let document code publish an answer to its own wait.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { ensure, type Operation, suspend } from "effection";
import {
  type ActivateDurabilityFailure,
  createDurableOperation,
  type DurableEffect,
  type EffectDescription,
  type Json,
  type JournalProvenance,
  type LiveDurableOperationCoordinator,
  type Result,
} from "@executablemd/durable-streams";
import { WorkflowSuspensionRequestError, type WorkflowSuspensionRequest } from "./api.ts";

/** The effect type one delivered answer is retained under. */
export const SUSPENSION_ANSWER = "suspension_answer";

/** What a live answer publication is given, and what it may do with it. */
export interface SuspensionAnswerAuthority {
  /** The wait being answered, as this run derives it. */
  readonly suspensionId: string;
  /** What that wait asked for, and what shape an answer takes. */
  readonly request: WorkflowSuspensionRequest;
  /** The journal this effect publishes through, for the owner to recognize. */
  readonly journalProvenance: JournalProvenance | undefined;
  /**
   * Publish the durable answer Yield carrying this value.
   *
   * Called inside the owner's own transaction, so the event and whatever
   * retained state it consumes commit together or not at all.
   */
  publish(value: Json): Operation<void>;
}

/** Whoever keeps a run's retained delivery state. */
export interface SuspensionAnswerProvider {
  /**
   * The value that ends this wait, already published, or nothing when none is
   * retained.
   *
   * Returning a value without having published it is a defect rather than an
   * answer, and is refused: what makes a wait over is the event, not the
   * return.
   */
  claim(authority: SuspensionAnswerAuthority): Operation<Json | undefined>;
}

/** A live answer publication that did not happen the way its contract says. */
export class SuspensionAnswerPublicationError extends WorkflowSuspensionRequestError {
  override name = "SuspensionAnswerPublicationError";
}

interface AnswerCoordinationApi {
  readonly provider: object | undefined;
}

const AnswerCoordination: Api<AnswerCoordinationApi> = createApi<AnswerCoordinationApi>(
  "executablemd.workflow.suspension.answer",
  { provider: undefined },
);

/**
 * The providers this module has registered, keyed by an opaque selection.
 *
 * Module-private and keyed by identity, so what travels through the contextual
 * name is a token and never the capability. A fabricated selection resolves to
 * nothing, and a registration closed with its scope stops resolving at all.
 */
const answerProviders = (() => {
  const providers = new WeakMap<object, { open: boolean; provider: SuspensionAnswerProvider }>();

  return {
    register(provider: SuspensionAnswerProvider): { selection: object; close: () => void } {
      const selection = Object.freeze({});
      const registration = { open: true, provider };
      providers.set(selection, registration);
      return {
        selection,
        close(): void {
          registration.open = false;
          providers.delete(selection);
        },
      };
    },

    get(selection: object | undefined): SuspensionAnswerProvider | undefined {
      if (selection === undefined) {
        return undefined;
      }
      const registration = providers.get(selection);
      return registration?.open ? registration.provider : undefined;
    },
  };
})();

/**
 * Install the owner of this run's retained delivery state for the current scope.
 *
 * `{ at: "min" }` for the reason every provider here uses it: middleware at the
 * default position runs outermost, so an outer scope's registration would be
 * selected ahead of the one installed nearer the run.
 */
export function* useSuspensionAnswerProvider(provider: SuspensionAnswerProvider): Operation<void> {
  const registration = answerProviders.register(provider);
  yield* ensure(registration.close);
  yield* AnswerCoordination.around({ provider: () => registration.selection }, { at: "min" });
}

function describeAnswer(id: string): EffectDescription {
  return { type: SUSPENSION_ANSWER, name: id, suspensionId: id };
}

/**
 * The wait's answer: replayed when one was published, claimed when one is
 * retained, and otherwise the wait itself.
 *
 * `enter` is the public composable route into the wait. It is reached only when
 * no answer is retained, and nothing it returns is an answer — a value arriving
 * from it means some handler stood between this operation and the controller,
 * so the operation does what an unentered wait is and stops.
 */
export function suspensionAnswerEffect(
  id: string,
  request: WorkflowSuspensionRequest,
  enter: () => Operation<Json>,
): DurableEffect<Json> {
  return createDurableOperation<Json>(describeAnswer(id), enter, {
    coordinator: answerCoordinator(id, request),
  });
}

function answerCoordinator(
  id: string,
  request: WorkflowSuspensionRequest,
): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: Result) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
      journalProvenance: JournalProvenance | undefined,
    ): Operation<Result> {
      const provider = answerProviders.get(yield* AnswerCoordination.operations.provider);
      if (provider !== undefined) {
        const claimed = yield* claimRetainedAnswer(
          provider,
          id,
          request,
          publish,
          activateFailure,
          journalProvenance,
        );
        if (claimed !== undefined) {
          return claimed;
        }
      }

      yield* execute();

      // Reaching this line means the route answered, and nothing may: an answer
      // is a published event, and no event was published. A value here came
      // from a handler standing between this operation and the controller.
      //
      // The wait therefore goes unentered, and this operation does what an
      // unentered wait is — it stops. Raising would not do: an ordinary error
      // is something the document can catch, and a caught suspension is a
      // document continuing past a wait it asked for and did not get.
      yield* suspend();
      throw new WorkflowSuspensionRequestError("a suspended execution resumed itself.");
    },
  };
}

function* claimRetainedAnswer(
  provider: SuspensionAnswerProvider,
  id: string,
  request: WorkflowSuspensionRequest,
  publish: (result: Result) => Operation<void>,
  activateFailure: ActivateDurabilityFailure,
  journalProvenance: JournalProvenance | undefined,
): Operation<Result | undefined> {
  let published: Result | undefined;
  let open = true;

  const authority: SuspensionAnswerAuthority = Object.freeze({
    suspensionId: id,
    request,
    journalProvenance,
    *publish(value: Json): Operation<void> {
      if (!open || published !== undefined) {
        throw new SuspensionAnswerPublicationError(
          "the live answer publication is completed, stale, or already consumed.",
        );
      }
      const result: Result = { status: "ok", value };
      yield* publish(result);
      published = result;
    },
  });

  try {
    const claimed = yield* provider.claim(authority);
    if (claimed === undefined) {
      if (published !== undefined) {
        throw new SuspensionAnswerPublicationError(
          "the selected answer provider published an answer and then reported none.",
        );
      }
      return undefined;
    }
    if (published === undefined) {
      throw new SuspensionAnswerPublicationError(
        "the selected answer provider omitted its durable publication.",
      );
    }
    return published;
  } catch (error) {
    // Deliberately not "it was published, so the wait is over". The append
    // happened inside the provider's own transaction, and a transaction that
    // did not commit took it back — so an offered publication proves nothing.
    // What proves a wait ended is the provider returning the value, which its
    // contract lets it do only once that transaction has committed.
    throw activateFailure(error);
  } finally {
    open = false;
  }
}
