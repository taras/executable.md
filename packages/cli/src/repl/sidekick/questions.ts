/**
 * The Sidekick's own questions, and how one reaches the response that asked it.
 *
 * A reply may write canonical paired `<Elicit>`, so a Sidekick question is the
 * same element an authored document writes and the same component Core runs.
 * Nothing here implements it, re-presents it or judges an answer: the form this
 * REPL draws, the bounded schema language it accepts, Core's compiler, Core's
 * validator and Core's durable answer are all `useReplElicitation()`'s and
 * `<Elicit>`'s already. This module does the two things that are actually the
 * Sidekick's.
 *
 * ## One: the question belongs to the conversation, not to the entry
 *
 * The provider is installed in the *owner's* scope. A conversation is held open
 * by a task in that scope and a reply's root is evaluated inside that
 * conversation's own execution, so a provider installed here is the one the
 * response reaches — while an entry's questions keep reaching the session's,
 * which is installed in the session's scope and dies with it. Two owners, two
 * pending questions, two answers, and neither can take the other's: a person
 * answering an entry's question has not answered the Sidekick's, and Stop
 * withdraws one without touching the other.
 *
 * ## Two: an answer is an operation result, so it is journaled
 *
 * Every designated control's answer is read back out of the records it was
 * retained in, which is what makes a delivery what the history holds rather
 * than what a collector remembered. `<Elicit>` is designated — its validated
 * answer is what the reply asked for — so its invocation needs the same
 * intent/outcome pair every other control writes.
 *
 * It cannot get one the ordinary way. Every other control is a definition this
 * CLI wrote, so `performed()` wraps its body; this one is *Core's* definition,
 * selected by name, and wrapping it is exactly what the canonical
 * grant forbids. The one piece of this CLI's code in an `<Elicit>` invocation
 * is the provider it asks — so the pair is written there, as ordinary
 * middleware in the band *outside* the implementation installed at `min`. That
 * is a journal of operation feedback, which every control has; it is not a
 * second question journal, and the answer's own durability stays
 * `persistElicitation()`'s.
 *
 * The pair is written exactly where the facts are. The intent goes down before
 * anybody is asked, so a question waiting when a process stops is readable as
 * an operation that began and whose result nobody knows — which is what an
 * interrupted question *is*. The outcome goes down when the asking returns or
 * throws, and on a halt neither runs: an answer nobody gave is not written, and
 * a withdrawn question leaves its intent standing with nothing beside it.
 *
 * ## Which response a question belongs to
 *
 * Journals are per response, and the provider is installed once for the owner's
 * whole lifetime — so which journal a question goes to is state rather than
 * lexical. It has to be: a reply's root runs inside the *conversation's*
 * execution rather than in the scope that asked for the evaluation, so a
 * wrapper installed around the call would not be in the chain the question
 * crosses. `answering()` is the seam, and the ownership it establishes is
 * total: one conversation runs one turn, one turn evaluates one root, and a
 * question asked with no response in flight is refused rather than filed under
 * a guess.
 */

import { ensure, Ok, scoped } from "effection";
import type { Operation } from "effection";
import { Elicitation, ElicitationProviderError } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";

import { useReplElicitation } from "../elicitation.ts";
import type { ReplElicitations } from "../elicitation.ts";
import { ELICIT_CONTROL } from "./controls.ts";
import type { ControlJournal, SidekickDestinations } from "./controls.ts";

/** The Sidekick's questions, and the seam that files each one. */
export interface SidekickAsking {
  /**
   * The pending question and its changes, for whoever draws it.
   *
   * The Sidekick's own, separate from `ReplSession.elicitation` by
   * construction rather than by a rule: they are two providers in two scopes.
   */
  readonly questions: ReplElicitations;
  /**
   * Run one response's evaluation with its questions filed under its journal.
   *
   * Scoped, so the previous journal is restored however the work ends —
   * including a Stop that halts it mid-question.
   */
  answering<T>(journal: ControlJournal, work: () => Operation<T>): Operation<T>;
}

/**
 * Install this Sidekick's question owner on the calling scope.
 *
 * Two installations in one scope, in two bands. The journal is ordinary
 * middleware, which runs outermost; the presenter goes in at `min`, which is
 * the implementation slot. So a question crosses the journal and then reaches
 * the form — and a provider an outer scope installed is still shadowed by this
 * one, because a nearer `min` precedes an inherited one.
 */
export function* useSidekickQuestions(
  /**
   * This conversation's destinations, so a queried question presents what it
   * selected.
   *
   * Canonical `<Elicit>` is core's own body, so the occurrence lookup a control
   * uses is unreachable from inside it. Core names the occurrence it is
   * dispatching on that body's own scope instead, and this asks for it from
   * where the asking happens — which is what lets the intent carry its
   * marker, and what keeps two questions that are open at once from taking
   * each other's receiver.
   */
  destinations?: SidekickDestinations,
): Operation<SidekickAsking> {
  /** The response being evaluated right now, and therefore asking. */
  let current: ControlJournal | undefined;

  yield* Elicitation.around({
    *elicit([request]: [ElicitationRequest], next) {
      const journal = current;
      if (journal === undefined) {
        // Fails closed, and before anybody is asked. A question whose answer
        // has nowhere to be recorded is a question the reply that asked it
        // would never be told the answer to, so asking it would waste a
        // person's attention on an answer that goes nowhere.
        throw new ElicitationProviderError(
          "this Sidekick asks questions on behalf of a reply it is evaluating, and it is " +
            "evaluating none — so there is no response for an answer to belong to.",
        );
      }
      // Asked for from inside the body that is asking, before anybody is
      // asked: the occurrence is read from this call's own scope, so it is
      // this question's. A question asked inside another question's content
      // therefore reaches its own receiver, the enclosing question still
      // reaches its own when its body resumes, and a question asked from one
      // admitted branch reaches its own while another branch's question is
      // still waiting to be answered.
      const mine = destinations === undefined ? undefined : yield* destinations.running();
      const selecting = mine?.query !== undefined;
      // Before the asking. A question waiting when a process stops has an
      // intent and no outcome, which is exactly what an interrupted operation
      // looks like everywhere else in this history — and a queried one carries
      // its marker from here, so an interrupted selection is readable as a
      // selection that was owed rather than as a question nobody queried.
      const order = yield* journal.began(
        {
          component: ELICIT_CONTROL,
          // The rendered request and nothing else. The schema is the reply's own
          // and the answer is retained by the outcome below; what a person or a
          // later process needs from the intent is which question was open.
          arguments: { message: request.message },
        },
        undefined,
        selecting ? "selected-v1" : undefined,
      );
      let answer: unknown;
      try {
        answer = yield* next(request);
      } catch (error) {
        // A schema this surface cannot draw, or a failure above. The reply is
        // told, because it wrote the schema and the refusal says what the form
        // language accepts. Nothing is filed: a question that was never
        // answered has no selected value, and the marked intent standing
        // without a presentation is what says so.
        const failure = error instanceof Error ? error : new Error(String(error));
        yield* journal.settled(order, { ok: false, error: failure });
        throw failure;
      }
      // Deliberately not in a `finally`. A halted question resolved nothing, so
      // writing an outcome for it would manufacture one — an interruption is
      // the absence of a completed operation rather than a receipt saying so.
      //
      // The original answer is retained whole here, whatever the expression
      // later selects out of it: the outcome is what the person actually said.
      yield* journal.settled(order, Ok(answer), answer as Json);
      // Filed only after a successful original outcome, exactly as a control's
      // own route files: the destination then presents the selected value, and
      // what goes back as feedback is that presentation rather than the answer.
      if (selecting) {
        mine?.file(order);
      }
      return answer;
    },
  });

  // No waits reading. `ReplWaits` counts what an *entry* is held on, and a
  // Sidekick question holds no entry: it holds the response that asked it.
  const questions = yield* useReplElicitation();

  return {
    questions,
    answering<T>(journal: ControlJournal, work: () => Operation<T>): Operation<T> {
      return scoped(function* () {
        const previous = current;
        current = journal;
        yield* ensure(() => {
          current = previous;
        });
        return yield* work();
      });
    },
  };
}
