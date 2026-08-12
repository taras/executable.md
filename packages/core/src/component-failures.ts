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
 *
 * The two differ over one thing, and it is who is speaking. `<PrintErrors>` is
 * written by the author of the region it encloses, so it decides everything
 * inside it. `printErrors(fn)` is written by the author of one component, who
 * owns what that component does and not what a caller wrote inside it — so a
 * failure of the projected content is passed outward instead (§6.8.1).
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
 * What an expansion is allowed to do about a checked command failure, and what
 * one already did to this run.
 *
 * Created by the execution and handed down through core's own calls. Neither
 * half is ambient: a document or component cannot read it, set it, or shadow
 * it, which is what keeps the outcome of a run something the document's own
 * text decides.
 *
 * `authorized` is granted only by an authored `<PrintErrors>` element, for the
 * work its region causes. Everywhere else a nonzero command records itself in
 * `failure` on the way out, and that record is what makes the failure survive
 * an enclosing boundary that would otherwise print it and continue —
 * `printErrors(fn)`, a built-in like `<TempDir>`, or a component catching the
 * `ContentError` its projected content raised. Those recover their own
 * failures; none of them may decide that a command which exited nonzero was
 * not a failure of the run.
 */
export interface CheckedFailures {
  /** Whether an authored `<PrintErrors>` region covers this work. */
  readonly authorized: boolean;
  /** The first unauthorized checked failure this run suffered, once it has. */
  failure?: ErrorSegment;
}

/** The ledger an execution starts with: no authority, nothing suffered yet. */
export function checkedFailureLedger(): CheckedFailures {
  return { authorized: false };
}

/**
 * The ledger for work a `<PrintErrors>` region causes: recovery is authorized,
 * so nothing it prints is a failure the run suffered.
 */
export function recoveringLedger(): CheckedFailures {
  return { authorized: true };
}

/**
 * The ledger for the body of a contained invocation.
 *
 * A fresh record with the inherited authority: a checked failure inside it
 * fails that invocation — which is how a test reports a failing test — and the
 * run's own record stays clear, so the tests after it still run and the testing
 * session's completion policy is what decides the run.
 */
export function containedLedger(inherited: CheckedFailures | undefined): CheckedFailures {
  return { authorized: inherited?.authorized ?? false };
}

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
 * invocation is being dismantled is printed too. What it does not cover is the
 * content a caller projected: that text is the caller's, and the region it is
 * written in decides what a failure of it means (§6.8.1).
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
 *
 * A boundary a component declared about itself has one thing it does not
 * decide: a failure of the content its caller wrote, arriving where that
 * caller's region does not print. `<PrintErrors>` re-declares the region it
 * encloses, so printing there resumes only what its own author gated; a
 * component declaration cannot re-declare the region it is invoked in, and
 * printing a failure into an `<Output>` region would resume exactly what that
 * region's author gated behind it. It is delegated outward instead.
 */
export function* usePrintErrors(declaredBy: "region" | "component" = "region"): Operation<void> {
  const site = (yield* ErrorMode.get()) ?? "print";
  if (site !== "throw") {
    yield* ErrorMode.set("print");
  }
  yield* Component.around({
    *handleFailure([failure], next): Operation<ErrorSegment> {
      if (declaredBy === "component" && failure.origin === "content" && site !== "print") {
        return yield* next(failure);
      }
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
