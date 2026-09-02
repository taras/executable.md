/**
 * What an ordinary component invocation's own syntax decides.
 *
 * These are the engine's rules about the invocation rather than about the
 * component: how `as` may be written, what it may name, and what a component
 * that declares `returns` requires of the site that invokes it. None of them
 * asks the component anything, and none needs a value the document computes —
 * so all of them are decided here, once, and read by every caller.
 *
 * They are phase-appropriate rather than phase-bound. Whether `as` was written
 * as an expression is a fact about authored syntax and is answered from the
 * scanned element. What a binding name may be is a fact about a value, and is
 * answered from whatever value its caller has: expansion passes the resolved
 * prop, validation passes the literal the author wrote. One rule, asked at the
 * point each caller can ask it.
 *
 * Expansion refuses at the first of these and stops, as it always has.
 * Validation reports each independent one it finds. Both read this module, so a
 * site expansion would refuse is never a site validation calls acceptable.
 */

import { validateBindingName } from "./live-env.ts";
import type { StructuralViolation } from "./structural-rules.ts";
import type { Json } from "./types.ts";

/**
 * `as` names a binding, so it is rejected on the expression itself rather than
 * on a resolved value.
 *
 * Evaluating it first would make the outcome depend on the host: a bare
 * identifier that happens to name a global resolves on one runtime and throws
 * `ReferenceError` on another.
 */
export function asExpressionViolation(
  name: string,
  expressions: Record<string, string>,
): StructuralViolation | undefined {
  return "as" in expressions
    ? {
        code: "capture-invalid",
        source: name,
        message: `Prop "as" on <${name} /> must be a string literal.`,
      }
    : undefined;
}

/** What a value `as` cannot name a binding with says. */
export function asBindingViolation(
  name: string,
  value: Json | undefined,
): StructuralViolation | undefined {
  const binding = validateBindingName(value);
  return binding.ok
    ? undefined
    : {
        code: "capture-invalid",
        source: name,
        message: `Prop "as" on <${name} /> ${binding.error.message}`,
      };
}

/** The binding a well-formed `as` names, or `undefined` when it names none. */
export function capturedBinding(value: Json | undefined): string | undefined {
  const binding = validateBindingName(value);
  return binding.ok ? binding.value : undefined;
}

/**
 * A component that declares `returns` renders nothing, so an invocation that
 * captures nothing would discard the only thing it produces.
 *
 * Unless a trusted host declared that return to be executable source (§5.3):
 * such a component has somewhere for an uncaptured return to go, because the
 * engine expands it where the component was written. Expansion and document
 * validation ask this one question, so they cannot disagree about which
 * invocations need `as`.
 */
export function returnCaptureViolation(
  name: string,
  declaresReturns: boolean,
  capture: string | undefined,
  expandsSource = false,
): StructuralViolation | undefined {
  return declaresReturns && capture === undefined && !expandsSource
    ? {
        code: "return-usage-invalid",
        source: name,
        message:
          `<${name} /> declares \`returns\`, so it renders nothing and must be invoked ` +
          `with \`as\`: <${name} as="binding" />.`,
      }
    : undefined;
}
