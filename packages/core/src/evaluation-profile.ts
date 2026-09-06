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
import {
  CAPABILITY_FORMS,
  capabilityDefinition,
  capabilityProps,
  captureCapabilities,
} from "./fragment-capabilities.ts";
import type {
  CapturedCapabilities,
  FragmentCapability,
  FragmentFetchAccess,
  FragmentFileAccess,
} from "./fragment-capabilities.ts";
import type { FetchRequest } from "./fetch-request.ts";
import { normalizeFetchRequest, requestRecord } from "./fetch-request.ts";
import type { GeneratedRequest } from "./generated-xmd.ts";
import type { FunctionComponentDefinition, Json, PropsSchema } from "./types.ts";

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
 * The live implementation travels beside the structural identity rather than
 * being derived from it: what is journaled is the identity, the forms and the
 * limits, and what runs is the implementation the host handed over.
 */
export interface FragmentEntry {
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
   * The exact requests this entry may perform, for an entry that performs any.
   *
   * Stated per entry rather than per profile, because a ceiling belongs to the
   * identity it bounds: two entries performing requests are two ceilings, and
   * flattening them would let one entry's limit admit another's request.
   */
  readonly requests?: readonly GeneratedRequest[];
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
   * For both standard profiles this is exactly the self-closing `<File>`.
   * `<Fetch>` joins it only where the host also states the exact requests it
   * may perform.
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
 * The revision core's own entries state.
 *
 * One number for all of them, bumped whenever what any of these entries
 * authorizes changes. A continuation admitted under an earlier revision is
 * refused rather than silently granted the newer authority.
 *
 * Revision 2 is where the authority behind these entries changed: an admitted
 * element used to invoke the ordinary component and resolve `API.Files` or
 * `API.Fetch` wherever it happened to run, and now it invokes a body closed
 * over the operations the host handed the profile. A continuation granted under
 * revision 1 was granted something the run could still compose around, so it is
 * refused rather than silently re-granted under the narrower one.
 */
const CORE_REVISION = "2";

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
export function fileReadEntry(): FragmentEntry {
  return coreEntry("File", "File:read", "file:read");
}

/** Core's `<File>…</File>`, admitted to write and not to read. */
export function fileWriteEntry(): FragmentEntry {
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
export function fileDeleteEntry(): FragmentEntry {
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
export function directoryEntry(identity: FragmentIdentity, name: string): FragmentEntry {
  return {
    name,
    identity,
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
export function fetchEntry(requests: readonly GeneratedRequest[]): FragmentEntry {
  return { ...coreEntry("Fetch", "Fetch", "fetch"), requests };
}

/** What core's own entries tell an agent they do. */
const CORE_DESCRIPTIONS: Readonly<Record<FragmentCapability, string>> = Object.freeze({
  "file:read": "Read one file and render its text. Written self-closing.",
  "file:write": "Write what it renders to one file. Written with content.",
  "file:delete": "Remove one file. Written self-closing.",
  "directory:ensure":
    "Make one directory exist, and resolve the paths inside it against it. Written with content.",
  fetch: "Perform one admitted HTTP read. Written self-closing.",
});

function coreEntry(name: string, key: string, capability: FragmentCapability): FragmentEntry {
  return {
    name,
    identity: { origin: CORE_ORIGIN, key, revision: CORE_REVISION },
    forms: [...CAPABILITY_FORMS[capability]],
    capability,
    props: capabilityProps(capability),
    description: CORE_DESCRIPTIONS[capability],
  };
}

/** One captured entry: frozen structural data beside one bound implementation. */
export interface CapturedEntry {
  readonly name: string;
  readonly identity: FragmentIdentity;
  readonly forms: readonly FragmentForm[];
  readonly props: PropsSchema;
  readonly capability: FragmentCapability;
  /** What the admitted vocabulary says this entry does, when the host said. */
  readonly description?: string;
  /** Core's own body, closed over the operations this capture bound. */
  readonly definition: FunctionComponentDefinition;
  /** This entry's own ceiling, normalized once and canonically ordered. */
  readonly requests?: readonly FetchRequest[];
}

/** What canonical execution keeps, and what canonical `<Evaluate>` reads. */
export interface CapturedProfile {
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
 * Capture one host's profile by value, before any installation runs.
 *
 * Everything structural is copied and frozen here, so a host mutating its own
 * arrays, schemas, headers or tables afterwards changes nothing this execution
 * does. What is not copied is the implementation itself: a function is the one
 * thing a profile must keep by reference, and it is kept behind a revocation
 * this execution owns rather than handed onward.
 */
export function* captureEvaluationProfile(
  input: FragmentEvaluationInput,
): Operation<CapturedProfile> {
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
  const read = yield* captureEntries(input.read ?? [], input.fetchTimeout, built);
  const write = yield* captureEntries(input.write ?? [], input.fetchTimeout, built);
  if (read.length === 0 && write.length === 0) {
    throw new EvaluationProfileError(
      "an evaluation profile states no component at all. A host offering evaluation states what " +
        "a fragment may do; one that offers none states no profile.",
    );
  }
  return Object.freeze({
    read,
    write,
    ...(input.workspace === undefined ? {} : { workspace: bindWorkspace(input.workspace) }),
    deprecatedSourceAlias: input.deprecatedSourceAlias === true,
    enterFragment: () => capabilities.enterFragment(),
    live: () => capabilities.live(),
    revoke: () => {
      capabilities.revoke();
    },
  });
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

function* captureEntries(
  entries: readonly FragmentEntry[],
  fetchTimeout: number | undefined,
  built: Map<string, FunctionComponentDefinition>,
): Operation<readonly CapturedEntry[]> {
  const captured: CapturedEntry[] = [];
  for (const entry of entries) {
    captured.push(yield* captureEntry(entry, fetchTimeout, built));
  }
  return Object.freeze(captured);
}

function* captureEntry(
  entry: FragmentEntry,
  fetchTimeout: number | undefined,
  built: Map<string, FunctionComponentDefinition>,
): Operation<CapturedEntry> {
  const forms = canonicalForms(entry.forms);
  if (forms.length === 0) {
    throw new EvaluationProfileError(
      `an evaluation profile admitted "${entry.name}" for no authored form.`,
    );
  }
  const identity = captureIdentity(entry.identity, entry.name);
  const requests =
    entry.requests === undefined
      ? undefined
      : yield* captureRequests(entry.requests, fetchTimeout, entry.name);
  // Detached, so a host that edits its schema afterwards does not change what a
  // fragment's props are validated against.
  const props = detach(entry.props);
  // The definition every entry under this name shares, built before any entry
  // was captured.
  const definition = built.get(entry.name);
  if (definition === undefined) {
    throw new EvaluationProfileError(
      "an evaluation profile admitted a name with no operation behind it.",
    );
  }
  return Object.freeze({
    name: entry.name,
    identity,
    forms,
    props,
    capability: entry.capability,
    ...(typeof entry.description === "string" && entry.description.length > 0
      ? { description: entry.description }
      : {}),
    definition,
    ...(requests === undefined ? {} : { requests }),
  });
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
