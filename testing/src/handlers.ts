/**
 * `<Testing>` and `<Test>` handlers (specs/testing-spec.md).
 *
 * `createTestHandlers` is the internal dependency-injection seam for the
 * fixed 20-second test timeout: the public vocabulary always constructs
 * handlers with 20_000; tests construct them directly with a small timeout.
 */

import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Task } from "effection";
import { timebox } from "@effectionx/timebox";
import { unbox, useEvalScope } from "@effectionx/scope-eval";
import type { EvalScope } from "@effectionx/scope-eval";
import { AssertionError } from "@std/assert";
import { Component, env, evalScope } from "@executablemd/core";
import type {
  ComponentInvocation,
  ErrorSegment,
  EvalEnv,
  InvocationContext,
  Segment,
} from "@executablemd/core";
import { Test, boundary, inTest, record, testing } from "./test-api.ts";
import type { TestResult } from "./test-api.ts";
import { AssertionDiagnostic, expandAssertion } from "./assertions.ts";
import type { AssertionEntry } from "./assertions.ts";
import { persistBoundaryOutcome, persistTestResult } from "./journal.ts";

/** An ErrorSegment raised anywhere inside a test body. */
class RaisedSegmentError extends Error {
  override name = "RaisedSegmentError";
  segment: ErrorSegment;

  constructor(segment: ErrorSegment) {
    super(segment.message);
    this.segment = segment;
  }
}

/** A failure while dismantling an established test scope or lease. */
class TeardownError extends Error {
  override name = "TeardownError";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

interface EvalScopeLease {
  scope: EvalScope;
  task: Task<void>;
}

/**
 * Host a child EvalScope in a dedicated task inside the parent EvalScope.
 * The child inherits the parent's middleware, but its lifetime belongs to
 * the TEST: `parentScope.eval(() => useEvalScope())` alone would tie the
 * worker to the parent scope, leaking test-installed middleware into later
 * tests. The suspended task keeps the child alive until the lease is halted.
 */
function* leaseChildEvalScope(parentScope: EvalScope): Operation<EvalScopeLease> {
  const published = withResolvers<EvalScope>();
  const boxed = yield* parentScope.eval(function* () {
    return yield* spawn(function* () {
      published.resolve(yield* useEvalScope());
      yield* suspend();
    });
  });
  return { scope: yield* published.operation, task: unbox(boxed) };
}

export interface TestHandlers {
  expandTesting(invocation: ComponentInvocation, ctx: InvocationContext): Operation<Segment[]>;
  expandTest(invocation: ComponentInvocation, ctx: InvocationContext): Operation<Segment[]>;
  expandAssertion(
    assertion: AssertionEntry,
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]>;
}

export function createTestHandlers(options: { timeoutMs: number }): TestHandlers {
  const { timeoutMs } = options;

  function* expandTesting(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    return yield* scoped(function* () {
      const local: TestResult[] = [];
      yield* Test.around(
        {
          testing: () => true,
          // deno-lint-ignore require-yield
          *results() {
            return local;
          },
          *record([result], next) {
            local.push(result);
            yield* next(result);
          },
        },
        { at: "min" },
      );
      const report = yield* ctx.expand(invocation.children);
      // Journal the outcome before the root Close so a full replay can
      // restore it without re-expanding this boundary.
      const outcome = yield* persistBoundaryOutcome(
        {
          tests: local.length,
          failed: local.filter((result) => result.status === "fail").length,
        },
        formatLocation(invocation),
      );
      yield* boundary(outcome);
      return report;
    });
  }

  function* expandTest(
    invocation: ComponentInvocation,
    ctx: InvocationContext,
  ): Operation<Segment[]> {
    if (!(yield* testing)) {
      return [];
    }
    if (yield* inTest) {
      // Returned while the ENCLOSING test's raise interceptor is still
      // active — the hook's re-raise fails the current test.
      const error: ErrorSegment = {
        type: "error",
        message: "Nested <Test> elements are invalid.",
        source: "Test",
      };
      return [error];
    }

    const name = typeof invocation.props.name === "string" ? invocation.props.name : undefined;
    const location = formatLocation(invocation);

    const parentEnv = yield* env;
    const parentScope = yield* evalScope;
    if (!parentScope) {
      const result = yield* persistTestResult(
        failResult(name, location, {
          kind: "error",
          message: "<Test> requires an eval scope in context.",
        }),
      );
      yield* record(result);
      return [failureDiagnostic(result, { detail: true })];
    }

    // ONE stable binding environment, created before middleware install —
    // the accessor returns the same object on every read, so <Capture>
    // writes persist for the assertion that follows. Caller-projected
    // bindings merge UNDER the current environment (core's precedence,
    // expand.ts §content projection), so a <Test> projected through
    // <Content /> still sees the caller's eval bindings.
    const testEnv: EvalEnv = {
      values: {
        ...(ctx.projectedEnv?.values ?? {}),
        ...(parentEnv?.values ?? {}),
      },
    };

    const testOutput: Segment[] = [];
    let bodyError: unknown;
    let timedOut = false;
    let established = false;

    try {
      yield* scoped(function* () {
        const lease = yield* leaseChildEvalScope(parentScope);
        // Halt the lease during this scope's teardown, before the next test
        // can start. A throwing halt propagates as a teardown failure.
        yield* ensure(() => lease.task.halt());

        yield* Component.around(
          {
            env: () => testEnv,
            evalScope: () => lease.scope,
          },
          { at: "min" },
        );
        yield* Test.around({ inTest: () => true }, { at: "min" });
        // ErrorSegments fail the test. Outer instrumentation (default "max")
        // so nested { at: "min" } policies cannot shadow it: every raise in
        // the body — components, <Output> regions, code blocks, imports,
        // validation, nested <Test> — arrives here first.
        yield* Component.around({
          // deno-lint-ignore require-yield
          *raise([segment]) {
            throw new RaisedSegmentError(segment);
          },
        });
        established = true;

        const boxed = yield* timebox(timeoutMs, function* () {
          for (const child of invocation.children) {
            try {
              testOutput.push(...(yield* ctx.expand([child])));
            } catch (error) {
              bodyError = error;
              throw error;
            }
          }
        });
        if (boxed.timeout) {
          timedOut = true;
        }
      });
    } catch (outer) {
      if (bodyError === undefined && !timedOut) {
        // Setup failures (lease creation, middleware install) are unexpected
        // errors; only failures dismantling an ESTABLISHED scope/lease are
        // teardown failures.
        bodyError = established ? new TeardownError(outer) : outer;
      }
    }

    // Journal the result before the root Close. On partial replay the
    // stored record wins over the recomputation (short-circuited effects
    // can change what the re-run observes, e.g. a halted exec no longer
    // times out), keeping the original outcome authoritative.
    const result = yield* persistTestResult(
      classify(name, location, bodyError, timedOut, timeoutMs),
    );
    yield* record(result);

    if (result.status === "fail") {
      // Containment invariant: a completed test returns only text segments.
      // The hook re-raises returned ErrorSegments under the AMBIENT policy —
      // after this test's interception scope has ended — so raised segments
      // are formatted into the diagnostic instead of returned raw.
      if (bodyError instanceof AssertionDiagnostic) {
        // The assertion's own diagnostic (built when it threw) follows the
        // output produced before the failure, then the test-level line.
        testOutput.push({ type: "text", content: bodyError.diagnostic });
        testOutput.push(failureDiagnostic(result, { detail: false }));
      } else {
        testOutput.push(failureDiagnostic(result, { detail: true }));
      }
    }
    return testOutput;
  }

  return { expandTesting, expandTest, expandAssertion };
}

function formatLocation(invocation: ComponentInvocation): string {
  const position = invocation.position;
  if (!position) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}

function failResult(
  name: string | undefined,
  location: string,
  error: NonNullable<TestResult["error"]>,
): TestResult {
  return { status: "fail", name, location, error };
}

function classify(
  name: string | undefined,
  location: string,
  bodyError: unknown,
  timedOut: boolean,
  timeoutMs: number,
): TestResult {
  if (bodyError === undefined && !timedOut) {
    return { status: "pass", name, location };
  }
  if (timedOut && bodyError === undefined) {
    return failResult(name, location, {
      kind: "timeout",
      message: `test timed out after ${timeoutMs / 1000} seconds`,
    });
  }
  if (bodyError instanceof AssertionDiagnostic) {
    return failResult(name, location, {
      kind: "assertion",
      message: bodyError.message,
      actual: bodyError.detail.actual,
      expected: bodyError.detail.expected,
    });
  }
  if (bodyError instanceof AssertionError) {
    return failResult(name, location, { kind: "assertion", message: bodyError.message });
  }
  if (bodyError instanceof TeardownError) {
    return failResult(name, location, { kind: "teardown", message: bodyError.message });
  }
  const message = bodyError instanceof Error ? bodyError.message : String(bodyError);
  return failResult(name, location, { kind: "error", message });
}

function failureDiagnostic(result: TestResult, options: { detail: boolean }): Segment {
  const title = result.name ? `**${result.name}**` : `test at ${result.location}`;
  const error = result.error;
  const lines = [`> ❌ Test ${title} failed (${error?.kind ?? "error"}): ${error?.message ?? ""}`];
  if (options.detail && error?.actual !== undefined) {
    lines.push(`> actual: ${error.actual}`);
  }
  if (options.detail && error?.expected !== undefined) {
    lines.push(`> expected: ${error.expected}`);
  }
  return { type: "text", content: `\n${lines.join("\n")}\n` };
}
