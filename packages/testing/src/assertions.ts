/**
 * Assertion components (specs/testing-spec.md §Assertions).
 *
 * Each component maps to an operation in `./assert.ts` with the same name and
 * parameter names. Expression props evaluate LIVE against the merged binding
 * environment — never through JSON serialization, which would destroy
 * `RegExp`s, `undefined`, and object identity.
 *
 * The assertion runs on the raw values BEFORE any report formatting, so
 * formatting arbitrary values (mutating or throwing getters/toJSON/toString)
 * can never change the assertion outcome. Reports are built afterwards
 * under guarded fallback.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertGreater,
  assertGreaterOrEqual,
  AssertionError,
  assertLess,
  assertLessOrEqual,
  assertMatch,
  assertNotEquals,
  assertNotMatch,
  assertNotStrictEquals,
  assertStrictEquals,
  assertStringIncludes,
  fail,
} from "./assert.ts";
import type { Operation } from "effection";
import {
  capture,
  content,
  DocumentOutput,
  env,
  hasCapture,
  hasContent,
  raise,
  renderSegments,
} from "@executablemd/core";
import type { ErrorSegment, FunctionComponent, Json, PropsSchema } from "@executablemd/core";
import { inTest, testing, verbose } from "./test-api.ts";

export type AssertionKind =
  | "unary-truthy"
  | "unary-exists"
  | "binary-eq"
  | "string-includes"
  | "match"
  | "numeric";

export interface AssertionEntry {
  name: string;
  kind: AssertionKind;
  /** Runs the underlying assertion operation on the resolved raw values. */
  run(values: ResolvedValues): void;
  allowsExpectedChildren: boolean;
  /** What this assertion checks, for `xmd syntax`. */
  description: string;
}

interface ResolvedValues {
  expr?: unknown;
  actual?: unknown;
  expected?: unknown;
  msg?: string;
}

function entry(
  name: string,
  kind: AssertionKind,
  description: string,
  run: (values: ResolvedValues) => void,
): [string, AssertionEntry] {
  const allowsExpectedChildren = kind === "binary-eq" || kind === "string-includes";
  return [name, { name, kind, run, allowsExpectedChildren, description }];
}

/**
 * What the content of an assertion means, decided by kind.
 *
 * The two kinds that compare against a value read multiline content as that
 * value; every other kind takes its operands as props alone, so content is a
 * configuration error rather than an undocumented affordance.
 */
export function assertionContext(kind: AssertionKind): string | null {
  return kind === "binary-eq" || kind === "string-includes"
    ? "The expected value, in place of the `expected` prop."
    : null;
}

/** The operands an assertion of `kind` takes, spelled for a reader. */
const OPERANDS: Record<AssertionKind, string> = {
  "unary-truthy": "Takes one `expr` operand.",
  "unary-exists": "Takes one `actual` operand.",
  "binary-eq": "Takes `actual` and `expected` operands.",
  "string-includes": "Takes `actual` and `expected` string operands.",
  match: "Takes an `actual` string and an `expected` RegExp, written `expected={/pattern/}`.",
  numeric: "Takes `actual` and `expected` operands, compared as numbers.",
};

/** The prose one assertion reports, with its operands and `msg` stated once. */
export function assertionDescription(assertion: AssertionEntry): string {
  return (
    `${assertion.description} ${OPERANDS[assertion.kind]} ` +
    "The optional `msg` prop replaces the reported failure message."
  );
}

export const ASSERTIONS: Map<string, AssertionEntry> = new Map([
  entry("Assert", "unary-truthy", "Passes when the operand is truthy.", (v) =>
    assert(v.expr, v.msg),
  ),
  entry("AssertFalse", "unary-truthy", "Passes when the operand is falsy.", (v) =>
    assertFalse(v.expr, v.msg),
  ),
  entry(
    "AssertExists",
    "unary-exists",
    "Passes when the operand is neither null nor undefined.",
    (v) => assertExists(v.actual, v.msg),
  ),
  entry("AssertEquals", "binary-eq", "Passes when the two operands are deeply equal.", (v) =>
    assertEquals(v.actual, v.expected, v.msg),
  ),
  entry("AssertNotEquals", "binary-eq", "Passes when the two operands are not deeply equal.", (v) =>
    assertNotEquals(v.actual, v.expected, v.msg),
  ),
  entry(
    "AssertStrictEquals",
    "binary-eq",
    "Passes when the two operands are the same value, compared by identity.",
    (v) => assertStrictEquals(v.actual, v.expected, v.msg),
  ),
  entry(
    "AssertNotStrictEquals",
    "binary-eq",
    "Passes when the two operands are not the same value, compared by identity.",
    (v) => assertNotStrictEquals(v.actual, v.expected, v.msg),
  ),
  entry(
    "AssertStringIncludes",
    "string-includes",
    "Passes when the actual string contains the expected substring.",
    (v) => assertStringIncludes(coerceString(v.actual), coerceString(v.expected), v.msg),
  ),
  entry("AssertMatch", "match", "Passes when the actual string matches the pattern.", (v) =>
    assertMatch(coerceString(v.actual), requireRegExp(v.expected), v.msg),
  ),
  entry(
    "AssertNotMatch",
    "match",
    "Passes when the actual string does not match the pattern.",
    (v) => assertNotMatch(coerceString(v.actual), requireRegExp(v.expected), v.msg),
  ),
  entry("AssertGreater", "numeric", "Passes when actual is greater than expected.", (v) =>
    assertGreater(v.actual, v.expected, v.msg),
  ),
  entry(
    "AssertGreaterOrEqual",
    "numeric",
    "Passes when actual is greater than or equal to expected.",
    (v) => assertGreaterOrEqual(v.actual, v.expected, v.msg),
  ),
  entry("AssertLess", "numeric", "Passes when actual is less than expected.", (v) =>
    assertLess(v.actual, v.expected, v.msg),
  ),
  entry(
    "AssertLessOrEqual",
    "numeric",
    "Passes when actual is less than or equal to expected.",
    (v) => assertLessOrEqual(v.actual, v.expected, v.msg),
  ),
]);

function coerceString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  fail(`expected a string "actual"/"expected" value, got ${typeof value}`);
}

function requireRegExp(value: unknown): RegExp {
  if (value instanceof RegExp) {
    return value;
  }
  fail("match assertions require a RegExp through the expected prop — use expected={/pattern/}");
}

function safeFormat(value: unknown): string {
  try {
    if (typeof value === "string") {
      return JSON.stringify(value);
    }
    if (value instanceof RegExp) {
      return String(value);
    }
    const json = JSON.stringify(value);
    if (json !== undefined) {
      return json;
    }
    return String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "<unformattable value>";
    }
  }
}

/**
 * An assertion failure enriched with its Markdown report. Still an
 * `AssertionError`, so containment and classification treat it as the
 * original assertion failure.
 */
export class AssertionReport extends AssertionError {
  override name = "AssertionReport";
  report: string;
  detail: { actual?: string; expected?: string };

  constructor(cause: Error, report: string, detail: { actual?: string; expected?: string }) {
    // Node's AssertionError takes an options bag, not a message string.
    super({ message: cause.message });
    this.report = report;
    this.detail = detail;
    this.cause = cause;
  }
}

const KIND_PROPS: Record<AssertionKind, { allowed: string[]; required: string[] }> = {
  "unary-truthy": { allowed: ["expr", "msg"], required: ["expr"] },
  "unary-exists": { allowed: ["actual", "msg"], required: ["actual"] },
  "binary-eq": { allowed: ["actual", "expected", "msg"], required: ["actual"] },
  "string-includes": { allowed: ["actual", "expected", "msg"], required: ["actual"] },
  match: { allowed: ["actual", "expected", "msg"], required: ["actual", "expected"] },
  numeric: { allowed: ["actual", "expected", "msg"], required: ["actual", "expected"] },
};

/**
 * Build a validation printed error. Constructing one is separate from reporting
 * it: the handler that owns the failure raises it (core §6.9) before returning
 * it, so this stays usable from synchronous prop checks.
 */
export function validationError(name: string, message: string): ErrorSegment {
  return { type: "error", message: `<${name}> ${message}`, source: name };
}

// Outside a test the throw would abort before the segment could render, so
// emit the visible report first.
export function* failVisiblyThenThrow(
  name: string,
  msg: string | undefined,
  detail: { actual?: string; expected?: string },
  failure: Error,
): Operation<never> {
  const report = buildReport(name, "failed", msg, detail, failure);
  const visible = (yield* testing) || (yield* verbose);
  const inTestScope = yield* inTest;
  if (visible && !inTestScope) {
    yield* DocumentOutput.operations.output(report);
  }
  throw new AssertionReport(failure, report, detail);
}

export function buildReport(
  name: string,
  outcome: "passed" | "failed",
  msg: string | undefined,
  detail: { actual?: string; expected?: string },
  failure?: Error,
): string {
  const icon = outcome === "passed" ? "✅" : "❌";
  const lines = [`> ${icon} **${name}** ${outcome}${msg ? ` — ${msg}` : ""}`];
  if (detail.actual !== undefined) {
    lines.push(`> actual: ${detail.actual}`);
  }
  if (detail.expected !== undefined) {
    lines.push(`> expected: ${detail.expected}`);
  }
  if (failure) {
    const message = failure.message.split("\n")[0];
    if (message) {
      lines.push(`> ${message}`);
    }
  }
  return `\n${lines.join("\n")}\n`;
}

/** The props an assertion of `kind` captures — its operands, never `msg`. */
export function capturesFor(kind: AssertionKind): string[] {
  return KIND_PROPS[kind].allowed.filter((name) => name !== "msg");
}

/** `msg` is the one prop a schema can describe: an ordinary JSON string. */
export const ASSERTION_PROPS: PropsSchema = {
  type: "object",
  properties: { msg: { type: "string" } },
  additionalProperties: false,
};

/**
 * The function-component form of one assertion.
 *
 * Same table, same rules, same order of operations as the handler it replaces:
 * validate what was written, take the operands raw, run the assertion on them,
 * and only then format anything — so a hostile `toString` cannot reach a value
 * before the outcome is fixed.
 */
export function assertionComponent(assertion: AssertionEntry): FunctionComponent {
  const rules = KIND_PROPS[assertion.kind];
  return function* (props: Record<string, Json>): Operation<Json> {
    const written: string[] = [];
    for (const name of rules.allowed) {
      if (yield* hasCapture(name)) {
        written.push(name);
      }
    }

    const hasChildren = yield* hasContent();
    if (hasChildren && !assertion.allowsExpectedChildren) {
      yield* raise(validationError(assertion.name, "does not accept expected children."));
      return "";
    }
    if (hasChildren && written.includes("expected")) {
      yield* raise(
        validationError(
          assertion.name,
          'accepts either an "expected" prop or expected children, not both.',
        ),
      );
      return "";
    }
    for (const name of rules.required) {
      const suppliedByChildren = name === "expected" && hasChildren;
      if (!written.includes(name) && !suppliedByChildren) {
        yield* raise(validationError(assertion.name, `requires the "${name}" prop.`));
        return "";
      }
    }

    // Operands, live. Evaluated here rather than during prop resolution, so an
    // expression that throws is this assertion's failure to report — the
    // assertion that owns the operand, not the invocation that contains it.
    const values: ResolvedValues = { msg: undefined };
    for (const name of written) {
      let value: unknown;
      try {
        value = yield* capture(name);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield* raise(
          validationError(assertion.name, `failed to evaluate the "${name}" expression: ${detail}`),
        );
        return "";
      }
      if (name === "expr") {
        values.expr = value;
      } else if (name === "actual") {
        values.actual = value;
      } else if (name === "expected") {
        values.expected = value;
      }
    }
    if (typeof props.msg === "string") {
      values.msg = props.msg;
    }

    if (hasChildren) {
      values.expected = (yield* content()).replace(/\s+$/, "");
    }

    let failure: Error | undefined;
    try {
      assertion.run(values);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    const detail: { actual?: string; expected?: string } = {};
    if (assertion.kind === "unary-truthy") {
      detail.actual = safeFormat(values.expr);
    } else {
      detail.actual = safeFormat(values.actual);
      if (assertion.kind !== "unary-exists") {
        detail.expected = safeFormat(values.expected);
      }
    }

    if (failure) {
      yield* failVisiblyThenThrow(assertion.name, values.msg, detail, failure);
    }

    const visible = (yield* testing) || (yield* verbose);
    return visible ? buildReport(assertion.name, "passed", values.msg, detail) : "";
  };
}
