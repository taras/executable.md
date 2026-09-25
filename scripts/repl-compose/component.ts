/**
 * What a parent says its children are.
 *
 * A component description is a value, not a mounted thing: a key, the component
 * to run, and the immutable input to run it on. A parent produces the
 * descriptions of its *direct* children from its own input and nothing else —
 * it does not reach into a registry, ask what is mounted, or hand a child a way
 * to register itself. That is the whole boundary, and it is what lets the tree
 * be decided before anything exists.
 *
 * Crank is the model. A component is a function of its input; a keyed child
 * matched across an update keeps its identity and its local state; a child that
 * stops being described is unmounted with everything below it. What is not
 * borrowed is Crank's runtime, because a second mounted component-context tree
 * beside Freedom is exactly the duplication this experiment exists to remove.
 * Here the description is reconciled *into* Freedom, and a Freedom node is the
 * only thing that gets mounted.
 *
 * **One description, one input.** A description does not carry its input where
 * anything can reach it. Everything the input decides — the children, what is
 * drawn, what a key means, and what a retained branch is told next — is a
 * closure over the same captured value, made in one call, and a description is
 * a class with a private field so no object can be assembled that looks like
 * one. An earlier version exposed `input: unknown` beside those closures, and a
 * spread could then replace it: `{ ...describe(Probe, "probe", 2), input: 3 }`
 * type-checked, and produced a mounted component whose lifecycle acted on 3
 * while it drew 2. One component, two inputs, and nothing to detect it.
 *
 * The typed channel that replaces it is reached without a cast, without
 * bivariance and without any table: a component carries its own
 * `NodeDataKey<Handoff<Input>>`, minted when the component is built, and a
 * branch keeps its update channel on its own node under that key. Reading it
 * back is `node.data.get(component.updates)`, which the compiler already knows
 * is a `Handoff<Input>`.
 */

import type { Operation } from "effection";
import { createNodeData } from "../repl-study/vendor/freedom/upstream/index.ts";
import type { Node, NodeDataKey } from "../repl-study/vendor/freedom/upstream/index.ts";

import type { Frames } from "./frames.ts";
import { createHandoff } from "./handoff.ts";
import type { Handoff, Receiver } from "./handoff.ts";
import type { Action, KeyPress } from "./input.ts";

/**
 * A component's identity is the component value itself.
 *
 * Nothing mints an id and nothing remembers one: reconciliation compares the
 * component a description names by reference. A table of components keyed by
 * name would be a registry beside the tree, and it would answer a question —
 * "which component is this?" — that the description already answers.
 */
export type ComponentIdentity = object;

/** Where a branch waits for the input its parent hands it next. */
export interface Updates<Input> {
  receive(): Operation<Receiver<Input>>;
}

/** What a mounted branch is given: its own node, its input, and the operational APIs. */
export interface Mounted<Input> {
  /** This branch's Freedom node. Its scope owns everything the branch holds. */
  readonly node: Node;
  /** The input this branch was mounted on. Later input arrives on `updates`. */
  readonly input: Input;
  /** The one host frame stream, and the demand this branch may place on it. */
  readonly frames: Frames;
  /**
   * Later input for this same branch, handed down by its parent.
   *
   * A retained branch keeps its node and its local state, so it has to be told
   * what changed rather than rebuilt. This is that channel, and it crosses the
   * direct parent-child boundary like the first input did: nothing ambient,
   * nothing to look up, and nothing to poll. Taking the next input reports that
   * the previous one was applied, so the reconcile that delivered it does not
   * return until this branch has acted on it.
   */
  readonly updates: Updates<Input>;
  /**
   * Say that this branch's local state exists.
   *
   * The reconcile that mounted the branch waits here before it returns, so a
   * caller never observes a tree whose new branches have not finished setting
   * themselves up. A lifecycle that ends without calling it does not hang the
   * mount — finishing releases the same gate — but then nothing it did was
   * guaranteed to be visible.
   */
  ready(): Operation<void>;
}

/**
 * What one component is, before it is given the channel key its branches use.
 *
 * A member is optional when its absence is the neutral element of a
 * composition, and required when its absence would substitute a claim. Absent
 * `onPress` means this component says nothing about a key, so the key carries
 * on to the branch that does understand it — which is what would have happened
 * anyway, and is why writing `onPress: () => undefined` on every leaf is noise.
 * Absent `children` would instead be the reconciler deciding this component has
 * no subtree, and a `children` misspelled, renamed or lost in a merge would
 * mount a tree missing a branch with nothing to report. That one costs a line.
 *
 * `lifecycle` is written `null` rather than left out, because whether a branch
 * holds anything disposable decides whether a task is started for it at all.
 * Absence there is a value the author chose, the same distinction the engine's
 * own prop boundary draws between an omitted prop and one written `null`.
 */
export interface ComponentSpec<Input> {
  readonly name: string;
  /** The direct children this input describes, in the order they appear. */
  children(input: Input): readonly Description[];
  /** Disposable local state and subscriptions, or `null` for a branch with none. */
  readonly lifecycle: ((mounted: Mounted<Input>) => Operation<void>) | null;
  /** Whether this component is a focus target of its own. */
  readonly focusable: boolean;
  /** The semantic action this input gives a key. Absent means: pass it on. */
  onPress?(input: Input, key: KeyPress): Action | undefined;
  /** What this component draws, around what its children drew. */
  present(input: Input, children: readonly string[]): readonly string[];
}

/** One component, with the typed channel its branches are updated through. */
export interface Component<Input> extends ComponentSpec<Input> {
  /**
   * Where a branch of this component keeps the channel its parent updates it
   * through.
   *
   * Minted with the component and carried on it — metadata an author declares
   * about a value they own, rather than an entry in a collection somebody has
   * to keep. It is what makes delivering later input a typed read of this
   * branch's own node instead of an erased payload the reconciler carries.
   */
  readonly updates: NodeDataKey<Handoff<Input>>;
}

/** Build one component, minting the channel key its branches will use. */
export function component<Input>(spec: ComponentSpec<Input>): Component<Input> {
  return {
    ...spec,
    updates: createNodeData<Handoff<Input>>(`xmd:repl-compose:${spec.name}:updates`),
  };
}

interface DescribedParts {
  children(): readonly Description[];
  start(node: Node, frames: Frames, ready: () => Operation<void>): Operation<void> | undefined;
  update(node: Node): Operation<void>;
  onPress(key: KeyPress): Action | undefined;
  present(children: readonly string[]): readonly string[];
}

/**
 * A parent's statement that one keyed child exists, on the input it runs on.
 *
 * Not exported as a value, and holding a private field, so the only thing that
 * can make one is `describe()`. Its input is captured, never carried: there is
 * no member to replace, and so no way to leave a mounted component acting on
 * one input while it draws another.
 */
class DescribedChild {
  readonly #parts: DescribedParts;

  constructor(
    readonly key: string,
    readonly name: string,
    readonly identity: ComponentIdentity,
    readonly focusable: boolean,
    parts: DescribedParts,
  ) {
    this.#parts = parts;
  }

  /** The children this description's own input describes. */
  children(): readonly Description[] {
    return this.#parts.children();
  }

  /** Start this branch, or nothing when the component holds nothing disposable. */
  start(node: Node, frames: Frames, ready: () => Operation<void>): Operation<void> | undefined {
    return this.#parts.start(node, frames, ready);
  }

  /**
   * Hand a retained branch the input this description was made with.
   *
   * The reconciler calls it only after the node's identity matched this
   * description's component, and what it reaches is that component's own typed
   * channel on that node — so the value delivered is the one this description
   * captured, and it can be no other.
   */
  update(node: Node): Operation<void> {
    return this.#parts.update(node);
  }

  onPress(key: KeyPress): Action | undefined {
    return this.#parts.onPress(key);
  }

  present(children: readonly string[]): readonly string[] {
    return this.#parts.present(children);
  }
}

export type Description = DescribedChild;

/**
 * Declare one keyed child.
 *
 * The input is captured here and read nowhere else, so a component can only
 * ever see what its parent handed it — and every behaviour that input decides
 * is a closure made in this one call.
 */
export function describe<Input>(
  component: Component<Input>,
  key: string,
  input: Input,
): Description {
  const lifecycle = component.lifecycle;
  return new DescribedChild(key, component.name, component, component.focusable, {
    children: () => component.children(input),

    start:
      lifecycle === null
        ? () => undefined
        : (node, frames, ready) => {
            const updates = createHandoff<Input>();
            node.data.set(component.updates, updates);
            return lifecycle({ node, input, frames, ready, updates });
          },

    *update(node: Node): Operation<void> {
      const updates = node.data.get(component.updates);
      if (updates !== undefined) {
        yield* updates.deliver(input);
      }
    },

    onPress: (key) => component.onPress?.(input, key),
    present: (children) => component.present(input, children),
  });
}
