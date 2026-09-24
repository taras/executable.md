/**
 * The REPL's interface, as the tree that owns focus.
 *
 * #839's first attempt kept a flat `FocusTarget[]` beside the interface and
 * rebuilt traversal order, ownership and restoration by hand. That is the
 * manual-focus problem Freedom exists to remove: a parallel list has to be kept
 * in step with the interface by whoever changes the interface, and every
 * opening and closing of a panel is another chance to forget.
 *
 * Here the hierarchy *is* the interface. A surface is a node, a scope panel
 * mounted inside it is a branch, a drawer is a branch pushed as the active
 * focus root, and a control is a leaf. Traversal order is tree order, computed
 * on demand. Closing a panel removes its branch, and its controls and their
 * middleware go with it through structured teardown — there is no second list
 * to update, because there is no second list.
 *
 * A control that is visible but disabled is still a node: the renderer draws it
 * and the `F1` map numbers it. It is simply never made focusable, so it cannot
 * enter the focus chain. That is Freedom's own distinction, not one this
 * harness invents.
 */

import { until } from "effection";
import type { Operation } from "effection";

import {
  advance,
  current,
  focus,
  focusable,
  focusPush,
  retreat,
  useFocus,
  useRoot,
} from "./vendor/freedom/upstream/index.ts";
import type { Node, PopFocus, Root } from "./vendor/freedom/upstream/index.ts";

import { drawerTargets, labelFor } from "./surfaces.ts";
import { activation, aimedAt, recordPath, ReplInputApi, sendInput } from "./input.ts";
import type { Delivery, ReplInput } from "./input.ts";
import { ReplActionApi, UnownedActionError } from "./actions.ts";
import type { ReplAction } from "./actions.ts";
import { attach, boxOf, placementOf, within } from "./component.ts";
import type { Placement, Presentation } from "./component.ts";
import {
  bindingsBody,
  controlBody,
  drawerBody,
  escapeBody,
  focusMapBody,
  headerBody,
  historyBody,
  inputBody,
  outletBody,
  refusalBody,
  rootBody,
  rulesBody,
  sessionsBody,
  surfaceBarBody,
  transcriptBody,
} from "./components.ts";
import type { DrawerView, HistoryView, InputView, ReplView, TranscriptView } from "./view.ts";
import { drawerSlots, inputSlot, transportSlots } from "./render.ts";
import type { Layout, Rect } from "./layout.ts";
import { isDrawerKind } from "./fixtures.ts";
import {
  animates,
  easeInOutCubic,
  SETTLED_SECONDS,
  TRANSITION_SECONDS,
  useFrames,
} from "./animation.ts";
import { applyAction, layoutOf, reverseTab } from "./store.ts";
import type { Key, ReduceContext, Reduction, ReplState, Size } from "./store.ts";
import { isRouteSurface, ROUTE_SURFACES, topDrawer } from "./route.ts";
import type { RouteSurface } from "./route.ts";
import type { Mutation } from "./mutations.ts";

/** A node's semantic identity is its name, so the tree is readable as evidence. */
export function identity(node: Node): string {
  return node.name;
}

/** Every node of the tree, in tree order. */
export function walk(node: Node): Node[] {
  const found: Node[] = [node];
  for (const child of node.children) {
    found.push(...walk(child));
  }
  return found;
}

/** True where a node may take focus: Freedom marks exactly those. */
export function isFocusable(node: Node): boolean {
  return "focused" in node.props;
}

export function find(root: Node, name: string): Node | undefined {
  return walk(root).find((node) => node.name === name);
}

/**
 * The surface a node belongs to, read by walking up the tree.
 *
 * The first attempt parsed this out of the identity string. The tree already
 * knows, and asking it cannot disagree with where the node actually is.
 */
export function surfaceOwning(node: Node): RouteSurface | undefined {
  for (let at: Node | undefined = node; at; at = at.parent) {
    const name = at.name;
    if (name.startsWith("region:")) {
      const region = name.slice("region:".length);
      if (isRouteSurface(region)) {
        return region;
      }
    }
  }
  return undefined;
}

export interface ReplTree {
  readonly root: Root;
  /** Bring the interface into line with a state, mounting and removing branches. */
  sync(state: ReplState, options?: SyncOptions): Operation<void>;
  /**
   * Hand every direct child its own view subtree and its placement.
   *
   * The root is a parent, so this is the root doing what every parent does. It
   * reaches its *own* children and no further: a drawer presents its own
   * contents, and no node's data is chosen by something walking the whole tree
   * from outside.
   */
  present(view: ReplView, layout: Layout, options?: PresentOptions): void;
  /**
   * Deliver one normalized input to the node it is aimed at.
   *
   * A key goes to whatever has focus; a pointer goes to the node drawn where it
   * landed. Either way it travels up that node's scope, and whatever action
   * survives to the root is adapted there — the one place a new state comes
   * from.
   */
  deliver(request: DeliverRequest): Delivered;
  /** The innermost node drawn over a cell, or nothing where none is. */
  hit(x: number, y: number): Node | undefined;
  /** Where focus is, asked of the tree. */
  focused(): Node;
  advance(): void;
  retreat(): void;
  /** Every node the `F1` overlay numbers, in tree order. */
  map(): Node[];
  /** The focus chain: visible, enabled, and in tree order. */
  chain(): Node[];
}

export interface DeliverRequest {
  readonly state: ReplState;
  readonly input: ReplInput;
  /** Where focus is is the tree's own answer, so it is not asked for. */
  readonly context: Omit<ReduceContext, "focused">;
}

export interface Delivered {
  readonly delivery: Delivery;
  /**
   * What an action left, when one was dispatched and the root adapted it.
   *
   * Absent where nothing owned the input at all, which is the only case the
   * store's own fallback may read.
   */
  readonly reduction?: Reduction;
}

export interface SyncOptions {
  readonly mutation?: Mutation;
  /**
   * The terminal this interface is composed for, when it has changed.
   *
   * Topology follows the composition: what a profile does not compose has no
   * branch in the tree. Left out, the size is the one the interface already
   * has, because most syncs are not resizes.
   */
  readonly size?: Size;
}

export interface PresentOptions {
  readonly anchor?: number;
  readonly mutation?: Mutation;
  /**
   * The moment on screen is being played into rather than cut to.
   *
   * It carries where the motion starts, because which two moments they are is a
   * fact only the thing that chose them knows. How far along it is, and what
   * that looks like, belongs to the components.
   */
  readonly transition?: { readonly fromHeadAt: number };
  /** Ordinary UI state: whether F1 has been pressed. Nothing about focus. */
  readonly overlay?: boolean;
}

/**
 * The presentations the root retains for its own children.
 *
 * Each one was written by the lifecycle that created the node it places, and
 * the root holds them because the root is that lifecycle. A drawer's is looked
 * up among the drawers this tree mounted, not off the node.
 */
/** What the root tells the transcript, beyond its own view. */
interface TranscriptPresentation {
  readonly view: TranscriptView;
  readonly anchor: number;
  readonly mutation?: Mutation;
  readonly transition?: { readonly fromHeadAt: number };
}

/** What the root tells the Execution History band, beyond its own view. */
interface HistoryPresentation {
  readonly view: HistoryView;
  readonly mutation?: Mutation;
  readonly transition?: { readonly fromHeadAt: number };
}

interface Owned {
  readonly input: Presentation<InputView>;
  readonly transcript: Presentation<TranscriptPresentation>;
  readonly history: Presentation<HistoryPresentation>;
  readonly drawer: (node: Node) => Presentation<DrawerPresentation> | undefined;
}

/**
 * What the composition tells a drawer.
 *
 * `escape` is the box the way out is drawn over. The root composed both the
 * drawer and the band, so the root is what knows where the band is; the drawer
 * decides that its own escape child sits there.
 */
interface DrawerPresentation {
  readonly view: DrawerView;
  readonly escape: Rect | undefined;
}

interface Mounted {
  readonly node: Node;
  /** Assigned after the way out exists, so the trap has something to land on. */
  pop?: PopFocus;
  /** True while this drawer was mounted as a recorded, read-only one. */
  readonly historical: boolean;
  /** The drawer's own presentation of its own children, kept by its lifecycle. */
  readonly present: Presentation<DrawerPresentation>;
  /**
   * The way out, while the composition draws the band it leads to.
   *
   * Absent at the narrow profile, where the drawer owns the whole screen and
   * there is no Execution History band on it. A target whose destination is not
   * composed is one Tab reaches and nothing shows, so it is not mounted at all
   * — no node, no place in the ring, no middleware.
   */
  escape?: Node;
}

/**
 * Build the interface once, then keep it in step.
 *
 * Nothing here rebuilds the tree from scratch. A rebuild would destroy every
 * node each frame and take focus with it, which is the defect a live tree
 * exists to avoid.
 */
export function useReplTree(state: ReplState, composed: Size): Operation<ReplTree> {
  return {
    *[Symbol.iterator]() {
      let size = composed;
      // One clock for the whole interface. The host installs it; a caller that
      // mounts a tree without one gets a service of its own, which is what a
      // capture wants — time supplied rather than measured.
      const frames = yield* useFrames();
      const root = yield* useRoot();
      // Chrome the composition draws around the panes. These are nodes so that
      // rendering order is the tree's, not a sequence written out in one
      // function — but they take no focus, so the ring is unchanged.
      for (const name of ["chrome:surface-bar", "chrome:header"]) {
        root.node.createChild(name).set("container", true);
      }
      const regions = new Map<string, Node>();
      for (const region of ROUTE_SURFACES) {
        const node = root.node.createChild(`region:${region}`);
        focusable(node);
        recordPath(node, node.name);
        regions.set(region, node);
      }
      // Drawn after the panes, so they land on top of what they describe.
      for (const name of ["chrome:rules", "chrome:focus-map"]) {
        root.node.createChild(name).set("container", true);
      }
      useFocus(root.node);

      // Each band places its own controls. These closures hold the node this
      // lifecycle created — which is what a lifecycle may do and a render body
      // may not — and they are kept here, so presenting a child is always the
      // parent running its own code rather than something looked up on a node.
      const transcriptNode = regions.get("transcript")!;
      const inputRegionNode = regions.get("input")!;
      const presentInput: Presentation<InputView> = (_input, placement) => {
        const cell = inputSlot(placement);
        for (const control of inputRegionNode.children) {
          attach(control, controlBody, undefined, within(placement, cell));
        }
      };
      const historyRegionNode = regions.get("history")!;

      /**
       * The transcript's own arrival, and the playhead's own travel.
       *
       * Both are this component's to keep: how far along they are lives here,
       * in variables nothing outside can see, advanced by the one clock the
       * host runs. Their bodies are handed the resulting number and nothing
       * else — not the clock, not the two moments, not how long it takes.
       */
      type Phase = "still" | "running" | "arrived";
      let reveal = 1;
      let revealPhase: Phase = "still";
      let revealed = 0;
      let revealWant: (() => void) | undefined;
      const releaseReveal = (): void => {
        revealWant?.();
        revealWant = undefined;
      };
      animates(transcriptNode, frames, ({ deltaSeconds }) => {
        if (revealPhase !== "running") {
          return;
        }
        revealed += deltaSeconds;
        reveal = easeInOutCubic(Math.min(1, revealed / TRANSITION_SECONDS));
        if (revealed >= TRANSITION_SECONDS - SETTLED_SECONDS) {
          // Arrived, and it stays arrived: the transition is still being
          // supplied on every frame after this one, and a component that read
          // it as a fresh instruction would play the same arrival for ever.
          revealPhase = "arrived";
          reveal = 1;
          releaseReveal();
        }
      });

      let headAt: number | undefined;
      let travelFrom = 0;
      let travelTo = 0;
      let travelPhase: Phase = "still";
      let travelled = 0;
      let travelWant: (() => void) | undefined;
      const releaseTravel = (): void => {
        travelWant?.();
        travelWant = undefined;
      };
      animates(historyRegionNode, frames, ({ deltaSeconds }) => {
        if (travelPhase !== "running") {
          return;
        }
        travelled += deltaSeconds;
        const eased = easeInOutCubic(Math.min(1, travelled / TRANSITION_SECONDS));
        headAt = travelFrom + (travelTo - travelFrom) * eased;
        if (travelled >= TRANSITION_SECONDS - SETTLED_SECONDS) {
          travelPhase = "arrived";
          headAt = travelTo;
          releaseTravel();
        }
      });

      const presentTranscript: Presentation<TranscriptPresentation> = (data, placement) => {
        if (data.transition === undefined) {
          revealPhase = "still";
          reveal = 1;
          releaseReveal();
        } else if (revealPhase === "still") {
          revealPhase = "running";
          revealed = 0;
          reveal = 0;
          revealWant = frames.want();
        }
        attach(
          transcriptNode,
          transcriptBody,
          {
            view: data.view,
            anchor: data.anchor,
            mutation: data.mutation,
            // The control: a reconstruction that lands halfway through a
            // transition instead of on a moment.
            reveal: data.mutation === "restore-mid-animation" ? 0.5 : reveal,
          },
          placement,
        );
      };

      const presentHistory: Presentation<HistoryPresentation> = (data, placement) => {
        const history = data.view;
        if (data.transition === undefined) {
          travelPhase = "still";
          headAt = history.headAt;
          releaseTravel();
        } else if (travelPhase === "still") {
          travelPhase = "running";
          travelFrom = data.transition.fromHeadAt;
          travelTo = history.headAt;
          travelled = 0;
          headAt = travelFrom;
          travelWant = frames.want();
        }
        attach(
          historyRegionNode,
          historyBody,
          {
            view: history,
            mutation: data.mutation,
            headAt:
              data.mutation === "restore-mid-animation"
                ? history.headAt / 2
                : (headAt ?? history.headAt),
          },
          placement,
        );
        // The band knows where it wrote each bracket, so the band says where
        // its controls may draw. They are mounted in the band's own order,
        // because both come from the same transport mode.
        const cells = transportSlots(history, placement);
        [...historyRegionNode.children].forEach((control, at) => {
          attach(control, controlBody, undefined, within(placement, cells[at]));
        });
      };

      let drawers: Mounted[] = [];
      let scopes: Node[] = [];

      /**
       * Bring one region's controls into line, by name.
       *
       * Reconciled rather than rebuilt: removing and recreating every control
       * on each sync would destroy the node focus is on and take focus with
       * it, which is the defect a live tree exists to avoid.
       */
      /**
       * Bring one region's controls into line, by name.
       *
       * Two things have to hold at once, and an earlier round held only the
       * first. **Surviving nodes keep their identity**, so focus and the
       * middleware installed on them survive a sync — that is why this
       * reconciles rather than rebuilds. And **the rendered order is
       * canonical**, so the tree a live interaction arrives at is the tree a
       * cold start rebuilds from the same URL and journal. Replacements are
       * appended wherever there is room, so the order is restored explicitly
       * rather than left to the order things happened to be created in.
       */
      const reconcile = function* (
        parent: Node,
        wanted: readonly Control[],
        mutation?: Mutation,
      ): Operation<void> {
        const childrenByName = () =>
          new Map([...parent.children].map((child) => [child.name, child] as const));
        const shouldFocus = (control: Control): boolean =>
          control.enabled || mutation === "focus-hidden-target";

        // Additions come first. Removing the focused control before its
        // replacement exists would leave the region with nothing to move focus
        // to, and focus would land outside it — which is how a resumed run once
        // lost its transport slot.
        let present = childrenByName();
        for (const control of wanted) {
          if (!present.has(control.name)) {
            const node = parent.createChild(control.name);
            // A disabled control is a node the renderer draws and the map
            // numbers; not making it focusable is the whole of what disables it.
            if (shouldFocus(control)) {
              focusable(node);
            }
            if (shouldFocus(control)) {
              activates(node, control.action);
            }
          }
        }

        present = childrenByName();
        for (const [name, child] of present) {
          if (!wanted.some((control) => control.name === name)) {
            yield* until(child.remove());
          }
        }

        // A control whose enabled-ness changed is a different node: making a
        // node focusable is one-way, so the honest way to disable one is for it
        // to stop being that node and start being another.
        present = childrenByName();
        for (const control of wanted) {
          const child = present.get(control.name);
          if (child === undefined || shouldFocus(control) === isFocusable(child)) {
            continue;
          }
          yield* until(child.remove());
          const replacement = parent.createChild(control.name);
          if (shouldFocus(control)) {
            focusable(replacement);
          }
          if (shouldFocus(control)) {
            activates(replacement, control.action);
          }
        }

        const order = new Map(wanted.map((control, at) => [control.name, at] as const));
        if (mutation === "append-replacements") {
          // Leave the order to however the nodes happened to be created, which
          // is what makes a live tree and a rebuilt one disagree.
          return;
        }
        parent.sort((one, other) => (order.get(one.name) ?? 0) - (order.get(other.name) ?? 0));
      };

      const mountControls = function* (next: ReplState, mutation?: Mutation): Operation<void> {
        // The footer is an *explicit* region: its controls join the interface
        // only once focus is inside it. The tree asks itself where focus is
        // rather than being told, so the two can never disagree.
        const within = withinHistory(current(root.node).name);
        if (mutation === "rebuild-tree-each-sync") {
          // Rebuilding destroys the node focus is on, and takes focus with it.
          for (const region of [regions.get("input")!, regions.get("history")!]) {
            for (const child of [...region.children]) {
              yield* until(child.remove());
            }
          }
        }
        yield* reconcile(regions.get("input")!, runControls(next), mutation);
        yield* reconcile(regions.get("history")!, transportControls(next, within), mutation);
      };

      /**
       * The locus, as nested panels inside the transcript.
       *
       * Only the part that actually diverged is removed. Navigating deeper
       * keeps the panels already open, and with them whatever focus is inside.
       */
      const mountScopes = function* (next: ReplState): Operation<void> {
        const wanted = next.route.scopes;
        let diverged = 0;
        while (
          diverged < Math.min(scopes.length, wanted.length) &&
          scopes[diverged].name === `panel:${wanted[diverged]}`
        ) {
          diverged += 1;
        }
        while (scopes.length > diverged) {
          const leaf = scopes.pop()!;
          yield* until(leaf.remove());
        }
        let parent = scopes[scopes.length - 1] ?? regions.get("transcript")!;
        for (const scope of wanted.slice(scopes.length)) {
          const node = parent.createChild(`panel:${scope}`);
          // A scope panel is a container, not a target: it owns the middleware
          // and the lifetime of what is inside it, and the study never focuses
          // one. Not making it focusable is the whole of that distinction.
          node.set("container", true);
          recordPath(node, node.name);
          scopes.push(node);
          parent = node;
        }
      };

      /**
       * Whether this composition draws the band a drawer escapes to.
       *
       * Asked of the layout rather than of the profile, because the escape
       * exists exactly when the thing it leads to is on screen.
       */
      const composesFooter = (next: ReplState, mutation?: Mutation): boolean =>
        layoutOf(next, size, mutation).footer !== undefined;

      /** Mount or remove one drawer's way out, to match the composition. */
      const syncEscape = function* (one: Mounted, composes: boolean): Operation<void> {
        if (composes && one.escape === undefined) {
          // Appended, so it lands after the body panel: the same order a
          // narrow-to-wide resize arrives at and a cold start builds.
          const node = one.node.createChild("region:history");
          focusable(node);
          one.escape = node;
          return;
        }
        if (!composes && one.escape !== undefined) {
          yield* until(one.escape.remove());
          one.escape = undefined;
        }
      };

      const syncDrawers = function* (next: ReplState, mutation?: Mutation): Operation<void> {
        const wanted = next.route.drawers;
        let kept = 0;
        while (
          kept < Math.min(drawers.length, wanted.length) &&
          drawers[kept].node.name === `drawer:${wanted[kept]}`
        ) {
          kept += 1;
        }
        // A drawer that changed between live and recorded is a different
        // drawer: `focusable()` is one-way, so a mounted node cannot stop being
        // focusable. Unwinding to it lets it be rebuilt without actionability.
        const historical = next.route.inspect;
        for (let at = 0; at < Math.min(kept, drawers.length); at += 1) {
          if (drawers[at].historical !== historical) {
            kept = at;
            break;
          }
        }
        while (drawers.length > kept) {
          const top = drawers.pop()!;
          // Pop the focus root first, so the invoking focus is restored while
          // the branch still exists, then remove the branch: its controls and
          // their middleware go with it.
          if (mutation !== "forget-drawer-invoker") {
            top.pop?.();
          }
          if (mutation !== "keep-closed-branch") {
            yield* until(top.node.remove());
          }
        }
        // A drawer that survived this sync may have survived a resize with it.
        const composes = composesFooter(next, mutation);
        for (const one of drawers) {
          yield* syncEscape(one, composes);
        }
        for (let at = drawers.length; at < wanted.length; at += 1) {
          const kind = wanted[at];
          if (!isDrawerKind(kind)) {
            continue;
          }
          const before = [...root.node.children].find((child) => child.name === "chrome:rules");
          const node = root.node.createChild(`drawer:${kind}`, before ? { before } : undefined);
          node.set("container", true);
          recordPath(node, node.name);
          // The drawer's controls live in a body panel, so a key bound for one
          // of them passes through the drawer *and* the panel — which is the
          // ancestor path a flat registry has no way to produce.
          const body = node.createChild(`panel:${kind}.body`);
          body.set("container", true);
          recordPath(body, body.name);
          for (const target of drawerTargets(kind)) {
            const child = body.createChild(target.id);
            // A recorded drawer keeps its complete presentation and offers
            // nothing to act on: its fields and controls are mounted so the
            // components can render them, and never made focusable or wired, so
            // none of them enters the ring, receives a key or emits an action.
            if (!historical) {
              focusable(child);
              activates(child, target.action);
            }
          }
          // The panel places the controls it created, and the drawer places the
          // panel and the way out. Each closure holds only its own node, and
          // the drawer keeps the panel's rather than looking one up.
          const presentPanel: Presentation<ReadonlyMap<string, Rect>> = (cells, placement) => {
            for (const control of body.children) {
              attach(control, controlBody, undefined, within(placement, cells.get(control.name)));
            }
          };
          // Back, inside a drawer, means close the drawer. The drawer is the
          // thing that knows it is a drawer, so it owns that translation rather
          // than the root keeping a list of what might be open.
          node.scope.around(ReplActionApi, {
            dispatch([action], next): void {
              if (action.kind !== "back") {
                return next(action);
              }
              // Owning an action means answering it or saying what it really
              // means. Saying it is dispatching the other action, not passing a
              // changed one along — so what the root finally adapts arrived the
              // same way every other action does.
              ReplActionApi.invoke(node.scope, "dispatch", [{ kind: "close-drawer" }]);
            },
          });

          const mounted: Mounted = {
            node,
            historical,
            present: ({ view, escape }, placement) => {
              // Whether there is a gutter at all is the question the drawer's
              // own body asks of itself: is focus inside me? The lifecycle may
              // hold the node, so it asks the same question the same way.
              const gutter = holds(node, current(root.node));
              const cells = new Map(
                drawerSlots(view, placement, gutter).map((slot) => [slot.id, slot.rect] as const),
              );
              presentPanel(cells, placement);
              if (mounted.escape !== undefined) {
                attach(mounted.escape, escapeBody, undefined, within(placement, escape));
              }
            },
          };
          // The footer stays reachable through a suspension, so it is inside
          // the pushed root rather than outside it — and it is the navigation
          // that stays valid while a recorded moment is open. It is mounted
          // *before* the trap is pushed: a recorded drawer has no other
          // focusable child, and a trap pushed over nothing keeps focus on the
          // container itself.
          yield* syncEscape(mounted, composesFooter(next, mutation));
          mounted.pop = mutation === "leak-drawer-trap" ? undefined : focusPush(node);
          drawers.push(mounted);
        }
      };

      /**
       * The application root, adapting actions.
       *
       * This is the only code that turns an action into a new state. It is
       * installed on the root's scope, so every action dispatched anywhere in
       * the tree arrives here last — after every branch that might have owned
       * or translated it — and whatever it does not implement goes on to the
       * API default, which throws.
       *
       * The state being adapted is set for the length of one delivery and read
       * back afterwards. Nothing else may write it: a branch that wanted the
       * state changed says so as an action.
       */
      let adapting: { state: ReplState; context: ReduceContext } | undefined;
      let left: Reduction | undefined;
      root.node.scope.around(ReplActionApi, {
        dispatch([action], next): void {
          if (adapting === undefined) {
            // Dispatched outside a delivery: there is no state to adapt it
            // against, so nothing here owns it.
            return next(action);
          }
          // Whatever is nearer the action gets first refusal. Middleware runs
          // outermost first, so the root — which is the outermost there is —
          // passes the action on and answers only what comes back unowned. The
          // default's own error is that signal, and it is the one this catches.
          try {
            return next(action);
          } catch (error) {
            if (!(error instanceof UnownedActionError)) {
              throw error;
            }
          }
          const applied = applyAction(adapting.state, action, adapting.context);
          if (applied === undefined) {
            throw new UnownedActionError(action);
          }
          adapting = { ...adapting, state: applied.state };
          left = applied;
        },
      });

      /**
       * Give one node an activation of its own.
       *
       * Enter, Space and a primary pointer land in the same branch, so the
       * keyboard and the pointer cannot drift apart: there is one gesture with
       * three spellings, and one action for all of them. The action is built
       * fresh each time so that what is dispatched is a value, not a shared
       * object two call sites happen to hold.
       */
      const activates = (node: Node, action: ReplAction | undefined): void => {
        node.scope.around(ReplInputApi, {
          handle([input], next): boolean {
            if (!activation(input) || !aimedAt(node)) {
              return next(input);
            }
            if (action !== undefined) {
              ReplActionApi.invoke(node.scope, "dispatch", [{ ...action }]);
            }
            // A control with nothing to say still answers. A field and a scroll
            // region are activated by being reached, and letting the activation
            // fall past them would hand it to whatever the fallback makes of
            // it — which is the silent fall-through this boundary removes.
            return true;
          },
        });
      };

      // Activating the band opens a reconstruction of whatever the scrubber is
      // on. The band is a region rather than a control, and it is still the
      // thing that was activated.
      activates(historyRegionNode, { kind: "inspect" });

      // The surface the URL names owns focus before anything is pushed over
      // it. A drawer's trap remembers what it interrupted, and a cold start
      // that mounted the drawer first made it remember the ring's default
      // first region — so closing a drawer opened straight from a URL put you
      // on Sessions, which the URL had never said.
      const owner = [...root.node.children].find(
        (child) => child.name === `region:${state.route.surface}`,
      );
      if (owner !== undefined) {
        focus(owner);
      }

      yield* mountScopes(state);
      yield* mountControls(state);
      yield* syncDrawers(state);

      const tree: ReplTree = {
        root,
        *sync(next: ReplState, options: SyncOptions = {}) {
          const mutation = options.mutation;
          size = options.size ?? size;
          yield* mountScopes(next);
          yield* mountControls(next, mutation);
          yield* syncDrawers(next, mutation);
          if (mutation === "steal-focus-on-background") {
            // Nothing in the honest path writes focus when the world changes
            // underneath; this one does.
            advance(root.node);
          }
        },
        present(view, layout, options = {}) {
          const place = (rect: Rect | undefined): Placement => placementOf(layout, rect);
          attach(root.node, rootBody, undefined, place(layout.screen));
          if (layout.profile === "too-small") {
            // Below the minimum the interface is refused rather than shrunk, so
            // the panes are not presented at all.
            for (const child of root.node.children) {
              attach(child, refusalBody, layout, place(layout.screen));
              return;
            }
          }
          // The overlay is the tree, walked — by the root, which is the only
          // thing that can see it. Its child is handed the result.
          const overlay = overlayOf(tree, options.mutation);
          const own: Owned = {
            input: presentInput,
            transcript: presentTranscript,
            history: presentHistory,
            drawer: (node) => drawers.find((one) => one.node === node)?.present,
          };
          for (const child of root.node.children) {
            presentChild(child, view, layout, place, options, overlay, own);
          }
        },
        deliver({ state, input, context }) {
          const target =
            input.kind === "pointer"
              ? hitAt(activeRoot(root, drawers), input.pointer.x, input.pointer.y)
              : current(root.node);
          if (target === undefined) {
            // A pointer on a cell nothing is drawn in. There is no node to
            // deliver to, so nothing happened.
            return { delivery: { target: root.node.name, path: [], handled: false } };
          }
          // Pointing at something you can reach is reaching it. Focus moves
          // first, so the action is dispatched from where the person now is and
          // everything that reads focus afterwards — the surface the URL
          // follows, what Back returns to — reads the same answer.
          //
          // Nothing else moves it. A cell with nothing in it, a disabled
          // control, a recorded drawer's read-only contents: none of them can
          // take focus, so pointing at one changes nothing about where you are.
          if (input.kind === "pointer" && isFocusable(target)) {
            focus(target);
          }
          const focused = current(root.node);
          // Whatever was refused last time was about the last thing done, so
          // doing anything at all answers it. The identity is kept where there
          // is nothing to clear, so an ordinary delivery hands back the very
          // state it was given.
          const fresh = state.notice === "" ? state : { ...state, notice: "" };
          adapting = { state: fresh, context: { ...context, focused: focused.name } };
          left = undefined;
          try {
            const delivery = sendInput(root.node, target, input);
            if (delivery.handled) {
              return {
                delivery,
                reduction: left ?? (fresh === state ? undefined : { state: fresh }),
              };
            }
            // Nothing in the tree claimed it, so the root reads it. Its own
            // action is dispatched **on the target's scope**, so a branch on
            // the way up may still translate what the key meant there.
            const action = rootAction(input, context.mutation);
            if (action === undefined) {
              return { delivery };
            }
            ReplActionApi.invoke(target.scope, "dispatch", [action]);
            // `handled` stays what the path said. It means an input *handler*
            // claimed it, and the root is not on the path — what the root read
            // shows up as a reduction instead.
            return {
              delivery,
              reduction: left ?? (fresh === state ? undefined : { state: fresh }),
            };
          } finally {
            adapting = undefined;
          }
        },
        hit: (x, y) => hitAt(activeRoot(root, drawers), x, y),
        focused: () => current(root.node),
        advance: () => advance(root.node),
        retreat: () => retreat(root.node),
        // The overlay numbers targets, not the containers that hold them.
        map: () =>
          walk(activeRoot(root, drawers)).filter(
            (node) => node.name !== "" && node.props.container !== true,
          ),
        chain: () => walk(activeRoot(root, drawers)).filter(isFocusable),
      };
      return tree;
    },
  };
}

/**
 * The innermost node drawn over a cell.
 *
 * Depth first, deepest wins: a control's own cell sits inside its region's box,
 * and a pointer on it means the control. Only a node that was placed has a box
 * at all, so a structural outlet is never what a pointer lands on.
 *
 * A container is not something you point at. The chrome that floats over the
 * whole screen — the rules, the numbered map — is placed against the screen and
 * would otherwise swallow every pointer that reached it.
 */
function hitAt(node: Node, x: number, y: number): Node | undefined {
  let found: Node | undefined;
  const box = boxOf(node);
  if (
    box !== undefined &&
    node.props.container !== true &&
    x >= box.x &&
    x < box.x + box.width &&
    y >= box.y &&
    y < box.y + box.height
  ) {
    found = node;
  }
  for (const child of node.children) {
    const deeper = hitAt(child, x, y);
    if (deeper !== undefined) {
      found = deeper;
    }
  }
  return found;
}

/**
 * What the root reads an input as, when nothing in the tree claimed it.
 *
 * Only the two that are navigation rather than editing. Everything else a key
 * can mean — typing, scrolling, scrubbing, the overlay, quitting — is not an
 * action and is read by the store instead.
 */
function rootAction(input: ReplInput, mutation?: Mutation): ReplAction | undefined {
  if (input.kind !== "key") {
    return undefined;
  }
  const key: Key = input.key;
  if (key.code === "Tab" || key.code === "Backtab") {
    // Traversal is the tree's: it is the thing that knows what exists now.
    return { kind: "focus", move: reverseTab(key, mutation) ? "previous" : "next" };
  }
  if (key.code === "Escape") {
    return { kind: "back" };
  }
  return undefined;
}

/** The subtree traversal is trapped in: the top drawer, or the whole tree. */
function activeRoot(root: Root, drawers: readonly Mounted[]): Node {
  const top = drawers[drawers.length - 1];
  return top?.pop === undefined ? root.node : top.node;
}

interface Control {
  readonly name: string;
  readonly enabled: boolean;
  /** What activating it means. Supplied by whatever mounts it. */
  readonly action?: ReplAction;
}

/** True while the identity is the footer itself or one of its controls. */
function withinHistory(identity: string): boolean {
  return identity === "region:history" || identity.startsWith("control:transport.");
}

/** `Run` is listed whenever there is something to run and nothing running. */
function runControls(state: ReplState): readonly Control[] {
  const runnable = state.moment.entry !== "running" && state.route.draft !== "";
  return runnable ? [{ name: "control:input.run", enabled: true, action: { kind: "run" } }] : [];
}

/**
 * The transport controls the footer exposes.
 *
 * There is nothing to expose before an execution has been recorded, and
 * `Continue` is visible but disabled while a reconstruction is open — the study
 * numbers it and says Tab skips it.
 */
function transportControls(state: ReplState, within: boolean): readonly Control[] {
  if (state.moment.entry === "none" || !within) {
    return [];
  }
  if (state.moment.transport === "live") {
    return [{ name: "control:transport.pause", enabled: true, action: { kind: "pause" } }];
  }
  if (state.moment.transport === "paused") {
    return [
      { name: "control:transport.continue", enabled: true, action: { kind: "continue" } },
      { name: "control:transport.return-head", enabled: true, action: { kind: "return-to-head" } },
    ];
  }
  if (state.moment.transport === "inspecting") {
    return [
      // Visible, numbered, and not actionable: it is disabled, so it is neither
      // focusable nor wired to anything.
      { name: "control:transport.continue", enabled: false },
      { name: "control:transport.return-head", enabled: true, action: { kind: "return-to-head" } },
      { name: "control:transport.fork", enabled: true, action: { kind: "fork" } },
    ];
  }
  return [];
}

export { focus, topDrawer };

export interface OverlayEntry {
  readonly id: string;
  readonly label: string;
  /** False where the node is drawn and numbered but cannot take focus. */
  readonly enabled: boolean;
  readonly number: number;
  /** Whether this is the node the tree currently reports as focused. */
  readonly focused: boolean;
}

/**
 * The `F1` map, read off the live tree.
 *
 * There is no ordered registry to consult: the nodes are walked in tree order
 * and numbered as the study numbers them — regions first, then the controls.
 * Numbering and traversal are deliberately different orders, which is why the
 * study's numbers look out of sequence: `Run` belongs to the input and is
 * traversed there, but numbered after the last region.
 */
export function overlayOf(tree: ReplTree, mutation?: Mutation): readonly OverlayEntry[] {
  if (mutation === "flat-overlay") {
    // A list kept beside the interface rather than read off it: it goes on
    // numbering the five regions whatever the tree currently holds.
    return ROUTE_SURFACES.map((region, at) => ({
      id: `region:${region}`,
      label: labelFor(`region:${region}`),
      enabled: true,
      number: at + 1,
      focused: false,
    }));
  }
  const nodes = tree.map();
  const regions = nodes.filter((node) => node.name.startsWith("region:"));
  const rest = nodes.filter((node) => !node.name.startsWith("region:"));
  const ordered = regions.length === ROUTE_SURFACES.length ? [...regions, ...rest] : nodes;
  const here = tree.focused();
  return ordered.map((node, at) => ({
    id: node.name,
    label: labelFor(node.name),
    enabled: isFocusable(node),
    number: at + 1,
    focused: node === here,
  }));
}

/**
 * One direct child of the root, given the data it owns.
 *
 * Each branch below this presents its own contents: the drawer draws its form
 * from its own `DrawerView`, and nothing here reaches past a child to choose
 * what a grandchild renders.
 */
function presentChild(
  child: Node,
  view: ReplView,
  layout: Layout,
  place: (rect: Rect | undefined) => Placement,
  options: PresentOptions,
  overlay: readonly OverlayEntry[],
  own: Owned,
): void {
  const name = child.name;
  if (name === "region:sessions") {
    attach(child, sessionsBody, view.sessions, place(layout.sidebar));
    return;
  }
  if (name === "region:transcript") {
    own.transcript(
      {
        view: view.transcript,
        anchor: options.anchor ?? 0,
        mutation: options.mutation,
        transition: options.transition,
      },
      place(layout.transcript),
    );
    return;
  }
  if (name === "region:bindings") {
    attach(child, bindingsBody, view.bindings, place(layout.bindings));
    return;
  }
  if (name === "region:input") {
    // An open drawer owns the contextual band; the input keeps its node and
    // simply has nowhere to draw.
    const taken = view.contextual.drawers.length > 0;
    const placement = place(taken ? undefined : layout.contextual);
    attach(child, inputBody, view.contextual.input, placement);
    own.input(view.contextual.input, placement);
    return;
  }
  if (name === "region:history") {
    own.history(
      { view: view.history, mutation: options.mutation, transition: options.transition },
      place(layout.footer),
    );
    return;
  }
  if (name.startsWith("drawer:")) {
    const kind = name.slice("drawer:".length);
    const drawer = view.contextual.drawers.find((candidate) => candidate.kind === kind);
    if (drawer !== undefined) {
      const covering =
        options.mutation === "drawer-covers-footer" &&
        layout.contextual !== undefined &&
        layout.footer !== undefined;
      const rect =
        covering && layout.contextual !== undefined && layout.footer !== undefined
          ? { ...layout.contextual, height: layout.contextual.height + layout.footer.height }
          : layout.contextual;
      const placement = place(rect);
      attach(child, drawerBody, { view: drawer }, placement);
      own.drawer(child)?.({ view: drawer, escape: layout.footer }, placement);
      return;
    }
  }
  if (name === "chrome:surface-bar") {
    attach(
      child,
      surfaceBarBody,
      {
        crumb: view.crumb,
        badge: view.badge,
        surface: view.surface === "input" ? "transcript" : view.surface,
        notice: view.notice,
      },
      place(layout.surfaceBar),
    );
    return;
  }
  if (name === "chrome:header") {
    attach(
      child,
      headerBody,
      { crumb: view.crumb, badge: view.badge, notice: view.notice },
      place(layout.header),
    );
    return;
  }
  if (name === "chrome:rules") {
    attach(child, rulesBody, layout.separators, place(layout.screen));
    return;
  }
  if (name === "chrome:focus-map") {
    attach(
      child,
      focusMapBody,
      {
        entries: overlay,
        visible: options.overlay === true,
      },
      place(layout.screen),
    );
    return;
  }
  attach(child, outletBody, undefined, place(undefined));
}

/** True where `target` is `node` or sits somewhere beneath it. */
function holds(node: Node, target: Node): boolean {
  for (let at: Node | undefined = target; at; at = at.parent) {
    if (at === node) {
      return true;
    }
  }
  return false;
}
