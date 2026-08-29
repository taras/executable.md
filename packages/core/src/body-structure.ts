/**
 * The body contract a definition's own source states (spec §6.9, §6.10).
 *
 * A body either renders markdown, in which case `<Output>` may restrict what it
 * renders and `<Return>` has no declaration to satisfy, or it declares
 * `returns`, in which case it renders nothing and produces exactly one value.
 * Which one it is, and what the source got wrong about it, is read from the
 * body's own segment tree and from nothing else — before `<Content />`
 * substitution, so projected content can neither introduce nor satisfy a
 * declaration.
 *
 * The facts are separated from the sentences here because two callers need
 * different things from one rule. Expansion needs the aggregate printed error
 * it has always produced, and renders it below. Validation needs each violation
 * on its own, at the position it was authored, under its own code. Both read
 * the same walk and the same catalog, so a body cannot be acceptable to one and
 * refused by the other.
 */

import type { ComponentElement, ReturnsSchema, Segment, TextSegment } from "./types.ts";
import type { ErrorSegment } from "./types.ts";

/** One thing a `<Return>` element itself got wrong. */
export interface ReturnElementViolation {
  readonly element: ComponentElement;
  readonly message: string;
}

/**
 * What one body's source says about its own output and return contract.
 *
 * Every member is the *violations* found, so an empty set of facts is a body
 * whose structure holds. Which members can be populated depends on the mode:
 * the two are exclusive contracts, not two halves of one.
 */
export interface BodyStructureFacts {
  readonly mode: "text" | "value";
  /** Text mode: every `<Output>` written below the top level. */
  readonly misplacedOutputs: readonly ComponentElement[];
  /** Text mode: every `<Return>` a body with no `returns` declaration wrote. */
  readonly undeclaredReturns: readonly ComponentElement[];
  /** Value mode: every `<Output>`, at any depth — `returns` excludes all of them. */
  readonly exclusiveOutputs: readonly ComponentElement[];
  /** Value mode: the body declares `returns` and writes no `<Return>` at all. */
  readonly missingReturn: boolean;
  /** Value mode: what each `<Return>` element itself got wrong. */
  readonly returnViolations: readonly ReturnElementViolation[];
}

function isTopLevelOutput(segment: Segment): boolean {
  return segment.type === "component" && segment.name === "Output";
}

export function bodyHasOutput(bodySegments: Segment[]): boolean {
  return bodySegments.some(isTopLevelOutput);
}

/** Every `<Output>` at or below `minimumDepth`, in source order. */
function collectOutputs(bodySegments: Segment[], minimumDepth: number): ComponentElement[] {
  const found: ComponentElement[] = [];
  const walk = (segments: Segment[], depth: number): void => {
    for (const segment of segments) {
      if (segment.type !== "component") {
        continue;
      }
      if (segment.name === "Output" && depth >= minimumDepth) {
        found.push(segment);
      }
      walk(segment.children, depth + 1);
    }
  };
  walk(bodySegments, 0);
  return found;
}

/**
 * Every `<Return>` the body itself declares, at any depth.
 *
 * Depth is not a violation: a return under `<If>` or inside a `<Loop>` is
 * written in the body's own flow and is reached by ordinary expansion. What
 * this walk does not see is the only thing that still cannot declare one —
 * another component's definition, and markdown produced at runtime — because
 * it reads this body's source AST and nothing else.
 */
function collectReturns(bodySegments: Segment[]): ComponentElement[] {
  const declared: ComponentElement[] = [];

  const walk = (segments: Segment[]): void => {
    for (const segment of segments) {
      if (segment.type !== "component") {
        continue;
      }
      if (segment.name === "Return") {
        declared.push(segment);
      }
      walk(segment.children);
    }
  };

  walk(bodySegments);
  return declared;
}

export function previewOutput(segment: ComponentElement): string {
  const text = segment.children
    .filter((child): child is TextSegment => child.type === "text")
    .map((child) => child.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) {
    return "<Output> (empty)";
  }
  const clipped = text.slice(0, 40);
  return `<Output> containing "${clipped}${text.length > 40 ? "…" : ""}"`;
}

export function previewReturn(segment: ComponentElement): string {
  if ("value" in segment.expressions) {
    return `<Return value={${segment.expressions.value}} />`;
  }
  if ("value" in segment.props) {
    return `<Return value=${JSON.stringify(segment.props.value)} />`;
  }
  return "<Return />";
}

function returnElementViolations(segment: ComponentElement): string[] {
  const violations: string[] = [];
  const names = [...Object.keys(segment.props), ...Object.keys(segment.expressions)];
  const extra = names.filter((name) => name !== "value");
  if (extra.length > 0) {
    violations.push(`${previewReturn(segment)} accepts only a "value" prop, got "${extra[0]}"`);
  }
  if (!names.includes("value")) {
    violations.push(`${previewReturn(segment)} requires a "value" prop`);
  }
  if (segment.children.length > 0) {
    violations.push(`${previewReturn(segment)} takes no children`);
  }
  return violations;
}

/**
 * Read one body's output and return contract from its own source AST.
 *
 * Pure, and free of effects: nothing here evaluates an expression, resolves a
 * name, or reads a file, so the same body always produces the same facts.
 */
export function bodyStructureFacts(
  bodySegments: Segment[],
  returns: ReturnsSchema | undefined,
): BodyStructureFacts {
  if (returns !== undefined) {
    const declared = collectReturns(bodySegments);
    const returnViolations: ReturnElementViolation[] = [];
    for (const element of declared) {
      for (const message of returnElementViolations(element)) {
        returnViolations.push({ element, message });
      }
    }
    return {
      mode: "value",
      misplacedOutputs: [],
      undeclaredReturns: [],
      exclusiveOutputs: collectOutputs(bodySegments, 0),
      missingReturn: declared.length === 0,
      returnViolations,
    };
  }
  return {
    mode: "text",
    misplacedOutputs: collectOutputs(bodySegments, 1),
    undeclaredReturns: collectReturns(bodySegments),
    exclusiveOutputs: [],
    missingReturn: false,
    returnViolations: [],
  };
}

/** Whether these facts describe a body whose structure is refused. */
export function hasBodyStructureViolation(facts: BodyStructureFacts): boolean {
  return (
    facts.misplacedOutputs.length > 0 ||
    facts.undeclaredReturns.length > 0 ||
    facts.exclusiveOutputs.length > 0 ||
    facts.missingReturn ||
    facts.returnViolations.length > 0
  );
}

function structureError(source: string, headline: string, violations: string[]): ErrorSegment {
  const list = violations.map((entry) => `  - ${entry}`).join("\n");
  return { type: "error", message: `${headline}\n${list}`, source };
}

function misplacedOutputAggregate(
  misplaced: readonly ComponentElement[],
): ErrorSegment | undefined {
  if (misplaced.length === 0) {
    return undefined;
  }
  const list = misplaced.map((segment) => `  - ${previewOutput(segment)}`).join("\n");
  return {
    type: "error",
    message:
      "<Output> must be a direct top-level child of the component or document " +
      "that declares it. For conditional rendering, use <If> inside " +
      `<Output>. Misplaced <Output> found:\n${list}`,
    source: "Output",
  };
}

/**
 * The one printed error expansion has always produced for these facts, or
 * `undefined` when the body's structure holds.
 *
 * A renderer over the facts rather than a second walk: what it says is
 * unchanged, and what it says it about is decided once, above.
 */
export function renderBodyStructure(facts: BodyStructureFacts): ErrorSegment | undefined {
  if (facts.mode === "value") {
    const violations: string[] = [];
    for (const segment of facts.exclusiveOutputs) {
      violations.push(`${previewOutput(segment)} — <Output> and \`returns\` are exclusive`);
    }
    if (facts.missingReturn) {
      violations.push("no <Return>");
    }
    for (const violation of facts.returnViolations) {
      violations.push(violation.message);
    }
    if (violations.length === 0) {
      return undefined;
    }
    return structureError(
      "Return",
      "A component that declares `returns` renders nothing and produces exactly one " +
        "value through a <Return> its own body executes. Problems found:",
      violations,
    );
  }

  const outputError = misplacedOutputAggregate(facts.misplacedOutputs);
  const returnError =
    facts.undeclaredReturns.length === 0
      ? undefined
      : structureError(
          "Return",
          "<Return> requires a document or component that declares `returns`. Declare a " +
            "return schema, or remove <Return>. Found:",
          facts.undeclaredReturns.map(previewReturn),
        );
  if (outputError && returnError) {
    return {
      type: "error",
      message: `${outputError.message}\n\n${returnError.message}`,
      source: "Return",
    };
  }
  return outputError ?? returnError;
}

/**
 * Structural preflight (spec §6.9). Validates `<Output>` placement against the
 * body's own source AST. Only a direct top-level `<Output>` is a valid
 * declaration; any `<Output>` at depth > 0 — including inside unreachable or
 * discarded children — is a placement violation. All violations are combined
 * into a single aggregate ErrorSegment. Returns undefined when placement is
 * valid.
 */
export function validateOutputPlacement(bodySegments: Segment[]): ErrorSegment | undefined {
  return misplacedOutputAggregate(collectOutputs(bodySegments, 1));
}

/**
 * Structural preflight for a body's output and return contract (spec §6.9,
 * §6.10). Runs against the body's own source AST, before `<Content />`
 * substitution, so projected content can neither introduce nor satisfy a
 * declaration. Every violation is combined into a single ErrorSegment, and a
 * body whose structure is invalid runs no eval, exec, `<Let>`, or nested
 * component.
 */
export function validateBodyStructure(
  bodySegments: Segment[],
  returns: ReturnsSchema | undefined,
): ErrorSegment | undefined {
  return renderBodyStructure(bodyStructureFacts(bodySegments, returns));
}

/** What a misplaced `<Output>` reaching expansion's dispatch says. */
export function misplacedOutputMessage(): string {
  return (
    "<Output> must be a direct top-level child of the component or document " +
    "that declares it. For conditional rendering, use <If> inside <Output>."
  );
}

/** What a `<Return>` written outside a value body's flow says. */
export function misplacedReturnMessage(segment: ComponentElement): string {
  return (
    `${previewReturn(segment)} is not written in the flow of a body that declares ` +
    "`returns`, so there is no declaration for it to satisfy. <Return> is reserved: " +
    "it never resolves a component, and neither markdown produced at runtime nor " +
    "another component's body can declare one."
  );
}

/** What an `<Output>` carrying props says, or `undefined` when it carries none. */
export function outputPropsViolation(segment: ComponentElement): string | undefined {
  const hasProps = Object.keys(segment.props).length > 0;
  const hasExpressions = Object.keys(segment.expressions).length > 0;
  return hasProps || hasExpressions ? "<Output> accepts no props." : undefined;
}
