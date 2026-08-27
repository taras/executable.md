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
 * host did not admit, and a request that is malformed or outside the admitted
 * set. The record and the diagnostic name the class and nothing else. Generated
 * source is exactly the text a refusal must not echo — which is why a candidate
 * request is normalized behind a converting boundary rather than allowed to
 * report itself, and why a refusal is *returned* by the admission rather than
 * thrown out of it: a thrown one is serialized into the journal with its
 * message and its stack.
 *
 * The line is admission. Before it, nothing of the candidate is retained, so a
 * refusal carries none of it. After it the exact source is retained on purpose,
 * so an ordinary expansion diagnostic quoting the fragment discloses nothing
 * the journal does not already hold.
 *
 * ## A name is not an identity
 *
 * The host admits pinned identities: the exact definition each admitted name
 * runs. Resolution never consults `includes`, a registration, or the
 * workflow component bundle, so a repository `Fetch.md` — or any same-name file
 * beside the checkout — answers nothing here. `Component.importComponent`
 * middleware still composes around every import and may observe or refuse one;
 * it cannot answer one, because canonical core issues a witness for the answer
 * it produced and verifies it at the call site.
 *
 * ## Nor is a name a form
 *
 * The host states its identities in two tables — `read` and `write` — and the
 * caller selects which of them this fragment draws on. Each entry carries the
 * spellings it is admitted for, because a component whose two spellings do
 * different things is two identities: `<File />` reads and `<File>…</File>`
 * writes, so one name holds two entries and how the element was written chooses
 * between them. That choice is made in preflight, from the scan, before the
 * first effect — not inside the component after earlier elements have already
 * run, and never by whichever entry the host happened to list first.
 *
 * What a read produced is collected into the result. A write contributes
 * nothing to it: what it did is retained by its own ordinary durable effect,
 * and a second account of it on the result would be a second thing to keep
 * true.
 *
 * The form holds where the component runs, too. `<File>` learns which spelling
 * it is from the invocation the engine issued (executable-mdx-spec §5.6), and
 * so does this: every admitted invocation is checked against that same fact
 * before the component runs, and refused when it is not the form its identity
 * was chosen for. Nothing a handler answers reaches either read, so an admitted
 * `File:read` cannot be turned into a write, or an admitted `File:write` into a
 * read, however many times something is asked.
 *
 * ## A resumed run is held to the ceilings it was admitted under
 *
 * Durable replay matches an effect by its type and name; what a description
 * carries is stored, never compared. So the retained admission carries the
 * normalized policy in its **result** as well as in the event input, and a
 * continuation checks that retained policy against the one this run states
 * before a single generated component is invoked or a single effect is
 * performed. The Workspace roots are as-of-admission provenance and are asked
 * for by membership: the run's own progress legitimately retains further
 * roots and advances the authoritative current root, while a run that no
 * longer retains an admission root — or its selected root — is refused. Every
 * other term compares whole and exactly: a changed class selection, a changed
 * pinned identity behind the same name, a changed admitted form, and a
 * widened request ceiling are each refused there. Only the tables the
 * selection reached take part, so a write table a read-only admission never
 * drew on may move without invalidating it.
 *
 * That is also why the walk lives inside the admission's live executor. A
 * continuation restores what was admitted without consulting the current source
 * at all, so what expands is the fragment this run admitted rather than
 * whatever a later caller happens to be holding.
 *
 * ## What the run keeps
 *
 * One ordinary durable event records the decision. An admission carries the
 * exact source, the identity and form of each element the fragment named, and
 * the normalized policy; a refusal carries the construct class and nothing
 * else. Either way it commits before the first generated effect, and the
 * effects themselves are retained by their own durable records — `fetch` for
 * `<Fetch>`, the Workspace file effect for `<File>` — so a replay restores both
 * without asking anyone anything a second time.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { Json as DurableJson } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";

import { Component } from "./component-api.ts";
import { ErrorMode } from "./errors.ts";
import { CanonicalImports, retain } from "./components/import-authority.ts";
import type { ImportAuthority, ImportedDefinition } from "./components/import-authority.ts";
import { isComponentName } from "./components/registration.ts";
import { CORE_ORIGIN, CORE_REGISTRY } from "./components/registry.ts";
import { createBlockCounter, expandSegmentsWithin } from "./expand.ts";
import { extendPath } from "./expansion.ts";
import { parseRequestRecord, prepareFetchRequest, requestRecord } from "./fetch-request.ts";
import { timeoutFetch } from "@executablemd/runtime";
import type { FetchRequest } from "./fetch-request.ts";
import { isJsonObject, parseJson } from "./json.ts";
import { renderSegments } from "./render.ts";
import { scanSegments } from "./scanner.ts";
import { sourceDescription } from "./source-position.ts";
import { RESERVED_STRUCTURAL } from "./structural.ts";
import { installFormSelections, invocationForm } from "./invocation-identity.ts";
import type { FormSelections } from "./invocation-identity.ts";
import type { ComponentInvocation } from "./invocation-identity.ts";
import type {
  FunctionComponentDefinition,
  Json,
  JsonObject,
  Segment,
  SourcePosition,
} from "./types.ts";

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
  | "content"
  | "form"
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
  content:
    "a generated fragment gives content to a component this host admitted only in its " +
    "self-closing form.",
  form:
    "a generated fragment writes self-closing a component this host admitted only in its " +
    "paired form.",
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
  "admission resumes only under the exact effect classes, Workspace roots, pinned identities, " +
  "forms and requests it was admitted with.";

const UNREADABLE = "the retained generated-XMD admission record cannot be read as one.";

/**
 * What an admitted invocation is refused with when its form is not the one its
 * identity was admitted for.
 *
 * Preflight decides the form from the scan and this reads the engine's own
 * account of the same element, so the two agree for every invocation the engine
 * made. What they do not agree about is an invocation something built rather
 * than received — which is the case this refuses, before the component runs and
 * therefore before any provider is reached. Fixed, and naming nothing the
 * fragment carried.
 */
const SHAPE =
  "a generated element was admitted for one form and invoked as another. An admitted identity " +
  "runs the form the element was written as, which is read from the invocation the engine " +
  "issued rather than from anything composed around it.";

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
 * The effect classes a host table is divided into.
 *
 * A class is what the caller selects, and the host table beneath the label is
 * what the selection resolves to. `read` observes and returns a value; `write`
 * mutates the run's own Workspace and returns nothing the result collects.
 */
export type GeneratedEffectClass = "read" | "write";

/**
 * The authored forms one pinned identity runs in.
 *
 * A component whose two spellings do different things has two identities, so
 * the form travels with the identity rather than being decided inside the
 * component. `either` is one identity that does the same thing both ways.
 */
export type GeneratedComponentForm = "self-closing" | "paired" | "either";

/** The two forms an element is actually written in. */
type AuthoredForm = "self-closing" | "paired";

/** Canonical order, everywhere a class or a form is compared or retained. */
const EFFECT_CLASSES: readonly GeneratedEffectClass[] = ["read", "write"];
const AUTHORED_FORMS: readonly AuthoredForm[] = ["self-closing", "paired"];

function authoredForms(form: GeneratedComponentForm): readonly AuthoredForm[] {
  return form === "either" ? AUTHORED_FORMS : [form];
}

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
  /**
   * Whether only the self-closing form of this name is admitted.
   *
   * A component whose two forms do different things has two identities, and a
   * host admitting one of them is not admitting the other. `<File>` is the case
   * that matters: `hasContent()` is exactly `!selfClosing`, so the paired form
   * writes. The constraint therefore travels with the pinned identity and is
   * decided in preflight, before the first effect — not checked inside the
   * component after earlier elements have already run.
   */
  readonly selfClosing?: boolean;
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
 * The pinned core `<File>` identity, constrained to its read form.
 *
 * Core's own default definition, and only its self-closing spelling. `<File>`
 * reads when it has no content and writes when it has some, so admitting the
 * unconstrained definition would admit a write — which is why this constructor
 * exists rather than a caller reaching for `CORE_REGISTRY` and hoping. The
 * identity says so too, so a run that later admitted the unconstrained `File`
 * would be stating a different policy and a retained admission would refuse it.
 *
 * An admitted read invokes the ordinary `<File>` component and therefore the
 * installed Files provider, which under a workflow run is the transaction-bound
 * one. There is no second filesystem path here.
 */
export function pinnedFileRead(): GeneratedObservation {
  const definition = CORE_REGISTRY.get("File")?.default?.definition;
  if (definition === undefined || definition.kind !== "function") {
    throw new GeneratedXmdError("core supplies no File component to admit.");
  }
  return {
    name: "File",
    identity: `${CORE_ORIGIN}#File:read`,
    definition,
    selfClosing: true,
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

/**
 * One mutation component a generated fragment may name, and the exact
 * definition that name runs.
 *
 * The same shape a read entry has, with one difference that is the whole point:
 * `form` is required. A mutation is admitted for the spelling that mutates and
 * for no other, so `<File>` paired and `<File />` self-closing are two entries
 * under one name — and which one an element gets is decided in preflight, from
 * how the element was written, rather than by whichever entry the host listed
 * first.
 *
 * A mutation contributes nothing to the evaluator's result. What it did is
 * retained by its own ordinary durable effect, which is the authoritative
 * account of it.
 */
export interface GeneratedMutation {
  readonly name: string;
  readonly identity: string;
  readonly definition: FunctionComponentDefinition;
  readonly form: GeneratedComponentForm;
}

/**
 * The pinned core `<File>` identity, constrained to its write form.
 *
 * Core's own default definition again, and only its paired spelling — including
 * the empty paired one, which truncates. An admitted write invokes the ordinary
 * `<File>` component and therefore the installed Files provider, which under a
 * workflow run is the transaction-bound one, so the mutation crosses the run's
 * ordinary effect transaction rather than a path of the evaluator's own.
 */
export function pinnedFileWrite(): GeneratedMutation {
  const definition = CORE_REGISTRY.get("File")?.default?.definition;
  if (definition === undefined || definition.kind !== "function") {
    throw new GeneratedXmdError("core supplies no File component to admit.");
  }
  return {
    name: "File",
    identity: `${CORE_ORIGIN}#File:write`,
    definition,
    form: "paired",
  };
}

/**
 * The pinned core `<File.Delete>` identity, in the one form it has.
 *
 * Core's own default definition, and its self-closing spelling. One name, one
 * identity: unlike `<File>`, whose two spellings do different things, this
 * component answers the self-closing form and refuses the paired one, so the
 * form stated here names what the identity is rather than narrowing it to part
 * of it. Stating it anyway is what puts the decision in preflight, before the
 * first effect of the fragment — a paired spelling costs an earlier admitted
 * element nothing.
 *
 * An admitted deletion invokes the ordinary `<File.Delete>` component and
 * therefore the installed Files provider, which under a workflow run is the
 * transaction-bound one, so the removal crosses the run's ordinary effect
 * transaction rather than a path of the evaluator's own. What it did is
 * retained by the `workspace_file` effect it publishes there, and the evaluator
 * collects nothing beside it: a mutation contributes no observation, and a
 * deletion has no outcome for one to carry.
 */
export function pinnedFileDelete(): GeneratedMutation {
  const definition = CORE_REGISTRY.get("File.Delete")?.default?.definition;
  if (definition === undefined || definition.kind !== "function") {
    throw new GeneratedXmdError("core supplies no File.Delete component to admit.");
  }
  return {
    name: "File.Delete",
    identity: `${CORE_ORIGIN}#File.Delete`,
    definition,
    form: "self-closing",
  };
}

/**
 * One host-owned mutation component, by the exact definition the host holds and
 * the exact form it admits.
 */
export function pinnedMutation(
  name: string,
  identity: string,
  definition: FunctionComponentDefinition,
  form: GeneratedComponentForm,
): GeneratedMutation {
  return { name, identity, definition, form };
}

/**
 * What one admitted observation produced.
 *
 * The value is the component's own return, kept whatever the fragment rendered.
 * Which pinned identity produced it is not here: the admission record already
 * retains the identities the fragment named, and a second copy on the result
 * would be a second thing to keep true.
 * An admitted `<Fetch>` written without `as` renders nothing at all — a
 * component returning a non-string has nowhere to render — so a result taken
 * from the rendered text would hand the Agent an empty answer to the question it
 * asked.
 */
export interface GeneratedObservationValue {
  readonly name: string;
  readonly value: Json;
}

/**
 * What one admitted fragment produced, detached from its expansion.
 *
 * Deterministic: the observations appear in the order the fragment invoked them,
 * each under the name the fragment invoked it by. Which pinned identity produced
 * one is not here — the admission record retains that — so the value a document
 * binds is the name and the return, and nothing else. The rendered text is kept
 * beside them rather than instead of them: a fragment whose elements render
 * prose still has prose, and a fragment whose elements render nothing still has
 * its values.
 */
export interface GeneratedObservationResult {
  readonly observations: readonly GeneratedObservationValue[];
  /** What the fragment rendered, beside the values rather than instead of them. */
  readonly output: string;
}

/** What a trusted host asks this evaluator to admit. */
export interface GeneratedXmdRequest {
  /** Which fragment this is. It names the durable admission record. */
  readonly id: string;
  /** The candidate source, exactly as it was generated. */
  readonly source: string;
  /** The retained Workspace roots the host is willing to expose. */
  readonly workspaceRoots: readonly string[];
  /** The one root admitted effects address. */
  readonly selectedRoot: string;
  /** The pinned observation identities the `read` class resolves to. */
  readonly observations: readonly GeneratedObservation[];
  /** The pinned mutation identities the `write` class resolves to. */
  readonly mutations?: readonly GeneratedMutation[];
  /**
   * Which effect classes this fragment may draw on. Omitted selects `read`
   * alone, which is what a host stating no class at all is asking for.
   */
  readonly allow?: readonly GeneratedEffectClass[];
  /**
   * Where the authored element asking for this admission was written.
   * Diagnostic journal data beside the admission's identity and policy — it
   * takes no part in the durable name, the policy comparison, or admission.
   */
  readonly position?: Readonly<SourcePosition>;
}

/**
 * One admitted identity, normalized out of the class table it came from.
 *
 * A read entry and a mutation entry differ in what they select and in what
 * they contribute to the result; everything the preflight and the retained
 * policy do with them is the same, and this is that shape.
 */
interface Entry {
  readonly name: string;
  readonly identity: string;
  readonly definition: FunctionComponentDefinition;
  readonly forms: readonly AuthoredForm[];
  readonly effect: GeneratedEffectClass;
  readonly requests?: readonly GeneratedRequest[];
}

/** The pinned identity of one admitted entry, as the run retains it. */
interface RetainedEntry {
  readonly name: string;
  readonly identity: string;
  readonly forms: readonly AuthoredForm[];
}

/** One element the fragment actually named, as the run retains it. */
interface RetainedInvocation {
  readonly name: string;
  readonly identity: string;
  readonly form: AuthoredForm;
}

/**
 * The ceilings one fragment ran under, normalized.
 *
 * Normalized because this is what a continuation is compared against: a request
 * the host spelled differently but meant identically must compare equal, and
 * one it meant differently must not. The selection is here too — only the
 * tables `allow` chose take part, so a host that changed a table this admission
 * never drew on has changed nothing this admission was granted under.
 */
interface Policy {
  readonly allow: readonly GeneratedEffectClass[];
  readonly roots: readonly string[];
  readonly selectedRoot: string;
  readonly allowed: readonly RetainedEntry[];
  readonly requests: readonly FetchRequest[];
}

/** The decision this run recorded, restored from its own durable record. */
type RetainedAdmission =
  | {
      readonly decision: "admitted";
      readonly source: string;
      readonly named: readonly RetainedInvocation[];
      readonly policy: Policy;
    }
  | { readonly decision: "refused"; readonly construct: Construct };

/**
 * Refuse this invocation unless it is the form its identity was admitted for.
 *
 * Preflight decided the identity from the scan; this reads the engine's own
 * account of the same element, so the two agree unless something built the
 * invocation rather than receiving it — which is what this refuses.
 *
 * Neither `Component.hasContent()` nor the method on the invocation takes part.
 * The chain is answered by whoever installed a handler outside this expansion,
 * and the method belongs to whatever object a caller passed; both are answers
 * about something other than the element (executable-mdx-spec §5.6).
 */
function holdForm(form: AuthoredForm, invocation: ComponentInvocation): void {
  // The engine's own account of the element, not the method on the object this
  // was handed. A wrapper can mint an object carrying that method; it cannot
  // mint an issuance, and this reads the issuance
  // (`invocation-identity.ts`). A component whose form the engine-owned
  // dispatcher already enforces is held to the same fact twice, which is
  // harmless; one whose definition carries no dispatcher — a form-insensitive
  // pinned identity — is held to it here and nowhere else.
  const written = invocationForm(invocation);
  if (written === undefined || written !== form) {
    throw new GeneratedXmdError(SHAPE);
  }
}

/**
 * The authority a generated fragment imports through.
 *
 * Resolution is closed over what preflight decided and consults nothing else —
 * no component search path, no registration, no bundle. Each import mints a
 * fresh copy of the pinned definition, so what a handler does to one answer
 * cannot reach the table or a later import.
 *
 * It is closed over the *plan* rather than the table because one name can hold
 * two identities in two classes. `<File />` observes and `<File>…</File>`
 * writes, and only preflight — which read how each element was written — knows
 * which of them an import is for. Every entry for a name shares one definition,
 * so what the import answers with is the same either way; what differs is
 * whether the value it produced is collected, and that is a property of the
 * entry preflight selected rather than of what the component returned.
 */
class GeneratedImportAuthority implements ImportAuthority {
  readonly #planned: Map<string, Planned[]>;
  readonly #imports = new CanonicalImports();
  readonly #values: GeneratedObservationValue[] = [];
  /**
   * This fragment's own selection frames.
   *
   * A generated fragment resolves its imports here rather than through the
   * document's resolver, so it records what it selected here too — the same
   * boundary, owned by the same object that owns the admission.
   */
  readonly #forms = installFormSelections();
  /** The form authority under each admitted name's wrapper. */
  readonly #dispatchers = new Map<string, unknown>();

  constructor(named: readonly Planned[]) {
    const planned = new Map<string, Planned[]>();
    for (const invocation of named) {
      const queue = planned.get(invocation.name);
      if (queue === undefined) {
        planned.set(invocation.name, [invocation]);
        continue;
      }
      queue.push(invocation);
    }
    this.#planned = planned;
  }

  /** What each admitted read returned, in invocation order. */
  get values(): GeneratedObservationValue[] {
    return this.#values;
  }

  /** The answer canonical execution produces for this name. */
  issue(name: string): ImportedDefinition {
    // Imports happen once per element and in the order the walk read them, so
    // the head of this name's queue is the entry preflight selected for the
    // element being expanded. An import the plan does not account for is an
    // element preflight never saw, and it is refused rather than resolved.
    const planned = this.#planned.get(name)?.shift();
    if (planned === undefined) {
      throw new GeneratedXmdError(CONSTRUCT.component);
    }
    const { entry, form } = planned;
    const copy = retain(entry.definition);
    if (copy === undefined || copy.kind !== "function" || typeof copy.fn !== "function") {
      throw new GeneratedXmdError(CONSTRUCT.component);
    }
    const implementation = copy.fn;
    // The wrapper below is the answer to the import; the dispatcher underneath
    // it is the form authority. Recording the dispatcher is what binds the
    // invocation to it — a wrapper that collected results is trusted host code
    // and takes no part in deciding which form-specific body runs.

    // The value is taken where the component produced it. Reading it back from
    // the rendered fragment would lose every observation that renders nothing,
    // which is most of them. A mutation collects nothing: its own durable
    // record is the account of it.
    const values = entry.effect === "read" ? this.#values : undefined;
    const admitted: FunctionComponentDefinition = {
      ...copy,
      *fn(props, invocation) {
        // Before the component runs, and therefore before it reaches a
        // provider: the form that chose this identity must be the form this
        // invocation is of.
        holdForm(form, invocation);
        const value = yield* implementation(props, invocation);
        values?.push({
          name: entry.name,
          // Parsed rather than asserted: this value is retained and handed back
          // to a trusted host, and a component that returned something with no
          // JSON shape has broken the contract an observation runs under. A
          // component that returned nothing observed nothing, which is `null`.
          value: value === undefined ? null : parseJson(value),
        });
        return value;
      },
    };
    // The wrapper above is the answer to the import; the dispatcher underneath
    // it is the form authority. Remembered by name so `authorize` can record it
    // against core's own copy — the object expansion actually invokes — because
    // a trusted collection wrapper takes no part in deciding which
    // form-specific body runs.
    this.#dispatchers.set(name, implementation);
    return this.#imports.issue(name, admitted);
  }

  /** The frames this fragment's own imports record into. */
  get forms(): FormSelections {
    return this.#forms;
  }

  authorize(name: string, answer: ImportedDefinition): ImportedDefinition {
    const canonical = this.#imports.authorize(
      name,
      answer,
      (refusal) => new GeneratedXmdError(WITNESS[refusal]),
    );
    // Recorded here rather than at issue, because this is the object expansion
    // invokes: `authorize` answers with core's own copy of the definition
    // rather than the one the chain handed back.
    this.#forms.select(name, canonical, this.#dispatchers.get(name));
    return canonical;
  }
}

/**
 * The classes this request selects, canonically ordered.
 *
 * Defensive on purpose. A document host validates `allow` against its own
 * closed schema, and a host that is not a document has no schema at all — so
 * an empty, duplicated or unknown selection is refused here too, before a
 * candidate is parsed and before any record of it exists.
 */
function selection(allow: readonly GeneratedEffectClass[] | undefined): GeneratedEffectClass[] {
  if (allow === undefined) {
    return ["read"];
  }
  if (allow.length === 0) {
    throw new GeneratedXmdError("a generated-XMD allowlist selected no effect class.");
  }
  const selected = new Set<GeneratedEffectClass>();
  for (const effect of allow) {
    if (!EFFECT_CLASSES.includes(effect)) {
      throw new GeneratedXmdError(
        "a generated-XMD allowlist selected an effect class this evaluator does not have.",
      );
    }
    if (selected.has(effect)) {
      throw new GeneratedXmdError("a generated-XMD allowlist selected one effect class twice.");
    }
    selected.add(effect);
  }
  // Authored order is not identity: two hosts asking for the same two classes
  // are asking for the same thing, and a continuation compares this.
  return EFFECT_CLASSES.filter((effect) => selected.has(effect));
}

/**
 * Every entry the selected classes resolve to, in the order the host stated
 * them: the read table first, then the write table.
 *
 * A selected class the host supplied no table for fails here, as the host's own
 * error and before a candidate is read. Asking for `write` of a host that
 * admits no mutation is not a fragment being refused; it is a policy that
 * cannot be stated.
 */
function selectedEntries(
  request: GeneratedXmdRequest,
  allow: readonly GeneratedEffectClass[],
): Entry[] {
  const entries: Entry[] = [];
  if (allow.includes("read")) {
    if (request.observations.length === 0) {
      throw new GeneratedXmdError("a generated-XMD allowlist selected `read` with no read table.");
    }
    for (const observation of request.observations) {
      entries.push({
        name: observation.name,
        identity: observation.identity,
        definition: observation.definition,
        // An entry the host constrained to its self-closing spelling admits
        // that one; an unconstrained one admits both, as it always has.
        forms: observation.selfClosing === true ? ["self-closing"] : AUTHORED_FORMS,
        effect: "read",
        ...(observation.requests === undefined ? {} : { requests: observation.requests }),
      });
    }
  }
  if (allow.includes("write")) {
    const mutations = request.mutations ?? [];
    if (mutations.length === 0) {
      throw new GeneratedXmdError(
        "a generated-XMD allowlist selected `write` with no write table.",
      );
    }
    for (const mutation of mutations) {
      entries.push({
        name: mutation.name,
        identity: mutation.identity,
        definition: mutation.definition,
        forms: authoredForms(mutation.form),
        effect: "write",
      });
    }
  }
  return entries;
}

/**
 * The pinned identities this fragment may name, keyed by the name it writes.
 *
 * A name may hold more than one entry, because a component whose two spellings
 * do different things has two identities. What it may not hold is two entries
 * that could both answer for one element, or two definitions: an import is
 * asked for by name, so a name resolves to exactly one implementation and the
 * form chooses only which identity that implementation ran as. Either
 * ambiguity is a malformed host table, refused before anything is retained
 * rather than settled by whichever entry was listed first.
 */
function admitted(entries: readonly Entry[]): Map<string, Entry[]> {
  const table = new Map<string, Entry[]>();
  for (const entry of entries) {
    const { name } = entry;
    if (!isComponentName(name) || RESERVED_STRUCTURAL.has(name)) {
      throw new GeneratedXmdError(
        "a generated-XMD allowlist admitted a name that is not a component name.",
      );
    }
    if (entry.definition.kind !== "function") {
      throw new GeneratedXmdError(
        "a generated-XMD allowlist admitted a definition that is not a function component.",
      );
    }
    if (typeof entry.definition.fn !== "function") {
      // The `<Test>` harness marker is a definition whose `fn` is data rather
      // than an implementation. Nothing invokes it here, and an entry whose
      // effect cannot be performed is not one.
      throw new GeneratedXmdError(
        "a generated-XMD allowlist admitted a definition with no invocable implementation.",
      );
    }
    const existing = table.get(name);
    if (existing === undefined) {
      table.set(name, [entry]);
      continue;
    }
    if (existing.some((other) => other.definition !== entry.definition)) {
      throw new GeneratedXmdError(
        "a generated-XMD allowlist admitted one name with two definitions.",
      );
    }
    if (existing.some((other) => other.forms.some((form) => entry.forms.includes(form)))) {
      throw new GeneratedXmdError("a generated-XMD allowlist admitted one name and form twice.");
    }
    existing.push(entry);
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

/** Two lists of the same strings, in the same order. */
function sameStrings(one: readonly string[], other: readonly string[]): boolean {
  return one.length === other.length && one.every((value, index) => value === other[index]);
}

/**
 * The requests each admitted observation may perform, normalized.
 *
 * Deliberately computed *outside* the durable admission. These are the host's
 * own values, so a malformed one is a host mistake rather than a statement
 * about the candidate — it should fail as itself, before anything is appended,
 * rather than be serialized into the journal as a refusal of the fragment.
 */
function* normalizedCeilings(entries: readonly Entry[]): Operation<Map<string, FetchRequest[]>> {
  const ceilings = new Map<string, FetchRequest[]>();
  for (const entry of entries) {
    if (entry.requests === undefined) {
      continue;
    }
    const normalized: FetchRequest[] = [];
    for (const props of entry.requests) {
      normalized.push(yield* prepareFetchRequest(props));
    }
    // Keyed by identity rather than by name, because a name can hold two of
    // them and only one of the two may perform a request.
    ceilings.set(entry.identity, normalized);
  }
  return ceilings;
}

/** The ceilings this run states, in the order the host stated them. */
function currentPolicy(
  request: GeneratedXmdRequest,
  allow: readonly GeneratedEffectClass[],
  entries: readonly Entry[],
  ceilings: ReadonlyMap<string, FetchRequest[]>,
): Policy {
  const requests: FetchRequest[] = [];
  const allowed: RetainedEntry[] = [];
  for (const entry of entries) {
    allowed.push({ name: entry.name, identity: entry.identity, forms: entry.forms });
    requests.push(...(ceilings.get(entry.identity) ?? []));
  }
  return {
    allow: [...allow],
    roots: [...request.workspaceRoots],
    selectedRoot: request.selectedRoot,
    allowed,
    requests,
  };
}

/** The policy as journal data. */
function policyRecord(policy: Policy): JsonObject {
  return {
    allow: [...policy.allow],
    roots: [...policy.roots],
    selectedRoot: policy.selectedRoot,
    allowed: policy.allowed.map((entry) => ({
      name: entry.name,
      identity: entry.identity,
      forms: [...entry.forms],
    })),
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
  const { allow, roots, selectedRoot, allowed, requests } = value;
  if (!Array.isArray(roots) || typeof selectedRoot !== "string") {
    return undefined;
  }
  if (!Array.isArray(allow) || !Array.isArray(allowed) || !Array.isArray(requests)) {
    return undefined;
  }
  const classes = readClasses(allow);
  if (classes === undefined) {
    return undefined;
  }
  const retainedRoots: string[] = [];
  for (const root of roots) {
    if (typeof root !== "string") {
      return undefined;
    }
    retainedRoots.push(root);
  }
  const identities = readAllowed(allowed);
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
    allow: classes,
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

function readClasses(value: readonly Json[]): GeneratedEffectClass[] | undefined {
  const classes: GeneratedEffectClass[] = [];
  for (const effect of value) {
    const parsed = EFFECT_CLASSES.find((known) => known === effect);
    if (parsed === undefined) {
      return undefined;
    }
    classes.push(parsed);
  }
  return classes;
}

function readForms(value: Json): AuthoredForm[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const forms: AuthoredForm[] = [];
  for (const form of value) {
    const parsed = AUTHORED_FORMS.find((known) => known === form);
    if (parsed === undefined) {
      return undefined;
    }
    forms.push(parsed);
  }
  return forms;
}

function readAllowed(value: readonly Json[]): RetainedEntry[] | undefined {
  const identities: RetainedEntry[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return undefined;
    }
    const { name, identity } = entry;
    const forms = readForms(entry.forms);
    if (typeof name !== "string" || typeof identity !== "string" || forms === undefined) {
      return undefined;
    }
    identities.push({ name, identity, forms });
  }
  return identities;
}

function readNamed(value: readonly Json[]): RetainedInvocation[] | undefined {
  const named: RetainedInvocation[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return undefined;
    }
    const { name, identity } = entry;
    const form = AUTHORED_FORMS.find((known) => known === entry.form);
    if (typeof name !== "string" || typeof identity !== "string" || form === undefined) {
      return undefined;
    }
    named.push({ name, identity, form });
  }
  return named;
}

/**
 * Whether a resumed run still holds the grant the retained admission was made
 * under.
 *
 * Two kinds of term, compared differently on purpose.
 *
 * The Workspace roots are as-of-admission provenance over a set the run's own
 * progress legitimately grows: every committed mutation retains another
 * immutable root and advances the authoritative current root. So the retained
 * basis is asked for by membership — every admission root and the admission's
 * selected root must still be retained, and the root the run now stands on
 * must be a retained one — while additional roots and an advanced current
 * root change nothing this admission was granted under. A run that lost an
 * admission root no longer holds the history the grant was made over, and is
 * refused before any generated work.
 *
 * Every other term is a host-stated ceiling and compares whole and exactly,
 * in order: a widened class selection, one identity behind a name replaced, a
 * form added, or one request added to the allowed set each make this false.
 * Widening is the case that matters most — a ceiling that still contains the
 * original request is precisely the one that comparing the *fragment* against
 * the *current* policy would wave through.
 */
function policyHolds(retained: Policy, current: Policy): boolean {
  const held = new Set(current.roots);
  if (!retained.roots.every((root) => held.has(root))) {
    return false;
  }
  if (!held.has(retained.selectedRoot) || !held.has(current.selectedRoot)) {
    return false;
  }
  if (!sameStrings(retained.allow, current.allow)) {
    return false;
  }
  if (retained.allowed.length !== current.allowed.length) {
    return false;
  }
  const replaced = retained.allowed.some((entry, index) => {
    const here = current.allowed[index];
    return (
      here === undefined ||
      here.name !== entry.name ||
      here.identity !== entry.identity ||
      !sameStrings(here.forms, entry.forms)
    );
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

/** One element the fragment named, and the entry preflight selected for it. */
interface Planned extends RetainedInvocation {
  readonly entry: Entry;
}

/** What one fragment turned out to name, in the order it named it. */
interface Preflight {
  readonly segments: Segment[];
  readonly named: Planned[];
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
  table: ReadonlyMap<string, Entry[]>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
): Operation<Preflight> {
  // Read once, here, so a contextual default that refuses fails as itself
  // rather than as a statement about the fragment. Every candidate request
  // below reads the same value, and what it can fail on afterwards is the
  // props it was handed.
  yield* timeoutFetch;

  const named: Planned[] = [];
  const segments = scanSegments(source);
  yield* walk(segments, table, ceilings, named);
  return { segments, named };
}

/**
 * The candidate's request, normalized — or the fixed refusal.
 *
 * `prepareFetchRequest()` reports what is wrong with a request by quoting it:
 * the URL that is not a URL, the header name written twice, the timeout that is
 * not a duration. Every one of those is generated text, and a refusal of
 * generated text may not carry it — not into the run's failure, and not into
 * the journal, where a thrown executor error is serialized with its message and
 * its stack. So the diagnostic is dropped here and the class is kept.
 */
function* admitCandidateRequest(props: Record<string, Json>): Operation<FetchRequest> {
  try {
    return yield* prepareFetchRequest(props);
  } catch {
    throw new Refusal("request");
  }
}

function* walk(
  segments: readonly Segment[],
  table: ReadonlyMap<string, Entry[]>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
  named: Planned[],
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
        const entries = table.get(segment.name);
        if (entries === undefined) {
          throw new Refusal("component");
        }
        if (Object.keys(segment.expressions).length > 0) {
          throw new Refusal("expression");
        }
        if ("as" in segment.props) {
          throw new Refusal("binding");
        }
        // How the element was written, read from the scan rather than from
        // anything the run could answer differently later. This is what
        // separates the two `<File>` identities, so it is decided here — once,
        // before the first effect — and travels with the invocation.
        const form: AuthoredForm = segment.selfClosing ? "self-closing" : "paired";
        const entry = entries.find((candidate) => candidate.forms.includes(form));
        if (entry === undefined) {
          throw new Refusal(form === "paired" ? "content" : "form");
        }
        if (entry.requests !== undefined) {
          const ceiling = ceilings.get(entry.identity) ?? [];
          const candidate = yield* admitCandidateRequest(segment.props);
          if (!ceiling.some((allowed) => sameRequest(allowed, candidate))) {
            throw new Refusal("request");
          }
        }
        named.push({ name: entry.name, identity: entry.identity, form, entry });
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
  table: ReadonlyMap<string, Entry[]>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
  policy: Policy,
): Operation<DurableJson> {
  try {
    const { named } = yield* preflight(source, table, ceilings);
    return parseJson({
      decision: "admitted",
      source,
      named: named.map((entry) => ({
        name: entry.name,
        identity: entry.identity,
        form: entry.form,
      })),
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
  table: ReadonlyMap<string, Entry[]>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
  policy: Policy,
  position: Readonly<SourcePosition> | undefined,
): Operation<Json> {
  const stored = yield createDurableOperation<DurableJson>(
    {
      type: GENERATED_XMD,
      name: `generated:${id}`,
      input: policyRecord(policy),
      ...sourceDescription(position),
    },
    () => admitSource(source, table, ceilings, policy),
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
  const invocations = readNamed(named);
  const retained = readPolicy(policy);
  if (invocations === undefined || retained === undefined) {
    return undefined;
  }
  return { decision, source, named: invocations, policy: retained };
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
  named: readonly Planned[],
): Operation<GeneratedObservationResult> {
  return scoped(function* () {
    yield* ErrorMode.set("throw");
    const authority = new GeneratedImportAuthority(named);
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          return authority.issue(name);
        },
      },
      { at: "min" },
    );
    const expanded = yield* expandSegmentsWithin(
      segments,
      {},
      {},
      new Set<string>(),
      createBlockCounter(),
      undefined,
      extendPath("", { f: "gen", id }),
      0,
      undefined,
      // No identity domains: a generated fragment names no durable work of its
      // own, and what it may invoke is this table and nothing else. The
      // selection frames are this fragment's own, so what its admitted imports
      // select is not the enclosing document's business and cannot be reached
      // from it.
      { imports: authority, forms: authority.forms },
    );
    return { observations: authority.values, output: renderSegments(expanded) };
  });
}

/**
 * Admit one generated fragment and perform what it asks for.
 *
 * An `Operation`, so its durable records belong to the caller's own durable
 * sequence: the production workflow reaches it through the host-declared
 * `<Evaluate>` component inside the owning document expansion, and the
 * admission together with every durable effect the admitted fragment performs
 * is offered inline there, in authored order. A partial continuation offers
 * the same sequence and restores the admission and every observation that
 * already committed rather than performing them again.
 */
export function* evaluateGeneratedXmd(
  request: GeneratedXmdRequest,
): Operation<GeneratedObservationResult> {
  const allow = selection(request.allow);
  const entries = selectedEntries(request, allow);
  const table = admitted(entries);
  const ceilings = yield* normalizedCeilings(entries);
  const policy = currentPolicy(request, allow, entries, ceilings);

  const stored = yield* persistAdmission(
    request.id,
    request.source,
    table,
    ceilings,
    policy,
    request.position,
  );
  const decided = readAdmission(stored);
  if (decided === undefined) {
    throw new GeneratedXmdError(UNREADABLE);
  }
  if (decided.decision === "refused") {
    throw new GeneratedXmdError(CONSTRUCT[decided.construct]);
  }
  // Before a single component is invoked or a single request is performed: a
  // retained admission is a grant whose non-root ceilings must be stated
  // exactly again, and whose Workspace basis must still be retained. The run's
  // own progress may have retained further roots and advanced the current one;
  // a run that lost an admission root, or moved any exact term, is asking for
  // a different grant.
  if (!policyHolds(decided.policy, policy)) {
    throw new GeneratedXmdError(CEILING);
  }

  // The retained source is what expands, so a continuation runs the fragment
  // this run admitted rather than whatever a later caller happens to hold.
  const restored = yield* preflight(decided.source, table, ceilings);
  return yield* expand(request.id, restored.segments, restored.named);
}
