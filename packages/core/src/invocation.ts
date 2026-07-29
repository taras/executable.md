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
 */
export function* withInvocation<T>(body: (invocation: Invocation) => Operation<T>): Operation<T> {
  return yield* scoped(function* () {
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

    yield* ensure(function* () {
      const failures: unknown[] = [];
      const stages: Array<() => Operation<void>> = [
        () => (content ? content.task.halt() : noop()),
        () => bodyHost.halt(),
        () => evalHost.halt(),
      ];
      for (const stage of stages) {
        try {
          yield* stage();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new InvocationTeardownError(failures);
      }
    });

    start.resolve(invocation);
    return yield* resultPublished.operation;
  });
}

// deno-lint-ignore require-yield
function* noop(): Operation<void> {}
