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
import { recordPath } from "./keys.ts";
import { attach, placementOf } from "./component.ts";
import type { Placement } from "./component.ts";
import {
  bindingsBody,
  drawerBody,
  focusMapBody,
  focusMarkerBody,
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
import type { FocusView } from "./render.ts";
import type { Motion } from "./playback.ts";
import type { ReplView } from "./view.ts";
import type { Layout, Rect } from "./layout.ts";
import { isDrawerKind } from "./fixtures.ts";
import type { ReplState } from "./store.ts";
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
  sync(state: ReplState, mutation?: Mutation): Operation<void>;
  /**
   * Hand every direct child its own view subtree and its placement.
   *
   * The root is a parent, so this is the root doing what every parent does. It
   * reaches its *own* children and no further: a drawer presents its own
   * contents, and no node's data is chosen by something walking the whole tree
   * from outside.
   */
  present(view: ReplView, layout: Layout, options?: PresentOptions): void;
  /** Where focus is, asked of the tree. */
  focused(): Node;
  advance(): void;
  retreat(): void;
  /** Every node the `F1` overlay numbers, in tree order. */
  map(): Node[];
  /** The focus chain: visible, enabled, and in tree order. */
  chain(): Node[];
}

export interface PresentOptions {
  readonly anchor?: number;
  readonly mutation?: Mutation;
  readonly motion?: Motion;
  readonly focus?: FocusView;
}

interface Mounted {
  readonly node: Node;
  readonly pop?: PopFocus;
  /** True while this drawer was mounted as a recorded, read-only one. */
  readonly historical: boolean;
}

/**
 * Build the interface once, then keep it in step.
 *
 * Nothing here rebuilds the tree from scratch. A rebuild would destroy every
 * node each frame and take focus with it, which is the defect a live tree
 * exists to avoid.
 */
export function useReplTree(state: ReplState): Operation<ReplTree> {
  return {
    *[Symbol.iterator]() {
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
      for (const name of ["chrome:rules", "chrome:focus-marker", "chrome:focus-map"]) {
        root.node.createChild(name).set("container", true);
      }
      useFocus(root.node);

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
            // components can render them, and never made focusable, so none of
            // them enters the ring or receives a key.
            if (!historical) {
              focusable(child);
            }
          }
          // The footer stays reachable through a suspension, so it is inside
          // the pushed root rather than outside it — and it is the navigation
          // that stays valid while a recorded moment is open.
          const footer = node.createChild("region:history");
          focusable(footer);
          const pop = mutation === "leak-drawer-trap" ? undefined : focusPush(node);
          drawers.push({ node, pop, historical });
        }
      };

      yield* mountScopes(state);
      yield* mountControls(state);
      yield* syncDrawers(state);

      const tree: ReplTree = {
        root,
        *sync(next: ReplState, mutation?: Mutation) {
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
          for (const child of root.node.children) {
            presentChild(child, view, layout, place, options);
          }
        },
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

/** The subtree traversal is trapped in: the top drawer, or the whole tree. */
function activeRoot(root: Root, drawers: readonly Mounted[]): Node {
  const top = drawers[drawers.length - 1];
  return top?.pop === undefined ? root.node : top.node;
}

interface Control {
  readonly name: string;
  readonly enabled: boolean;
}

/** True while the identity is the footer itself or one of its controls. */
function withinHistory(identity: string): boolean {
  return identity === "region:history" || identity.startsWith("control:transport.");
}

/** `Run` is listed whenever there is something to run and nothing running. */
function runControls(state: ReplState): readonly Control[] {
  const runnable = state.moment.entry !== "running" && state.route.draft !== "";
  return runnable ? [{ name: "control:input.run", enabled: true }] : [];
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
    return [{ name: "control:transport.pause", enabled: true }];
  }
  if (state.moment.transport === "paused") {
    return [
      { name: "control:transport.continue", enabled: true },
      { name: "control:transport.return-head", enabled: true },
    ];
  }
  if (state.moment.transport === "inspecting") {
    return [
      { name: "control:transport.continue", enabled: false },
      { name: "control:transport.return-head", enabled: true },
      { name: "control:transport.fork", enabled: true },
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
    }));
  }
  const nodes = tree.map();
  const regions = nodes.filter((node) => node.name.startsWith("region:"));
  const rest = nodes.filter((node) => !node.name.startsWith("region:"));
  const ordered = regions.length === ROUTE_SURFACES.length ? [...regions, ...rest] : nodes;
  return ordered.map((node, at) => ({
    id: node.name,
    label: labelFor(node.name),
    enabled: isFocusable(node),
    number: at + 1,
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
): void {
  const name = child.name;
  if (name === "region:sessions") {
    attach(child, sessionsBody, view.sessions, place(layout.sidebar));
    return;
  }
  if (name === "region:transcript") {
    attach(
      child,
      transcriptBody,
      {
        view: view.transcript,
        anchor: options.anchor ?? 0,
        mutation: options.mutation,
        motion: options.motion,
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
    attach(child, inputBody, view.contextual.input, place(taken ? undefined : layout.contextual));
    return;
  }
  if (name === "region:history") {
    attach(
      child,
      historyBody,
      {
        view: view.history,
        mutation: options.mutation,
        motion: options.motion,
        focus: options.focus,
      },
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
      attach(child, drawerBody, { view: drawer, focus: options.focus }, place(rect));
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
      },
      place(layout.surfaceBar),
    );
    return;
  }
  if (name === "chrome:header") {
    attach(child, headerBody, { crumb: view.crumb, badge: view.badge }, place(layout.header));
    return;
  }
  if (name === "chrome:rules") {
    attach(child, rulesBody, layout.separators, place(layout.screen));
    return;
  }
  if (name === "chrome:focus-marker") {
    attach(child, focusMarkerBody, { layout, focus: options.focus }, place(layout.screen));
    return;
  }
  if (name === "chrome:focus-map") {
    attach(child, focusMapBody, { layout, focus: options.focus }, place(layout.screen));
    return;
  }
  attach(child, outletBody, undefined, place(undefined));
}
