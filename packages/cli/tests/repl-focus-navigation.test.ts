/**
 * Region navigation, as the tree answers it (#895).
 *
 * Three layers, each through the boundary the next one consumes: the pure rules
 * over placed stops, the mounted tree that applies them after a focused
 * control's own handler, and the decoder that names the keys. The mounted REPL's
 * own journeys are in `repl-focus-regions.test.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createInput } from "@bomb.sh/tty";
import { until } from "effection";
import type { Operation, Result } from "effection";

import { component, describe as describeNode, fields } from "../src/repl/description.ts";
import type {
  ReplComponent,
  ReplDescription,
  ReplInputEvent,
  ReplKey,
  ReplNode,
} from "../src/repl/description.ts";
import {
  arrowTarget,
  focusLayout,
  homeTarget,
  regionTarget,
  survivorTarget,
} from "../src/repl/focus-navigation.ts";
import type {
  ReplFocusGroup,
  ReplFocusRegion,
  ReplNavigationKey,
  ReplPlacement,
  ReplStop,
} from "../src/repl/focus-navigation.ts";
import { scanInput } from "../src/repl/input.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import type { ReplDispatched, ReplTree } from "../src/repl/reconcile.ts";

const LIST: ReplFocusRegion = { key: "list", rank: 1, axis: "vertical" };
const ROW: ReplFocusRegion = { key: "row", rank: 2, axis: "horizontal" };
const TAIL: ReplFocusRegion = { key: "tail", rank: 3, axis: "vertical" };

const vertical = (key: string): ReplFocusGroup => ({ key, axis: "vertical" });
const horizontal = (key: string): ReplFocusGroup => ({ key, axis: "horizontal" });

function stop(id: string, placement?: ReplPlacement): ReplStop {
  return { id, placement };
}

/** Follow keys from one stop, answering where focus is after each. */
function walk(stops: readonly ReplStop[], from: string, keys: readonly ReplNavigationKey[]) {
  const layout = focusLayout(stops);
  let at = from;
  const visited: string[] = [];
  for (const key of keys) {
    at = arrowTarget(layout, at, key) ?? at;
    visited.push(at);
  }
  return visited;
}

/**
 * A catalog-shaped region: two entries, each heading its scopes, the second
 * entry's first scope heading one of its own.
 */
const CATALOG: readonly ReplStop[] = [
  stop("e1", { region: LIST, groups: [vertical("e1")], anchor: true }),
  stop("e1/a", { region: LIST, groups: [vertical("e1"), vertical("e1/a")], anchor: true }),
  stop("e2", { region: LIST, groups: [vertical("e2")], anchor: true }),
  stop("e2/a", { region: LIST, groups: [vertical("e2"), vertical("e2/a")], anchor: true }),
  stop("e2/a/x", {
    region: LIST,
    groups: [vertical("e2"), vertical("e2/a"), vertical("e2/a/x")],
    anchor: true,
  }),
  stop("e2/b", { region: LIST, groups: [vertical("e2"), vertical("e2/b")], anchor: true }),
];

describe("region navigation: the rules over placed controls", () => {
  it("N1: Tab enters each region at its fixed entry, whatever was visited, and wraps", function* () {
    const stops = [
      ...Array.from({ length: 40 }, (_, at) => stop(`turn-${at}`, { region: LIST })),
      stop("send", { region: ROW }),
      stop("field", { region: ROW, entry: 0 }),
      stop("history", { region: TAIL, entry: 0 }),
      stop("exit", { region: TAIL, entry: 1 }),
    ];
    const layout = focusLayout(stops);
    // Forty controls in the first region cost one press, not forty.
    expect(regionTarget(layout, stops, "turn-17", 1)).toBe("field");
    expect(regionTarget(layout, stops, "send", 1)).toBe("history");
    expect(regionTarget(layout, stops, "exit", 1)).toBe("turn-0");
    expect(regionTarget(layout, stops, "turn-0", -1)).toBe("history");
    // Leaving a region from a child it was not entered at changes nothing
    // about where entering it lands next time.
    expect(regionTarget(layout, stops, "history", -1)).toBe("field");
  });

  it("N1: an entry preference falls back in order, then to the first control", function* () {
    const stops = [
      stop("mark-1", { region: TAIL }),
      stop("mark-2", { region: TAIL }),
      stop("pause", { region: TAIL, entry: 1 }),
      stop("other", { region: LIST }),
    ];
    const layout = focusLayout(stops);
    expect(regionTarget(layout, stops, "other", 1)).toBe("pause");
    const bare = [stop("mark-1", { region: TAIL }), stop("mark-2", { region: TAIL })];
    expect(regionTarget(focusLayout(bare), bare, undefined, 1)).toBe("mark-1");
  });

  it("N2: arrows move along an axis, stop at edges, and never wrap", function* () {
    const stops = [
      stop("a", { region: ROW }),
      stop("b", { region: ROW }),
      stop("c", { region: ROW }),
    ];
    expect(walk(stops, "a", ["ArrowRight", "ArrowRight", "ArrowRight"])).toEqual(["b", "c", "c"]);
    expect(walk(stops, "a", ["ArrowLeft", "ArrowDown", "ArrowUp"])).toEqual(["a", "a", "a"]);
  });

  it("N2: an anchor enters its group at the first child and the group leaves to it", function* () {
    // Down walks entries, not every scope beneath them.
    expect(walk(CATALOG, "e1", ["ArrowDown", "ArrowDown"])).toEqual(["e2", "e2"]);
    // Right enters at the first child; Down moves among siblings; Right goes a
    // level deeper; Left climbs one level at a time.
    expect(
      walk(CATALOG, "e2", ["ArrowRight", "ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"]),
    ).toEqual(["e2/a", "e2/b", "e2/a", "e2/a/x", "e2/a"]);
    expect(walk(CATALOG, "e2/b", ["ArrowLeft", "ArrowUp"])).toEqual(["e2", "e1"]);
    // Inside a group the arrows stay in it: no edge hands focus to the parent.
    expect(walk(CATALOG, "e2/b", ["ArrowDown"])).toEqual(["e2/b"]);
    // Re-entering is at the first child again, never the one last visited.
    expect(walk(CATALOG, "e2/b", ["ArrowLeft", "ArrowRight"])).toEqual(["e2", "e2/a"]);
  });

  it("N2: a group without an anchor is one position its parent moves through", function* () {
    const crumbs = horizontal("crumbs");
    const stops = [
      stop("entries", { region: LIST, groups: [crumbs] }),
      stop("crumb-1", { region: LIST, groups: [crumbs] }),
      stop("earlier", { region: LIST }),
      stop("later", { region: LIST }),
    ];
    // Left/Right walk the row; Up/Down leave it for the column's neighbours.
    expect(walk(stops, "entries", ["ArrowRight", "ArrowDown", "ArrowDown"])).toEqual([
      "crumb-1",
      "earlier",
      "later",
    ]);
    // Coming back up lands on the row's first control.
    expect(walk(stops, "later", ["ArrowUp", "ArrowUp"])).toEqual(["earlier", "entries"]);
  });

  it("N3: Alt+arrows step depth first through one region, and stop at its edges", function* () {
    const stops = [...CATALOG, stop("close", { region: ROW })];
    expect(
      walk(stops, "e1", [
        "Alt+ArrowDown",
        "Alt+ArrowDown",
        "Alt+ArrowDown",
        "Alt+ArrowDown",
        "Alt+ArrowDown",
        "Alt+ArrowDown",
      ]),
    ).toEqual(["e1/a", "e2", "e2/a", "e2/a/x", "e2/b", "e2/b"]);
    expect(walk(stops, "e1", ["Alt+ArrowUp"])).toEqual(["e1"]);
  });

  it("N4: a departed control's survivor is its sibling, its anchor, then its region", function* () {
    const before = focusLayout(CATALOG);
    const without = (...gone: string[]) => CATALOG.filter((one) => !gone.includes(one.id));
    const after = (...gone: string[]) => {
      const now = without(...gone);
      return { layout: focusLayout(now), now };
    };
    let next = after("e2/a");
    expect(survivorTarget(before, next.layout, next.now, "e2/a")).toBe("e2/b");
    next = after("e2/b");
    expect(survivorTarget(before, next.layout, next.now, "e2/b")).toBe("e2/a");
    next = after("e2/a", "e2/b", "e2/a/x");
    expect(survivorTarget(before, next.layout, next.now, "e2/b")).toBe("e2");
  });

  it("N4: a region that is gone recovers into the lowest home, then the next region", function* () {
    const outlet: ReplFocusRegion = { key: "outlet", rank: 2, axis: "vertical", home: 0 };
    const bar: ReplFocusRegion = { key: "bar", rank: 0, axis: "horizontal", home: 1 };
    const tabs: ReplFocusRegion = { key: "tabs", rank: 4, axis: "horizontal" };
    const wide = [stop("tab", { region: tabs }), stop("history", { region: TAIL })];
    const narrow = [
      stop("sessions", { region: bar, entry: 0 }),
      stop("entries", { region: bar }),
      stop("crumb", { region: outlet }),
      stop("history", { region: { ...TAIL, rank: 7 } }),
    ];
    expect(survivorTarget(focusLayout(wide), focusLayout(narrow), narrow, "tab")).toBe("crumb");
    const empty = narrow.filter((one) => one.id !== "crumb");
    expect(survivorTarget(focusLayout(wide), focusLayout(empty), empty, "tab")).toBe("sessions");
    // With no home declared, the next region in cycle order.
    const plain = [
      stop("left", { region: LIST }),
      stop("history", { region: { ...TAIL, rank: 7 } }),
    ];
    expect(survivorTarget(focusLayout(wide), focusLayout(plain), plain, "tab")).toBe("history");
    expect(homeTarget(focusLayout(narrow), narrow)).toBe("crumb");
  });

  it("N5: an unplaced control is a region of its own, after every placed one", function* () {
    const stops = [stop("refusal"), stop("draft", { region: LIST }), stop("exit")];
    const layout = focusLayout(stops);
    expect(regionTarget(layout, stops, "draft", 1)).toBe("refusal");
    expect(regionTarget(layout, stops, "refusal", 1)).toBe("exit");
    expect(regionTarget(layout, stops, "exit", 1)).toBe("draft");
  });
});

type Act = { readonly kind: "activate" | "caret" | "close"; readonly from: string };

/** A control that activates on Enter and, when asked to, keeps its arrows. */
const CONTROL: ReplComponent<Act> = component<Act>({
  name: "control",
  attach(node: ReplNode<Act>): void {
    node.focusable();
    node.render(`[${node.key}]`);
    node.claim((event: ReplInputEvent): Act | undefined => {
      if (event.kind === "pointer" || (event.kind === "key" && event.key === "Enter")) {
        return { kind: "activate", from: node.key };
      }
      const keeps = fields(node.input)?.["keeps"] === true;
      return keeps && event.kind === "key" && event.key.startsWith("Arrow")
        ? { kind: "caret", from: node.key }
        : undefined;
    });
  },
});

/** A modal branch that closes on Escape. */
const DRAWER: ReplComponent<Act> = component<Act>({
  name: "drawer",
  attach(node: ReplNode<Act>): void {
    node.render(`|${node.key}|`);
    node.claim((event: ReplInputEvent): Act | undefined =>
      event.kind === "key" && event.key === "Escape"
        ? { kind: "close", from: node.key }
        : undefined,
    );
  },
});

function placed(
  key: string,
  navigation: ReplPlacement | undefined,
  options: { readonly keeps?: true; readonly focus?: true } = {},
): ReplDescription<Act> {
  return describeNode<Act>({
    key,
    component: CONTROL,
    input: { keeps: options.keeps === true },
    ...(navigation === undefined ? {} : { navigation }),
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  });
}

function committed(outcome: Result<void>): void {
  if (!outcome.ok) {
    throw outcome.error;
  }
}

function* press(tree: ReplTree<Act>, key: ReplKey): Operation<ReplDispatched<Act>> {
  const outcome = yield* tree.dispatch({ kind: "key", key });
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function focusedKey(tree: ReplTree<Act>): string | undefined {
  const id = tree.focused();
  return id === undefined ? undefined : tree.keyOf(id);
}

const FIELD_REGION: ReplFocusRegion = { key: "field", rank: 1, axis: "horizontal" };
const ACTIONS: ReplFocusRegion = { key: "actions", rank: 2, axis: "horizontal" };

/**
 * One page: a field and its action, then History and Exit.
 *
 * The field asks for focus only on the opening commit, the way the Draft does:
 * a request repeated on every commit would pull focus back after every move.
 */
function page(
  opening: boolean,
  extra: readonly ReplDescription<Act>[] = [],
): readonly ReplDescription<Act>[] {
  return [
    placed(
      "draft",
      { region: FIELD_REGION, entry: 0 },
      opening ? { keeps: true, focus: true } : { keeps: true },
    ),
    placed("send", { region: FIELD_REGION }),
    placed("history", { region: ACTIONS, entry: 0 }),
    placed("exit", { region: ACTIONS }),
    ...extra,
  ];
}

describe("region navigation: the mounted tree", () => {
  it("T1: a focused control's claim wins over navigation, and Tab is never claimed", function* () {
    const tree = yield* useReplTree<Act>();
    committed(yield* tree.apply(page(true)));
    expect(focusedKey(tree)).toBe("draft");

    const kept = yield* press(tree, "ArrowRight");
    expect(kept.outcome === "action" && kept.action).toEqual({ kind: "caret", from: "draft" });
    expect(focusedKey(tree)).toBe("draft");

    const neighbour = yield* press(tree, "Alt+ArrowDown");
    expect(neighbour.outcome).toBe("focus");
    expect(focusedKey(tree)).toBe("send");

    yield* press(tree, "Tab");
    expect(focusedKey(tree)).toBe("history");
    yield* press(tree, "ArrowRight");
    expect(focusedKey(tree)).toBe("exit");
    // Back to the field's region at its entry, not at the Send last visited.
    yield* press(tree, "Backtab");
    expect(focusedKey(tree)).toBe("draft");
  });

  it("T2: a modal is entered at its first region's entry and contains the cycle", function* () {
    const tree = yield* useReplTree<Act>();
    committed(yield* tree.apply(page(true)));
    yield* press(tree, "Tab");
    expect(focusedKey(tree)).toBe("history");

    const content: ReplFocusRegion = { key: "content", rank: 1, axis: "vertical" };
    const actions: ReplFocusRegion = { key: "drawer-actions", rank: 2, axis: "vertical" };
    const open = describeNode<Act>({
      key: "drawer",
      component: DRAWER,
      input: null,
      modal: true,
      children: [
        // Described first, as a drawer's window control is, and still not where
        // the drawer is entered.
        placed("earlier", { region: actions }),
        placed("row-1", { region: content }),
        placed("row-2", { region: content }),
        placed("close", { region: actions, entry: 0 }),
      ],
    });
    committed(yield* tree.apply(page(false, [open])));
    expect(focusedKey(tree)).toBe("row-1");

    const reached: (string | undefined)[] = [];
    for (let step = 0; step < 4; step += 1) {
      yield* press(tree, "Tab");
      reached.push(focusedKey(tree));
    }
    expect(reached).toEqual(["close", "row-1", "close", "row-1"]);

    // Closing hands focus back to the exact opener.
    committed(yield* tree.apply(page(false)));
    expect(focusedKey(tree)).toBe("history");
  });

  it("T3: a removed control hands focus to its sibling, not to the first control", function* () {
    const tree = yield* useReplTree<Act>();
    committed(yield* tree.apply(page(true)));
    yield* press(tree, "Alt+ArrowDown");
    expect(focusedKey(tree)).toBe("send");

    // Send replaced by Stop: Send's survivor is the field beside it, and
    // nothing activates.
    committed(
      yield* tree.apply([
        placed("draft", { region: FIELD_REGION, entry: 0 }, { keeps: true }),
        placed("stop", { region: FIELD_REGION }),
        placed("history", { region: ACTIONS, entry: 0 }),
        placed("exit", { region: ACTIONS }),
      ]),
    );
    expect(focusedKey(tree)).toBe("draft");

    yield* press(tree, "Tab");
    yield* press(tree, "ArrowRight");
    expect(focusedKey(tree)).toBe("exit");
    // The whole region gone: the next region in cycle order, at its entry.
    committed(
      yield* tree.apply([placed("draft", { region: FIELD_REGION, entry: 0 }, { keeps: true })]),
    );
    expect(focusedKey(tree)).toBe("draft");
  });

  it("T4: two declarations of one region, axis or anchor are refused before mounting", function* () {
    const tree = yield* useReplTree<Act>();
    const rank = tree.validate([
      placed("a", { region: LIST }),
      placed("b", { region: { ...LIST, rank: 9 } }),
    ]);
    expect(rank.ok).toBe(false);
    const axis = tree.validate([
      placed("a", { region: LIST, groups: [vertical("g")] }),
      placed("b", { region: LIST, groups: [horizontal("g")] }),
    ]);
    expect(axis.ok).toBe(false);
    const heads = tree.validate([
      placed("a", { region: LIST, groups: [vertical("g")], anchor: true }),
      placed("b", { region: LIST, groups: [vertical("g")], anchor: true }),
    ]);
    expect(heads.ok).toBe(false);
    expect(tree.mounted()).toEqual([]);
  });
});

describe("region navigation: the keys the decoder names", () => {
  it("D1: arrows, Home, End, the Page keys and Alt+Up/Down arrive named", function* () {
    const input = yield* until(createInput({}));
    const named = (bytes: string): readonly string[] =>
      scanInput(input, new TextEncoder().encode(bytes)).events.map((event) =>
        event.kind === "key" ? event.key : event.kind === "text" ? `text:${event.text}` : "pointer",
      );
    expect(named("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([
      "ArrowUp",
      "ArrowDown",
      "ArrowRight",
      "ArrowLeft",
    ]);
    expect(named("\x1b[H\x1b[F\x1b[5~\x1b[6~")).toEqual(["Home", "End", "PageUp", "PageDown"]);
    expect(named("\x1b[1;3A\x1b[1;3B")).toEqual(["Alt+ArrowUp", "Alt+ArrowDown"]);
    // Every other Alt chord is still dropped whole, its letter included.
    expect(named("\x1b[1;3C\x1b[1;3D\x1ba")).toEqual([]);
    // Shift+Tab in both of its spellings stays Backtab.
    expect(named("\x1b[Z\x1b[9;2u")).toEqual(["Backtab", "Backtab"]);
  });
});
