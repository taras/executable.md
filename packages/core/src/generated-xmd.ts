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
 * The complete source is parsed and walked before the first effect. A fragment
 * whose second element is an executable block performs nothing at all, however
 * safe its first element was — which is the difference between an allowlist and
 * a filter that runs while the document does.
 *
 * What is refused is a construct *class*: executable code blocks, expression
 * props, interpolation that reads a binding, a result binding, a component the
 * host did not admit, and a request outside the admitted set. The diagnostic
 * names the class and nothing else. Generated source is exactly the text a
 * refusal must not echo.
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
 * ## What the run keeps
 *
 * One ordinary durable event records the admitted source, the roots the host
 * selected, the pinned identities, and the exact request policy the fragment
 * ran under. It commits *before* the first admitted observation, so a fragment
 * refused in preflight appends nothing. The observations themselves are
 * retained by their own durable effects — `fetch` for `<Fetch>` — and a replay
 * restores both without asking anyone anything a second time.
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
import { prepareFetchRequest, requestRecord } from "./fetch-request.ts";
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

/**
 * The fixed diagnostics.
 *
 * Each names one construct class. None of them interpolates the source, a
 * component name, a URL, a header, or anything else the fragment carried: the
 * candidate is untrusted text, and a refusal is not a reason to publish it.
 */
const REFUSED = {
  block: "a generated fragment carries an executable code block, which it may not.",
  expression: "a generated fragment carries an expression prop, which it may not.",
  interpolation: "a generated fragment reads a binding through interpolation, which it may not.",
  binding: "a generated fragment binds a result with `as`, which it may not.",
  component: "a generated fragment names a component this host did not admit.",
  construct: "a generated fragment carries a construct this evaluator does not admit.",
  request: "a generated fragment asks for a request this host did not admit.",
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
 * which implementation was admitted, and holding it grants nothing.
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

/** The admission this run recorded, restored from its own durable record. */
interface RetainedAdmission {
  readonly decision: "admitted";
  readonly source: string;
  readonly named: readonly RetainedIdentity[];
}

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
      throw new GeneratedXmdError(REFUSED.component);
    }
    const copy = retain(pinned.definition);
    if (copy === undefined) {
      throw new GeneratedXmdError(REFUSED.component);
    }
    return this.#imports.issue(name, copy);
  }

  authorize(name: string, answer: ImportedDefinition): ImportedDefinition {
    return this.#imports.authorize(
      name,
      answer,
      (refusal) => new GeneratedXmdError(REFUSED[refusal]),
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
function same(one: FetchRequest, other: FetchRequest): boolean {
  return JSON.stringify(requestRecord(one)) === JSON.stringify(requestRecord(other));
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
          throw new GeneratedXmdError(REFUSED.interpolation);
        }
        break;
      }
      case "codeBlock": {
        throw new GeneratedXmdError(REFUSED.block);
      }
      case "component": {
        const observation = table.get(segment.name);
        if (observation === undefined) {
          throw new GeneratedXmdError(REFUSED.component);
        }
        if (Object.keys(segment.expressions).length > 0) {
          throw new GeneratedXmdError(REFUSED.expression);
        }
        if ("as" in segment.props) {
          throw new GeneratedXmdError(REFUSED.binding);
        }
        const ceiling = ceilings.get(segment.name);
        if (ceiling !== undefined) {
          const candidate = yield* prepareFetchRequest(segment.props);
          if (!ceiling.some((allowed) => same(allowed, candidate))) {
            throw new GeneratedXmdError(REFUSED.request);
          }
        }
        named.push({ name: observation.name, identity: observation.identity });
        yield* walk(segment.children, table, ceilings, named);
        break;
      }
      default: {
        throw new GeneratedXmdError(REFUSED.construct);
      }
    }
  }
}

const GENERATED_XMD = "generated_xmd";

/** Record what this fragment was admitted as, before its first observation. */
function* persistAdmission(
  id: string,
  policy: JsonObject,
  admission: RetainedAdmission,
): Workflow<Json> {
  const stored = yield createDurableOperation<DurableJson>(
    { type: GENERATED_XMD, name: `generated:${id}`, input: policy },
    // deno-lint-ignore require-yield
    function* (): Operation<DurableJson> {
      return parseJson({
        decision: admission.decision,
        source: admission.source,
        named: admission.named.map((entry) => ({ ...entry })),
      });
    },
  );
  return parseJson(stored);
}

/**
 * The admission this run recorded, read back from the journal.
 *
 * Parsed rather than trusted: a replay hands back whatever the history holds,
 * and a record somebody else wrote is not an admission because it happens to
 * have the right keys.
 */
function readAdmission(value: Json): RetainedAdmission | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const { decision, source, named } = value;
  if (decision !== "admitted" || typeof source !== "string" || !Array.isArray(named)) {
    return undefined;
  }
  const identities: RetainedIdentity[] = [];
  for (const entry of named) {
    if (!isJsonObject(entry)) {
      return undefined;
    }
    const { name, identity } = entry;
    if (typeof name !== "string" || typeof identity !== "string") {
      return undefined;
    }
    identities.push({ name, identity });
  }
  return { decision, source, named: identities };
}

/** What the run retains about the ceilings this fragment ran under. */
function* describePolicy(
  request: GeneratedXmdRequest,
  table: ReadonlyMap<string, GeneratedObservation>,
): Operation<JsonObject> {
  const requests: JsonObject[] = [];
  for (const observation of table.values()) {
    for (const props of observation.requests ?? []) {
      requests.push(requestRecord(yield* prepareFetchRequest(props)));
    }
  }
  return {
    roots: [...request.workspaceRoots],
    selectedRoot: request.selectedRoot,
    allowed: [...table.values()].map((observation) => ({
      name: observation.name,
      identity: observation.identity,
    })),
    requests,
  };
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

  // Preflight decides the candidate before anything is appended, which is what
  // makes a refused fragment leave no generated-XMD event behind.
  const candidate = yield* ephemeral(preflight(request.source, table));
  const policy = yield* ephemeral(describePolicy(request, table));

  const stored = yield* persistAdmission(request.id, policy, {
    decision: "admitted",
    source: request.source,
    named: candidate.named,
  });
  const admission = readAdmission(stored);
  if (admission === undefined) {
    throw new GeneratedXmdError(
      "the retained generated-XMD admission record cannot be read as one.",
    );
  }

  // The retained source is what expands, so a continuation runs the fragment
  // this run admitted rather than whatever a later caller happens to hold. On a
  // live run the two are the same text, and this walk finds the same fragment.
  const restored = yield* ephemeral(preflight(admission.source, table));
  return yield* ephemeral(expand(request.id, restored.segments, table));
}
