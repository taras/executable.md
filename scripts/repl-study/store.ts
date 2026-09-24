/**
 * One place that holds where the person is.
 *
 * #838 kept location in four loose fields on a `View`, mutated by a reducer that
 * read keys directly, and that is the defect #839 exists to remove: nothing
 * could be reopened, because nothing had been said. Here the REPL has exactly
 * three kinds of state, and telling them apart is what makes every acceptance
 * criterion reachable.
 *
 * **Execution truth** belongs to the journal — `journal.ts` for this experiment,
 * #842 for the real one. **Location** is the URL in `route.ts`, and nothing else
 * is location. **Everything else is disposable**: the scroll anchor, the
 * scrubber's selection, whether the overlay is on, which target is focused right
 * now. Throwing the disposable half away and rebuilding from the durable half is
 * `hydrate()`, and `projection()` is what two states are then compared by.
 */

import { fixture, drawerOf, isDrawerKind } from "./fixtures.ts";
import type { DrawerKind } from "./fixtures.ts";
import { fold, JOURNAL, journalThrough, siblingsOf } from "./journal.ts";
import type { JournalFixture, JournalRecord, Moment } from "./journal.ts";
import { layoutFor, SURFACES } from "./layout.ts";
import type { Layout, SurfaceName } from "./layout.ts";
import type { FixtureName, Fixture, TransportMode } from "./model.ts";
import type { Mutation } from "./mutations.ts";
import type { ReplAction } from "./actions.ts";
import { formatRoute, navigationFor, parseRoute, topDrawer } from "./route.ts";
import type { Route, RouteChange, RouteSurface } from "./route.ts";

/**
 * What the renderer reads.
 *
 * Every field is derived from the state below it. It exists because the
 * renderer clips rather than scrolls, so the window over a long transcript and
 * the selected marker have to be told to it in its own terms — not because the
 * harness keeps a second copy of where the person is.
 */
export interface View {
  readonly fixture: FixtureName;
  /** Index of the first visible transcript line. */
  readonly anchor: number;
  /** Index into the fixture's checkpoints, or -1 for "following the head". */
  readonly checkpoint: number;
  readonly surface: SurfaceName;
  readonly drawerOpen: boolean;
}

export function initialView(subject: Fixture): View {
  const selected = subject.history.selectedAt;
  const checkpoint =
    selected === undefined
      ? -1
      : subject.history.checkpoints.findIndex((point) => point.at === selected);
  return {
    fixture: subject.name,
    anchor: 0,
    checkpoint,
    surface: "transcript",
    drawerOpen: subject.drawer !== undefined,
  };
}

export function scrollBy(view: View, delta: number, limit: number): View {
  const anchor = Math.max(0, Math.min(limit, view.anchor + delta));
  return anchor === view.anchor ? view : { ...view, anchor };
}

export function moveSurface(view: View, delta: number): View {
  const at = SURFACES.indexOf(view.surface);
  const next = SURFACES[(at + delta + SURFACES.length) % SURFACES.length];
  return { ...view, surface: next };
}

/**
 * The four layout surfaces are not the five route surfaces.
 *
 * Narrow routing promotes one region to the whole screen, and the REPL input is
 * never one of those because `layout.ts` already renders it inside the
 * transcript. It is still somewhere focus can be, so it is a route surface;
 * mapping it here is the whole of the reconciliation.
 */
export function surfaceOf(route: Route): SurfaceName {
  return route.surface === "input" ? "transcript" : route.surface;
}

export interface ReplState {
  /** Parsed from the URL: the durable half, and the only thing reopening needs. */
  readonly route: Route;
  /** Execution truth, as it stands. A fixture here; #842 owns the real one. */
  readonly journal: JournalFixture;
  /** The fold of that journal at this route, minted with them and never alone. */
  readonly moment: Moment;
  /** Disposable: the transcript window. */
  readonly anchor: number;
  /**
   * Which recorded marker the scrubber is on, or -1 for none.
   *
   * Derived from `route.at`, never set on its own. A selection that lived only
   * in memory would render a state the URL could not reopen.
   */
  readonly selection: number;
  /** Disposable: whether the F1 focus map is drawn. */
  readonly overlay: boolean;
  /** Which identity opened each drawer, so closing one can restore it. */
  readonly invokers: Readonly<Record<string, string>>;
  /** The navigation stack, for Back. Entries are URLs. */
  readonly history: readonly string[];
  /** How many times a running entry has been interrupted, which never exits. */
  readonly interrupts: number;
  readonly quit: boolean;
}

function mint(
  route: Route,
  journal: JournalFixture,
  rest: Omit<ReplState, "route" | "journal" | "moment" | "selection">,
): ReplState {
  return {
    route,
    journal,
    // Selecting a marker and reconstructing it are different things: the fold
    // follows the head until `inspect` says the reconstruction is open.
    moment: fold(journal, route.inspect ? route.at : undefined),
    selection:
      route.at === undefined ? -1 : journal.findIndex((record) => record.marker === route.at),
    ...rest,
  };
}

/** Rebuild everything durable from a URL and a journal, with nothing else. */
export function hydrate(url: string, journal: JournalFixture, mutation?: Mutation): ReplState {
  const parsed = parseRoute(url);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return hydrateRoute(parsed.value, journal, mutation);
}

export function hydrateRoute(
  route: Route,
  journal: JournalFixture,
  mutation?: Mutation,
): ReplState {
  const rebuilt = mint(route, journal, {
    anchor: 0,
    overlay: false,
    invokers: {},
    history: [],
    interrupts: 0,
    quit: false,
  });
  // The control throws the selection away on the way back in, which is what a
  // selection kept outside the URL would have done on every cold start.
  return mutation === "drop-selection-on-hydrate" ? { ...rebuilt, selection: -1 } : rebuilt;
}

/** The semantic projection two states are compared by. Nothing disposable is in it. */
export interface Projection {
  readonly url: string;
  readonly surface: RouteSurface;
  readonly scopes: readonly string[];
  readonly drawers: readonly string[];
  readonly at?: string;
  readonly inspect: boolean;
  readonly draft: string;
  readonly head?: string;
  readonly transport: TransportMode;
  readonly scope: string;
  readonly published: readonly string[];
  readonly suspension?: DrawerKind;
  readonly entry: Moment["entry"];
  /** The marker the scrubber has selected, and what was true there. */
  readonly selected?: string;
  readonly selectedScope?: string;
  readonly selectedPublished?: readonly string[];
}

export function projection(state: ReplState): Projection {
  // The selected marker is folded for itself, so the projection carries the
  // scope and the bindings a cold start has to come back with — not just the
  // marker's name.
  const selected =
    state.selection < 0 ? undefined : fold(state.journal, state.journal[state.selection].marker);
  return {
    url: formatRoute(state.route),
    surface: state.route.surface,
    scopes: state.route.scopes,
    drawers: state.route.drawers,
    at: state.route.at,
    inspect: state.route.inspect,
    draft: state.route.draft,
    head: state.journal[state.journal.length - 1]?.marker,
    transport: state.moment.transport,
    scope: state.moment.scope,
    published: state.moment.published,
    suspension: state.moment.suspension,
    entry: state.moment.entry,
    selected: selected?.marker,
    selectedScope: selected?.scope,
    selectedPublished: selected?.published,
  };
}

export interface Size {
  readonly cols: number;
  readonly rows: number;
}

export function layoutOf(state: ReplState, size: Size, mutation?: Mutation): Layout {
  return layoutFor({
    cols: size.cols,
    rows: size.rows,
    drawer: topDrawer(state.route) !== undefined,
    surface: surfaceOf(state.route),
    mutation,
  });
}

/**
 * The fixture this state is showing, with the journal's own answers on it.
 *
 * The moment decides the transport, whether what is on screen is a
 * reconstruction, and which drawer is open — so `--route` and `--frame` really
 * do drive the picture, rather than picking a fixture and hoping.
 */
export function fixtureFor(state: ReplState): Fixture {
  const base = fixture(state.moment.shows);
  const top = topDrawer(state.route);
  const drawer = top !== undefined && isDrawerKind(top) ? drawerOf(top) : undefined;
  const inspecting = state.route.inspect;
  const selected = state.journal[state.selection]?.at;
  return {
    ...base,
    badge: inspecting ? base.badge : undefined,
    readOnly: inspecting,
    drawer,
    history: {
      ...base.history,
      transport: state.moment.transport,
      // Selecting a marker marks the band; reconstructing it also reads
      // read-only and carries the badge. Both show the same marker.
      selectedAt: selected,
    },
  };
}

export function viewOf(state: ReplState): View {
  const subject = fixtureFor(state);
  const selectedAt = subject.history.selectedAt;
  return {
    fixture: subject.name,
    anchor: state.anchor,
    checkpoint:
      selectedAt === undefined
        ? -1
        : subject.history.checkpoints.findIndex((point) => point.at === selectedAt),
    surface: surfaceOf(state.route),
    drawerOpen: subject.drawer !== undefined,
  };
}

/**
 * Go somewhere, and decide whether that is a place you can come Back from.
 *
 * A push records the URL being left. A replace does not, which is what keeps
 * Back from an inspected marker returning to the head instead of walking back
 * through every marker the scrubber passed.
 */
function go(state: ReplState, route: Route, change: RouteChange, mutation?: Mutation): ReplState {
  const navigation =
    mutation === "push-draft-edits" && change === "draft" ? "push" : navigationFor(change);
  return mint(route, state.journal, {
    anchor: state.anchor,
    overlay: state.overlay,
    invokers: state.invokers,
    history: navigation === "push" ? [...state.history, formatRoute(state.route)] : state.history,
    interrupts: state.interrupts,
    quit: state.quit,
  });
}

function withJournal(state: ReplState, journal: JournalFixture): ReplState {
  return mint(state.route, journal, {
    anchor: state.anchor,
    overlay: state.overlay,
    invokers: state.invokers,
    history: state.history,
    interrupts: state.interrupts,
    quit: state.quit,
  });
}

/** The journal as it stands once the execution records its next `kind`. */
function extendTo(state: ReplState, kind: JournalRecord["kind"]): ReplState {
  const from = state.journal.length;
  const next = JOURNAL.slice(from).find((record) => record.kind === kind);
  if (next === undefined) {
    return state;
  }
  return withJournal(state, journalThrough(next.marker));
}

/**
 * Take the route to wherever focus now is.
 *
 * Focus itself is the tree's and never appears here. What the route records is
 * the *surface* focus landed in, and the caller reads that off the tree — this
 * does not work it out from an identity string. A focus move that crosses a
 * region boundary is a move the URL has to make too, in the same transition.
 */
export function followFocus(
  state: ReplState,
  surface: RouteSurface | undefined,
  change: RouteChange = "focus",
  mutation?: Mutation,
): ReplState {
  if (
    surface === undefined ||
    surface === state.route.surface ||
    mutation === "keep-route-on-focus"
  ) {
    return state;
  }
  return go(state, { ...state.route, surface }, change, mutation);
}

export type HarnessEvent =
  /** Whatever the decoder produced. It is parsed here, never assumed. */
  | { readonly kind: "key"; readonly event: unknown }
  /**
   * A pointer landing on a cell.
   *
   * Synthetic: mouse reporting is never enabled. It exists so that activating a
   * control with a pointer and activating it with the keyboard can be shown to
   * be the same act by the time either reaches an action.
   */
  | { readonly kind: "pointer"; readonly pointer: Pointer }
  | { readonly kind: "resize"; readonly cols: number; readonly rows: number }
  | { readonly kind: "tick"; readonly advanceMs: number }
  | { readonly kind: "background"; readonly record: JournalRecord }
  | { readonly kind: "quit" };

export interface ReduceContext {
  readonly size: Size;
  readonly mutation?: Mutation;
  /** How many transcript lines the window may scroll past. */
  readonly scrollLimit: number;
  /**
   * The identity the tree reports as focused.
   *
   * Supplied rather than stored: the tree owns focus, and a reducer that kept
   * its own copy would be the second focus model this rework removes.
   */
  readonly focused: string;
}

/**
 * What one event did, and what the tree should do about focus.
 *
 * Traversal and restoration are the tree's to perform — it is the thing that
 * knows what exists. The reducer decides *what should happen*, names it, and
 * lets the tree carry it out, so neither side keeps a second answer.
 */
export type FocusIntent =
  | { readonly kind: "advance" }
  | { readonly kind: "retreat" }
  | { readonly kind: "to"; readonly identity: string }
  | { readonly kind: "owner" };

export interface Reduction {
  readonly state: ReplState;
  readonly focus?: FocusIntent;
}

export interface Pointer {
  readonly button: "primary";
  readonly x: number;
  readonly y: number;
}

export interface Key {
  readonly type: string;
  readonly code?: string;
  readonly text?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/** A decoded key, read rather than assumed: the decoder's shape is its own. */
export function asKey(event: unknown): Key {
  const record = typeof event === "object" && event !== null ? { ...event } : {};
  const read = (name: string): string | undefined => {
    const value = Reflect.get(record, name);
    return typeof value === "string" ? value : undefined;
  };
  const flag = (name: string): boolean => Reflect.get(record, name) === true;
  return {
    type: read("type") ?? "",
    code: read("code"),
    text: read("text"),
    ctrl: flag("ctrl"),
    shift: flag("shift"),
    alt: flag("alt"),
  };
}

/** True where typing has to reach the target rather than the navigator. */
function editable(identity: string): boolean {
  return identity === "region:input" || identity.startsWith("field:");
}

/**
 * Reverse traversal, as a real terminal spells it.
 *
 * A terminal sends Shift+Tab as `ESC [ Z`, which this decoder reports as the
 * key code `Backtab` carrying no shift flag. A reducer that tested `Tab` with
 * `shift` was testing an event only a test had ever produced.
 */
export function reverseTab(key: Key, mutation?: Mutation): boolean {
  if (key.code === "Tab" && key.shift === true) {
    return true;
  }
  return key.code === "Backtab" && mutation !== "ignore-backtab";
}

/** A recorded moment is read-only, so nothing that changes the run may happen in one. */
function frozen(state: ReplState, mutation?: Mutation): boolean {
  return state.route.inspect && mutation !== "mutate-while-inspecting";
}

/**
 * How one event changes where you are.
 *
 * Pure, so every transition the interactive harness performs can be driven from
 * a test without a terminal — and so that a background update can be shown to
 * return state whose route, focus, selection and anchor are the *same
 * references* it was handed.
 */
export function reduce(state: ReplState, event: HarnessEvent, context: ReduceContext): Reduction {
  const { mutation } = context;
  const only = (next: ReplState): Reduction => ({ state: next });

  if (event.kind === "quit") {
    return only({ ...state, quit: true });
  }
  if (event.kind === "tick" || event.kind === "resize") {
    // A frame passing and a terminal resizing change what is drawn, never where
    // you are. The route survives a resize because the profile was never
    // recorded in it.
    if (event.kind === "resize" && mutation === "drop-route-on-resize") {
      return only(
        hydrateRoute(
          {
            execution: state.route.execution,
            surface: "transcript",
            scopes: [],
            drawers: [],
            inspect: false,
            draft: "",
          },
          state.journal,
        ),
      );
    }
    return only(state);
  }
  if (event.kind === "background") {
    // Nothing here touches focus at all — it is not in this model to touch,
    // which is the strongest form the "no stealing" claim can take. The control
    // has to reach past the store, into the tree, to break it.
    return only(withJournal(state, [...state.journal, event.record]));
  }

  if (event.kind === "pointer") {
    // A pointer that nothing owned did nothing. There is no global meaning for
    // one: it is an address, and an address nobody answered is not an event.
    return only(state);
  }
  const key = asKey(event.event);
  if (key.type !== "keydown") {
    return only(state);
  }
  const here = context.focused;

  if (key.code === "q" && !editable(here)) {
    return only({ ...state, quit: true });
  }
  if (key.ctrl === true && key.code === "c") {
    // An entry that is paused, or being looked at through a reconstruction, is
    // still running. Exiting instead of interrupting it would hand its
    // lifecycle to whoever closed the terminal.
    const active = state.moment.entry === "running" && mutation !== "exit-on-paused-interrupt";
    if (active) {
      return only({ ...state, interrupts: state.interrupts + 1 });
    }
    if (state.route.draft !== "") {
      return only(go(state, { ...state.route, draft: "" }, "draft", mutation));
    }
    return only({ ...state, quit: true });
  }
  if (key.code === "F1") {
    return only({ ...state, overlay: !state.overlay });
  }
  if (key.code === "Tab" || key.code === "Backtab" || key.code === "Escape") {
    // Traversal and Back are actions: the root maps these keys before the store
    // ever sees them, so reaching here means the delivery was refused and there
    // is nothing left to do.
    return only(state);
  }
  if (key.code === "Enter") {
    // Activation belongs to whatever was activated. An Enter that reaches the
    // fallback activated nothing, and inserting it into a draft instead would
    // make the same key mean two things.
    return only(state);
  }

  const digit = Number(key.code);
  if (!editable(here) && Number.isInteger(digit) && digit >= 1 && digit <= 5) {
    const surface = (["sessions", "transcript", "bindings", "input", "history"] as const)[
      digit - 1
    ];
    return {
      state: followFocus(state, surface, "surface", mutation),
      focus: { kind: "to", identity: `region:${surface}` },
    };
  }

  if (
    key.ctrl === true &&
    key.code !== undefined &&
    key.code.startsWith("Arrow") &&
    // Structural navigation acts only outside an editable target, so a
    // modified arrow is never stolen out of a draft somebody is typing.
    !editable(here)
  ) {
    return only(structural(state, key.code, mutation));
  }

  if (key.code === "ArrowUp") {
    return only({ ...state, anchor: Math.max(0, state.anchor - 1) });
  }
  if (key.code === "ArrowDown") {
    return only({ ...state, anchor: Math.min(context.scrollLimit, state.anchor + 1) });
  }
  if (key.code === "PageUp") {
    return only({ ...state, anchor: Math.max(0, state.anchor - 10) });
  }
  if (key.code === "PageDown") {
    return only({ ...state, anchor: Math.min(context.scrollLimit, state.anchor + 10) });
  }
  if (key.code === "ArrowLeft" || key.code === "ArrowRight") {
    return only(scrub(state, key.code === "ArrowLeft" ? -1 : 1, mutation));
  }
  if (key.code === "d" && !editable(here)) {
    return toggleDrawer(state, here, mutation);
  }

  return only(type(state, key, here, mutation));
}

/**
 * Back, which never discards the draft and never answers anything.
 *
 * The order is the study's: a drawer first, then a reconstruction, then a
 * control, then the navigation stack. Every step of it is non-destructive,
 * which is what lets Escape be the one key a person can always press.
 */
function back(state: ReplState, here: string, size: Size, mutation?: Mutation): Reduction {
  void size;
  // A drawer is not a step in this sequence any more. An open drawer traps
  // focus, so Back inside one passes through the drawer's own branch, and the
  // drawer translates it into closing itself — which is the thing that knows
  // it is a drawer.
  if (state.route.inspect) {
    return { state: go(state, { ...state.route, inspect: false }, "inspection", mutation) };
  }
  if (!here.startsWith("region:")) {
    // Which region owns this control is the tree's to answer; the route follows
    // once the tree has moved, in the same transition.
    return { state, focus: { kind: "owner" } };
  }
  const previous = state.history[state.history.length - 1];
  if (previous === undefined) {
    return { state };
  }
  const parsed = parseRoute(previous);
  if (!parsed.ok) {
    return { state };
  }
  return {
    state: mint(parsed.value, state.journal, {
      anchor: state.anchor,
      overlay: state.overlay,
      invokers: state.invokers,
      history: state.history.slice(0, -1),
      interrupts: state.interrupts,
      quit: state.quit,
    }),
  };
}

/**
 * What an action does to the state.
 *
 * `undefined` means this store does not own the action, which is how an action
 * nobody implements reaches the API default and throws instead of quietly doing
 * nothing.
 *
 * Every transition the interface can perform is here, and nowhere else. The
 * branch an action came from decided *what* should happen; this is the only
 * place that decides what the state becomes because of it.
 */
export function applyAction(
  state: ReplState,
  action: ReplAction,
  context: ReduceContext,
): Reduction | undefined {
  const { mutation } = context;
  if (mutation === "disown-actions") {
    // The control: a root that implements nothing. Every action then reaches
    // the default, which is the only thing that can tell the difference between
    // an action nobody owns and a button that happens to do nothing.
    return undefined;
  }
  if (action.kind === "pause") {
    return { state: frozen(state, mutation) ? state : extendTo(state, "paused") };
  }
  if (action.kind === "continue") {
    return { state: frozen(state, mutation) ? state : extendTo(state, "resumed") };
  }
  if (action.kind === "return-to-head") {
    // Closing the reconstruction leaves the selection where it was: returning
    // to the head is not the same act as deselecting a marker.
    return { state: go(state, { ...state.route, inspect: false }, "inspection", mutation) };
  }
  if (action.kind === "inspect") {
    // A reconstruction has no live suspension, so the drawer stack does not
    // survive into one. That is what makes study frame 12's focus walk real:
    // the trapped controls leave the sequence and focus has to resolve to the
    // nearest owner that did survive.
    if (state.selection < 0 || state.route.inspect) {
      return { state };
    }
    return {
      state: go(state, { ...state.route, inspect: true, drawers: [] }, "inspection", mutation),
    };
  }
  if (action.kind === "close-drawer") {
    // The route loses the drawer; the tree removes the branch and restores the
    // focus its push remembered. Neither side keeps the other's answer.
    return {
      state: go(
        state,
        { ...state.route, drawers: state.route.drawers.slice(0, -1) },
        "drawer",
        mutation,
      ),
    };
  }
  if (action.kind === "back") {
    return back(state, context.focused, context.size, mutation);
  }
  if (action.move === "next") {
    return { state, focus: { kind: "advance" } };
  }
  if (action.move === "previous") {
    return { state, focus: { kind: "retreat" } };
  }
  return { state, focus: { kind: "owner" } };
}

/**
 * The chronological axis: one semantic marker at a time.
 *
 * Selection moves and focus does not — the study is explicit that moving the
 * selection never moves focus. While a reconstruction is open the selection is
 * the reconstruction, so the URL moves with it, and it replaces rather than
 * pushes.
 */
function scrub(state: ReplState, delta: number, mutation?: Mutation): ReplState {
  const count = state.journal.length;
  if (count === 0) {
    return state;
  }
  const from = state.selection === -1 ? count : state.selection;
  const selection = Math.max(0, Math.min(count - 1, from + delta));
  // The selection is canonical, so it moves in the URL whether or not the
  // reconstruction is open — and it replaces, so Back from a marker returns to
  // where you came from rather than walking every marker the scrubber passed.
  return go(state, { ...state.route, at: state.journal[selection].marker }, "scrub", mutation);
}

/**
 * The structural axis: the locus, not the timeline.
 *
 * These move where you are in the execution's own tree, so they push. They act
 * only when focus is not in an editable target, which is what keeps a modified
 * arrow from being stolen out of a draft somebody is typing.
 */
function structural(state: ReplState, code: string, mutation?: Mutation): ReplState {
  const scopes = state.route.scopes;
  if (code === "ArrowUp") {
    return scopes.length === 0
      ? state
      : go(state, { ...state.route, scopes: scopes.slice(0, -1) }, "locus", mutation);
  }
  if (code === "ArrowDown") {
    // The entry is the first segment; the journal's scope stack starts below it.
    const children = siblingsOf(state.journal, scopes.slice(1));
    const first = children[0];
    return first === undefined
      ? state
      : go(state, { ...state.route, scopes: [...scopes, first] }, "locus", mutation);
  }
  if ((code === "ArrowLeft" || code === "ArrowRight") && mutation !== "inert-sibling-arrows") {
    const current = scopes[scopes.length - 1];
    if (scopes.length < 2 || current === undefined) {
      return state;
    }
    const siblings = siblingsOf(state.journal, scopes.slice(1, -1));
    const at = siblings.indexOf(current);
    if (at === -1 || siblings.length === 0) {
      return state;
    }
    const delta = code === "ArrowLeft" ? -1 : 1;
    const next = siblings[(at + delta + siblings.length) % siblings.length];
    return next === current
      ? state
      : go(state, { ...state.route, scopes: [...scopes.slice(0, -1), next] }, "locus", mutation);
  }
  return state;
}

/** `d` opens the suspension that is waiting, or closes the one that is open. */
function toggleDrawer(state: ReplState, here: string, mutation?: Mutation): Reduction {
  if (topDrawer(state.route) !== undefined) {
    return back(state, here, { cols: 0, rows: 0 }, mutation);
  }
  const waiting = state.moment.suspension;
  if (waiting === undefined || frozen(state, mutation)) {
    return { state };
  }
  return { state: openDrawer(state, waiting, here, mutation) };
}

/**
 * Open a suspension's drawer.
 *
 * The route gains it and the invoking identity is remembered. Mounting the
 * branch, pushing it as the focus root and seeding focus inside it are the
 * tree's — this does not reach across and place focus itself.
 */
export function openDrawer(
  state: ReplState,
  kind: DrawerKind,
  invoker: string,
  mutation?: Mutation,
): ReplState {
  const opened = go(
    state,
    { ...state.route, drawers: [...state.route.drawers, kind] },
    "drawer",
    mutation,
  );
  return { ...opened, invokers: { ...state.invokers, [kind]: invoker } };
}

/** Typing edits the draft, which replaces the current URL rather than adding to it. */
function type(state: ReplState, key: Key, here: string, mutation?: Mutation): ReplState {
  if (!editable(here) || frozen(state, mutation)) {
    return state;
  }
  if (key.code === "Backspace") {
    return go(state, { ...state.route, draft: state.route.draft.slice(0, -1) }, "draft", mutation);
  }
  const glyph = key.text ?? (key.code !== undefined && [...key.code].length === 1 ? key.code : "");
  if (glyph === "" || key.ctrl === true || key.alt === true) {
    return state;
  }
  return go(state, { ...state.route, draft: state.route.draft + glyph }, "draft", mutation);
}

export { JOURNAL, journalThrough };
