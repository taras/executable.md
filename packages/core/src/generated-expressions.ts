/**
 * The declarative data expressions a generated fragment may write
 * (specs/executable-mdx-spec.md §5.3.3).
 *
 * An ordinary document's expression props are its author's own JavaScript, and
 * the engine runs them as such. A generated fragment has no author: its text
 * arrived from a model, and running it as JavaScript would hand that text the
 * whole language behind whatever the fragment was admitted for. So a generated
 * expression is *data*, and this is the grammar of that data — JSON literals,
 * the fragment's own bindings, arrays, objects, and object shorthand.
 *
 * The grammar is deliberately smaller than JSON-with-variables looks. There is
 * no arithmetic, no concatenation, no call and no member access, because each
 * of those is a way to compute something the fragment did not state, and a
 * value the fragment did not state is a value nobody admitted.
 *
 * A leading minus is the one exception, and it is not an exception to the rule
 * above: JSON's own number grammar carries one, so `-1` *is* a JSON literal and
 * reading it as an operator would refuse a value JSON defines. It is the
 * numeric grammar and not general unary evaluation, so the minus must sit
 * directly on a numeric literal and nothing else joins it — `+1` is refused
 * because JSON has no leading plus, and `-note`, `!note`, `typeof note` and
 * `1 - 1` are refused as the operators they are.
 *
 * ## Parsed, then interpreted — never executed
 *
 * Acorn reads the existing expression syntax, and this walks the nodes it
 * produced. `new Function()`, `eval`, and every other way of turning text into
 * code are absent by construction rather than by guard: there is no path
 * through here that hands a string to the runtime to compile.
 *
 * ## Two passes over one grammar
 *
 * Whole-fragment preflight validates every expression against the bindings that
 * will exist where it is written, before the fragment performs its first
 * effect. Expansion then interprets the same text against the values those
 * bindings actually took. Both passes walk this one grammar, so an expression
 * that passes preflight and fails at expansion is a bug here rather than a
 * fragment's second chance — which is why the scope a preflight checks is the
 * scope expansion will have, and not a superset of it.
 */

import { parseExpressionAt } from "acorn";
import { createContext } from "effection";
import type { Context } from "effection";
import type { Json } from "./types.ts";

/**
 * Whether the expansion in progress is a generated fragment's.
 *
 * Core's own generated expansion sets it, and reading it is how the two
 * expression paths — an ordinary prop and a declared capture — reach this
 * grammar instead of the trusted-document evaluator. It is core-private: it is
 * exported from no package entry point, so nothing outside this copy of core
 * can name it.
 *
 * Setting it can only ever narrow what an expression may be, so the failure
 * mode of a stray installation is a refusal rather than an escape. Preflight
 * refuses a non-data expression before the fragment's first effect in any case,
 * which is where the authority actually lives; this is what performs the value.
 */
export const GeneratedDataExpressions: Context<boolean> = createContext<boolean>(
  "@executablemd/core/generated-data-expressions",
  false,
);

/** An expression a generated fragment may not write, or a binding it lacks. */
export class DataExpressionError extends Error {
  override name = "DataExpressionError";
}

const UNPARSEABLE = "a generated expression is not an expression.";

const INCOMPLETE =
  "a generated expression is followed by more than one expression. One prop states one value.";

const FORM =
  "a generated expression uses a form that computes a value rather than stating one. A " +
  "generated fragment writes JSON literals, its own bindings, arrays, objects and shorthand.";

const NUMBER = "a generated expression states a number that is not a finite JSON number.";

const KEY = "a generated expression states an object key that is not a plain name or string.";

/**
 * What a fragment's expression may name, at one point in the fragment.
 *
 * A set rather than the values themselves, because preflight runs before any
 * of them exist. Expansion checks the same names against the environment that
 * holds them, so the two passes disagree only if this is wrong.
 */
export type DataScope = ReadonlySet<string>;

/**
 * The one parse. Complete, so text after a valid expression refuses rather than
 * being ignored: `{ a: 1 }, sideEffect()` states two things and admitting the
 * first would silently drop the reader's evidence of the second.
 */
function parsed(text: string): unknown {
  let node: unknown;
  try {
    node = parseExpressionAt(text, 0, { ecmaVersion: "latest" });
  } catch {
    throw new DataExpressionError(UNPARSEABLE);
  }
  if (!isNode(node)) {
    throw new DataExpressionError(UNPARSEABLE);
  }
  if (text.slice(node.end).trim().length > 0) {
    throw new DataExpressionError(INCOMPLETE);
  }
  return node;
}

interface AcornNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

function isNode(value: unknown): value is AcornNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number"
  );
}

/**
 * Refuse a generated expression that is not data, or that names a binding the
 * fragment does not have at this point.
 *
 * Preflight's half. It produces no value: nothing exists to produce one from
 * yet, and the point of running it now is that the fragment has performed
 * nothing.
 */
export function validateDataExpression(text: string, scope: DataScope): void {
  walk(parsed(text), (name) => {
    if (!scope.has(name)) {
      throw new DataExpressionError(binding(name));
    }
  });
}

/**
 * Interpret one generated expression against the bindings it can see.
 *
 * Expansion's half, over the grammar preflight already accepted. It checks the
 * names again rather than trusting that it was: this runs the value, and a
 * value assembled from a binding nobody admitted is the thing preflight exists
 * to prevent.
 */
export function evaluateDataExpression(text: string, values: Record<string, unknown>): Json {
  return interpret(parsed(text), values);
}

function binding(name: string): string {
  return `a generated expression names \`${name}\`, which is not one of the fragment's bindings.`;
}

/** Validate without producing a value, reporting each identifier as it is met. */
function walk(node: unknown, identifier: (name: string) => void): void {
  if (!isNode(node)) {
    throw new DataExpressionError(FORM);
  }
  switch (node.type) {
    case "Literal": {
      literal(node);
      return;
    }
    case "UnaryExpression": {
      signed(node);
      return;
    }
    case "Identifier": {
      identifier(named(node));
      return;
    }
    case "ArrayExpression": {
      for (const element of elements(node)) {
        walk(element, identifier);
      }
      return;
    }
    case "ObjectExpression": {
      for (const property of properties(node)) {
        key(property);
        walk(property.value, identifier);
      }
      return;
    }
    default: {
      throw new DataExpressionError(FORM);
    }
  }
}

function interpret(node: unknown, values: Record<string, unknown>): Json {
  if (!isNode(node)) {
    throw new DataExpressionError(FORM);
  }
  switch (node.type) {
    case "Literal": {
      return literal(node);
    }
    case "UnaryExpression": {
      return signed(node);
    }
    case "Identifier": {
      const name = named(node);
      if (!Object.hasOwn(values, name)) {
        throw new DataExpressionError(binding(name));
      }
      return asData(values[name]);
    }
    case "ArrayExpression": {
      return elements(node).map((element) => interpret(element, values));
    }
    case "ObjectExpression": {
      // Built by defining each property rather than by assigning it, so a
      // fragment writing `__proto__` states a key whose value is data. An
      // assignment would reach the setter that name inherits and change the
      // object's prototype instead of adding a member to it.
      const object: Record<string, Json> = {};
      for (const property of properties(node)) {
        Object.defineProperty(object, key(property), {
          value: interpret(property.value, values),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return object;
    }
    default: {
      throw new DataExpressionError(FORM);
    }
  }
}

/**
 * A negative numeric literal, which is what JSON calls a negative number.
 *
 * Minus alone, because that is the whole of JSON's sign grammar: `+1` is a
 * unary operator applied to a number rather than a number, and admitting it
 * would be admitting evaluation. The minus also has to sit on the number
 * itself — anything else beneath a unary operator, a binding or another
 * expression, is the computation this grammar refuses.
 *
 * *Directly* attached, which the parser will not say for us: `- 1` and
 * `-/*gap*\/1` produce the same tree as `-1`, and they are operator spellings
 * rather than the number JSON defines. So the literal must begin at the
 * character after the minus, which is true only when nothing — whitespace, a
 * line break, a comment — sits between them.
 */
function signed(node: AcornNode): Json {
  if (!("operator" in node) || node.operator !== "-") {
    throw new DataExpressionError(FORM);
  }
  if (!("argument" in node) || !isNode(node.argument) || node.argument.type !== "Literal") {
    throw new DataExpressionError(FORM);
  }
  if (node.argument.start !== node.start + 1) {
    throw new DataExpressionError(FORM);
  }
  const held = literal(node.argument);
  if (typeof held !== "number") {
    throw new DataExpressionError(FORM);
  }
  return -held;
}

/**
 * One literal's value.
 *
 * `1e999` is a numeric literal whose value is `Infinity`, so finiteness is
 * checked on the value rather than on the spelling. A BigInt or a regular
 * expression is a literal to the parser and not a JSON value to anyone, and
 * each is refused as the form it is.
 */
function literal(node: AcornNode): Json {
  if ("bigint" in node || "regex" in node) {
    throw new DataExpressionError(FORM);
  }
  if (!("value" in node)) {
    throw new DataExpressionError(FORM);
  }
  const held = node.value;
  if (held === null || typeof held === "string" || typeof held === "boolean") {
    return held;
  }
  if (typeof held === "number") {
    if (!Number.isFinite(held)) {
      throw new DataExpressionError(NUMBER);
    }
    return held;
  }
  throw new DataExpressionError(FORM);
}

function named(node: AcornNode): string {
  if (!("name" in node) || typeof node.name !== "string") {
    throw new DataExpressionError(FORM);
  }
  return node.name;
}

function elements(node: AcornNode): unknown[] {
  if (!("elements" in node) || !Array.isArray(node.elements)) {
    throw new DataExpressionError(FORM);
  }
  for (const element of node.elements) {
    // A hole — `[1, , 2]` — is an absent element rather than a value, and a
    // spread is a form of its own. Neither states what it contributes.
    if (element === null) {
      throw new DataExpressionError(FORM);
    }
  }
  return node.elements;
}

interface DataProperty {
  readonly key: unknown;
  readonly value: unknown;
  readonly computed: boolean;
  readonly kind: string;
}

function properties(node: AcornNode): DataProperty[] {
  if (!("properties" in node) || !Array.isArray(node.properties)) {
    throw new DataExpressionError(FORM);
  }
  const held: DataProperty[] = [];
  for (const property of node.properties) {
    // A `SpreadElement` is not a `Property` at all, and a getter, setter or
    // method is a `Property` whose value is a function. Each is refused as the
    // form it is rather than by what it would have produced.
    if (
      !isNode(property) ||
      property.type !== "Property" ||
      !("key" in property) ||
      !("value" in property) ||
      !("computed" in property) ||
      typeof property.computed !== "boolean" ||
      !("kind" in property) ||
      typeof property.kind !== "string"
    ) {
      throw new DataExpressionError(FORM);
    }
    if (property.kind !== "init") {
      throw new DataExpressionError(FORM);
    }
    if ("method" in property && property.method === true) {
      throw new DataExpressionError(FORM);
    }
    held.push({
      key: property.key,
      value: property.value,
      computed: property.computed,
      kind: property.kind,
    });
  }
  return held;
}

/**
 * One object key, as the data it is.
 *
 * A computed key is an expression evaluated to choose a name, which is the
 * member access this grammar refuses seen from the other side. What is left is
 * a plain name or a string, and both are kept exactly as written — including
 * `__proto__`, which is an ordinary key here because nothing assigns it.
 */
function key(property: DataProperty): string {
  if (property.computed) {
    throw new DataExpressionError(KEY);
  }
  if (!isNode(property.key)) {
    throw new DataExpressionError(KEY);
  }
  if (property.key.type === "Identifier") {
    return named(property.key);
  }
  if (property.key.type === "Literal" && "value" in property.key) {
    const held = property.key.value;
    if (typeof held === "string") {
      return held;
    }
    if (typeof held === "number" && Number.isFinite(held)) {
      return String(held);
    }
  }
  throw new DataExpressionError(KEY);
}

/**
 * A binding's value, admitted as data.
 *
 * A binding holds whatever the component that produced it returned, and a
 * fragment composing one into a prop is stating that value as data. What
 * survives is what JSON holds; anything else — a function, a symbol, a cycle —
 * is refused here rather than crossing into a prop as something a later reader
 * cannot account for.
 */
function asData(held: unknown): Json {
  if (held === null) {
    return null;
  }
  if (typeof held === "string" || typeof held === "boolean") {
    return held;
  }
  if (typeof held === "number") {
    if (!Number.isFinite(held)) {
      throw new DataExpressionError(NUMBER);
    }
    return held;
  }
  if (Array.isArray(held)) {
    return held.map(asData);
  }
  if (typeof held === "object") {
    const object: Record<string, Json> = {};
    for (const [name, member] of Object.entries(held)) {
      Object.defineProperty(object, name, {
        value: asData(member),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return object;
  }
  throw new DataExpressionError(FORM);
}
