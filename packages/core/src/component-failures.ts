/**
 * Continuing after a function component fails (spec §6.9).
 *
 * A component that fails fails the operation it is part of, like any other
 * Effection work. Carrying on instead is a decision somebody makes: either the
 * component says so about itself with `printErrors()`, or a document says so
 * about a region with `<PrintErrors>`. Both install the boundary through
 * `usePrintErrors()`, so "the nearest printing boundary handles it" is one rule
 * rather than two.
 *
 * A boundary sets `print` for its region and turns a propagating failure into
 * one printed error. Both halves are the same decision: the region prints, and
 * a failure that reaches the boundary is what gets printed.
 */

import { Component, raise } from "./component-api.ts";
import { attributeCause, ErrorMode } from "./errors.ts";
import type { ComponentFailure, ErrorSegment, FunctionComponent } from "./types.ts";
import type { Operation } from "effection";

/**
 * The declaration a component wears to say it continues after failing.
 *
 * This is the one thing about a component that is not run state. `printErrors(fn)`
 * runs while a component module is evaluated — outside any operation, with no run
 * to own a table and no scope to reach — and what it records is what an author
 * declared about a function the author owns. So it lives on that function, which
 * is where its lifetime already is.
 *
 * The stable string key lets another loaded copy recognise the declaration when
 * a bundled core receives a function marked by an installed core, or vice
 * versa. It is non-enumerable, so a component that is copied, wrapped, or
 * inspected does not carry it along by accident. Identity still carries the
 * declaration: a repository component that happens to share a registered
 * component's name is a different function object and inherits nothing.
 */
const PRINTS_ERRORS = "executablemd.core.printsErrors";

/**
 * Continue after this component fails, reporting the failure as a printed error.
 *
 * The component is returned unchanged — declaring is marking, not wrapping — so
 * its identity and type survive:
 *
 * ```ts
 * export default printErrors(function* (props) {
 *   // body, requested content, retained work and teardown are all inside
 * });
 * ```
 *
 * The boundary is outside the whole invocation, so a failure while the
 * invocation is being dismantled is printed too, and content the component
 * projects is inside it.
 */
export function printErrors<T extends FunctionComponent>(component: T): T {
  Object.defineProperty(component, PRINTS_ERRORS, { value: true, enumerable: false });
  return component;
}

export function printsErrors(component: FunctionComponent): boolean {
  return Object.getOwnPropertyDescriptor(component, PRINTS_ERRORS)?.value === true;
}

/**
 * Print this region's errors, and report an invocation failure as one printed
 * error instead of failing the operation.
 *
 * The mode is a context value, so it governs by lexical structure and nothing
 * more: a region nested inside this one that chooses its own — an `<Output>`
 * region in a component invoked here — shadows it, and what happens inside that
 * region is the same whether or not this boundary is written around it.
 *
 * `throw` is the one mode this does not replace. Documentation and value roots
 * render nothing, so a printed error there is a printed error nobody can read,
 * and the failure stays a failure (§6.9).
 *
 * The middleware is terminal: it answers rather than delegating, so the nearest
 * boundary is the one that handles a failure and an enclosing one never sees it
 * again. The original failure is attributed as the printed error's cause, so
 * what the component actually did remains reachable from the outside.
 */
export function* usePrintErrors(): Operation<void> {
  if ((yield* ErrorMode.get()) !== "throw") {
    yield* ErrorMode.set("print");
  }
  yield* Component.around({
    *handleFailure([failure], _next): Operation<ErrorSegment> {
      const segment: ErrorSegment = {
        type: "error",
        message: `Function component ${failure.name} error: ${failure.error.message}`,
        source: failure.name,
      };
      yield* attributeCause(segment, failure.error);
      return yield* raise(segment);
    },
  });
}
