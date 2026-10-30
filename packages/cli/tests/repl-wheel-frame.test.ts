import type { Operation } from "effection";
import { journalModel } from "./fixtures/repl/journals.ts";
import { usePresenter } from "./fixtures/repl/presentation.ts";
import { readQuestionForm } from "../src/repl/elicitation.ts";
import {
  initialState,
  reduceRepl,
  viewFor,
  withWorkspace,
  workspaceOf,
  presentedDrawer,
  NO_AGENT,
} from "../src/repl/application.ts";
import type { ReplLive } from "../src/repl/application.ts";
import type { ReplInputEvent } from "../src/repl/description.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
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

describe("foundation wheel anchor lifetime", () => {
  it("retains the focused reading anchor when wheel enters a control-only question page", function* () {
    const model = yield* journalModel(["# Current entry"]);
    const size = { columns: 120, rows: 30 };
    const presenter = yield* usePresenter(size);
    const live: ReplLive = {
      output: "",
      expansion: "playing",
      pausable: false,
      running: true,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
      question: {
        message: Array.from({ length: 40 }, (_, index) => `Preview row ${index}`).join("\n"),
        form: readQuestionForm({
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: Array.from({ length: 35 }, (_, index) => `pick-${index}`),
            },
          },
          required: ["decision"],
          additionalProperties: false,
        }),
        submit() {
          throw new Error("the witness must not submit");
        },
      },
    };
    let state = reduceRepl(
      initialState("anchor-witness"),
      { kind: "open-drawer", drawer: { kind: "live-elicit" } },
      model,
      live,
    ).state;
    const focused = () => {
      const id = presenter.tree.focused();
      return id === undefined ? undefined : presenter.tree.keyOf(id);
    };
    function view() {
      const resolved = viewFor(state, model, live, size, focused());
      if (!resolved.ok) {
        throw resolved.error;
      }
      return withWorkspace(resolved.value, workspaceOf(model));
    }
    let current = view();
    let shown = yield* presenter.commit(current);
    function* send(event: ReplInputEvent): Operation<void> {
      const dispatched = yield* presenter.tree.dispatch(event);
      if (!dispatched.ok) {
        throw dispatched.error;
      }
      if (dispatched.value.outcome === "action") {
        state = reduceRepl(
          state,
          dispatched.value.action,
          model,
          live,
          shown.committed.admission,
          presentedDrawer(current),
        ).state;
      }
      current = view();
      shown = yield* presenter.commit(current);
    }
    for (
      let page = 0;
      page < 15 && !presenter.grid.rows().some((row) => row.includes("Preview row 0"));
      page++
    ) {
      yield* send({ kind: "key", key: "PageUp" });
    }
    expect(presenter.grid.rows().some((row) => row.includes("Preview row 0"))).toBe(true);
    expect(focused()).toBe("drawer:reading:anchor");
    const anchor = presenter.tree.focused();
    expect(anchor).toBeDefined();
    let controlsOnly = false;
    for (let tick = 0; tick < 25; tick++) {
      const scroll = shown.committed.rendered.map.scrolls.find(
        (one) => one.id === "box:drawer:viewport",
      );
      if (scroll === undefined) {
        throw new Error("production drawer viewport is absent");
      }
      const event = resolveWheel(
        shown.committed.rendered,
        { column: scroll.bounds.x, row: scroll.bounds.y },
        "down",
      );
      if (event === undefined) {
        throw new Error("production wheel did not resolve");
      }
      yield* send(event);
      expect(shown.nodeOf("drawer:reading:anchor")).toBe(anchor);
      expect(shown.mounted).toContain(anchor);
      expect(shown.targets.some((target) => target.node === anchor)).toBe(false);
      const window = shown.committed.admission.windows.get("drawer");
      if (window === undefined) {
        throw new Error("production drawer admission is absent");
      }
      if (presenter.grid.textIn(scroll.bounds).every((row) => row.includes("( ) pick-"))) {
        controlsOnly = true;
        expect(shown.keys.some((key) => key.startsWith("drawer:message:"))).toBe(false);
        expect(shown.boundsOf("drawer:reading:anchor")).toBeUndefined();
        const choices = shown.keys.filter((key) => key.startsWith("drawer:choice:"));
        expect(choices).toHaveLength(window.count);
      }
      expect(presenter.tree.focused()).toBe(anchor);
    }
    expect(controlsOnly).toBe(true);
  });
});

describe("wheel ordinary Entries composition", () => {
  it("pairs permanent catalog admission with its mounted viewport owner", function* () {
    const model = yield* journalModel(
      Array.from({ length: 18 }, (_, at) => `Ordinary entry ${at}`),
    );
    const size = { columns: 160, rows: 36 };
    const live: ReplLive = {
      output: "",
      expansion: "playing",
      pausable: false,
      running: false,
      question: undefined,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    };
    const presenter = yield* usePresenter(size);
    let state = initialState("ordinary-catalog");
    const view = () => {
      const id = presenter.tree.focused();
      const resolved = viewFor(
        state,
        model,
        live,
        size,
        id === undefined ? undefined : presenter.tree.keyOf(id),
      );
      if (!resolved.ok) {
        throw resolved.error;
      }
      return resolved.value;
    };
    let shown = yield* presenter.commit(view());
    function* tick(direction: "up" | "down"): Operation<void> {
      const scroll = shown.committed.rendered.map.scrolls.find(
        (one) => one.id === "box:entries:viewport",
      );
      if (scroll === undefined) {
        throw new Error("ordinary Entries has no live viewport");
      }
      expect(presenter.tree.mounted()).toContain(scroll.node);
      const event = resolveWheel(
        shown.committed.rendered,
        { column: scroll.bounds.x, row: scroll.bounds.y },
        direction,
      );
      if (event === undefined) {
        throw new Error("body cell has no target");
      }
      const dispatched = yield* presenter.tree.dispatch(event);
      if (!dispatched.ok) {
        throw dispatched.error;
      }
      if (dispatched.value.outcome !== "action") {
        throw new Error("viewport did not act");
      }
      state = reduceRepl(
        state,
        dispatched.value.action,
        model,
        live,
        shown.committed.admission,
      ).state;
      shown = yield* presenter.commit(view());
    }
    expect(shown.keys).toContain("entry:entry-1");
    yield* tick("down");
    expect(shown.keys).not.toContain("entry:entry-1");
    yield* tick("up");
    expect(shown.keys).toContain("entry:entry-1");
    for (let at = 0; at < 12; at += 1) {
      yield* tick("down");
    }
    expect(shown.keys).toContain("entry:entry-18");
    expect(shown.keys).not.toContain("entries:later");
  });
});
