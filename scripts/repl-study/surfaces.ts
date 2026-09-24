/**
 * The vocabulary the interface is built from.
 *
 * Which controls a drawer carries, in what order, and what activating each one
 * means. The tree in `tree.ts` turns these into nodes and hands each its own
 * action; the renderer draws them. Nothing here knows about focus — that is the
 * tree's, and having it in one place is the point of this file being this
 * small.
 */

import type { DrawerKind } from "./fixtures.ts";
import type { ReplAction } from "./actions.ts";

export interface SurfaceControl {
  readonly id: string;
  readonly kind: "control" | "field";
  readonly label: string;
  /**
   * What activating it means, for the parent that mounts it to hand over.
   *
   * Absent where there is nothing to say: a field and a scroll region are
   * activated by being reached, and they answer the activation themselves
   * rather than letting it fall past them.
   */
  readonly action?: ReplAction;
}

/** Each drawer's own sequence, taken from study frames 07, 08 and 09. */
const DRAWER_TARGETS: Record<DrawerKind, readonly SurfaceControl[]> = {
  project: [
    { id: "field:drawer.project.name", kind: "field", label: "Project name" },
    { id: "field:drawer.project.description", kind: "field", label: "Description" },
    {
      id: "control:drawer.project.schema",
      kind: "control",
      label: "Schema disclosure · ⌥S",
      action: { kind: "disclose-schema" },
    },
    {
      id: "control:drawer.project.submit",
      kind: "control",
      label: "Submit",
      action: { kind: "submit" },
    },
  ],
  review: [
    { id: "control:drawer.review.scroll", kind: "control", label: "Plan review · scroll region" },
    {
      id: "control:drawer.review.approve",
      kind: "control",
      label: "Approve",
      action: { kind: "approve" },
    },
    {
      id: "control:drawer.review.request",
      kind: "control",
      label: "Request changes",
      action: { kind: "request-changes" },
    },
    { id: "control:drawer.review.stop", kind: "control", label: "Stop", action: { kind: "stop" } },
    {
      id: "control:drawer.review.submit",
      kind: "control",
      label: "Submit",
      action: { kind: "submit" },
    },
  ],
  confirm: [
    {
      id: "control:drawer.confirm.preview",
      kind: "control",
      label: "README preview · scroll region",
    },
    {
      id: "control:drawer.confirm.approve",
      kind: "control",
      label: "Approve",
      action: { kind: "approve" },
    },
    {
      id: "control:drawer.confirm.decline",
      kind: "control",
      label: "Decline",
      action: { kind: "decline" },
    },
  ],
};

export function drawerTargets(kind: DrawerKind): readonly SurfaceControl[] {
  return DRAWER_TARGETS[kind];
}

/** What the overlay writes beside a node, keyed by the node's own name. */
export function labelFor(name: string): string {
  for (const targets of Object.values(DRAWER_TARGETS)) {
    const found = targets.find((target) => target.id === name);
    if (found !== undefined) {
      return found.label;
    }
  }
  return REGION_LABELS[name] ?? CONTROL_LABELS[name] ?? name;
}

const REGION_LABELS: Record<string, string> = {
  "region:sessions": "Sessions",
  "region:transcript": "Transcript",
  "region:bindings": "Bindings",
  "region:input": "REPL input",
  "region:history": "Execution History",
};

const CONTROL_LABELS: Record<string, string> = {
  "control:input.run": "Run",
  "control:transport.pause": "Pause",
  "control:transport.continue": "Continue",
  "control:transport.return-head": "Return to paused head",
  "control:transport.fork": "Fork from here",
};
