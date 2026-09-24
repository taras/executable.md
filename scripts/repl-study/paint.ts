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
      { view: view.transcript, anchor },
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
      attach(node, drawerBody, { view: drawer }, placed(layout.contextual, layout));
      return;
    }
  }
  if (name === "region:history") {
    // Only the pane draws the band. The identically-named node inside a drawer
    // is that trap's way out, not a second Execution History.
    const pane = node.parent?.parent === undefined;
    if (pane) {
      attach(node, historyBody, { view: view.history }, placed(layout.footer, layout));
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
}

/** Which of the four routed surfaces the narrow bar names. */
function surfaceOf(view: ReplView): SurfaceName {
  return view.surface === "input" ? "transcript" : view.surface;
}

/** Hand every mounted node its data, then render the tree. */
export function paint(request: PaintRequest): Op[] {
  const { root, layout } = request;
  attach(root, rootBody, undefined, placementOf(layout, layout.screen));
  if (layout.profile === "too-small") {
    // Below the minimum the interface is refused rather than shrunk, so the
    // panes are not dressed at all — there is nothing for them to be inside.
    for (const child of root.children) {
      attach(child, refusalBody, layout, placementOf(layout, layout.screen));
      return walk(child);
    }
  }
  const visit = (node: Node): void => {
    for (const child of node.children) {
      dress(child, request);
      visit(child);
    }
  };
  visit(root);
  return walk(root);
}
