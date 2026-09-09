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
 * Each component keeps its ordinary binding and output behavior. A read
 * written without `as` renders what it ordinarily renders and one written with
 * `as` binds inside the fragment; nothing is copied into a separate result.
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
 *
 * An identity in that record is a closed tagged structural record: what kind of
 * thing is behind the name, the origin that owns it, the component key, and the
 * revision. Four terms rather than one spelling, so a reader comparing two
 * admissions can say which of them moved and no two hosts have to agree on a
 * separator. Version 1 — the untagged #369 record — wrote one opaque string
 * instead, and stays both readable *and* resumable: a version-1 string is
 * reconciled against a current capability identity under the spelling that
 * build used. Nothing this build writes uses that spelling.
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
import { prepareFetchRequest, requestRecord } from "./fetch-request.ts";
import { timeoutFetch } from "@executablemd/runtime";
import type { FetchRequest } from "./fetch-request.ts";
import { isJsonObject, parseJson } from "./json.ts";
import { markGeneratedRequestRefusal } from "./generated-request-refusal.ts";
import { GeneratedDataExpressions, validateDataExpression } from "./generated-expressions.ts";
import { capturedBinding } from "./invocation-rules.ts";
import { renderSegments } from "./render.ts";
import { scanSegments } from "./scanner.ts";
import { sourceDescription } from "./source-position.ts";
import { RESERVED_STRUCTURAL } from "./structural.ts";
// The ordinary source rules, read rather than reimplemented: a construct means
// one thing whether a person wrote it or an Agent did.
import {
  answersViolations,
  answerViolations,
  breakViolations,
  eachCaptureBinding,
  eachItemBinding,
  eachViolations,
  ifConditionViolation,
  ifPropsViolation,
  ifStructure,
  isBlankText,
  letBindingName,
  letViolations,
  loopViolations,
  printErrorsViolations,
  switchStructure,
} from "./structural-rules.ts";
import type { StructuralViolation } from "./structural-rules.ts";
import { installFormSelections, invocationForm } from "./invocation-identity.ts";
import type { FormSelections, ProtectedBodies } from "./invocation-identity.ts";
import type { ComponentInvocation } from "./invocation-identity.ts";
import type { SyntaxReference } from "./syntax-reference.ts";
import type {
  ComponentElement,
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
  | "structure"
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
  expression:
    "a generated fragment states an expression prop that is not declarative data over its own " +
    "bindings.",
  interpolation: "a generated fragment reads a binding through interpolation, which it may not.",
  binding: "a generated fragment binds a result with an `as` that is not a binding name.",
  component: "a generated fragment names a component this host did not admit.",
  content:
    "a generated fragment gives content to a component this host admitted only in its " +
    "self-closing form.",
  form:
    "a generated fragment writes self-closing a component this host admitted only in its " +
    "paired form.",
  construct: "a generated fragment carries a construct this evaluator does not admit.",
  // Distinct from `component`, because the two are different mistakes. A
  // structural construct is language rather than authority: writing one badly,
  // or writing one where the generated root supplies no context for it, is a
  // source error the candidate can correct — not a statement that the host
  // withheld something.
  structure:
    "a generated fragment writes a structural construct the language does not allow where it " +
    "was written.",
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
 * What a resumed run is refused with when the text it now offers is not the
 * text that was admitted.
 *
 * The admission is a decision about one exact fragment. Expanding the retained
 * copy while the caller holds a different one would run something nobody
 * admitted *this* run for — the earlier behavior, which silently preferred the
 * retained text and let a changed candidate pass unnoticed. Naming neither
 * fragment, because both are generated text.
 */
const STALE_TEXT =
  "a generated fragment was admitted for text this run no longer offers. A retained admission " +
  "resumes only for the exact text it was made about.";

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
 * Which implementation one admitted entry runs, as the run retains it.
 *
 * A closed tagged record rather than a string, and structural rather than
 * assembled, because this is what a continuation compares. Four terms, each
 * with one meaning: a reader looking at two admissions can say *which* of them
 * moved, and no host has to agree with another about how to spell a separator.
 *
 * `kind` is part of the identity rather than beside it. An operation canonical
 * core supplies the body for and an implementation the ordinary import chain
 * answered with are different grants even under one origin, key and revision —
 * the first cannot be composed around and the second was resolved through
 * middleware — so a record that confused them would compare a fragment's
 * authority equal to authority it never had.
 *
 * Never derived from a function. An implementation is not an identity, and
 * serializing or inspecting one would make the retained policy depend on how a
 * host happened to write its code. Functions never enter the journal.
 */
export type RetainedFragmentIdentity =
  | {
      readonly kind: "capability";
      readonly origin: string;
      readonly key: string;
      readonly revision: string;
    }
  | {
      readonly kind: "component-answer";
      readonly origin: string;
      readonly key: string;
      readonly revision: string;
    };

/** The two ways a host can say what is behind an admitted name. */
const IDENTITY_KINDS: readonly RetainedFragmentIdentity["kind"][] = [
  "capability",
  "component-answer",
];

/**
 * What a record retains for one entry: this version's identity, or version 1's.
 *
 * Version 1 retained one opaque string. It is kept as the string it is rather
 * than parsed into a shape it never had, and reconciled against a version-2
 * identity under the spelling the build that wrote it used — so an older record
 * stays readable *and* stays a grant, instead of being readable and useless.
 */
type RetainedIdentity = RetainedFragmentIdentity | LegacyIdentity;

/** One version-1 identity: the exact string an older build wrote. */
interface LegacyIdentity {
  readonly legacy: string;
}

/**
 * One identity as a map key, for the run's own tables.
 *
 * Never retained and never compared: what a continuation is held to is the
 * record's four members, read one at a time. This exists because a `Map` needs
 * a primitive, and it carries the kind so two grants that differ only in how
 * they were resolved do not share a ceiling.
 *
 * The encoding is JSON rather than the four terms joined by a separator,
 * because a joined key is only as unique as the separator is illegal. A host
 * may state an origin or a key holding any character at all — a URL with a
 * space in it, a component key with a `#` — and two identities that differ only
 * in where the separator falls would key one entry's request ceiling under
 * another's. JSON escapes what it encodes, so distinct terms encode distinctly.
 */
function identityKey(identity: RetainedFragmentIdentity): string {
  return JSON.stringify([identity.kind, identity.origin, identity.key, identity.revision]);
}

/**
 * Whether two version-2 identities describe the same implementation.
 *
 * Member by member, kind included: an operation canonical core supplies the
 * body for and an implementation the ordinary import chain answered with are
 * different grants even under one origin, key and revision.
 */
function sameStructural(one: RetainedFragmentIdentity, other: RetainedFragmentIdentity): boolean {
  return (
    one.kind === other.kind &&
    one.origin === other.origin &&
    one.key === other.key &&
    one.revision === other.revision
  );
}

/**
 * Whether the entry this run states is the one a retained record was admitted
 * under.
 *
 * Two version-2 records compare structurally, and two version-1 strings compare
 * as the strings they are.
 *
 * A version-1 string against a version-2 entry is the case that cannot be
 * decided by looking at either one. Version 1 retained one opaque value chosen
 * by whoever built the pinned entry — `@executablemd/core#File:read` from core,
 * `@executablemd/workflow/composition/dir-v2#Dir` from the workflow host, and
 * whatever a host passed to `pinnedComponent` from anyone else. No rule
 * recovers four structural terms from one of those, and a rule that appeared to
 * would only be reading the shapes core happens to use today back onto records
 * core did not write.
 *
 * So it is not inferred. The *current* entry states which version-1 strings it
 * succeeds, and a retained string reconciles only against that stated list.
 * Listing one is an assertion by the party that owns the entry; an entry that
 * lists none refuses every version-1 record naming it, which is the safe
 * direction. New records state the structural identity and never a string.
 */
function sameIdentity(retained: RetainedIdentity, current: RetainedEntry): boolean {
  const here = current.identity;
  if ("legacy" in retained) {
    if ("legacy" in here) {
      return retained.legacy === here.legacy;
    }
    // Only a capability reconciles. The component-answer arm did not exist when
    // version-1 records were written, so no such string ever described one —
    // and the kind is checked here rather than left to the profile, because
    // this is the comparison a continuation is actually held to.
    return here.kind === "capability" && current.legacy?.includes(retained.legacy) === true;
  }
  return "legacy" in here ? false : sameStructural(retained, here);
}

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
  readonly identity: RetainedFragmentIdentity;
  readonly definition: FunctionComponentDefinition;
  /**
   * The form authority underneath this entry's implementation, when the
   * definition wraps one.
   *
   * A host whose admitted definition is core's own guard around somebody else's
   * implementation still has to say which function decides the authored form,
   * because a selection reads that off the definition it was handed. Absent is
   * the ordinary case: the definition's own `fn` is the authority.
   */
  readonly dispatch?: unknown;
  /**
   * The exact version-1 identity strings this entry states it succeeds.
   *
   * Stated by whoever owns the entry rather than derived from the identity
   * above, because version 1 retained one opaque value that nothing recovers
   * four structural terms from. A retained version-1 record reconciles against
   * this list and against nothing else.
   */
  readonly legacy?: readonly string[];
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
 * The revision core's own entries state, wherever they are admitted from.
 *
 * One number for all of them, bumped whenever what any of these entries
 * authorizes changes, so a continuation admitted under an earlier revision is
 * refused rather than silently granted the newer authority.
 *
 * One constant rather than one per table. The pinned constructors here and the
 * evaluation profile's entries describe the same operations, and a reader
 * comparing two admissions has to be able to trust that they say so — two
 * numbers that had to be moved together would eventually not be.
 *
 * Revision 2 is where the authority behind these entries changed: an admitted
 * element used to invoke the ordinary component and resolve `API.Files` or
 * `API.Fetch` wherever it happened to run, and now it invokes a body closed over
 * the operations the host handed the profile.
 */
export const CORE_REVISION = "2";

/** One of core's own pinned identities, under core's origin and revision. */
function coreIdentity(key: string): RetainedFragmentIdentity {
  return { kind: "capability", origin: CORE_ORIGIN, key, revision: CORE_REVISION };
}

/**
 * The exact strings core's own entries were retained as under version 1.
 *
 * Written out one by one, and deliberately not assembled from the origin and
 * the key. There was never a rule producing these — `pinnedFetch` wrote its
 * string, `pinnedFileRead` wrote its own, and a host writing a fourth was under
 * no obligation to resemble either — so a function that built them would be
 * inventing the rule this module exists to say does not exist. Enumerating them
 * is also what makes the set reviewable: adding an alias is adding a line, and
 * every line is an assertion that the current entry authorizes no more than the
 * one that string named.
 *
 * Frozen and read by value at each call site. Nothing derives one, and a fifth
 * released alias would be a fifth literal here rather than a broader pattern.
 */
const CORE_V1_FETCH = Object.freeze(["@executablemd/core#Fetch"]);
const CORE_V1_FILE_READ = Object.freeze(["@executablemd/core#File:read"]);
const CORE_V1_FILE_WRITE = Object.freeze(["@executablemd/core#File:write"]);
const CORE_V1_FILE_DELETE = Object.freeze(["@executablemd/core#File.Delete"]);

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
    identity: coreIdentity("Fetch"),
    legacy: CORE_V1_FETCH,
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
    identity: coreIdentity("File:read"),
    legacy: CORE_V1_FILE_READ,
    definition,
    selfClosing: true,
  };
}

/**
 * Core's `<Json />`, admitted as trusted composition rather than as an effect.
 *
 * It is the one component every generated fragment may write whatever `allow`
 * selects, because rendering a value it already holds performs nothing: there
 * is no operation behind it to grant, so admitting it widens no authority. The
 * exact core definition, so a same-name replacement anywhere reaches nothing
 * here — purity is a property of this identity, never inferred from a name.
 *
 * Self-closing alone. `<Json>` refuses content of its own, and stating the form
 * here puts that refusal in preflight rather than inside the component after
 * earlier elements have run.
 */
export function pinnedJson(): GeneratedObservation {
  const definition = CORE_REGISTRY.get("Json")?.default?.definition;
  if (definition === undefined || definition.kind !== "function") {
    throw new GeneratedXmdError("core supplies no Json component to admit.");
  }
  return {
    name: "Json",
    identity: coreIdentity("Json"),
    definition,
    selfClosing: true,
  };
}

/**
 * The always-on trusted composition table.
 *
 * Core's own, and not a ceiling a host states: a host cannot remove Json from a
 * fragment's vocabulary by omitting it, and cannot add an effect to the table
 * by naming one. A trusted host that wants another pure component states its
 * exact definition and identity, which is a different act from this one.
 */
export function coreComposition(): readonly GeneratedObservation[] {
  return [pinnedJson()];
}

/**
 * One host-registered function observation component, by the exact definition
 * the host holds.
 */
export function pinnedComponent(
  name: string,
  identity: RetainedFragmentIdentity,
  definition: FunctionComponentDefinition,
  /**
   * The version-1 strings this host's own entry succeeds.
   *
   * The host's to state, because under version 1 this constructor took whatever
   * string the host chose and retained it verbatim. Core has nothing to assert
   * about which of those an entry is the successor of.
   */
  legacy?: readonly string[],
): GeneratedObservation {
  return { name, identity, definition, ...(legacy === undefined ? {} : { legacy }) };
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
  readonly identity: RetainedFragmentIdentity;
  readonly definition: FunctionComponentDefinition;
  /** The form authority underneath this entry's implementation, when it wraps one. */
  readonly dispatch?: unknown;
  /** The exact version-1 identity strings this entry states it succeeds. */
  readonly legacy?: readonly string[];
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
    identity: coreIdentity("File:write"),
    legacy: CORE_V1_FILE_WRITE,
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
 * invents no receipt beside it: a deletion renders nothing unless the fragment
 * authors output around it.
 */
export function pinnedFileDelete(): GeneratedMutation {
  const definition = CORE_REGISTRY.get("File.Delete")?.default?.definition;
  if (definition === undefined || definition.kind !== "function") {
    throw new GeneratedXmdError("core supplies no File.Delete component to admit.");
  }
  return {
    name: "File.Delete",
    identity: coreIdentity("File.Delete"),
    legacy: CORE_V1_FILE_DELETE,
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
  identity: RetainedFragmentIdentity,
  definition: FunctionComponentDefinition,
  form: GeneratedComponentForm,
  /** The version-1 strings this host's own entry succeeds, as the host states them. */
  legacy?: readonly string[],
): GeneratedMutation {
  return { name, identity, definition, form, ...(legacy === undefined ? {} : { legacy }) };
}

/** What a trusted host asks this evaluator to admit. */
export interface GeneratedXmdRequest {
  /** Which fragment this is. It names the durable admission record. */
  readonly id: string;
  /** The candidate source, exactly as it was generated. */
  readonly source: string;
  /**
   * The retained Workspace roots the host is willing to expose.
   *
   * Absent for a host that evaluates against no Workspace. An ordinary run is
   * one: its admitted effects address the Files provider its own execution
   * installed, and there is no immutable root history for a continuation to be
   * held to. A workflow run states both, and a continuation is then held to
   * that basis by membership.
   */
  readonly workspaceRoots?: readonly string[];
  /** The one root admitted effects address, for a host that has one. */
  readonly selectedRoot?: string;
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
 * A composition entry, a read entry and a mutation entry differ in what selects
 * them; everything the preflight and the retained policy do with them is the
 * same, and this is that shape.
 */
interface Entry {
  readonly name: string;
  readonly identity: RetainedFragmentIdentity;
  readonly definition: FunctionComponentDefinition;
  /** The form authority under this entry's definition, when a host stated one. */
  readonly dispatch?: unknown;
  readonly forms: readonly AuthoredForm[];
  /**
   * Which table admitted this entry.
   *
   * `composition` is not a `GeneratedEffectClass`: it names the always-on
   * trusted table that carries no effect operation and that `allow` does not
   * select between.
   */
  readonly effect: GeneratedEffectClass | "composition";
  /** The version-1 identity strings this entry states it succeeds. */
  readonly legacy?: readonly string[];
  readonly requests?: readonly GeneratedRequest[];
}

/** The pinned identity of one admitted entry, as the run retains it. */
interface RetainedEntry {
  readonly name: string;
  readonly identity: RetainedIdentity;
  readonly forms: readonly AuthoredForm[];
  /**
   * The version-1 strings this entry succeeds, on the *current* side only.
   *
   * Never read from a record and never written to one: a journal holds what was
   * admitted, and which older grants a current entry is willing to answer for
   * is a statement this run's host makes now. Reading it from the record would
   * let a retained value nominate its own successor.
   */
  readonly legacy?: readonly string[];
}

/** One element the fragment actually named, as the run retains it. */
interface RetainedInvocation {
  readonly name: string;
  readonly identity: RetainedIdentity;
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
  /**
   * The Workspace basis, or nothing for a host that evaluates against none.
   *
   * The distinction is itself a ceiling. A run admitted with no Workspace and
   * one admitted against a Workspace were granted different things, so a
   * continuation that acquired or lost one is asking for a different grant
   * rather than restating the same one.
   */
  readonly workspace?: { readonly roots: readonly string[]; readonly selectedRoot: string };
  readonly allowed: readonly RetainedEntry[];
  readonly requests: readonly FetchRequest[];
  /**
   * Which record shape this policy was read from, for a retained one.
   *
   * Absent on the policy a run states now, which is always current. A version-1
   * record was written before the trusted composition table existed, so it
   * names none, and holding it to entries that carry no effect operation would
   * refuse a continuation over a grant nobody widened.
   */
  readonly recordVersion?: 1 | 2;
  /** How many leading entries are composition, on the policy a run states now. */
  readonly composition?: number;
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
/**
 * The admission this invocation runs under, chosen by the form it was written
 * as.
 *
 * The engine's own issuance decides, not the caller: a wrapper can mint an
 * object carrying a `hasContent` method, and it cannot mint an issuance. An
 * element whose form the host admitted for no entry under this name reaches no
 * admission and is refused with the same diagnostic a mismatched invocation
 * always produced.
 */
function plannedForm(
  byForm: ReadonlyMap<AuthoredForm, Planned>,
  invocation: ComponentInvocation,
): Planned {
  const written = invocationForm(invocation);
  const planned = written === undefined ? undefined : byForm.get(written);
  if (planned === undefined) {
    throw new GeneratedXmdError(SHAPE);
  }
  return planned;
}

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
  /**
   * Every admission, by the name and the authored form it was made for.
   *
   * Two keys rather than one, and no consumption. Preflight reads every
   * alternative and every body once; the run enters one arm of an `<If>`, and
   * may enter one authored element many times or not at all — so a queue drawn
   * down per import has neither the cardinality nor the order the run has. A
   * name and a form select exactly one admission because the table says so:
   * `admitted()` refuses one name holding two definitions, and refuses one name
   * and form twice.
   */
  readonly #planned: Map<string, Map<AuthoredForm, Planned>>;
  readonly #imports = new CanonicalImports();
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
  readonly #protectedBodies: ProtectedBodies | undefined;
  readonly #invocations = new WeakMap<object, Map<AuthoredForm, Planned>>();

  /**
   * A generated fragment may invoke only what the host admitted for it, so
   * every import it makes is canonical execution's — including a name the
   * allowlist does not hold, which is refused rather than answered.
   */
  // deno-lint-ignore no-unused-vars
  closes(_name: string): boolean {
    return true;
  }

  constructor(named: readonly Planned[], protectedBodies?: ProtectedBodies) {
    const planned = new Map<string, Map<AuthoredForm, Planned>>();
    for (const invocation of named) {
      const byForm = planned.get(invocation.name) ?? new Map<AuthoredForm, Planned>();
      byForm.set(invocation.form, invocation);
      planned.set(invocation.name, byForm);
    }
    this.#planned = planned;
    this.#protectedBodies = protectedBodies;
  }

  /** The answer canonical execution produces for this name. */
  issue(name: string): ImportedDefinition {
    const byForm = this.#planned.get(name);
    if (byForm === undefined) {
      throw new GeneratedXmdError(CONSTRUCT.component);
    }
    // Every entry under one name shares one definition — the table refuses two
    // — so the implementation is the same whichever form the element turns out
    // to have been written as. Which *admission* it runs under is decided per
    // invocation below, from the engine's own account of the form.
    const [first] = [...byForm.values()];
    if (first === undefined) {
      throw new GeneratedXmdError(CONSTRUCT.component);
    }
    const entry = first.entry;
    const copy = retain(entry.definition);
    if (copy === undefined || copy.kind !== "function" || typeof copy.fn !== "function") {
      throw new GeneratedXmdError(CONSTRUCT.component);
    }
    const implementation = copy.fn;
    // The wrapper below is the answer to the import; the dispatcher underneath
    // it is the form authority. Recording the dispatcher is what binds the
    // invocation to it — a wrapper that collected results is trusted host code
    // and takes no part in deciding which form-specific body runs.

    const admitted: FunctionComponentDefinition = {
      ...copy,
      *fn(props, invocation) {
        // Per invocation, because one authored element may be entered many
        // times and two elements of one name may be written in two forms. The
        // admission is selected by the form the engine issued for *this*
        // element, and an element whose form the host admitted for no entry is
        // refused here exactly as it always was.
        holdForm(plannedForm(byForm, invocation).form, invocation);
        return yield* implementation(props, invocation);
      },
    };
    this.#invocations.set(admitted.fn, byForm);
    // The wrapper above is the answer to the import; the dispatcher underneath
    // it is the form authority. Remembered by name so `authorize` can record it
    // against core's own copy — the object expansion actually invokes — because
    // a trusted collection wrapper takes no part in deciding which
    // form-specific body runs. A host that admitted a definition of its own
    // states that authority explicitly, because an entry whose implementation
    // is core's guard around somebody else's would otherwise offer the guard,
    // and a form authority read off the guard selects no body at all.
    this.#dispatchers.set(name, entry.dispatch ?? implementation);
    this.#protectedBodies?.project(implementation, admitted.fn);
    return this.#imports.issue(name, admitted);
  }

  // Protected dispatch bypasses the public wrapper function, so collection and
  // form checking surround canonical dispatch rather than that function alone.
  *invoke(
    fn: unknown,
    invocation: ComponentInvocation,
    body: Operation<unknown>,
  ): Operation<unknown> {
    const byForm = typeof fn === "function" ? this.#invocations.get(fn) : undefined;
    if (byForm === undefined) {
      throw new GeneratedXmdError(CONSTRUCT.component);
    }
    holdForm(plannedForm(byForm, invocation).form, invocation);
    return yield* body;
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
  // Before either effect table and under every selection: composition is not a
  // class `allow` chooses between, so its entries are in the policy the same
  // way whatever the caller asked for, and in one canonical position.
  for (const composition of coreComposition()) {
    entries.push({
      name: composition.name,
      identity: composition.identity,
      definition: composition.definition,
      forms: composition.selfClosing === true ? ["self-closing"] : AUTHORED_FORMS,
      effect: "composition",
    });
  }
  if (allow.includes("read")) {
    if (request.observations.length === 0) {
      throw new GeneratedXmdError("a generated-XMD allowlist selected `read` with no read table.");
    }
    for (const observation of request.observations) {
      entries.push({
        name: observation.name,
        identity: observation.identity,
        definition: observation.definition,
        ...(observation.dispatch === undefined ? {} : { dispatch: observation.dispatch }),
        // An entry the host constrained to its self-closing spelling admits
        // that one; an unconstrained one admits both, as it always has.
        forms: observation.selfClosing === true ? ["self-closing"] : AUTHORED_FORMS,
        effect: "read",
        ...(observation.legacy === undefined ? {} : { legacy: observation.legacy }),
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
        ...(mutation.dispatch === undefined ? {} : { dispatch: mutation.dispatch }),
        forms: authoredForms(mutation.form),
        effect: "write",
        ...(mutation.legacy === undefined ? {} : { legacy: mutation.legacy }),
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
    ceilings.set(identityKey(entry.identity), normalized);
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
    allowed.push({
      name: entry.name,
      identity: entry.identity,
      forms: entry.forms,
      // Carried on the current policy so a version-1 record can be reconciled
      // against it, and dropped by `policyRecord` so nothing this run writes
      // holds it.
      ...(entry.legacy === undefined ? {} : { legacy: entry.legacy }),
    });
    requests.push(...(ceilings.get(identityKey(entry.identity)) ?? []));
  }
  const workspace = workspaceBasis(request);
  return {
    allow: [...allow],
    ...(workspace === undefined ? {} : { workspace }),
    allowed,
    requests,
    composition: entries.filter((entry) => entry.effect === "composition").length,
  };
}

/**
 * The Workspace basis this request states, or nothing.
 *
 * Both terms or neither: a host stating roots without the root its effects
 * address, or the reverse, has stated half a basis, and half a ceiling is not
 * one to admit a fragment under.
 */
function workspaceBasis(
  request: GeneratedXmdRequest,
): { roots: readonly string[]; selectedRoot: string } | undefined {
  const { workspaceRoots, selectedRoot } = request;
  if (workspaceRoots === undefined && selectedRoot === undefined) {
    return undefined;
  }
  if (workspaceRoots === undefined || selectedRoot === undefined) {
    throw new GeneratedXmdError(
      "a generated-XMD host stated half a Workspace basis. A host evaluates against a Workspace " +
        "or against none, and the roots and the selected root are one statement.",
    );
  }
  // Validated here, as the host's own error, rather than compared later against
  // a live basis and appearing to hold: a basis with no roots, a repeated root,
  // or a selected root nothing retains is not a stricter grant than a coherent
  // one — there is nothing for a continuation to be held to at all.
  const roots = [...workspaceRoots];
  if (roots.length === 0 || roots.some((root) => root.length === 0)) {
    throw new GeneratedXmdError("a generated-XMD host stated a Workspace basis retaining no root.");
  }
  if (new Set(roots).size !== roots.length) {
    throw new GeneratedXmdError("a generated-XMD host stated one retained Workspace root twice.");
  }
  if (!roots.includes(selectedRoot)) {
    throw new GeneratedXmdError(
      "a generated-XMD host selected a Workspace root it does not retain.",
    );
  }
  return { roots, selectedRoot };
}

/**
 * The policy as journal data, in the closed version-2 shape.
 *
 * Version 1 is the untagged #369 record, whose `roots` and `selectedRoot` sat
 * at the top level and were mandatory. Version 2 tags itself and carries the
 * Workspace basis as one optional member, because an ordinary host has none —
 * and telling the two apart matters: a reader that treated a missing basis as
 * an empty one would compare a Workspace-less admission equal to a Workspace
 * admission that had lost every root.
 */
function policyRecord(policy: Policy): JsonObject {
  return {
    version: RECORD_VERSION,
    allow: [...policy.allow],
    ...(policy.workspace === undefined
      ? {}
      : {
          workspace: {
            roots: [...policy.workspace.roots],
            selectedRoot: policy.workspace.selectedRoot,
          },
        }),
    allowed: policy.allowed.map((entry) => ({
      name: entry.name,
      identity: retainedIdentityRecord(entry.identity),
      forms: [...entry.forms],
    })),
    requests: policy.requests.map(requestRecord),
  };
}

/**
 * One identity as journal data.
 *
 * Total over both retained shapes, so a policy read back is written back as the
 * shape it was read as. What this run *states* is always the version-2 record —
 * the version-1 arm exists because a record read from an older journal is still
 * a policy, not because this build writes one.
 *
 * Distinct from the one-line spelling a *diagnostic* uses
 * (`components/import-authority.ts`): that one is for a reader, and this one is
 * what a continuation compares, so they are named apart rather than allowed to
 * drift into each other.
 */
function retainedIdentityRecord(identity: RetainedIdentity): Json {
  if ("legacy" in identity) {
    return identity.legacy;
  }
  return {
    kind: identity.kind,
    origin: identity.origin,
    key: identity.key,
    revision: identity.revision,
  };
}

/**
 * The policy a record holds, parsed rather than trusted.
 *
 * A history is durable input: a record somebody else wrote is not a policy
 * because it happens to have the right keys, and a policy this version cannot
 * read is refused rather than treated as matching.
 */
/**
 * Whether an object carries exactly these members and nothing else.
 *
 * Every retained shape below is closed, which is a stronger claim than "the
 * members it needs are present and well-typed". A record carrying an extra
 * member was written by something this build does not know the rules of, and
 * reading the members it recognizes would be admitting a grant on terms it
 * never saw. Destructuring alone cannot say that, because a destructure is
 * blind to what it did not name.
 */
function exactly(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (!required.every((member) => Object.hasOwn(value, member))) {
    return false;
  }
  const known = new Set([...required, ...optional]);
  return Object.keys(value).every((member) => known.has(member));
}

/**
 * The policy a record holds, in whichever closed shape its version defines.
 *
 * The two versions are exact and disjoint. Version 1 is the untagged #369
 * record: no version member, the Workspace basis as two mandatory top-level
 * ones. Version 2 tags itself, carries the basis as one optional member, and
 * has no legacy root fields at all — so a record mixing the two, or tagging
 * itself with a version this build does not have, is refused rather than read
 * as whichever it most resembles.
 */
function readPolicy(value: Json): Policy | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const tagged = Object.hasOwn(value, "version");
  if (tagged) {
    if (value.version !== RECORD_VERSION) {
      return undefined;
    }
    if (!exactly(value, ["version", "allow", "allowed", "requests"], ["workspace"])) {
      return undefined;
    }
    const workspace = Object.hasOwn(value, "workspace")
      ? readWorkspace(value.workspace)
      : undefined;
    if (workspace === MALFORMED) {
      return undefined;
    }
    return readPolicyTerms(value, workspace, 2);
  }
  if (!exactly(value, ["allow", "roots", "selectedRoot", "allowed", "requests"])) {
    return undefined;
  }
  // A version-1 record always evaluated against a Workspace, so its basis is
  // mandatory and reads through the same validation a version-2 basis does.
  const workspace = readWorkspace({ roots: value.roots, selectedRoot: value.selectedRoot });
  if (workspace === MALFORMED || workspace === undefined) {
    return undefined;
  }
  return readPolicyTerms(value, workspace, 1);
}

/** The terms both versions share, read closed. */
function readPolicyTerms(
  value: JsonObject,
  workspace: { roots: readonly string[]; selectedRoot: string } | undefined,
  version: 1 | 2,
): Policy | undefined {
  const classes = readClasses(value.allow);
  const identities = readAllowed(value.allowed, version);
  const requests = readRequests(value.requests);
  if (classes === undefined || identities === undefined || requests === undefined) {
    return undefined;
  }
  return {
    allow: classes,
    ...(workspace === undefined ? {} : { workspace }),
    allowed: identities,
    requests,
    recordVersion: version,
  };
}

/** A record this version cannot read, told apart from one that holds nothing. */
const MALFORMED = Symbol("malformed");

/**
 * One Workspace basis, validated rather than merely well-typed.
 *
 * A basis with no roots, a repeated root, or a selected root the run does not
 * retain is not a stricter grant than one without those faults — it is not a
 * grant at all, because there is nothing coherent for a continuation to be held
 * to. So it is refused here, before the admission, rather than compared later
 * against a live basis and appearing to hold.
 */
function readWorkspace(
  value: Json | undefined,
): { roots: readonly string[]; selectedRoot: string } | undefined | typeof MALFORMED {
  if (!isJsonObject(value) || !exactly(value, ["roots", "selectedRoot"])) {
    return MALFORMED;
  }
  const roots = readRoots(value.roots);
  const { selectedRoot } = value;
  if (roots === undefined || typeof selectedRoot !== "string") {
    return MALFORMED;
  }
  return roots.includes(selectedRoot) ? { roots, selectedRoot } : MALFORMED;
}

/** The retained roots, which are a non-empty set rather than a list. */
function readRoots(value: Json | undefined): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const roots: string[] = [];
  for (const root of value) {
    if (typeof root !== "string" || root.length === 0 || roots.includes(root)) {
      return undefined;
    }
    roots.push(root);
  }
  return roots;
}

/**
 * The retained requests, read closed.
 *
 * `parseRequestRecord()` is the wrong reader here: it ignores members it does
 * not know and treats a malformed `timeout` as an absent one, so a retained
 * ceiling could compare equal to a live one it does not describe.
 */
function readRequests(value: Json): FetchRequest[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const requests: FetchRequest[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || !exactly(entry, ["url", "method", "headers"], ["timeout"])) {
      return undefined;
    }
    const { url, method, headers, timeout } = entry;
    if (typeof url !== "string" || typeof method !== "string" || !isJsonObject(headers)) {
      return undefined;
    }
    if (Object.hasOwn(entry, "timeout") && typeof timeout !== "number") {
      return undefined;
    }
    const named: Record<string, string> = {};
    for (const [header, value] of Object.entries(headers)) {
      if (typeof value !== "string") {
        return undefined;
      }
      named[header] = value;
    }
    requests.push({
      url,
      method,
      headers: named,
      ...(typeof timeout === "number" ? { timeout } : {}),
    });
  }
  return requests;
}

/** The selected classes, which are a non-empty set in canonical order. */
function readClasses(value: Json): GeneratedEffectClass[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const classes: GeneratedEffectClass[] = [];
  for (const effect of value) {
    const parsed = EFFECT_CLASSES.find((known) => known === effect);
    if (parsed === undefined || classes.includes(parsed)) {
      return undefined;
    }
    classes.push(parsed);
  }
  return sameStrings(
    classes,
    EFFECT_CLASSES.filter((known) => classes.includes(known)),
  )
    ? classes
    : undefined;
}

/** The forms one entry is admitted for: a non-empty set, canonically ordered. */
function readForms(value: Json): AuthoredForm[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const forms: AuthoredForm[] = [];
  for (const form of value) {
    const parsed = AUTHORED_FORMS.find((known) => known === form);
    if (parsed === undefined || forms.includes(parsed)) {
      return undefined;
    }
    forms.push(parsed);
  }
  return sameStrings(
    forms,
    AUTHORED_FORMS.filter((known) => forms.includes(known)),
  )
    ? forms
    : undefined;
}

/**
 * One retained identity, in whichever shape its version defines.
 *
 * The two are exact and disjoint. Version 1 is a string and nothing else.
 * Version 2 is the closed tagged record and nothing else: a string, a missing
 * member, an extra member, an unknown kind and a non-string member are each
 * refused rather than read as whichever shape the value most resembles.
 */
function readIdentity(value: Json | undefined, version: 1 | 2): RetainedIdentity | undefined {
  if (version === 1) {
    return typeof value === "string" ? { legacy: value } : undefined;
  }
  if (!isJsonObject(value) || !exactly(value, ["kind", "origin", "key", "revision"])) {
    return undefined;
  }
  const { origin, key, revision } = value;
  const kind = IDENTITY_KINDS.find((known) => known === value.kind);
  if (
    kind === undefined ||
    typeof origin !== "string" ||
    typeof key !== "string" ||
    typeof revision !== "string"
  ) {
    return undefined;
  }
  return { kind, origin, key, revision };
}

function readAllowed(value: Json, version: 1 | 2): RetainedEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const identities: RetainedEntry[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || !exactly(entry, ["name", "identity", "forms"])) {
      return undefined;
    }
    const { name } = entry;
    const identity = readIdentity(entry.identity, version);
    const forms = readForms(entry.forms);
    if (typeof name !== "string" || identity === undefined || forms === undefined) {
      return undefined;
    }
    identities.push({ name, identity, forms });
  }
  return identities;
}

function readNamed(value: Json, version: 1 | 2): RetainedInvocation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const named: RetainedInvocation[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || !exactly(entry, ["name", "identity", "form"])) {
      return undefined;
    }
    const { name } = entry;
    const identity = readIdentity(entry.identity, version);
    const form = AUTHORED_FORMS.find((known) => known === entry.form);
    if (typeof name !== "string" || identity === undefined || form === undefined) {
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
  if (!workspaceHolds(retained.workspace, current.workspace)) {
    return false;
  }
  if (!sameStrings(retained.allow, current.allow)) {
    return false;
  }
  // A version-1 record predates the trusted composition table, so it is
  // reconciled against the effect entries alone. Composition grants nothing —
  // its entries carry no effect operation — so a continuation held to the
  // remainder is held to exactly the authority it was admitted under.
  const stated =
    retained.recordVersion === 1
      ? current.allowed.slice(current.composition ?? 0)
      : current.allowed;
  if (retained.allowed.length !== stated.length) {
    return false;
  }
  const replaced = retained.allowed.some((entry, index) => {
    const here = stated[index];
    return (
      here === undefined ||
      here.name !== entry.name ||
      // The retained side is what was granted; the current side is the entry
      // asking to answer for it, and only that side states version-1 aliases.
      !sameIdentity(entry.identity, here) ||
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

/**
 * Whether a resumed run still holds the Workspace basis it was admitted over.
 *
 * Absent on both sides is a host that evaluates against no Workspace, and two
 * of those hold each other. Present on one side only is a run that acquired or
 * lost a Workspace between the admission and the resume, which is a different
 * grant rather than the same one restated.
 *
 * Present on both compares by membership, because the set legitimately grows:
 * every committed mutation retains another immutable root and advances the
 * authoritative current one. So each admission root and the admission's
 * selected root must still be retained, and the root the run now stands on must
 * be a retained one — while additional roots change nothing this admission was
 * granted under.
 */
function workspaceHolds(retained: Policy["workspace"], current: Policy["workspace"]): boolean {
  if (retained === undefined || current === undefined) {
    return retained === current;
  }
  const held = new Set(current.roots);
  if (!retained.roots.every((root) => held.has(root))) {
    return false;
  }
  return held.has(retained.selectedRoot) && held.has(current.selectedRoot);
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
  // A generated fragment starts with no bindings: it imports none from the
  // document that admitted it, and exports none back to it.
  yield* walk(segments, table, ceilings, named, new Set<string>());
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

/**
 * Whole-fragment preflight, over the scope the fragment will actually have.
 *
 * `scope` is the set of bindings in effect where the next segment is written.
 * A component's `as` joins it *after* that component, so an expression cannot
 * name the binding its own element is producing, and the names a component's
 * children introduce stay in the child set the recursion passes down — the
 * fragment's later siblings never see them, exactly as expansion's
 * environments never see them. Preflight and expansion therefore refuse the
 * same identifier, and a fragment cannot reach an effect by naming a binding
 * that is only visible after one.
 */
function* walk(
  segments: readonly Segment[],
  table: ReadonlyMap<string, Entry[]>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
  named: Planned[],
  scope: Set<string>,
  lexical: Lexical = ROOT_LEXICAL,
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
        // Structural names are language, not authority, so they are decided
        // before the admitted table is consulted — exactly as expansion decides
        // them before it resolves a component. A construct that reached the
        // table lookup would be refused as a component the host withheld, which
        // is a different and misleading thing to tell a candidate.
        if (RESERVED_STRUCTURAL.has(segment.name)) {
          yield* structural(segment, table, ceilings, named, scope, lexical);
          break;
        }
        const entries = table.get(segment.name);
        if (entries === undefined) {
          throw new Refusal("component");
        }
        // Data over the bindings that exist here, and refused as a class: the
        // grammar's own diagnostic names the offending form, and a refusal of
        // generated text may not carry the text back out (see `Refusal`).
        //
        // Both readings of a brace, because the scanner splits them: a brace it
        // could read as JSON becomes a resolved prop and the text it read is
        // kept beside it, while anything else stays as expression text. Only
        // the second reaches expansion, so validating it alone would admit
        // whatever the first silently rewrote — `{1e999}`, which JSON has no
        // number for, is resolved to `null` rather than refused. The authored
        // text is what the fragment actually stated, so it is what preflight
        // holds the fragment to.
        const stated = [
          ...Object.values(segment.expressions),
          ...Object.values(segment.authoredExpressions ?? {}),
        ];
        for (const expression of stated) {
          try {
            validateDataExpression(expression, scope);
          } catch {
            throw new Refusal("expression");
          }
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
          const ceiling = ceilings.get(identityKey(entry.identity)) ?? [];
          const candidate = yield* admitCandidateRequest(segment.props);
          if (!ceiling.some((allowed) => sameRequest(allowed, candidate))) {
            throw new Refusal("request");
          }
        }
        named.push({ name: entry.name, identity: entry.identity, form, entry });
        // The children see this element's bindings but not its own `as`, and
        // nothing they bind escapes back to its siblings. They are a component
        // body rather than a transparent region, so the lexical facts reset:
        // a `<Break>` written in a component's own body cannot break a loop
        // that encloses the invocation.
        yield* walk(segment.children, table, ceilings, named, new Set(scope), ROOT_LEXICAL);
        // After the element, because a component's result does not exist until
        // it has run: `<File as="x" />` beside `<Json value={x} />` is ordered,
        // and `<Json value={x} as="x" />` names nothing.
        if ("as" in segment.props) {
          const bound = capturedBinding(segment.props.as);
          if (bound === undefined) {
            throw new Refusal("binding");
          }
          scope.add(bound);
        }
        break;
      }
      default: {
        throw new Refusal("construct");
      }
    }
  }
}

/**
 * The lexical facts a construct is decided against.
 *
 * Only what a construct's own rule actually consults. `<Break>` is legal
 * because a `<Loop>` encloses it lexically — not because one is running — so
 * that is a property of where it was written and travels down the walk.
 */
interface Lexical {
  readonly insideLoop: boolean;
}

/**
 * What encloses the fragment's own top level.
 *
 * A generated fragment is not a component body and not a value body: there is
 * no caller content for `<Content>` to claim, no output region for `<Output>`
 * to select, and no value body for `<Return>` to answer. It is also not inside
 * a loop.
 */
const ROOT_LEXICAL: Lexical = Object.freeze({ insideLoop: false });

/** A typed empty table, so an absent one reads as no expressions rather than as `{}`. */
const NO_EXPRESSIONS: Record<string, string> = {};

/**
 * Every expression prop one element states, held to the fragment's own scope.
 *
 * Both readings of a brace, because the scanner splits them: a brace it could
 * read as JSON becomes a resolved prop with the original token kept beside it,
 * while anything else stays as expression text. Validating only the second
 * would admit whatever the first silently rewrote — `{1e999}`, which JSON has
 * no number for, resolves to `null` rather than refusing.
 */
function stated(segment: ComponentElement, scope: ReadonlySet<string>): void {
  const expressions = [
    ...Object.values(segment.expressions),
    ...Object.values(segment.authoredExpressions ?? NO_EXPRESSIONS),
  ];
  for (const expression of expressions) {
    try {
      validateDataExpression(expression, scope);
    } catch {
      throw new Refusal("expression");
    }
  }
}

/** The structural names that only their own parent may consume. */
const CONSUMED_BY_PARENT: ReadonlySet<string> = new Set(["Else", "Case", "Answer"]);

/**
 * The structural names the generated root supplies no context for.
 *
 * Each of these is ordinary language wherever its context exists, and a
 * fragment is simply not that place. Refused as a structural mistake rather
 * than as withheld authority, because nothing about the host's tables would
 * make one of them work.
 */
const NO_GENERATED_CONTEXT: ReadonlySet<string> = new Set(["Content", "Output", "Return"]);

/**
 * One structural construct, held to the ordinary source rules.
 *
 * The rules come from `structural-rules.ts` — the same module ordinary
 * validation and expansion read — so a construct means one thing wherever it is
 * written. What is different here is only *when*: every branch, every `<Case>`,
 * every body and every path the run will not take is walked before the
 * fragment's first effect, so a prohibited component in an untaken branch
 * refuses the whole fragment rather than being discovered after an earlier read
 * already happened.
 *
 * What stays at runtime stays at runtime. A condition, a matcher, a `max` an
 * expression computes and a read that fails are values, and preflight proves
 * the source and the authority of every possible path without fabricating one.
 */
function* structural(
  segment: ComponentElement,
  table: ReadonlyMap<string, Entry[]>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
  named: Planned[],
  scope: Set<string>,
  lexical: Lexical,
): Operation<void> {
  const name = segment.name;
  // Consumed by the construct that gives them meaning, so reaching one here is
  // an element written where that construct is not.
  if (CONSUMED_BY_PARENT.has(name) || NO_GENERATED_CONTEXT.has(name)) {
    throw new Refusal("structure");
  }

  // The construct's own props, over the bindings in effect where it was
  // written.
  stated(segment, scope);

  if (name === "Break") {
    refuseStructure(breakViolations(segment, lexical.insideLoop));
    return;
  }

  if (name === "If") {
    refuseStructure(ifPropsViolation(segment));
    if (!("condition" in segment.props) && !("condition" in segment.expressions)) {
      refuseStructure(ifConditionViolation(segment));
    }
    const structure = ifStructure(segment);
    refuseStructure(structure.violations);
    // Both arms, whichever the condition would select, and each from the same
    // incoming bindings. A prohibited component in the arm this run never
    // enters still refuses the whole fragment.
    yield* alternatives(
      [{ body: structure.whenTrue }, { body: structure.whenFalse }],
      table,
      ceilings,
      named,
      scope,
      lexical,
    );
    return;
  }

  if (name === "Switch") {
    const structure = switchStructure(segment);
    refuseStructure(structure.violations);
    const branches = [...structure.matching, ...(structure.fallback ? [structure.fallback] : [])];
    // Each branch is an alternative to the others, so each is checked from the
    // bindings that reach the `<Switch>` — including its matcher, which is the
    // branch's own expression and is validated whether or not the comparison
    // would ever reach it.
    yield* alternatives(
      branches.map((branch) => ({ matcher: branch.element, body: branch.element.children })),
      table,
      ceilings,
      named,
      scope,
      lexical,
    );
    return;
  }

  if (name === "Loop") {
    refuseStructure(loopViolations(segment));
    // Inside for the body alone: a `<Break>` after the loop is as stray as one
    // written where no loop ever was.
    yield* transparent(segment.children, table, ceilings, named, scope, {
      ...lexical,
      insideLoop: true,
    });
    return;
  }

  if (name === "PrintErrors") {
    refuseStructure(printErrorsViolations(segment));
    yield* transparent(segment.children, table, ceilings, named, scope, lexical);
    return;
  }

  if (name === "Answers") {
    refuseStructure(answersViolations(segment));
    // Its `<Answer>` children are the matchers; everything else is the region
    // whose elicitations they answer. Both are walked — the matchers because
    // which one is chosen is a runtime question, and the body because it is
    // ordinary segments.
    const body: Segment[] = [];
    for (const child of segment.children) {
      if (child.type === "component" && child.name === "Answer") {
        refuseStructure(answerViolations(child));
        stated(child, scope);
        yield* transparent(child.children, table, ceilings, named, scope, lexical);
        continue;
      }
      if (!isBlankText(child)) {
        body.push(child);
      }
    }
    yield* transparent(body, table, ceilings, named, scope, lexical);
    return;
  }

  if (name === "Let") {
    refuseStructure(letViolations(segment));
    yield* transparent(segment.children, table, ceilings, named, scope, lexical);
    // After its own body, like a component's `as`: a `<Let>` cannot name the
    // binding it is producing.
    const bound = letBindingName(segment);
    if (bound === undefined) {
      throw new Refusal("structure");
    }
    scope.add(bound);
    return;
  }

  if (name === "Each") {
    refuseStructure(eachViolations(segment));
    const item = eachItemBinding(segment);
    if (item === undefined) {
      throw new Refusal("structure");
    }
    // A fresh scope, seeded with what encloses the construct and the item this
    // iteration names. Nothing the body binds survives it: the body runs once
    // per item and may run no times at all, so a binding made inside it is not
    // something a later sibling can be promised. What the construct offers its
    // caller is the one capture it was asked for.
    const body = new Set(scope);
    body.add(item);
    yield* walk(segment.children, table, ceilings, named, body, lexical);
    const capture = eachCaptureBinding(segment);
    if (capture !== undefined) {
      scope.add(capture);
    }
    return;
  }

  // Every structural name is either handled above or refused above, and
  // `RESERVED_STRUCTURAL` is derived from the declarations, so a name added
  // there without a rule here arrives as an ordinary structural refusal rather
  // than as silently admitted syntax.
  throw new Refusal("structure");
}

/** One of several regions the run chooses between, with its own matcher. */
interface Alternative {
  /** The element carrying the branch's own expression, when it has one. */
  readonly matcher?: ComponentElement;
  readonly body: readonly Segment[];
}

/**
 * Regions the run chooses *between*, checked from one incoming snapshot.
 *
 * The alternatives of an `<If>` or a `<Switch>` are mutually exclusive, so none
 * of them may be checked against bindings another one produced: doing that in
 * source order would let the second arm read a binding only the first makes,
 * and admit a fragment whose second arm cannot run. Each is therefore walked
 * from the bindings that reach the construct.
 *
 * What they may all contribute is what comes *after*. Once every alternative
 * has been proved, the union of what they produce becomes visible past the
 * construct — the accepted runtime-dependent behavior, where reading a binding
 * only one alternative makes fails when the value is needed rather than at
 * preflight.
 */
function* alternatives(
  branches: readonly Alternative[],
  table: ReadonlyMap<string, Entry[]>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
  named: Planned[],
  scope: Set<string>,
  lexical: Lexical,
): Operation<void> {
  const incoming: ReadonlySet<string> = new Set(scope);
  const outgoing = new Set<string>();
  for (const branch of branches) {
    if (branch.matcher !== undefined) {
      stated(branch.matcher, incoming);
    }
    const region = new Set(incoming);
    yield* walk(branch.body, table, ceilings, named, region, lexical);
    for (const bound of region) {
      if (!incoming.has(bound)) {
        outgoing.add(bound);
      }
    }
  }
  for (const bound of outgoing) {
    scope.add(bound);
  }
}

/**
 * A region that runs in the environment enclosing it.
 *
 * `<If>` arms, `<Case>` bodies, `<Loop>` and `<PrintErrors>` bodies and a
 * `<Let>` body are transparent: expansion expands them against the same live
 * environment, so a binding one of them produces is visible after the construct
 * and preflight says so too. Which arm actually ran is a runtime question, and
 * a fragment that reads a binding only one arm produces fails where it always
 * would — when the value is needed.
 */
function* transparent(
  segments: readonly Segment[],
  table: ReadonlyMap<string, Entry[]>,
  ceilings: ReadonlyMap<string, FetchRequest[]>,
  named: Planned[],
  scope: Set<string>,
  lexical: Lexical,
): Operation<void> {
  const region = new Set(scope);
  yield* walk(segments, table, ceilings, named, region, lexical);
  for (const bound of region) {
    scope.add(bound);
  }
}

/** Refuse when the ordinary source rules found anything wrong. */
function refuseStructure(
  found: StructuralViolation | readonly StructuralViolation[] | undefined,
): void {
  if (found === undefined) {
    return;
  }
  if (Array.isArray(found) ? found.length > 0 : true) {
    throw new Refusal("structure");
  }
}

const GENERATED_XMD = "generated_xmd";

/**
 * The record shape new executions write.
 *
 * Version 1 is the untagged #369 record and stays readable: a run suspended
 * before this build resumes under exactly the ceilings it was admitted with.
 * Version 2 tags itself, which is what lets an untagged record be recognized as
 * the older shape rather than guessed at, and carries the Workspace basis as
 * one optional member because an ordinary host has none.
 */
const RECORD_VERSION = 2;

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
      version: RECORD_VERSION,
      decision: "admitted",
      source,
      named: named.map((entry) => ({
        name: entry.name,
        identity: retainedIdentityRecord(entry.identity),
        form: entry.form,
      })),
      policy: policyRecord(policy),
    });
  } catch (error) {
    if (error instanceof Refusal) {
      return parseJson({
        version: RECORD_VERSION,
        decision: "refused",
        construct: error.construct,
      });
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
  // Tagged at the result level as well as inside the policy, and the two must
  // agree: a record whose result claims one version and whose policy claims
  // another describes no shape this build has.
  const tagged = Object.hasOwn(value, "version");
  if (tagged && value.version !== RECORD_VERSION) {
    return undefined;
  }
  const version = tagged ? ["version"] : [];
  const { decision } = value;
  if (decision === "refused") {
    if (!exactly(value, [...version, "decision", "construct"])) {
      return undefined;
    }
    const { construct } = value;
    return typeof construct === "string" && isConstruct(construct)
      ? { decision, construct }
      : undefined;
  }
  if (decision !== "admitted") {
    return undefined;
  }
  if (!exactly(value, [...version, "decision", "source", "named", "policy"])) {
    return undefined;
  }
  const { source } = value;
  if (typeof source !== "string") {
    return undefined;
  }
  const invocations = readNamed(value.named, tagged ? 2 : 1);
  const retained = readPolicy(value.policy);
  if (invocations === undefined || retained === undefined) {
    return undefined;
  }
  // The policy's own version has to be the one the result claimed. A tagged
  // result holding an untagged policy, or the reverse, is two shapes at once.
  const policyTagged = isJsonObject(value.policy) && Object.hasOwn(value.policy, "version");
  if (policyTagged !== tagged) {
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
  protectedBodies: ProtectedBodies | undefined,
  syntax: SyntaxReference | undefined,
): Operation<string> {
  return scoped(function* () {
    yield* ErrorMode.set("throw");
    // Every expression this expansion resolves — an ordinary prop and a
    // declared capture alike — reads the declarative grammar rather than the
    // trusted-document evaluator. Set on this scope, so it ends with the
    // fragment and reaches nothing the document expands afterwards.
    yield* GeneratedDataExpressions.set(true);
    const authority = new GeneratedImportAuthority(named, protectedBodies);
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
      // No enclosing identity table: protected invocation domains travel only
      // through the narrowed route. Import and form selection belong to this
      // fragment, while the reference preserves the admitting site's documentation.
      {
        imports: authority,
        forms: authority.forms,
        invoke: (fn, invocation, body) => authority.invoke(fn, invocation, body),
        ...(protectedBodies === undefined ? {} : { protectedBodies }),
        ...(syntax === undefined ? {} : { syntax }),
      },
      // A generated fragment is the engine's own text, so it owns no value body
      // and a <Return> written into it satisfies no declaration.
      undefined,
    );
    return renderSegments(expanded);
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
 * the same sequence and restores the admission and every effect that already
 * committed rather than performing them again.
 *
 * What it answers with is the fragment's rendered text.
 */
export function evaluateGeneratedXmd(request: GeneratedXmdRequest): Operation<string> {
  return evaluateProtectedGeneratedXmd(request, undefined, undefined);
}

/** Canonical Evaluate's internal handoff; absent from the public host surface. */
export function* evaluateProtectedGeneratedXmd(
  request: GeneratedXmdRequest,
  protectedBodies: ProtectedBodies | undefined,
  syntax: SyntaxReference | undefined,
): Operation<string> {
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
    // The one failure in this function a candidate can act on: its own text was
    // wrong. Everything below — a moved ceiling, changed source, an unreadable
    // record — is this run's history rather than the candidate's mistake, and
    // is deliberately left unmarked so a trusted loop cannot retry it.
    throw markGeneratedRequestRefusal(
      new GeneratedXmdError(CONSTRUCT[decided.construct]),
      CONSTRUCT[decided.construct],
    );
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
  // And for the exact text, on the same terms as the ceilings. An admission is
  // a decision about one fragment; a caller now holding a different one is
  // asking for a decision that was never made, so it refuses here rather than
  // quietly expanding the retained copy in its place.
  if (decided.source !== request.source) {
    throw new GeneratedXmdError(STALE_TEXT);
  }

  // The retained source is what expands, so a continuation runs exactly the
  // bytes this run admitted rather than a caller's copy of them.
  const restored = yield* preflight(decided.source, table, ceilings);
  return yield* expand(request.id, restored.segments, restored.named, protectedBodies, syntax);
}
