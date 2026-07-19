/**
 * Assertion components (specs/testing-spec.md §Assertions).
 *
 * Each component maps to an `@std/assert` export with the same name and
 * parameter names. Expression props evaluate LIVE against the merged binding
 * environment — never through JSON serialization, which would destroy
 * `RegExp`s, `undefined`, and object identity.
 *
 * The assertion runs on the raw values BEFORE any diagnostic formatting, so
 * formatting arbitrary values (mutating or throwing getters/toJSON/toString)
 * can never change the assertion outcome. Diagnostics are built afterwards
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
} from "@std/assert";
import type { Operation } from "effection";
import { DocumentOutput, env, renderSegments } from "@executablemd/core";
import type {
  ComponentInvocation,
  ErrorSegment,
  InvocationContext,
  Segment,
} from "@executablemd/core";
import { inTest, testing, verbose } from "./test-api.ts";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type AssertionKind =
  | "unary-truthy"
  | "unary-exists"
  | "binary-eq"
  | "string-includes"
  | "match"
  | "numeric";

export interface AssertionEntry {
  name: string;
  kind: AssertionKind;
  /** Runs the underlying @std/assert function on the resolved raw values. */
  run(values: ResolvedValues): void;
  allowsExpectedChildren: boolean;
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
  run: (values: ResolvedValues) => void,
): [string, AssertionEntry] {
  const allowsExpectedChildren = kind === "binary-eq" || kind === "string-includes";
  return [name, { name, kind, run, allowsExpectedChildren }];
}

export const ASSERTIONS: Map<string, AssertionEntry> = new Map([
  entry("Assert", "unary-truthy", (v) => assert(v.expr, v.msg)),
  entry("AssertFalse", "unary-truthy", (v) => assertFalse(v.expr, v.msg)),
  entry("AssertExists", "unary-exists", (v) => assertExists(v.actual, v.msg)),
  entry("AssertEquals", "binary-eq", (v) => assertEquals(v.actual, v.expected, v.msg)),
  entry("AssertNotEquals", "binary-eq", (v) => assertNotEquals(v.actual, v.expected, v.msg)),
  entry("AssertStrictEquals", "binary-eq", (v) => assertStrictEquals(v.actual, v.expected, v.msg)),
  entry("AssertNotStrictEquals", "binary-eq", (v) =>
    assertNotStrictEquals(v.actual, v.expected, v.msg),
  ),
  entry("AssertStringIncludes", "string-includes", (v) =>
    assertStringIncludes(coerceString(v.actual), coerceString(v.expected), v.msg),
  ),
  entry("AssertMatch", "match", (v) =>
    assertMatch(coerceString(v.actual), requireRegExp(v.expected), v.msg),
  ),
  entry("AssertNotMatch", "match", (v) =>
    assertNotMatch(coerceString(v.actual), requireRegExp(v.expected), v.msg),
  ),
  entry("AssertGreater", "numeric", (v) => assertGreater(v.actual, v.expected, v.msg)),
  entry("AssertGreaterOrEqual", "numeric", (v) =>
    assertGreaterOrEqual(v.actual, v.expected, v.msg),
  ),
  entry("AssertLess", "numeric", (v) => assertLess(v.actual, v.expected, v.msg)),
  entry("AssertLessOrEqual", "numeric", (v) => assertLessOrEqual(v.actual, v.expected, v.msg)),
]);

function coerceString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  throw new AssertionError(`expected a string "actual"/"expected" value, got ${typeof value}`);
}

function requireRegExp(value: unknown): RegExp {
  if (value instanceof RegExp) {
    return value;
  }
  throw new AssertionError(
    "match assertions require a RegExp through the expected prop — use expected={/pattern/}",
  );
}

// ---------------------------------------------------------------------------
// Live expression evaluation
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function evaluateExpression(expression: string, values: Record<string, unknown>): unknown {
  const names = Object.keys(values).filter((name) => IDENTIFIER_RE.test(name));
  const fn = new Function(...names, `return (${expression});`);
  return fn(...names.map((name) => values[name]));
}

// ---------------------------------------------------------------------------
// Guarded value formatting — runs only AFTER the assertion outcome is fixed
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Diagnostic-carrying assertion error
// ---------------------------------------------------------------------------

/**
 * An assertion failure enriched with its Markdown diagnostic. Still an
 * `AssertionError`, so containment and classification treat it as the
 * original @std/assert failure.
 */
export class AssertionDiagnostic extends AssertionError {
  override name = "AssertionDiagnostic";
  diagnostic: string;
  detail: { actual?: string; expected?: string };

  constructor(cause: Error, diagnostic: string, detail: { actual?: string; expected?: string }) {
    super(cause.message);
    this.diagnostic = diagnostic;
    this.detail = detail;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// expandAssertion
// ---------------------------------------------------------------------------

const KIND_PROPS: Record<AssertionKind, { allowed: string[]; required: string[] }> = {
  "unary-truthy": { allowed: ["expr", "msg"], required: ["expr"] },
  "unary-exists": { allowed: ["actual", "msg"], required: ["actual"] },
  "binary-eq": { allowed: ["actual", "expected", "msg"], required: ["actual"] },
  "string-includes": { allowed: ["actual", "expected", "msg"], required: ["actual"] },
  match: { allowed: ["actual", "expected", "msg"], required: ["actual", "expected"] },
  numeric: { allowed: ["actual", "expected", "msg"], required: ["actual", "expected"] },
};

function validationError(name: string, message: string): ErrorSegment {
  return { type: "error", message: `<${name}> ${message}`, source: name };
}

/**
 * Expand one assertion component: validate props, resolve raw values, run the
 * @std/assert function, then build the diagnostic. Returns diagnostic text on
 * a visible pass; throws `AssertionDiagnostic` on failure.
 */
export function* expandAssertion(
  assertion: AssertionEntry,
  invocation: ComponentInvocation,
  ctx: InvocationContext,
): Operation<Segment[]> {
  const rules = KIND_PROPS[assertion.kind];
  const supplied = [...Object.keys(invocation.props), ...Object.keys(invocation.expressions)];

  for (const name of supplied) {
    if (!rules.allowed.includes(name)) {
      return [
        validationError(
          assertion.name,
          `does not accept a "${name}" prop (allowed: ${rules.allowed.join(", ")}).`,
        ),
      ];
    }
  }

  const hasChildren = !invocation.selfClosing && invocation.children.length > 0;
  if (hasChildren && !assertion.allowsExpectedChildren) {
    return [validationError(assertion.name, "does not accept expected children.")];
  }
  if (hasChildren && supplied.includes("expected")) {
    return [
      validationError(
        assertion.name,
        'accepts either an "expected" prop or expected children, not both.',
      ),
    ];
  }

  for (const name of rules.required) {
    const suppliedByChildren = name === "expected" && hasChildren;
    if (!supplied.includes(name) && !suppliedByChildren) {
      return [validationError(assertion.name, `requires the "${name}" prop.`)];
    }
  }
  if (assertion.kind === "binary-eq" || assertion.kind === "string-includes") {
    if (!supplied.includes("expected") && !hasChildren) {
      return [validationError(assertion.name, 'requires an "expected" prop or expected children.')];
    }
  }

  // Resolve raw values: literal props as-is, expression props evaluated live
  // against caller-projected bindings merged under the current environment
  // (the same precedence core uses for projected children).
  const currentEnv = yield* env;
  const merged = {
    ...(ctx.projectedEnv?.values ?? {}),
    ...(currentEnv?.values ?? {}),
  };

  const resolved: Record<string, unknown> = {};
  const resolutionOrder = ["expr", "actual", "expected", "msg"] as const;
  for (const name of resolutionOrder) {
    if (name in invocation.expressions) {
      try {
        resolved[name] = evaluateExpression(invocation.expressions[name]!, merged);
      } catch (error) {
        return [
          validationError(
            assertion.name,
            `failed to evaluate the "${name}" expression: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        ];
      }
    } else if (name in invocation.props) {
      resolved[name] = invocation.props[name];
    }
  }

  const values: ResolvedValues = {
    expr: resolved.expr,
    actual: resolved.actual,
    expected: resolved.expected,
    // Guarded coercion: a hostile toString on a non-string msg must not
    // become a new failure before the assertion runs.
    msg:
      "msg" in resolved
        ? typeof resolved.msg === "string"
          ? resolved.msg
          : safeFormat(resolved.msg)
        : undefined,
  };

  if (hasChildren) {
    const expanded = yield* ctx.expand(invocation.children);
    values.expected = renderSegments(expanded).replace(/\s+$/, "");
  }

  // Run the assertion on the raw values — the outcome is fixed before any
  // diagnostic formatting can observe (or mutate) them.
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
    const diagnostic = buildDiagnostic(assertion.name, "failed", values.msg, detail, failure);
    const visible = (yield* testing) || (yield* verbose);
    const inTestScope = yield* inTest;
    if (visible && !inTestScope) {
      // Outside a test the throw below aborts expansion before the segment
      // could render — emit the diagnostic directly so it reaches the output.
      yield* DocumentOutput.operations.output(diagnostic);
    }
    throw new AssertionDiagnostic(failure, diagnostic, detail);
  }

  const visible = (yield* testing) || (yield* verbose);
  if (!visible) {
    return [];
  }
  return [{ type: "text", content: buildDiagnostic(assertion.name, "passed", values.msg, detail) }];
}

function buildDiagnostic(
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
