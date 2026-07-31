/**
 * `<Test>`, `<AssertThrows>` and assertion handlers (specs/testing-spec.md).
 *
 * `createTestHandlers` is the internal dependency-injection seam for the
 * fixed 20-second test timeout: the public components always construct
 * handlers with 20_000; tests construct them directly with a small timeout.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import { timebox } from "@effectionx/timebox";
import { AssertionError, assertionError } from "./assert.ts";
import {
  Component,
  env,
  evalScope,
  expandSegments,
  raise,
  validateBindingName,
  withInvocation,
} from "@executablemd/core";
import type { ComponentElement, ErrorSegment, EvalEnv, Segment } from "@executablemd/core";
import { Test, boundary, inTest, record, testing, verbose } from "./test-api.ts";
import type { TestResult } from "./test-api.ts";
import {
  AssertionDiagnostic,
  buildDiagnostic,
  evaluateExpression,
  expandAssertion,
  failVisiblyThenThrow,
  validationError,
} from "./assertions.ts";
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

class CapturedRaise extends Error {
  override name = "CapturedRaise";
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

export interface TestHandlers {
  expandTest(element: ComponentElement): Operation<Segment[]>;
  expandAssertion(assertion: AssertionEntry, element: ComponentElement): Operation<Segment[]>;
  expandAssertThrows(element: ComponentElement): Operation<Segment[]>;
}

export function createTestHandlers(options: { timeoutMs: number }): TestHandlers {
  const { timeoutMs } = options;

  function* expandTest(element: ComponentElement): Operation<Segment[]> {
    if (!(yield* testing)) {
      return [];
    }
    if (yield* inTest) {
      // Reported here, while the ENCLOSING test's raise interceptor is still
      // active, so the nesting fails the current test.
      const error: ErrorSegment = {
        type: "error",
        message: "Nested <Test> elements are invalid.",
        source: "Test",
      };
      return [yield* raise(error)];
    }

    const name = typeof element.props.name === "string" ? element.props.name : undefined;
    const location = formatLocation(element);

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
        ...(element.projectedEnv?.values ?? {}),
        ...(parentEnv?.values ?? {}),
      },
    };

    const testOutput: Segment[] = [];
    let bodyError: unknown;
    let timedOut = false;
    let established = false;

    try {
      // A test is a component invocation: its resources, its middleware and
      // anything its body projects are dismantled in that order before the
      // next test starts (core §4.4).
      yield* withInvocation(function* (invocation) {
        yield* Component.around(
          {
            env: () => testEnv,
            evalScope: () => invocation.evalScope,
          },
          { at: "min" },
        );
        // Published separately from `evalScope`, which a nested component
        // invocation shadows with its own: this stays the test's for anything
        // running inside it, however deeply nested.
        yield* Test.around(
          { inTest: () => true, testScope: () => invocation.evalScope },
          { at: "min" },
        );
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
          for (const child of element.children) {
            try {
              testOutput.push(...(yield* expandSegments([child])));
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
        // Setup failures (invocation startup, middleware install) are
        // unexpected errors; only failures dismantling an ESTABLISHED
        // invocation — an InvocationTeardownError — are teardown failures.
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
      // A returned ErrorSegment would be settled under the AMBIENT policy —
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

  function* expandAssertThrows(element: ComponentElement): Operation<Segment[]> {
    for (const propName of [...Object.keys(element.props), ...Object.keys(element.expressions)]) {
      if (propName !== "message" && propName !== "as") {
        return [
          yield* raise(
            validationError(
              "AssertThrows",
              `does not accept a "${propName}" prop (allowed: message, as).`,
            ),
          ),
        ];
      }
    }
    if (!("message" in element.props) && !("message" in element.expressions)) {
      return [yield* raise(validationError("AssertThrows", 'requires a "message" prop.'))];
    }
    if ("as" in element.expressions) {
      return [
        yield* raise(
          validationError(
            "AssertThrows",
            'the "as" prop must be a string literal, not an expression.',
          ),
        ),
      ];
    }

    const currentEnv = yield* env;
    const merged = {
      ...(element.projectedEnv?.values ?? {}),
      ...(currentEnv?.values ?? {}),
    };

    let matcher: string | RegExp;
    if ("message" in element.expressions) {
      let evaluated: unknown;
      try {
        evaluated = evaluateExpression(element.expressions["message"]!, merged);
      } catch (error) {
        return [
          yield* raise(
            validationError(
              "AssertThrows",
              `failed to evaluate the "message" expression: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          ),
        ];
      }
      if (typeof evaluated === "string" || evaluated instanceof RegExp) {
        matcher = evaluated;
      } else {
        return [
          yield* raise(
            validationError(
              "AssertThrows",
              `the "message" expression must evaluate to a string or RegExp, got ${typeof evaluated}.`,
            ),
          ),
        ];
      }
    } else {
      const literal = element.props["message"];
      if (typeof literal !== "string") {
        return [
          yield* raise(validationError("AssertThrows", 'the "message" prop must be a string.')),
        ];
      }
      matcher = literal;
    }

    let binding: string | undefined;
    if ("as" in element.props) {
      if (!currentEnv) {
        return [
          yield* raise(
            validationError("AssertThrows", 'binding with "as" requires an eval scope in context.'),
          ),
        ];
      }
      const parsed = validateBindingName(element.props["as"]);
      if (!parsed.ok) {
        return [
          yield* raise(validationError("AssertThrows", `the "as" prop ${parsed.error.message}`)),
        ];
      }
      if (parsed.value === undefined) {
        return [
          yield* raise(
            validationError("AssertThrows", 'the "as" prop must be a non-empty string.'),
          ),
        ];
      }
      binding = parsed.value;
    }

    // Install a scope-local raise interceptor and expand the body. Inside a
    // <Test> the enclosing interceptor is installed in an outer scope, and
    // outer middleware runs first (see @effectionx/context-api ordering), so
    // it throws RaisedSegmentError before this hook is reached; outside a test
    // this hook is the only interceptor and throws CapturedRaise. Catching
    // both makes capture behave identically inside and outside <Test>. The
    // first raised error stops expansion, so later children never execute.
    let captured: ErrorSegment | undefined;
    try {
      yield* scoped(function* () {
        yield* Component.around({
          // deno-lint-ignore require-yield
          *raise([segment]) {
            throw new CapturedRaise(segment);
          },
        });
        yield* expandSegments(element.children);
      });
    } catch (error) {
      if (error instanceof CapturedRaise || error instanceof RaisedSegmentError) {
        captured = error.segment;
      } else {
        throw error;
      }
    }

    if (!captured) {
      yield* failAssertThrows(matcher, undefined);
    } else if (!matchesMessage(matcher, captured.message)) {
      yield* failAssertThrows(matcher, captured.message);
    }

    if (binding !== undefined && currentEnv) {
      currentEnv.values[binding] = captured;
    }

    const visible = (yield* testing) || (yield* verbose);
    if (!visible) {
      return [];
    }
    return [
      {
        type: "text",
        content: buildDiagnostic("AssertThrows", "passed", describeMatcher(matcher), {}),
      },
    ];
  }

  return { expandTest, expandAssertion, expandAssertThrows };
}

function* failAssertThrows(matcher: string | RegExp, actual: string | undefined): Operation<never> {
  const expected = describeMatcher(matcher);
  const failure = assertionError(
    actual === undefined
      ? `AssertThrows: expected the body to raise an error matching ${expected}, but none was raised`
      : `AssertThrows: raised error ${JSON.stringify(actual)} did not match ${expected}`,
  );
  yield* failVisiblyThenThrow(
    "AssertThrows",
    undefined,
    { expected, actual: actual ?? "(none)" },
    failure,
  );
  throw failure;
}

function matchesMessage(matcher: string | RegExp, message: string): boolean {
  return matcher instanceof RegExp ? matcher.test(message) : message.includes(matcher);
}

function describeMatcher(matcher: string | RegExp): string {
  return matcher instanceof RegExp ? String(matcher) : `substring ${JSON.stringify(matcher)}`;
}

function formatLocation(element: ComponentElement): string {
  const position = element.position;
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
