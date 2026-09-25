/**
 * The whole way down: a URL, a model, a mounted tree, and what a terminal gets.
 *
 * Slice 1 proved a location resolves and Slice 2 proved a description mounts.
 * What is left is the claim those two were for: that one resolved location
 * decides the interface, and that everything after it — layout, rendering,
 * focus, input, teardown — reads the one tree rather than agreeing with it.
 *
 * So the cases here are the ones a design with a second representation could
 * not pass: the same location at two viewports describing the same tree, a
 * refusal that leaves nothing of the screen it replaced, a renderer swapped
 * under a running animation, and a host that can be read from top to bottom
 * without finding the name of anything it is showing.
 */

import { describe as suite, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import { until } from "effection";
import type { Operation, Result } from "effection";
import { fileURLToPath } from "node:url";

import { focus, useRoot } from "../repl-study/vendor/freedom/upstream/index.ts";
import type { Node, Root } from "../repl-study/vendor/freedom/upstream/index.ts";

import { useFrameClock } from "../repl-compose/frames.ts";
import type { FrameClock } from "../repl-compose/frames.ts";
import { EXECUTION, projectModel } from "../repl-compose/history.ts";
import { createHost, focused, normalize } from "../repl-compose/host.ts";
import type { Host } from "../repl-compose/host.ts";
import { focusTargets, keyOf, paint, topology } from "../repl-compose/reconcile.ts";
import { framedRenderer, plainRenderer } from "../repl-compose/render.ts";
import { decodeRoute, resolveRoute, ROUTE_SURFACES } from "../repl-compose/router.ts";
import type { ResolvedLocation } from "../repl-compose/router.ts";
import { describeScreen } from "../repl-compose/screen.ts";
import type { SessionSnapshot, Viewport } from "../repl-compose/screen.ts";

const MODEL = projectModel(EXECUTION);
const SESSION: SessionSnapshot = { scroll: {} };
const WIDE: Viewport = { columns: 120, rows: 30 };
const NARROW: Viewport = { columns: 72, rows: 20 };

const ENTRY = "xmd://repl/e1/transcript/entry-1/document?at=cp-10&inspect";
const PROJECT = "xmd://repl/e1/transcript/entry-1/document/+project?at=cp-10&inspect";
const STACKED = "xmd://repl/e1/transcript/entry-1/document/+project/+confirm?at=cp-10&inspect";
const NOWHERE = "xmd://repl/e1/transcript/entry-1/document/+review?at=cp-10&inspect";

function located(url: string): Result<ResolvedLocation> {
  const decoded = decodeRoute(url);
  return decoded.ok ? resolveRoute(decoded.value, MODEL) : decoded;
}

interface Harness {
  readonly root: Root;
  readonly clock: FrameClock;
  readonly host: Host;
  go(url: string, viewport?: Viewport): Operation<void>;
}

function* harness(): Operation<Harness> {
  const root = yield* useRoot();
  const clock = yield* useFrameClock();
  const host = createHost({ root, clock, renderer: plainRenderer, viewport: WIDE });
  return {
    root,
    clock,
    host,
    *go(url: string, viewport: Viewport = host.viewport): Operation<void> {
      host.resize(viewport);
      const shown = yield* host.show(describeScreen(located(url), SESSION, viewport));
      if (!shown.ok) {
        throw shown.error;
      }
    },
  };
}

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

/** Where a node sits, by the keys it was described by, outermost first. */
function ancestryOf(node: Node): string[] {
  const path: string[] = [];
  for (let at: Node | undefined = node; at; at = at.parent) {
    const key = keyOf(at);
    if (key !== undefined) {
      path.unshift(key);
    }
  }
  return path;
}

function expectNode(node: Node, key: string): Node {
  const found = find(node, key);
  if (found === undefined) {
    throw new Error(`no mounted branch is keyed ${JSON.stringify(key)}`);
  }
  return found;
}

suite("REPL composition: one location, all the way down", () => {
  suite("a resolved location decides the tree", () => {
    it("mounts the entry, its scope path and the drawer stack it names", function* () {
      const { root, go } = yield* harness();
      yield* go(STACKED);

      expect(topology(root.node)).toEqual([
        "screen",
        "workbench",
        "sessions",
        "transcript",
        "entry-1",
        "document",
        "bindings",
        "input",
        "history",
        "project",
        "project.answer",
        "project.back",
        "confirm",
        "confirm.answer",
        "confirm.back",
      ]);

      // The entry lives inside the transcript surface, which is the branch the
      // URL's surface segment names.
      expect(expectNode(root.node, "entry-1").parent).toBe(expectNode(root.node, "transcript"));

      // The stack is a branch: confirm is inside project, as the suspension
      // stack says it is.
      expect(expectNode(root.node, "confirm").parent).toBe(expectNode(root.node, "project"));
    });

    it("draws what the mounted tree drew, and nothing from anywhere else", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);

      const drawn = host.draw();
      expect(drawn).toBe(plainRenderer.draw(paint(root.node), WIDE.columns));
      expect(drawn).toContain("owner: document/write");
      expect(drawn).toContain("owner: document/publish");
    });
  });

  suite("the URL reconstructs focus", () => {
    it("focuses the branch it names, cold, for every surface a route can name", function* () {
      for (const surface of ROUTE_SURFACES) {
        // A fresh root each time: nothing carried over, nothing remembered.
        const { root, go } = yield* harness();
        yield* go(`xmd://repl/e1/${surface}/entry-1/document?at=cp-10&inspect`);

        expect({ surface, focused: keyOf(focused(root)) }).toEqual({ surface, focused: surface });
      }
    });

    it("rebuilds the same focus identity in a fresh root", function* () {
      const first = yield* harness();
      yield* first.go(STACKED);
      const identity = ancestryOf(focused(first.root));

      const second = yield* harness();
      yield* second.go(STACKED);

      // Different nodes, because it is a different tree — and the same place,
      // because the URL says where that is.
      expect(ancestryOf(focused(second.root))).toEqual(identity);
      expect(focused(second.root)).not.toBe(focused(first.root));
    });

    it("hands focus to the drawer the location opened, and back when it closes", function* () {
      const { root, go } = yield* harness();
      yield* go(ENTRY);
      expect(keyOf(focused(root))).toBe("transcript");

      yield* go(PROJECT);
      expect(ancestryOf(focused(root))).toEqual(["screen", "workbench", "project"]);

      yield* go(STACKED);
      expect(ancestryOf(focused(root))).toEqual(["screen", "workbench", "project", "confirm"]);

      yield* go(PROJECT);
      // The branch that held focus is gone, so focus is back on what is asking
      // for it now. Nothing outside the description said the word "drawer".
      expect(ancestryOf(focused(root))).toEqual(["screen", "workbench", "project"]);
    });

    it("leaves focus alone when the same location is composed again", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);
      const back = expectNode(root.node, "confirm.back");
      host.deliver({ kind: "pointer", button: "primary", on: back.id });
      expect(keyOf(focused(root))).toBe("confirm.back");

      yield* go(STACKED);

      // Focus that jumped on every reconcile would be taken away from whoever
      // was using it.
      expect(keyOf(focused(root))).toBe("confirm.back");
    });
  });

  suite("layout presents; it does not decide existence", () => {
    it("describes the same tree at two viewports and draws it differently", function* () {
      const { root, host, go } = yield* harness();

      yield* go(STACKED, WIDE);
      const wideTopology = topology(root.node);
      const wideFocus = focusTargets(root.node).map((node) => keyOf(node));
      const wideDrawn = host.draw();

      yield* go(STACKED, NARROW);

      expect(topology(root.node)).toEqual(wideTopology);
      expect(focusTargets(root.node).map((node) => keyOf(node))).toEqual(wideFocus);
      expect(host.draw()).not.toBe(wideDrawn);
      expect(host.draw()).toContain("— narrow —");
    });

    it("keeps every branch through a resize, rather than remounting them", function* () {
      const { root, clock, go } = yield* harness();
      yield* go(STACKED, WIDE);
      const confirm = expectNode(root.node, "confirm");
      yield* clock.advance(16);
      expect(confirm.props.opened).toBe(1);

      yield* go(STACKED, NARROW);

      expect(expectNode(root.node, "confirm")).toBe(confirm);
      expect(confirm.props.opened).toBe(1);
      expect(clock.demand).toBe(2);
    });
  });

  suite("a refusal is the whole screen", () => {
    it("leaves nothing of the location it replaced", function* () {
      const { root, host, clock, go } = yield* harness();
      yield* go(STACKED);
      expect(clock.demand).toBe(2);

      yield* go(NOWHERE);

      // Only the refusal is described, so only the refusal is mounted. There is
      // no half-resolved screen behind it holding focus, input or frames.
      expect(topology(root.node)).toEqual(["screen", "refusal"]);
      expect(focusTargets(root.node).map((node) => keyOf(node))).toEqual(["refusal"]);
      expect(clock.demand).toBe(0);
      expect(host.draw()).toContain("does not exist in this execution");
      expect(host.draw()).not.toContain("owner:");
    });

    it("says which segment refused, in the words the router used", function* () {
      const { host, go } = yield* harness();
      yield* go(NOWHERE);

      expect(host.draw()).toContain('"review" is not drawer 1 of entry-1 at cp-10');
    });

    it("comes back to a whole screen when the next location resolves", function* () {
      const { root, clock, go } = yield* harness();
      yield* go(NOWHERE);
      yield* go(STACKED);

      expect(topology(root.node)).toContain("confirm.answer");
      expect(clock.demand).toBe(2);
    });
  });

  suite("keyboard and pointer are the same activation", () => {
    it("normalizes both to one value before anything is dispatched", function* () {
      // The keypress is the same value either way; the target rides alongside
      // it, so the tree is handed something with no trace of how it arrived.
      expect(normalize({ kind: "bytes", bytes: Uint8Array.from([13]) })?.key).toEqual({
        key: "Enter",
      });
      expect(normalize({ kind: "pointer", button: "primary", on: "node-3" })).toEqual({
        key: { key: "Enter" },
        on: "node-3",
      });
      expect(normalize({ kind: "bytes", bytes: Uint8Array.from([27]) })?.key).toEqual({
        key: "Escape",
      });
      expect(normalize({ kind: "pointer", button: "secondary", on: "node-3" })?.key).toEqual({
        key: "Escape",
      });
    });

    it("emits one action down one live ancestry, whichever arrived", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);

      const answer = expectNode(root.node, "confirm.answer");
      focus(answer);
      const typed = host.deliver({ kind: "bytes", bytes: Uint8Array.from([13]) });

      const clicked = host.deliver({ kind: "pointer", button: "primary", on: answer.id });

      expect(typed.action).toEqual({ kind: "suspension.answer", from: "Answer" });
      expect(clicked.action).toEqual(typed.action);
      expect(clicked.path).toEqual(typed.path);
      expect(typed.path).toEqual(["screen", "workbench", "project", "confirm", "confirm.answer"]);
    });

    it("activates what the pointer was on, not what had focus", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);

      const answer = expectNode(root.node, "confirm.answer");
      const back = expectNode(root.node, "confirm.back");
      focus(answer);
      expect(keyOf(focused(root))).toBe("confirm.answer");

      const clicked = host.deliver({ kind: "pointer", button: "primary", on: back.id });

      // Focus moved to what was pointed at, and the action is that control's.
      expect(keyOf(focused(root))).toBe("confirm.back");
      expect(clicked.action).toEqual({ kind: "drawer.close", from: "Back" });
      expect(clicked.path[clicked.path.length - 1]).toBe("confirm.back");

      // And the keyboard at that same node now answers identically.
      const typed = host.deliver({ kind: "bytes", bytes: Uint8Array.from([13]) });
      expect(typed.action).toEqual(clicked.action);
      expect(typed.path).toEqual(clicked.path);
    });

    it("gives nothing to a removed, disabled, container or absent target", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);

      const settled = keyOf(focused(root));
      const cases: readonly [string, string][] = [
        // Drawn, but never made focusable: a control on the drawer underneath.
        ["disabled", expectNode(root.node, "project.answer").id],
        // A branch that holds children and is not a place focus can be.
        ["container", expectNode(root.node, "workbench").id],
        // Nothing at all.
        ["absent", "node-that-was-never-here"],
      ];

      for (const [name, on] of cases) {
        const clicked = host.deliver({ kind: "pointer", button: "primary", on });
        expect({ name, path: clicked.path, action: clicked.action }).toEqual({
          name,
          path: [],
          action: undefined,
        });
        expect(keyOf(focused(root))).toBe(settled);
      }

      // Removed: the node existed a moment ago and does not now.
      const going = expectNode(root.node, "confirm.answer").id;
      yield* go(PROJECT);
      const after = host.deliver({ kind: "pointer", button: "primary", on: going });
      expect(after.path).toEqual([]);
      expect(after.action).toBe(undefined);
    });

    it("bubbles to the drawer when the control has nothing to say", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);
      focus(expectNode(root.node, "confirm.answer"));

      const answer = expectNode(root.node, "confirm.answer");
      const escaped = host.deliver({ kind: "bytes", bytes: Uint8Array.from([27]) });
      const secondary = host.deliver({ kind: "pointer", button: "secondary", on: answer.id });

      expect(escaped.action).toEqual({ kind: "drawer.close", from: "confirm" });
      expect(secondary.action).toEqual(escaped.action);
    });

    it("puts focus on something that exists after the tree changes", function* () {
      const { root, go } = yield* harness();
      yield* go(STACKED);
      focus(expectNode(root.node, "confirm.answer"));
      expect(keyOf(focused(root))).toBe("confirm.answer");

      yield* go(PROJECT);

      // Focus is derived from the tree there is now. A host that remembered the
      // node it focused last would be pointing at one that no longer exists,
      // and the next key would go nowhere.
      const now = focused(root);
      expect(focusTargets(root.node)).toContain(now);
      expect(keyOf(now)).not.toBe("confirm.answer");
    });

    it("delivers nothing into a branch the location closed", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);
      const answer = expectNode(root.node, "confirm.answer");

      yield* go(PROJECT);

      // Focus is derived from the tree that exists now, so the host cannot even
      // address the control that went — and the node it used to be is inert.
      expect(focusTargets(root.node).map((node) => keyOf(node))).not.toContain("confirm.answer");
      expect(find(root.node, "confirm")).toBe(undefined);
      expect(host.deliver({ kind: "pointer", button: "primary", on: answer.id }).path).toEqual([]);
      expect(answer.props.opened).toBe(undefined);
    });
  });

  suite("the renderer is replaceable", () => {
    it("changes the bytes and nothing else", function* () {
      const { root, host, clock, go } = yield* harness();
      yield* go(STACKED);
      yield* clock.advance(16);
      yield* clock.advance(32);

      const confirm = expectNode(root.node, "confirm");
      const before = {
        topology: topology(root.node),
        focus: focusTargets(root.node).map((node) => keyOf(node)),
        opened: confirm.props.opened,
        at: confirm.props.at,
        demand: clock.demand,
      };
      const plain = host.draw();

      host.use(framedRenderer);
      const framed = host.draw();

      expect(framed).not.toBe(plain);
      expect(framed).toContain("│");
      expect(host.renderer.name).toBe("framed");

      // The location, the topology and the animation are where they were.
      expect(topology(root.node)).toEqual(before.topology);
      expect(focusTargets(root.node).map((node) => keyOf(node))).toEqual(before.focus);
      expect(expectNode(root.node, "confirm")).toBe(confirm);
      expect(confirm.props.opened).toBe(before.opened);
      expect(confirm.props.at).toBe(before.at);
      expect(clock.demand).toBe(before.demand);
    });

    it("keeps animating after the swap, on the same branches", function* () {
      const { root, host, clock, go } = yield* harness();
      yield* go(STACKED);
      yield* clock.advance(16);
      host.use(framedRenderer);
      yield* clock.advance(32);

      const confirm = expectNode(root.node, "confirm");
      expect(confirm.props.opened).toBe(2);
      expect(confirm.props.at).toBe(32);
    });
  });

  suite("the host knows nothing about what it is showing", () => {
    it("names no route segment, drawer kind, surface or component", function* () {
      const source = yield* readTextFile(
        fileURLToPath(new URL("../repl-compose/host.ts", import.meta.url)),
      );
      // The prose is allowed to explain the invariant; the code is what has to
      // keep it, so the comments come out before this looks.
      const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

      for (const name of [
        "entry-1",
        "document",
        "project",
        "confirm",
        "transcript",
        "sessions",
        "bindings",
        "drawer",
        "workbench",
        "suspension",
        "checkpoint",
        "xmd://repl",
      ]) {
        expect(code).not.toContain(name);
      }
    });

    it("imports no history, no model and no router", function* () {
      const source = yield* readTextFile(
        fileURLToPath(new URL("../repl-compose/host.ts", import.meta.url)),
      );
      const specifiers = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map(
        (match) => match[1],
      );

      expect(specifiers).not.toContain("./history.ts");
      expect(specifiers).not.toContain("./model.ts");
      expect(specifiers).not.toContain("./router.ts");
    });
  });

  suite("the tree ends with the run", () => {
    it("takes every branch and every frame demand with it", function* () {
      const { root, clock, go } = yield* harness();
      yield* go(STACKED);
      expect(clock.demand).toBe(2);

      yield* until(root.destroy());

      expect(clock.demand).toBe(0);
    });
  });
});
