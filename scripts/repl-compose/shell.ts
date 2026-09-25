/**
 * A small interface, described rather than built.
 *
 * These are the components the reconciliation evidence drives: enough shape to
 * have a nested drawer over some panels, and nothing more. Each one is a plain
 * value with a pure `children` and an optional lifecycle, and none of them
 * reaches anything but the input its parent handed it.
 *
 * The drawer is the interesting one. A stack of drawers is described as a
 * *branch* — the second drawer is a child of the first, not a sibling — so
 * closing the top one removes exactly one subtree, and closing the bottom one
 * removes both. It also animates, which is how a removed branch can be shown to
 * stop asking the host for frames.
 */

import { spawn } from "effection";
import type { Operation } from "effection";

import { component, describe } from "./component.ts";
import type { Component, Description, Mounted } from "./component.ts";

export interface ControlInput {
  readonly label: string;
  /** The action pressing this control means. */
  readonly action: string;
}

export interface PanelInput {
  readonly key: string;
  readonly title: string;
  readonly lines: readonly string[];
}

export interface DrawerInput {
  readonly key: string;
  readonly kind: string;
  readonly prompt: string;
  readonly controls: readonly ControlInput[];
}

export interface WorkspaceInput {
  readonly panels: readonly PanelInput[];
  /** The drawer stack, outermost first. Each one is mounted inside the last. */
  readonly drawers: readonly DrawerInput[];
}

/** One drawer, and whatever is stacked on top of it. */
interface StackedDrawer {
  readonly drawer: DrawerInput;
  readonly above: readonly DrawerInput[];
}

export const Control: Component<ControlInput> = component({
  name: "control",
  focusable: true,
  lifecycle: null,
  children: () => [],
  onPress(input, key) {
    if (key.key === "Enter") {
      return { kind: input.action, from: input.label };
    }
    return undefined;
  },
  present(input) {
    return [`[ ${input.label} ]`];
  },
});

export const Panel: Component<PanelInput> = component({
  name: "panel",
  focusable: true,
  lifecycle: null,
  children: () => [],
  present(input, children) {
    return [`${input.title}:`, ...input.lines.map((line) => `  ${line}`), ...children];
  },
});

export const Drawer: Component<StackedDrawer> = component({
  name: "drawer",
  focusable: true,

  children({ drawer, above }): readonly Description[] {
    const controls = drawer.controls.map((control) =>
      describe(Control, `${drawer.key}.${control.label}`, control),
    );
    const [next, ...rest] = above;
    if (next === undefined) {
      return controls;
    }
    // Stacked, not adjacent: the drawer above is a child branch of this one.
    return [...controls, describe(Drawer, next.key, { drawer: next, above: rest })];
  },

  *lifecycle({ node, input, frames, ready, updates }: Mounted<StackedDrawer>): Operation<void> {
    // A drawer opens over time, so it asks the host for frames — and stops
    // asking when this scope ends, which is when the branch is removed.
    const clock = yield* frames.subscribe();
    const later = yield* updates.receive();
    let opened = 0;
    let current = input;
    node.set("opened", opened);
    node.set("prompt", current.drawer.prompt);

    // Both subscriptions belong to this body's scope, and are acquired before
    // the child that reads one is spawned.
    yield* spawn(function* () {
      while (true) {
        const elapsed = yield* clock.next();
        opened += 1;
        node.set("opened", opened);
        node.set("at", elapsed);
      }
    });

    yield* ready();

    // Its parent tells it what changed. Taking the next input is what reports
    // the previous one applied, so a reconcile does not return until the prompt
    // on screen is the prompt that was just described.
    while (true) {
      current = yield* later.next();
      node.set("prompt", current.drawer.prompt);
    }
  },

  onPress({ drawer }, key) {
    if (key.key === "Escape") {
      return { kind: "drawer.close", from: drawer.key };
    }
    return undefined;
  },

  present({ drawer }, children) {
    return [`— ${drawer.kind}: ${drawer.prompt}`, ...children.map((line) => `  ${line}`)];
  },
});

export const Workspace: Component<WorkspaceInput> = component({
  name: "workspace",
  focusable: false,
  lifecycle: null,

  children(input): readonly Description[] {
    const panels = input.panels.map((panel) => describe(Panel, panel.key, panel));
    const [first, ...above] = input.drawers;
    if (first === undefined) {
      return panels;
    }
    return [...panels, describe(Drawer, first.key, { drawer: first, above })];
  },

  present(_input, children) {
    return children;
  },
});
