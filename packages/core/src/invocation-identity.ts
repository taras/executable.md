/**
 * The identity a trusted host's component names its durable work after
 * (architecture.md, *Capability-backed invocation identity*).
 *
 * A component that names a durable operation after its own invocation is making
 * an authority claim: the name decides which retained record a replay restores,
 * so two invocations arriving at one name each replay the other's work, and an
 * implementation running under somebody else's identity commits against its own
 * storage under their expansion. Code Rule 15 says such a decision never trusts
 * replaceable state, and every channel a component could *read* one from is
 * replaceable — a Context is addressed by name, a contextual Api answer is
 * composed by whoever installed a handler, and the registry is an answer a
 * handler may keep from one attachment and hand back inside another, record and
 * all.
 *
 * So nothing is read. The execution is *told*, before any installation runs,
 * which components name durable work; it mints one domain for each, builds the
 * implementation by handing that domain's **claimant** straight to the host's
 * factory, and registers what comes back. The domain exists only here, the
 * claimant exists only as the argument of that call, and neither is published,
 * named, or reachable from a document. An implementation from another execution
 * holds another execution's claimant, which answers for nothing here.
 *
 * A claimant answers only for the invocation the engine is running: the one the
 * engine minted for a component in this domain, still live, not expanding its
 * own content, running in the frame the engine invoked it in, and not already
 * answered. Everything else refuses.
 *
 * ## Which invocation is in the domain
 *
 * Not the one whose authored name matches: a name is what a document wrote, and
 * what it resolves to is decided by tiers, registrations and middleware. An
 * invocation is in a domain when *canonical resolution selected that domain's
 * own implementation for it* — the function object this execution built from
 * the host's factory, recognized by identity where core resolves the import and
 * carried to the issuance through this module's own state.
 *
 * The carrying is a frame around one import: the engine opens one before it
 * asks, canonical resolution records what it selected, and the engine settles it
 * immediately afterwards. A resolution that never happened, one that happened
 * more than once, and one that answered for a different name than the engine
 * asked all settle to nothing. Nothing travels on the answer, so a handler that
 * short-circuits the import, redirects the name, replaces the definition, wraps
 * it, or hands back a registration record from somewhere else moves no
 * authority: what it can change is which implementation runs, and an
 * implementation running where canonical resolution did not select it names
 * nothing.
 */

import { createContext, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { printErrors, printsErrors } from "./component-failures.ts";
import type {
  FunctionComponent,
  FunctionComponentDefinition,
  Json,
  PropsSchema,
  ReturnsSchema,
} from "./types.ts";

/**
 * What a function component receives beside its props.
 *
 * Almost opaque. What it names is answered by a claimant, and only for the
 * execution that minted both; there is no shape here to copy and nothing to
 * read about the caller, the binding, the children, the environment or the
 * scope.
 *
 * The one thing it reports is how the element that caused this invocation was
 * written, because that is a fact about *this invocation* rather than about the
 * surroundings it runs in — and a component whose two spellings do different
 * things is choosing an effect with it.
 *
 * The brand is declared and never exported, so it names a type and nothing a
 * value can carry — the runtime test is the private field below, not this.
 */
declare const Invocation: unique symbol;

export interface ComponentInvocation {
  readonly [Invocation]?: never;
  /**
   * Whether the element was written with content: `<C>…</C>` and `<C></C>`
   * yes, `<C />` no.
   *
   * The authored shape, immutable and synchronous. It projects nothing,
   * suspends on nothing, asks nothing of the middleware chain, and does not
   * spend this invocation's durable identity — reading it leaves the claimant
   * exactly as it was. On an invocation the engine issued this is the canonical
   * fact, and a component that reaches nothing else — no import, no context, no
   * helper of its own copy — reads it by calling what it received.
   *
   * **Observation only.** Calling it is not authentication: a component
   * receives whatever its caller passed, and a wrapper can pass an object
   * literal with a method of this name — there is no shape a forger cannot
   * copy, because a shape is what a forger copies. Nor can a component
   * authenticate it for itself; a reader recognizing the invocation by private
   * state would recognize only the copy of core it was imported with, and a
   * component can be loaded beside its own copy.
   *
   * So a branch that decides *how to render* may call this, and a branch that
   * selects an irreversible **effect** does not read the form at all. Such a
   * component declares its forms and canonical {@link formDispatcher} enters
   * the one the scan recorded, so the choice is the engine's before the body
   * runs.
   *
   * `Component.hasContent()` is weaker again: it answers through the composable
   * chain, where a handler installed anywhere outside the invocation answers
   * ahead of the engine, and where a handler that answers per call can report
   * one shape to a check and the other to the component.
   */
  hasContent(): boolean;
}

/** A durable identity that cannot be claimed here. */
export class ComponentInvocationError extends Error {
  override name = "ComponentInvocationError";
}

/**
 * What a trusted host's implementation is handed to name its durable work.
 *
 * Delivered, never published: it exists as the argument of one call, made by
 * the execution that minted it, to the factory that installation supplied.
 */
export interface IdentityClaimant {
  (invocation: ComponentInvocation): Operation<string>;
}

/**
 * A component whose implementation names durable work after its invocation.
 *
 * Declared to the execution rather than registered by the host, because what
 * may name durable work here has to be fixed before anything can observe or
 * replace it. The factory is called once, with this execution's claimant.
 */
export interface IdentityComponent {
  readonly name: string;
  readonly props: PropsSchema;
  readonly returns?: ReturnsSchema;
  readonly captures?: readonly string[];
  readonly origin: string;
  factory(claim: IdentityClaimant): FunctionComponent;
}

/** One execution's domain for one component name. Reachable from nowhere. */
export interface IdentityDomain {
  readonly component: string;
}

/**
 * What one execution knows about the components it gave identity to.
 *
 * Built by the execution from what installation declared, held by value, and
 * passed into core's own expansion beside the import authority — so no
 * document, component or middleware can reach it, replace it, or add to it.
 */
export interface InvocationIdentities {
  /**
   * Open the frame for one import the engine is about to ask for.
   *
   * The engine settles it as soon as that import answers, whatever the answer
   * was, so nothing a handler does in between decides what the frame holds.
   */
  beginImport(name: string): ImportSelection;
  /**
   * Record what canonical resolution selected. Only core's own resolver calls
   * this, from inside the import the frame above was opened for.
   */
  select(name: string, definition: FunctionComponentDefinition): void;
  /** Answer for nothing, from here on. Called when the execution is torn down. */
  revoke(): void;
}

/** One import's frame: what canonical resolution selected, once. */
export interface ImportSelection {
  /**
   * The domain of the registration canonical resolution selected here, if it
   * selected one of this execution's own.
   *
   * Answers `undefined` unless exactly one canonical resolution happened inside
   * this frame, for the name the engine asked, selecting the implementation
   * this execution built for that domain.
   */
  settle(): IdentityDomain | undefined;
}

/** What the engine holds for one invocation: the value, and the end of it. */
export interface IssuedInvocation {
  readonly invocation: ComponentInvocation;
  /**
   * Enter one projection of this invocation's own content; the answer ends it.
   *
   * Nothing names this invocation in between, because everything running in
   * there belongs to somebody else.
   */
  projecting(): () => void;
  /** End the issuance. Nothing it produced authorizes anything afterwards. */
  close(): void;
}

interface Issuance {
  readonly id: string;
  /** The component this is an invocation of, as the engine resolved it. */
  readonly component: string;
  /** How the element was written, as the engine scanned it. */
  readonly content: boolean;
  /**
   * The dispatcher canonical resolution selected for this import, when it
   * selected one.
   *
   * Recorded by the engine rather than read off the answer, so a dispatcher a
   * handler kept from another import — or produced for another name — is not
   * the one this invocation admits.
   */
  readonly selection: FunctionComponent | undefined;
  /** The domain this execution gave that component, when it gave one. */
  readonly domain: IdentityDomain | undefined;
  /** The frame the engine invoked the implementation in. */
  readonly frame: Scope;
  live: boolean;
  spent: boolean;
  projecting: number;
}

let stateOf: (value: unknown) => Issuance | undefined;

/**
 * The one value core will admit as an invocation, and the only thing that is
 * one.
 *
 * Identity is the private field: a structural look-alike, a descriptor-for-
 * descriptor clone, and an object built on this prototype are none of them one.
 */
class EngineInvocation implements ComponentInvocation {
  declare readonly [Invocation]?: never;
  readonly #issuance: Issuance;

  constructor(issuance: Issuance) {
    this.#issuance = issuance;
    Object.freeze(this);
  }

  /**
   * The authored shape, read straight off the owner-kept issuance.
   *
   * Not a Context, not a contextual Api answer, not a registry entry, not a
   * property anything could redefine on a copy, and not a lookup exported for
   * somebody to reach: the state is private to this module and the only way to
   * it is an object the engine minted and handed over. A component evaluated
   * through a second loaded copy of core still calls this object, so what it
   * gets is the fact its own copy's helpers could not answer.
   */
  hasContent(): boolean {
    return this.#issuance.content;
  }

  static {
    stateOf = (value) =>
      typeof value === "object" && value !== null && #issuance in value
        ? value.#issuance
        : undefined;
  }
}

/**
 * How an element was written, as the scanner read it.
 *
 * The vocabulary generated-XMD admission already speaks (`generated-xmd.ts`),
 * used here for the same fact so one element is described one way wherever it
 * is decided.
 */
export type InvocationForm = "self-closing" | "paired";

/** The error a component reports for a form, or an invocation, it will not run. */
export type FormRefusal = (props: Record<string, Json>, form: InvocationForm | undefined) => Error;

/**
 * What a form-sensitive component declares to canonical definition
 * construction.
 *
 * A declaration is **input**, not authority: it says which bodies exist and
 * which forms they answer, and canonical core turns it into the dispatcher that
 * decides. A component that declares nothing is form-insensitive and reaches
 * expansion exactly as it always has.
 *
 * `refuse` belongs to the component rather than to the engine because the
 * sentence and the failure mode are the component's settled contract: a
 * `<File.Delete>` refusal is a printed component error and a `<Dir />` refusal
 * ends the run, and moving the decision earlier must not change which.
 */
export type FormDeclaration =
  | { readonly forms: "either"; readonly fn: FunctionComponent }
  | {
      readonly forms: "self-closing";
      readonly fn: FunctionComponent;
      readonly refuse: FormRefusal;
    }
  | { readonly forms: "paired"; readonly fn: FunctionComponent; readonly refuse: FormRefusal }
  | {
      readonly forms: "both";
      readonly "self-closing": FunctionComponent;
      readonly paired: FunctionComponent;
    };

/**
 * The declaration this value is, or `undefined` when it is not one.
 *
 * Parsed rather than asserted: a repository module exports whatever it likes,
 * and this reads a value from outside the type system. An unreadable
 * declaration is not a declaration, which leaves the component form-insensitive
 * rather than half-dispatched.
 */
export function parseFormDeclaration(value: unknown): FormDeclaration | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const forms = Reflect.get(value, "forms");
  const refuse = Reflect.get(value, "refuse");
  const fn = Reflect.get(value, "fn");
  if (forms === "either" && typeof fn === "function") {
    return { forms, fn: fn as FunctionComponent };
  }
  if ((forms === "self-closing" || forms === "paired") && typeof fn === "function") {
    if (typeof refuse !== "function") {
      return undefined;
    }
    return { forms, fn: fn as FunctionComponent, refuse: refuse as FormRefusal };
  }
  if (forms === "both") {
    const selfClosing = Reflect.get(value, "self-closing");
    const paired = Reflect.get(value, "paired");
    if (typeof selfClosing === "function" && typeof paired === "function") {
      return {
        forms,
        "self-closing": selfClosing as FunctionComponent,
        paired: paired as FunctionComponent,
      };
    }
  }
  return undefined;
}

/**
 * The mark a dispatcher this copy of core built wears.
 *
 * A module-private `Symbol` rather than a registry: it is not on the global
 * symbol table, so nothing outside this module can name it, and a dispatcher
 * another copy of core built wears that copy's symbol rather than this one.
 * `Symbol.for` would be forgeable by anyone who can spell the key.
 */
const DISPATCHER: unique symbol = Symbol("executablemd.core.form-dispatcher");

/** Whether this implementation is a dispatcher this copy of core built. */
export function isFormDispatcher(fn: unknown): boolean {
  return typeof fn === "function" && DISPATCHER in fn;
}

/**
 * The engine-owned body a form-sensitive component is invoked through.
 *
 * This is the authority. The raw handlers stay closed over here and never
 * travel on an import answer, so the only route into one is a call that
 * satisfies all of:
 *
 * - the invocation is an object **this** copy of core minted, recognized by the
 *   same private field a claimant recognizes — a structural look-alike carrying
 *   `hasContent()` is not one;
 * - the issuance is still live, and its frame is the one running now, so an
 *   invocation kept from a sibling or a finished element answers nothing here;
 * - canonical resolution selected *this* dispatcher for the import that led
 *   here, so a dispatcher a handler retained and answered with reaches no body.
 *
 * Built by whichever copy of core is performing the execution — canonical
 * definition construction calls this, never the component module — so a
 * component loaded from disk through `--component-dir` is wrapped by the copy
 * that minted the invocation. That is what makes the compiled binary's embedded
 * defaults and a repository-loaded copy behave the same.
 *
 * The form itself comes from the scan, carried on the issuance. No contextual
 * answer, no method on the object handed in, and nothing a handler composed
 * takes part in choosing it.
 */
export function formDispatcher(declaration: FormDeclaration): FunctionComponent {
  const handlers: Partial<Record<InvocationForm, FunctionComponent>> =
    declaration.forms === "both"
      ? { "self-closing": declaration["self-closing"], paired: declaration.paired }
      : declaration.forms === "either"
        ? { "self-closing": declaration.fn, paired: declaration.fn }
        : { [declaration.forms]: declaration.fn };
  const refuse: FormRefusal =
    declaration.forms === "self-closing" || declaration.forms === "paired"
      ? declaration.refuse
      : unusable;

  function* dispatch(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<unknown> {
    const issuance = stateOf(invocation);
    if (
      issuance === undefined ||
      !issuance.live ||
      issuance.selection !== dispatch ||
      issuance.frame !== (yield* useScope())
    ) {
      throw refuse(props, undefined);
    }
    const form: InvocationForm = issuance.content ? "paired" : "self-closing";
    const handler = handlers[form];
    if (handler === undefined) {
      throw refuse(props, form);
    }
    return yield* handler(props, invocation);
  }

  // The declaration a component wears travels to the dispatcher, because the
  // dispatcher is what expansion asks. A component that prints its own failures
  // must go on printing the one this raises for a form it will not run.
  if (Object.values(handlers).some((handler) => printsErrors(handler))) {
    printErrors(dispatch);
  }
  Object.defineProperty(dispatch, DISPATCHER, { value: true, enumerable: false });
  return dispatch;
}

/** The fallback refusal, for a declaration that names no sentence of its own. */
function unusable(_props: Record<string, Json>, form: InvocationForm | undefined): Error {
  return new ComponentInvocationError(
    form === undefined
      ? "this component was called without the invocation the engine issued, so which form it " +
          "was written as cannot be established."
      : `this component has no ${form} form.`,
  );
}

/**
 * The dispatcher canonical resolution selected for one import.
 *
 * The same shape the identity frame above uses, and open for the same reason:
 * what the engine records is what canonical resolution produced *inside* this
 * import, not what came back from the chain. A frame holding two selections —
 * a handler that delegated twice, or two expansions interleaving — settles to
 * nothing, which refuses rather than guesses.
 *
 * Held in a context an execution installs, not in this module. A module-scoped
 * stack would be one stack for every run in the process, so two executions
 * importing at once would push and pop each other's frames — the identity
 * frames beside this live in `installIdentities()`'s closure for the same
 * reason.
 */
interface SelectionFrame {
  selected: FunctionComponent | undefined;
  count: number;
}

const FormSelections = createContext<SelectionFrame[]>("executablemd.core.form-selection");

/**
 * Give this execution its own selection stack.
 *
 * Installed once per execution, before anything imports. An expansion running
 * without one records no selection, so a form-sensitive component refuses
 * rather than running unselected — the safe direction, and the reason this is
 * not defaulted to a shared array.
 */
export function* useFormSelections(): Operation<void> {
  yield* FormSelections.set([]);
}

export interface FormSelection {
  settle(): FunctionComponent | undefined;
}

/** Open the frame for one import the engine is about to ask for. */
export function* beginFormSelection(): Operation<FormSelection> {
  const stack = yield* FormSelections.get();
  const frame: SelectionFrame = { selected: undefined, count: 0 };
  stack?.push(frame);
  return {
    settle(): FunctionComponent | undefined {
      const index = stack?.lastIndexOf(frame) ?? -1;
      if (index >= 0) {
        stack?.splice(index, 1);
      }
      return frame.count === 1 ? frame.selected : undefined;
    },
  };
}

/**
 * Record what canonical resolution selected. Only core's own resolvers call
 * this, from inside the import the frame above was opened for.
 *
 * What it records is the **dispatcher**, wherever it sits. A trusted wrapper
 * that collects what a component returned is still the answer to the import,
 * but it is not the form authority: what the invocation is bound to is the
 * canonical dispatcher underneath it.
 */
export function* selectForm(fn: unknown): Operation<void> {
  const stack = yield* FormSelections.get();
  const frame = stack?.at(-1);
  if (frame === undefined) {
    return;
  }
  frame.count += 1;
  frame.selected = isFormDispatcher(fn) ? (fn as FunctionComponent) : undefined;
}

/**
 * The form of an invocation this engine issued, for core's own use.
 *
 * Not exported from the package. A caller-visible method on the object handed
 * in is what a wrapper can mint; this reads the issuance the engine holds, so a
 * check written against it is a check about the element rather than about what
 * somebody passed.
 */
export function invocationForm(invocation: ComponentInvocation): InvocationForm | undefined {
  const issuance = stateOf(invocation);
  if (issuance === undefined) {
    return undefined;
  }
  return issuance.content ? "paired" : "self-closing";
}

/** Mint one invocation identity. Only the engine calls this. */
export function issueInvocation(
  id: string,
  component: string,
  domain: IdentityDomain | undefined,
  frame: Scope,
  content: boolean,
  selection?: FunctionComponent,
): IssuedInvocation {
  const issuance: Issuance = {
    id,
    component,
    content,
    selection,
    domain,
    frame,
    live: true,
    spent: false,
    projecting: 0,
  };
  return {
    invocation: new EngineInvocation(issuance),
    projecting(): () => void {
      issuance.projecting += 1;
      let released = false;
      // Counted, because one invocation may have more than one projection in
      // flight, and idempotent, because a release that ran twice would lower
      // somebody else's.
      return () => {
        if (!released) {
          released = true;
          issuance.projecting -= 1;
        }
      };
    },
    close(): void {
      issuance.live = false;
    },
  };
}

/** One domain, and the claimant that is the only way to spend it. */
interface Minted {
  /** The implementation this execution built for it, by identity. */
  implementation?: FunctionComponent;
  readonly domain: IdentityDomain;
  readonly claim: IdentityClaimant;
  /** Answer nothing until the registration this belongs to has committed. */
  activate(): void;
  revoke(): void;
}

function mintDomain(component: string): Minted {
  let active = false;
  const domain: IdentityDomain = Object.freeze({ component });
  return {
    domain,
    activate: () => {
      active = true;
    },
    revoke: () => {
      active = false;
    },
    *claim(invocation: ComponentInvocation): Operation<string> {
      const issuance = stateOf(invocation);
      if (issuance === undefined) {
        throw new ComponentInvocationError(
          "this is not an invocation the engine issued, so it names no durable identity",
        );
      }
      if (!active) {
        throw new ComponentInvocationError(
          `the execution that gave <${component} /> its durable identity is not running this — ` +
            "an implementation kept from another execution names nothing here",
        );
      }
      if (issuance.domain !== domain) {
        throw new ComponentInvocationError(
          `this is an invocation of <${issuance.component} />, and this claimant answers for ` +
            `<${component} /> as this execution installed it — an implementation kept from one ` +
            "installation names no durable identity at another's",
        );
      }
      if (!issuance.live) {
        throw new ComponentInvocationError(
          "this invocation has finished — an issuance kept from another element names no " +
            "durable identity here",
        );
      }
      if (issuance.projecting > 0) {
        throw new ComponentInvocationError(
          "this invocation is expanding its own content and names nothing while it does — an " +
            "ancestor still running names no durable identity for what is inside it",
        );
      }
      if (issuance.frame !== (yield* useScope())) {
        throw new ComponentInvocationError(
          "this issuance belongs to another invocation of the same component — one that is " +
            "running right now, in a frame of its own, and it names nothing here",
        );
      }
      if (issuance.spent) {
        throw new ComponentInvocationError(
          "this invocation's durable identity has already been taken, and one invocation names " +
            "one durable operation",
        );
      }
      issuance.spent = true;
      return issuance.id;
    },
  };
}

/** One built implementation, ready for core's own registration path. */
export interface IdentityRegistration {
  readonly name: string;
  readonly origin: string;
  readonly props: PropsSchema;
  readonly returns?: ReturnsSchema;
  readonly captures?: readonly string[];
  readonly fn: FunctionComponent;
}

/** Every domain one execution minted, and how the engine reaches them. */
export interface IdentityInstallation {
  readonly identities: InvocationIdentities;
  /** The registrations to make, already built from their factories. */
  readonly registrations: readonly IdentityRegistration[];
  /** Called once the registrations have been validated and committed. */
  activate(): void;
}

/**
 * Mint this execution's domains and build the implementations from them.
 *
 * The factory is called here, with a claimant that answers only for this
 * execution's own invocations of that component. Nothing is registered yet:
 * the caller registers what comes back, and activates only once that batch has
 * been validated and committed, so a refused registration leaves a claimant
 * that answers for nothing.
 */
export function installIdentities(components: readonly IdentityComponent[]): IdentityInstallation {
  const minted = new Map<string, Minted>();
  const registrations: IdentityRegistration[] = [];
  for (const component of components) {
    if (minted.has(component.name)) {
      throw new ComponentInvocationError(
        `this execution was given two identity components called "${component.name}", and one ` +
          "component names its durable work in one domain",
      );
    }
    const domain = mintDomain(component.name);
    minted.set(component.name, domain);
    // Built here, and held by identity: this exact function is what canonical
    // resolution has to have selected for an invocation to be in this domain.
    const implementation = component.factory(domain.claim);
    domain.implementation = implementation;
    registrations.push({
      name: component.name,
      origin: component.origin,
      props: component.props,
      ...(component.returns === undefined ? {} : { returns: component.returns }),
      ...(component.captures === undefined ? {} : { captures: component.captures }),
      fn: implementation,
    });
  }

  /**
   * The import frames the engine has open, innermost last.
   *
   * A stack rather than a slot, because a handler may expand something of its
   * own while an import is in flight. Anything that leaves two selections in
   * one frame — a handler delegating twice, or two expansions interleaving —
   * settles to nothing, which is the safe direction.
   */
  const frames: { asked: string; selected: Minted | undefined; count: number }[] = [];

  return {
    identities: {
      beginImport(asked: string): ImportSelection {
        const frame = { asked, selected: undefined as Minted | undefined, count: 0 };
        frames.push(frame);
        return {
          settle(): IdentityDomain | undefined {
            const index = frames.lastIndexOf(frame);
            if (index >= 0) {
              frames.splice(index, 1);
            }
            return frame.count === 1 && frame.selected !== undefined
              ? frame.selected.domain
              : undefined;
          },
        };
      },
      select(name: string, definition: FunctionComponentDefinition): void {
        const frame = frames.at(-1);
        if (frame === undefined) {
          return;
        }
        frame.count += 1;
        // The name canonical resolution answered for has to be the one the
        // engine asked: a handler that delegates a different name selects a
        // registration the element never named.
        const domain = frame.asked === name ? minted.get(name) : undefined;
        // And the implementation has to be the one this execution built. A
        // repository file, a nested registration and another execution's
        // component all resolve to a different function.
        frame.selected =
          domain !== undefined && domain.implementation === definition.fn ? domain : undefined;
      },
      revoke: () => {
        for (const domain of minted.values()) {
          domain.revoke();
        }
      },
    },
    registrations,
    activate: () => {
      for (const domain of minted.values()) {
        domain.activate();
      }
    },
  };
}
