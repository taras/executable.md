/**
 * The component invocation boundary (spec §4.4).
 *
 * Every Markdown and TypeScript component invocation is a resource scope.
 * Authors acquire resources with ordinary Effection operations; the boundary
 * decides when they are released, and guarantees that content projected into
 * the component has stopped completely before that happens.
 *
 * The shape:
 *
 *     withInvocation()
 *     └─ scoped invocation frame
 *        ├─ evalHost                 → EvalScope A: persist eval / daemon anchor
 *        │  └─ bodyHost              → the component body, its resources and middleware
 *        │     └─ content host       → EvalScope C: everything projected content creates
 *        └─ ordered teardown ensure
 *
 * A is created on the invocation's own frame and the body runs inside it, so
 * one context chain carries the expansion providers down to projected content
 * and persistent middleware back up. The body is a child task of A's loop task,
 * not the loop itself, so `A.eval(...)` never deadlocks against it.
 */

import { ensure, scoped, spawn, suspend, useScope, withResolvers } from "effection";
import type { Operation, Scope, Task } from "effection";
import { useEvalScope } from "@effectionx/scope-eval";
import type { EvalScope } from "@effectionx/scope-eval";

/** A failure while dismantling an invocation; carries every stage that failed. */
export class InvocationTeardownError extends Error {
  override name = "InvocationTeardownError";
  readonly causes: unknown[];

  constructor(causes: unknown[]) {
    const first = causes[0];
    super(first instanceof Error ? first.message : String(first));
    this.causes = causes;
    this.cause = first;
  }
}

export interface Invocation {
  /** Anchors `persist eval` and `daemon` resources for this invocation. */
  evalScope: EvalScope;
  /** Where the body runs; hosts the content scope. */
  bodyScope: Scope;
  /** The content scope, created at the first projection and shared by the rest. */
  useContentScope(): Operation<EvalScope>;
}

interface Hosted {
  scope: EvalScope;
  task: Task<void>;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Run a component body as an invocation.
 *
 * Teardown is one destructor with three ordered stages, so it never depends on
 * the order in which the body happened to acquire things:
 *
 *   1. halt the content scope — projected content, to completion;
 *   2. halt the body — the author's own resources;
 *   3. halt A — whatever `persist eval` and `daemon` retained.
 *
 * Every stage is attempted even when an earlier one throws. Success, error and
 * cancellation all leave through it: the body's throw is caught at its task
 * boundary so its resources are still alive when stage 1 runs.
 *
 * Body execution and teardown are different failure domains, and a cleanup
 * failure must not erase the failure that caused the unwind. When both fail,
 * the caller receives one `AggregateError` whose ordered members are the body
 * failure and a single `InvocationTeardownError` — each original error stays
 * reachable by identity, which is what `fatalCause()` traverses.
 */
export function* withInvocation<T>(body: (invocation: Invocation) => Operation<T>): Operation<T> {
  return yield* scoped(function* () {
    let bodyFailure: Error | undefined;
    const teardownFailures: unknown[] = [];

    // The frame's final failure is decided here, not by the stage runner
    // below. Spawning registers an auto-halt destructor for `evalHost` on this
    // frame, and a halted task rethrows its teardown failure every time
    // `halt()` is awaited — so that re-halt runs between the stage runner and
    // this destructor, and would otherwise replace the selected outcome.
    // Destructors run last-registered-first and a later failure wins, which is
    // why this one is registered before the spawn: it runs last, and what it
    // throws — or declines to throw, letting the body failure through — is
    // what the caller receives.
    yield* ensure(function* () {
      if (teardownFailures.length === 0) {
        return;
      }
      const teardown = new InvocationTeardownError(teardownFailures);
      if (bodyFailure === undefined) {
        throw teardown;
      }
      throw new AggregateError(
        [bodyFailure, teardown],
        "component invocation body and teardown both failed",
      );
    });

    const evalPublished = withResolvers<EvalScope>();
    const evalHost = yield* spawn(function* () {
      try {
        evalPublished.resolve(yield* useEvalScope());
      } catch (error) {
        evalPublished.reject(asError(error));
        return;
      }
      yield* suspend();
    });
    const evalScope = yield* evalPublished.operation;

    const scopePublished = withResolvers<Scope>();
    const start = withResolvers<Invocation>();
    const resultPublished = withResolvers<T>();

    const bodyHost = yield* evalScope.scope.spawn(function* () {
      try {
        scopePublished.resolve(yield* useScope());
      } catch (error) {
        scopePublished.reject(asError(error));
        return;
      }
      const invocation = yield* start.operation;
      try {
        resultPublished.resolve(yield* body(invocation));
      } catch (error) {
        resultPublished.reject(asError(error));
      }
      yield* suspend();
    });
    const bodyScope = yield* scopePublished.operation;

    let content: Hosted | undefined;
    let contentPending: Operation<EvalScope> | undefined;

    const invocation: Invocation = {
      evalScope,
      bodyScope,
      *useContentScope(): Operation<EvalScope> {
        if (!contentPending) {
          const published = withResolvers<EvalScope>();
          // Assigned before any suspension point: concurrent first projections
          // await the same publication instead of creating a second scope.
          contentPending = published.operation;
          const task = bodyScope.run(function* () {
            try {
              published.resolve(yield* useEvalScope());
            } catch (error) {
              published.reject(asError(error));
              return;
            }
            yield* suspend();
          });
          content = { scope: yield* published.operation, task };
          return content.scope;
        }
        return yield* contentPending;
      },
    };

    // Registered after the spawns so it runs first: the stages execute in the
    // boundary's order and every one is attempted. Failures are only recorded
    // here — throwing would hand the frame an outcome a later destructor's
    // re-halt could still replace.
    yield* ensure(function* () {
      const stages: Array<() => Operation<void>> = [
        () => (content ? content.task.halt() : noop()),
        () => bodyHost.halt(),
        () => evalHost.halt(),
      ];
      for (const stage of stages) {
        try {
          yield* stage();
        } catch (error) {
          teardownFailures.push(error);
        }
      }
    });

    start.resolve(invocation);
    try {
      return yield* resultPublished.operation;
    } catch (error) {
      // Recorded so the outcome destructor can keep it when a teardown stage
      // also fails; a destructor throw would otherwise replace it as the
      // scope's failure.
      bodyFailure = asError(error);
      throw error;
    }
  });
}

// deno-lint-ignore require-yield
function* noop(): Operation<void> {}
