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
 * A description carries closures rather than a component plus a separately
 * typed input, so a parent can describe children of different input types in
 * one list without anything being cast. `identity` is what reconciliation
 * compares: two descriptions with the same key and the same component are the
 * same child, and two with the same key and different components are not.
 */

import type { Operation } from "effection";
import type { Node } from "../repl-study/vendor/freedom/upstream/index.ts";

import type { Frames } from "./frames.ts";
import { createHandoff } from "./handoff.ts";
import type { Receiver } from "./handoff.ts";
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
 * One component.
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
 *
 * `children` is pure — the same input describes the same children. `lifecycle`
 * is where anything disposable lives, and it runs for exactly as long as the
 * branch is mounted, because it runs in that node's own scope.
 */
export interface Component<Input> {
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

/** Where a branch waits for the input its parent hands it next. */
export interface Updates<Input> {
  receive(): Operation<Receiver<Input>>;
}

/**
 * Where a parent puts the input a retained branch should see next.
 *
 * Written with method syntax deliberately. A method parameter is bivariant in
 * TypeScript, which is what lets a branch keep a sink typed to its own input
 * while the reconciler holds it as this untyped shape — with no cast anywhere.
 * What makes that sound is the reconciler itself: it delivers into a sink only
 * after confirming the new description names the very component that made it,
 * so the value arriving is always of the type the sink was built for.
 */
export interface InputSink {
  accept(input: unknown): Operation<void>;
}

/** A started branch: the body to run, and where its parent hands it later input. */
export interface Branch {
  readonly body: Operation<void>;
  readonly sink: InputSink;
}

/** A parent's statement that one keyed child exists, with the input it runs on. */
export interface Description {
  readonly key: string;
  readonly name: string;
  readonly identity: ComponentIdentity;
  readonly focusable: boolean;
  /** The children this description's own input describes. */
  children(): readonly Description[];
  /** The immutable input this description carries, for its branch to be given. */
  readonly input: unknown;
  /** Start this branch, or nothing when the component holds nothing disposable. */
  start(node: Node, frames: Frames, ready: () => Operation<void>): Branch | undefined;
  onPress(key: KeyPress): Action | undefined;
  present(children: readonly string[]): readonly string[];
}

/**
 * Declare one keyed child.
 *
 * The input is captured here and read nowhere else, so a component can only
 * ever see what its parent handed it.
 */
export function describe<Input>(
  component: Component<Input>,
  key: string,
  input: Input,
): Description {
  const lifecycle = component.lifecycle;
  return {
    key,
    name: component.name,
    identity: component,
    focusable: component.focusable,
    input,
    children: () => component.children(input),
    start:
      lifecycle === null
        ? () => undefined
        : (node, frames, ready) => {
            const updates = createHandoff<Input>();
            return {
              body: lifecycle({ node, input, frames, ready, updates }),
              sink: { accept: updates.deliver },
            };
          },
    onPress: (key) => component.onPress?.(input, key),
    present: (children) => component.present(input, children),
  };
}
