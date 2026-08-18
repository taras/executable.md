/**
 * Evaluating XMD an Agent generated, under a constrained allowlist
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * An Agent proposes work by returning a fragment of Executable Markdown. That
 * fragment is untrusted input: it carries data, never authorization. So a
 * trusted host — never a document, a component, or a middleware package — hands
 * this evaluator the candidate source together with the ceilings it may run
 * under, and the ceilings are values captured before the fragment exists.
 *
 * ## Nothing happens before the whole fragment has been read
 *
 * The complete source is parsed and walked inside the durable admission itself,
 * before the first effect. A fragment whose second element is an executable
 * block performs nothing at all, however safe its first element was — which is
 * the difference between an allowlist and a filter that runs while the document
 * does.
 *
 * What is refused is a construct *class*: executable code blocks, expression
 * props, interpolation that reads a binding, a result binding, a component the
 * host did not admit, and a request outside the admitted set. The record and
 * the diagnostic name the class and nothing else. Generated source is exactly
 * the text a refusal must not echo — and a refusal is *returned* by the
 * admission rather than thrown out of it, because a thrown one would be
 * serialized into the journal with a stack trace nobody asked for.
 *
 * ## A name is not an identity
 *
 * The host admits pinned identities: the exact definition each admitted name
 * runs. Resolution never consults `componentDirs`, a registration, or the
 * workflow component bundle, so a repository `Fetch.md` — or any same-name file
 * beside the checkout — answers nothing here. `Component.importComponent`
 * middleware still composes around every import and may observe or refuse one;
 * it cannot answer one, because canonical core issues a witness for the answer
 * it produced and verifies it at the call site.
 *
 * ## A resumed run is held to the ceilings it was admitted under
 *
 * Durable replay matches an effect by its type and name; what a description
 * carries is stored, never compared. So the retained admission carries the
 * normalized policy in its **result** as well as in the event input, and a
 * continuation compares that retained policy to the one this run states — whole
 * and exactly — before a single generated component is invoked or a single
 * request is performed. Changed roots, a changed pinned identity behind the
 * same name, and a widened request ceiling are each refused there.
 *
 * That is also why the walk lives inside the admission's live executor. A
 * continuation restores what was admitted without consulting the current source
 * at all, so what expands is the fragment this run admitted rather than
 * whatever a later caller happens to be holding.
 *
 * ## What the run keeps
 *
 * One ordinary durable event records the decision. An admission carries the
 * exact source, the pinned identities the fragment named, and the normalized
 * policy; a refusal carries the construct class and nothing else. Either way it
 * commits before the first admitted observation, and the observations
 * themselves are retained by their own durable effects — `fetch` for `<Fetch>`
 * — so a replay restores both without asking anyone anything a second time.
 */

import { createDurableOperation, ephemeral } from "@executablemd/durable-streams";
import type { Json as DurableJson, Workflow } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";

import { Component } from "./component-api.ts";
import { ErrorMode } from "./errors.ts";
import { CanonicalImports, retain } from "./components/import-authority.ts";
import type { ImportAuthority, ImportedDefinition } from "./components/import-authority.ts";
import { isComponentName } from "./components/registration.ts";
import { CORE_ORIGIN, CORE_REGISTRY } from "./components/registry.ts";
import { createBlockCounter, expandSegments } from "./expand.ts";
import { extendPath } from "./expansion.ts";
import { parseRequestRecord, prepareFetchRequest, requestRecord } from "./fetch-request.ts";
import type { FetchRequest } from "./fetch-request.ts";
import { isJsonObject, parseJson } from "./json.ts";
import { renderSegments } from "./render.ts";
import { scanSegments } from "./scanner.ts";
import { RESERVED_STRUCTURAL } from "./structural.ts";
import type { FunctionComponentDefinition, Json, JsonObject, Segment } from "./types.ts";

/** A generated fragment this evaluator will not run, or an import it refuses. */
export class GeneratedXmdError extends Error {
  override name = "GeneratedXmdError";
}

/** The construct classes a fragment can be refused for. */
type Construct =
  | "block"
  | "expression"
  | "interpolation"
  | "binding"
  | "component"
  | "construct"
  | "request";

/**
 * The fixed diagnostics.
 *
 * Each names one construct class. None of them interpolates the source, a
 * component name, a URL, a header, or anything else the fragment carried: the
 * candidate is untrusted text, and a refusal is not a reason to publish it.
 */
const CONSTRUCT: Record<Construct, string> = {
  block: "a generated fragment carries an executable code block, which it may not.",
  expression: "a generated fragment carries an expression prop, which it may not.",
  interpolation: "a generated fragment reads a binding through interpolation, which it may not.",
  binding: "a generated fragment binds a result with `as`, which it may not.",
  component: "a generated fragment names a component this host did not admit.",
  construct: "a generated fragment carries a construct this evaluator does not admit.",
  request: "a generated fragment asks for a request this host did not admit.",
};

/**
 * What a resumed run is refused with when its ceilings moved.
 *
 * Fixed, like every other diagnostic here, and deliberately naming nothing it
 * compared: which root, identity or request changed is exactly the material a
 * refusal must not publish.
 */
const CEILING =
  "a generated fragment was admitted under ceilings this run no longer states. A retained " +
  "admission resumes only under the exact Workspace roots, pinned identities and requests it " +
  "was admitted with.";

const UNREADABLE = "the retained generated-XMD admission record cannot be read as one.";

/** How an import that did not come from canonical execution is refused. */
const WITNESS = {
  unissued:
    "Component.importComponent middleware answered a generated import with a definition " +
    "canonical execution did not produce. A handler may observe, delegate or refuse a " +
    "generated import; only canonical execution answers one.",
  "another-name":
    "Component.importComponent middleware answered a generated import with the definition " +
    "canonical execution produced for another component.",
  changed:
    "Component.importComponent middleware changed the definition canonical execution produced " +
    "for a generated import before it was invoked.",
} as const;

/**
 * One construct class the walk refused.
 *
 * Module-private and never published: the durable executor turns it into a
 * record, and the caller turns that record back into a `GeneratedXmdError`.
 */
class Refusal extends Error {
  override name = "GeneratedRefusal";
  readonly construct: Construct;

  constructor(construct: Construct) {
    super(construct);
    this.construct = construct;
  }
}

/**
 * One request a generated fragment may perform, written the way an element
 * writes it.
 *
 * The host states the ceiling in the same vocabulary the candidate uses, and
 * both sides go through `prepareFetchRequest()`, so "the same request" is one
 * normalization rather than two readings that could disagree.
 */
export type GeneratedRequest = Record<string, Json>;

/**
 * One observation component a generated fragment may name, and the exact
 * definition that name runs.
 *
 * `identity` is the stable, non-secret descriptor the run retains: it says
 * which implementation was admitted, and holding it grants nothing. It is also
 * what a continuation is compared against, so changing the definition behind a
 * name means changing this.
 */
export interface GeneratedObservation {
  readonly name: string;
  readonly identity: string;
  readonly definition: FunctionComponentDefinition;
  /**
   * The exact requests this observation may perform, when it performs HTTP
   * reads at all. Present only on the pinned `<Fetch>` identity.
   */
  readonly requests?: readonly GeneratedRequest[];
}

/**
 * The pinned core `<Fetch>` identity, bounded to exactly these requests.
 *
 * Core's own default definition, taken from the registry every execution and
 * every inspection resolves through — not the name `Fetch`, which a repository
 * file may also take. The ceiling is not optional: an unbounded network read is
 * a different decision from an admitted one, and this constructor does not make
 * it.
 */
export function pinnedFetch(requests: readonly GeneratedRequest[]): GeneratedObservation {
  const definition = CORE_REGISTRY.get("Fetch")?.default?.definition;
  if (definition === undefined || definition.kind !== "function") {
    throw new GeneratedXmdError("core supplies no Fetch component to admit.");
  }
  if (requests.length === 0) {
    throw new GeneratedXmdError(
      "admitting <Fetch> to a generated fragment requires the exact requests it may perform.",
    );
  }
  return {
    name: "Fetch",
    identity: `${CORE_ORIGIN}#Fetch`,
    definition,
    requests: [...requests],
  };
}

/**
 * One host-registered function observation component, by the exact definition
 * the host holds.
 */
export function pinnedComponent(
  name: string,
  identity: string,
  definition: FunctionComponentDefinition,
): GeneratedObservation {
  return { name, identity, definition };
}

/** What a trusted host asks this evaluator to admit. */
export interface GeneratedXmdRequest {
  /** Which fragment this is. It names the durable admission record. */
  readonly id: string;
  /** The candidate source, exactly as it was generated. */
  readonly source: string;
  /** The retained Workspace roots the host is willing to expose. */
  readonly workspaceRoots: readonly string[];
  /** The one root admitted observations address. */
  readonly selectedRoot: string;
  /** The pinned observation identities this fragment may name. */
  readonly observations: readonly GeneratedObservation[];
}

/** The pinned identity of one admitted observation, as the run retains it. */
interface RetainedIdentity {
  readonly name: string;
  readonly identity: string;
}

/**
 * The ceilings one fragment ran under, normalized.
 *
 * Normalized because this is what a continuation is compared against: a request
 * the host spelled differently but meant identically must compare equal, and
 * one it meant differently must not.
 */
interface Policy {
  readonly roots: readonly string[];
  readonly selectedRoot: string;
  readonly allowed: readonly RetainedIdentity[];
  readonly requests: readonly FetchRequest[];
}

/** The decision this run recorded, restored from its own durable record. */
type RetainedAdmission =
  | {
      readonly decision: "admitted";
      readonly source: string;
      readonly named: readonly RetainedIdentity[];
      readonly policy: Policy;
    }
  | { readonly decision: "refused"; readonly construct: Construct };

/**
 * The authority a generated fragment imports through.
 *
 * Resolution is closed over the pinned identities and consults nothing else —
 * no component search path, no registration, no bundle. Each import mints a
 * fresh copy of the pinned definition, so what a handler does to one answer
 * cannot reach the table or a later import.
 */
class GeneratedImportAuthority implements ImportAuthority {
  readonly #observations: ReadonlyMap<string, GeneratedObservation>;
  readonly #imports = new CanonicalImports();

  constructor(observations: ReadonlyMap<string, GeneratedObservation>) {
    this.#observations = observations;
  }

  /** The answer canonical execution produces for this name. */
  issue(name: string): ImportedDefinition {
    const pinned = this.#observations.get(name);
    if (pinned === undefined) {
      throw new GeneratedXmdError(CONSTRUCT.component);
    }
    const copy = retain(pinned.definition);
    if (copy === undefined) {
      throw new GeneratedXmdError(CONSTRUCT.component);
    }
    return this.#imports.issue(name, copy);
  }

  authorize(name: string, answer: ImportedDefinition): ImportedDefinition {
    return this.#imports.authorize(
      name,
      answer,
      (refusal) => new GeneratedXmdError(WITNESS[refusal]),
    );
  }
}

/** The pinned identities this fragment may name, keyed by the name it writes. */
function admitted(
  observations: readonly GeneratedObservation[],
): Map<string, GeneratedObservation> {
  const table = new Map<string, GeneratedObservation>();
  for (const observation of observations) {
    const { name } = observation;
    if (!isComponentName(name) || RESERVED_STRUCTURAL.has(name)) {
      throw new GeneratedXmdError(
        "a generated-XMD allowlist admitted a name that is not a component name.",
      );
    }
    if (observation.definition.kind !== "function") {
      throw new GeneratedXmdError(
        "a generated-XMD allowlist admitted a definition that is not a function component. " +
          "Slice 1 admits host and core observation components only.",
      );
    }
    if (table.has(name)) {
      throw new GeneratedXmdError("a generated-XMD allowlist admitted one name twice.");
    }
    table.set(name, observation);
  }
  return table;
}

/**
 * Whether this text would read anything.
 *
 * The two interpolation passes a text segment goes through are the authority
 * on what a reference is, so this asks them rather than guessing: `\{` is
 * protected exactly as expansion protects it, and what remains is matched by
 * the same shapes `interpolate()` and `interpolateEvalBindings()` consume.
 * Braces that neither pass would read — prose, a JSON sample, a CSS rule — are
 * left alone.
 */
const ESCAPED_BRACE_PLACEHOLDER = "\uE000";
const FRONTMATTER_REFERENCE = /\{(meta|props)\.[^}]+\}/;
const BINDING_REFERENCE = /\{[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*\}/;

function reads(content: string): boolean {
  const protectedEscapes = content.replaceAll("\\{", ESCAPED_BRACE_PLACEHOLDER);
  return FRONTMATTER_REFERENCE.test(protectedEscapes) || BINDING_REFERENCE.test(protectedEscapes);
}

/** Two normalized requests describing the same read. */
function sameRequest(one: FetchRequest, other: FetchRequest): boolean {
  return JSON.stringify(requestRecord(one)) === JSON.stringify(requestRecord(other));
}

/** The ceilings this run states, with every request normalized. */
function* currentPolicy(
  request: GeneratedXmdRequest,
  table: ReadonlyMap<string, GeneratedObservation>,
): Operation<Policy> {
  const requests: FetchRequest[] = [];
  const allowed: RetainedIdentity[] = [];
  for (const observation of table.values()) {
    allowed.push({ name: observation.name, identity: observation.identity });
    for (const props of observation.requests ?? []) {
      requests.push(yield* prepareFetchRequest(props));
    }
  }
  return {
    roots: [...request.workspaceRoots],
    selectedRoot: request.selectedRoot,
    allowed,
    requests,
  };
}

/** The policy as journal data. */
function policyRecord(policy: Policy): JsonObject {
  return {
    roots: [...policy.roots],
    selectedRoot: policy.selectedRoot,
    allowed: policy.allowed.map((entry) => ({ name: entry.name, identity: entry.identity })),
    requests: policy.requests.map(requestRecord),
  };
}

/**
 * The policy a record holds, parsed rather than trusted.
 *
 * A history is durable input: a record somebody else wrote is not a policy
 * because it happens to have the right keys, and a policy this version cannot
 * read is refused rather than treated as matching.
 */
function readPolicy(value: Json): Policy | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const { roots, selectedRoot, allowed, requests } = value;
  if (!Array.isArray(roots) || typeof selectedRoot !== "string") {
    return undefined;
  }
  if (!Array.isArray(allowed) || !Array.isArray(requests)) {
    return undefined;
  }
  const retainedRoots: string[] = [];
  for (const root of roots) {
    if (typeof root !== "string") {
      return undefined;
    }
    retainedRoots.push(root);
  }
  const identities = readIdentities(allowed);
  if (identities === undefined) {
    return undefined;
  }
  const retainedRequests: FetchRequest[] = [];
  for (const request of requests) {
    const parsed = readRequest(request);
    if (parsed === undefined) {
      return undefined;
    }
    retainedRequests.push(parsed);
  }
  return {
    roots: retainedRoots,
    selectedRoot,
    allowed: identities,
    requests: retainedRequests,
  };
}

/** One retained request, or nothing when this version cannot read it. */
function readRequest(value: Json): FetchRequest | undefined {
  try {
    return parseRequestRecord(value);
  } catch {
    return undefined;
  }
}

function readIdentities(value: readonly Json[]): RetainedIdentity[] | undefined {
  const identities: RetainedIdentity[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return undefined;
    }
    const { name, identity } = entry;
    if (typeof name !== "string" || typeof identity !== "string") {
      return undefined;
    }
    identities.push({ name, identity });
  }
  return identities;
}

/**
 * Whether a resumed run states exactly the ceilings the retained admission was
 * granted under.
 *
 * Whole and exact, in order: a root added, a root reordered, one identity
 * behind a name replaced, or one request added to the allowed set each make
 * this false. Widening is the case that matters most — a ceiling that still
 * contains the original request is precisely the one that comparing the
 * *fragment* against the *current* policy would wave through.
 */
function samePolicy(retained: Policy, current: Policy): boolean {
  if (retained.selectedRoot !== current.selectedRoot) {
    return false;
  }
  if (retained.roots.length !== current.roots.length) {
    return false;
  }
  if (retained.roots.some((root, index) => root !== current.roots[index])) {
    return false;
  }
  if (retained.allowed.length !== current.allowed.length) {
    return false;
  }
  const replaced = retained.allowed.some((entry, index) => {
    const here = current.allowed[index];
    return here === undefined || here.name !== entry.name || here.identity !== entry.identity;
  });
  if (replaced) {
    return false;
  }
  if (retained.requests.length !== current.requests.length) {
    return false;
  }
  return retained.requests.every((request, index) => {
    const here = current.requests[index];
    return here !== undefined && sameRequest(request, here);
  });
}

/** What one fragment turned out to name, in the order it named it. */
interface Preflight {
  readonly segments: Segment[];
  readonly named: RetainedIdentity[];
}

/**
 * Walk the complete fragment, admitting it or refusing it whole.
 *
 * Nothing here performs an effect. The requests are normalized — the candidate's
 * and the host's alike — because deciding whether two requests are the same one
 * is what `prepareFetchRequest()` is for, and a second reading of the same props
 * could disagree with the one `<Fetch>` will make.
 */
function* preflight(
  source: string,
  table: ReadonlyMap<string, GeneratedObservation>,
): Operation<Preflight> {
  const ceilings = new Map<string, FetchRequest[]>();
  for (const [name, observation] of table) {
    if (observation.requests === undefined) {
      continue;
    }
    const normalized: FetchRequest[] = [];
    for (const request of observation.requests) {
      normalized.push(yield* prepareFetchRequest(request));
    }
    ceilings.set(name, normalized);
  }

  const named: RetainedIdentity[] = [];
  const segments = scanSegments(source);
  yield* walk(segments, table, ceilings, named);
  return { segments, named };
}

function* walk(
  segments: readonly Segment[],
  table: ReadonlyMap<string, GeneratedObservation>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
  named: RetainedIdentity[],
): Operation<void> {
  for (const segment of segments) {
    switch (segment.type) {
      case "text": {
        if (reads(segment.content)) {
          throw new Refusal("interpolation");
        }
        break;
      }
      case "codeBlock": {
        throw new Refusal("block");
      }
      case "component": {
        const observation = table.get(segment.name);
        if (observation === undefined) {
          throw new Refusal("component");
        }
        if (Object.keys(segment.expressions).length > 0) {
          throw new Refusal("expression");
        }
        if ("as" in segment.props) {
          throw new Refusal("binding");
        }
        const ceiling = ceilings.get(segment.name);
        if (ceiling !== undefined) {
          const candidate = yield* prepareFetchRequest(segment.props);
          if (!ceiling.some((allowed) => sameRequest(allowed, candidate))) {
            throw new Refusal("request");
          }
        }
        named.push({ name: observation.name, identity: observation.identity });
        yield* walk(segment.children, table, ceilings, named);
        break;
      }
      default: {
        throw new Refusal("construct");
      }
    }
  }
}

const GENERATED_XMD = "generated_xmd";

/**
 * What the durable admission records for this source.
 *
 * A refusal is a value rather than a failure. Throwing out of a durable
 * executor journals the error *and its stack*, which for a refusal caused by
 * untrusted input would put host paths in the run's history to say something
 * one word already says.
 */
function* admitSource(
  source: string,
  table: ReadonlyMap<string, GeneratedObservation>,
  policy: Policy,
): Operation<DurableJson> {
  try {
    const { named } = yield* preflight(source, table);
    return parseJson({
      decision: "admitted",
      source,
      named: named.map((entry) => ({ name: entry.name, identity: entry.identity })),
      policy: policyRecord(policy),
    });
  } catch (error) {
    if (error instanceof Refusal) {
      return parseJson({ decision: "refused", construct: error.construct });
    }
    throw error;
  }
}

/**
 * Decide this fragment, once, and keep the decision.
 *
 * The walk runs inside the executor, so a continuation restores what was
 * decided without reading the current source at all.
 */
function* persistAdmission(
  id: string,
  source: string,
  table: ReadonlyMap<string, GeneratedObservation>,
  policy: Policy,
): Workflow<Json> {
  const stored = yield createDurableOperation<DurableJson>(
    { type: GENERATED_XMD, name: `generated:${id}`, input: policyRecord(policy) },
    () => admitSource(source, table, policy),
  );
  return parseJson(stored);
}

/**
 * The decision this run recorded, read back from the journal.
 *
 * Parsed rather than trusted: a replay hands back whatever the history holds,
 * and a record somebody else wrote is not an admission because it happens to
 * have the right keys.
 */
function readAdmission(value: Json): RetainedAdmission | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const { decision } = value;
  if (decision === "refused") {
    const { construct } = value;
    return typeof construct === "string" && isConstruct(construct)
      ? { decision, construct }
      : undefined;
  }
  if (decision !== "admitted") {
    return undefined;
  }
  const { source, named, policy } = value;
  if (typeof source !== "string" || !Array.isArray(named) || policy === undefined) {
    return undefined;
  }
  const identities = readIdentities(named);
  const retained = readPolicy(policy);
  if (identities === undefined || retained === undefined) {
    return undefined;
  }
  return { decision, source, named: identities, policy: retained };
}

/** Whether a retained string names one of the construct classes this version has. */
function isConstruct(value: string): value is Construct {
  return Object.hasOwn(CONSTRUCT, value);
}

/**
 * Expand the admitted fragment through ordinary durable XMD effects.
 *
 * The import provider installs at `min` on this scope alone, so it answers
 * ahead of the execution's own terminal and is gone when the fragment is. It
 * reaches no component search path: what a name resolves to is the pinned
 * identity or nothing.
 *
 * Errors here fail rather than print. A printed error is something an author
 * reads and acts on; a generated fragment has no author, and a refusal that
 * rendered as text would leave every element after it still running — which is
 * the partial effect the whole-fragment preflight exists to prevent.
 */
function expand(
  id: string,
  segments: Segment[],
  table: ReadonlyMap<string, GeneratedObservation>,
): Operation<string> {
  return scoped(function* () {
    yield* ErrorMode.set("throw");
    const authority = new GeneratedImportAuthority(table);
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          return authority.issue(name);
        },
      },
      { at: "min" },
    );
    const expanded = yield* expandSegments(
      segments,
      {},
      {},
      new Set<string>(),
      createBlockCounter(),
      undefined,
      extendPath("", { f: "gen", id }),
      0,
      undefined,
      authority,
    );
    return renderSegments(expanded);
  });
}

/**
 * Admit one generated fragment and perform what it asks for.
 *
 * A `Workflow`, because what it records belongs in the run's journal: a trusted
 * host reaches it from a `DurablePreparation`, and a partial continuation
 * restores the admission and every observation that already committed rather
 * than performing them again.
 */
export function* evaluateGeneratedXmd(request: GeneratedXmdRequest): Workflow<string> {
  const table = admitted(request.observations);
  const policy = yield* ephemeral(currentPolicy(request, table));

  const stored = yield* persistAdmission(request.id, request.source, table, policy);
  const decided = readAdmission(stored);
  if (decided === undefined) {
    throw new GeneratedXmdError(UNREADABLE);
  }
  if (decided.decision === "refused") {
    throw new GeneratedXmdError(CONSTRUCT[decided.construct]);
  }
  // Before a single component is invoked or a single request is performed: a
  // retained admission is a grant under the ceilings it was granted with, and a
  // run that states different ones is asking for a different grant.
  if (!samePolicy(decided.policy, policy)) {
    throw new GeneratedXmdError(CEILING);
  }

  // The retained source is what expands, so a continuation runs the fragment
  // this run admitted rather than whatever a later caller happens to hold.
  const restored = yield* ephemeral(preflight(decided.source, table));
  return yield* ephemeral(expand(request.id, restored.segments, table));
}
