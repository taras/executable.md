/**
 * What a trusted host allows a generated fragment to do, stated before any
 * document code exists.
 *
 * `<Evaluate>` is a public component: any author may write it, and canonical
 * core owns what it means. That settles *which implementation runs* and nothing
 * else — protection grants no permission. Canonical `<Evaluate>` admits only
 * the entries already captured in this profile, selected by `allow`. So the
 * ceiling lives here, in a value the host hands canonical execution at the
 * installation boundary, before a document exists to ask for it.
 *
 * ## Host input and what execution captures are two shapes
 *
 * A host states {@link FragmentEvaluationInput}: entry tables, an optional
 * Workspace snapshot operation, and whether it accepts the released `source`
 * spelling. Canonical execution turns that into a captured profile of its own
 * — every value deep-copied and frozen, every admitted implementation resolved
 * once and held to this execution — and keeps the captured one. A host that
 * mutates its own arrays, headers or tables after installation changes nothing
 * about the execution, because the execution is no longer reading them.
 *
 * Only the input type is exported, and only from the trusted `core/host`
 * surface, because that is where `ExecutionInstallation` already is. The
 * captured profile, its bound operations and its revocation are unexported:
 * ordinary core publishes no getter for the active profile and no way to install
 * a provider.
 *
 * ## One per execution
 *
 * Two profiles would be two answers to "what may a fragment do here", and
 * choosing between them by installation order would make permission depend on
 * assembly. So an execution accepts one and refuses two — even two identical
 * ones, because a host that stated it twice has an assembly nobody validated.
 * A host that stated none offers no evaluation at all, which `<Evaluate>`
 * refuses with when it is invoked rather than at installation: a document that
 * never writes `<Evaluate>` is not asking for a ceiling.
 */

import type { Operation } from "effection";

import { CORE_ORIGIN, ELICIT_COMPONENT } from "./components/registry.ts";
import { SYNTAX_COMPONENT } from "./components/Syntax.ts";
import {
  CAPABILITY_FORMS,
  capabilityImplementation,
  capabilityProps,
  captureCapabilities,
  FragmentCapabilityError,
  REVOKED_CAPABILITY,
} from "./fragment-capabilities.ts";
import type {
  CapabilityImplementation,
  CapturedCapabilities,
  FragmentCapability,
} from "./fragment-capabilities.ts";
import { isFormDispatcher } from "./invocation-identity.ts";
import type { ComponentInvocation, ComponentRouting } from "./invocation-identity.ts";
import type { FetchRequest } from "./fetch-request.ts";
import { normalizeFetchRequest, requestRecord } from "./fetch-request.ts";
import { JSON_COMPOSITION_IDENTITY, pinnedJson } from "./generated-xmd.ts";
import type { GeneratedRequest } from "./generated-xmd.ts";
import { definitionGeneratedRefusal, offeredForm } from "./components/generated-metadata.ts";
import type { GeneratedEffect } from "./components/generated-metadata.ts";
import type { FunctionComponent, FunctionComponentDefinition, Json, PropsSchema } from "./types.ts";

/** The two forms an element is actually written in. */
export type FragmentForm = "self-closing" | "paired";

/**
 * One component a generated fragment may name, as the host states it.
 *
 * A closed union of the two ways a host can say what is behind a name, and it
 * is closed on purpose: a third shape would be a third answer to "where does
 * this implementation come from", which is exactly the question an admission
 * has to settle once.
 *
 * Neither arm carries a function. A capability names a component canonical
 * core supplies; a component answer names something the ordinary import chain
 * resolves, which canonical capture does once — before any document code — and
 * then holds by value. What is journaled is the admitted spellings, the
 * identity each of them runs under, and the limits.
 */
export type FragmentEntry = CapabilityEntry | ComponentAnswerEntry;

/** An entry canonical core supplies the component for. */
export interface CapabilityEntry {
  readonly kind: "capability";
  /** The name a fragment writes. */
  readonly name: string;
  /**
   * The exact spellings this entry is admitted for.
   *
   * A component whose two spellings do different things is two entries under
   * one name — `<File />` reads and `<File>…</File>` writes — and each spelling
   * carries its own identity and effect on the declaration that owns the
   * implementation, so preflight chooses between them before the first effect.
   */
  readonly forms: readonly FragmentForm[];
  /** The contract this entry's props are validated against. */
  readonly props: PropsSchema;
  /**
   * What this entry does, for the agent being told it may write the name.
   *
   * The host's, because the entry is: canonical core supplies the operation
   * behind a capability, and only the host knows what admitting it under this
   * name means here. A narrowed catalog without it would name a component and
   * say nothing about it, which is the one thing the catalog exists to avoid.
   */
  readonly description?: string;
  /**
   * Which of core's own components this entry runs.
   *
   * A name rather than a definition, because the definition is core's to
   * supply: capture answers with the ordinary `<File>`, `<File.Delete>`,
   * `<Dir>`, `<Glob>`, `<Fetch>` or `<Elicit>` an author writes, held to the
   * execution that captured it. So a host chooses *what a fragment may do* and
   * never *how it reaches it*: the operation crosses the contextual provider
   * and the consuming scope's `Permissions` exactly as an authored element's
   * does (`fragment-capabilities.ts`).
   */
  readonly capability: FragmentCapability;
  /**
   * The exact requests this entry may perform, for an entry that performs any.
   *
   * Stated per entry rather than per profile, because a ceiling belongs to the
   * identity it bounds: two entries performing requests are two ceilings, and
   * flattening them would let one entry's limit admit another's request.
   */
  readonly requests?: readonly GeneratedRequest[];
}

/**
 * An entry whose implementation the ordinary import chain answers for.
 *
 * The host states *what it expects* — the name and the forms — and states no
 * implementation at all. There is no definition, function, resolver, provider
 * operation, identity or context handle on this arm to hold one.
 *
 * Canonical capture resolves the name once, before the root import and before
 * any document code, through the complete ordinary `Component.importComponent`
 * chain; takes the definition the provider published on that exact final
 * answer; retains it defensively; and seals the result. Props, the callable
 * definition and the identity each admitted form runs under are all derived
 * from that answer rather than restated here, so a host cannot describe a
 * contract or an effect the implementation does not have.
 *
 * Resolution happens at capture and never again. A fragment invokes the sealed
 * snapshot, and a continuation resolves once more in its own capture and
 * reconciles before any effect. Calling a retained resolver later would see
 * document-time middleware, which is the whole thing this avoids.
 */
export interface ComponentAnswerEntry {
  readonly kind: "component-answer";
  readonly name: string;
  readonly forms: readonly FragmentForm[];
  readonly description?: string;
}

/**
 * How a host answers what its Workspace currently retains.
 *
 * An operation rather than a value, because a run's own progress legitimately
 * advances it: every committed mutation retains another immutable root. A
 * basis captured once at installation would be stale by the second evaluation
 * in one run, so canonical `<Evaluate>` asks this per invocation instead.
 *
 * An ordinary host has none — it evaluates against no Workspace at all, which
 * is a different statement from evaluating against an empty one.
 */
export interface FragmentWorkspaceAccess {
  snapshot(): Operation<{ readonly roots: readonly string[]; readonly current: string }>;
}

/** One host's complete statement of what a fragment may do. */
export interface FragmentEvaluationInput {
  /**
   * The entries the `read` class resolves to.
   *
   * For the ordinary profile this is the self-closing `<File>`, the
   * self-closing `<Glob>` and canonical `<Syntax />`; the workflow profile
   * states its own. `<Fetch>` joins it only where the host also states the
   * exact requests it may perform.
   */
  readonly read: readonly FragmentEntry[];
  /**
   * The entries the `write` class resolves to, when this host offers the class.
   *
   * The two standard profiles differ here: the ordinary one is paired
   * `<File>`, self-closing `<File.Delete>` and paired `<Elicit>`, while the
   * workflow one is paired `<File>`, paired `<Dir>` and self-closing
   * `<File.Delete>`. Neither includes the read table: `write` selects mutation
   * and nothing else.
   */
  readonly write?: readonly FragmentEntry[];
  /** How this host answers for its Workspace, when it evaluates against one. */
  readonly workspace?: FragmentWorkspaceAccess;
  /**
   * The effective Fetch timeout this host resolved, in milliseconds.
   *
   * Resolved once, by the host, when it builds the profile. Reading it from
   * context during preflight would let the ceiling a fragment is held to depend
   * on where the reading happened.
   */
  readonly fetchTimeout?: number;
}

/**
 * Core's `<File />`, admitted to observe and not to write.
 *
 * `<File>` reads when it has no content and writes when it has some, so one
 * unconstrained entry would admit a write. Each spelling carries its own
 * identity and effect on core's own declaration, and preflight decides between
 * the two — before the first effect, rather than inside a body that has already
 * been entered.
 *
 * An admitted read is core's ordinary `<File />` performing its ordinary
 * operation: it resolves the contextual working directory and reads through
 * `API.Files`, under the provider the host installed and the effective
 * `Permissions` of the consuming scope. Under a workflow run that provider is
 * the transaction-bound one, so the read crosses the run's own transaction for
 * the same reason an authored read does.
 */
export function fileReadEntry(): CapabilityEntry {
  return coreEntry("File", "file:read");
}

/**
 * Core's `<Glob />`, admitted to select paths and nothing else.
 *
 * A value entry: core's own declaration states what it binds, so a generated
 * `<Glob />` written without `as` is refused before any provider is asked to
 * traverse anything. What it selects is bounded the same way a read is — the
 * contextual working directory it resolves, and the `API.Files` provider the
 * host installed — so the paths it answers with are the ones that provider
 * produced for that directory.
 */
export function globReadEntry(): CapabilityEntry {
  return coreEntry("Glob", "files:glob");
}

/**
 * The protected names canonical execution states what is behind, for a profile.
 *
 * An allowlist rather than "every protected name", because core publishing an
 * answer is what makes a protected name admissible: a host that wrote
 * `<Evaluate>` into its read table would otherwise obtain evaluation inside
 * evaluation, which is a different grant from being shown a vocabulary. Core
 * answers for the one protected name it offers a host an entry for, and a
 * hand-written entry for any other resolves to an answer nobody published and
 * is refused.
 */
export const CANONICAL_PROFILE_ANSWERS: ReadonlySet<string> = new Set([SYNTAX_COMPONENT]);

/**
 * Canonical `<Syntax />`, admitted as the answer the import chain gives for it.
 *
 * Not a capability: `<Syntax />` is canonical core's protected component, and a
 * capability arm would be core supplying a second body for a name it already
 * owns. So the entry states the name and the one form it has, and canonical
 * capture resolves it once through the ordinary import chain — where core
 * publishes its own answer for it — and seals that answer through the
 * execution's own protected-body route. The identity the fragment is admitted
 * under is the one core's declaration states for that form.
 *
 * Admitting it grants no other permission. The symbols an occurrence renders
 * describe the vocabulary the fragment has; naming a component in them is not
 * permission to run it, and a component the fragment may only read about stays
 * unavailable.
 */
export function syntaxReadEntry(): ComponentAnswerEntry {
  return {
    kind: "component-answer",
    name: SYNTAX_COMPONENT,
    forms: ["self-closing"],
    description:
      "Render the components this evaluation may write, or selected documentation. " +
      "Written self-closing.",
  };
}

/**
 * Canonical `<Elicit>`, admitted as a question a generated fragment may ask.
 *
 * A capability, not a component answer. What core owns here is the *behavior*,
 * so the body a fragment reaches is pinned the way `<File>`'s is rather than
 * resolved by name: the ordinary import chain answers for the authored element,
 * where a repository file, a registration, a declaration and the workflow's own
 * suspension replacement all legitimately shadow it, and none of them is what a
 * generated fragment was admitted to run.
 *
 * Resolving it was also the wrong *time*. An admitted component answer is
 * resolved for every execution the profile belongs to, before any document code
 * — so a name a host had quite properly shadowed made executions that never ask
 * anything refuse, and a document holding only `<File>` was refused for an
 * entry it never wrote. Nothing is resolved now: preflight selects this entry
 * only where it finds an `<Elicit>` occurrence, and what it selects is core's.
 *
 * In the write table and not the read one. Asking a person is not reading:
 * `allow={["read"]}` admits what a fragment may look at without anyone being
 * interrupted, and a question is an interaction whose answer then drives what
 * the fragment writes. A program a person is asked to approve before it writes
 * is the case this exists for, and a `read` fragment that could ask would be
 * able to interrupt on a permission that promised it would not.
 *
 * Paired only. The question is the content, so a self-closing spelling would be
 * a request with nothing in it.
 */
export function elicitWriteEntry(): CapabilityEntry {
  return coreEntry(ELICIT_COMPONENT, "elicit:ask");
}

/** Core's `<File>…</File>`, admitted to write and not to read. */
export function fileWriteEntry(): CapabilityEntry {
  return coreEntry("File", "file:write");
}

/**
 * Core's `<File.Delete />`, in the one form it has.
 *
 * One name, one form: unlike `<File>`, whose two spellings do different things,
 * this answers the self-closing form alone. Stating the form is what puts the
 * decision in preflight, before the fragment's first effect — a paired spelling
 * costs an earlier admitted element nothing.
 */
export function fileDeleteEntry(): CapabilityEntry {
  return coreEntry("File.Delete", "file:delete");
}

/**
 * A directory an admitted fragment may create, under the name the host gives it.
 *
 * The name is the host's because the component is: the workflow calls it
 * `<Dir>`, and an ordinary run admits no such thing. What core supplies is the
 * component — its implementation, and the identity and effect its paired form
 * is offered under — so a host chooses whether the name is admitted here and
 * never what admitting it grants.
 */
export function directoryEntry(name: string): CapabilityEntry {
  return {
    kind: "capability",
    name,
    forms: [...CAPABILITY_FORMS["directory:ensure"]],
    capability: "directory:ensure",
    props: capabilityProps("directory:ensure"),
    description: CORE_DESCRIPTIONS["directory:ensure"],
  };
}

/**
 * Core's `<Fetch />`, bounded to exactly these requests.
 *
 * The ceiling is not optional and this constructor does not decide it: an
 * unbounded network read is a different grant from an admitted one, and a host
 * that states no request admits `<Fetch>` not at all rather than admitting it
 * and refusing everything it asks for.
 */
export function fetchEntry(requests: readonly GeneratedRequest[]): CapabilityEntry {
  return { ...coreEntry("Fetch", "fetch"), requests };
}

/** What core's own entries tell an agent they do. */
const CORE_DESCRIPTIONS: Readonly<Record<FragmentCapability, string>> = Object.freeze({
  "elicit:ask":
    "Ask a person a structured question and bind the validated answer. Written paired, with " +
    "the request as its content.",
  "file:read": "Read one file and render its text. Written self-closing.",
  "files:glob":
    "Select the files under the working directory that these patterns match, as a sorted " +
    "list of relative paths. Written self-closing and captured with `as`.",
  "file:write": "Write what it renders to one file. Written with content.",
  "file:delete": "Remove one file. Written self-closing.",
  "directory:ensure":
    "Make one directory exist, and resolve the paths inside it against it. Written with content.",
  fetch: "Perform one admitted HTTP read. Written self-closing.",
});

function coreEntry(name: string, capability: FragmentCapability): CapabilityEntry {
  return {
    kind: "capability",
    name,
    forms: [...CAPABILITY_FORMS[capability]],
    capability,
    props: capabilityProps(capability),
    description: CORE_DESCRIPTIONS[capability],
  };
}

/**
 * One provider-backed name, already resolved and reconciled.
 *
 * Produced by canonical execution's capture step before this module is asked
 * to seal anything: the chain has answered, the definition the provider
 * published has been taken off that exact final object, and it has been
 * retained defensively. What arrives here is the settled result, so nothing in
 * this module resolves, looks up, or holds a resolver it could call later.
 */
export interface ResolvedAnswer {
  /** Core's own retained copy, which is what a fragment invokes. */
  readonly definition: FunctionComponentDefinition;
  /** Which provider installation published it, as documentation provenance. */
  readonly origin: string;
}

/** Every provider-backed name this capture resolved, by name. */
export type ResolvedAnswers = ReadonlyMap<string, ResolvedAnswer>;

/**
 * One captured entry: frozen structural data beside one sealed implementation.
 *
 * `kind` survives capture because the retained record keeps it: a continuation
 * comparing identities has to know whether the thing behind a name was core's
 * own operation or a provider's answer, and the two are different grants.
 *
 * There is no identity on it. Which URL and effect each admitted form runs
 * under is on the definition this entry already holds, declared by whoever owns
 * the implementation, so a capture that restated them would be a second source
 * for one fact.
 */
export interface CapturedEntry {
  /** Documentation provenance of an exact routed answer; grants no callable permission. */
  readonly protectedOrigin?: string;
  readonly name: string;
  /**
   * Where this entry's implementation came from, for a reader and for the
   * admitted vocabulary's symbols.
   *
   * Core's own origin for an operation core supplies the body for, and the
   * publishing installation's for a provider's answer. Documentation
   * provenance: it is no part of what the implementation is, and nothing
   * compares a continuation against it.
   */
  readonly origin: string;
  readonly forms: readonly FragmentForm[];
  readonly props: PropsSchema;
  readonly kind: "capability" | "component-answer" | "composition";
  /** Which operation this runs, for a capability entry. */
  readonly capability?: FragmentCapability;
  /** What the admitted vocabulary says this entry does, when the host said. */
  readonly description?: string;
  /**
   * What a fragment invokes.
   *
   * For a capability, core's own body closed over the operations this capture
   * bound. For a component answer, core's retained copy of the exact final
   * answer the import chain gave — never the object the chain was holding, and
   * never something re-resolved later.
   */
  readonly definition: FunctionComponentDefinition;
  /**
   * The form dispatcher underneath this entry's implementation, when the sealed
   * definition wraps one.
   *
   * A component answer runs behind a lifetime guard canonical capture built, so
   * the function on the definition is core's rather than the provider's. A
   * provider whose own answer dispatches on the authored form would otherwise
   * lose that dispatch, because what a selection records as the form dispatcher
   * is read off the definition it was handed. So the dispatcher travels
   * explicitly, and a capability — whose definition is core's own dispatcher —
   * states none.
   */
  readonly dispatch?: unknown;
  /** This entry's own ceiling, normalized once and canonically ordered. */
  readonly requests?: readonly FetchRequest[];
}

/** What canonical execution keeps, and what canonical `<Evaluate>` reads. */
export interface EvaluationProfile {
  /**
   * The pure components every evaluation may write, whatever `allow` selects.
   *
   * Core's own, and not a table a host states: composition carries no effect
   * operation, so admitting it grants nothing and omitting it would take a
   * language construct away rather than a permission. `allow` selects between
   * the two effect tables below and never between these.
   */
  readonly composition: readonly CapturedEntry[];
  readonly read: readonly CapturedEntry[];
  readonly write: readonly CapturedEntry[];
  readonly workspace?: FragmentWorkspaceAccess;
  /** Whether this profile's admitted implementations are still usable. */
  readonly live: () => boolean;
  /**
   * End them.
   *
   * Called by canonical execution at teardown, and reachable from nowhere a
   * document can put code: an operation a fragment or a handler retained past
   * the execution refuses rather than acting on a filesystem the run no longer
   * holds a transaction for.
   */
  readonly revoke: () => void;
}

/** What an execution that was offered no evaluation profile refuses with. */
export const NO_PROFILE =
  "<Evaluate /> has no evaluation profile here: this host stated none, so nothing established " +
  "what a generated fragment may do. A profile is the host's own statement of the maximum " +
  "permission an evaluation has, and `allow` only narrows it.";

/** What an execution offered two evaluation profiles refuses with. */
export const TWO_PROFILES =
  "two installations stated the evaluation profile this execution offers. One execution offers " +
  "one maximum permission, so what a generated fragment may do is never a question of assembly " +
  "order.";

/** What a profile whose execution has ended refuses with. */
export const REVOKED =
  "the evaluation profile this fragment was admitted under belongs to an execution that has " +
  "ended.";

/** A profile a host stated in a shape canonical execution cannot capture. */
export class EvaluationProfileError extends Error {
  override name = "EvaluationProfileError";
}

/**
 * One entry this execution has copied, before it knows what is behind a
 * provider-backed name.
 *
 * Everything a host stated is already settled here — the forms, the schema for
 * a capability, the ceiling, and the effect table this entry came from. What is
 * missing is exactly the part a host does not state: a component answer's
 * implementation, the contract that comes with it, and the identity its own
 * declaration offers each admitted form under.
 */
interface PreparedEntry {
  readonly name: string;
  readonly forms: readonly FragmentForm[];
  readonly kind: "capability" | "component-answer" | "composition";
  /** Which table admitted it, so a form's offered effect is checked against it. */
  readonly effect: GeneratedEffect;
  readonly description?: string;
  readonly props?: PropsSchema;
  readonly capability?: FragmentCapability;
  readonly definition?: FunctionComponentDefinition;
  /** The owning component's own form dispatcher, when its implementation wraps one. */
  readonly dispatch?: unknown;
  readonly requests?: readonly FetchRequest[];
}

/**
 * One host's profile, copied and bound, waiting only for its provider answers.
 *
 * Preparation is where a host stops being consulted: the tables are copied, the
 * identities and forms are frozen, the ceilings are normalized, and every live
 * operation is read off the host's objects once and bound behind this
 * execution's revocation. A host that mutates its own arrays, headers or tables
 * afterwards changes nothing.
 *
 * What preparation cannot do is decide what a provider-backed name resolves to:
 * that takes the complete ordinary import chain, which does not exist until the
 * providers have installed. So it publishes the names that need resolving and
 * seals afterwards.
 */
export interface PreparedProfile {
  /**
   * The provider-backed names this profile admits.
   *
   * Names alone, because what is behind one is the definition the chain
   * answers with: a host states which names it admits and the owning
   * declaration states what each admitted form runs as. Empty for a
   * capability-only profile, which performs no component-chain lookup at all —
   * a host that offers no provider answer pays for none.
   */
  readonly answered: readonly string[];
  /** Whether the operations this preparation bound are still usable. */
  readonly live: () => boolean;
  /** End them. Registered by canonical execution before any installation runs. */
  readonly revoke: () => void;
  /** Seal answers, projecting lifetime wrappers through the execution's private operation. */
  seal(
    answers: ResolvedAnswers,
    project?: ComponentRouting["project"],
  ): Operation<EvaluationProfile>;
}

/**
 * Copy and bind one host's profile, before any installation runs.
 *
 * Everything structural is copied and frozen here, so a host mutating its own
 * arrays, schemas, headers or tables afterwards changes nothing this execution
 * does. What is not copied is the implementation itself: a function is the one
 * thing a profile must keep by reference, and it is kept behind a revocation
 * this execution owns rather than handed onward.
 */
export function* prepareEvaluationProfile(
  input: FragmentEvaluationInput,
): Operation<PreparedProfile> {
  // The lifetime every admitted implementation is held to, opened here before a
  // single installation has run. There is no host operation to read off an
  // object any more: an admitted name runs canonical core's own component,
  // through the provider installed where the fragment runs.
  const capabilities = captureCapabilities();
  // One definition per *name*, built from every capability that name holds
  // across both tables. `<File />` observing and `<File>…</File>` writing are
  // two entries under one name, and the evaluator resolves an import by name —
  // so they arrive as one definition whose dispatch separates the two
  // spellings, exactly as the ordinary `<File>` does.
  const built = buildDefinitions(input, capabilities);
  const read = yield* prepareEntries(input.read ?? [], "read", input.fetchTimeout, built);
  const write = yield* prepareEntries(input.write ?? [], "write", input.fetchTimeout, built);
  if (read.length === 0 && write.length === 0) {
    throw new EvaluationProfileError(
      "an evaluation profile states no component at all. A host offering evaluation states what " +
        "a fragment may do; one that offers none states no profile.",
    );
  }
  // One lookup per distinct name, however many entries and tables hold it: a
  // name resolves to one implementation, and asking twice would be two chances
  // for the chain to answer differently.
  // Core's own, built before the host's tables are examined, so a host naming
  // one of these refuses at capture rather than shadowing it at evaluation.
  const composition = compositionEntries();
  const reserved = new Set(composition.map((entry) => entry.name));
  for (const entry of [...read, ...write]) {
    if (reserved.has(entry.name)) {
      throw new EvaluationProfileError(
        `an evaluation profile admitted "${entry.name}" as an effect, and it is trusted ` +
          "composition every evaluation already has. One name is one component, and a table " +
          "cannot give an effect to a name that performs none.",
      );
    }
  }
  const answered = answeredNames([...read, ...write]);
  const workspace = input.workspace === undefined ? undefined : bindWorkspace(input.workspace);
  return Object.freeze({
    answered: Object.freeze([...answered]),
    live: () => capabilities.live(),
    revoke: () => {
      capabilities.revoke();
    },
    // deno-lint-ignore require-yield
    *seal(
      answers: ResolvedAnswers,
      project?: ComponentRouting["project"],
    ): Operation<EvaluationProfile> {
      // One sealed implementation per name, built before either table is
      // sealed. A name that holds two entries — the self-closing spelling in
      // `read` and the paired one in `write` — is one component seen from two
      // sides, so both entries carry the same object: two guards over one
      // answer would be two lifetimes for one implementation, and which of
      // them a fragment reached would depend on which table admitted it.
      const sealed = sealAnswers(answered, answers, capabilities, project);
      return Object.freeze({
        composition,
        read: sealEntries(read, sealed),
        write: sealEntries(write, sealed),
        ...(workspace === undefined ? {} : { workspace }),
        live: () => capabilities.live(),
        revoke: () => {
          capabilities.revoke();
        },
      });
    },
  });
}

/**
 * The trusted composition table, as this execution retains it.
 *
 * Built from the same pinned core entry the evaluator admits, so the vocabulary
 * an agent is shown and the vocabulary preflight enforces are one fact rather
 * than two copies of one. Nothing here is a host's to state: a composition
 * entry runs a component that performs nothing, so there is no operation to
 * bind and no revocation to hold.
 */
function compositionEntries(): readonly CapturedEntry[] {
  return Object.freeze(
    [pinnedJson()].map((entry) =>
      Object.freeze({
        name: entry.name,
        origin: CORE_ORIGIN,
        forms: Object.freeze<FragmentForm[]>(["self-closing"]),
        props: detach(entry.definition.props),
        kind: "composition" as const,
        definition: entry.definition,
        ...(typeof entry.definition.description === "string"
          ? { description: entry.definition.description }
          : {}),
      }),
    ),
  );
}

/**
 * The workspace access, read once and bound.
 *
 * Bound rather than kept as the host's object, so replacing the method on that
 * object after installation reaches nothing.
 */
function bindWorkspace(access: FragmentWorkspaceAccess): FragmentWorkspaceAccess {
  const snapshot = access.snapshot.bind(access);
  return Object.freeze({
    *snapshot() {
      const answered = yield* snapshot();
      // Copied on the way out too: what the host answered with is its own
      // object, and the basis this invocation is admitted under must not move
      // afterwards.
      return Object.freeze({
        roots: Object.freeze([...answered.roots]),
        current: answered.current,
      });
    },
  });
}

/**
 * One definition per admitted name, built before any entry is captured.
 *
 * Built here rather than per entry because a name's definition depends on
 * *every* capability that name holds: a profile admitting `<File />` to read
 * and `<File>…</File>` to write is describing one component with two spellings,
 * and which body a spelling reaches is dispatch's decision rather than the
 * table's.
 *
 * A ceiling belongs to the entry that states it, so the requests handed to a
 * name's definition are that name's own — never a flattened set, which would
 * let one entry's limit admit another's request.
 */
function buildDefinitions(
  input: FragmentEvaluationInput,
  capabilities: CapturedCapabilities,
): Map<string, CapabilityImplementation> {
  const admitted = new Map<
    string,
    { "self-closing"?: FragmentCapability; paired?: FragmentCapability }
  >();
  const ceilings = new Map<string, readonly GeneratedRequest[]>();
  for (const entry of [...(input.read ?? []), ...(input.write ?? [])]) {
    // A component answer has no capability behind it: canonical capture
    // resolves its implementation through the ordinary import chain and derives
    // the definition from that answer, so there is nothing for this to build.
    if (entry.kind !== "capability") {
      continue;
    }
    const held = admitted.get(entry.name) ?? {};
    for (const form of CAPABILITY_FORMS[entry.capability]) {
      held[form] = entry.capability;
    }
    admitted.set(entry.name, held);
    if (entry.requests !== undefined) {
      ceilings.set(entry.name, entry.requests);
    }
  }
  const built = new Map<string, CapabilityImplementation>();
  for (const [name, forms] of admitted) {
    built.set(
      name,
      capabilityImplementation(
        name,
        forms,
        capabilities,
        normalizedCeiling(ceilings.get(name), input),
      ),
    );
  }
  return built;
}

/**
 * One name's ceiling, normalized on the same terms the retained policy is.
 *
 * The component performs the admitted request rather than the props, so the
 * value it holds has to be the one preflight compared against — normalized
 * once, against the host's own resolved timeout, rather than read again from a
 * context wherever the performance happens.
 */
function normalizedCeiling(
  requests: readonly GeneratedRequest[] | undefined,
  input: FragmentEvaluationInput,
): readonly FetchRequest[] {
  if (requests === undefined) {
    return [];
  }
  return requests.map((request) => normalizeFetchRequest({ ...request }, input.fetchTimeout));
}

function* prepareEntries(
  entries: readonly FragmentEntry[],
  effect: GeneratedEffect,
  fetchTimeout: number | undefined,
  built: Map<string, CapabilityImplementation>,
): Operation<readonly PreparedEntry[]> {
  const prepared: PreparedEntry[] = [];
  for (const entry of entries) {
    prepared.push(yield* prepareEntry(entry, effect, fetchTimeout, built));
  }
  return Object.freeze(prepared);
}

function* prepareEntry(
  entry: FragmentEntry,
  effect: GeneratedEffect,
  fetchTimeout: number | undefined,
  built: Map<string, CapabilityImplementation>,
): Operation<PreparedEntry> {
  const forms = canonicalForms(entry.forms);
  if (forms.length === 0) {
    throw new EvaluationProfileError(
      `an evaluation profile admitted "${entry.name}" for no authored form.`,
    );
  }
  const described =
    typeof entry.description === "string" && entry.description.length > 0
      ? { description: entry.description }
      : {};

  if (entry.kind === "component-answer") {
    // Nothing about the implementation is settled here. What this entry states
    // is which name and which forms; the chain answers later, and the props,
    // the identity and the effect all come from that answer rather than from
    // the host, so a host cannot describe a contract or an effect the
    // implementation lacks.
    return Object.freeze({
      name: entry.name,
      forms,
      kind: "component-answer" as const,
      effect,
      ...described,
    });
  }

  const requests =
    entry.requests === undefined
      ? undefined
      : yield* captureRequests(entry.requests, fetchTimeout, entry.name);
  // Detached, so a host that edits its schema afterwards does not change what a
  // fragment's props are validated against.
  const props = detach(entry.props);
  // The implementation every entry under this name shares, built before any
  // entry was prepared.
  const implementation = built.get(entry.name);
  if (implementation === undefined) {
    throw new EvaluationProfileError(
      "an evaluation profile admitted a name with no operation behind it.",
    );
  }
  const prepared: PreparedEntry = Object.freeze({
    name: entry.name,
    forms,
    props,
    kind: "capability" as const,
    effect,
    capability: entry.capability,
    ...described,
    definition: implementation.definition,
    ...(implementation.dispatch === undefined ? {} : { dispatch: implementation.dispatch }),
    ...(requests === undefined ? {} : { requests }),
  });
  // Core supplies this body, so the owning declaration is already in hand: a
  // capability admitted in the table its owner does not offer that form to
  // refuses here, before an execution holds a profile at all.
  admittedIdentities(prepared, implementation.definition);
  return prepared;
}

/**
 * The provider-backed names this profile admits.
 *
 * A name is one component, so it resolves once and runs one implementation. Two
 * entries under one name are the two spellings of that component — the
 * self-closing one admitted to observe and the paired one to mutate — and both
 * read their own identity and effect off the one definition the chain answered
 * with, so there is nothing for a second entry to disagree about.
 *
 * A name a host holds as both a capability and a component answer is a real
 * ambiguity, and refuses: canonical core would supply one body and the import
 * chain the other, which are different grants under one spelling.
 */
function answeredNames(prepared: readonly PreparedEntry[]): ReadonlySet<string> {
  const answered = new Set<string>();
  const kinds = new Map<string, PreparedEntry["kind"]>();
  for (const entry of prepared) {
    const held = kinds.get(entry.name);
    if (held !== undefined && held !== entry.kind) {
      throw new EvaluationProfileError(
        `an evaluation profile admitted "${entry.name}" both as an operation core supplies the ` +
          "body for and as an implementation the import chain answers for. One name is one " +
          "component, and those are different grants.",
      );
    }
    kinds.set(entry.name, entry.kind);
    if (entry.kind === "component-answer") {
      answered.add(entry.name);
    }
  }
  return answered;
}

/** One provider-backed name's sealed implementation, shared by every entry. */
interface SealedAnswer {
  readonly protectedOrigin?: string;
  readonly origin: string;
  readonly props: PropsSchema;
  readonly definition: FunctionComponentDefinition;
  readonly dispatch?: unknown;
}

/**
 * One sealed implementation per provider-backed name, built once per capture.
 *
 * Built here rather than per entry because a name has one implementation: the
 * lifetime guard, the detached schema and the form dispatcher are properties of
 * that implementation, and building them twice would give one component two
 * bodies whose only difference was which table asked for it.
 */
function sealAnswers(
  answered: ReadonlySet<string>,
  answers: ResolvedAnswers,
  capabilities: CapturedCapabilities,
  project: ComponentRouting["project"] | undefined,
): ReadonlyMap<string, SealedAnswer> {
  const sealed = new Map<string, SealedAnswer>();
  for (const name of answered) {
    // Resolved once, before any document code, through the complete ordinary
    // import chain, and published there by the provider that supplied it.
    const resolved = answers.get(name);
    if (resolved === undefined) {
      throw new EvaluationProfileError(
        `an evaluation profile admitted "${name}" as a component answer, and this execution ` +
          "resolved none for it.",
      );
    }
    const answer = resolved.definition;
    const inner = answer.fn;
    const guard = bounded(inner, capabilities);
    const protectedOrigin = project?.(inner, guard);
    sealed.set(
      name,
      Object.freeze({
        origin: resolved.origin,
        props: detach(answer.props),
        definition: Object.freeze({ ...answer, fn: guard }),
        ...(protectedOrigin === undefined ? {} : { protectedOrigin }),
        // The provider's own dispatcher, when its answer has one. The
        // definition above runs behind core's lifetime guard, so what a
        // selection would read off it is core's function rather than the
        // provider's — and a form dispatcher read off the wrong function selects
        // no body at all.
        ...(isFormDispatcher(inner) ? { dispatch: inner } : {}),
      }),
    );
  }
  return sealed;
}

function sealEntries(
  prepared: readonly PreparedEntry[],
  sealed: ReadonlyMap<string, SealedAnswer>,
): readonly CapturedEntry[] {
  return Object.freeze(prepared.map((entry) => sealEntry(entry, sealed)));
}

function sealEntry(entry: PreparedEntry, sealed: ReadonlyMap<string, SealedAnswer>): CapturedEntry {
  const described = entry.description === undefined ? {} : { description: entry.description };
  if (entry.kind === "component-answer") {
    const answer = sealed.get(entry.name);
    if (answer === undefined) {
      throw new EvaluationProfileError(
        `an evaluation profile admitted "${entry.name}" as a component answer, and this ` +
          "execution resolved none for it.",
      );
    }
    // The identity each admitted form runs under is on this definition, so it
    // is checked here rather than at the first generated effect: a form the
    // provider's own declaration never offered, or offered under the other
    // effect, is a table this host cannot state.
    admittedIdentities(entry, answer.definition);
    return Object.freeze({
      name: entry.name,
      origin: answer.origin,
      forms: entry.forms,
      props: answer.props,
      kind: "component-answer" as const,
      ...described,
      definition: answer.definition,
      ...(answer.protectedOrigin === undefined ? {} : { protectedOrigin: answer.protectedOrigin }),
      ...(answer.dispatch === undefined ? {} : { dispatch: answer.dispatch }),
    });
  }
  const definition = entry.definition;
  const props = entry.props;
  if (definition === undefined || props === undefined) {
    throw new EvaluationProfileError(
      "an evaluation profile admitted a name with no operation behind it.",
    );
  }
  return Object.freeze({
    name: entry.name,
    origin: CORE_ORIGIN,
    forms: entry.forms,
    props,
    kind: "capability" as const,
    ...(entry.capability === undefined ? {} : { capability: entry.capability }),
    ...described,
    definition,
    ...(entry.dispatch === undefined ? {} : { dispatch: entry.dispatch }),
    ...(entry.requests === undefined ? {} : { requests: entry.requests }),
  });
}

/**
 * Hold each admitted form to the identity its owner offers it under.
 *
 * Two refusals, and both of them are about the table rather than about the
 * fragment: a form the owning declaration offers no generated use of has no
 * identity for a continuation to be compared against, and a form offered as a
 * read cannot be admitted in the write table — the effect belongs to the
 * spelling, so a host placing it elsewhere would be granting what the
 * implementation does not do.
 *
 * It keeps nothing. What a run retains is derived from the same definition
 * where the admission is recorded (`generated-xmd.ts`), so this is the early
 * refusal rather than a second copy of the fact.
 */
function admittedIdentities(entry: PreparedEntry, definition: FunctionComponentDefinition): void {
  // What the definition offers at all, before which of it this entry admits. A
  // provider's answer was read where it was published and core's own owners
  // where they are declared, so a refusal here is a definition that reached a
  // profile without crossing either.
  const refusal = definitionGeneratedRefusal(definition);
  if (refusal !== undefined) {
    throw new EvaluationProfileError(
      `an evaluation profile admitted "${entry.name}", whose declaration ${refusal}.`,
    );
  }
  for (const form of entry.forms) {
    const offered = offeredForm(definition.generated, form);
    if (offered === undefined) {
      throw new EvaluationProfileError(
        `an evaluation profile admitted "${entry.name}" in its ${form} form, and the ` +
          "declaration that owns that implementation offers no generated use of it. A " +
          "generated fragment runs a form its owner states an identity and an effect for.",
      );
    }
    if (offered.effect !== entry.effect) {
      throw new EvaluationProfileError(
        `an evaluation profile admitted "${entry.name}" in its ${form} form as a ` +
          `${entry.effect}, and its owner offers that form as a ${offered.effect}. What a ` +
          "spelling does belongs to the component, not to the table that admits it.",
      );
    }
  }
}

/**
 * One provider's implementation, held to this execution's lifetime.
 *
 * A capability reaches the host's operations through bindings this capture
 * already revokes, so a capability body retained past teardown refuses on its
 * own. A provider's answer reaches whatever the provider closed over, which this
 * execution never saw and cannot revoke — so the *entry* carries the lifetime
 * instead, and a definition somebody kept refuses rather than running against a
 * run that is over.
 *
 * The guard is what canonical capture builds the entry's definition around, not
 * a wrapper placed over one afterwards: this function is the implementation the
 * entry has ever had, so nothing about which body a form selects moves.
 */
function bounded(
  inner: FunctionComponentDefinition["fn"],
  capabilities: CapturedCapabilities,
): FunctionComponent {
  if (typeof inner !== "function") {
    throw new EvaluationProfileError(
      "an evaluation profile admitted a component answer with no invocable implementation.",
    );
  }
  const implementation = inner;
  return function* held(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<unknown> {
    if (!capabilities.live()) {
      throw new FragmentCapabilityError(REVOKED_CAPABILITY);
    }
    return yield* implementation(props, invocation);
  };
}

/** The forms an entry is admitted for: a non-empty set in canonical order. */
const FORMS: readonly FragmentForm[] = ["self-closing", "paired"];

function canonicalForms(forms: readonly FragmentForm[]): readonly FragmentForm[] {
  const held = new Set(forms);
  return Object.freeze(FORMS.filter((form) => held.has(form)));
}

/**
 * One entry's ceiling, normalized once and canonically ordered.
 *
 * Normalized here rather than at preflight so the comparison a continuation
 * makes is one normalization rather than two readings that could disagree, and
 * ordered so two hosts stating the same requests in different orders state the
 * same ceiling. The timeout is the host's resolved value: reading it from
 * context later would make the ceiling depend on where it was read.
 */
function* captureRequests(
  requests: readonly GeneratedRequest[],
  fetchTimeout: number | undefined,
  name: string,
): Operation<readonly FetchRequest[]> {
  if (requests.length === 0) {
    throw new EvaluationProfileError(
      `an evaluation profile admitted "${name}" as a request entry with no request it may perform.`,
    );
  }
  const normalized: FetchRequest[] = [];
  for (const request of requests) {
    // Normalized against the host's own resolved bound rather than a context
    // read: a ceiling compared across a suspension cannot depend on where the
    // comparison happened.
    const prepared = normalizeFetchRequest({ ...request }, fetchTimeout);
    normalized.push(
      Object.freeze({
        url: prepared.url,
        method: prepared.method,
        headers: Object.freeze({ ...prepared.headers }),
        ...(prepared.timeout === undefined ? {} : { timeout: prepared.timeout }),
      }),
    );
  }
  // Deduplicated and ordered by the record a continuation compares, so one
  // ceiling stated twice is one ceiling.
  const seen = new Map<string, FetchRequest>();
  for (const request of normalized) {
    seen.set(JSON.stringify(requestRecord(request)), request);
  }
  return Object.freeze(
    [...seen.entries()]
      .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
      .map(([, request]) => request),
  );
}

/** A frozen deep copy of one JSON value the host stated. */
function detach<T extends Json>(value: T): T {
  return freeze(structuredClone(value));
}

function freeze<T extends Json>(value: T): T {
  if (Array.isArray(value)) {
    for (const member of value) {
      freeze(member);
    }
    Object.freeze(value);
    return value;
  }
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) {
      freeze(member);
    }
    Object.freeze(value);
    return value;
  }
  return value;
}
