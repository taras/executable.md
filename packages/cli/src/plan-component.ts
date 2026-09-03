/**
 * `<Plan>` — how this host declares the component, and the five private
 * capabilities only its own bytes may write.
 *
 * The Component itself is `src/documents/Plan.md` rather than anything here:
 * `xmd plan` and a `<Plan>` written in an ordinary run both expand those exact
 * bytes, and the authorship workflow they carry out belongs to them. What this
 * module contributes is the declaration around them — the public name, the
 * origin that identifies the packaged asset rather than a path, the digest of
 * what this build actually shipped, the paired-only form, and the private
 * closure the Component's own phases need.
 *
 * ## What the host contributes, and what it does not
 *
 * Everything a caller cannot be allowed to choose is captured here, by value,
 * before the declaration exists: which surface is asking, the include path, the
 * Agent stack this invocation settled, this build's adapter assembly, who
 * answers the review question, where authorship directories live, and the scope
 * the two host acts run in. None of it is a prop, and no document, component or
 * middleware can reach or replace any of it.
 *
 * What the host does not contribute is prose or a branch. Every sentence a
 * person reads — every Prompt, every choice, every ending — is in `Plan.md`,
 * where it can be read and argued with. The one thing that crosses is a sealed
 * `surface` discriminator, and the Component decides for itself what each
 * surface calls things.
 *
 * ## Why the capabilities are private
 *
 * `<PlanInputs>`, `<PlanAuthorship>`, `<PlanProgress>`, `<CheckDraft>` and
 * `<AdmitPlan>` are the phases of one invocation, not components anyone composes
 * with. Freezing the inputs, installing a constrained Agent frame, telling an
 * operator which phase is running, answering about a draft and admitting the
 * approved bytes are each meaningless outside the workflow that orders them —
 * and each carries authority the enclosing document does not have.
 * So they resolve only while canonical core is expanding these exact bytes:
 * not from the caller's root, not from the Prompt the caller projected, not from
 * a sibling `<Plan>`, and not from anything middleware can answer.
 */

import { createHash } from "node:crypto";
import { scoped } from "effection";
import type { Operation, Result, Scope } from "effection";
import { createDurableOperation, StaleInputError } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import {
  agentIdentityComponents,
  content,
  DocumentOutput,
  retainedSource,
  validateDocumentStructure,
} from "@executablemd/core";
import { sourceDigest } from "@executablemd/core/host";
import type {
  DeclaredMarkdownComponent,
  IdentityClaimant,
  IdentityComponent,
} from "@executablemd/core/host";
import type { DocumentValidation } from "@executablemd/core";
import type { ComponentInvocation } from "@executablemd/core";

import {
  DEFAULT_AUTHORSHIP_ROOT,
  installAuthorshipFrame,
  useSessionDirectory,
} from "./authorship-profile.ts";
import type { PlanAuthorship, PlanAuthorshipObservation } from "./authorship-profile.ts";
import type { CandidateAssessment } from "./authorship-profile.ts";
import type { MachineSessionAssembly } from "./session-coordinator.ts";
import { PLAN_DOCUMENT, readPackagedDocument } from "./packaged-document.ts";
import { useRunProfileRegistry } from "./syntax.ts";

/**
 * The origin `<Plan>` reports, in every distribution.
 *
 * It names the packaged asset, not a file path: the source checkout, the
 * published npm package and the compiled binary all ship the same bytes at the
 * same package-relative location, and a reader asking where the Component came
 * from is owed the answer that is true in all three.
 */
export const PLAN_ORIGIN = "@executablemd/cli/Plan.md";

/** The public name of the packaged Component that owns Plan authorship. */
export const PLAN_COMPONENT = "Plan";

/**
 * The identity approved text is read under.
 *
 * Deliberate and fixed, the way `<eval>` is for an inline document: the bytes
 * came from an agent, not from a file, and a source position reading
 * `(<plan>:5:1)` says so. It affects positions and diagnostics only.
 */
export const PLAN_IDENTITY = "<plan>";

/**
 * How this host decides whether one candidate is structurally a program.
 *
 * One dependency rather than three call sites that happen to agree. `<CheckDraft>`
 * answers a draft with it, `<AdmitPlan>` admits the approved bytes with it, and
 * on the command surface the host asks it once more after everything the
 * conversation built has gone. Three questions, one environment — so two of them
 * cannot come to differ for a reason nobody chose, and the last one is still a
 * separate question about a tree that may have moved since.
 */
export type StructuralValidation = (candidate: string) => Operation<DocumentValidation>;

/**
 * The canonical answer: `validateDocumentStructure` under the ordinary run
 * profile, the `<plan>` identity, these includes and these declarations.
 *
 * Structure alone — the declarations, the source, the component resolution, the
 * forms and everything else decidable without the property values a later run
 * will supply. A Plan whose root declares required properties is a Plan, and
 * refusing it for not having been given arguments nobody has offered it yet
 * would refuse a program for being one.
 *
 * The declarations are read when the question is asked rather than when this is
 * built, because the `<Plan>` declaration has to be able to describe itself: the
 * profile a Plan will run in contains `<Plan>`, and the catalog the agent was
 * shown says so.
 */
export function structuralValidation(
  includes: readonly string[],
  declarations: readonly DeclaredMarkdownComponent[],
): StructuralValidation {
  return (candidate: string) =>
    // The registry is installed around the question rather than around the
    // Component: what a Plan may write is the run profile's whole vocabulary —
    // `<Testing>`, `<Test>` and the assertions included — and the Component
    // itself has no business reaching a vocabulary it only describes.
    scoped(function* (): Operation<DocumentValidation> {
      yield* useRunProfileRegistry();
      return yield* validateDocumentStructure({
        ...retainedSource(PLAN_IDENTITY, candidate),
        includes: [...includes],
        components: agentIdentityComponents(),
        declarations: [...declarations],
      });
    });
}

/** Which surface reached the Component. Sealed: it is never a public prop. */
export type PlanSurface = "command" | "component";

/** Everything the host settles before a `<Plan>` invocation can exist. */
export interface PlanComponentAssembly {
  /**
   * Which surface is asking.
   *
   * Fixed in the execution's declaration before the root is imported, so the
   * thin command adapter cannot accept it, derive it, or pass it on. A Plan
   * a later `xmd run` executes is an ordinary run and receives `component`,
   * because that run builds its own declaration.
   */
  readonly surface: PlanSurface;
  /** The component search path a Plan's own components resolve against. */
  readonly includes: readonly string[];
  /**
   * The Agent context this host can give a Plan, or why it can give none.
   *
   * A host that establishes none — `xmd test` at its own root, or an
   * unconfigured run child — still declares the Component. A document that
   * writes `<Plan>` there resolves the same protected bytes and is refused at
   * the frame, before any placement, rather than told the component does not
   * exist.
   *
   * The capability is a closure the host supplied before this declaration
   * existed. No prop, binding, registration, middleware answer or separately
   * loaded copy can supply or replace one.
   */
  readonly context: Result<PlanAuthorship>;
  /** What this host states about machine-wide agent sessions, if anything. */
  readonly sessions?: MachineSessionAssembly;
  /**
   * Where this host keeps its authorship session directories.
   *
   * Absent is the ordinary host default. A harness that owns a temporary tree
   * names that tree here, which is the only way anything but production selects
   * one — there is no flag, no environment variable and no contextual Api to
   * reach, so a document cannot move where authorship directories live.
   */
  readonly authorshipRoot?: string;
  /**
   * The logical session name this surface fixes, when it fixes one.
   *
   * `xmd plan` settles its own before the document runs — the generated
   * `xmd-plan:<UUID>` or the caller's raw `--session` — and its directory
   * mapping must not change. An ordinary run fixes none, and a placement is
   * derived from the `<Plan>` expansion instead.
   */
  readonly session?: string;
  /** Whether that fixed name was one a caller asked for and can ask for again. */
  readonly explicitSession?: boolean;
  /**
   * Whether this command selected long-form progress.
   *
   * Sealed beside {@link surface}, and read by `<PlanProgress verbose>` alone.
   * `xmd plan --verbose` is the only thing that sets it: no prop, binding,
   * middleware answer or authored opt-in reaches it, so a document cannot ask
   * for the drafts and diagnostics an operator did not.
   */
  readonly verbose?: boolean;
  /** The scope the two host acts run in, captured before the frame exists. */
  readonly host: Scope;
  /** A trusted host-only observation after the whole frame is installed. */
  observeAuthorship?(observation: PlanAuthorshipObservation): Operation<void>;
  /** Who answers the review question. */
  installElicitation(): Operation<void>;
  /** The run profile's rendered vocabulary, as the first Agent turn receives it. */
  catalog(): Operation<string>;
  /**
   * How this host decides whether one candidate is structurally a program.
   *
   * Omitted is the canonical answer built from `includes` and this declaration,
   * which is what a document invoking `<Plan>` wants. `xmd plan` supplies its
   * own so that the draft check, the admission and the gate the command keeps
   * after teardown are one dependency rather than three.
   */
  validate?: StructuralValidation;
}

/** The frozen inputs `<PlanInputs>` answers with. */
const INPUTS_RETURNS = {
  type: "object",
  properties: {
    syntax: { type: "string" },
    session: { type: "string" },
    surface: { type: "string" },
    durable: { type: "boolean" },
    authoredSession: { type: "string" },
  },
  required: ["syntax", "session", "surface", "durable"],
  additionalProperties: false,
};

/**
 * What the frozen inputs are given: the caller's optional session name, and the
 * prompt this invocation is about.
 *
 * The prompt is here so that the first durable record of the invocation is
 * about a question as well as a catalog. Only its digest is kept.
 */
const INPUTS_PROPS = {
  type: "object",
  properties: {
    session: { type: "string", minLength: 1 },
    instruction: { type: "string" },
  },
  required: ["instruction"],
  additionalProperties: false,
};

const OPTIONAL_SESSION = {
  type: "object",
  properties: { session: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const AUTHORSHIP_PROPS = {
  type: "object",
  properties: {
    session: { type: "string", minLength: 1 },
    durable: { type: "boolean" },
    authoredSession: { type: "string", minLength: 1 },
  },
  required: ["session", "durable"],
  additionalProperties: false,
};

/**
 * What one progress phase is given: whether it is long-form, and nothing else.
 *
 * Closed on purpose. A phase says which part of authorship is running, and the
 * only question about one is whether an operator asked to see the drafts and
 * diagnostics — which is the host's answer, not a prop's.
 */
const PROGRESS_PROPS = {
  type: "object",
  properties: { verbose: { type: "boolean" } },
  additionalProperties: false,
};

const SOURCE_PROP = {
  type: "object",
  properties: { source: { type: "string" } },
  required: ["source"],
  additionalProperties: false,
};

/**
 * What the final admission is given: the approved bytes, and the prompt they
 * were written for.
 *
 * The prompt is here because the artifact this phase retains is an answer to a
 * question, and a record that did not say which question would be restorable
 * for one nobody asked. Only its digest is kept.
 */
const ADMIT_PROPS = {
  type: "object",
  properties: { source: { type: "string" }, instruction: { type: "string" } },
  required: ["source", "instruction"],
  additionalProperties: false,
};

const CHECK_RETURNS = {
  type: "object",
  properties: { valid: { type: "boolean" }, diagnostics: { type: "object" } },
  required: ["valid", "diagnostics"],
  additionalProperties: false,
};

/**
 * The declaration one execution runs `<Plan>` under.
 *
 * Reads the packaged bytes and states their digest, so a build that shipped
 * different bytes is refused where it is installed rather than where a document
 * happens to write the name. The schemas are not restated here: `Plan.md`'s own
 * frontmatter declares them, and canonical core holds a stated schema to the
 * parsed one — so the only thing this adds to the source is what the source
 * cannot say about itself.
 */
export function* planComponentDeclaration(
  assembly: PlanComponentAssembly,
): Operation<DeclaredMarkdownComponent> {
  const source = yield* readPackagedDocument(PLAN_DOCUMENT);
  // The admission validates against the profile a Plan will run in, and that
  // profile now contains `<Plan>` — the catalog the agent was shown says so. So
  // the declaration has to be able to describe itself, which is why it is
  // assigned back rather than rebuilt: a second copy of these bytes would be a
  // second Component identity.
  const declared: DeclaredMarkdownComponent[] = [];
  // One structural question for this invocation, asked by the draft check and by
  // the admission alike — and, when the command supplied it, by the command's own
  // gate after this declaration is gone.
  const validate = assembly.validate ?? structuralValidation(assembly.includes, declared);
  const declaration: DeclaredMarkdownComponent = {
    name: PLAN_COMPONENT,
    origin: PLAN_ORIGIN,
    source,
    digest: sourceDigest(source),
    // Paired only. A Prompt is what a caller writes between the tags, and a
    // self-closing invocation has written none — the Component fails it on the
    // empty rendering rather than on the spelling, which is the same answer for
    // a body that rendered to nothing.
    forms: ["paired"],
    // What this Component renders is a program's source. Reflowing it or
    // formatting it as Markdown would publish bytes nobody approved.
    exact: true,
    privates: [
      planInputs(assembly),
      planAuthorship(assembly),
      planProgress(assembly),
      checkDraft(validate),
      admitPlan(validate),
    ],
  };
  declared.push(declaration);
  return declaration;
}

/**
 * The same declaration, for the paths that describe an environment rather than
 * run in one.
 *
 * Inspection and validation answer about what a document may write. They mint no
 * execution, so there is no claimant to build a private capability from and no
 * frame to install — and none of that is describable anyway: a private name
 * is not syntax a document may write, so a catalog listing one would describe an
 * environment that does not exist.
 *
 * What they do report is the identity: the same name, the same origin, the same
 * digest and the same contract the run would expand, read from the same packaged
 * bytes. That is what makes `xmd syntax` a check on which Component a build
 * ships.
 */
export function* planComponentDescription(): Operation<DeclaredMarkdownComponent> {
  const source = yield* readPackagedDocument(PLAN_DOCUMENT);
  return {
    name: PLAN_COMPONENT,
    origin: PLAN_ORIGIN,
    source,
    digest: sourceDigest(source),
    forms: ["paired"],
    exact: true,
    // The private names travel too, even though none of them is ever described.
    // Selection refuses a name a declaration keeps to itself, and it has to
    // refuse the same names here as it does in a run — otherwise a repository
    // file called `CheckDraft.md` would be listed and validated as though a
    // document could write it, and only the run would say otherwise.
    privates: describedPrivates(),
  };
}

/**
 * The private closure as a description: the names, origins and contracts, with
 * no implementation behind them.
 *
 * Describing an environment mints no execution and therefore no claimant, so
 * there is nothing to build one from. The factory is a refusal rather than an
 * omission: nothing that only describes a document reaches an implementation, so
 * it is unreachable — it is there so that anything which ever did would fail
 * loudly rather than run a private component with no invocation behind it.
 */
function describedPrivates(): readonly IdentityComponent[] {
  const described: readonly Omit<IdentityComponent, "origin" | "factory">[] = [
    {
      name: "PlanInputs",
      props: INPUTS_PROPS,
      returns: INPUTS_RETURNS,
      forms: ["self-closing"],
    },
    { name: "PlanAuthorship", props: AUTHORSHIP_PROPS, forms: ["paired"] },
    { name: "PlanProgress", props: PROGRESS_PROPS, forms: ["paired"] },
    { name: "CheckDraft", props: SOURCE_PROP, returns: CHECK_RETURNS, forms: ["self-closing"] },
    { name: "AdmitPlan", props: ADMIT_PROPS, returns: { type: "string" }, forms: ["self-closing"] },
  ];
  return described.map((component) => ({
    ...component,
    origin: `${PLAN_ORIGIN}#${component.name}`,
    factory: () => uninvocable,
  }));
}

// deno-lint-ignore require-yield
function* uninvocable(): Operation<never> {
  throw new Error(
    "this private component was described rather than executed, so it has no implementation " +
      "to run",
  );
}

/**
 * Freeze this invocation's authorship inputs, and retain them.
 *
 * The catalog is an observation the first Agent turn is built from, so it is
 * journaled: a continuation restores what the run actually showed the agent
 * rather than rebuilding one from a working tree that has moved. The instruction
 * identity beside it is what makes a continuation answerable at all: this is the
 * first durable record of the invocation, so comparing it here refuses a Plan
 * asked for different instructions before a directory, a provider, a turn, a
 * review or an admission exists — the only place that can refuse without having
 * already done some of the work it would be refusing.
 *
 * The session placement is derived here too, from the durable identity canonical
 * execution minted for this exact expansion — which is what makes two `<Plan>`
 * sites, and two iterations of one site, distinct without either of them being
 * nameable.
 */
function planInputs(assembly: PlanComponentAssembly): IdentityComponent {
  return {
    name: "PlanInputs",
    origin: `${PLAN_ORIGIN}#PlanInputs`,
    forms: ["self-closing"],
    props: INPUTS_PROPS,
    returns: INPUTS_RETURNS,
    factory: (claim: IdentityClaimant) =>
      function* PlanInputs(
        props: Record<string, Json>,
        invocation: ComponentInvocation,
      ): Operation<Json> {
        // Read where the work is not journaled, and read from the claimant
        // rather than from a name, a context or an answer: this is the identity
        // canonical execution minted where resolution selected this exact
        // implementation, for this exact expansion.
        const id = yield* claim(invocation);
        const authored = typeof props.session === "string" ? props.session : undefined;
        const session = placementFor(assembly, id, authored);

        const instruction = sourceDigest(String(props.instruction));

        const frozen = yield* durablePlanOperation<Json>(`plan:inputs:${id}`, function* () {
          return { syntax: yield* assembly.catalog(), instruction };
        });

        // A history is input, so it is parsed rather than trusted.
        const retained = readInputs(frozen);
        if (retained === undefined) {
          throw new StaleInputError(UNREADABLE_INPUTS);
        }
        if (retained.instruction !== instruction) {
          throw new StaleInputError(STALE);
        }

        return {
          syntax: retained.syntax,
          session,
          surface: assembly.surface,
          durable: durability(assembly, authored),
          ...(authored === undefined ? {} : { authoredSession: authored }),
        };
      },
  };
}

/**
 * The logical placement one invocation's conversation belongs to.
 *
 * `xmd plan` settles its own name before the document exists and its directory
 * mapping is unchanged, so that name is used exactly as written. An ordinary
 * run has none: the placement is the digest of this expansion's durable
 * identity, and of the authored name when the caller wrote one — so a named
 * session continues the same site across runs while two sibling sites writing
 * one name stay two conversations. The name never becomes a path in either
 * case; the directory below is keyed by the digest of whatever this returns.
 */
/**
 * Whether this placement's directory outlives the invocation.
 *
 * The public `session` prop is the whole of the question on the component
 * surface, and it is answered here — inside the frozen inputs — because this is
 * the last place that can see it. `<PlanAuthorship>` receives a placement rather
 * than a prop, and a placement cannot be asked whether somebody wrote it: a name
 * a caller can write again needs a directory that is still there next time, and
 * one this expansion derived belongs to this expansion and goes back with it.
 *
 * `xmd plan` settles its own answer before the document exists, from whether
 * `--session` was written, and that answer is used exactly as given.
 */
function durability(assembly: PlanComponentAssembly, authored: string | undefined): boolean {
  if (assembly.session !== undefined) {
    return assembly.explicitSession === true;
  }
  return authored !== undefined;
}

function placementFor(
  assembly: PlanComponentAssembly,
  id: string,
  authored: string | undefined,
): string {
  if (assembly.session !== undefined) {
    return assembly.session;
  }
  const placement = createHash("sha256").update(id);
  if (authored !== undefined) {
    placement.update("\n").update(authored);
  }
  return `xmd-plan:${placement.digest("hex")}`;
}

/**
 * Install the constrained authorship frame, project the workflow inside it, and
 * do not return until every part of it has finished tearing down.
 *
 * The frame is this invocation's own scope, so the provider, the authorship
 * directory, the Prompt tasks, the Elicitation resources and the host acts
 * started for this Plan all end when the projection does. What follows in the
 * Component — the structural admission and the return — is therefore written after
 * teardown by construction rather than by a rule somebody has to remember.
 */
function planAuthorship(assembly: PlanComponentAssembly): IdentityComponent {
  return {
    name: "PlanAuthorship",
    origin: `${PLAN_ORIGIN}#PlanAuthorship`,
    forms: ["paired"],
    props: AUTHORSHIP_PROPS,
    factory: () =>
      function* PlanAuthorship(props: Record<string, Json>): Operation<string> {
        // Before a directory exists, before a provider exists, and therefore
        // before any session could be placed or any turn started. A host that
        // supplies no Agent context refuses rather than writing a Plan under
        // a weaker one, and broader authority in the calling document cannot
        // widen it.
        const context = assembly.context;
        if (!context.ok) {
          throw context.error;
        }

        const session = String(props.session);
        const established = yield* useSessionDirectory({
          root: assembly.authorshipRoot ?? DEFAULT_AUTHORSHIP_ROOT,
          session,
          // A placement this expansion derived belongs to it and goes back with
          // it; a name a caller wrote is one they can write again, so its
          // directory is still there next time. The frozen inputs decided which
          // this is, because they are the last thing that saw the public prop.
          explicitSession: props.durable === true,
        });
        if (!established.ok) {
          throw established.error;
        }

        yield* installAuthorshipFrame({
          workdir: established.value,
          authorship: context.value,
          host: assembly.host,
          session,
          ...(typeof props.authoredSession === "string"
            ? { authoredSession: props.authoredSession }
            : {}),
          ...(assembly.observeAuthorship === undefined
            ? {}
            : { observe: assembly.observeAuthorship }),
          installElicitation: assembly.installElicitation,
        });

        // The Component's own phases, projected inside everything installed above.
        // The content scope descends from this body's, so the frame covers the
        // turns and the review and nothing outside them.
        yield* content();
        return "";
      },
  };
}

/**
 * Say which part of authorship is running, to the operator and to nobody else.
 *
 * Progress is a side effect of the command's own output, not something `<Plan>`
 * produces. The rendered prose is sent through the current `DocumentOutput`
 * operation and the invocation returns the empty string, which is what keeps it
 * out of two places at once: `<Plan as="approved">` captures what the Component
 * *returns*, so returning the prose would put a phase heading inside approved
 * source, and the declaration is `exact`, so it would also bypass the
 * whitespace and terminal presentation every other line of progress gets.
 *
 * Only the command surface has an operator to tell. An ordinary document that
 * writes `<Plan>` renders its approved source where the element stands, and a
 * phase announcement in the middle of that is the same contamination by another
 * route — so the component surface returns before the content is expanded at
 * all, and the bindings a phase interpolates are never even read there.
 *
 * `verbose` is the same decision one step further in: a phase that carries a
 * draft or a check's diagnostics renders only when this command was asked for
 * them. The answer is the host's sealed fact rather than the prop's value; the
 * prop says which phases the question is about.
 */
function planProgress(assembly: PlanComponentAssembly): IdentityComponent {
  return {
    name: "PlanProgress",
    origin: `${PLAN_ORIGIN}#PlanProgress`,
    forms: ["paired"],
    props: PROGRESS_PROPS,
    factory: () =>
      function* PlanProgress(props: Record<string, Json>): Operation<string> {
        if (assembly.surface !== "command") {
          return "";
        }
        if (props.verbose === true && assembly.verbose !== true) {
          return "";
        }
        yield* DocumentOutput.operations.output(yield* content());
        return "";
      },
  };
}

/**
 * Answer about one draft, without executing a byte of it.
 *
 * Each assessment is retained under this expansion and the exact candidate it
 * was about, so a continuation restores the answer the run gave rather than
 * re-deciding it against a working tree that has moved. The candidate itself
 * never reaches the description — only the digest that tells two drafts apart.
 */
function checkDraft(validate: StructuralValidation): IdentityComponent {
  return {
    name: "CheckDraft",
    origin: `${PLAN_ORIGIN}#CheckDraft`,
    forms: ["self-closing"],
    props: SOURCE_PROP,
    returns: CHECK_RETURNS,
    factory: (claim: IdentityClaimant) =>
      function* CheckDraft(
        props: Record<string, Json>,
        invocation: ComponentInvocation,
      ): Operation<Json> {
        const id = yield* claim(invocation);
        const candidate = String(props.source);
        return yield* durablePlanOperation<Json>(
          `plan:check:${id}:${sourceDigest(candidate)}`,
          function* () {
            const validation = yield* validate(candidate);
            const answer: CandidateAssessment =
              validation.outcome === "invalid"
                ? { valid: false, diagnostics: { validation } as unknown as Json }
                : { valid: true, diagnostics: {} };
            return { valid: answer.valid, diagnostics: answer.diagnostics };
          },
        );
      },
  };
}

/**
 * Structurally admit the exact approved bytes, after the whole authorship frame
 * has gone.
 *
 * Nothing is executed, and the string that comes back is the string that went
 * in — no trimming, no fence removal, no normalization, no added newline.
 */

/** What the frozen inputs retained, or nothing when the record is not one. */
interface RetainedInputs {
  readonly syntax: string;
  readonly instruction: string;
}

/**
 * The frozen inputs a record holds, read as a closed protocol.
 *
 * Exactly two members, both strings. A record missing one, carrying a member
 * this version does not know, or holding one of the wrong type is a record this
 * version cannot read — not one to fill in a default for, because every default
 * here is a guess about what an earlier run actually asked.
 */
function readInputs(value: Json): RetainedInputs | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { syntax, instruction } = value;
  if (Object.keys(value).length !== 2) {
    return undefined;
  }
  if (typeof syntax !== "string" || typeof instruction !== "string") {
    return undefined;
  }
  return { syntax, instruction };
}

/**
 * What a record this version cannot read is refused with.
 *
 * A `StaleInputError`, like the changed-instruction refusal and for the same
 * reason: it is raised while the journal still holds entries this run will now
 * never reach, and an ordinary failure there is replaced by the completion's
 * divergence report — so the person would read a count of unreached entries
 * instead of what was actually wrong with their history.
 */
const UNREADABLE_INPUTS =
  "the retained Plan inputs cannot be read as Plan inputs, so no Plan source was produced.";

/**
 * What a continuation asking for a different Plan is refused with.
 *
 * A `StaleInputError` rather than an ordinary failure, because that is exactly
 * what this is: the effect identity matches — same site, same occurrence — and
 * what changed is outside the journal. Raising it as one also makes it the
 * run's authoritative outcome, so the person reads why their Plan was refused
 * instead of a count of unreached journal entries.
 */
const STALE =
  "this Plan was written for different instructions, so the retained Plan is stale input. " +
  "No Plan source was produced, and none was written for the new instructions. Re-run from " +
  "the start rather than resuming a journal that answers a different question.";

/**
 * The record one approved Plan leaves behind.
 *
 * Five facts, retained together because they are one answer: which invocation
 * asked, which prompt it asked about, the exact bytes that were approved, their
 * digest, and that the structural admission succeeded. A continuation reads it
 * back as hostile data — a history is input, not a value this process left in
 * memory — and hands back those bytes without another turn, repair, check,
 * review, explanation or admission.
 */
interface PlanArtifact {
  readonly invocation: string;
  readonly instruction: string;
  readonly source: string;
  readonly digest: string;
  readonly admission: "valid";
}

/**
 * What a record holds, read as a closed protocol.
 *
 * Exactly five members. A record missing one, carrying a sixth this version does
 * not know, or holding one of the wrong type is refused rather than read
 * partially: this record is the only thing standing between a continuation and
 * publishing bytes nobody approved, so a member it cannot account for is a
 * reason to stop.
 */
function readArtifact(value: Json): PlanArtifact | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { invocation, instruction, source, digest, admission } = value;
  if (Object.keys(value).length !== 5) {
    return undefined;
  }
  if (typeof invocation !== "string" || typeof instruction !== "string") {
    return undefined;
  }
  if (typeof source !== "string" || typeof digest !== "string" || admission !== "valid") {
    return undefined;
  }
  return { invocation, instruction, source, digest, admission };
}

const UNREADABLE_ARTIFACT =
  "the retained Plan artifact cannot be read as one, so no Plan source was produced.";

function admitPlan(validate: StructuralValidation): IdentityComponent {
  return {
    name: "AdmitPlan",
    origin: `${PLAN_ORIGIN}#AdmitPlan`,
    forms: ["self-closing"],
    props: ADMIT_PROPS,
    returns: { type: "string" },
    factory: (claim: IdentityClaimant) =>
      function* AdmitPlan(
        props: Record<string, Json>,
        invocation: ComponentInvocation,
      ): Operation<Json> {
        const id = yield* claim(invocation);
        const candidate = String(props.source);
        const instruction = sourceDigest(String(props.instruction));
        // Named for the invocation alone. A name carrying the candidate's digest
        // would be a different record for every draft, so a continuation whose
        // instructions moved would author a second Plan rather than meet the one
        // this site already has.
        const retained = yield* durablePlanOperation<Json>(`plan:artifact:${id}`, function* () {
          const validation = yield* validate(candidate);
          if (validation.outcome === "invalid") {
            throw new Error(
              "the approved Plan does not validate:\n" +
                JSON.stringify(validation.diagnostics, null, 2),
            );
          }
          return {
            invocation: id,
            instruction,
            source: candidate,
            digest: sourceDigest(candidate),
            admission: "valid",
          };
        });

        const artifact = readArtifact(retained);
        if (artifact === undefined) {
          throw new StaleInputError(UNREADABLE_ARTIFACT);
        }
        if (artifact.invocation !== id || artifact.digest !== sourceDigest(artifact.source)) {
          throw new StaleInputError(UNREADABLE_ARTIFACT);
        }
        if (artifact.instruction !== instruction) {
          throw new StaleInputError(STALE);
        }
        // Byte for byte: what was approved is what comes back, and the
        // admission decided only whether it may.
        return artifact.source;
      },
  };
}

/**
 * One durable operation of this Component's, named so that a reader of the journal
 * can tell which phase it was without any of it being in the record.
 *
 * The description carries the expansion identity and, where two calls at one
 * site could be about different things, the digest that tells them apart. It
 * carries no Prompt, no candidate source, no diagnostics and no session name.
 */
function durablePlanOperation<T extends Json>(
  name: string,
  body: () => Operation<T>,
): Operation<T> {
  return (function* (): Operation<T> {
    return (yield createDurableOperation<T>({ type: "call", name }, body)) as T;
  })();
}
