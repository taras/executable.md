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
  failVisiblyThenThrow,
  validationError,
} from "./assertions.ts";
import type { AssertionEntry } from "./assertions.ts";
import { persistBoundaryOutcome, persistTestResult } from "./journal.ts";
import { capture, content, ContentError, hasCapture } from "@executablemd/core";
import type { Json, PropsSchema } from "@executablemd/core";
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
}

export function createTestHandlers(options: { timeoutMs: number }): TestHandlers {
  const { timeoutMs } = options;

  return { timeoutMs };
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

/** `<AssertThrows>` takes `message` as a capture; `as` is the engine's. */
export const ASSERT_THROWS_PROPS: PropsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * `<AssertThrows>` as a function component.
 *
 * `message` is a capture, so a `RegExp` reaches the matcher — through JSON props
 * that branch is unreachable, because a round-trip turns one into `{}`. The
 * caught `ErrorSegment` is the return value and the registration declares
 * `liveReturn`, so `as` binds that very object rather than a description of it.
 *
 * It emits no pass diagnostic. The return channel now carries the segment, and
 * no other channel preserves a durable rendered segment: `raise()` is the error
 * observation chain and would abort the document under a throwing policy, and
 * `DocumentOutput` is ephemeral, so a live run and a replay would disagree.
 */
export function* AssertThrows(_props: Record<string, Json>): Operation<unknown> {
  if (!(yield* hasCapture("message"))) {
    yield* raise(validationError("AssertThrows", 'requires a "message" prop.'));
    return undefined;
  }
  const evaluated = yield* capture("message");
  if (typeof evaluated !== "string" && !(evaluated instanceof RegExp)) {
    yield* raise(validationError("AssertThrows", 'requires "message" to be a string or a RegExp.'));
    return undefined;
  }
  const matcher: string | RegExp = evaluated;

  let captured: ErrorSegment | undefined;
  try {
    yield* scoped(function* () {
      yield* Component.around({
        // deno-lint-ignore require-yield
        *raise([segment]) {
          throw new CapturedRaise(segment);
        },
      });
      yield* content();
    });
  } catch (error) {
    if (error instanceof CapturedRaise || error instanceof RaisedSegmentError) {
      captured = error.segment;
    } else if (error instanceof ContentError) {
      captured = error.errors[0];
    } else {
      throw error;
    }
  }

  if (!captured) {
    yield* failAssertThrows(matcher, undefined);
  } else if (!matchesMessage(matcher, captured.message)) {
    yield* failAssertThrows(matcher, captured.message);
  }
  // Bound by identity through the live return — the engine owns `as`.
  return captured;
}
