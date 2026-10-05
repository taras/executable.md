/**
 * A semantic REPL screen, described through the composition factories.
 *
 * Enough of a screen to measure, admit, mount and draw: a Sessions list that can
 * be empty, Entries, the selected entry's scopes, a transcript, a
 * bindings/history inspection column, an optional drawer and a footer holding
 * the action row, the History band and the draft. Every row is an ordinary
 * described node, so what is under test is placement and rendering rather than a
 * screen this fixture invented.
 *
 * ## One walk, two things
 *
 * The descriptions and the boxes that place them are built together, from the
 * same classification, exactly as the application builds its own. A box carries
 * the structural id the measuring pass draws it under and the description key
 * whose live node the committed pass draws it under, so a measured region and
 * the region drawn into it cannot be two different regions.
 *
 * This fixture computes **no** cell coordinate and **no** capacity. Every
 * rectangle comes from `layout.ts`'s shared constraints and every window comes
 * from what the engine measured — which is the point: a fixture with its own
 * layout arithmetic would agree with itself and disagree with the product.
 */

import { component, describe as describeNode, fields } from "../../../src/repl/description.ts";
import type {
  ReplComponent,
  ReplDescription,
  ReplInputEvent,
  ReplNode,
  ReplViewData,
} from "../../../src/repl/description.ts";
import {
  actionRowProps,
  bandProps,
  bodyProps,
  box,
  columnProps,
  CONTROL_PROPS,
  drawerLayerProps,
  drawerRect,
  footerProps,
  historyBand,
  inspectionWidth,
  profileFor,
  refusalProps,
  refusalText,
  rootProps,
  ROW_PROPS,
  sharedColumnRows,
  sidebarWidth,
  stackProps,
  viewportProps,
} from "../../../src/repl/layout.ts";
import type {
  ReplBox,
  ReplLayoutManifest,
  ReplRegion,
  ReplSurfaceMarker,
  ReplViewportSlot,
} from "../../../src/repl/layout.ts";
import type { ReplTerminalSize } from "../../../src/repl/terminal.ts";
import type { PairBuilder, Pass } from "./presentation.ts";

/** Everything this screen's controls can ask the root to do. */
export type Surfaced =
  | { readonly kind: "select-session"; readonly key: string }
  | { readonly kind: "select-entry"; readonly key: string }
  | { readonly kind: "select-scope"; readonly key: string }
  | { readonly kind: "select-marker"; readonly key: string }
  | { readonly kind: "close-drawer" }
  | { readonly kind: "scroll"; readonly window: string; readonly delta: number }
  | { readonly kind: "act"; readonly key: string }
  | { readonly kind: "submit" }
  /** Text the person typed or pasted, for the draft to append. */
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "erase" };

/** The windows this screen scrolls, named as the production ones are. */
export const SESSIONS = "sessions";
export const ENTRIES = "entries";
export const DRAWER = "drawer";

/** The one string field every fixture component is given. */
function text(input: ReplViewData): string {
  const value = fields(input)?.["text"];
  if (typeof value !== "string") {
    throw new Error("a fixture node is given a { text } input");
  }
  return value;
}

function optional(input: ReplViewData, name: string): string | undefined {
  const value = fields(input)?.[name];
  return typeof value === "string" ? value : undefined;
}

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

/**
 * A selectable row.
 *
 * Its action comes from its key, which does not change when its text does — so
 * redescribing a row for a narrower screen cannot change what activating it
 * means.
 */
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

/** A control of the action row, or of a window. */
const CONTROL: ReplComponent<Surfaced> = component<Surfaced>({
  name: "control",
  attach(node: ReplNode<Surfaced>): void {
    node.focusable();
    node.render(text(node.input));
    node.onInput((input: ReplViewData) => node.render(text(input)));
    node.claim((event: ReplInputEvent): Surfaced | undefined => {
      if (event.kind === "text") {
        return undefined;
      }
      if (event.kind !== "pointer" && event.key !== "Enter") {
        return undefined;
      }
      const window = optional(node.input, "window");
      const delta = fields(node.input)?.["delta"];
      if (window !== undefined && typeof delta === "number") {
        return { kind: "scroll", window, delta };
      }
      return { kind: "act", key: node.key };
    });
  },
});

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
const DRAWER_COMPONENT: ReplComponent<Surfaced> = component<Surfaced>({
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
const CLOSE_ROW = row("close-drawer");

/**
 * Which surface a narrow screen is showing.
 *
 * A route, not a preference: the application decides it, and placement is told
 * rather than asked.
 */
export type ReplFixtureRoute = "sessions" | "entries";

/** One offered action of the footer's row, in priority order. */
export interface ReplFixtureAction {
  readonly key: string;
  readonly label: string;
}

/** The footer's two standing controls, which every screen offers. */
export const STANDING_ACTIONS: readonly ReplFixtureAction[] = Object.freeze([
  Object.freeze({ key: "footer:history", label: "[history]" }),
  Object.freeze({ key: "footer:exit", label: "[exit]" }),
]);

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
  /** The drawer's own ordered content, which its window shows part of. */
  readonly drawerLines: readonly string[];
  /** The action row's controls, in priority order. */
  readonly actions: readonly ReplFixtureAction[];
  /**
   * Whether each list offers its two window controls.
   *
   * Off by default, so a test about placement gets the plainest screen that
   * places anything. The admission tests turn it on, because what a window
   * control costs its own region a row for is the thing they are measuring.
   */
  readonly windowed: boolean;
  readonly draft: string;
  /** How far each window is scrolled, by window name. */
  readonly offsets: Readonly<Record<string, number>>;
  /** Whether the drawer layer takes the engine's pointer off what it covers. */
  readonly capture: "capture" | "passthrough";
}

/** A state with nothing in it yet, which is a screen the REPL really shows. */
export const EMPTY: ReplFixtureState = Object.freeze({
  route: "sessions",
  sessions: Object.freeze([]),
  entries: Object.freeze([]),
  scopes: Object.freeze([]),
  transcript: Object.freeze([]),
  bindings: Object.freeze([]),
  history: Object.freeze([]),
  drawer: undefined,
  drawerLines: Object.freeze([]),
  actions: STANDING_ACTIONS,
  windowed: false,
  draft: "",
  offsets: Object.freeze({}),
  capture: "capture",
});

function leaf(
  kind: ReplComponent<Surfaced>,
  key: string,
  body: string,
  options: {
    readonly modal?: true;
    readonly focus?: true;
    readonly extra?: Readonly<Record<string, number | string>>;
    readonly children?: readonly ReplDescription<Surfaced>[];
  } = {},
): ReplDescription<Surfaced> {
  return describeNode<Surfaced>({
    key,
    component: kind,
    input: { text: body, ...(options.extra ?? {}) },
    ...(options.children === undefined ? {} : { children: options.children }),
    ...(options.modal === undefined ? {} : { modal: options.modal }),
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  });
}

/** One described row paired with the box that places it. */
interface Paired {
  readonly description: ReplDescription<Surfaced>;
  readonly box: ReplBox;
}

function paired(
  kind: ReplComponent<Surfaced>,
  key: string,
  body: string,
  region: ReplRegion,
  options: {
    readonly control?: boolean;
    readonly focus?: true;
    readonly extra?: Readonly<Record<string, number | string>>;
    readonly props?: typeof ROW_PROPS;
  } = {},
): Paired {
  return {
    description: leaf(kind, key, body, {
      ...(options.focus === undefined ? {} : { focus: options.focus }),
      ...(options.extra === undefined ? {} : { extra: options.extra }),
    }),
    box: box({
      id: `box:${region}:${key}`,
      key,
      region,
      props: options.props ?? ROW_PROPS,
      text: body,
      control: options.control === true,
    }),
  };
}

function descriptionsOf(parts: readonly Paired[]): readonly ReplDescription<Surfaced>[] {
  return parts.map((part) => part.description);
}

function boxesOf(parts: readonly Paired[]): readonly ReplBox[] {
  return parts.map((part) => part.box);
}

/** The rows one measured window shows, or none while the frame is measured. */
function shown<T>(rows: readonly T[], pass: Pass, window: string): readonly T[] {
  if (pass.measuring) {
    return [];
  }
  const held = pass.admission.windows.get(window);
  return held === undefined ? [] : rows.slice(held.from, held.from + held.count);
}

/**
 * The paired screen one fixture state describes at one size.
 *
 * Hands back a builder rather than a pair, because measuring and committing are
 * the same walk given different answers: the committer calls it twice and the
 * second call is the one that mounts.
 */
export function fixturePairs(
  state: ReplFixtureState,
  size: ReplTerminalSize,
): PairBuilder<Surfaced> {
  const sessionRows = state.sessions;
  const entryRows = [
    ...state.entries.map((entry) => ({ key: `entry:${entry}`, label: entry, kind: ENTRY_ROW })),
    ...state.scopes.map((scope) => ({ key: `scope:${scope}`, label: scope, kind: SCOPE_ROW })),
  ];

  return {
    total(window) {
      if (window === SESSIONS) {
        return sessionRows.length;
      }
      if (window === ENTRIES) {
        return entryRows.length;
      }
      return state.drawerLines.length;
    },
    offset(window) {
      return state.offsets[window] ?? 0;
    },
    build(pass) {
      const profile = profileFor(size);
      const band = historyBand(state.history, size.columns);
      if (profile === "too-small") {
        return {
          descriptions: [leaf(LINE, "refusal", refusalText(size))],
          manifest: Object.freeze({
            profile,
            size: Object.freeze({ ...size }),
            root: box({
              id: "box:root",
              props: rootProps(size),
              children: [
                box({
                  id: "box:refusal",
                  region: "refusal",
                  props: refusalProps(),
                  text: refusalText(size),
                }),
              ],
            }),
            viewports: Object.freeze([]),
            actions: undefined,
            regions: Object.freeze([Object.freeze({ region: "refusal", id: "box:refusal" })]),
            // This fixture screen draws no pane edges, so it reports no interior
            // beside the panes themselves.
            contents: Object.freeze([]),
            history: band,
          }),
        };
      }

      const viewports: ReplViewportSlot[] = [];
      const regions: { region: ReplRegion; id: string }[] = [];
      const descriptions: ReplDescription<Surfaced>[] = [];

      /** One list region: its heading, its window controls and the window. */
      const list = (
        region: ReplRegion,
        window: string,
        heading: Paired,
        rows: readonly Paired[],
        windowed: boolean,
      ): readonly ReplBox[] => {
        const id = `box:${window}:viewport`;
        viewports.push(Object.freeze({ id, region, window }));
        const less = paired(CONTROL, `${window}:earlier`, "[^ earlier]", region, {
          control: true,
          extra: { window, delta: -1 },
        });
        const more = paired(CONTROL, `${window}:later`, "[v later]", region, {
          control: true,
          extra: { window, delta: 1 },
        });
        descriptions.push(heading.description);
        if (windowed) {
          descriptions.push(less.description);
        }
        descriptions.push(...descriptionsOf(rows));
        if (windowed) {
          descriptions.push(more.description);
        }
        return [
          heading.box,
          ...(windowed ? [less.box] : []),
          box({ id, region, props: viewportProps(), children: boxesOf(rows) }),
          ...(windowed ? [more.box] : []),
        ];
      };

      const sessionHeading = (region: ReplRegion): Paired =>
        state.sessions.length === 0
          ? // An empty list is a thing the screen says, not a thing it omits.
            paired(SECTION, "sessions:empty", "Sessions: none yet", region)
          : paired(SECTION, "sessions:heading", "Sessions", region);

      const sessionWindow = (region: ReplRegion): readonly Paired[] =>
        shown(sessionRows, pass, SESSIONS).map((session) =>
          paired(SESSION_ROW, `session:${session}`, session, region, { control: true }),
        );

      const entryWindow = (region: ReplRegion): readonly Paired[] =>
        shown(entryRows, pass, ENTRIES).map((entry) =>
          paired(entry.kind, entry.key, entry.label, region, { control: true }),
        );

      const columns: ReplBox[] = [];
      if (profile === "narrow") {
        const routed =
          state.route === "sessions"
            ? list(
                "content",
                SESSIONS,
                sessionHeading("content"),
                sessionWindow("content"),
                state.windowed,
              )
            : list(
                "content",
                ENTRIES,
                paired(SECTION, "entries:heading", "Entries", "content"),
                entryWindow("content"),
                state.windowed,
              );
        regions.push({ region: "content", id: "box:content" });
        columns.push(
          box({
            id: "box:content",
            region: "content",
            props: columnProps(undefined),
            children: routed,
          }),
        );
      } else {
        const transcript = state.transcript.map((line, at) =>
          paired(LINE, `line:${at}`, line, "transcript"),
        );
        const inspection = state.bindings.map((one) =>
          paired(LINE, `binding:${one.name}`, `${one.name} = ${one.value}`, "inspection"),
        );
        regions.push(
          { region: "sidebar", id: "box:sidebar" },
          { region: "transcript", id: "box:transcript" },
          { region: "inspection", id: "box:inspection" },
        );
        const sessionsGroup = list(
          "sidebar",
          SESSIONS,
          sessionHeading("sidebar"),
          sessionWindow("sidebar"),
          state.windowed,
        );
        const entriesGroup = list(
          "sidebar",
          ENTRIES,
          paired(SECTION, "entries:heading", "Entries", "sidebar"),
          entryWindow("sidebar"),
          state.windowed,
        );
        descriptions.push(...descriptionsOf(transcript), ...descriptionsOf(inspection));
        columns.push(
          box({
            id: "box:sidebar",
            region: "sidebar",
            props: columnProps(sidebarWidth(size)),
            children: [
              // Only one of the two grows. Two growing siblings split the
              // remainder in the engine's own arithmetic, which is not whole.
              box({
                id: "box:sidebar:sessions",
                region: "sidebar",
                props: stackProps("grow"),
                children: sessionsGroup,
              }),
              box({
                id: "box:sidebar:entries",
                region: "sidebar",
                props: stackProps(sharedColumnRows(size)),
                children: entriesGroup,
              }),
            ],
          }),
          box({
            id: "box:transcript",
            region: "transcript",
            props: columnProps(undefined),
            children: [
              box({
                id: "box:transcript:viewport",
                region: "transcript",
                props: viewportProps(),
                children: boxesOf(transcript),
              }),
            ],
          }),
          box({
            id: "box:inspection",
            region: "inspection",
            props: columnProps(inspectionWidth(size)),
            children: [
              box({
                id: "box:inspection:viewport",
                region: "inspection",
                props: viewportProps(),
                children: boxesOf(inspection),
              }),
            ],
          }),
        );
      }

      const rect = drawerRect(size);
      if (state.drawer !== undefined && rect !== undefined) {
        const id = `box:${DRAWER}:viewport`;
        viewports.push(Object.freeze({ id, region: "drawer", window: DRAWER }));
        regions.push({ region: "drawer", id: "box:drawer:layer" });
        const less = paired(CONTROL, "drawer:earlier", "[^ earlier]", "drawer", {
          control: true,
          extra: { window: DRAWER, delta: -1 },
        });
        const more = paired(CONTROL, "drawer:later", "[v later]", "drawer", {
          control: true,
          extra: { window: DRAWER, delta: 1 },
        });
        const lines = shown(state.drawerLines, pass, DRAWER).map((line, at) =>
          paired(LINE, `drawer:line:${at}`, line, "drawer"),
        );
        const close = paired(CLOSE_ROW, "drawer:close", "[close]", "drawer", { control: true });
        // Focus follows the innermost modal. An open drawer holds it, because the
        // composition kernel refuses a focus claim its open modal does not
        // contain — which is why the drawer's controls are its children.
        descriptions.push(
          describeNode<Surfaced>({
            key: "drawer:open",
            component: DRAWER_COMPONENT,
            input: { text: state.drawer },
            modal: true,
            children: [
              less.description,
              ...descriptionsOf(lines),
              more.description,
              leaf(CLOSE_ROW, "drawer:close", "[close]", { focus: true }),
            ],
          }),
        );
        columns.push(
          box({
            id: "box:drawer:layer",
            region: "drawer",
            props: drawerLayerProps(rect, state.capture),
            children: [
              box({
                id: "box:drawer:drawer:open",
                key: "drawer:open",
                region: "drawer",
                props: ROW_PROPS,
                text: state.drawer,
                control: false,
              }),
              less.box,
              box({
                id,
                region: "drawer",
                props: viewportProps(),
                children: boxesOf(lines),
              }),
              more.box,
              close.box,
            ],
          }),
        );
      }

      const offered = state.actions.map((action) =>
        paired(CONTROL, action.key, action.label, "footer", {
          control: true,
          props: CONTROL_PROPS,
        }),
      );
      // Every candidate while measuring, so each one's own width is an answer
      // the engine has given; only the admitted prefix once there is one. A
      // control described but left out of the frame would be a focus stop that
      // draws nothing, which is the thing admission exists to prevent.
      const placed = offered.filter(
        (one) => pass.measuring || pass.admission.actions.has(one.box.key ?? ""),
      );
      descriptions.push(...descriptionsOf(placed));
      const draft = paired(DRAFT, "footer:input", `> ${state.draft}`, "footer", { control: true });
      descriptions.push(
        state.drawer === undefined
          ? leaf(DRAFT, "footer:input", `> ${state.draft}`, { focus: true })
          : draft.description,
      );
      regions.push({ region: "footer", id: "box:footer" });

      return {
        descriptions,
        manifest: Object.freeze({
          profile,
          size: Object.freeze({ ...size }),
          root: box({
            id: "box:root",
            props: rootProps(size),
            children: [
              box({ id: "box:body", props: bodyProps(false), children: columns }),
              box({
                id: "box:footer",
                region: "footer",
                props: footerProps(),
                children: [
                  box({
                    id: "box:footer:actions",
                    region: "footer",
                    props: actionRowProps(),
                    children: boxesOf(placed),
                  }),
                  box({
                    id: "box:footer:band",
                    region: "footer",
                    props: bandProps(),
                    children: band.rows.map((line, at) =>
                      box({
                        id: `box:band:${at}`,
                        region: "footer",
                        props: ROW_PROPS,
                        text: line,
                      }),
                    ),
                  }),
                  draft.box,
                ],
              }),
            ],
          }),
          viewports: Object.freeze(viewports),
          actions: Object.freeze({
            id: "box:footer:actions",
            controls: Object.freeze(
              offered.map((one) => ({
                key: one.box.key ?? "",
                id: one.box.id,
                control: one.box.control,
              })),
            ),
          }),
          regions: Object.freeze(regions.map((region) => Object.freeze(region))),
          contents: Object.freeze([]),
          history: band,
        }),
      };
    },
  };
}
