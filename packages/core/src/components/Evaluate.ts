/**
 * `<Evaluate>` — the composition site where a complete XMD program runs
 * (specs/executable-mdx-spec.md §5.7).
 *
 * `<Plan>` produces a program and never runs it. This is where an author says
 * that it should run, and the two ways of saying so are the two forms of this
 * element:
 *
 * ```md
 * <Evaluate>
 *   <Plan>Inspect the release inputs and recommend a version.</Plan>
 * </Evaluate>
 * ```
 *
 * ```md
 * <Plan as="plan">Inspect the release inputs and recommend a version.</Plan>
 *
 * <Evaluate program={plan} />
 * ```
 *
 * Paired content is a private program buffer, not a quotation. Whatever is
 * written inside runs under ordinary XMD semantics while it produces text, and
 * that text is what admission is offered — none of it reaches the surrounding
 * document. Any source-producing component may be used there, provided what it
 * renders is a complete admissible root.
 *
 * ## The forms are disjoint, and ambiguity refuses first
 *
 * `program` and paired content are mutually exclusive, and one of them is
 * required. Both together, and neither, are refused from the element's own
 * shape — read from the invocation canonical execution issued — before any
 * content is produced and before the durable admission exists. A program that
 * would have been produced by rendering the content is not produced, so an
 * ambiguous element performs nothing at all.
 *
 * ## What it answers with
 *
 * Whatever the program's own root contract says. A text root's selected output
 * is the element's rendered result, or the string bound by `as`; a value root's
 * schema-validated result is bound by `as`, which it requires. The engine
 * decides between rendering and binding exactly as it does for any component,
 * so this returns the one value and says nothing about where it goes.
 *
 * Deliberately not wrapped in `printErrors`. A refused or failed program stops
 * the document unless the author put a recovery boundary around it: a program
 * that did not run must not become text a later step reads as though it had.
 */

import type { Operation } from "effection";

import { content, hasBinding } from "../component-api.ts";
import { getExpansion } from "../expansion.ts";
import { isJsonObject } from "../json.ts";
import {
  evaluateProgram,
  pairedProgramSource,
  ProgramEvaluationError,
} from "../program-evaluation.ts";
import type { ComponentInvocation, IdentityClaimant } from "../invocation-identity.ts";
import type { FunctionComponent, Json, JsonObject, PropsSchema } from "../types.ts";
import type { IdentityComponent } from "../invocation-identity.ts";

/** The origin that identifies this component wherever it is declared. */
export const EVALUATE_ORIGIN = "@executablemd/core/program";

/**
 * The complete-program half of `<Evaluate>`'s schema.
 *
 * Shared with the workflow host, which adds its restricted-fragment props to
 * these rather than restating them: two hand-written copies of one schema are
 * two schemas, and no test catches the day they stop agreeing.
 */
export const programProperties: Record<string, Json> = {
  program: { type: "string" },
  props: { type: "object" },
};

/** The whole schema an ordinary run's `<Evaluate>` accepts. */
export const props: PropsSchema = {
  type: "object",
  properties: { ...programProperties },
  additionalProperties: false,
};

/** What the catalog and the syntax reference say this component is for. */
export const EVALUATE_DESCRIPTION =
  "Evaluate XMD source in the current execution. `<Evaluate program={plan} />` evaluates a " +
  "complete program.";

/**
 * Which complete-program form this element is, or why it is neither.
 *
 * Decided from the authored shape and the props alone. It reads no content,
 * performs nothing, and is what every host calls before a program can exist —
 * so a misplaced or ambiguous combination is refused at the same point whatever
 * else that host also accepts.
 */
export function selectProgramForm(
  elementProps: Record<string, Json>,
  written: boolean,
  /** What a host with a wider grammar calls an element that names nothing. */
  absent: string = "<Evaluate> evaluates a program written as its content or supplied as `program`.",
): "content" | "program" {
  const supplied = elementProps.program;
  if (supplied !== undefined && written) {
    throw new ProgramEvaluationError(
      "<Evaluate> takes a program either as `program` or as its content, not both.",
    );
  }
  if (supplied === undefined && !written) {
    throw new ProgramEvaluationError(absent);
  }
  if (supplied === undefined) {
    return "content";
  }
  if (typeof supplied !== "string") {
    throw new ProgramEvaluationError("<Evaluate> takes `program` as complete XMD program source.");
  }
  return "program";
}

/**
 * The root props this element supplies, defaulting to none.
 *
 * A program receives what the site wrote here and nothing else. The caller's
 * own root props are not adopted, silently or otherwise: a program that needs
 * them is written at a site that passes them.
 */
export function programProps(value: Json | undefined): JsonObject {
  if (value === undefined) {
    return {};
  }
  if (!isJsonObject(value)) {
    throw new ProgramEvaluationError("<Evaluate> takes `props` as an object.");
  }
  return value;
}

/**
 * Evaluate the program this element names, in the current execution.
 *
 * Shared by every host that exposes the complete-program forms, so the
 * admission, the retained terms and the refusals are one implementation rather
 * than one per profile.
 *
 * `claim` is spent on the invocation the engine handed over, in the frame it
 * handed it over in: the durable identity of this evaluation is this element's
 * own invocation, so a continuation restores the program this position admitted
 * rather than whichever one a later turn happens to hold.
 */
export function* evaluateProgramElement(
  elementProps: Record<string, Json>,
  invocation: ComponentInvocation,
  claim: IdentityClaimant,
  /** What a host with a wider grammar calls an element that names nothing. */
  absent?: string,
): Operation<Json> {
  const rootProps = programProps(elementProps.props);

  // Claimed before the authored shape is read, because reading it is only
  // meaningful once the invocation has been authenticated. The claimant answers
  // for an invocation this execution minted where resolution selected this
  // implementation, and for nothing a handler routed here from elsewhere — so
  // an element's own form is what the claim proved it was, never what a
  // borrowed invocation reports about somebody else's element.
  const id = yield* claim(invocation);

  const form = selectProgramForm(elementProps, invocation.hasContent(), absent);
  const captured = yield* hasBinding();
  const expansion = yield* getExpansion();

  // Produced only once the element's shape has been accepted, so an ambiguous
  // one renders no producer and performs none of its effects.
  //
  // A paired buffer gives up the framing its wrapper contributed and nothing
  // else; `program` is exact supplied source, so whitespace an author put at
  // either end of it is part of the program and stays there.
  const source =
    form === "content" ? pairedProgramSource(yield* content()) : String(elementProps.program);

  const outcome = yield* evaluateProgram({
    id,
    source,
    props: rootProps,
    origin: expansion.position?.path ?? "",
    captured,
    ...(expansion.position === undefined ? {} : { position: expansion.position }),
  });

  return outcome.kind === "value" ? outcome.value : outcome.output;
}

/**
 * What a host declares to an execution for one attachment.
 *
 * `<Evaluate>` is not registered with ordinary components: its implementation
 * names durable work after its own invocation, so canonical execution builds it
 * from the claimant it minted (executable-mdx-spec §5.6). A run whose host
 * declares none has no `<Evaluate>` at all.
 */
export function programEvaluationComponents(): readonly IdentityComponent[] {
  return [
    {
      name: "Evaluate",
      origin: EVALUATE_ORIGIN,
      description: EVALUATE_DESCRIPTION,
      props,
      factory: (claim: IdentityClaimant): FunctionComponent =>
        function* Evaluate(
          elementProps: Record<string, Json>,
          invocation: ComponentInvocation,
        ): Operation<Json> {
          return yield* evaluateProgramElement(elementProps, invocation, claim);
        },
    },
  ];
}
