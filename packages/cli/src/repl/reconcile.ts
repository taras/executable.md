/**
 * Turning described children into one mounted tree, and nothing else into one.
 *
 * Freedom owns the only mounted lifetime tree here. A node exists because a
 * description named it, it keeps its identity and its running lifetime for as
 * long as its parent keeps describing it under the same key and type, and when
 * it stops being described the node, its scope, its focus, its input and its
 * contribution to a frame all go away together. There is no second tree, no
 * registry keyed by id and no map that could still hold a component the tree no
 * longer does.
 *
 * ## The order of a commit is the contract
 *
 * Validate the whole desired set first, over every descendant, and refuse
 * without touching anything — a reconciler that mutated as it walked would
 * leave a tree that is neither the old one nor the new one when it met a
 * duplicate key at the end. Then add and update before removing, so a branch
 * that is being replaced never leaves the region empty and focus always has
 * somewhere valid to land. Then set canonical order, so the order children were
 * described in is what shows, rather than the order they happened to be
 * created in.
 *
 * ## What a component may own
 *
 * A component's lifetime runs in its own node's scope and may own Freedom work.
 * What it renders is a value it hands over, not a callback the renderer calls
 * back into — a render body that could create a node would be a second way for
 * the tree to grow, outside the only commit that is allowed to grow it.
 */

import { Err, Ok, action, ensure, until, useScope } from "effection";
import type { Operation, Result, Scope, Task } from "effection";

import {
  createNodeData,
  current,
  focus,
  focusable,
  focusPush,
  useFocus,
  useRoot,
} from "./vendor/freedom/patched/index.ts";
import type { Node, NodeDataKey, PopFocus, Root } from "./vendor/freedom/patched/index.ts";
import { readComponent, readDescription, validateDescriptions } from "./description.ts";
import {
  arrowTarget,
  focusLayout,
  homeTarget,
  isNavigationKey,
  regionTarget,
  survivorTarget,
} from "./focus-navigation.ts";
import type { ReplFocusLayout, ReplPlacement, ReplStop } from "./focus-navigation.ts";
import type {
  ReplComponent,
  ReplDescription,
  ReplInputEvent,
  ReplNode,
  ReplLayout,
  ReplViewData,
} from "./description.ts";

/** An event reached a live node and nothing handled it. */
export class ReplUnownedEventError extends Error {
  constructor(ancestry: readonly string[]) {
    super(
      `a normalized event reached the root through ${ancestry.length} node(s) and nothing ` +
        "claimed it. An action nobody owns is a gap in the tree, not something to swallow.",
    );
    this.name = "ReplUnownedEventError";
  }
}

/** What one mounted node holds. Node-relative, and gone when the node is. */
interface Mounted<Action> {
  key: string;
  component: ReplComponent<Action>;
  input: { value: ReplViewData };
  layout: ReplLayout;
  onInput: { handle: ((input: ReplViewData) => void) | undefined };
  detach: { run: (() => void) | undefined };
  /** The bound pop of this node's modal focus root, when it pushed one. */
  pop: { release: PopFocus | undefined };
  /** Whether the description that last named this node asked for focus. */
  claimsFocus: boolean;
  /** Whether the description that last named this node asked to be modal. */
  modal: boolean;
  /** Where the description that last named this node placed it in navigation. */
  navigation: ReplPlacement | undefined;
  /**
   * What held focus when this node's modal root was pushed, and where it sat.
   *
   * Freedom restores that exact control when the root pops. Where it has gone in
   * the meantime, this is what the survivor is chosen from — rather than the
   * first control anywhere on the screen.
   */
  opened: { readonly focused: string; readonly layout: ReplFocusLayout } | undefined;
  /** Set at the commit boundary: this node is on its way out. */
  retiring: boolean;
  cell: { text: string | undefined };
  claim: { decide: ((event: ReplInputEvent) => Action | undefined) | undefined };
}

// deno-lint-ignore no-explicit-any
const MOUNTED: NodeDataKey<Mounted<any>> = createNodeData("executablemd.repl.mounted");

/** One committed frame: what each mounted node contributed, in mounted order. */
export interface ReplFrame {
  readonly id: number;
  readonly cells: readonly { readonly node: string; readonly cell: string }[];
}

/**
 * What delivering one normalized event did.
 *
 * Closed, so every outcome has to be handled and none of them is the absence
 * of another: an action a node produced, a focus move the tree itself owns, or
 * an event that never reached a live node at all. An event that reached one
 * and nothing handled is not in here — that is an `Err`.
 */
export type ReplDispatched<Action> =
  | {
      readonly outcome: "action";
      readonly action: Action;
      /** The node ids the event passed through, target first. */
      readonly ancestry: readonly string[];
    }
  | { readonly outcome: "focus"; readonly focused: string | undefined }
  | { readonly outcome: "dropped"; readonly reason: string };

/** The mounted tree, as the application drives it. */
export interface ReplTree<Action> {
  /**
   * Judge a set without mounting it.
   *
   * The same whole-set judgment `apply()` makes, asked ahead of time: what is
   * described, whether two children share a key, whether two request focus and
   * whether a focus request sits inside the open modal. It attaches, updates,
   * draws and removes nothing, moves focus nowhere and leaves the frame where
   * it was.
   *
   * Synchronous, because judging a described set reads nothing but the set.
   *
   * An `Ok` is an answer about these values, not a reservation: nothing is
   * held, and `apply()` judges whatever it is actually given rather than
   * trusting that it was asked about first.
   */
  validate(descriptions: readonly ReplDescription<Action>[]): Result<void>;
  /** Reconcile the root's children to exactly this set. */
  apply(descriptions: readonly ReplDescription<Action>[]): Operation<Result<void>>;
  /** The frame the tree contributes as it stands. */
  frame(): ReplFrame;
  /**
   * Deliver one normalized event.
   *
   * The only way in. Focus traversal arrives the same way an activation does,
   * because a host that could move focus directly would be a second input path
   * with its own rules — and one that a modal focus root would not contain.
   */
  dispatch(event: ReplInputEvent): Operation<Result<ReplDispatched<Action>>>;
  /** The id of the node holding focus, or none. */
  focused(): string | undefined;
  /** Every mounted node id, in canonical order, outermost first. */
  mounted(): readonly string[];
  /** The key path of one mounted node, for a test that wants to name it. */
  keyOf(id: string): string | undefined;
}

/**
 * Mount one tree owned by the calling scope.
 *
 * `useRoot()` rather than `createRoot()`: the tree belongs to whoever asked for
 * it, inherits that scope's contexts and is destroyed when it ends. A root
 * parented to Effection's global would outlive its owner and raise node
 * failures into a boundary nobody is watching.
 */
export function* useReplTree<Action>(): Operation<ReplTree<Action>> {
  const root: Root = yield* useRoot();
  const owner: Scope = yield* useScope();
  useFocus(root.node);
  let frameId = 0;

  /**
   * The modal focus roots that are pushed, outermost first.
   *
   * Kept centrally rather than per node because Freedom pops in reverse order
   * and throws on an out-of-order pop: which roots exist, and in what order,
   * is a property of the tree rather than of any one branch.
   */
  const modals: Node[] = [];

  /** Pop every modal root at or above `node`, innermost first. */
  function popThrough(node: Node): void {
    const at = modals.indexOf(node);
    if (at === -1) {
      return;
    }
    for (let index = modals.length - 1; index >= at; index--) {
      held(modals[index])?.pop.release?.();
      const state = held(modals[index]);
      if (state !== undefined) {
        state.pop.release = undefined;
      }
    }
    modals.length = at;
  }

  function held(node: Node): Mounted<Action> | undefined {
    return node.data.get(MOUNTED);
  }

  function mount(parent: Node, description: ReplDescription<Action>): Node {
    const described = readDescription(description);
    const definition = readComponent(described.component);
    const node = parent.createChild(definition.name);
    const state: Mounted<Action> = {
      key: described.key,
      component: described.component,
      input: { value: described.input },
      layout: described.layout,
      onInput: { handle: undefined },
      detach: { run: undefined },
      pop: { release: undefined },
      claimsFocus: described.focus,
      modal: described.modal,
      navigation: described.navigation,
      opened: undefined,
      retiring: false,
      cell: { text: undefined },
      claim: { decide: undefined },
    };
    node.data.set(MOUNTED, state);
    node.set("key", described.key);
    node.set("type", definition.name);

    const handle = handleFor(node, state);
    // Inside the commit, so what this node draws and claims is true the moment
    // the commit is acknowledged rather than a scheduler turn afterwards.
    const detach = definition.attach(handle);
    state.detach.run = typeof detach === "function" ? detach : undefined;

    // The ongoing half runs in the node's own scope, so it ends exactly when
    // the node is removed and nothing it started can outlive the branch.
    const lifetime = definition.lifetime;
    if (lifetime !== undefined) {
      node.scope.run(() => lifetime(handle));
    }
    return node;
  }

  function handleFor(node: Node, state: Mounted<Action>): ReplNode<Action> {
    return {
      id: node.id,
      key: state.key,
      get input() {
        return state.input.value;
      },
      get layout() {
        return state.layout;
      },
      onInput(handle: (input: ReplViewData) => void) {
        state.onInput.handle = handle;
      },
      focusable() {
        focusable(node);
      },
      get focused() {
        return node.props.focused === true;
      },
      render(cell: string) {
        state.cell.text = cell;
      },
      claim(decide) {
        state.claim.decide = decide;
      },
    };
  }

  function prepare(
    parent: Node,
    descriptions: readonly ReplDescription<Action>[],
    retiring: Node[],
  ): void {
    const existing = new Map<string, Node>();
    for (const child of parent.children) {
      const state = held(child);
      if (state !== undefined) {
        existing.set(state.key, child);
      }
    }

    // Added and updated first, removed after: a replacement exists before the
    // branch it replaces goes, so a region is never momentarily empty and focus
    // always has a valid survivor to move to.
    const kept = new Map<string, Node>();
    const ordered: Node[] = [];
    for (const description of descriptions) {
      const described = readDescription(description);
      const previous = existing.get(described.key);
      const state = previous === undefined ? undefined : held(previous);
      if (
        previous !== undefined &&
        state !== undefined &&
        state.component === described.component
      ) {
        state.input.value = described.input;
        state.layout = described.layout;
        state.claimsFocus = described.focus;
        // A preserved node whose modal intent changed pushes or pops in the
        // stack pass below, without losing the lifetime it already has.
        state.modal = described.modal;
        state.navigation = described.navigation;
        // Inside the commit: after it, the node draws the input it was just
        // given, not the one before it.
        state.onInput.handle?.(described.input);
        kept.set(described.key, previous);
        ordered.push(previous);
        prepare(previous, described.children, retiring);
        continue;
      }
      const node = mount(parent, description);
      ordered.push(node);
      prepare(node, described.children, retiring);
    }

    // Collected rather than removed here: preparation is synchronous, so the
    // tree reaches its new shape in one turn and no cancellation can leave it
    // halfway. Finishing with these branches is the tree's own work, after the
    // commit boundary.
    for (const [key, node] of existing) {
      if (kept.get(key) === node) {
        continue;
      }
      const departing = held(node);
      if (departing !== undefined) {
        departing.retiring = true;
      }
      for (const descendant of allBeneath(node)) {
        const beneath = held(descendant);
        if (beneath !== undefined) {
          beneath.retiring = true;
        }
      }
      retiring.push(node);
    }

    // Canonical order last, from the described positions rather than from the
    // order nodes happened to be created in.
    const positions = new Map<Node, number>();
    ordered.forEach((node, index) => positions.set(node, index));
    parent.sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
  }

  /**
   * Every mounted node beneath `node`, in ancestry order.
   *
   * A retiring node is not one: between the commit boundary and its teardown
   * it is still attached to Freedom's tree, and nothing outside this module
   * should see a node the commit has already accounted for as gone.
   */
  function walkMounted(node: Node, into: Node[]): Node[] {
    for (const child of node.children) {
      const state = held(child);
      if (state !== undefined && !state.retiring) {
        into.push(child);
      }
      walkMounted(child, into);
    }
    return into;
  }

  function findMounted(id: string): Node | undefined {
    return walkMounted(root.node, []).find((node) => node.id === id);
  }

  /**
   * Every focusable control the active focus root holds, in canonical order.
   *
   * The innermost pushed modal's when one is open, so nothing a drawer covers
   * is ever a destination.
   */
  function stops(): ReplStop[] {
    const active = modals[modals.length - 1] ?? root.node;
    return walkMounted(active, [])
      .filter((node) => "focused" in node.props)
      .map((node) => ({ id: node.id, placement: held(node)?.navigation }));
  }

  /** The id of the control holding focus, while it is one the commit keeps. */
  function holding(): string | undefined {
    const node = current(root.node);
    const state = held(node);
    return state === undefined || state.retiring ? undefined : node.id;
  }

  function focusId(id: string | undefined): void {
    const node = id === undefined ? undefined : findMounted(id);
    if (node !== undefined && "focused" in node.props) {
      focus(node);
    }
  }

  /**
   * Finish with the branches this commit retired.
   *
   * Owned by the tree rather than by the caller that asked for the commit: a
   * teardown that was started has to be finished, and a halted caller must not
   * leave a scope half unwound or a removal promise nobody is waiting on.
   */
  function* retire(retiring: readonly Node[]): Operation<void> {
    for (const node of retiring) {
      // Its modal root first, and everything pushed above it, so no entry is
      // left naming a node that is about to stop existing.
      popThrough(node);
      for (const descendant of [node, ...allBeneath(node)].reverse()) {
        const departing = held(descendant);
        if (departing === undefined) {
          continue;
        }
        departing.detach.run?.();
        departing.detach.run = undefined;
      }
      yield* until(node.remove());
    }
  }

  /** Every node beneath this one, retiring or not. */
  function allBeneath(node: Node, into: Node[] = []): Node[] {
    for (const child of node.children) {
      if (held(child) !== undefined) {
        into.push(child);
      }
      allBeneath(child, into);
    }
    return into;
  }

  /**
   * One commit at a time, and one outstanding retirement at a time.
   *
   * The lock keeps two commits from being halfway through one tree. `settling`
   * is the other half of the same rule: a caller halted while waiting for its
   * retirement releases the lock, and the next commit waits for that same
   * retirement before it touches anything.
   */
  let busy = false;
  const waiting: (() => void)[] = [];
  let settling: Task<void> | undefined;

  function take(): Operation<void> {
    return action<void>(function (resolve) {
      if (!busy) {
        busy = true;
        resolve();
        return () => {};
      }
      waiting.push(resolve);
      return () => {
        const at = waiting.indexOf(resolve);
        if (at !== -1) {
          waiting.splice(at, 1);
        }
      };
    });
  }

  function release(): void {
    const next = waiting.shift();
    if (next === undefined) {
      busy = false;
      return;
    }
    next();
  }

  // The tree does not finish while it still owes a teardown.
  yield* ensure(function* () {
    if (settling !== undefined) {
      yield* settling;
    }
  });

  /**
   * One commit, in two halves with a boundary between them.
   *
   * Everything up to the boundary is synchronous, so the tree reaches its new
   * shape in one turn and there is no halfway state a cancellation could leave
   * behind. The one suspension before it is the *previous* commit's
   * retirement: a caller cancelled there has mounted nothing, and the teardown
   * it was waiting for is still owned and still finishes.
   */
  function* commit(descriptions: readonly ReplDescription<Action>[]): Operation<Result<void>> {
    const outstanding = settling;
    if (outstanding !== undefined) {
      yield* outstanding;
    }

    const judged = validateDescriptions(descriptions);
    if (!judged.ok) {
      // Nothing has been touched: the whole set was judged before the first
      // node was created, so the previous tree is exactly what it was.
      return judged;
    }

    // Where focus was, in the structure it was in, before anything moves: if
    // the control holding it is retired here, the survivor is chosen from its
    // own neighbours rather than from whatever the new tree happens to start with.
    const was = holding();
    const before = was === undefined ? undefined : focusLayout(stops());

    const retiring: Node[] = [];
    prepare(root.node, descriptions, retiring);
    frameId++;

    // The modal stack, made equal to what is described, outermost first.
    // Pre-order is ancestry order, so an outer drawer is pushed before the
    // inner one it contains and popped after it.
    const wanted = walkMounted(root.node, []).filter((node) => held(node)?.modal === true);
    let reopened: { readonly focused: string; readonly layout: ReplFocusLayout } | undefined;
    while (
      modals.length > 0 &&
      (modals.length > wanted.length || modals[modals.length - 1] !== wanted[modals.length - 1])
    ) {
      reopened = held(modals[modals.length - 1])?.opened ?? reopened;
      popThrough(modals[modals.length - 1]);
    }
    let pushed = false;
    for (let index = modals.length; index < wanted.length; index++) {
      const state = held(wanted[index]);
      if (state !== undefined) {
        state.opened =
          was !== undefined && before !== undefined ? { focused: was, layout: before } : undefined;
        state.pop.release = focusPush(wanted[index]);
        modals.push(wanted[index]);
        pushed = true;
      }
    }

    // A description may claim focus, and exactly one can: the validator
    // refused the set otherwise. Focus intent is its own thing rather than a
    // member of the layout a parent chose, because the layout is opaque to
    // everyone but that parent and focus is the tree's.
    const mountedNodes = walkMounted(root.node, []);
    let claimed = false;
    for (const node of mountedNodes) {
      if (held(node)?.claimsFocus === true && "focused" in node.props) {
        focus(node);
        claimed = true;
      }
    }

    // Focus is derived from what is mounted rather than remembered across
    // commits. A claim says where it goes. A modal pushed here is entered at
    // its first region's fixed entry, not at whatever Freedom found first. A
    // popped modal hands focus back to its opener, or — where the opener has
    // gone — to the opener's own survivor. And a control retired here hands
    // focus to its survivor, so the first commit, a removal and a resize all
    // land somewhere chosen from where focus was.
    if (!claimed) {
      const now = stops();
      const after = focusLayout(now);
      if (pushed) {
        focusId(homeTarget(after, now));
      } else if (reopened !== undefined && !after.where.has(reopened.focused)) {
        focusId(survivorTarget(reopened.layout, after, now, reopened.focused));
      } else if (holding() === undefined) {
        focusId(
          was !== undefined && before !== undefined
            ? survivorTarget(before, after, now, was)
            : homeTarget(after, now),
        );
      }
    }

    // The commit boundary. What the tree shows is now the described set, and
    // what is left is finishing with the branches it replaced.
    //
    // The retirement clears itself rather than being cleared by whoever is
    // waiting on it. A caller halted here would otherwise put the slot back
    // while the teardown was still running, and the next commit — seeing
    // nothing outstanding — would overlap it.
    const retirement: Task<void> = owner.run(function* () {
      try {
        yield* retire(retiring);
      } finally {
        if (settling === retirement) {
          settling = undefined;
        }
      }
    });
    settling = retirement;
    yield* retirement;
    return Ok(undefined);
  }

  return {
    validate(descriptions: readonly ReplDescription<Action>[]): Result<void> {
      // The commit's own judgment, asked without committing. Nothing is taken
      // and nothing is recorded: a set judged here is judged again from the
      // values `apply()` receives, so an answer that has gone stale cannot let
      // anything through.
      return validateDescriptions(descriptions);
    },
    *apply(descriptions: readonly ReplDescription<Action>[]): Operation<Result<void>> {
      yield* take();
      try {
        return yield* commit(descriptions);
      } finally {
        release();
      }
    },
    frame(): ReplFrame {
      const cells: { node: string; cell: string }[] = [];
      for (const node of walkMounted(root.node, [])) {
        const text = held(node)?.cell.text;
        if (text !== undefined) {
          cells.push({ node: node.id, cell: text });
        }
      }
      return Object.freeze({ id: frameId, cells: Object.freeze(cells) });
    },
    // deno-lint-ignore require-yield
    *dispatch(event: ReplInputEvent): Operation<Result<ReplDispatched<Action>>> {
      // Focus traversal is the tree's, not a component's: Freedom owns the
      // chain, and a modal focus root is what keeps this inside the branch
      // that pushed it rather than reaching the tree underneath.
      if (event.kind === "key" && (event.key === "Backtab" || event.key === "Tab")) {
        const now = stops();
        focusId(regionTarget(focusLayout(now), now, holding(), event.key === "Tab" ? 1 : -1));
        const moved = current(root.node);
        const traversed: ReplDispatched<Action> = {
          outcome: "focus",
          focused: held(moved) === undefined ? undefined : moved.id,
        };
        return Ok(Object.freeze(traversed));
      }

      let target: Node | undefined;
      if (event.kind === "pointer" || event.kind === "wheel") {
        if (event.frame !== frameId) {
          return Ok(dropped("this pointer was resolved against a frame that is no longer drawn."));
        }
        target = findMounted(event.target);
        if (target === undefined) {
          return Ok(dropped("this pointer names a node the tree no longer holds."));
        }
        const modal = modals[modals.length - 1];
        if (modal !== undefined && !contains(modal, target)) {
          // The branch underneath a modal is mounted, and inaccessible. A
          // pointer that reached it would be the one way past a focus root.
          return Ok(dropped("this pointer names a node behind the open drawer."));
        }
      } else {
        const focusedNode = current(root.node);
        target = held(focusedNode) === undefined ? undefined : focusedNode;
        if (target === undefined) {
          return Ok(dropped("no mounted node holds focus."));
        }
      }

      // Target first, then each ancestor: the same walk whichever normalized
      // event arrived, which is what makes a key and a click on one control
      // mean one thing.
      const ancestry: string[] = [];
      let walk: Node | undefined = target;
      while (walk !== undefined) {
        const state = held(walk);
        if (state === undefined) {
          break;
        }
        ancestry.push(walk.id);
        const action = state.claim.decide?.(event);
        if (action !== undefined) {
          const claimed: ReplDispatched<Action> = {
            outcome: "action",
            action,
            ancestry: Object.freeze([...ancestry]),
          };
          return Ok(Object.freeze(claimed));
        }
        walk = walk.parent;
      }
      // Offered to the focused control first, so a field keeps its arrows for
      // its caret and a reading keeps them for scrolling. What nothing claimed
      // is navigation.
      if (event.kind === "key" && isNavigationKey(event.key)) {
        focusId(arrowTarget(focusLayout(stops()), target.id, event.key));
        const moved = current(root.node);
        const navigated: ReplDispatched<Action> = {
          outcome: "focus",
          focused: held(moved) === undefined ? undefined : moved.id,
        };
        return Ok(Object.freeze(navigated));
      }
      return Err(new ReplUnownedEventError(ancestry));
    },
    focused(): string | undefined {
      const node = current(root.node);
      return held(node) === undefined ? undefined : node.id;
    },
    mounted(): readonly string[] {
      return walkMounted(root.node, []).map((node) => node.id);
    },
    keyOf(id: string): string | undefined {
      return held(findMounted(id) ?? root.node)?.key;
    },
  };
}

function dropped<Action>(reason: string): ReplDispatched<Action> {
  const ignored: ReplDispatched<Action> = { outcome: "dropped", reason };
  return Object.freeze(ignored);
}

/** Whether `node` is `ancestor` itself or anywhere beneath it. */
function contains(ancestor: Node, node: Node): boolean {
  let walk: Node | undefined = node;
  while (walk !== undefined) {
    if (walk === ancestor) {
      return true;
    }
    walk = walk.parent;
  }
  return false;
}
