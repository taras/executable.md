/**
 * Render the mounted tree, and report which id drew each measured role.
 *
 * Presentation is the tree's: each parent hands its own children their data and
 * placement. What is left here is the walk, and a map from the roles evidence
 * asks about — "is the footer ever covered?" — to the ids that actually
 * rendered them, because a component is addressed by its node's id and two
 * nodes may share a semantic name.
 */

import type { Op } from "@bomb.sh/tty";

import { walk } from "./component.ts";
import type { Layout } from "./layout.ts";
import type { Node } from "./vendor/freedom/upstream/index.ts";
import type { PresentOptions, ReplTree } from "./tree.ts";
import type { ReplView } from "./view.ts";

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

export interface PaintRequest {
  readonly tree: ReplTree;
  readonly view: ReplView;
  readonly layout: Layout;
  readonly anchor?: number;
  readonly options?: PresentOptions;
}

export function paint(request: PaintRequest): Painted {
  const { tree, view, layout } = request;
  tree.present(view, layout, { anchor: request.anchor ?? 0, ...request.options });
  const root: Node = tree.root.node;
  // Focus is asked of the tree once, here, and handed to the walk. A body then
  // learns only where focus is relative to itself, which is the whole of what
  // it may know.
  const focused = tree.focused();
  const ids: Record<string, string> = { root: root.id };
  if (layout.profile === "too-small") {
    for (const child of root.children) {
      return { ops: walk(child, focused), ids: { ...ids, "too-small": child.id } };
    }
  }
  for (const child of root.children) {
    const role = ROLES[child.name];
    if (role !== undefined && ids[role] === undefined) {
      ids[role] = child.id;
    }
    if (child.name.startsWith("drawer:")) {
      // An open drawer owns the contextual band, so it is what "contextual"
      // names while it is there.
      ids.contextual = child.id;
    }
  }
  return { ops: walk(root, focused), ids };
}
