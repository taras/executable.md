/**
 * One description, one mounted tree, and nothing beside it.
 *
 * The reverted first #840 experiment kept rendering, focus order, the input
 * path and the overlay derived from structures that had to agree with each
 * other. Every case it wrote passed, because things that are kept in step
 * always agree. The cases here are chosen to be ones only a single mounted tree
 * can satisfy: a branch that is removed and therefore contributes nothing
 * anywhere, and a keyed child that survives an update with the state its
 * lifecycle is holding.
 *
 * Three named controls stand in for the designs this rejects — positional
 * matching, a drawer that is hidden rather than removed, and a registry beside
 * the tree — and each one *passes* the check the real design fails it on, which
 * is what makes the check a check.
 */

import { describe as suite, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";
import type { Operation } from "effection";

import { useRoot } from "../repl-study/vendor/freedom/upstream/index.ts";
import type { Node, Root } from "../repl-study/vendor/freedom/upstream/index.ts";

import { describe } from "../repl-compose/component.ts";
import type { Description } from "../repl-compose/component.ts";
import { createFrameClock } from "../repl-compose/frames.ts";
import type { FrameClock } from "../repl-compose/frames.ts";
import { press } from "../repl-compose/input.ts";
import {
  compose,
  focusTargets,
  keyOf,
  paint,
  settle,
  topology,
} from "../repl-compose/reconcile.ts";
import { Control, Drawer, Workspace } from "../repl-compose/shell.ts";
import type { DrawerInput, WorkspaceInput } from "../repl-compose/shell.ts";

const PANELS = [
  { key: "transcript", title: "Transcript", lines: ["entry-1"] },
  { key: "bindings", title: "Bindings", lines: ["draft"] },
];

const PROJECT: DrawerInput = {
  key: "+project",
  kind: "project",
  prompt: "Which project should the README describe?",
  controls: [{ label: "Submit", action: "drawer.submit" }],
};

const CONFIRM: DrawerInput = {
  key: "+confirm",
  kind: "confirm",
  prompt: "Commit and push the README now?",
  controls: [{ label: "Commit", action: "drawer.commit" }],
};

function workspace(drawers: readonly DrawerInput[]): WorkspaceInput {
  return { panels: PANELS, drawers };
}

function shell(input: WorkspaceInput): readonly Description[] {
  return [describe(Workspace, "workspace", input)];
}

/** One mounted tree and the clock it is driven by. */
interface Harness {
  readonly root: Root;
  readonly clock: FrameClock;
  show(input: WorkspaceInput): Operation<void>;
}

function* harness(): Operation<Harness> {
  const root = yield* useRoot();
  const clock = createFrameClock();
  return {
    root,
    clock,
    *show(input: WorkspaceInput): Operation<void> {
      yield* compose(root.node, shell(input), clock);
    },
  };
}

/** The node one key names, searched in the one tree there is. */
function find(node: Node, key: string): Node | undefined {
  if (keyOf(node) === key) {
    return node;
  }
  for (const child of node.children) {
    const found = find(child, key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function expectNode(node: Node, key: string): Node {
  const found = find(node, key);
  if (found === undefined) {
    throw new Error(`no mounted branch is keyed ${JSON.stringify(key)}`);
  }
  return found;
}

suite("REPL composition: keyed descriptions reconciled into Freedom", () => {
  suite("a parent declares its direct children", () => {
    it("mounts exactly the described topology, in described order", function* () {
      const { root, show } = yield* harness();
      yield* show(workspace([PROJECT]));

      expect(topology(root.node)).toEqual([
        "workspace",
        "transcript",
        "bindings",
        "+project",
        "+project.Submit",
      ]);
    });

    it("stacks a drawer as a child branch of the drawer below it", function* () {
      const { root, show } = yield* harness();
      yield* show(workspace([PROJECT, CONFIRM]));

      const project = expectNode(root.node, "+project");
      const confirm = expectNode(root.node, "+confirm");

      // Stacked, not adjacent: the second drawer is inside the first.
      expect(confirm.parent).toBe(project);
      expect(topology(project)).toEqual([
        "+project",
        "+project.Submit",
        "+confirm",
        "+confirm.Commit",
      ]);
    });

    it("draws the tree by walking it, each parent around its children", function* () {
      const { root, show } = yield* harness();
      yield* show(workspace([PROJECT]));

      expect(paint(root.node)).toEqual([
        "Transcript:",
        "  entry-1",
        "Bindings:",
        "  draft",
        "— project: Which project should the README describe?",
        "  [ Submit ]",
      ]);
    });
  });

  suite("reconciling preserves a matching keyed child", () => {
    it("keeps the node, and the state its lifecycle is holding", function* () {
      const { root, clock, show } = yield* harness();
      yield* show(workspace([PROJECT]));

      const before = expectNode(root.node, "+project");
      clock.tick(16);
      clock.tick(16);
      yield* settle();
      expect(before.props.opened).toBe(2);

      // New input for the panels; the drawer's key and component are unchanged.
      yield* show({
        panels: [{ key: "transcript", title: "Transcript", lines: ["entry-1", "entry-2"] }],
        drawers: [PROJECT],
      });

      const after = expectNode(root.node, "+project");
      expect(after).toBe(before);
      // The lifecycle was never restarted, so its count carries on rather than
      // beginning again at zero.
      expect(after.props.opened).toBe(2);
      clock.tick(16);
      yield* settle();
      expect(after.props.opened).toBe(3);
    });

    it("replaces a node whose key is reused by a different component", function* () {
      const { root, clock } = yield* harness();

      yield* compose(root.node, [describe(Drawer, "slot", { drawer: PROJECT, above: [] })], clock);
      const before = expectNode(root.node, "slot");
      expect(before.name).toBe("drawer");
      expect(clock.demand).toBe(1);

      // The same key, describing a different component. A key is not an
      // identity on its own: this is a different child, so the drawer is
      // unmounted rather than handed a Control's input.
      yield* compose(
        root.node,
        [describe(Control, "slot", { label: "Submit", action: "drawer.submit" })],
        clock,
      );

      const after = expectNode(root.node, "slot");
      expect(after).not.toBe(before);
      expect(after.name).toBe("control");
      expect(clock.demand).toBe(0);
    });

    it("reorders without remounting when the described order changes", function* () {
      const { root, show } = yield* harness();
      yield* show(workspace([PROJECT]));
      const transcript = expectNode(root.node, "transcript");

      yield* show({ panels: [PANELS[1], PANELS[0]], drawers: [PROJECT] });

      expect(topology(root.node)).toEqual([
        "workspace",
        "bindings",
        "transcript",
        "+project",
        "+project.Submit",
      ]);
      expect(expectNode(root.node, "transcript")).toBe(transcript);
    });
  });

  suite("closing a drawer removes its whole branch", () => {
    it("leaves no node, focus target, input path, frame demand or presentation", function* () {
      const { root, clock, show } = yield* harness();
      yield* show(workspace([PROJECT, CONFIRM]));

      const confirm = expectNode(root.node, "+confirm");
      const commit = expectNode(root.node, "+confirm.Commit");
      expect(clock.demand).toBe(2);
      expect(focusTargets(root.node).map((node) => keyOf(node))).toEqual([
        "transcript",
        "bindings",
        "+project",
        "+project.Submit",
        "+confirm",
        "+confirm.Commit",
      ]);
      expect(press(root.node, commit, { key: "Enter" }).path).toEqual([
        "workspace",
        "+project",
        "+confirm",
        "+confirm.Commit",
      ]);
      expect(paint(root.node).join("\n")).toContain("Commit and push");

      // Close the top drawer: it is simply no longer described.
      yield* show(workspace([PROJECT]));

      expect(find(root.node, "+confirm")).toBe(undefined);
      expect(find(root.node, "+confirm.Commit")).toBe(undefined);
      expect(topology(root.node)).toEqual([
        "workspace",
        "transcript",
        "bindings",
        "+project",
        "+project.Submit",
      ]);
      expect(focusTargets(root.node).map((node) => keyOf(node))).toEqual([
        "transcript",
        "bindings",
        "+project",
        "+project.Submit",
      ]);
      expect(clock.demand).toBe(1);
      expect(paint(root.node).join("\n")).not.toContain("Commit and push");

      // The branch is halted, not merely detached: its scope is gone, so a key
      // sent to what used to be the control reaches no middleware at all.
      expect(press(root.node, commit, { key: "Enter" }).path).toEqual([]);
      expect(confirm.props.opened).toBe(0);
    });

    it("removes the whole stack when the drawer below it closes", function* () {
      const { root, clock, show } = yield* harness();
      yield* show(workspace([PROJECT, CONFIRM]));
      expect(clock.demand).toBe(2);

      yield* show(workspace([]));

      expect(topology(root.node)).toEqual(["workspace", "transcript", "bindings"]);
      expect(clock.demand).toBe(0);
    });

    it("stops the removed branch's frames rather than leaving them running", function* () {
      const { root, clock, show } = yield* harness();
      yield* show(workspace([PROJECT, CONFIRM]));
      const confirm = expectNode(root.node, "+confirm");

      clock.tick(16);
      yield* settle();
      expect(confirm.props.opened).toBe(1);

      yield* show(workspace([PROJECT]));
      clock.tick(16);
      clock.tick(16);
      yield* settle();

      // Its scope is destroyed, so the props it last wrote are all it has.
      expect(confirm.props.opened).toBe(1);
      expect(clock.demand).toBe(1);
    });
  });

  suite("input travels the live ancestry and comes back as an action", () => {
    it("claims a key at the innermost branch that understands it", function* () {
      const { root, show } = yield* harness();
      yield* show(workspace([PROJECT, CONFIRM]));

      const commit = expectNode(root.node, "+confirm.Commit");
      const delivered = press(root.node, commit, { key: "Enter" });

      expect(delivered.action).toEqual({ kind: "drawer.commit", from: "Commit" });
      expect(delivered.path).toEqual(["workspace", "+project", "+confirm", "+confirm.Commit"]);
    });

    it("bubbles a key the control does not claim to the branch that does", function* () {
      const { root, show } = yield* harness();
      yield* show(workspace([PROJECT, CONFIRM]));

      const commit = expectNode(root.node, "+confirm.Commit");
      const delivered = press(root.node, commit, { key: "Escape" });

      // The control has no meaning for Escape; the drawer it is inside does.
      expect(delivered.action).toEqual({ kind: "drawer.close", from: "+confirm" });
    });

    it("answers from the input a branch was last reconciled to", function* () {
      const { root, show } = yield* harness();
      yield* show(workspace([PROJECT]));

      const renamed: DrawerInput = {
        ...PROJECT,
        kind: "project",
        controls: [{ label: "Submit", action: "drawer.retry" }],
      };
      yield* show(workspace([renamed]));

      const submit = expectNode(root.node, "+project.Submit");
      expect(press(root.node, submit, { key: "Enter" }).action?.kind).toBe("drawer.retry");
    });
  });

  suite("negative controls", () => {
    it("positional-only reconciliation: matching by index moves state to the wrong child", function* () {
      const { root, show } = yield* harness();
      yield* show(workspace([PROJECT]));
      const transcript = expectNode(root.node, "transcript");
      const bindings = expectNode(root.node, "bindings");

      // What an index-matched reconciler would have decided for the reorder:
      // position 0 keeps position 0's node, so `bindings` would inherit the
      // node `transcript` was mounted on.
      const byPosition = [PANELS[1], PANELS[0]].map((panel, index) => ({
        key: panel.key,
        node: index === 0 ? transcript : bindings,
      }));
      expect(byPosition[0]).toEqual({ key: "bindings", node: transcript });

      yield* show({ panels: [PANELS[1], PANELS[0]], drawers: [PROJECT] });

      // Matching by key keeps each child on the node it was mounted on.
      expect(expectNode(root.node, "bindings")).toBe(bindings);
      expect(expectNode(root.node, "transcript")).toBe(transcript);
    });

    it("hidden-but-live drawer: hiding leaves every contribution behind", function* () {
      const { root, clock, show } = yield* harness();
      yield* show(workspace([PROJECT, CONFIRM]));
      const commit = expectNode(root.node, "+confirm.Commit");

      // A "hide" that only stops drawing: the node stays, so the focus target,
      // the input path and the frame demand all stay with it.
      const hidden = expectNode(root.node, "+confirm");
      hidden.set("hidden", true);

      expect(focusTargets(root.node).map((node) => keyOf(node))).toContain("+confirm.Commit");
      expect(press(root.node, commit, { key: "Enter" }).action).toBeDefined();
      expect(clock.demand).toBe(2);

      // Removing it is what makes those contributions stop.
      yield* show(workspace([PROJECT]));

      expect(focusTargets(root.node).map((node) => keyOf(node))).not.toContain("+confirm.Commit");
      expect(press(root.node, commit, { key: "Enter" }).action).toBe(undefined);
      expect(clock.demand).toBe(1);
    });

    it("parallel registry: a collection beside the tree outlives what it records", function* () {
      const { root, show } = yield* harness();

      // A registry that records what was mounted, the way a component runtime
      // beside Freedom would have to.
      const registry: string[] = [];
      const record = (node: Node): void => {
        const key = keyOf(node);
        if (key !== undefined && !registry.includes(key)) {
          registry.push(key);
        }
        for (const child of node.children) {
          record(child);
        }
      };

      yield* show(workspace([PROJECT, CONFIRM]));
      record(root.node);
      expect(registry).toContain("+confirm");

      yield* show(workspace([PROJECT]));
      record(root.node);

      // Nothing told the registry, so it still says the drawer is there.
      expect(registry).toContain("+confirm");
      // The tree needed telling by nobody.
      expect(topology(root.node)).not.toContain("+confirm");
    });
  });

  suite("the tree is the only thing that is mounted", () => {
    it("destroys every branch when the root goes", function* () {
      const { root, clock, show } = yield* harness();
      yield* show(workspace([PROJECT, CONFIRM]));
      expect(clock.demand).toBe(2);

      yield* until(root.destroy());

      expect(clock.demand).toBe(0);
    });
  });
});
