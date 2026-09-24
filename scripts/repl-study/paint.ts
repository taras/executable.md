/**
 * One downward pass: every mounted node is handed its own slice of the view.
 *
 * This is the "data down" half. The projector above the tree produces one
 * immutable `ReplView`; this walks the mounted nodes and gives each the subtree
 * it owns together with the box its parent allows it. Nothing is rebuilt — a
 * node that was already mounted keeps its identity, its focus, its middleware
 * and its generator-local state, and only the data it renders changes.
 *
 * Rendering is then `walk()` over that same tree, each parent wrapping what its
 * children already produced. Rendering, focus order, the scoped input path and
 * the `F1` overlay therefore all come off one structure, which is the whole
 * claim #840 makes.
 */

import type { Op } from "@bomb.sh/tty";

import { attach, placementOf, walk } from "./component.ts";
import type { Placement } from "./component.ts";
import {
  bindingsBody,
  drawerBody,
  focusMapBody,
  focusMarkerBody,
  refusalBody,
  rulesBody,
  surfaceBarBody,
  headerBody,
  historyBody,
  inputBody,
  outletBody,
  rootBody,
  sessionsBody,
  transcriptBody,
} from "./components.ts";
import type { Layout, Rect } from "./layout.ts";
import type { Node } from "./vendor/freedom/upstream/index.ts";
import type { ReplView } from "./view.ts";
import type { FocusView } from "./render.ts";
import type { SurfaceName } from "./layout.ts";
import type { Mutation } from "./mutations.ts";
import type { Motion } from "./playback.ts";

/** A node that is mounted but not composed at this profile draws nothing. */
const NOWHERE: Rect = { x: 0, y: 0, width: 0, height: 0 };

function placed(rect: Rect | undefined, layout: Layout): Placement {
  return placementOf(layout, rect ?? NOWHERE);
}

/**
 * Give one node the body and the data it owns.
 *
 * Attaching is idempotent and keeps the node, so this runs every frame: the
 * alternative — attaching once and mutating a captured reference — would make
 * "the data a component rendered" a thing two places could answer.
 */
function dress(node: Node, request: PaintRequest): void {
  const { view, layout, anchor } = request;
  const name = node.name;
  if (name === "chrome:surface-bar") {
    attach(
      node,
      surfaceBarBody,
      {
        crumb: view.crumb,
        badge: view.badge,
        surface: surfaceOf(view),
      },
      placed(layout.surfaceBar, layout),
    );
    return;
  }
  if (name === "chrome:rules") {
    attach(node, rulesBody, layout.separators, placed(layout.screen, layout));
    return;
  }
  if (name === "chrome:focus-marker") {
    attach(node, focusMarkerBody, { layout, focus: request.focus }, placed(layout.screen, layout));
    return;
  }
  if (name === "chrome:focus-map") {
    attach(node, focusMapBody, { layout, focus: request.focus }, placed(layout.screen, layout));
    return;
  }
  if (name === "chrome:header") {
    attach(
      node,
      headerBody,
      { crumb: view.crumb, badge: view.badge },
      placed(layout.header, layout),
    );
    return;
  }
  if (name === "region:sessions") {
    attach(node, sessionsBody, view.sessions, placed(layout.sidebar, layout));
    return;
  }
  if (name === "region:transcript") {
    attach(
      node,
      transcriptBody,
      { view: view.transcript, anchor, mutation: request.mutation, motion: request.motion },
      placed(layout.transcript, layout),
    );
    return;
  }
  if (name === "region:bindings") {
    attach(node, bindingsBody, view.bindings, placed(layout.bindings, layout));
    return;
  }
  if (name === "region:input") {
    // While a drawer is open it owns the contextual band, so the input has
    // nowhere to draw — the parent decides placement, not the child.
    // An open drawer owns the band from the first frame of the transition. Its
    // *height* is what the transition interpolates — the drawer starts in the
    // input's four rows and grows — which is why the layout, not this, decides
    // how tall it is.
    const taken = view.contextual.drawers.length > 0;
    attach(
      node,
      inputBody,
      view.contextual.input,
      placed(taken ? undefined : layout.contextual, layout),
    );
    return;
  }
  if (name.startsWith("drawer:")) {
    const kind = name.slice("drawer:".length);
    const drawer = view.contextual.drawers.find((candidate) => candidate.kind === kind);
    if (drawer !== undefined) {
      // A drawer takes the contextual band; the input keeps its own node and
      // simply has nowhere to draw while one is open.
      // The control lets the drawer take the rows the band owns. It is drawn
      // after the footer, so extending it is all it takes to cover what the
      // study says is never covered.
      const covering =
        request.mutation === "drawer-covers-footer" &&
        layout.contextual !== undefined &&
        layout.footer !== undefined;
      const rect =
        covering && layout.contextual !== undefined && layout.footer !== undefined
          ? { ...layout.contextual, height: layout.contextual.height + layout.footer.height }
          : layout.contextual;
      attach(node, drawerBody, { view: drawer, focus: request.focus }, placed(rect, layout));
      return;
    }
  }
  if (name === "region:history") {
    // Only the pane draws the band. The identically-named node inside a drawer
    // is that trap's way out, not a second Execution History.
    const pane = node.parent?.parent === undefined;
    if (pane) {
      attach(
        node,
        historyBody,
        {
          view: view.history,
          mutation: request.mutation,
          motion: request.motion,
          focus: request.focus,
        },
        placed(layout.footer, layout),
      );
      return;
    }
  }
  if (name === "header") {
    attach(
      node,
      headerBody,
      { crumb: view.crumb, badge: view.badge },
      placed(layout.header, layout),
    );
    return;
  }
  // Panels, drawers and controls are structural for now: they own ancestry,
  // focus and input, and contribute their children's operations unchanged.
  attach(node, outletBody, undefined, placed(undefined, layout));
}

export interface PaintRequest {
  readonly root: Node;
  readonly view: ReplView;
  readonly layout: Layout;
  /** The transcript window, which the renderer clips rather than scrolls. */
  readonly anchor: number;
  readonly focus?: FocusView;
  readonly mutation?: Mutation;
  /** Present only while a playback is running between two moments. */
  readonly motion?: Motion;
}

/** Which of the four routed surfaces the narrow bar names. */
function surfaceOf(view: ReplView): SurfaceName {
  return view.surface === "input" ? "transcript" : view.surface;
}

/**
 * What each measured region was addressed by.
 *
 * The tree addresses components by node id, because two nodes may share a
 * semantic name. Evidence asks about regions by role — "is the footer ever
 * covered?" — so the mapping from role to the id actually rendered is reported
 * rather than guessed.
 */
export type RenderedIds = Readonly<Record<string, string>>;

export interface Painted {
  readonly ops: Op[];
  readonly ids: RenderedIds;
}

const ROLES: Readonly<Record<string, string>> = {
  "region:sessions": "sidebar",
  "region:transcript": "transcript",
  "region:bindings": "bindings",
  "region:input": "contextual",
  "region:history": "footer",
  "chrome:surface-bar": "surface-bar",
  "chrome:header": "header",
};

/** Hand every mounted node its data, then render the tree. */
export function paint(request: PaintRequest): Painted {
  const { root, layout } = request;
  const ids: Record<string, string> = { root: root.id };
  attach(root, rootBody, undefined, placementOf(layout, layout.screen));
  if (layout.profile === "too-small") {
    // Below the minimum the interface is refused rather than shrunk, so the
    // panes are not dressed at all — there is nothing for them to be inside.
    for (const child of root.children) {
      attach(child, refusalBody, layout, placementOf(layout, layout.screen));
      return { ops: walk(child), ids: { ...ids, "too-small": child.id } };
    }
  }
  const visit = (node: Node): void => {
    for (const child of node.children) {
      dress(child, request);
      const role = ROLES[child.name];
      if (role !== undefined && ids[role] === undefined) {
        ids[role] = child.id;
      }
      if (child.name.startsWith("drawer:")) {
        // An open drawer owns the contextual band, so it is what "contextual"
        // names while it is there.
        ids.contextual = child.id;
      }
      visit(child);
    }
  };
  visit(root);
  return { ops: walk(root), ids };
}
