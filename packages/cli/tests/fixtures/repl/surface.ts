/**
 * A semantic REPL screen, described through the composition factories.
 *
 * Enough of a screen to lay out and render: a Sessions list that can be empty,
 * Entries, the selected entry's scopes, a transcript, a bindings/history
 * inspection column, an optional drawer and a footer holding History and an
 * input. Every one of them is an ordinary described node, so what is under test
 * is placement and rendering rather than a screen this fixture invented.
 *
 * The region a node belongs to is decided **here**, from its key, and the text
 * it shows comes from the committed frame. Presentation therefore reads the
 * tree; it never tells the tree anything, which is what keeps a resize from
 * touching identity.
 */

import { component, describe as describeNode, fields } from "../../../src/repl/description.ts";
import type {
  ReplComponent,
  ReplDescription,
  ReplInputEvent,
  ReplNode,
  ReplViewData,
} from "../../../src/repl/description.ts";
import type {
  ReplRegion,
  ReplSurface,
  ReplSurfaceCell,
  ReplSurfaceMarker,
} from "../../../src/repl/layout.ts";
import type { ReplTree } from "../../../src/repl/reconcile.ts";

/** Everything this screen's controls can ask the root to do. */
export type Surfaced =
  | { readonly kind: "select-session"; readonly key: string }
  | { readonly kind: "select-entry"; readonly key: string }
  | { readonly kind: "select-scope"; readonly key: string }
  | { readonly kind: "select-marker"; readonly key: string }
  | { readonly kind: "close-drawer" }
  | { readonly kind: "submit" }
  /** Text the person typed or pasted, for the draft to append. */
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "erase" };

/** The one string field every fixture component is given. */
function text(input: ReplViewData): string {
  const value = fields(input)?.["text"];
  if (typeof value !== "string") {
    throw new Error("a fixture node is given a { text } input");
  }
  return value;
}

/**
 * A selectable row.
 *
 * Its action comes from its key, which does not change when its text does — so
 * redescribing a row for a narrower screen cannot change what activating it
 * means.
 */
/** The actions a selectable row can produce. */
type Selecting = "select-session" | "select-entry" | "select-scope" | "select-marker";

/** One selection action, spelled out per kind so nothing has to be asserted. */
function selected(kind: Selecting, key: string): Surfaced {
  switch (kind) {
    case "select-session":
      return { kind: "select-session", key };
    case "select-entry":
      return { kind: "select-entry", key };
    case "select-scope":
      return { kind: "select-scope", key };
    case "select-marker":
      return { kind: "select-marker", key };
  }
}

function row(kind: Selecting | "close-drawer"): ReplComponent<Surfaced> {
  return component<Surfaced>({
    name: `row:${kind}`,
    attach(node: ReplNode<Surfaced>): void {
      node.focusable();
      node.render(text(node.input));
      node.onInput((input: ReplViewData) => node.render(text(input)));
      node.claim((event: ReplInputEvent): Surfaced | undefined => {
        // A row is not an editor: text passes it by on the way to whatever is.
        if (event.kind === "text") {
          return undefined;
        }
        if (event.kind !== "pointer" && event.key !== "Enter") {
          return undefined;
        }
        if (kind === "close-drawer") {
          return { kind: "close-drawer" };
        }
        return selected(kind, node.key);
      });
    },
  });
}

/** A line of text nobody can select. */
const LINE: ReplComponent<Surfaced> = component<Surfaced>({
  name: "line",
  attach(node: ReplNode<Surfaced>): void {
    node.render(text(node.input));
    node.onInput((input: ReplViewData) => node.render(text(input)));
  },
});

/** A titled container. */
const SECTION: ReplComponent<Surfaced> = component<Surfaced>({
  name: "section",
  attach(node: ReplNode<Surfaced>): void {
    node.render(text(node.input));
    node.onInput((input: ReplViewData) => node.render(text(input)));
  },
});

/** A drawer: a modal branch that closes on Escape. */
const DRAWER: ReplComponent<Surfaced> = component<Surfaced>({
  name: "drawer",
  attach(node: ReplNode<Surfaced>): void {
    node.render(text(node.input));
    node.onInput((input: ReplViewData) => node.render(text(input)));
    node.claim((event: ReplInputEvent): Surfaced | undefined =>
      event.kind === "key" && event.key === "Escape" ? { kind: "close-drawer" } : undefined,
    );
  },
});

/**
 * The draft line, which is where typing goes.
 *
 * It claims text and Backspace as well as Enter, and answers each with its own
 * semantic action. The host said what arrived; what it means to a draft — append,
 * erase, submit — is this component's to decide, which is why the same Enter that
 * activates a row submits here.
 */
const DRAFT: ReplComponent<Surfaced> = component<Surfaced>({
  name: "draft",
  attach(node: ReplNode<Surfaced>): void {
    node.focusable();
    node.render(text(node.input));
    node.onInput((input: ReplViewData) => node.render(text(input)));
    node.claim((event: ReplInputEvent): Surfaced | undefined => {
      if (event.kind === "text") {
        return { kind: "insert", text: event.text };
      }
      if (event.kind === "pointer") {
        return { kind: "submit" };
      }
      if (event.key === "Enter") {
        return { kind: "submit" };
      }
      if (event.key === "Backspace") {
        return { kind: "erase" };
      }
      return undefined;
    });
  },
});

const SESSION_ROW = row("select-session");
const ENTRY_ROW = row("select-entry");
const SCOPE_ROW = row("select-scope");
const MARKER_ROW = row("select-marker");
const CLOSE_ROW = row("close-drawer");

/**
 * Which surface a narrow screen is showing.
 *
 * A route, not a preference: the application decides it, and placement is told
 * rather than asked.
 */
export type ReplFixtureRoute = "sessions" | "entries" | "transcript" | "inspection";

/** What the screen is showing. */
export interface ReplFixtureState {
  /** The surface a narrow frame routes to. */
  readonly route: ReplFixtureRoute;
  readonly sessions: readonly string[];
  readonly entries: readonly string[];
  readonly scopes: readonly string[];
  readonly transcript: readonly string[];
  readonly bindings: readonly { readonly name: string; readonly value: string }[];
  readonly history: readonly ReplSurfaceMarker[];
  /** The open drawer's title, or none. */
  readonly drawer: string | undefined;
  readonly draft: string;
}

/** A state with nothing in it yet, which is a screen the REPL really shows. */
export const EMPTY: ReplFixtureState = {
  route: "sessions",
  sessions: [],
  entries: [],
  scopes: [],
  transcript: [],
  bindings: [],
  history: [],
  drawer: undefined,
  draft: "",
};

function leaf(
  kind: ReplComponent<Surfaced>,
  key: string,
  body: string,
  options: {
    readonly modal?: true;
    readonly focus?: true;
    readonly children?: readonly ReplDescription<Surfaced>[];
  } = {},
): ReplDescription<Surfaced> {
  return describeNode<Surfaced>({
    key,
    component: kind,
    input: { text: body },
    ...(options.children === undefined ? {} : { children: options.children }),
    ...(options.modal === undefined ? {} : { modal: options.modal }),
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  });
}

/** Describe the whole screen. One flat set: placement is not nesting. */
export function fixtureDescriptions(state: ReplFixtureState): readonly ReplDescription<Surfaced>[] {
  const described: ReplDescription<Surfaced>[] = [];

  described.push(
    state.sessions.length === 0
      ? // An empty list is a thing the screen says, not a thing it omits.
        leaf(SECTION, "sessions:empty", "Sessions: none yet")
      : leaf(SECTION, "sessions:heading", "Sessions"),
  );
  for (const session of state.sessions) {
    described.push(leaf(SESSION_ROW, `session:${session}`, session));
  }
  described.push(leaf(SECTION, "entries:heading", "Entries"));
  for (const entry of state.entries) {
    described.push(leaf(ENTRY_ROW, `entry:${entry}`, entry));
  }
  for (const scope of state.scopes) {
    described.push(leaf(SCOPE_ROW, `scope:${scope}`, scope));
  }
  for (const [index, line] of state.transcript.entries()) {
    described.push(leaf(LINE, `line:${index}`, line));
  }
  for (const binding of state.bindings) {
    described.push(leaf(LINE, `binding:${binding.name}`, `${binding.name} = ${binding.value}`));
  }
  for (const marker of state.history) {
    described.push(leaf(MARKER_ROW, `marker:${marker.marker}`, marker.label));
  }
  // Focus follows the innermost modal. An open drawer holds it, because the
  // composition kernel refuses a focus claim its open modal does not contain —
  // which is the same reason the drawer's own control is its child rather than
  // its sibling.
  described.push(
    state.drawer === undefined
      ? leaf(DRAFT, "footer:input", `> ${state.draft}`, { focus: true })
      : leaf(DRAFT, "footer:input", `> ${state.draft}`),
  );
  if (state.drawer !== undefined) {
    described.push(
      leaf(DRAWER, "drawer:open", state.drawer, {
        modal: true,
        children: [leaf(CLOSE_ROW, "drawer:close", "Close", { focus: true })],
      }),
    );
  }
  return described;
}

/** Which region a key belongs to, and whether a pointer may activate it. */
function regionOf(
  key: string,
): { readonly region: ReplRegion; readonly targetable: boolean } | undefined {
  if (key.startsWith("sessions:") || key.startsWith("entries:")) {
    return { region: "sidebar", targetable: false };
  }
  if (key.startsWith("session:") || key.startsWith("entry:") || key.startsWith("scope:")) {
    return { region: "sidebar", targetable: true };
  }
  if (key.startsWith("line:")) {
    return { region: "transcript", targetable: false };
  }
  if (key.startsWith("binding:")) {
    return { region: "inspection", targetable: false };
  }
  if (key.startsWith("marker:")) {
    return { region: "footer", targetable: true };
  }
  if (key.startsWith("footer:")) {
    return { region: "footer", targetable: true };
  }
  if (key.startsWith("drawer:")) {
    return { region: "drawer", targetable: true };
  }
  return undefined;
}

/**
 * The surface a committed tree presents.
 *
 * Read from the frame, so a node the tree has removed contributes nothing and a
 * cell nobody rendered is not in it. The live node id travels with every cell,
 * because that id is what a pointer resolved against the drawn frame has to name.
 */
export function fixtureSurface(tree: ReplTree<Surfaced>, state: ReplFixtureState): ReplSurface {
  const collected = new Map<ReplRegion, ReplSurfaceCell[]>([
    ["sidebar", []],
    ["transcript", []],
    ["inspection", []],
    ["drawer", []],
    ["footer", []],
  ]);

  for (const cell of tree.frame().cells) {
    const key = tree.keyOf(cell.node);
    if (key === undefined) {
      continue;
    }
    const placed = regionOf(key);
    if (placed === undefined) {
      continue;
    }
    collected.get(placed.region)?.push({
      node: cell.node,
      text: cell.cell,
      ...(placed.targetable ? { targetable: true } : {}),
    });
  }

  const sidebar = collected.get("sidebar") ?? [];
  const sessions = sidebar.filter((cell) => {
    const key = tree.keyOf(cell.node);
    return key !== undefined && (key.startsWith("sessions:") || key.startsWith("session:"));
  });
  const entries = sidebar.filter((cell) => !sessions.includes(cell));
  const transcript = collected.get("transcript") ?? [];
  const inspection = collected.get("inspection") ?? [];

  const routed: { readonly [route in ReplFixtureRoute]: readonly ReplSurfaceCell[] } = {
    sessions,
    entries,
    transcript,
    inspection,
  };

  return {
    // The route picks one. Everything else stays mounted and stays off the
    // narrow frame, which is what makes it unreachable there rather than hidden.
    content: routed[state.route],
    sessions,
    entries,
    transcript,
    inspection,
    drawer: collected.get("drawer") ?? [],
    footer: collected.get("footer") ?? [],
    history: state.history,
  };
}
