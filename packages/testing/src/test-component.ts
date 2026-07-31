/**
 * `<Test>` as an ordinary function component (specs/testing-spec.md).
 *
 * A test is a component invocation, and the engine now owns that invocation:
 * its resources, its middleware and anything its body projects are dismantled
 * in that order before the next test starts. What the component keeps is the
 * part that is a test rather than a component — the isolated binding
 * environment, the raise interception that turns any diagnostic in the body
 * into this test's failure, and the timeout.
 *
 * One thing an invocation boundary sits outside of is its own teardown, so a
 * function component cannot see a failure that happens while it is being
 * dismantled. `<Test>` needs to, because a teardown failure is a test outcome.
 * So a result is *staged* here and journaled by `flushStaged`: a teardown
 * failure arrives at the collection boundary the session installs, which
 * upgrades the staged result before it is written.
 */

import { createContext } from "effection";
import type { Operation } from "effection";
import { timebox } from "@effectionx/timebox";
import {
  Component,
  env,
  evalScope,
  hasContent,
  invocation,
  raise,
  tryContent,
} from "@executablemd/core";
import type {
  ComponentInvocationMetadata,
  ErrorSegment,
  EvalEnv,
  Json,
  PropsSchema,
} from "@executablemd/core";
import { AssertionError } from "./assert.ts";
import { AssertionDiagnostic } from "./assertions.ts";
import { persistTestResult } from "./journal.ts";
import { inTest, record, Test, testing } from "./test-api.ts";
import type { TestResult } from "./test-api.ts";

export const TEST_PROPS: PropsSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  additionalProperties: false,
};

/** An ErrorSegment raised anywhere inside a test body. */
export class RaisedSegmentError extends Error {
  override name = "RaisedSegmentError";
  segment: ErrorSegment;

  constructor(segment: ErrorSegment) {
    super(segment.message);
    this.segment = segment;
  }
}

/** A failure while dismantling an established test scope or lease. */
export class TeardownError extends Error {
  override name = "TeardownError";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

/** A result computed but not yet journaled — see the module note. */
interface StagedResult {
  location: string;
  result: TestResult;
}

/**
 * Results waiting to be journaled, in discovery order.
 *
 * Staging is what lets a teardown failure — which arrives after the component
 * has returned — still land in the record for the test it belongs to. The
 * queue is scope-local: `installTestingComponents` provides one per install,
 * so two sessions never share staged work.
 */
export interface StagingQueue {
  staged: StagedResult[];
}

export const Staging = createContext<StagingQueue>("testing.staging");

/**
 * The queue for this scope.
 *
 * Absent means no session installed one, so nothing can be staged and every
 * operation below is a no-op rather than an error.
 */
function* stagingQueue(): Operation<StagingQueue | undefined> {
  return yield* Staging.get();
}

/** Journal and record everything staged, in the order it was staged. */
export function* flushStaged(): Operation<void> {
  const queue = yield* stagingQueue();
  if (!queue) {
    return;
  }
  while (queue.staged.length > 0) {
    const next = queue.staged.shift();
    if (!next) {
      break;
    }
    yield* record(yield* persistTestResult(next.result));
  }
}

/**
 * Stage `result`, having first flushed whatever preceded it.
 *
 * Flushing the predecessor here is what keeps the journal in discovery order
 * without needing a hook that runs after an invocation settles: by the time a
 * test stages its own result, the previous test's invocation is long gone and
 * its outcome — including any teardown failure — is final.
 */
export function* stageResult(location: string, result: TestResult): Operation<void> {
  yield* flushStaged();
  const queue = yield* stagingQueue();
  if (!queue) {
    return;
  }
  queue.staged.push({ location, result });
}

/**
 * Fold a failure that escaped a `<Test>` invocation into its staged result.
 *
 * Returns `true` when it belonged to a staged test. A failure with no staged
 * entry is a test that died before it could stage one — its own middleware
 * install threw, or the nested-`<Test>` diagnostic threw under a documentation
 * policy — and is staged here as an error so it is still reported and still
 * counted, rather than disappearing from the run.
 */
export function* absorbTestFailure(location: string, error: unknown): Operation<TestResult> {
  const queue = yield* stagingQueue();
  if (!queue) {
    return classify(undefined, location, error, false, 0);
  }
  const staged =
    queue.staged.find((entry) => entry.location === location) ??
    // No position of its own: the only invocation that can be in flight is the
    // one that just failed, since a nested <Test> is rejected.
    (location === "unknown" ? queue.staged[queue.staged.length - 1] : undefined);

  if (staged === undefined) {
    const result = classify(undefined, location, error, false, 0);
    queue.staged.push({ location, result });
    return result;
  }
  if (staged.result.status === "pass") {
    // The body said nothing was wrong; dismantling it disagreed.
    staged.result = classify(
      staged.result.name,
      staged.location,
      new TeardownError(error),
      false,
      0,
    );
  }
  // A body that already failed keeps its own account: it is the more useful of
  // the two. The teardown error itself is NOT carried onward — a TestResult
  // records a message and `ErrorSegment.cause` is Json, so neither can hold the
  // Error by identity, and the engine's cause channel is internal to core.
  return staged.result;
}

export function formatLocation(metadata: ComponentInvocationMetadata): string {
  const position = metadata.position;
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

export function classify(
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

export function failureDiagnostic(result: TestResult, options: { detail: boolean }): string {
  const title = result.name ? `**${result.name}**` : `test at ${result.location}`;
  const error = result.error;
  const lines = [`> ❌ Test ${title} failed (${error?.kind ?? "error"}): ${error?.message ?? ""}`];
  if (options.detail && error?.actual !== undefined) {
    lines.push(`> actual: ${error.actual}`);
  }
  if (options.detail && error?.expected !== undefined) {
    lines.push(`> expected: ${error.expected}`);
  }
  return `\n${lines.join("\n")}\n`;
}

/** Build the `<Test>` component for a given per-test timeout. */
export function createTest(timeoutMs: number) {
  return function* Test_(props: Record<string, Json>): Operation<Json> {
    if (!(yield* testing)) {
      return "";
    }
    if (yield* inTest) {
      // Reported here, while the ENCLOSING test's raise interceptor is still
      // active, so the nesting fails the current test.
      yield* raise({
        type: "error",
        message: "Nested <Test> elements are invalid.",
        source: "Test",
      });
      return "";
    }

    const name = typeof props.name === "string" ? props.name : undefined;
    const location = formatLocation(yield* invocation());
    const parentEnv = yield* env;
    // The invocation's own scope, read before any nested invocation can shadow
    // it, and published as `testScope` so anything however deeply nested still
    // finds this test's.
    const scope = yield* evalScope;

    // ONE stable binding environment: the accessor returns the same object on
    // every read, so <Capture> writes persist for the assertion that follows.
    // Caller-projected bindings merge UNDER the current environment, so a
    // <Test> projected through <Content /> still sees the caller's bindings.
    const testEnv: EvalEnv = { values: { ...(parentEnv?.values ?? {}) } };

    yield* Component.around({ env: () => testEnv }, { at: "min" });
    yield* Test.around(
      { inTest: () => true, ...(scope ? { testScope: () => scope } : {}) },
      { at: "min" },
    );
    // ErrorSegments fail the test. Installed at "min" — nearest answers first —
    // because the body expands in the invocation's content scope rather than
    // this frame, so the two layers are no longer ancestor and descendant and
    // "max" would resolve in the test's favour, preempting <AssertThrows>'s
    // capture. The property "max" was meant to protect — a raise the test does
    // not claim still fails it — is pinned by the raise-observer test.
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *raise([segment]) {
          throw new RaisedSegmentError(segment);
        },
      },
      { at: "min" },
    );

    let text = "";
    let bodyError: unknown;
    let timedOut = false;

    if (yield* hasContent()) {
      const boxed = yield* timebox(timeoutMs, function* () {
        // Partial output plus the failure that ended it: what the body rendered
        // before it failed is part of what the test reports.
        return yield* tryContent();
      });
      if (boxed.timeout) {
        timedOut = true;
      } else {
        text = boxed.value.text;
        bodyError = boxed.value.failure;
      }
    }

    const result = classify(name, location, bodyError, timedOut, timeoutMs);
    yield* stageResult(location, result);

    if (result.status === "fail") {
      // Containment: a completed test returns only text. A returned ErrorSegment
      // would be settled under the AMBIENT policy — after this test's
      // interception scope has ended — so it is formatted in instead.
      if (bodyError instanceof AssertionDiagnostic) {
        text += bodyError.diagnostic;
        text += failureDiagnostic(result, { detail: false });
      } else {
        text += failureDiagnostic(result, { detail: true });
      }
    }
    return text;
  };
}
