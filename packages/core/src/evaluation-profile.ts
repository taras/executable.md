/**
 * What a trusted host allows a generated fragment to do, stated before any
 * document code exists.
 *
 * `<Evaluate>` is a public component: any author may write it, and canonical
 * core owns what it means. That settles *which implementation runs* and nothing
 * else — protection grants no authority. Canonical `<Evaluate>` uses only
 * authority already captured in this profile, selected by `allow`. So the
 * ceiling lives here, in a value the host hands canonical execution at the
 * installation boundary, before a document exists to ask for it.
 *
 * ## Host input and what execution captures are two shapes
 *
 * A host states {@link FragmentEvaluationInput}: entry tables, an optional
 * Workspace snapshot operation, and whether it accepts the released `source`
 * spelling. Canonical execution turns that into a captured profile of its own
 * — every value deep-copied and frozen, every live operation read and bound
 * once — and keeps the captured one. A host that mutates its own arrays,
 * headers or tables after installation changes nothing about the execution,
 * because the execution is no longer reading them.
 *
 * Only the input type is exported, and only from the trusted `core/host`
 * surface, because that is where `ExecutionInstallation` already is. The
 * captured profile, its bound operations and its revocation are unexported:
 * ordinary core publishes no getter for active authority and no way to install
 * a provider.
 *
 * ## One per execution
 *
 * Two profiles would be two answers to "what may a fragment do here", and
 * choosing between them by installation order would make authority depend on
 * assembly. So an execution accepts one and refuses two — even two identical
 * ones, because a host that stated it twice has an assembly nobody validated.
 * A host that stated none offers no evaluation at all, which `<Evaluate>`
 * refuses with when it is invoked rather than at installation: a document that
 * never writes `<Evaluate>` is not asking for a ceiling.
 */

import type { Operation } from "effection";

import { CORE_ORIGIN } from "./components/registry.ts";
import { SYNTAX_COMPONENT } from "./components/Syntax.ts";
import {
  CAPABILITY_FORMS,
  capabilityDefinition,
  capabilityProps,
  captureCapabilities,
  FragmentCapabilityError,
  REVOKED_CAPABILITY,
} from "./fragment-capabilities.ts";
import type {
  CapturedCapabilities,
  FragmentCapability,
  FragmentFetchAccess,
  FragmentFileAccess,
} from "./fragment-capabilities.ts";
import { isFormDispatcher } from "./invocation-identity.ts";
import type { ComponentInvocation, ProtectedBodies } from "./invocation-identity.ts";
import type { FetchRequest } from "./fetch-request.ts";
import { normalizeFetchRequest, requestRecord } from "./fetch-request.ts";
import { CORE_REVISION, pinnedJson } from "./generated-xmd.ts";
import type { GeneratedRequest } from "./generated-xmd.ts";
import type { FunctionComponent, FunctionComponentDefinition, Json, PropsSchema } from "./types.ts";

/** The two forms an element is actually written in. */
export type FragmentForm = "self-closing" | "paired";

/**
 * What a run retains about which implementation an entry runs.
 *
 * Three structural parts rather than one opaque string, because a continuation
 * compares them and a reader has to be able to say which one moved. Never
 * derived from a function: an implementation is not an identity, and
 * serializing or inspecting one would make the retained policy depend on how a
 * host happened to write its code.
 */
export interface FragmentIdentity {
  /** The package or host that owns this implementation. */
  readonly origin: string;
  /** Which component of that origin, including the form when forms differ. */
  readonly key: string;
  /** Which version of it. A changed revision is a changed grant. */
  readonly revision: string;
}

/**
 * One component a generated fragment may name, as the host states it.
 *
 * A closed union of the two ways a host can say what is behind a name, and it
 * is closed on purpose: a third shape would be a third answer to "where does
 * this implementation come from", which is exactly the question an admission
 * has to settle once.
 *
 * Neither arm carries a function. A capability names an operation canonical
 * core supplies the body for; a component answer names something the ordinary
 * import chain resolves, which canonical capture does once — before any
 * document code — and then holds by value. What is journaled is the structural
 * identity, the forms and the limits.
 */
export type FragmentEntry = CapabilityEntry | ComponentAnswerEntry;

/** An entry core supplies the body for, bound to the host's own operations. */
export interface CapabilityEntry {
  readonly kind: "capability";
  /** The name a fragment writes. */
  readonly name: string;
  readonly identity: FragmentIdentity;
  /**
   * The exact spellings this entry is admitted for.
   *
   * A component whose two spellings do different things is two entries under
   * one name — `<File />` reads and `<File>…</File>` writes — so the form
   * travels with the identity and preflight chooses between them.
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
   * Which captured operation this entry runs.
   *
   * Not a definition, because a definition is where a provider lookup would go.
   * A host names the capability and hands its private operations to the
   * profile; canonical capture reads each one off exactly once and closes
   * core's own body over the bound result. A host therefore chooses *what a
   * fragment may do* and never *how it reaches it*
   * (`fragment-capabilities.ts`).
   */
  readonly capability: FragmentCapability;
  /**
   * The exact version-1 identity strings this entry is the successor of.
   *
   * Version-1 records retained one opaque string, chosen by whoever built the
   * pinned entry: core wrote `@executablemd/core#File:read`, the workflow host
   * wrote `@executablemd/workflow/composition/dir-v2#Dir`, and a host passing
   * its own observation wrote whatever it liked. There is no rule that recovers
   * four structural terms from one of those, and inferring one would be this
   * module deciding on a host's behalf that two grants are the same.
   *
   * So it is stated rather than derived, by the party that owns the entry.
   * Listing a string here is an assertion that this entry authorizes no more
   * than the entry that string named — a continuation admitted under it resumes
   * against this one. An entry that lists none is a new grant, and every
   * version-1 record naming it refuses.
   *
   * Only a capability arm has this. The component-answer arm did not exist when
   * version-1 records were written, so no such string ever described one.
   */
  readonly legacy?: readonly string[];
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
 * The host states *what it expects* — the name, the structural identity a
 * provider must claim, and the forms — and states no implementation at all.
 * There is no definition, function, resolver, provider operation or context
 * handle on this arm to hold one.
 *
 * Canonical capture resolves the name once, before the root import and before
 * any document code, through the complete ordinary `Component.importComponent`
 * chain; reads the identity the provider claimed on that exact final answer;
 * compares it with what this entry expects; retains the answer defensively; and
 * seals the result. Props and the callable definition are derived from that
 * answer rather than restated here, so a host cannot describe a contract the
 * implementation does not have.
 *
 * Resolution happens at capture and never again. A fragment invokes the sealed
 * snapshot, and a continuation resolves once more in its own capture and
 * reconciles before any effect. Calling a retained resolver later would see
 * document-time middleware, which is the whole thing this avoids.
 *
 * This arm states no version-1 alias, and has nowhere to put one: version-1
 * records predate it, so no string an older run committed ever described an
 * implementation the import chain answered for.
 */
export interface ComponentAnswerEntry {
  readonly kind: "component-answer";
  readonly name: string;
  /** What a provider must have claimed for this name, exactly. */
  readonly identity: FragmentIdentity;
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
   * For both standard profiles this is exactly paired `<File>`, paired `<Dir>`
   * and self-closing `<File.Delete>`. It does not include the read table:
   * `write` selects mutation and nothing else.
   */
  readonly write?: readonly FragmentEntry[];
  /** How this host answers for its Workspace, when it evaluates against one. */
  readonly workspace?: FragmentWorkspaceAccess;
  /**
   * The exact filesystem operations the admitted entries run.
   *
   * Required by every file and directory entry, and read off this object once
   * at capture. A profile that admits `<File />` without stating them is a
   * profile that admitted an operation it cannot perform, and is refused rather
   * than falling through to whatever provider a document installed.
   */
  readonly files?: FragmentFileAccess;
  /** The exact transport an admitted `<Fetch />` performs its request through. */
  readonly fetch?: FragmentFetchAccess;
  /**
   * The effective Fetch timeout this host resolved, in milliseconds.
   *
   * Resolved once, by the host, when it builds the profile. Reading it from
   * context during preflight would let the ceiling a fragment is held to depend
   * on where the reading happened.
   */
  readonly fetchTimeout?: number;
  /**
   * Whether this host accepts the released `source` spelling beside `text`.
   *
   * The workflow profile does, silently, because documents were written against
   * it before `text` existed. The ordinary profile does not: it never shipped
   * that spelling.
   */
  readonly deprecatedSourceAlias?: boolean;
}

/**
 * Core's `<File />`, admitted to observe and not to write.
 *
 * `<File>` reads when it has no content and writes when it has some, so one
 * unconstrained entry would admit a write. The form travels with the identity
 * and preflight decides between the two — before the first effect, rather than
 * inside a body that has already been entered.
 *
 * An admitted read reaches the `readTextFile` the host handed the profile and
 * nothing else. Under a workflow run that is the transaction-bound operation,
 * so the read still crosses the run's own transaction; what it no longer does
 * is resolve a provider through the contextual API at the moment it runs.
 */
export function fileReadEntry(): CapabilityEntry {
  return coreEntry("File", "File:read", "file:read");
}

/**
 * Core's `<Glob />`, admitted to select paths and nothing else.
 *
 * A value entry: the definition core builds for it declares what it binds, so a
 * generated `<Glob />` written without `as` is refused before the host's
 * provider is asked to traverse anything. What it selects is bounded the same
 * way a read is — the captured `globFiles` operation and the captured working
 * directory — so a search never reaches `API.Files` or `Env.cwd`, and the paths
 * it answers with are the ones that provider produced.
 */
export function globReadEntry(): CapabilityEntry {
  return coreEntry("Glob", "Glob", "files:glob");
}

/**
 * The protected names canonical execution states what is behind, for a profile.
 *
 * An allowlist rather than "every protected name", because stating an identity
 * is what makes a name admissible: a host that wrote `<Evaluate>`'s own
 * canonical identity into its read table would otherwise obtain evaluation
 * inside evaluation, which is a different grant from being shown a vocabulary.
 * Core answers for the one protected name it offers a host an entry for, and a
 * hand-written entry for any other resolves to an answer carrying no identity
 * and is refused.
 */
export const CANONICAL_PROFILE_ANSWERS: ReadonlySet<string> = new Set([SYNTAX_COMPONENT]);

/**
 * Canonical `<Syntax />`, admitted as the answer the import chain gives for it.
 *
 * Not a capability: `<Syntax />` is canonical core's protected component, and a
 * capability arm would be core supplying a second body for a name it already
 * owns. So the entry states what a resolution must have answered with — core's
 * own origin, key and revision — and canonical capture resolves the name once
 * through the ordinary import chain, reconciles that identity, and seals the
 * protected answer through the execution's own protected-body route.
 *
 * Admitting it grants no other authority. The symbols an occurrence renders
 * describe the vocabulary the fragment has; naming a component in them is not
 * permission to run it, and a component the fragment may only read about stays
 * unavailable.
 */
export function syntaxReadEntry(): ComponentAnswerEntry {
  return {
    kind: "component-answer",
    name: SYNTAX_COMPONENT,
    identity: { origin: CORE_ORIGIN, key: SYNTAX_COMPONENT, revision: CORE_REVISION },
    forms: ["self-closing"],
    description:
      "Render the components this evaluation may write, or selected documentation. " +
      "Written self-closing.",
  };
}

/** Core's `<File>…</File>`, admitted to write and not to read. */
export function fileWriteEntry(): CapabilityEntry {
  return coreEntry("File", "File:write", "file:write");
}

/**
 * Core's `<File.Delete />`, in the one form it has.
 *
 * One name, one identity: unlike `<File>`, whose two spellings do different
 * things, this answers the self-closing form alone. Stating the form is what
 * puts the decision in preflight, before the fragment's first effect — a paired
 * spelling costs an earlier admitted element nothing.
 */
export function fileDeleteEntry(): CapabilityEntry {
  return coreEntry("File.Delete", "File.Delete", "file:delete");
}

/**
 * A directory an admitted fragment may create, under the name the host gives it.
 *
 * The name is the host's because the component is: the workflow calls it
 * `<Dir>`, and an ordinary run admits no such thing. What core supplies is the
 * operation — `ensureDirectory`, from the profile — so the body a fragment
 * reaches is not the ordinary registration and cannot be composed around.
 */
export function directoryEntry(
  identity: FragmentIdentity,
  name: string,
  /**
   * The version-1 strings this host's own directory entry succeeds.
   *
   * The host's to state, because the identity is: core never wrote one of
   * these, so it has nothing to assert about which older grant this entry is
   * the same as.
   */
  legacy?: readonly string[],
): CapabilityEntry {
  return {
    kind: "capability",
    name,
    identity,
    forms: [...CAPABILITY_FORMS["directory:ensure"]],
    capability: "directory:ensure",
    props: capabilityProps("directory:ensure"),
    description: CORE_DESCRIPTIONS["directory:ensure"],
    ...(legacy === undefined ? {} : { legacy }),
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
  return { ...coreEntry("Fetch", "Fetch", "fetch"), requests };
}

/** What core's own entries tell an agent they do. */
const CORE_DESCRIPTIONS: Readonly<Record<FragmentCapability, string>> = Object.freeze({
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

/**
 * The exact strings each of core's own entries was retained as under version 1.
 *
 * Enumerated literally rather than assembled from the origin and the key.
 * There was never a rule that produced these — a released build wrote each one
 * where it built the pinned entry — so a template here would be this module
 * inventing the convention the whole design says does not exist, and a later
 * change to `CORE_ORIGIN` would silently rewrite what an old journal is
 * compared against. Core states them because core owns these entries and is the
 * party that can assert the current one authorizes no more than the old did.
 */
const CORE_LEGACY: Readonly<Record<FragmentCapability, readonly string[]>> = Object.freeze({
  "file:read": Object.freeze(["@executablemd/core#File:read"]),
  // Core never pinned a search entry under version 1; there is no older grant
  // for this one to assert it authorizes no more than.
  "files:glob": Object.freeze([]),
  "file:write": Object.freeze(["@executablemd/core#File:write"]),
  "file:delete": Object.freeze(["@executablemd/core#File.Delete"]),
  // Core never pinned a directory entry under version 1; the workflow host did,
  // and states its own alias.
  "directory:ensure": Object.freeze([]),
  fetch: Object.freeze(["@executablemd/core#Fetch"]),
});

function coreEntry(name: string, key: string, capability: FragmentCapability): CapabilityEntry {
  const legacy = CORE_LEGACY[capability];
  return {
    kind: "capability",
    name,
    identity: { origin: CORE_ORIGIN, key, revision: CORE_REVISION },
    forms: [...CAPABILITY_FORMS[capability]],
    capability,
    props: capabilityProps(capability),
    description: CORE_DESCRIPTIONS[capability],
    ...(legacy.length === 0 ? {} : { legacy }),
  };
}

/**
 * One provider-backed name, already resolved and reconciled.
 *
 * Produced by canonical execution's capture step before this module is asked to
 * seal anything: the chain has answered, the provider's claim has been read off
 * that exact final object, it has been compared with what the host entry
 * expects, and the answer has been retained defensively. What arrives here is
 * the settled result, so nothing in this module resolves, looks up, or holds a
 * resolver it could call later.
 */
export interface ResolvedAnswer {
  /** Core's own retained copy, which is what a fragment invokes. */
  readonly definition: FunctionComponentDefinition;
}

/** Every provider-backed name this capture resolved, by name. */
export type ResolvedAnswers = ReadonlyMap<string, ResolvedAnswer>;

/**
 * One captured entry: frozen structural data beside one sealed implementation.
 *
 * `kind` survives capture because the retained record keeps it: a continuation
 * comparing identities has to know whether the thing behind a name was core's
 * own operation or a provider's answer, and the two are different grants.
 */
export interface CapturedEntry {
  /** Documentation provenance of an exact routed answer; grants no callable authority. */
  readonly protectedOrigin?: string;
  readonly name: string;
  readonly identity: FragmentIdentity;
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
   * The form authority underneath this entry's implementation, when the sealed
   * definition wraps one.
   *
   * A component answer runs behind a lifetime guard canonical capture built, so
   * the function on the definition is core's rather than the provider's. A
   * provider whose own answer dispatches on the authored form would otherwise
   * lose that dispatch, because what a selection records as the form authority
   * is read off the definition it was handed. So the authority travels
   * explicitly, and a capability — whose definition is core's own dispatcher —
   * states none.
   */
  readonly dispatch?: unknown;
  /**
   * The version-1 identity strings this entry succeeds, copied by value.
   *
   * Read off the host's array once at capture and frozen, like everything else
   * here: a host that appends to its own list afterwards is appending to an
   * object nothing is looking at, so it cannot widen which retained records
   * reconcile to this entry from inside its own `install()`.
   */
  readonly legacy?: readonly string[];
  /** This entry's own ceiling, normalized once and canonically ordered. */
  readonly requests?: readonly FetchRequest[];
}

/** What canonical execution keeps, and what canonical `<Evaluate>` reads. */
export interface CapturedProfile {
  /**
   * The pure components every evaluation may write, whatever `allow` selects.
   *
   * Core's own, and not a table a host states: composition carries no effect
   * operation, so admitting it grants nothing and omitting it would take a
   * language construct away rather than an authority. `allow` selects between
   * the two effect tables below and never between these.
   */
  readonly composition: readonly CapturedEntry[];
  readonly read: readonly CapturedEntry[];
  readonly write: readonly CapturedEntry[];
  readonly workspace?: FragmentWorkspaceAccess;
  readonly deprecatedSourceAlias: boolean;
  /**
   * Begin one fragment, and answer with how to end it.
   *
   * Reads the host's working directory once per fragment rather than once per
   * element, and restores whatever was current afterwards — so a fragment
   * produced inside another fragment's producer leaves the outer one where it
   * was.
   */
  readonly enterFragment: () => Operation<() => void>;
  /** Whether this profile's bound operations are still usable. */
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
  "authority an evaluation has, and `allow` only narrows it.";

/** What an execution offered two evaluation profiles refuses with. */
export const TWO_PROFILES =
  "two installations stated the evaluation profile this execution offers. One execution offers " +
  "one maximum authority, so what a generated fragment may do is never a question of assembly " +
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
 * Everything a host stated is already settled here — the identity, the forms,
 * the schema for a capability, the ceiling. What is missing is exactly the part
 * a host does not state: a component answer's implementation and the contract
 * that comes with it.
 */
interface PreparedEntry {
  readonly name: string;
  readonly identity: FragmentIdentity;
  readonly forms: readonly FragmentForm[];
  readonly kind: "capability" | "component-answer" | "composition";
  readonly description?: string;
  readonly props?: PropsSchema;
  readonly capability?: FragmentCapability;
  readonly definition?: FunctionComponentDefinition;
  readonly legacy?: readonly string[];
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
   * The provider-backed names this profile admits, with what it expects of each.
   *
   * Empty for a capability-only profile, which performs no component-chain
   * lookup at all — a host that offers no provider answer pays for none.
   */
  readonly answered: readonly { readonly name: string; readonly identity: FragmentIdentity }[];
  /** Whether the operations this preparation bound are still usable. */
  readonly live: () => boolean;
  /** End them. Registered by canonical execution before any installation runs. */
  readonly revoke: () => void;
  /** Seal answers, projecting lifetime wrappers through the execution's private operation. */
  seal(answers: ResolvedAnswers, project?: ProtectedBodies["project"]): Operation<CapturedProfile>;
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
  // Every live operation is read off the host's objects here, once, before a
  // single installation has run. What comes back is bound and revocable, and
  // the host's own objects are never consulted again.
  const capabilities = captureCapabilities({
    ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  // One definition per *name*, built from every capability that name holds
  // across both tables. `<File />` observing and `<File>…</File>` writing are
  // two entries under one name, and the evaluator resolves an import by name —
  // so they arrive as one definition whose dispatch separates the two
  // spellings, exactly as the ordinary `<File>` does.
  const built = buildDefinitions(input, capabilities);
  const read = yield* prepareEntries(input.read ?? [], input.fetchTimeout, built);
  const write = yield* prepareEntries(input.write ?? [], input.fetchTimeout, built);
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
  const deprecatedSourceAlias = input.deprecatedSourceAlias === true;
  return Object.freeze({
    answered: Object.freeze(
      [...answered.entries()].map(([name, identity]) => Object.freeze({ name, identity })),
    ),
    live: () => capabilities.live(),
    revoke: () => {
      capabilities.revoke();
    },
    // deno-lint-ignore require-yield
    *seal(
      answers: ResolvedAnswers,
      project?: ProtectedBodies["project"],
    ): Operation<CapturedProfile> {
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
        deprecatedSourceAlias,
        enterFragment: () => capabilities.enterFragment(),
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
        identity: Object.freeze({
          origin: entry.identity.origin,
          key: entry.identity.key,
          revision: entry.identity.revision,
        }),
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
): Map<string, FunctionComponentDefinition> {
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
  const built = new Map<string, FunctionComponentDefinition>();
  for (const [name, forms] of admitted) {
    built.set(
      name,
      capabilityDefinition(name, forms, capabilities, normalizedCeiling(ceilings.get(name), input)),
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
  fetchTimeout: number | undefined,
  built: Map<string, FunctionComponentDefinition>,
): Operation<readonly PreparedEntry[]> {
  const prepared: PreparedEntry[] = [];
  for (const entry of entries) {
    prepared.push(yield* prepareEntry(entry, fetchTimeout, built));
  }
  return Object.freeze(prepared);
}

function* prepareEntry(
  entry: FragmentEntry,
  fetchTimeout: number | undefined,
  built: Map<string, FunctionComponentDefinition>,
): Operation<PreparedEntry> {
  const forms = canonicalForms(entry.forms);
  if (forms.length === 0) {
    throw new EvaluationProfileError(
      `an evaluation profile admitted "${entry.name}" for no authored form.`,
    );
  }
  const identity = captureIdentity(entry.identity, entry.name);
  const described =
    typeof entry.description === "string" && entry.description.length > 0
      ? { description: entry.description }
      : {};

  if (entry.kind === "component-answer") {
    // Nothing about the implementation is settled here. What this entry states
    // is which name, and which identity a provider must have claimed for it;
    // the chain answers later, and props come from that answer rather than from
    // the host, so a host cannot describe a contract the implementation lacks.
    return Object.freeze({
      name: entry.name,
      identity,
      forms,
      kind: "component-answer" as const,
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
  // The definition every entry under this name shares, built before any entry
  // was prepared.
  const definition = built.get(entry.name);
  if (definition === undefined) {
    throw new EvaluationProfileError(
      "an evaluation profile admitted a name with no operation behind it.",
    );
  }
  const legacy = captureLegacy(entry.legacy, entry.name);
  return Object.freeze({
    name: entry.name,
    identity,
    forms,
    props,
    kind: "capability" as const,
    capability: entry.capability,
    ...described,
    definition,
    ...(legacy === undefined ? {} : { legacy }),
    ...(requests === undefined ? {} : { requests }),
  });
}

/**
 * The version-1 aliases this entry states, copied and checked.
 *
 * Copied because the host's array is the host's, and checked because an alias
 * is a comparison term: an empty string would reconcile against nothing
 * usefully, and a duplicate would say one thing twice. A host stating an empty
 * list has stated no alias, which is the same as stating none.
 */
function captureLegacy(
  legacy: readonly string[] | undefined,
  name: string,
): readonly string[] | undefined {
  if (legacy === undefined) {
    return undefined;
  }
  const held = new Set<string>();
  for (const alias of legacy) {
    if (typeof alias !== "string" || alias.length === 0) {
      throw new EvaluationProfileError(
        `an evaluation profile stated an empty version-1 identity for "${name}". An alias is a ` +
          "string an older run actually retained, and there is no such record holding nothing.",
      );
    }
    held.add(alias);
  }
  return held.size === 0 ? undefined : Object.freeze([...held]);
}

/**
 * The provider-backed names this profile admits, with the one identity each of
 * them states.
 *
 * A name is one component, so it has one implementation and one identity. Two
 * entries under one name are the two spellings of that component — the
 * self-closing one admitted to observe and the paired one to mutate — and
 * stating a second identity for the second spelling would be stating that the
 * name means two things, with which of them a fragment reached decided by which
 * table admitted it. That is not a narrower grant than the host wrote down; it
 * is an ambiguous one, so it refuses at capture rather than resolving by
 * position.
 *
 * A name a host holds as both a capability and a component answer is the same
 * ambiguity with the sharper edge: canonical core would supply one body and the
 * import chain the other, which are different grants under one spelling.
 */
function answeredNames(prepared: readonly PreparedEntry[]): ReadonlyMap<string, FragmentIdentity> {
  const answered = new Map<string, FragmentIdentity>();
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
    if (entry.kind !== "component-answer") {
      continue;
    }
    const stated = answered.get(entry.name);
    if (stated === undefined) {
      answered.set(entry.name, entry.identity);
      continue;
    }
    if (
      stated.origin !== entry.identity.origin ||
      stated.key !== entry.identity.key ||
      stated.revision !== entry.identity.revision
    ) {
      throw new EvaluationProfileError(
        `an evaluation profile admitted "${entry.name}" as ${spelling(stated)} and as ` +
          `${spelling(entry.identity)}. One name states one identity, however many forms and ` +
          "tables hold it.",
      );
    }
  }
  return answered;
}

/** One identity as a reader sees it in a refusal. */
function spelling(identity: FragmentIdentity): string {
  return `${identity.origin}#${identity.key}@${identity.revision}`;
}

/** One provider-backed name's sealed implementation, shared by every entry. */
interface SealedAnswer {
  readonly protectedOrigin?: string;
  readonly props: PropsSchema;
  readonly definition: FunctionComponentDefinition;
  readonly dispatch?: unknown;
}

/**
 * One sealed implementation per provider-backed name, built once per capture.
 *
 * Built here rather than per entry because a name has one implementation: the
 * lifetime guard, the detached schema and the form authority are properties of
 * that implementation, and building them twice would give one component two
 * bodies whose only difference was which table asked for it.
 */
function sealAnswers(
  answered: ReadonlyMap<string, FragmentIdentity>,
  answers: ResolvedAnswers,
  capabilities: CapturedCapabilities,
  project: ProtectedBodies["project"] | undefined,
): ReadonlyMap<string, SealedAnswer> {
  const sealed = new Map<string, SealedAnswer>();
  for (const name of answered.keys()) {
    // Resolved once, before any document code, through the complete ordinary
    // import chain — and already reconciled against what this entry expects.
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
        props: detach(answer.props),
        definition: Object.freeze({ ...answer, fn: guard }),
        ...(protectedOrigin === undefined ? {} : { protectedOrigin }),
        // The provider's own dispatcher, when its answer has one. The
        // definition above runs behind core's lifetime guard, so what a
        // selection would read off it is core's function rather than the
        // provider's — and a form authority read off the wrong function selects
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
    return Object.freeze({
      name: entry.name,
      identity: entry.identity,
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
    identity: entry.identity,
    forms: entry.forms,
    props,
    kind: "capability" as const,
    ...(entry.capability === undefined ? {} : { capability: entry.capability }),
    ...described,
    definition,
    ...(entry.legacy === undefined ? {} : { legacy: entry.legacy }),
    ...(entry.requests === undefined ? {} : { requests: entry.requests }),
  });
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

function captureIdentity(identity: FragmentIdentity, name: string): FragmentIdentity {
  const { origin, key, revision } = identity;
  if (
    typeof origin !== "string" ||
    origin.length === 0 ||
    typeof key !== "string" ||
    key.length === 0 ||
    typeof revision !== "string" ||
    revision.length === 0
  ) {
    throw new EvaluationProfileError(
      `an evaluation profile admitted "${name}" without a complete identity. An entry states the ` +
        "origin, key and revision a continuation is compared against.",
    );
  }
  return Object.freeze({ origin, key, revision });
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
