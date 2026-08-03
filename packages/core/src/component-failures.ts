/**
 * Continuing after a function component fails (spec §6.9).
 *
 * A component that fails fails the operation it is part of, like any other
 * Effection work. Carrying on instead is a decision somebody makes: either the
 * component says so about itself with `captureErrors()`, or a document says so
 * about a region with `<CaptureErrors>`. Both install the same middleware, so
 * "the nearest capture boundary handles it" is one rule rather than two.
 *
 * Capture turns a failure into a diagnostic and marks that diagnostic as one a
 * document asked for. It does not decide what happens to it — the caller's
 * ambient policy still settles it, so a captured failure renders inside an
 * `<Output>` region and still stops the document under documentation.
 */

import { Component, raise } from "./component-api.ts";
import { AmbientPolicyFrame, attributeCause, markCaptured } from "./errors.ts";
import type { ComponentFailure, ErrorSegment, FunctionComponent } from "./types.ts";
import type { Operation } from "effection";

/**
 * The brand a component wears to say it continues after failing.
 *
 * It sits on the function object itself, so the answer is the component's own
 * property rather than an entry in a table that outlives every run. Identity is
 * what carries it: a repository component that happens to share a registered
 * component's name is a different function object, wears no brand, and inherits
 * nothing.
 *
 * Not enumerable, so a component that is copied, wrapped, or inspected does not
 * carry the decision along by accident, and module-private rather than
 * `Symbol.for`, so nothing outside this module can forge the brand.
 *
 * This is the one mark that is not run state: `captureErrors(fn)` runs while a
 * component module is evaluated, outside any operation, and what it records is
 * what an author declared about a definition.
 */
const CAPTURES = Symbol("executablemd.core.capturesErrors");

/**
 * Continue after this component fails, reporting the failure as a diagnostic.
 *
 * The component is returned unchanged — marking is membership, not wrapping —
 * so its identity and type survive:
 *
 * ```ts
 * export default captureErrors(function* (props) {
 *   // body, requested content, retained work and teardown are all inside
 * });
 * ```
 *
 * The boundary is outside the whole invocation, so a failure while the
 * invocation is being dismantled is collected too, and content the component
 * projects is inside it.
 */
export function captureErrors<T extends FunctionComponent>(component: T): T {
  Object.defineProperty(component, CAPTURES, { value: true, enumerable: false });
  return component;
}

export function capturesErrors(component: FunctionComponent): boolean {
  return Object.hasOwn(component, CAPTURES);
}

/**
 * Report an invocation failure as one diagnostic instead of failing the
 * operation.
 *
 * Terminal: it answers rather than delegating, so the nearest boundary is the
 * one that handles a failure and an enclosing one never sees it again. The
 * original failure is attributed as the diagnostic's cause, so what the
 * component actually did remains reachable from the outside.
 */
function* markUnderOwnPolicy(boundary: object | undefined, segment: ErrorSegment): Operation<void> {
  if ((yield* AmbientPolicyFrame.get()) === boundary) {
    yield* markCaptured(segment);
  }
}

export function* useFailures(): Operation<void> {
  // The decision this boundary was opened under. A diagnostic raised under a
  // policy something nested chose for itself — a component's own `<Output>`
  // region — is not one this document asked to carry on past, and marking it
  // would resume work that region's author gated behind the failure.
  const boundary = yield* AmbientPolicyFrame.get();
  yield* Component.around({
    *handleFailure([failure], _next): Operation<ErrorSegment> {
      const segment: ErrorSegment = {
        type: "error",
        message: `Function component ${failure.name} error: ${failure.error.message}`,
        source: failure.name,
      };
      yield* attributeCause(segment, failure.error);
      // Marked here as well as in the `raise` middleware below: a diagnostic
      // this boundary built is one the document asked to carry on past, and a
      // provider's own call does not re-enter the middleware it is part of.
      // Under the same rule either way — a decision something nested made for
      // itself is not this boundary's to reverse.
      yield* markUnderOwnPolicy(boundary, segment);
      return yield* raise(segment);
    },
    // Every diagnostic raised beneath the boundary is one the document asked to
    // carry on past, not only the ones translated from a component failure: a
    // region that captures errors captures the ones its own syntax reports too.
    // Marking here rather than in `handleFailure` keeps that a property of the
    // region, and delegating leaves the observation chain a single pass.
    *raise([segment], next): Operation<ErrorSegment> {
      yield* markUnderOwnPolicy(boundary, segment);
      return yield* next(segment);
    },
  });
}
