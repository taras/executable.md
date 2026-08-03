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
import { attributeCause, markCaptured } from "./errors.ts";
import type { ComponentFailure, ErrorSegment, FunctionComponent } from "./types.ts";
import type { Operation } from "effection";

/**
 * Components that continue after failing, remembered by function identity.
 *
 * Identity rather than name: a repository component that happens to share a
 * registered component's name is a different function and inherits nothing.
 */
const capturing = new WeakSet<FunctionComponent>();

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
  capturing.add(component);
  return component;
}

export function capturesErrors(component: FunctionComponent): boolean {
  return capturing.has(component);
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
export function useFailures(): Operation<void> {
  return Component.around({
    *handleFailure([failure], _next): Operation<ErrorSegment> {
      const segment: ErrorSegment = {
        type: "error",
        message: `Function component ${failure.name} error: ${failure.error.message}`,
        source: failure.name,
      };
      attributeCause(segment, failure.error);
      return yield* raise(segment);
    },
    // Every diagnostic raised beneath the boundary is one the document asked to
    // carry on past, not only the ones translated from a component failure: a
    // region that captures errors captures the ones its own syntax reports too.
    // Marking here rather than in `handleFailure` keeps that a property of the
    // region, and delegating leaves the observation chain a single pass.
    *raise([segment], next): Operation<ErrorSegment> {
      markCaptured(segment);
      return yield* next(segment);
    },
  });
}
