import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { open, close, fixed } from "@bomb.sh/tty";
import { describe as node } from "../src/repl/description.ts";
import { VIEWPORT } from "../src/repl/components/viewport.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import { resolveWheel, useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplAction } from "../src/repl/components/actions.ts";

const SIZE = { columns: 30, rows: 10 };

describe("wheel committed frame", () => {
  it("copies empty viewport geometry separately from activation and dispatches through live modal ancestry", function* () {
    const tree = yield* useReplTree<ReplAction>();
    const renderer = yield* useReplRenderer(SIZE);
    const owner = node({ key: "viewport", component: VIEWPORT, input: { window: "sidekick" } });
    const applied = yield* tree.apply([owner]);
    if (!applied.ok) {
      throw applied.error;
    }
    const mounted = tree.mounted().find((id) => tree.keyOf(id) === "viewport");
    if (mounted === undefined) {
      throw new Error("viewport did not mount");
    }
    const draw = yield* renderer.draw({
      ops: [open("viewport-box", { layout: { width: fixed(30), height: fixed(5) } }), close()],
      boxes: [],
      scrolls: [{ id: "viewport-box", node: mounted }],
      regions: ["viewport-box"],
      tree: tree.frame().id,
      size: SIZE,
      deltaTime: 0,
      pointer: undefined,
    });
    if (!draw.ok) {
      throw draw.error;
    }
    const frame = draw.value;
    expect(frame.map.targets).toEqual([]);
    expect(frame.map.at(0, 0)).toBeUndefined();
    expect(frame.map.scrollAt(29, 4)).toBe(mounted);
    expect(frame.map.scrollAt(30, 4)).toBeUndefined();
    expect(frame.map.scrollAt(0, 5)).toBeUndefined();
    const event = resolveWheel(frame, { column: 20, row: 3 }, "down");
    if (event === undefined) {
      throw new Error("empty body cell had no owner");
    }
    expect(event.frame).toBe(tree.frame().id);
    expect(yield* tree.dispatch(event)).toMatchObject({
      ok: true,
      value: {
        outcome: "action",
        action: { kind: "viewport-wheel", window: "sidekick", direction: "down" },
      },
    });
    expect(tree.focused()).toBeUndefined();
    const modal = node({
      key: "modal",
      component: VIEWPORT,
      input: { window: "drawer" },
      modal: true,
    });
    yield* tree.apply([owner, modal]);
    expect(yield* tree.dispatch(event)).toMatchObject({ ok: true, value: { outcome: "dropped" } });
    expect(yield* tree.dispatch({ ...event, frame: tree.frame().id })).toMatchObject({
      ok: true,
      value: { outcome: "dropped" },
    });
    yield* tree.apply([]);
    expect(yield* tree.dispatch({ ...event, frame: tree.frame().id })).toMatchObject({
      ok: true,
      value: { outcome: "dropped" },
    });
    renderer.resize({ columns: 40, rows: 15 });
    expect(frame.map.scrolls[0].bounds).toEqual({ x: 0, y: 0, width: 30, height: 5 });
  });
  it("uses draw order for overlaps, omits zero-sized regions and retains old copied bounds", function* () {
    const renderer = yield* useReplRenderer(SIZE);
    const request = {
      ops: [
        open("root", { layout: { width: fixed(30), height: fixed(10) } }),
        open("back", { layout: { width: fixed(30), height: fixed(5) } }),
        close(),
        open("front", {
          layout: { width: fixed(20), height: fixed(3) },
          floating: { x: 0, y: 0, attachTo: "root", zIndex: 10 },
        }),
        close(),
        open("zero", { layout: { width: fixed(0), height: fixed(0) } }),
        close(),
        close(),
      ],
      boxes: [],
      scrolls: [
        { id: "front", node: "front-owner" },
        { id: "zero", node: "zero-owner" },
        { id: "back", node: "back-owner" },
      ],
      regions: [],
      tree: 1,
      size: SIZE,
      deltaTime: 0,
      pointer: undefined,
    };
    const draw = yield* renderer.draw(request);
    if (!draw.ok) {
      throw draw.error;
    }
    const frame = draw.value;
    expect(frame.map.scrollAt(10, 1)).toBe("front-owner");
    expect(frame.map.scrollAt(25, 1)).toBe("back-owner");
    expect(frame.map.scrolls.map((one) => one.node)).toEqual(["back-owner", "front-owner"]);
    const changed = yield* renderer.draw({
      ...request,
      ops: [
        open("root", { layout: { width: fixed(30), height: fixed(10) } }),
        open("back", { layout: { width: fixed(30), height: fixed(2) } }),
        close(),
        close(),
      ],
    });
    if (!changed.ok) {
      throw changed.error;
    }
    expect(changed.value.map.scrolls[0].bounds.height).toBe(2);
    expect(frame.map.scrolls[0].bounds.height).toBe(5);
  });
});
