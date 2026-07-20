/**
 * Durable testing records (specs/testing-spec.md §Testing Mode).
 *
 * Completed tests and explicit `<Testing>` boundary outcomes are journaled
 * as testing-owned durable operations while document expansion runs —
 * before the root Close event. On a full replay of a completed journal,
 * `durableRun` returns the stored root result without re-expanding the
 * document, so no test would ever re-record; the stored records are
 * restored from the stream instead. On partial replay the document
 * re-expands and each record replays in place, recording exactly once in
 * discovery order.
 *
 * Record identities are deterministic, derived from source position.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { DurableStream, Json, Workflow } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import type { BoundaryOutcome, TestResult } from "./test-api.ts";

const TEST_RESULT = "test_result";
const TESTING_BOUNDARY = "testing_boundary";

export function* persistTestResult(result: TestResult): Workflow<TestResult> {
  const stored = yield createDurableOperation<Json>(
    { type: TEST_RESULT, name: `test:${result.location}` },
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      return serializeTestResult(result);
    },
  );
  const parsed = parseTestResult(stored);
  if (!parsed) {
    throw new Error(`journaled test_result for "${result.location}" has an unexpected shape`);
  }
  return parsed;
}

export function* persistBoundaryOutcome(
  outcome: BoundaryOutcome,
  location: string,
): Workflow<BoundaryOutcome> {
  const stored = yield createDurableOperation<Json>(
    { type: TESTING_BOUNDARY, name: `testing:${location}` },
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      return { tests: outcome.tests, failed: outcome.failed };
    },
  );
  const parsed = parseBoundaryOutcome(stored);
  if (!parsed) {
    throw new Error(`journaled testing_boundary for "${location}" has an unexpected shape`);
  }
  return parsed;
}

export interface CompletedRunRecords {
  results: TestResult[];
  boundaries: BoundaryOutcome[];
}

/**
 * Read testing records from a journal that already holds a root Close
 * event — the confirmed-full-replay case. Returns undefined for a live or
 * partial journal, where expansion itself (re)records each result.
 */
export function* readCompletedRun(
  stream: DurableStream,
): Operation<CompletedRunRecords | undefined> {
  const events = yield* stream.readAll();
  const completed = events.some((event) => event.type === "close" && event.coroutineId === "root");
  if (!completed) {
    return undefined;
  }

  const results: TestResult[] = [];
  const boundaries: BoundaryOutcome[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    if (event.description.type === TEST_RESULT) {
      const parsed = parseTestResult(event.result.value);
      if (parsed) {
        results.push(parsed);
      }
    } else if (event.description.type === TESTING_BOUNDARY) {
      const parsed = parseBoundaryOutcome(event.result.value);
      if (parsed) {
        boundaries.push(parsed);
      }
    }
  }
  return { results, boundaries };
}

function serializeTestResult(result: TestResult): Json {
  const payload: Record<string, Json> = {
    status: result.status,
    location: result.location,
  };
  if (result.name !== undefined) {
    payload.name = result.name;
  }
  if (result.error) {
    const error: Record<string, Json> = {
      kind: result.error.kind,
      message: result.error.message,
    };
    if (result.error.actual !== undefined) {
      error.actual = result.error.actual;
    }
    if (result.error.expected !== undefined) {
      error.expected = result.error.expected;
    }
    payload.error = error;
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

const ERROR_KINDS = ["assertion", "timeout", "teardown", "error"];

function parseTestResult(value: unknown): TestResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { status, location, name, error } = value;
  if (status !== "pass" && status !== "fail") {
    return undefined;
  }
  if (typeof location !== "string" || !optionalString(name)) {
    return undefined;
  }
  const result: TestResult = { status, location };
  if (name !== undefined) {
    result.name = name;
  }
  if (error !== undefined) {
    if (!isRecord(error)) {
      return undefined;
    }
    const { kind, message, actual, expected } = error;
    if (typeof kind !== "string" || !ERROR_KINDS.includes(kind)) {
      return undefined;
    }
    if (
      typeof message !== "string" ||
      !optionalString(actual) ||
      !optionalString(expected) ||
      (kind !== "assertion" && kind !== "timeout" && kind !== "teardown" && kind !== "error")
    ) {
      return undefined;
    }
    result.error = { kind, message };
    if (actual !== undefined) {
      result.error.actual = actual;
    }
    if (expected !== undefined) {
      result.error.expected = expected;
    }
  }
  return result;
}

function parseBoundaryOutcome(value: unknown): BoundaryOutcome | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { tests, failed } = value;
  if (typeof tests !== "number" || typeof failed !== "number" || tests < 0 || failed < 0) {
    return undefined;
  }
  return { tests, failed };
}
