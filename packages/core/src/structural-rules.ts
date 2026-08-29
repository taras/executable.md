/**
 * What a structural construct's own source says, before anything runs.
 *
 * Every construct the engine owns states part of its contract in syntax alone:
 * which props it accepts, which of them must be a literal, which children it
 * may hold, and where it may be written at all. None of those answers depends
 * on a value the document computes, so all of them are decided here — once, as
 * data — and both expansion and validation read the result.
 *
 * The checks are pure and yield nothing. Expansion turns a violation into the
 * positioned printed error it has always produced; validation reports the same
 * violation under its own code at the position it was authored. Neither owns
 * the rule, so a construct cannot be refused by one and accepted by the other.
 *
 * What is *not* here is anything needing a runtime value: whether a condition
 * holds, what an `in` expression evaluates to, whether a loop's `max` came back
 * a number. Those stay in expansion, which is the only place that may evaluate
 * them.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import { validateBindingName } from "./live-env.ts";
import type { ComponentElement, Json, Segment } from "./types.ts";

/**
 * Which part of the contract a structural violation broke.
 *
 * The names are the validation codes rather than construct names, because a
 * construct breaks more than one kind of rule: a `<Let>` may name its binding
 * badly or hold the wrong number of sources, and a consumer that acts on the
 * difference should not have to tell them apart by reading the sentence.
 */
export type StructuralViolationCode =
  | "structural-usage-invalid"
  | "binding-invalid"
  | "capture-invalid"
  | "return-usage-invalid";

/** One thing a construct's source got wrong. */
export interface StructuralViolation {
  readonly code: StructuralViolationCode;
  /** The sentence, unpositioned. Expansion positions the ones it always did. */
  readonly message: string;
  /** The construct a printed error names as its source. */
  readonly source: string;
  /**
   * The element the violation is about, when the check walked past the element
   * it was given. An `<If>` reports its `<Else>` children's mistakes, and each
   * one is anchored where it was written rather than at the `<If>`.
   */
  readonly element?: ComponentElement;
}

function violation(
  code: StructuralViolationCode,
  source: string,
  message: string,
  element?: ComponentElement,
): StructuralViolation {
  return element === undefined ? { code, source, message } : { code, source, message, element };
}

/** Every prop name written on an element, literal and expression alike. */
export function authoredPropNames(segment: ComponentElement): string[] {
  return [...Object.keys(segment.props), ...Object.keys(segment.expressions)];
}

/** Markdown puts newlines between block elements; they are not content. */
export function isBlankText(segment: Segment): boolean {
  return segment.type === "text" && segment.content.trim() === "";
}

const LET_PROPS = new Set(["as", "value", "select"]);

/**
 * Everything `<Let>` decides from what the author wrote (spec §6.5).
 *
 * Which source a `<Let>` has — rendered content or a named value — is read from
 * presence rather than from a resolved value, so a construct naming both
 * sources evaluates neither. Expansion reports the first of these and stops,
 * which is what it has always done; the whole list exists so validation can
 * report each one where it sits.
 */
export function letViolations(segment: ComponentElement): StructuralViolation[] {
  const found: StructuralViolation[] = [];
  const written = authoredPropNames(segment);
  if (written.some((name) => !LET_PROPS.has(name))) {
    found.push(
      violation(
        "structural-usage-invalid",
        "Let",
        '<Let> only accepts "as", "value" and "select" props.',
      ),
    );
  }

  if ("as" in segment.expressions) {
    found.push(
      violation(
        "binding-invalid",
        "Let",
        '<Let as={...}> is invalid: "as" must be a string literal.',
      ),
    );
  } else if (segment.props.as === undefined) {
    found.push(
      violation("binding-invalid", "Let", '<Let> requires an "as" prop (non-empty string).'),
    );
  } else {
    const asBinding = validateBindingName(segment.props.as);
    if (!asBinding.ok) {
      found.push(violation("binding-invalid", "Let", asBinding.error.message));
    } else if (asBinding.value === undefined) {
      found.push(
        violation("binding-invalid", "Let", '<Let> requires an "as" prop (non-empty string).'),
      );
    }
  }

  // Presence, not the resolved value: `value={undefined}` names the direct
  // source exactly as `value={42}` does, and a whitespace child is a body.
  const hasValue = "value" in segment.props || "value" in segment.expressions;
  const hasSelect = "select" in segment.props || "select" in segment.expressions;
  const hasChildren = segment.children.length > 0;

  if (hasValue && hasChildren) {
    found.push(
      violation(
        "structural-usage-invalid",
        "Let",
        '<Let> has one source. Remove the children or the "value" prop: ' +
          '<Let as="x">...</Let> binds what its body renders, and ' +
          '<Let as="x" value={...} /> binds the value itself.',
      ),
    );
  }
  if (hasValue && hasSelect) {
    found.push(
      violation(
        "structural-usage-invalid",
        "Let",
        '<Let> "select" extracts from rendered content, so it cannot be written with "value".',
      ),
    );
  }
  if (!hasValue && !hasChildren) {
    found.push(
      violation(
        "structural-usage-invalid",
        "Let",
        '<Let> must have content or a "value" prop. Use <Let as="x">...</Let> or ' +
          '<Let as="x" value={...} />.',
      ),
    );
  }
  return found;
}

/** The binding name a well-formed `<Let>` writes into. */
export function letBindingName(segment: ComponentElement): string | undefined {
  const binding = validateBindingName(segment.props.as);
  return binding.ok ? binding.value : undefined;
}

const EACH_PROPS = new Set(["in", "let", "as"]);

/**
 * Everything `<Each>` decides from what the author wrote (spec §6.5).
 *
 * The `in` prop is here only when it is a literal: an expression is a value the
 * document computes, and whether it produced an array is expansion's to find
 * out. `eachItemsViolation()` below is the same rule applied to that answer.
 */
export function eachViolations(segment: ComponentElement): StructuralViolation[] {
  const found: StructuralViolation[] = [];
  const unknownProp = authoredPropNames(segment).find((name) => !EACH_PROPS.has(name));
  if (unknownProp !== undefined) {
    found.push(
      violation(
        "structural-usage-invalid",
        "Each",
        `<Each> only accepts "in", "let", and "as" props. Got: "${unknownProp}".`,
      ),
    );
  }

  if ("let" in segment.expressions) {
    found.push(
      violation("binding-invalid", "Each", 'Prop "let" on <Each /> must be a string literal.'),
    );
  } else if (segment.props.let === undefined) {
    found.push(
      violation("binding-invalid", "Each", '<Each> requires a "let" prop (the item binding name).'),
    );
  } else {
    const letBinding = validateBindingName(segment.props.let);
    if (!letBinding.ok) {
      found.push(
        violation("binding-invalid", "Each", `Prop "let" on <Each /> ${letBinding.error.message}`),
      );
    } else if (letBinding.value === undefined) {
      found.push(
        violation(
          "binding-invalid",
          "Each",
          '<Each> requires a "let" prop (the item binding name).',
        ),
      );
    }
  }

  if ("as" in segment.expressions) {
    found.push(
      violation("binding-invalid", "Each", 'Prop "as" on <Each /> must be a string literal.'),
    );
  } else {
    const asResult = validateBindingName(segment.props.as);
    if (!asResult.ok) {
      found.push(
        violation("binding-invalid", "Each", `Prop "as" on <Each /> ${asResult.error.message}`),
      );
    }
  }

  if ("in" in segment.props) {
    const items = eachItemsViolation(segment.props.in);
    if (items !== undefined) {
      found.push(items);
    }
  } else if (!("in" in segment.expressions)) {
    found.push(
      violation(
        "structural-usage-invalid",
        "Each",
        '<Each> requires an "in" prop (the array to iterate).',
      ),
    );
  }
  return found;
}

/** The item binding a well-formed `<Each>` writes each element into. */
export function eachItemBinding(segment: ComponentElement): string | undefined {
  const binding = validateBindingName(segment.props.let);
  return binding.ok ? binding.value : undefined;
}

/** The capture a well-formed `<Each as>` writes its whole rendering into. */
export function eachCaptureBinding(segment: ComponentElement): string | undefined {
  const binding = validateBindingName(segment.props.as);
  return binding.ok ? binding.value : undefined;
}

/** What `<Each in>` says about a value that is not an array. */
export function eachItemsViolation(items: Json | undefined): StructuralViolation | undefined {
  return Array.isArray(items)
    ? undefined
    : violation(
        "structural-usage-invalid",
        "Each",
        'Prop "in" on <Each /> must resolve to an array.',
      );
}

const IF_PROPS = new Set(["condition"]);

/** The one prop `<If>` accepts, decided from what was written. */
export function ifPropsViolation(segment: ComponentElement): StructuralViolation | undefined {
  const unknownProp = authoredPropNames(segment).find((name) => !IF_PROPS.has(name));
  return unknownProp === undefined
    ? undefined
    : violation(
        "structural-usage-invalid",
        "If",
        `<If> only accepts a "condition" prop. Got: "${unknownProp}".`,
      );
}

/** An `<If>` that names no condition at all names nothing to decide. */
export function ifConditionViolation(segment: ComponentElement): StructuralViolation | undefined {
  return "condition" in segment.props || "condition" in segment.expressions
    ? undefined
    : violation("structural-usage-invalid", "If", '<If> requires a "condition" prop.');
}

function isElse(segment: Segment): segment is ComponentElement {
  return segment.type === "component" && segment.name === "Else";
}

function describeSegment(segment: Segment): string {
  if (segment.type === "component") {
    return `<${segment.name}>`;
  }
  if (segment.type === "codeBlock") {
    return `a \`${segment.language}\` code block`;
  }
  if (segment.type === "execOutput") {
    return "command output";
  }
  if (segment.type === "error") {
    return "an error";
  }
  const text = segment.content.trim().replace(/\s+/g, " ");
  return `text "${text.length > 30 ? `${text.slice(0, 30)}…` : text}"`;
}

/** What an `<Else>` written outside the `<If>` that selects it says. */
export function strayElseMessage(): string {
  return (
    "<Else> must be a direct child of <If>. <Else> is reserved: it never resolves a " +
    "component, and only the <If> it belongs to can select it."
  );
}

/**
 * A structural name written where its construct gives it no meaning.
 *
 * `<Content />` is the one that reaches here in practice: outside an invocation
 * there is nothing to project. Naming it reserved is the point — a repository
 * file called `Content.md` does not stand in for the syntax.
 */
export function strayStructuralMessage(name: string): string {
  const detail =
    name === "Content"
      ? `<${name} /> renders the content its invocation was given, so it means something ` +
        "only inside a component's body."
      : `<${name} /> is part of a construct that is not open here.`;
  return (
    `${detail} <${name}> is reserved: it never resolves a component, so a repository ` +
    `file named ${name} cannot supply it.`
  );
}

function elseElementViolations(segment: ComponentElement): StructuralViolation[] {
  const found: StructuralViolation[] = [];
  const names = authoredPropNames(segment);
  if (names.length > 0) {
    found.push(
      violation(
        "structural-usage-invalid",
        "Else",
        `<Else> accepts no props. Got: "${names[0]}".`,
        segment,
      ),
    );
  }
  if (segment.selfClosing || segment.children.length === 0) {
    found.push(
      violation(
        "structural-usage-invalid",
        "Else",
        "<Else> must have content. Use <Else>...</Else>.",
        segment,
      ),
    );
  }
  return found;
}

/**
 * Every `<Else>` below an `<If>` that is not one of its direct children. The
 * walk stops at a nested `<If>`, which owns the `<Else>` elements beneath it.
 */
function misplacedElseViolations(children: Segment[]): StructuralViolation[] {
  const found: StructuralViolation[] = [];

  const walk = (segments: Segment[], depth: number): void => {
    for (const segment of segments) {
      if (segment.type !== "component" || segment.name === "If") {
        continue;
      }
      if (segment.name === "Else" && depth > 0) {
        found.push(violation("structural-usage-invalid", "Else", strayElseMessage(), segment));
      }
      walk(segment.children, depth + 1);
    }
  };

  walk(children, 0);
  return found;
}

/**
 * Content written after `</Else>` belongs to neither branch.
 *
 * A component carries its own position; anything else is anchored to the
 * `<Else>` it follows, which is the boundary the author crossed.
 */
function trailingContentViolation(
  segment: Segment,
  elseElement: ComponentElement,
): StructuralViolation {
  const anchor = segment.type === "component" ? segment : elseElement;
  return violation(
    "structural-usage-invalid",
    "Else",
    `<Else> must be the final substantive child of <If>. Found ${describeSegment(segment)} ` +
      "after </Else>.",
    anchor,
  );
}

/** How an `<If>` body splits at its `<Else>`, and what the split got wrong. */
export interface IfStructure {
  readonly violations: StructuralViolation[];
  readonly whenTrue: Segment[];
  readonly whenFalse: Segment[];
  /**
   * The `<Else>` element, and where it sat among the `<If>`'s children.
   *
   * `<Else>` is consumed by its `<If>` and never reaches expansion's dispatch,
   * so it would contribute no frame of its own — and the two arms of one `<If>`
   * would expand under the same path (§5.6).
   */
  readonly elseElement?: ComponentElement;
  readonly elseIndex?: number;
}

/**
 * Split an `<If>` body at its `<Else>` and validate the split. Structure is
 * read from source, before either branch expands, so a malformed `<Else>` is
 * diagnosed even when it sits in the branch the condition does not select.
 *
 * `<If>` has exactly two branches, so `<Else>` is the final substantive child:
 * content after `</Else>` belongs to neither branch and is rejected rather than
 * silently folded into the true one.
 */
export function ifStructure(segment: ComponentElement): IfStructure {
  const violations: StructuralViolation[] = [];
  const whenTrue: Segment[] = [];
  let whenFalse: Segment[] | undefined;
  let elseElement: ComponentElement | undefined;
  let elseIndex: number | undefined;

  for (const [index, child] of segment.children.entries()) {
    if (isElse(child)) {
      if (elseElement) {
        violations.push(
          violation(
            "structural-usage-invalid",
            "Else",
            "<If> accepts at most one <Else> branch.",
            child,
          ),
        );
        continue;
      }
      violations.push(...elseElementViolations(child));
      elseElement = child;
      elseIndex = index;
      whenFalse = child.children;
      continue;
    }
    if (!elseElement) {
      whenTrue.push(child);
      continue;
    }
    if (!isBlankText(child)) {
      violations.push(trailingContentViolation(child, elseElement));
    }
  }

  violations.push(...misplacedElseViolations(segment.children));
  return {
    violations,
    whenTrue,
    whenFalse: whenFalse ?? [],
    ...(elseElement === undefined ? {} : { elseElement, elseIndex }),
  };
}

const LOOP_PROPS = new Set(["max", "name"]);

/** How a `<Loop>` names itself in its own printed errors. */
export function loopTag(segment: ComponentElement): string {
  const name = segment.props.name;
  return typeof name === "string" && name.length > 0 ? `<Loop name="${name}">` : "<Loop>";
}

function jsonKind(value: Json): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return "an object";
  }
  return `a ${typeof value}`;
}

/** The one prop set `<Loop>` accepts, decided from what was written. */
export function loopPropsViolation(segment: ComponentElement): StructuralViolation | undefined {
  const unknownProp = authoredPropNames(segment).find((name) => !LOOP_PROPS.has(name));
  return unknownProp === undefined
    ? undefined
    : violation(
        "structural-usage-invalid",
        "Loop",
        `<Loop> only accepts "max" and "name" props. Got: "${unknownProp}".`,
      );
}

/**
 * The bound a `<Loop>` runs to, or why `max` rejects it.
 *
 * The same rule wherever the value came from: a literal `max` is checked here
 * while the document is only being read, and an expression's answer is checked
 * here too once expansion has evaluated it.
 */
export function loopBound(segment: ComponentElement, max: Json): Result<number> {
  if (typeof max !== "number") {
    return Err(
      new Error(
        `Prop "max" on ${loopTag(segment)} must be a positive integer, not ${jsonKind(max)}.`,
      ),
    );
  }
  if (!Number.isInteger(max) || max < 1) {
    return Err(
      new Error(
        `Prop "max" on ${loopTag(segment)} must be a positive integer. Got: ${JSON.stringify(max)}.`,
      ),
    );
  }
  return Ok(max);
}

/** What a `<Loop>` naming no bound at all says. */
export function loopMissingBoundMessage(segment: ComponentElement): string {
  return (
    `${loopTag(segment)} requires a "max" prop (a positive integer). Repetition is ` +
    "always bounded — there is no unbounded loop."
  );
}

/**
 * Everything `<Loop>` decides from what the author wrote (spec §6.5).
 *
 * A `max` written as an expression is a value the document computes, so its
 * bound is expansion's to check with `loopBound()` once it has one.
 */
export function loopViolations(segment: ComponentElement): StructuralViolation[] {
  const found: StructuralViolation[] = [];
  const unknown = loopPropsViolation(segment);
  if (unknown !== undefined) {
    found.push(unknown);
  }
  if ("max" in segment.props) {
    const bound = loopBound(segment, segment.props.max);
    if (!bound.ok) {
      found.push(violation("structural-usage-invalid", "Loop", bound.error.message));
    }
  } else if (!("max" in segment.expressions)) {
    found.push(violation("structural-usage-invalid", "Loop", loopMissingBoundMessage(segment)));
  }
  return found;
}

/** What a `<Break>` element itself got wrong, as expansion words it. */
export function breakElementViolations(segment: ComponentElement): string[] {
  const violations: string[] = [];
  const names = authoredPropNames(segment);
  if (names.length > 0) {
    violations.push(`<Break> accepts no props. Got: "${names[0]}".`);
  }
  if (!segment.selfClosing || segment.children.length > 0) {
    violations.push("<Break> takes no content. Write it self-closing: <Break />.");
  }
  return violations;
}

/** What a `<Break>` written outside every `<Loop>` says. */
export function strayBreakMessage(): string {
  return (
    "<Break> must be written inside a <Loop>. <Break> is reserved: it never resolves a " +
    "component, and a <Break> a component writes in its own body cannot break the loop " +
    "that invoked it."
  );
}

/**
 * Everything `<Break>` decides from what the author wrote and from where it was
 * written (spec §6.5).
 *
 * Whether a `<Loop>` encloses it is lexical, so it is decided here too: a
 * `<Break>` written in a component's own body cannot break the loop that
 * invoked that component, however the run reaches it.
 */
export function breakViolations(
  segment: ComponentElement,
  insideLoop: boolean,
): StructuralViolation[] {
  const messages = breakElementViolations(segment);
  if (!insideLoop) {
    messages.unshift(strayBreakMessage());
  }
  return messages.map((message) => violation("structural-usage-invalid", "Break", message));
}

/**
 * `<PrintErrors>` names a region and nothing else, so it takes no props at all
 * — including `as` and `slot`, which are ordinary prop entries here rather than
 * fields of their own.
 */
export function printErrorsViolations(segment: ComponentElement): StructuralViolation[] {
  const names = authoredPropNames(segment);
  return names.length === 0
    ? []
    : [
        violation(
          "structural-usage-invalid",
          "PrintErrors",
          `<PrintErrors> accepts no props. Got: "${names[0]}".`,
        ),
      ];
}

/** What an `<Answer>` written outside the `<Answers>` that reads it says. */
export function strayAnswerMessage(): string {
  return (
    "<Answer> must be a direct child of <Answers>. It is reserved: it never resolves a " +
    "component, and only the <Answers> it belongs to can read it."
  );
}

/** What an unexpected prop on `<Answers>` says. */
export function answersPropMessage(name: string): string {
  return `<Answers> does not accept a "${name}" prop (allowed: delegate).`;
}

/** What a `delegate` that is not a boolean says, wherever the value came from. */
export function answersDelegateMessage(described: string): string {
  return `<Answers> delegate must be a boolean — ${described}`;
}

/** What a literal `delegate` that is not a boolean says. */
export function answersLiteralDelegateMessage(raw: Json): string {
  return answersDelegateMessage(`write delegate={true}, not delegate=${JSON.stringify(raw)}.`);
}

/** What an `<Answers>` with nothing to answer for says. */
export function answersNoBodyMessage(): string {
  return (
    "<Answers> has no body to answer for. It wraps the region whose elicitations it " +
    "answers, so an <Answers> containing only matchers can never do anything."
  );
}

/**
 * Everything `<Answers>` decides from what the author wrote (spec §6.16.2).
 *
 * A `delegate` written as an expression is a value the document computes;
 * whether it came back a boolean is expansion's to find out. The body check is
 * static: matchers are `<Answer>` children, and what is left over is the region
 * the element answers for.
 */
export function answersViolations(segment: ComponentElement): StructuralViolation[] {
  const found: StructuralViolation[] = [];
  for (const name of authoredPropNames(segment)) {
    if (name !== "delegate") {
      found.push(violation("structural-usage-invalid", "Answers", answersPropMessage(name)));
    }
  }
  if (!("delegate" in segment.expressions) && "delegate" in segment.props) {
    const raw = segment.props.delegate;
    if (typeof raw !== "boolean") {
      found.push(
        violation("structural-usage-invalid", "Answers", answersLiteralDelegateMessage(raw)),
      );
    }
  }
  const body = segment.children.filter(
    (child) => !(child.type === "component" && child.name === "Answer"),
  );
  if (segment.selfClosing || body.every(isBlankText)) {
    found.push(violation("structural-usage-invalid", "Answers", answersNoBodyMessage()));
  }
  return found;
}

/** What an unexpected prop on `<Answer>` says. */
export function answerPropMessage(name: string): string {
  return `<Answer> does not accept a "${name}" prop (allowed: template, value).`;
}

/** What an `<Answer template={…}>` says. */
export function answerTemplateExpressionMessage(): string {
  return (
    "<Answer> template must be a literal string prop or template children, not an " +
    "expression. Write the bindings a template references as {binding} holes inside it."
  );
}

/** What an `<Answer>` writing its template twice says. */
export function answerTemplateBothMessage(): string {
  return "<Answer> accepts either a template prop or template children, not both.";
}

/** What an `<Answer>` supplying nothing says. */
export function answerMissingValueMessage(): string {
  return '<Answer> requires a "value" prop.';
}

/**
 * Everything one `<Answer>` matcher decides from what the author wrote.
 *
 * The template itself is not parsed here when it is written as children: those
 * children render, and rendering is expansion's. A literal `template` prop is a
 * string the author wrote, so the rest of the matcher's shape is decided from
 * presence alone.
 */
export function answerViolations(segment: ComponentElement): StructuralViolation[] {
  const found: StructuralViolation[] = [];
  for (const name of authoredPropNames(segment)) {
    if (name !== "template" && name !== "value") {
      found.push(violation("structural-usage-invalid", "Answer", answerPropMessage(name)));
    }
  }
  if ("template" in segment.expressions) {
    found.push(violation("structural-usage-invalid", "Answer", answerTemplateExpressionMessage()));
  }
  const hasChildren = !segment.selfClosing && segment.children.length > 0;
  if (typeof segment.props.template === "string" && hasChildren) {
    found.push(violation("structural-usage-invalid", "Answer", answerTemplateBothMessage()));
  }
  if (!("value" in segment.props) && !("value" in segment.expressions)) {
    found.push(violation("structural-usage-invalid", "Answer", answerMissingValueMessage()));
  }
  return found;
}
