/**
 * Evaluating a complete XMD program at an explicit composition site
 * (specs/executable-mdx-spec.md §5.7).
 *
 * Producing a program and running one are separate choices. `<Plan>` produces
 * approved source and never runs it; this is the operation an author writes
 * where that source should run, either around the producer or later against
 * what it bound:
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
 * ## It is a composition site, not a child document
 *
 * The program runs in the current execution: its lifecycle, its journal, its
 * cancellation scope, its contextual providers, its working directory, and the
 * authority already in force where the element was written. There is no child
 * process, no second host profile, no second root lifecycle and no journal of
 * its own. Program source *requests* behavior; it grants none.
 *
 * What does not cross is the producer's temporary authority. By the time a
 * program is admitted, `<Plan>`'s authorship profile and its private phases
 * have torn down, and a private component belonging to an enclosing
 * declaration answers only for elements that declaration's exact bytes
 * authored. Source a producer returned can invoke neither.
 *
 * ## The root's own contract applies
 *
 * The admitted source is a root, so its frontmatter, imports, metadata, props
 * schema, `returns` declaration and `<Output>` selection are what decide what
 * it does. A text root renders its selected output where the element was
 * written, or binds that text under `as` and emits none of it. A value root
 * requires `as` and binds its schema-validated result — without one it refuses
 * before the first program effect, because there would be nowhere for the
 * result to go.
 *
 * Root props are the explicit `props` object and default to `{}`. Ambient root
 * props are never adopted: a program that declares `props` states what it needs
 * and receives what the site handed it, validated against its own schema before
 * anything runs.
 *
 * ## Admission is its own durable event
 *
 * Complete programs are not generated fragments, and the two are not one
 * record. `evaluate_program` is this boundary's own durable effect, and the
 * restricted `generated_xmd` admission is left exactly as #369 delivered it.
 *
 * Everything needed to prove the same evaluation is retained before the first
 * program effect: the exact source and its digest, the explicit props, the
 * evaluation-site source origin, the root mode, the components the program
 * names with the forms it writes them in, and whether the result is captured.
 * A partial continuation expands the retained source, restores the nested
 * effects that already committed, and repeats no planning. A changed program at
 * the same evaluation occurrence is stale input: it refuses before either the
 * current or the retained source can run, so neither silently wins.
 *
 * ## The digest is the artifact; the site is the occurrence
 *
 * A source digest identifies the program. The authored element and the loop
 * iteration it was reached through identify one execution of it. Evaluating the
 * same approved program at two sites is two executions with two nested effect
 * identities, and the digest never deduplicates them.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { Json as DurableJson } from "@executablemd/durable-streams";
import type { Operation } from "effection";

import { expandProgram, resolveProgramSite } from "./component-api.ts";
import { sourceDigest } from "./components/declared-markdown.ts";
import { parseRootMarkdownDefinition } from "./definition.ts";
import { validateBodyStructure } from "./expand.ts";
import { isJsonObject, parseJson } from "./json.ts";
import { sourceDescription } from "./source-position.ts";
import { validateProps } from "./validate.ts";
import {
  isProgramComponentForm,
  ProgramEvaluationError,
  readIdentity,
  sameElements,
  UNIDENTIFIED,
} from "./program-identity.ts";
import type {
  ProgramComponent,
  ProgramComponentRef,
  ResolvedProgramComponent,
} from "./program-identity.ts";
import type {
  Json,
  JsonObject,
  ProgramOutcome,
  ReturnsSchema,
  Segment,
  SourcePosition,
} from "./types.ts";

export { ProgramEvaluationError } from "./program-identity.ts";

/** The durable effect type one complete-program evaluation records. */
export const EVALUATE_PROGRAM = "evaluate_program";

/** What the name a diagnostic and a durable record call this program. */
const PROGRAM = "program";

/** The ways a program can be refused, and the only thing a refusal carries. */
type Refused = "source" | "structure" | "props" | "capture";

/**
 * What each refusal says.
 *
 * Named by class rather than by cause. A parser's complaint about approved
 * program source is the one text a diagnostic must not echo back, because a
 * refusal is written into the run's history and the source is somebody else's
 * bytes.
 */
const REFUSAL: Record<Refused, string> = {
  source: "<Evaluate> was given source that is not a complete XMD program.",
  structure: "<Evaluate> was given a program whose body structure is not valid.",
  props: "<Evaluate> was given props the program's own schema refuses.",
  capture:
    "<Evaluate> requires `as` to evaluate a program that declares `returns`: its result has " +
    "nowhere else to go.",
};

/** What a retained admission that cannot be read as one says. */
const UNREADABLE = "the retained complete-program admission record cannot be read as one.";

/**
 * What a changed evaluation says.
 *
 * Stale input, not a divergence: this element is the same occurrence it was,
 * and what it is being asked to evaluate is not what it evaluated. Neither
 * source runs.
 */
const STALE =
  "<Evaluate> was resumed with a different program than the one this evaluation admitted.";

/** A refusal carried as a value rather than thrown out of the admission. */
class Refusal extends Error {
  constructor(readonly refused: Refused) {
    super(REFUSAL[refused]);
  }
}

/** What a trusted host asks this boundary to evaluate. */
export interface ProgramEvaluationRequest {
  /** This evaluation occurrence's durable identity. */
  readonly id: string;
  /** Complete-program source, exactly as the form that supplied it produced it. */
  readonly source: string;
  /** The root props, supplied explicitly. */
  readonly props: JsonObject;
  /** The source origin of the authored element, which relative paths resolve from. */
  readonly origin: string;
  /** Whether the element was written with `as`. */
  readonly captured: boolean;
  /** Where the element was written, as diagnostic journal data. */
  readonly position?: Readonly<SourcePosition>;
}

/**
 * The terms an evaluation is admitted under, and held to on a continuation.
 *
 * The props here are the ones the site supplied, not the ones the program's
 * schema produced from them. What a continuation has to prove is that it is
 * asking for the same evaluation; comparing against defaults the schema filled
 * in would compare the admission with itself.
 */
interface Terms {
  readonly digest: string;
  readonly props: JsonObject;
  readonly origin: string;
  readonly captured: boolean;
}

/** An admitted decision, as the run retains it. */
interface Admitted {
  readonly decision: "admitted";
  readonly source: string;
  readonly mode: "text" | "value";
  readonly named: readonly ProgramComponent[];
  readonly terms: Terms;
  /** The props the program ran with, after its own schema validated them. */
  readonly validated: JsonObject;
}

/** The decision this run recorded, restored from its own durable record. */
type Admission = { readonly decision: "refused"; readonly refused: Refused } | Admitted;

/**
 * The program a paired `<Evaluate>` produced, with the wrapper's framing off.
 *
 * A paired element renders its producer into a private buffer, and the buffer
 * holds two things that belong to the `<Evaluate>` element rather than to the
 * program: the line break after the opening tag with whatever indentation
 * follows it, and the line break before the closing tag with whatever
 * indentation precedes it. Each is removed exactly once. Nothing else is
 * touched — no trimming, no trailing newline added or taken away, and every
 * interior byte the producer emitted survives.
 *
 * Removing exactly one line break at each end is what makes the two
 * compositions of one approved plan agree. `<Plan>` returns source ending in
 * its own newline, so a paired buffer ends with that newline followed by the
 * wrapper's; taking the wrapper's leaves the producer's, and the bytes and the
 * digest are the ones `program={plan}` supplies directly.
 *
 * The shared indentation of the lines after the first is the other half of what
 * a wrapper contributes, and only to a program written out literally: a
 * producer's result is spliced in as one value, so its own lines carry no
 * indentation to share. That is why the first line is excluded — its
 * indentation came off with the leading break.
 *
 * `program={value}` is exact supplied source and passes through none of this.
 */
export function pairedProgramSource(text: string): string {
  const body = text.replace(/^[ \t]*\r?\n[ \t]*/, "").replace(/[ \t]*\r?\n[ \t]*$/, "");
  if (body.length === 0) {
    return "";
  }
  const [first, ...rest] = body.split("\n");
  const indents = rest
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const shared = indents.length === 0 ? 0 : Math.min(...indents);
  if (shared === 0) {
    return body;
  }
  const dedented = rest.map((line) => (line.trim().length === 0 ? line : line.slice(shared)));
  return [first, ...dedented].join("\n");
}

/**
 * The content digest that identifies a program artifact.
 *
 * The same hash a host states about declared Markdown, so what identifies an
 * approved program here and what identifies packaged bytes elsewhere are one
 * function rather than two that agree until they do not.
 */
export function programDigest(source: string): string {
  return sourceDigest(source);
}

/** Every component the program names, with the form each element is written in. */
function elements(
  segments: readonly Segment[],
  found: ProgramComponentRef[],
): ProgramComponentRef[] {
  for (const segment of segments) {
    if (segment.type === "component") {
      found.push({ name: segment.name, form: segment.selfClosing ? "self-closing" : "paired" });
      elements(segment.children, found);
    }
  }
  return found;
}

/**
 * The elements a candidate program writes, or none when it will not parse.
 *
 * Asked before the admission, so the site can be resolved and retained with the
 * decision. A source the parser refuses still reaches the admission, which is
 * where a refusal belongs — so this reports no elements rather than failing.
 */
function* programElements(
  source: string,
  origin: string,
): Operation<readonly ProgramComponentRef[]> {
  try {
    const parsed = yield* parseRootMarkdownDefinition(PROGRAM, origin, source);
    return elements(parsed.definition.bodySegments, []);
  } catch {
    return [];
  }
}

/**
 * Decide this program, once, inside the durable executor.
 *
 * A refusal is returned rather than thrown, for the reason the restricted
 * evaluator returns its own: throwing out of a durable executor journals the
 * error and its stack, and a refusal caused by somebody else's source would put
 * host paths into the run's history to say what one word already says.
 */
function* admitProgram(
  request: ProgramEvaluationRequest,
  terms: Terms,
  resolved: readonly ProgramComponent[],
): Operation<DurableJson> {
  try {
    const { source } = request;
    if (source.trim().length === 0) {
      throw new Refusal("source");
    }
    let parsed;
    try {
      parsed = yield* parseRootMarkdownDefinition(PROGRAM, request.origin, source);
    } catch {
      throw new Refusal("source");
    }
    const { definition } = parsed;
    if (validateBodyStructure(definition.bodySegments, definition.returns) !== undefined) {
      throw new Refusal("structure");
    }
    const mode = definition.returns === undefined ? "text" : "value";
    // Before the props are looked at, because a value root with nowhere to put
    // its result is refused whatever its props would have validated to.
    if (mode === "value" && !terms.captured) {
      throw new Refusal("capture");
    }
    let props: Record<string, Json>;
    try {
      props = yield* validateProps(PROGRAM, { ...terms.props }, definition.props);
    } catch {
      throw new Refusal("props");
    }
    // What the site answered for each element, in the order the program writes
    // them. Resolution happened before this decision, so the record says which
    // implementation each name stood for when the grant was made rather than
    // which one happens to answer on the day it is read back.
    if (!sameElements(resolved, elements(definition.bodySegments, []))) {
      throw new Refusal("source");
    }
    return parseJson({
      decision: "admitted",
      source,
      mode,
      named: resolved.map((entry) => ({
        name: entry.name,
        form: entry.form,
        identity: { ...entry.identity },
      })),
      terms,
      validated: props,
    });
  } catch (error) {
    if (error instanceof Refusal) {
      return parseJson({ decision: "refused", refused: error.refused });
    }
    throw error;
  }
}

/**
 * Every member an admitted record has, and every member a refused one has.
 *
 * The record is hostile data: a replay hands back whatever the history holds,
 * and a value with the right keys is not an admission. So each shape is closed
 * — a missing member, a member spelled differently and a member nobody wrote
 * are all the same answer, which is that this is not a record this version
 * wrote.
 */
const ADMITTED_MEMBERS: readonly string[] = [
  "decision",
  "source",
  "mode",
  "named",
  "terms",
  "validated",
];
const REFUSED_MEMBERS: readonly string[] = ["decision", "refused"];
const TERM_MEMBERS: readonly string[] = ["digest", "props", "origin", "captured"];
const COMPONENT_MEMBERS: readonly string[] = ["name", "form", "identity"];

/** Whether an object has exactly these own members and no others. */
function closed(value: JsonObject, members: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === members.length && members.every((member) => Object.hasOwn(value, member));
}

/**
 * The decision this run recorded, read back from the journal.
 *
 * Parsed rather than trusted: a record somebody else wrote is not an admission
 * because it happens to have the right keys, and one this version wrote is not
 * an admission if something has since added to it.
 */
function readAdmission(value: Json): Admission | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const { decision } = value;
  if (decision === "refused") {
    const { refused } = value;
    return closed(value, REFUSED_MEMBERS) &&
      typeof refused === "string" &&
      Object.hasOwn(REFUSAL, refused)
      ? { decision, refused: refused as Refused }
      : undefined;
  }
  if (decision !== "admitted" || !closed(value, ADMITTED_MEMBERS)) {
    return undefined;
  }
  const { source, mode, named, terms, validated } = value;
  if (typeof source !== "string" || (mode !== "text" && mode !== "value")) {
    return undefined;
  }
  const components = readComponents(named);
  const retained = readTerms(terms);
  if (components === undefined || retained === undefined || !isJsonObject(validated)) {
    return undefined;
  }
  return { decision, source, mode, named: components, terms: retained, validated };
}

function readComponents(value: Json | undefined): readonly ProgramComponent[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const found: ProgramComponent[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || !closed(entry, COMPONENT_MEMBERS)) {
      return undefined;
    }
    const { name, form, identity } = entry;
    const settled = readIdentity(identity);
    if (typeof name !== "string" || settled === undefined || !isProgramComponentForm(form)) {
      return undefined;
    }
    found.push({ name, form, identity: settled });
  }
  return found;
}

function readTerms(value: Json | undefined): Terms | undefined {
  if (!isJsonObject(value) || !closed(value, TERM_MEMBERS)) {
    return undefined;
  }
  const { digest, props, origin, captured } = value;
  if (typeof digest !== "string" || typeof origin !== "string" || typeof captured !== "boolean") {
    return undefined;
  }
  if (!isJsonObject(props)) {
    return undefined;
  }
  return { digest, props, origin, captured };
}

/**
 * Whether a continuation is asking for the evaluation it was granted.
 *
 * Compared whole and exactly. The digest answers for the program, and the other
 * three answer for the site it was admitted at: a program evaluated with
 * different props, from a different source origin, or into a different
 * disposition is a different evaluation however familiar its bytes are.
 *
 * The props compared are the ones each side supplied, so a schema default is
 * not mistaken for agreement.
 */
function sameEvaluation(retained: Terms, current: Terms): boolean {
  return (
    retained.digest === current.digest &&
    retained.origin === current.origin &&
    retained.captured === current.captured &&
    JSON.stringify(retained.props) === JSON.stringify(current.props)
  );
}

/** What the durable record carries about this evaluation before it happens. */
function admissionInput(terms: Terms): Record<string, Json> {
  return {
    digest: terms.digest,
    origin: terms.origin,
    captured: terms.captured,
    props: terms.props,
  };
}

/**
 * Admit one complete program and evaluate it at this site.
 *
 * An `Operation`, so the admission and every durable effect the program
 * performs belong to the caller's own durable sequence, offered inline by the
 * owning expansion in authored order. A partial continuation offers the same
 * sequence and restores each effect that already committed rather than
 * performing it again.
 */
export function* evaluateProgram(request: ProgramEvaluationRequest): Operation<ProgramOutcome> {
  const terms: Terms = {
    digest: programDigest(request.source),
    props: request.props,
    origin: request.origin,
    captured: request.captured,
  };

  // What this site answers for each element the candidate writes, settled
  // before the decision so the decision can retain it. A candidate the parser
  // refuses names nothing, and the admission below is where that is recorded.
  const resolved: readonly ResolvedProgramComponent[] = yield* resolveProgramSite(
    yield* programElements(request.source, request.origin),
  );
  // A site holding an answer nobody stands behind cannot be described, so there
  // is nothing to record: no grant is made rather than one that a continuation
  // could not be held to.
  if (resolved.some((entry) => entry.unidentified)) {
    throw new ProgramEvaluationError(UNIDENTIFIED);
  }

  const stored = yield createDurableOperation<DurableJson>(
    {
      type: EVALUATE_PROGRAM,
      name: `${PROGRAM}:${request.id}`,
      input: admissionInput(terms),
      ...sourceDescription(request.position),
    },
    () => admitProgram(request, terms, resolved),
  );

  const decided = readAdmission(parseJson(stored));
  if (decided === undefined) {
    throw new ProgramEvaluationError(UNREADABLE);
  }
  if (decided.decision === "refused") {
    throw new ProgramEvaluationError(REFUSAL[decided.refused]);
  }
  // Before the retained source is read for anything else and before the first
  // program effect: a continuation asking for a different program is stale
  // input, and refusing here is what keeps the retained source from silently
  // winning over it.
  if (!sameEvaluation(decided.terms, terms)) {
    throw new ProgramEvaluationError(STALE);
  }

  const restored = yield* restore(decided);
  if (restored === undefined) {
    throw new ProgramEvaluationError(UNREADABLE);
  }

  return yield* expandProgram({
    name: PROGRAM,
    meta: restored.meta,
    props: decided.validated,
    ...(restored.returns === undefined ? {} : { returns: restored.returns }),
    bodySegments: restored.bodySegments,
    path: decided.terms.origin,
    // Canonical execution settles these again from its own resolver before the
    // first program effect, so a site that has moved refuses there.
    named: decided.named,
  });
}

/** What a retained admission has to say about itself before anything expands. */
interface Restored {
  readonly meta: Record<string, unknown>;
  readonly returns?: ReturnsSchema;
  readonly bodySegments: Segment[];
}

/**
 * Prove the retained admission describes itself, and produce what it admitted.
 *
 * A journal is data, and every member of this record is a claim about another
 * one: the digest claims to be the source's, the mode claims to be what
 * reparsing produces, the validated props claim to be what the supplied ones
 * validate to, and the components claim to be the elements the source writes.
 * A record that fails any of them is not one this evaluation wrote, whatever
 * shape it has, and nothing of either program runs on the strength of it.
 *
 * The parse is the one this expansion will use, so what is checked and what
 * runs are the same value rather than two readings of one string.
 */
function* restore(decided: Admitted): Operation<Restored | undefined> {
  if (programDigest(decided.source) !== decided.terms.digest) {
    return undefined;
  }
  let parsed;
  try {
    parsed = yield* parseRootMarkdownDefinition(PROGRAM, decided.terms.origin, decided.source);
  } catch {
    return undefined;
  }
  const { definition } = parsed;
  if (validateBodyStructure(definition.bodySegments, definition.returns) !== undefined) {
    return undefined;
  }
  const mode = definition.returns === undefined ? "text" : "value";
  if (mode !== decided.mode || (mode === "value" && !decided.terms.captured)) {
    return undefined;
  }
  if (!sameElements(decided.named, elements(definition.bodySegments, []))) {
    return undefined;
  }
  let props: Record<string, Json>;
  try {
    props = yield* validateProps(PROGRAM, { ...decided.terms.props }, definition.props);
  } catch {
    return undefined;
  }
  if (JSON.stringify(props) !== JSON.stringify(decided.validated)) {
    return undefined;
  }
  return {
    meta: definition.meta,
    ...(definition.returns === undefined ? {} : { returns: definition.returns }),
    bodySegments: definition.bodySegments,
  };
}
