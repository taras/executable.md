/**
 * What a parent says its children are.
 *
 * A description is issued, never written. `describe()` is the only way to make
 * one, `component()` is the only way to make something it can name, and what
 * either of them holds is behind a private field — so a plain object of the
 * right shape is not a description, statically or at runtime, and there is
 * nothing on the outside of one to reach into and change.
 *
 * It is also detached. The input a caller passes is copied into the
 * description rather than referenced from it: a caller that keeps its own
 * object and mutates it afterwards, or while an offer is still waiting to be
 * committed, changes nothing about the tree. Nothing the caller still owns is
 * frozen either — freezing somebody else's data as a side effect of describing
 * a child is a change to their program, not to ours.
 *
 * Keys are how identity survives a redescription. Two descriptions with the
 * same parent, key and component are the same child saying something new about
 * itself; a different key or a different component is a different child, and
 * the old one's lifetime ends. Position is not identity: reordering siblings
 * moves nodes, it does not replace them.
 *
 * Nothing here registers anything. There is no module-scoped table of
 * components: what a mounted child can do lives in its own Freedom node's
 * `NodeData`, which goes away exactly when the node does.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";

/**
 * What a component may be given, and therefore what a tree may hold.
 *
 * View data and nothing else. A function or a class instance would carry
 * behavior into a tree whose whole claim is that it holds values, and would be
 * a way for a component to reach something the commit never saw. A component
 * narrows what it is given by parsing it, the way everything else in this
 * repository narrows data it did not construct.
 */
export type ReplViewData =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ReplViewData[]
  | { readonly [key: string]: ReplViewData };

/** Placement a parent decides for one direct child. Opaque to everyone else. */
export type ReplPlacement = { readonly [key: string]: string | number | boolean };

/**
 * The named keys this composition layer understands.
 *
 * Named because each one means something structural — submit, dismiss, move
 * focus, erase, interrupt — as opposed to text, which means only itself.
 *
 * `Interrupt` is the one named key no mounted node claims: ending the command is
 * a lifecycle outcome its owner decides, so the program answers this key where
 * it answers end of input, rather than a row answering it for the screen that
 * happens to be up.
 */
export type ReplKey = "Enter" | "Escape" | "Tab" | "Backtab" | "Backspace" | "Interrupt";

/**
 * One normalized event, as a host hands it over.
 *
 * A discriminated union, so a key event carrying a frame and a pointer event
 * carrying a key name are not values anybody can build. The host says what
 * happened and where; it never says what it means.
 *
 * Text is its own member rather than a key with a payload, because the two are
 * answered differently: a named key is a command whoever claims it recognizes,
 * and text is content that goes wherever content goes. It carries the string the
 * terminal decoded — one grapheme as typed, or `"\n"` for a newline inside a
 * paste — and never a raw terminal event.
 */
export type ReplInputEvent =
  | { readonly kind: "key"; readonly key: ReplKey }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "pointer"; readonly target: string; readonly frame: number };

/** What a mounted child may do, for as long as it is mounted. */
export interface ReplNode<Action> {
  /** Stable for the whole of this node's lifetime, and never reused. */
  readonly id: string;
  /** This node's key among its siblings. */
  readonly key: string;
  /** The input as it stands: this description's own copy, already frozen. */
  readonly input: ReplViewData;
  /** The placement this node's parent gave it. */
  readonly placement: ReplPlacement;
  /**
   * Be told when the parent redescribes this node, inside that commit.
   *
   * Synchronous, and called as part of the commit rather than published on a
   * stream: a subscriber that had not started yet would miss the send, and a
   * node that missed an update would draw the input before last.
   */
  onInput(handle: (input: ReplViewData) => void): void;
  /** Join the focus chain. A node that never asks is never focusable. */
  focusable(): void;
  /** Whether this node currently holds focus. */
  readonly focused: boolean;
  /** What this node contributes to a frame. Replaces its previous cell. */
  render(cell: string): void;
  /**
   * Claim events reaching this node or passing through it on the way up.
   *
   * Returning an action stops the walk and hands that action to the root;
   * returning nothing lets the next ancestor decide.
   */
  claim(decide: (event: ReplInputEvent) => Action | undefined): void;
}

/** What one kind of child is. Supplied to `component()`, kept private by it. */
export interface ReplDefinition<Action> {
  readonly name: string;
  /**
   * Construct this node: what it draws, what it claims, whether it can focus.
   *
   * Synchronous and effect-free. It runs once, during the commit that mounts
   * the node, and may return what to run when the node is removed. That
   * teardown is registered by the commit, so it is certain to run even for a
   * node removed before any ongoing work of its own had a turn to start.
   */
  attach(node: ReplNode<Action>): (() => void) | void;
  /**
   * The node's ongoing work, if it has any.
   *
   * Runs in a scope that ends when the node is removed or replaced, so what it
   * starts cannot outlive the branch. It may own Freedom work; `attach` may
   * not start any, which is what keeps the commit the only thing that grows
   * the tree.
   */
  lifetime?(node: ReplNode<Action>): Operation<void>;
}

/**
 * One kind of child, as a stable identity.
 *
 * The definition is behind a private field: a description names *this object*,
 * and two descriptions naming it are the same kind of child. Nothing outside
 * this module can read what it does or build one that looks like it.
 */
/**
 * One kind of child, as an opaque handle.
 *
 * It has no public members at all: what it holds is a private field, which is
 * invisible to property access, to `Object.keys`, to `getOwnPropertyNames` and
 * to serialization. The instance and its prototype are frozen, so nothing can
 * be shadowed onto it after it is issued — an `attach` replaced from outside
 * would be behavior the tree runs that the factory never approved.
 */
class Component<Action> {
  readonly #definition: ReplDefinition<Action>;

  constructor(definition: ReplDefinition<Action>) {
    this.#definition = definition;
    Object.freeze(this);
  }

  /** Read one component's definition. The composition implementation's seam. */
  static definitionOf<Action>(component: Component<Action>): ReplDefinition<Action> {
    return component.#definition;
  }

  /** Whether this value is a component this factory issued. */
  static issued(value: unknown): value is Component<never> {
    return typeof value === "object" && value !== null && #definition in value;
  }
}

Object.freeze(Component.prototype);

/**
 * One kind of child, as a stable identity.
 *
 * Exported as a type and not as a value: there is no constructor to reach and
 * no static to call. `component()` is the only way to make one.
 */
export type ReplComponent<Action> = Component<Action>;

/**
 * What one component does, for the composition implementation.
 *
 * The seam the reconciler reads through. It takes a handle this factory
 * issued — nothing else has the private field — so a plain object shaped like
 * a component cannot be run through it.
 */
export function readComponent<Action>(component: ReplComponent<Action>): ReplDefinition<Action> {
  if (!Component.issued(component)) {
    throw new ReplDescriptionError(
      "this is not a component this tree issued. Build one with component().",
    );
  }
  return Component.definitionOf(component);
}

/** Issue one component identity. The only way to make one. */
export function component<Action>(definition: ReplDefinition<Action>): ReplComponent<Action> {
  if (typeof definition.name !== "string" || definition.name.length === 0) {
    throw new ReplDescriptionError("a component is defined with a name.");
  }
  if (typeof definition.attach !== "function") {
    throw new ReplDescriptionError(
      `the component ${definition.name} has no way to construct a node.`,
    );
  }
  // Frozen before it is stored. `readonly` is a statement to a compiler; what
  // stops `Reflect.set` from replacing the stored `attach` — and the issued
  // component from then running behavior nobody approved — is the freeze.
  return new Component(
    Object.freeze({
      name: definition.name,
      attach: definition.attach,
      ...(definition.lifetime === undefined ? {} : { lifetime: definition.lifetime }),
    }),
  );
}

/** What a description holds. Never exported, so nothing else can build one. */
interface Described<Action> {
  readonly key: string;
  readonly component: ReplComponent<Action>;
  readonly input: ReplViewData;
  readonly placement: ReplPlacement;
  readonly children: readonly ReplDescription<Action>[];
  /** Whether mounting this node pushes a modal focus root. */
  readonly modal: boolean;
  /** Whether this node asks to hold focus once mounted. */
  readonly focus: boolean;
}

/**
 * One immutable description of one child.
 *
 * Opaque: it has no readable members, and its contents are behind a private
 * field that only this module's reader reaches. A structurally similar plain
 * object is not one — TypeScript refuses it, and `ReplDescription.read` says
 * so at runtime.
 */
/**
 * One description, as an opaque handle.
 *
 * No public members, a private field that reflection cannot reach, and frozen
 * on the way out — so what a holder can do with one is hand it back, and
 * nothing it does can change what the tree reads.
 */
class Description<Action> {
  readonly #described: Described<Action>;

  constructor(described: Described<Action>) {
    this.#described = described;
    Object.freeze(this);
  }

  /** What this description says. The composition implementation's seam. */
  static contentsOf<Action>(description: Description<Action>): Described<Action> {
    return description.#described;
  }

  /**
   * Whether this value is a description this factory issued.
   *
   * A private field is what makes the answer unforgeable: a plain object of
   * the same shape does not have one, however carefully it was built.
   */
  static issued(value: unknown): value is Description<never> {
    return typeof value === "object" && value !== null && #described in value;
  }
}

Object.freeze(Description.prototype);

/**
 * One immutable description of one child.
 *
 * Exported as a type and not as a value: there is no constructor to reach, no
 * static issuer and no reader that takes an arbitrary value and hands its
 * contents back. `describe()` is the only way to make one, and everything a
 * reader can see is read-only.
 */
export type ReplDescription<Action> = Description<Action>;

/** What one description says, for the composition implementation. */
export interface ReplDescribedView<Action> {
  readonly key: string;
  readonly component: ReplComponent<Action>;
  readonly input: ReplViewData;
  readonly placement: ReplPlacement;
  readonly children: readonly ReplDescription<Action>[];
  readonly modal: boolean;
  readonly focus: boolean;
}

/**
 * Read one description. The seam the reconciler reads through.
 *
 * It takes a handle this factory issued; anything else is refused rather than
 * unwrapped, so there is no route from a look-alike object to a mounted node.
 */
export function readDescription<Action>(
  description: ReplDescription<Action>,
): ReplDescribedView<Action> {
  if (!Description.issued(description)) {
    throw new ReplDescriptionError(
      "this is not a description this tree issued. Build one with describe().",
    );
  }
  return Description.contentsOf(description);
}

/** What a set of descriptions could not be admitted for. */
export class ReplDescriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplDescriptionError";
  }
}

/**
 * Describe one child.
 *
 * The input is detached as it is read — copied member by member and frozen as
 * the copy is built — so what the description holds is its own and what the
 * caller holds stays theirs, mutable and unaffected either way.
 */
export function describe<Action>(description: {
  key: string;
  component: ReplComponent<Action>;
  input: ReplViewData;
  placement?: ReplPlacement;
  children?: readonly ReplDescription<Action>[];
  /** Mount this node as a modal focus root while it exists. */
  modal?: true;
  /** Ask for focus once this node is mounted. */
  focus?: true;
}): ReplDescription<Action> {
  if (!Component.issued(description.component)) {
    // Reached from an untyped boundary: a plain object with the right members
    // is not a component this factory issued, and running its `attach` would
    // be running behavior nothing approved.
    throw new ReplDescriptionError(
      `the component for ${description.key} is not one this tree issued. Build one with ` +
        "component().",
    );
  }
  // The record itself as well as each list and value inside it: the seam hands
  // this exact object to the reconciler, so anything left writable on it is
  // writable by whoever else can reach the seam.
  return new Description<Action>(
    Object.freeze({
      key: description.key,
      component: description.component,
      input: detach(description.input),
      placement: Object.freeze({ ...(description.placement ?? {}) }),
      children: Object.freeze([...(description.children ?? [])]),
      modal: description.modal === true,
      focus: description.focus === true,
    }),
  );
}

/**
 * One value, copied out of whatever the caller holds and frozen.
 *
 * Copied rather than frozen in place: a description that froze its caller's
 * object would make somebody else's data immutable as a side effect of being
 * described, and one that merely referenced it would change when they did.
 *
 * Only view data crosses. A function, a symbol or a class instance is refused
 * rather than smuggled through as an escape hatch out of the frozen tree.
 */
export function detach(value: unknown): ReplViewData {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") {
    throw new ReplDescriptionError(
      `a ${typeof value} cannot be a component's input: only view data crosses into the tree.`,
    );
  }
  if (Array.isArray(value)) {
    const copied: ReplViewData[] = [];
    for (const member of value) {
      copied.push(detach(member));
    }
    Object.freeze(copied);
    return copied;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    // The static type already forbids this at `describe()`; the check is for a
    // value that arrived through `unknown`. An instance would carry behavior
    // into a tree whose whole claim is that it holds values.
    throw new ReplDescriptionError(
      "only a plain object can be a component's input: an instance would carry behavior " +
        "into a tree that is supposed to hold view data.",
    );
  }
  const copied: { [key: string]: ReplViewData } = {};
  for (const [key, member] of Object.entries(value)) {
    Object.defineProperty(copied, key, {
      value: detach(member),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  Object.freeze(copied);
  return copied;
}

/** Where a description sits, for a refusal a reader can act on. */
function at(path: readonly string[]): string {
  return path.length === 0 ? "the root" : path.join("/");
}

/**
 * Judge a complete desired sibling set, and everything under it, before
 * anything is mounted.
 *
 * All of it, not the part reached so far: a reconciler that validated as it
 * walked would already have mounted half a tree by the time it found the
 * duplicate key at the end, and the previous tree would be neither the old one
 * nor the new one.
 */
export function validateDescriptions(
  descriptions: readonly unknown[],
  placementsAllowed: (placement: ReplPlacement, parent: string) => boolean = () => true,
): Result<void> {
  const found: Found = { claims: 0, modals: [], focus: undefined };
  const judged = walk(descriptions, [], placementsAllowed, found);
  if (!judged.ok) {
    return judged;
  }

  // Focus and modality are one question, not two counted separately. A claim
  // outside the innermost modal is a claim Freedom will refuse the moment it
  // is made, and by then the whole new tree is mounted — so it is refused
  // here, before anything is attached.
  const innermost = found.modals.reduce<string[] | undefined>(
    (deepest, path) => (deepest === undefined || path.length > deepest.length ? path : deepest),
    undefined,
  );
  if (found.focus !== undefined && innermost !== undefined && !encloses(innermost, found.focus)) {
    return Err(
      new ReplDescriptionError(
        `${at(found.focus)} claims focus and ${at(innermost)} is the open modal, which does not ` +
          "contain it. Only what the innermost modal contains can be focused while it is open.",
      ),
    );
  }
  return Ok(undefined);
}

/** What one walk has found so far, across the whole described set. */
interface Found {
  claims: number;
  modals: string[][];
  focus: string[] | undefined;
}

/**
 * `unknown`, deliberately.
 *
 * Judging whether a value is a description at all is this function's first
 * job, so it takes what a caller actually has rather than a type that has
 * already assumed the answer.
 */
function walk(
  descriptions: readonly unknown[],
  path: readonly string[],
  placementsAllowed: (placement: ReplPlacement, parent: string) => boolean,
  found: Found,
): Result<void> {
  const seen = new Set<string>();
  for (const description of descriptions) {
    if (!Description.issued(description)) {
      return Err(
        new ReplDescriptionError(
          `a child of ${at(path)} is not a description this tree issued. Build one with ` +
            "describe().",
        ),
      );
    }
    const described = Description.contentsOf(description);
    if (typeof described.key !== "string" || described.key.length === 0) {
      return Err(
        new ReplDescriptionError(`a child of ${at(path)} has no key, so nothing identifies it.`),
      );
    }
    if (seen.has(described.key)) {
      return Err(
        new ReplDescriptionError(
          `${at(path)} describes two children keyed ${described.key}, so which one a mounted ` +
            "node belongs to cannot be decided.",
        ),
      );
    }
    seen.add(described.key);

    if (!placementsAllowed(described.placement, at(path))) {
      return Err(
        new ReplDescriptionError(
          `${at([...path, described.key])} carries a placement ${at(path)} does not accept.`,
        ),
      );
    }
    const here = [...path, described.key];
    if (described.modal) {
      // Two modal roots on branches neither of which contains the other are a
      // stack with no order: Freedom pops in reverse, and nothing says which
      // of two siblings is on top.
      for (const other of found.modals) {
        if (!encloses(other, here) && !encloses(here, other)) {
          return Err(
            new ReplDescriptionError(
              `${at(here)} and ${at(other)} are both modal and neither contains the other, so ` +
                "there is no order to push or pop them in.",
            ),
          );
        }
      }
      found.modals.push(here);
    }
    if (described.focus) {
      found.claims++;
      found.focus = here;
      if (found.claims > 1) {
        return Err(
          new ReplDescriptionError(
            "two descriptions claim focus, and exactly one mounted ancestry can win it.",
          ),
        );
      }
    }

    const nested = walk(described.children, here, placementsAllowed, found);
    if (!nested.ok) {
      return nested;
    }
  }
  return Ok(undefined);
}

/**
 * One input read as named members, or none when it is not an object.
 *
 * A component narrows what it was given through this rather than by asserting
 * a shape: input is view data, and view data is whatever the parent described.
 */
export function fields(input: ReplViewData): { readonly [key: string]: ReplViewData } | undefined {
  if (input === null || input === undefined || typeof input !== "object") {
    return undefined;
  }
  return listed(input) ? undefined : input;
}

/** Whether this view object is a list. A predicate, so the narrowing is real. */
function listed(
  input: readonly ReplViewData[] | { readonly [key: string]: ReplViewData },
): input is readonly ReplViewData[] {
  return Array.isArray(input);
}

/** Whether `outer` is `inner` itself or one of its ancestors. */
function encloses(outer: readonly string[], inner: readonly string[]): boolean {
  if (outer.length > inner.length) {
    return false;
  }
  return outer.every((segment, index) => segment === inner[index]);
}
