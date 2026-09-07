/**
 * `<Evaluate>` — running program text a document did not author.
 *
 * A generating agent proposes a fragment of Executable Markdown; this is where
 * that fragment is admitted and performed. It is public, so any author may
 * write it, and canonical core owns what it means.
 *
 * ## Public, protected, and not authority
 *
 * Protection settles *which implementation runs* and nothing else. Every
 * ceiling this component draws on was stated by a trusted host at the
 * installation boundary, before a document existed to ask for one, and
 * canonical execution captured it by value there
 * (`evaluation-profile.ts`). An execution whose host stated no profile has no
 * evaluation at all, and the refusal happens at the invocation rather than at
 * installation: a document that never writes `<Evaluate>` is not asking for a
 * ceiling.
 *
 * So writing `<Evaluate>` grants nothing. It reaches the profile this run's
 * host stated, narrowed by `allow`, and never widens it: no prop, binding,
 * interpolation, context, contextual API answer, middleware return value,
 * registration or generated name adds an identity, a root, a destination or a
 * request to what the host already installed. `allow` names an effect *class*
 * and selects between two tables that already exist; omitting it asks for
 * `read`.
 *
 * ## Two disjoint input forms
 *
 * Self-closing takes the program as `text`: a value the document already holds,
 * bound from a component that produced it.
 *
 * ```markdown
 * <Evaluate text={program} allow={["read"]} />
 * ```
 *
 * Paired makes the content the producer, and what it renders is the program.
 *
 * ```markdown
 * <Evaluate allow={["read"]}>
 *   <Plan>Read the changelog and report the version.</Plan>
 * </Evaluate>
 * ```
 *
 * They are disjoint because they answer the same question twice: a paired
 * element that also carried `text` would leave which fragment ran a matter of
 * precedence, and precedence is not something an author should have to know to
 * predict what executed.
 *
 * The producer renders under the *narrowed* syntax reference — the vocabulary
 * this evaluation admitted, not the vocabulary of the site the element was
 * written at. An agent asked to write a fragment is told what a fragment may
 * contain, which is the only description of it that is true.
 *
 * ## What it answers with
 *
 * Each admitted observation's own value in invocation order, with whatever the
 * fragment rendered kept beside them under `output`. A value rather than a
 * serialization: how a value becomes text is the document's decision, and it
 * has `<Json>` to make it with. An admitted write puts nothing here — what it
 * did is retained by its own ordinary durable effect, which is the
 * authoritative account of it.
 *
 * It is deliberately not wrapped in `printErrors`. A refused or failed
 * evaluation must stop the authored loop unless the document put a recovery
 * boundary around it: returning a refusal as observation text would leave the
 * agent reasoning from a read that never happened.
 */

import type { Operation } from "effection";
import { EvaluationCandidateError } from "../evaluation-errors.ts";

import { getExpansion } from "../expansion.ts";
import { NO_PROFILE, REVOKED } from "../evaluation-profile.ts";
import type { CapturedEntry, CapturedProfile } from "../evaluation-profile.ts";
import { evaluateProtectedGeneratedXmd } from "../generated-xmd.ts";
import type {
  GeneratedEffectClass,
  GeneratedMutation,
  GeneratedObservation,
  GeneratedObservationResult,
  GeneratedXmdRequest,
  RetainedFragmentIdentity,
} from "../generated-xmd.ts";
import { ComponentInvocationError, invocationForm } from "../invocation-identity.ts";
import type {
  ComponentInvocation,
  IdentityClaimant,
  ProtectedBody,
  ProtectedSite,
} from "../invocation-identity.ts";
import { admittedSymbols } from "../syntax-admitted.ts";
import type { SyntaxReference } from "../syntax-reference.ts";
import type { ProtectedComponent } from "./protected.ts";
import { CORE_ORIGIN } from "./registry.ts";
import { documented } from "./documentation.ts";
import type { FunctionComponentDefinition, Json, PropsSchema } from "../types.ts";

/** The public name canonical core claims for the evaluation component. */
export const EVALUATE_COMPONENT = "Evaluate";

/** The classes this component accepts, and the order a selection canonicalizes to. */
const EFFECT_CLASSES: readonly GeneratedEffectClass[] = ["read", "write"];

/**
 * The whole schema: the program, the selection, and nothing else accepted.
 *
 * `allow` narrows the host's already-installed profile and can do nothing else.
 * It names no identity, no root, no destination and no request — it says which
 * of the tables this host captured before the document existed a fragment may
 * draw on, and omitting it asks for `read`.
 */
export const props: PropsSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "The program to evaluate, for the self-closing form. Written instead of content, " +
        "never beside it.",
    },
    source: {
      type: "string",
      description:
        "The earlier spelling of `text`, accepted only by a host that admitted it. " +
        "New documents write `text`.",
    },
    allow: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: [...EFFECT_CLASSES] },
      description:
        "Optional. Which effect classes the program may draw on, narrowing what this host " +
        "already installed. Omitted asks for `read`.",
    },
  },
  additionalProperties: false,
};

const UNISSUED_REFUSAL =
  "<Evaluate> is invoked by canonical core; this is not an invocation the engine issued.";

const BOTH_FORMS =
  "<Evaluate> takes the program either as `text` or as its content, and never as both: an " +
  "element that states it twice leaves which program ran a question of precedence.";

const NO_PROGRAM =
  "<Evaluate text={…} /> requires the program as a string. An element that states no program " +
  "and renders no content has nothing to evaluate.";

const PAIRED_TEXT =
  "<Evaluate> renders its content to produce the program, so a paired element does not also " +
  "carry `text`.";

const NO_ALIAS =
  "<Evaluate source={…} /> is the earlier spelling, and this host did not admit it. Write the " +
  "program as `text`.";

const ALLOW_SHAPE = "<Evaluate> takes `allow` as a non-empty array of effect classes.";

const ALLOW_UNKNOWN = "<Evaluate> admits the effect classes `read` and `write`, and nothing else.";

const ALLOW_REPEATED = "<Evaluate> takes each effect class in `allow` once.";

const NO_WRITE_TABLE =
  '<Evaluate allow={["write"]} /> asks for mutation, and this host installed no write table. A ' +
  "selection reaches what the host already stated; it never adds to it.";

const NO_READ_TABLE =
  '<Evaluate allow={["read"]} /> asks for observation, and this host installed no read table.';

const NO_PROJECTION =
  "<Evaluate> renders its content to produce the program, and this invocation has no content to " +
  "render.";

/**
 * The declaration canonical core selects for `<Evaluate>`.
 *
 * Both forms, because the two input spellings are two ways of stating the same
 * argument. No `returns`, so the value binds by reference under `as`,
 * unchecked: rewriting it on the way to the document would change what the
 * fragment observed.
 */
export const EVALUATE_PROTECTED: ProtectedComponent = {
  name: EVALUATE_COMPONENT,
  origin: CORE_ORIGIN,
  props,
  forms: ["self-closing", "paired"],
  ...documented({
    description: 'Evaluate program text. `<Evaluate text={program} allow={["read"]} />` runs it.',
    as: "Optional. Captures the observations and rendered output instead of emitting them.",
    context: null,
  }),
  build: (claim: IdentityClaimant) => evaluate(claim),
};

function evaluate(claim: IdentityClaimant): ProtectedBody {
  return function* runEvaluate(
    elementProps: Record<string, Json>,
    invocation: ComponentInvocation,
    site: ProtectedSite,
  ): Operation<unknown> {
    site.capture?.begin();
    // The engine's own account of how the element was written, not a method on
    // the object this was handed: a wrapper can mint an object carrying
    // `hasContent`, and it cannot mint an issuance.
    const form = invocationForm(invocation);
    if (form === undefined) {
      throw new ComponentInvocationError(UNISSUED_REFUSAL);
    }

    // Every refusal a selection or a spelling can produce happens before the
    // durable name is claimed and before any program exists, so an element this
    // host cannot answer for leaves no admission record and performs no effect.
    const profile = site.evaluation;
    if (profile === undefined) {
      throw new ComponentInvocationError(NO_PROFILE);
    }
    const allow = requestedClasses(elementProps.allow) ?? ["read"];
    if (site.capture !== undefined && allow.includes("write")) {
      throw new EvaluationCandidateError(
        "authority",
        "A staged evaluation capture accepts read-only requests.",
      );
    }
    const stated = statedText(elementProps, profile, form);
    const entries = selectedTables(profile, allow);

    const id = yield* claim(invocation);

    // Narrowed from the tables the selection resolved to, so the vocabulary a
    // producer is told about is the vocabulary the fragment is admitted for —
    // and reported as availability against the enclosing reference, which keeps
    // the authoring documentation the site already had.
    const narrowedSyntax = narrow(site.syntax, entries);
    const source = stated === undefined ? yield* project(site, narrowedSyntax) : stated;
    site.capture?.source(source);

    // Read after the producer has rendered, and exactly once per occurrence: a
    // producer may itself commit mutations, and the basis this admission is
    // made under is the run's basis at the moment the program exists.
    if (!profile.live()) {
      throw new ComponentInvocationError(REVOKED);
    }
    const basis = profile.workspace === undefined ? undefined : yield* profile.workspace.snapshot();

    // Where the authored element was written, as diagnostic journal data beside
    // the admission. A generated fragment's own elements are scanned from a
    // dynamic string and carry no authored position of their own.
    const expansion = yield* getExpansion();

    const request: GeneratedXmdRequest = {
      id,
      source,
      allow,
      observations: entries.observations,
      ...(entries.mutations.length === 0 ? {} : { mutations: entries.mutations }),
      ...(basis === undefined ? {} : { workspaceRoots: basis.roots, selectedRoot: basis.current }),
      ...(expansion.position === undefined ? {} : { position: expansion.position }),
    };
    // Every path in this fragment resolves against the directory the run is in
    // now, and the cursor is restored however the evaluation ends — so a
    // fragment produced inside another fragment's producer leaves the outer one
    // where it was, and a failed one leaves nothing behind.
    const leave = yield* profile.enterFragment();
    const narrowedBodies = site.narrowProtectedBodies(
      entries.admitted.map((entry) => entry.definition.fn),
    );
    try {
      const result = yield* evaluateProtectedGeneratedXmd(
        request,
        narrowedBodies,
        narrowedSyntax,
        site.capture,
      );
      site.capture?.complete();
      return answer(result);
    } finally {
      narrowedBodies?.close();
      leave();
    }
  };
}

/**
 * The program the element stated, or nothing when its content will produce one.
 *
 * The two forms are disjoint and the check is symmetric: a paired element
 * carrying `text` and a self-closing element carrying none are the same
 * mistake seen from either side, and both are refused rather than resolved by
 * precedence.
 */
function statedText(
  elementProps: Record<string, Json>,
  profile: CapturedProfile,
  form: "self-closing" | "paired",
): string | undefined {
  const text = elementProps.text;
  const alias = elementProps.source;
  if (alias !== undefined && !profile.deprecatedSourceAlias) {
    throw new ComponentInvocationError(NO_ALIAS);
  }
  if (text !== undefined && alias !== undefined) {
    throw new ComponentInvocationError(BOTH_FORMS);
  }
  const stated = text ?? alias;
  if (form === "paired") {
    if (stated !== undefined) {
      throw new ComponentInvocationError(PAIRED_TEXT);
    }
    return undefined;
  }
  if (typeof stated !== "string") {
    throw new ComponentInvocationError(NO_PROGRAM);
  }
  return stated;
}

/**
 * The classes this element asked for, canonicalized.
 *
 * Parsed rather than read. The declared schema already refuses everything but a
 * non-empty duplicate-free subset, and what this adds is the canonical order
 * the admission retains — two documents asking for the same two classes are
 * asking for the same thing, so authored order takes no part in the policy a
 * continuation is held to. It is a second gate rather than a redundant one: a
 * protected body is handed a props object rather than a promise that one was
 * validated.
 */
function requestedClasses(value: Json | undefined): readonly GeneratedEffectClass[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ComponentInvocationError(ALLOW_SHAPE);
  }
  const selected = new Set<GeneratedEffectClass>();
  for (const entry of value) {
    const effect = EFFECT_CLASSES.find((known) => known === entry);
    if (effect === undefined) {
      throw new ComponentInvocationError(ALLOW_UNKNOWN);
    }
    if (selected.has(effect)) {
      throw new ComponentInvocationError(ALLOW_REPEATED);
    }
    selected.add(effect);
  }
  return EFFECT_CLASSES.filter((effect) => selected.has(effect));
}

/** The pinned tables one selection resolves to. */
interface SelectedTables {
  readonly observations: readonly GeneratedObservation[];
  readonly mutations: readonly GeneratedMutation[];
  /** Both tables together, for describing the vocabulary the fragment has. */
  readonly admitted: readonly CapturedEntry[];
}

/**
 * The host's captured tables, as the pinned identities the evaluator admits.
 *
 * A class the host installed nothing for is refused here — before the durable
 * name is claimed and before a program exists — rather than reaching the
 * evaluator as an empty table. The identity a run retains is built from the
 * three structural parts the host stated, so a reader comparing two admissions
 * can say which part moved.
 *
 * The definition carries the *captured* schema rather than its own, so a host
 * that edits the schema on the definition it handed over after installation
 * does not change what a fragment's props are validated against.
 */
function selectedTables(
  profile: CapturedProfile,
  allow: readonly GeneratedEffectClass[],
): SelectedTables {
  const observations: GeneratedObservation[] = [];
  const mutations: GeneratedMutation[] = [];
  const admitted: CapturedEntry[] = [];
  if (allow.includes("read")) {
    if (profile.read.length === 0) {
      throw new ComponentInvocationError(NO_READ_TABLE);
    }
    for (const entry of profile.read) {
      observations.push({
        name: entry.name,
        identity: pinned(entry),
        definition: entry.definition,
        ...(entry.dispatch === undefined ? {} : { dispatch: entry.dispatch }),
        // An entry admitted for one spelling admits that one; an entry admitted
        // for both is the form-insensitive component it has always been.
        ...(entry.forms.length === 1 && entry.forms[0] === "self-closing"
          ? { selfClosing: true }
          : {}),
        // The version-1 strings this entry stated it succeeds, carried through
        // so a continuation admitted under one of them reconciles against this
        // entry. Nothing this run writes holds them.
        ...(entry.legacy === undefined ? {} : { legacy: entry.legacy }),
        ...(entry.requests === undefined ? {} : { requests: entry.requests.map(asRequest) }),
      });
      admitted.push(entry);
    }
  }
  if (allow.includes("write")) {
    if (profile.write.length === 0) {
      throw new ComponentInvocationError(NO_WRITE_TABLE);
    }
    for (const entry of profile.write) {
      mutations.push({
        name: entry.name,
        identity: pinned(entry),
        definition: entry.definition,
        ...(entry.dispatch === undefined ? {} : { dispatch: entry.dispatch }),
        ...(entry.legacy === undefined ? {} : { legacy: entry.legacy }),
        form: entry.forms.length === 2 ? "either" : (entry.forms[0] ?? "self-closing"),
      });
      admitted.push(entry);
    }
  }
  return { observations, mutations, admitted };
}

/**
 * The identity a run retains for one captured entry.
 *
 * Structural rather than assembled: the four terms travel as themselves, so a
 * continuation compares them one at a time and a reader looking at two
 * admissions can say which of them moved. Nothing here is derived from the
 * implementation — an implementation is not an identity — and the kind travels
 * with the rest because an operation core supplies the body for and an answer
 * the import chain resolved are different grants under the same three names.
 */
function pinned(entry: CapturedEntry): RetainedFragmentIdentity {
  const { origin, key, revision } = entry.identity;
  return entry.kind === "component-answer"
    ? { kind: "component-answer", origin, key, revision }
    : { kind: "capability", origin, key, revision };
}

/** One captured ceiling, as the request record the evaluator compares against. */
function asRequest(request: {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeout?: number;
}): Record<string, Json> {
  return {
    url: request.url,
    method: request.method,
    headers: { ...request.headers },
    ...(request.timeout === undefined ? {} : { timeout: `${request.timeout}ms` }),
  };
}

/**
 * The reference a producer renders under, or nothing when the site carries none.
 *
 * Narrowing is the reference's own operation rather than something assembled
 * here, because what an author may *read about* is not what this evaluation
 * admits: the enclosing documentation index stays exactly what it was, and only
 * the availability of each entry is replaced.
 */
function narrow(
  enclosing: SyntaxReference | undefined,
  tables: SelectedTables,
): SyntaxReference | undefined {
  return enclosing?.available(admittedSymbols(tables.admitted));
}

/**
 * Render the content once, under the narrowed reference.
 *
 * The projection is canonical expansion's own, delivered directly to this body
 * and reachable from nowhere else: it is not a context, not a registration, and
 * not published through `ActiveProjection`, so nothing that runs inside the
 * producer can render this element's content a second time or under a different
 * vocabulary.
 */
function* project(site: ProtectedSite, narrowed: SyntaxReference | undefined): Operation<string> {
  if (site.projectContent === undefined || narrowed === undefined) {
    throw new ComponentInvocationError(NO_PROJECTION);
  }
  return yield* site.projectContent(narrowed);
}

/**
 * What the document reads back: a detached value, not text.
 *
 * Copied out of the evaluator's own result rather than handed on, so the object
 * a document binds shares nothing with the evaluation that produced it.
 */
function answer(result: GeneratedObservationResult): Json {
  return {
    observations: result.observations.map((observation) => ({
      name: observation.name,
      value: observation.value,
    })),
    output: result.output,
  };
}
