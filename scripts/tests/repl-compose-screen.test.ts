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
import { decodeRoute, resolveRoute } from "../repl-compose/router.ts";
import type { ResolvedLocation } from "../repl-compose/router.ts";
import { describeScreen } from "../repl-compose/screen.ts";
import type { SessionSnapshot, Viewport } from "../repl-compose/screen.ts";

const MODEL = projectModel(EXECUTION);
const SESSION: SessionSnapshot = { scroll: {} };
const WIDE: Viewport = { columns: 120, rows: 30 };
const NARROW: Viewport = { columns: 72, rows: 20 };

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
        "bindings",
        "history",
        "entry-1",
        "document",
        "project",
        "project.answer",
        "confirm",
        "confirm.answer",
      ]);

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
      expect(normalize({ kind: "bytes", bytes: Uint8Array.from([13]) })).toEqual({ key: "Enter" });
      expect(normalize({ kind: "pointer", button: "primary" })).toEqual({ key: "Enter" });
      expect(normalize({ kind: "bytes", bytes: Uint8Array.from([27]) })).toEqual({ key: "Escape" });
      expect(normalize({ kind: "pointer", button: "secondary" })).toEqual({ key: "Escape" });
    });

    it("emits one action down one live ancestry, whichever arrived", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);

      const answer = expectNode(root.node, "confirm.answer");
      focus(answer);

      const typed = host.deliver({ kind: "bytes", bytes: Uint8Array.from([13]) });
      const clicked = host.deliver({ kind: "pointer", button: "primary" });

      expect(typed.action).toEqual({ kind: "suspension.answer", from: "Answer" });
      expect(clicked.action).toEqual(typed.action);
      expect(clicked.path).toEqual(typed.path);
      expect(typed.path).toEqual(["screen", "workbench", "project", "confirm", "confirm.answer"]);
    });

    it("bubbles to the drawer when the control has nothing to say", function* () {
      const { root, host, go } = yield* harness();
      yield* go(STACKED);
      focus(expectNode(root.node, "confirm.answer"));

      const escaped = host.deliver({ kind: "bytes", bytes: Uint8Array.from([27]) });
      const secondary = host.deliver({ kind: "pointer", button: "secondary" });

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
      expect(host.deliver({ kind: "pointer", button: "primary" }).path).not.toContain(
        "confirm.answer",
      );
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
