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
// One class, not two: `<Test>`'s interceptor throws this and the catch below
// checks it, so a second identical declaration would make `instanceof` miss.
import { RaisedSegmentError } from "./test-component.ts";

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
  /** The per-test timeout the `<Test>` registration is built from. */
  timeoutMs: number;
  expandAssertion(assertion: AssertionEntry, element: ComponentElement): Operation<Segment[]>;
  expandAssertThrows(element: ComponentElement): Operation<Segment[]>;
}

export function createTestHandlers(options: { timeoutMs: number }): TestHandlers {
  const { timeoutMs } = options;

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

    // Install a scope-local raise interceptor and expand the body. This hook is
    // the nearest one, so it answers first and throws CapturedRaise both inside
    // and outside a <Test>. RaisedSegmentError is still caught: it is what an
    // enclosing <Test> throws, and reaches here if this hook is ever bypassed.
    // Catching both makes capture behave identically either way. The first
    // raised error stops expansion, so later children never execute.
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

  return { timeoutMs, expandAssertion, expandAssertThrows };
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
