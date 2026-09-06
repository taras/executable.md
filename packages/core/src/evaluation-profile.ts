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
  /** The implementation this identity runs. */
  readonly definition: FunctionComponentDefinition;
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

/** One captured entry: frozen structural data beside one bound implementation. */
export interface CapturedEntry {
  readonly name: string;
  readonly identity: FragmentIdentity;
  readonly forms: readonly FragmentForm[];
  readonly props: PropsSchema;
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
  /** Whether this profile's bound operations are still usable. */
  readonly live: () => boolean;
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
  const read = yield* captureEntries(input.read ?? [], input.fetchTimeout);
  const write = yield* captureEntries(input.write ?? [], input.fetchTimeout);
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
    live: () => true,
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

function* captureEntries(
  entries: readonly FragmentEntry[],
  fetchTimeout: number | undefined,
): Operation<readonly CapturedEntry[]> {
  const captured: CapturedEntry[] = [];
  for (const entry of entries) {
    captured.push(yield* captureEntry(entry, fetchTimeout));
  }
  return Object.freeze(captured);
}

function* captureEntry(
  entry: FragmentEntry,
  fetchTimeout: number | undefined,
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
  return Object.freeze({
    name: entry.name,
    identity,
    forms,
    // Detached, so a host that edits its schema afterwards does not change what
    // a fragment's props are validated against.
    props: detach(entry.props),
    definition: entry.definition,
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
