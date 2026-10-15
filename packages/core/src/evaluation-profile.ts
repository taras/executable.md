/**
 * What a generated fragment may do here, derived from the host's selection and
 * from the declarations that own the implementations.
 *
 * `<Evaluate>` is a public component: any author may write it, and canonical
 * core owns what it means. That settles *which implementation runs* and nothing
 * else — protection grants no permission. Canonical `<Evaluate>` admits only
 * the entries captured here, selected by `allow`. So the ceiling is established
 * before public execution policy, from two inputs neither of which is a
 * contract table:
 *
 * - the host's `Component.generated` selection, which names components and
 *   authored forms (`generated-selection.ts`); and
 * - each selected name's own resolved definition, which states the identity and
 *   the effect every offered spelling runs under
 *   (`components/generated-metadata.ts`).
 *
 * A host therefore chooses *what a fragment may write* and never *what writing
 * it grants*. There are no host-stated schemas, descriptions, identities,
 * dispatchers or operations, and no second filesystem: an admitted name runs
 * the implementation canonical resolution answered with, performing its
 * ordinary operation through contextual `API.Files` and `API.Fetch` under the
 * provider installed where the fragment runs and the effective `Permissions` of
 * the consuming scope.
 *
 * ## One per execution, captured once
 *
 * Normal contextual composition answers with one final selection, so there is
 * no count of contributors and no two-profile refusal: a host assembly is
 * responsible for composing the value it intends to offer. Core reads that
 * answer once, resolves each selected name once, and keeps what it captured. A
 * later policy that supplies a broader selection, replaces a registration or
 * imports a different body changes nothing captured here.
 *
 * A host that selected nothing offers no evaluation at all, which `<Evaluate>`
 * refuses with when it is invoked rather than at installation: a document that
 * never writes `<Evaluate>` is not asking for a ceiling.
 */

import type { Operation } from "effection";

import { CORE_ORIGIN } from "./components/registry.ts";
import { DirInvocationError } from "./components/Dir.ts";
import { FileAccessError } from "./components/File.ts";
import { FileDeleteError } from "./components/FileDelete.ts";
import { GlobError } from "./components/Glob.ts";
import { markGeneratedRequestRefusal } from "./generated-request-refusal.ts";
import { isFormDispatcher } from "./invocation-identity.ts";
import type {
  ComponentInvocation,
  ComponentRouting,
  InvocationForm,
} from "./invocation-identity.ts";
import { pinnedJson } from "./generated-xmd.ts";
import { definitionGeneratedRefusal, offeredForm } from "./components/generated-metadata.ts";
import type { GeneratedEffect } from "./components/generated-metadata.ts";
import type { AdmittedSelection } from "./generated-selection.ts";
import type { FunctionComponent, FunctionComponentDefinition, Json, PropsSchema } from "./types.ts";

/**
 * One provider-backed name, already resolved and reconciled.
 *
 * Produced by canonical execution's capture step before this module is asked to
 * capture anything: the chain has answered, the definition published on that
 * exact final answer has been taken off it, and it has been retained
 * defensively. What arrives here is the settled result, so nothing in this
 * module resolves, looks up, or holds a resolver it could call later.
 */
export interface ResolvedAnswer {
  /** Core's own retained copy, which is what a fragment invokes. */
  readonly definition: FunctionComponentDefinition;
  /** Which installation published it, as documentation provenance. */
  readonly origin: string;
}

/** Every selected name this capture resolved, by name. */
export type ResolvedAnswers = ReadonlyMap<string, ResolvedAnswer>;

/**
 * One captured entry: frozen structural data beside one sealed implementation.
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
   * The publishing installation's origin, which is core's own wherever
   * canonical resolution answered with core's. Documentation provenance: it is
   * no part of what the implementation is, and nothing compares a continuation
   * against it.
   */
  readonly origin: string;
  readonly forms: readonly InvocationForm[];
  readonly props: PropsSchema;
  /**
   * Which table holds this entry.
   *
   * Every selected name is a `component-answer`: its implementation came
   * through the complete ordinary import chain and the canonical terminal
   * behind it, whether that answered with core's own fixed component, a
   * registration or a provider's published definition. `composition` is the
   * always-on trusted table, which `allow` does not select between.
   */
  readonly kind: "component-answer" | "composition";
  /** What the owning declaration says this entry does, when it says anything. */
  readonly description?: string;
  /**
   * What a fragment invokes.
   *
   * Core's retained copy of the exact final answer the import chain gave, held
   * behind this execution's lifetime — never the object the chain was holding,
   * and never something re-resolved later.
   */
  readonly definition: FunctionComponentDefinition;
  /**
   * The form dispatcher underneath this entry's implementation, when the sealed
   * definition wraps one.
   *
   * A selected name runs behind a lifetime guard canonical capture built, so
   * the function on the definition is core's rather than the owner's. A
   * component whose own answer dispatches on the authored form would otherwise
   * lose that dispatch, because what a selection records as the form dispatcher
   * is read off the definition it was handed. So the dispatcher travels
   * explicitly.
   */
  readonly dispatch?: unknown;
}

/** What canonical execution keeps, and what canonical `<Evaluate>` reads. */
export interface EvaluationProfile {
  /**
   * The pure components every evaluation may write, whatever `allow` selects.
   *
   * Core's own, and not something a host selects: composition carries no effect
   * operation, so admitting it grants nothing and omitting it would take a
   * language construct away rather than a permission. `allow` selects between
   * the two effect tables below and never between these.
   */
  readonly composition: readonly CapturedEntry[];
  readonly read: readonly CapturedEntry[];
  readonly write: readonly CapturedEntry[];
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

/** What an execution whose host selected no generated components refuses with. */
export const NO_PROFILE =
  "<Evaluate /> has no generated components here: this host selected none, so nothing " +
  "established what a generated fragment may do. The selection is the host's own statement of " +
  "the maximum permission an evaluation has, and `allow` only narrows it.";

/** What a profile whose execution has ended refuses with. */
export const REVOKED =
  "the generated components this fragment was admitted under belong to an execution that has " +
  "ended.";

/** A selected name canonical execution cannot capture an implementation for. */
export class EvaluationProfileError extends Error {
  override name = "EvaluationProfileError";
}

/**
 * The lifetime every captured implementation is held to.
 *
 * Opened by canonical execution and armed before a single name is resolved, so
 * a captured operation cannot escape an execution whose revocation is not yet
 * registered. There is nothing else on it: a selected name runs the
 * implementation canonical resolution answered with, through the provider
 * installed where the fragment runs, so there is no host operation to bind and
 * revoke beside it.
 */
export interface EvaluationLifetime {
  live(): boolean;
  revoke(): void;
}

/** Open one. */
export function evaluationLifetime(): EvaluationLifetime {
  let active = true;
  return {
    live: () => active,
    revoke: () => {
      active = false;
    },
  };
}

/**
 * Capture what this host selected, once, after every selected name has been
 * resolved and before public execution policy.
 *
 * Nothing is consulted here that a host still holds. The selection arrived as
 * owned, validated data; each definition arrived as core's own retained copy of
 * an answer canonical resolution produced; and everything structural this
 * module derives — the props contract, the description, the admitted forms and
 * which table each of them lands in — is read off that definition rather than
 * restated.
 */
export function captureEvaluationProfile(
  selection: AdmittedSelection,
  answers: ResolvedAnswers,
  lifetime: EvaluationLifetime,
  project?: ComponentRouting["project"],
): EvaluationProfile {
  // Core's own, built before the selection is examined, so a host selecting one
  // of these refuses at capture rather than shadowing it at evaluation.
  const composition = compositionEntries();
  const reserved = new Set(composition.map((entry) => entry.name));
  const read: CapturedEntry[] = [];
  const write: CapturedEntry[] = [];
  for (const [name, forms] of selection) {
    if (reserved.has(name)) {
      throw new EvaluationProfileError(
        `a host selected "${name}" as a generated effect, and it is trusted composition every ` +
          "evaluation already has. One name is one component, and a selection cannot give an " +
          "effect to a name that performs none.",
      );
    }
    const captured = captureName(name, forms, answers, lifetime, project);
    read.push(...captured.read);
    write.push(...captured.write);
  }
  return Object.freeze({
    composition,
    read: Object.freeze(read),
    write: Object.freeze(write),
    live: () => lifetime.live(),
    revoke: () => {
      lifetime.revoke();
    },
  });
}

/** The entries one selected name contributes, by the effect its owner offers. */
interface CapturedName {
  readonly read: readonly CapturedEntry[];
  readonly write: readonly CapturedEntry[];
}

/**
 * One selected name, as one implementation seen from the tables its spellings
 * belong to.
 *
 * A name resolves once and runs one implementation, however many spellings it
 * was selected for: `<File />` observing and `<File>…</File>` writing are two
 * entries under one name, and both carry the same sealed object. Two guards
 * over one answer would be two lifetimes for one implementation, and which of
 * them a fragment reached would depend on which table admitted it.
 *
 * Which table each spelling lands in is the owner's answer rather than the
 * selection's. A host selects a spelling; its declaration says whether that
 * spelling reads or writes, and a spelling the declaration offers no generated
 * use of refuses here — before an execution holds a profile at all.
 */
function captureName(
  name: string,
  forms: readonly InvocationForm[],
  answers: ResolvedAnswers,
  lifetime: EvaluationLifetime,
  project: ComponentRouting["project"] | undefined,
): CapturedName {
  const resolved = answers.get(name);
  if (resolved === undefined) {
    throw new EvaluationProfileError(
      `a host selected "${name}" for generated use, and this execution resolved no ` +
        "implementation for it.",
    );
  }
  const answer = resolved.definition;
  // What the definition offers at all, before which of it this selection
  // admits. A provider's answer was read where it was published and core's own
  // owners where they are declared, so a refusal here is a definition that
  // reached a capture without crossing either.
  const refusal = definitionGeneratedRefusal(answer);
  if (refusal !== undefined) {
    throw new EvaluationProfileError(
      `a host selected "${name}" for generated use, whose declaration ${refusal}.`,
    );
  }
  // Which class each selected spelling reaches, from the owner's own metadata.
  // It decides the table below and words the refusal the guard reports.
  const effects: Partial<Record<InvocationForm, GeneratedEffect>> = {};
  const byEffect = new Map<GeneratedEffect, InvocationForm[]>();
  for (const form of forms) {
    const offered = offeredForm(answer.generated, form);
    if (offered === undefined) {
      throw new EvaluationProfileError(
        `a host selected "${name}" in its ${form} form, and the declaration that owns that ` +
          "implementation offers no generated use of it. A generated fragment runs a form its " +
          "owner states an identity and an effect for.",
      );
    }
    effects[form] = offered.effect;
    const held = byEffect.get(offered.effect) ?? [];
    held.push(form);
    byEffect.set(offered.effect, held);
  }
  const inner = answer.fn;
  const guard = bounded(name, inner, lifetime, Object.freeze({ ...effects }));
  const protectedOrigin = project?.(inner, guard);
  const shared = {
    name,
    origin: resolved.origin,
    props: detach(answer.props),
    kind: "component-answer" as const,
    definition: Object.freeze({ ...answer, fn: guard }),
    ...(protectedOrigin === undefined ? {} : { protectedOrigin }),
    ...(typeof answer.description === "string" ? { description: answer.description } : {}),
    // The owner's own dispatcher, when its answer has one. The definition above
    // runs behind core's lifetime guard, so what a selection would read off it
    // is core's function rather than the owner's — and a form dispatcher read
    // off the wrong function selects no body at all.
    ...(isFormDispatcher(inner) ? { dispatch: inner } : {}),
  };
  return {
    read: entriesFor(shared, byEffect.get("read")),
    write: entriesFor(shared, byEffect.get("write")),
  };
}

function entriesFor(
  shared: Omit<CapturedEntry, "forms">,
  forms: readonly InvocationForm[] | undefined,
): readonly CapturedEntry[] {
  if (forms === undefined) {
    return [];
  }
  return [Object.freeze({ ...shared, forms: canonicalForms(forms) })];
}

/**
 * The trusted composition table, as this execution retains it.
 *
 * Built from the same pinned core entry the evaluator admits, so the vocabulary
 * an agent is shown and the vocabulary preflight enforces are one fact rather
 * than two copies of one. Nothing here is a host's to select: a composition
 * entry runs a component that performs nothing, so there is no operation to
 * bind and no revocation to hold.
 */
function compositionEntries(): readonly CapturedEntry[] {
  return Object.freeze(
    [pinnedJson()].map((entry) =>
      Object.freeze({
        name: entry.name,
        origin: CORE_ORIGIN,
        forms: Object.freeze<InvocationForm[]>(["self-closing"]),
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
 * One captured implementation, held to this execution's lifetime and reporting
 * a refusal of the fragment's own request as one.
 *
 * Two jobs, and both of them are the capture's rather than the component's.
 *
 * The lifetime is the execution's: a selected name's body reaches whatever its
 * owner closed over, which this execution never saw and cannot revoke — so the
 * *entry* carries the lifetime instead, and a definition somebody kept refuses
 * rather than running against a run that is over.
 *
 * The classification is the caller's. A host driving a loop needs to know
 * whether the fragment's own text was refused, and only the code that raised
 * the failure knows that — so an ordinary refusal from an admitted component is
 * marked here, with a safe reason, and everything else is left unmarked.
 *
 * The guard is what capture builds the entry's definition around, not a wrapper
 * placed over one afterwards: this function is the implementation the entry has
 * ever had, so nothing about which body a form selects moves. It opens no scope
 * and selects no body, so the component's own dispatcher still runs in the
 * frame the engine issued it for.
 */
function bounded(
  name: string,
  inner: FunctionComponentDefinition["fn"],
  lifetime: EvaluationLifetime,
  effects: Readonly<Partial<Record<InvocationForm, GeneratedEffect>>>,
): FunctionComponent {
  if (typeof inner !== "function") {
    throw new EvaluationProfileError(
      `a host selected "${name}" for generated use, and the import chain answered with a ` +
        "definition that has no implementation to invoke. A selected name runs something.",
    );
  }
  const implementation = inner;
  return function* held(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<unknown> {
    if (!lifetime.live()) {
      throw new EvaluationProfileError(REVOKED);
    }
    try {
      return yield* implementation(props, invocation);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      const reason = refusedReason(effects, props, invocation, error);
      if (reason === undefined) {
        throw error;
      }
      throw markGeneratedRequestRefusal(error, reason);
    }
  };
}

/** The verb a refusal of each filesystem effect is reported with. */
const VERBS: Readonly<Record<GeneratedEffect, string>> = Object.freeze({
  read: "read",
  write: "write",
});

/**
 * The safe reason this failure carries, when it is a refusal of the request.
 *
 * Core's own fixed sentence, not the component's. The component's message is
 * safe to *print* — it names the path the document wrote and a phrase from a
 * fixed vocabulary — but a write that failed because its content failed to
 * expand reports what that content said, and the content of a generated
 * fragment is text nobody audited. A refusal reason travels back to whatever is
 * driving the loop, so it is built here from the effect the spelling reaches
 * and the authored path, and from nothing the fragment produced.
 *
 * The glob sentences are the exception and are already written for this: a
 * pattern a fragment wrote wrongly is reported by `glob-source.ts` in the same
 * words an author would be told, and no provider diagnostic reaches them.
 *
 * Everything else is unmarked, which is the safe default. An absent provider, a
 * broken provider contract, a revoked execution, a cancellation and a durable
 * failure are not the request being refused, and calling any of them one would
 * invite another turn at work that cannot succeed.
 */
function refusedReason(
  effects: Readonly<Partial<Record<InvocationForm, GeneratedEffect>>>,
  props: Record<string, Json>,
  invocation: ComponentInvocation,
  error: unknown,
): string | undefined {
  if (error instanceof GlobError) {
    return error.message;
  }
  if (error instanceof FileDeleteError) {
    return refused("delete", props);
  }
  if (error instanceof DirInvocationError) {
    return refused("create", props);
  }
  if (!(error instanceof FileAccessError)) {
    return undefined;
  }
  const effect = effects[writtenForm(invocation) ?? "self-closing"];
  return effect === undefined ? undefined : refused(VERBS[effect], props);
}

function refused(verb: string, props: Record<string, Json>): string {
  return `an admitted fragment could not ${verb} ${JSON.stringify(String(props.path))}.`;
}

/**
 * Which spelling this element was written as.
 *
 * Read from the authored shape, which is the only thing that separates
 * `<File />` from `<File>…</File>` once both are selected under one name. This
 * is **not** how the effect was selected: the component's own dispatcher
 * already did that, from the scan, before its body ran — and the failure this
 * words a sentence for has already happened. A forged invocation can therefore
 * change which verb a refusal is phrased with and nothing else, which is why
 * reading it here is observation rather than authentication.
 */
function writtenForm(invocation: ComponentInvocation): InvocationForm | undefined {
  try {
    return invocation.hasContent() ? "paired" : "self-closing";
  } catch {
    return undefined;
  }
}

/** The forms an entry is admitted for: a non-empty set in canonical order. */
const FORMS: readonly InvocationForm[] = ["self-closing", "paired"];

function canonicalForms(forms: readonly InvocationForm[]): readonly InvocationForm[] {
  const held = new Set(forms);
  return Object.freeze(FORMS.filter((form) => held.has(form)));
}

/** A frozen deep copy of one JSON value the answer carried. */
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
