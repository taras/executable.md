/**
 * The product: what is on screen, and what every action changes.
 *
 * One boundary owns state. Everything a frame shows is derived here from a
 * resolved model prefix plus this process's explicit overlay, and every action
 * the tree returns is answered here. Components receive detached view data and
 * hand back a semantic action; they hold no session, no repository, no route
 * mutator and no host operation, so a keystroke cannot reach the Journal except
 * through this reduction.
 *
 * ## A prefix is not the present
 *
 * A view frozen at a history marker is read only and fills nothing from the
 * live head: no live output, no waiting question, no pause capability. That is
 * why the overlay is a separate member rather than merged into the model —
 * merging them is exactly the mistake that shows somebody the present while
 * they are looking at the past.
 *
 * ## Navigation that fails changes nothing
 *
 * Every navigating action builds a candidate route and resolves it against the
 * model before it is adopted. A candidate that does not resolve leaves the
 * standing route, selection and draft exactly as they were and reports why.
 * There is no half-applied navigation, because a route is adopted whole or not
 * at all.
 */

import { Ok, type Result } from "effection";
import type { Json } from "@executablemd/durable-streams";

import {
  describe as describeNode,
  fields,
  readDescription,
  runText,
  tokenRuns,
} from "./description.ts";
import type { ReplComponent, ReplDescription, ReplTokenRun, ReplViewData } from "./description.ts";
import {
  actionRowProps,
  bandProps,
  bodyProps,
  box,
  columnProps,
  stackProps,
  CONTROL_PROPS,
  drawerLayerProps,
  drawerRect,
  footerProps,
  historyBand,
  HISTORY_ROWS,
  inspectionWidth,
  paneColumnProps,
  paneContentProps,
  paneProps,
  NARROW,
  profileFor,
  refusalProps,
  refusalText,
  rootProps,
  rowProps,
  sharedColumnRows,
  sidebarWidth,
  viewportProps,
} from "./layout.ts";
import type {
  ReplBounds,
  ReplBox,
  ReplBoxProps,
  ReplLayoutManifest,
  ReplRegion,
  ReplViewportSlot,
} from "./layout.ts";
import {
  admitActions,
  admitRows,
  capacityOf,
  NOTHING_ADMITTED,
  scrolled,
} from "./layout-admission.ts";
import type { ReplAdmission, ReplWindow } from "./layout-admission.ts";
import { ORDINARY, REPL_PALETTE, styleOf } from "./presentation-style.ts";
import type { ReplPresentationRole, ReplRowStyle } from "./presentation-style.ts";
import { jsonRuns, sourceRuns } from "./presentation-text.ts";
import type { ReplTerminalSize } from "./terminal.ts";
import {
  decodeLocation,
  encodeLocation,
  NO_LIVE,
  resolveLocation,
  surfaceForDrawer,
} from "./route.ts";
import type {
  ReplDrawerRef,
  ReplLiveAvailability,
  ReplRoute,
  ReplSelection,
  ReplSurface,
} from "./route.ts";
import type {
  ReplAgentPermission,
  ReplAgentTurn,
  ReplEntry,
  ReplModel,
  ReplRow,
  ReplScope,
} from "./model.ts";
import type { ReplFormField, ReplQuestion, ReplQuestionForm } from "./elicitation.ts";
import type {
  ReplAgentReading,
  ReplAgentSlot,
  ReplLiveChoice,
  ReplLivePermission,
  ReplLiveTurn,
  ReplLiveTurnState,
} from "./agent.ts";
import type { ExpansionState } from "./expansion.ts";
import type { ReplTree } from "./reconcile.ts";
import {
  DRAWER,
  FIELD,
  fieldParts,
  fieldText,
  focusPrefixed,
  LINE,
  REFUSAL,
  SELECT_ROW,
} from "./components/rows.ts";
import type { ReplAction } from "./components/actions.ts";

export type { ReplAction };

/** What this process holds that the Journal does not. */
export interface ReplLive {
  /** Output no recorded outcome has replaced yet. */
  readonly output: string;
  /** The question waiting right now, or none. */
  readonly question: ReplQuestion | undefined;
  readonly expansion: ExpansionState;
  /** Whether this process holds the continuations, and so may pause at all. */
  readonly pausable: boolean;
  /**
   * Whether an entry's execution is still running in this process.
   *
   * The durable side cannot answer this. A root close is recorded the moment the
   * document settles, while the task that produced it is still unwinding — so a
   * screen reading only `model.settled` would offer the next entry during a
   * teardown that has not finished, and announce readiness the session would
   * refuse. Readiness is a fact about both halves, and this is the live half.
   */
  readonly running: boolean;
  /**
   * What this process knows about Agent work no record holds yet.
   *
   * Empty for a replay, a document with no Agent work and a frozen prefix — a
   * live reading describes work this process is doing, and none of those is.
   */
  readonly agent: ReplAgentReading;
}

/**
 * One turn as the Sessions surface shows it, live or retained.
 *
 * One type for both, because a person is looking at one turn either way: what
 * publication changes is where a turn's facts come from, not which turn it is.
 * `key` is its mounted identity and survives that change, so the row a person
 * had focus on is the same row afterwards.
 */
export interface ReplSessionTurn {
  /** The mounted identity: this process's slot, or a record's own marker. */
  readonly key: string;
  readonly prompt: string;
  /** `retained` once a record holds it, and the live states until then. */
  readonly state: ReplLiveTurnState | "retained";
  readonly text: string;
  readonly agent: string | undefined;
  /**
   * The conversation this turn joined, or none.
   *
   * None means the provider has not said yet — a queued turn — or never did.
   * Either way there is no conversation to filter it by, and the authored
   * Session name is not one.
   */
  readonly sessionKey: string | undefined;
  readonly status: "completed" | "failed" | "cancelled" | undefined;
  readonly stopReason: string | undefined;
  readonly failure: string | undefined;
  /** The history position this turn is recorded at, once it has one. */
  readonly marker: string | undefined;
  /** The request waiting on this turn right now, when one is. */
  readonly request: ReplLivePermission | undefined;
  /** What this turn was granted, once its record holds the audit. */
  readonly audits: readonly ReplAgentPermission[];
}

/**
 * Every turn this screen can show, in the order their Prompts were scheduled.
 *
 * Not a concatenation of the retained turns and the live ones. Prompts running
 * beside each other publish in whatever order their providers answer, so an
 * earlier Prompt can still be live while a later one is already durable — and
 * appending the live list to the retained one would put it second.
 *
 * The turns this process observed carry their own place, taken when each Prompt
 * was scheduled. Turns it did not observe are in the prefix it replayed, which
 * is entirely earlier than anything it went on to run, so they come first in the
 * order their records state.
 */
function chronology(model: ReplModel, live: ReplLive): readonly ReplSessionTurn[] {
  const observed = new Set<string>();
  for (const slot of live.agent.slots) {
    if (slot.durable !== undefined) {
      observed.add(correlation(slot.entry, slot.durable));
    }
  }
  const shown: ReplSessionTurn[] = [];
  for (const turn of model.turns) {
    if (!observed.has(correlation(turn.entry, turn.name))) {
      shown.push(retainedTurn(turn.marker, turn));
    }
  }
  for (const slot of [...live.agent.slots].sort((left, right) => left.order - right.order)) {
    const turn = resolved(slot, model, live);
    if (turn !== undefined) {
      shown.push(turn);
    }
  }
  return Object.freeze(shown);
}

/**
 * The one identity a publication is correlated by.
 *
 * Both halves, because neither is unique on its own. A Prompt's durable name is
 * derived from where it was written, and names restart with each entry — two
 * entries running the same source hold the same name at the same position, which
 * is ordinary rather than damaged. Correlating by the name alone suppresses both
 * of those records and resolves both slots to whichever one the chronology
 * reached first, so one turn is shown twice and the other not at all.
 *
 * The entry is the one each side already carries: the slot's own, and the
 * record's own. Never the entry that is current, the sequence by itself, or the
 * order the two turns happened to finish in.
 */
function correlation(entry: string, name: string): string {
  return `${entry}\u0000${name}`;
}

/** What one observed slot shows now: its record, or the turn as it still stands. */
function resolved(
  slot: ReplAgentSlot,
  model: ReplModel,
  live: ReplLive,
): ReplSessionTurn | undefined {
  if (slot.durable === undefined) {
    const turn = live.agent.turns.find((candidate) => candidate.key === slot.key);
    return turn === undefined ? undefined : liveTurn(slot.key, turn, live);
  }
  const record = model.turns.find(
    (candidate) => candidate.entry === slot.entry && candidate.name === slot.durable,
  );
  if (record !== undefined) {
    // Keyed by the slot, not by the marker: this is the row it already was.
    return retainedTurn(slot.key, record);
  }
  // Accounted for here before the history it belongs to was projected. The facts
  // it had are still the facts, and a row that vanished for this one frame is
  // the turn a person was reading disappearing under them.
  return slot.last === undefined ? undefined : liveTurn(slot.key, slot.last, live);
}

function liveTurn(key: string, turn: ReplLiveTurn, live: ReplLive): ReplSessionTurn {
  return Object.freeze({
    key,
    prompt: turn.prompt,
    state: turn.state,
    text: turn.text,
    agent: turn.agent,
    sessionKey: turn.sessionKey,
    status: turn.status,
    stopReason: turn.stopReason,
    failure: turn.failure,
    marker: undefined,
    request: live.agent.requests.find((request) => request.turn === turn.key),
    audits: Object.freeze([]),
  });
}

function retainedTurn(key: string, turn: ReplAgentTurn): ReplSessionTurn {
  return Object.freeze({
    key,
    prompt: turn.input,
    state: "retained",
    text: turn.text,
    agent: turn.agent,
    sessionKey: turn.sessionKey.length === 0 ? undefined : turn.sessionKey,
    status: turn.status,
    stopReason: turn.stopReason,
    failure: turn.failure,
    marker: turn.marker,
    // A record cannot be waiting on anybody: what it holds is what it was
    // granted, and it is read rather than answered.
    request: undefined,
    audits: turn.permissions,
  });
}

/**
 * The conversations this screen offers to filter by, earliest turn first.
 *
 * Earliest, never latest activity: a list that reordered itself when a provider
 * streamed would move the control somebody was reaching for.
 */
function conversations(turns: readonly ReplSessionTurn[]): readonly string[] {
  const keys: string[] = [];
  for (const turn of turns) {
    const key = turn.sessionKey;
    if (key !== undefined && key.length > 0 && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return Object.freeze(keys);
}

/** A process running no Agent work, which is what a frozen view also shows. */
export const NO_AGENT: ReplAgentReading = Object.freeze({
  turns: Object.freeze([]),
  requests: Object.freeze([]),
  slots: Object.freeze([]),
});

/** One thing the last submission said was wrong, as a reader sees it. */
export interface ReplFormMessage {
  /** The field it belongs to, or none for the object as a whole. */
  readonly field: string | undefined;
  readonly message: string;
}

/**
 * The form being filled in, while a question is being asked.
 *
 * Values are keyed by field name because the fields are independent: one global
 * string would make editing either field overwrite the other. None of this is
 * durable, none of it is in the route, and all of it is discarded when the
 * question ends or its drawer is closed.
 */
export interface ReplFormState {
  /** What has been typed into each field so far, by field name. */
  readonly values: Readonly<Record<string, string>>;
  /** Which field text and Backspace act on, or none yet. */
  readonly field: string | undefined;
  /** What the last submission was told was wrong. */
  readonly messages: readonly ReplFormMessage[];
  /** How far the read-only message region has been scrolled, in lines. */
  readonly offset: number;
}

/** A form nobody has touched. */
export const EMPTY_FORM: ReplFormState = Object.freeze({
  values: Object.freeze({}),
  field: undefined,
  messages: Object.freeze([]),
  offset: 0,
});

/**
 * Which control focus goes back to, because the drawer that held it went.
 *
 * Freedom restores the control that was focused before a modal was pushed, which
 * is where focus *was* rather than where the question now is: answering leaves a
 * retained invocation to look at, and dismissing leaves one still being asked.
 * Both are named here rather than resolved, because which row that is depends on
 * what is mounted and only the view knows that.
 */
export type ReplFocusRestore =
  /**
   * The invocation whose answer this was, once its record is projected.
   *
   * Named by what it caused rather than by where it sits: the record appends
   * after the drawer is gone, so the row does not exist yet at the moment the
   * claim is made. `known` is every answer already retained when this one was
   * taken and `answer` is exactly what was sent, which together name one
   * record — not the newest one, and not an answer somebody else caused.
   */
  | {
      readonly kind: "answered";
      readonly known: readonly string[];
      readonly answer: Json;
    }
  /** The invocation still asking, now that its drawer is not up. */
  | { readonly kind: "asked" }
  /**
   * The turn a permission drawer was answering for.
   *
   * The turn rather than the request: the request is gone — that is what
   * answering it means — and the turn it was waiting on is the thing still on
   * screen to come back to.
   */
  | { readonly kind: "turn"; readonly turn: string };

/**
 * How far each windowed reading is scrolled, in rows.
 *
 * Process-local, and deliberately not in the route: where somebody scrolled to
 * is not a place another process can be sent to, and a location carrying it
 * would reopen somewhere else at a row describing a different reading. Two
 * separate numbers because the windows are open at once — a wide frame carries
 * both readings in its sidebar, and a drawer scrolls the request it is asking
 * while the reading behind it keeps the row it was left on.
 *
 * Each is clamped where it is read, because publication, a filter, a background
 * change and a resize all change how many rows there are with nobody pressing
 * anything.
 */
export interface ReplViewports {
  /** Rows the Sessions reading is scrolled by. */
  readonly sessions: number;
  /** Rows the Entries catalog is scrolled by. */
  readonly entries: number;
  /** Rows the open permission drawer is scrolled by. */
  readonly permission: number;
  /**
   * Rows each retained drawer reading is scrolled by, one per reading.
   *
   * Keyed by what the reading **is** — the execution, the prefix being read, and
   * the binding or occurrence being shown — rather than by the drawer's title or
   * its position in the stack. Two bindings with the same name in different
   * scopes are different readings and keep different offsets, and revisiting one
   * finds its own position again instead of wherever the last drawer was left.
   *
   * Process-local, like every other window: no location, record or Journal holds
   * one, so a location read in another process opens each reading at its start.
   */
  readonly readings: Readonly<Record<string, number>>;
}

/** Every window at its first row, which is where a fresh reading starts. */
export const AT_TOP: ReplViewports = Object.freeze({
  sessions: 0,
  entries: 0,
  permission: 0,
  readings: Object.freeze({}),
});

/** Everything typed and not yet committed anywhere. */
export interface ReplState {
  readonly route: ReplRoute;
  /**
   * The text of the entry that would be submitted next.
   *
   * Execution-wide, and independent of what is selected: an admitted entry is
   * immutable, so this is always the *next* one. It survives a refused
   * submission, remains editable while an entry is running and while a history
   * position is being inspected, and leaves only when it has become an entry.
   */
  readonly draft: string;
  /** The form being filled into the waiting question. */
  readonly form: ReplFormState;
  /** Why the last action changed nothing, or none. */
  readonly refusal: string | undefined;
  /**
   * The pending permission request this screen has selected, or none.
   *
   * This process's own opaque key, never a location: which request is being
   * answered is a fact about the process holding it, and a key in a URL would
   * publish a live identity nothing else can use.
   */
  readonly permission: string | undefined;
  /**
   * Where focus starts again, for the one commit after a drawer went.
   *
   * One-shot and process-local. A claim repeated every frame would drag focus
   * back after every Tab, so the next action clears it: from then on focus is
   * the tree's, which is the only thing that knows where it is.
   */
  readonly restore: ReplFocusRestore | undefined;
  /** How far each windowed reading is scrolled. */
  readonly viewports: ReplViewports;
}

/** What the root must perform, because a component cannot. */
export type ReplIntent =
  | { readonly kind: "none" }
  | { readonly kind: "submit"; readonly source: string }
  | { readonly kind: "pause" }
  | { readonly kind: "continue" }
  | { readonly kind: "answer"; readonly values: Readonly<Record<string, string>> }
  /**
   * Answer one pending permission request with one option it offered.
   *
   * Scalars only, and the turn it belongs to comes along because the root needs
   * it after the request is gone: answering removes the request, and focus has
   * to land on the turn that was waiting.
   */
  | {
      readonly kind: "settle-permission";
      readonly request: string;
      readonly option: string | undefined;
      readonly turn: string;
    }
  /**
   * End the command.
   *
   * The root's to perform because only the root owns the scope that holds the
   * session, the observer, each entry task and the terminal. Nothing is appended
   * for it: ending is the absence of further work, not an outcome.
   */
  | { readonly kind: "exit" };

/** One reduction: the state that stands now, and what the root owes. */
export interface ReplTransition {
  readonly state: ReplState;
  readonly intent: ReplIntent;
}

/** One complete reading of the product, ready to describe. */
export interface ReplView {
  readonly state: ReplState;
  readonly model: ReplModel;
  readonly selection: ReplSelection;
  readonly live: ReplLive;
  /** The canonical location this view is at. */
  readonly location: string;
  /**
   * Why there is no view at all, when that is what happened.
   *
   * Only that. A refusal of one *action* is `state.refusal` and belongs in the
   * footer beside the control that was refused — replacing the whole screen with
   * it would take away the thing the person was working on in order to explain
   * why it did not change.
   */
  readonly refusal: string | undefined;
  /**
   * How much terminal there is.
   *
   * Carried because what a row may contain depends on where it will be put: a
   * row longer than its region is reflowed into rows the layout never allocated,
   * so whoever writes one has to know how wide it will be.
   */
  readonly size: ReplTerminalSize;
  /**
   * The key of the control that held focus when this view was built.
   *
   * Derived, and therefore one frame behind: focus belongs to the mounted tree,
   * and the tree is what answers where it is. A person has to be able to see
   * which control their next keystroke reaches, so the marker is part of the view
   * rather than something the renderer decorates.
   */
  readonly focused: string | undefined;
}

/**
 * The state after an entry was admitted.
 *
 * The draft leaves the state and the location together, because what was typed is
 * now the entry and a location carrying both would describe two different things
 * at once.
 */
export function admitted(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    draft: "",
    route: Object.freeze({ ...state.route, draft: undefined }),
    refusal: undefined,
  });
}

/**
 * The state after a question accepted its answer.
 *
 * `model` is the history as it stood *before* the answer and `answer` is the
 * object the question took, because together they name the record this answer is
 * about to add.
 *
 * The question is over, so the drawer that was asking it is over too. Leaving
 * `+elicit` in the route would print a location naming a drawer the topology no
 * longer mounts — a URL that describes a screen nobody can be shown — and
 * leaving the typed text in `answer` would offer it again as though it were
 * still waiting to be sent.
 */
export function answered(state: ReplState, model: ReplModel, answer: Json): ReplState {
  return Object.freeze({
    ...state,
    form: EMPTY_FORM,
    // The answer is what there is to look at now, so focus goes to the
    // invocation that has it rather than wherever the drawer was opened from.
    // Which invocation that is cannot be read yet: its record appends after this,
    // so the claim carries what will identify it when it arrives.
    restore: Object.freeze({ kind: "answered", known: retainedAnswers(model), answer }),
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze(state.route.drawers.filter((drawer) => drawer.kind !== "live-elicit")),
    }),
    refusal: undefined,
  });
}

/**
 * The state after a permission request was really settled.
 *
 * Only a successful authority call reaches this: the drawer goes because the
 * request it was opened over is gone, and focus returns to the turn that was
 * waiting rather than to wherever the drawer was opened from.
 */
export function permissionSettled(state: ReplState, turn: string): ReplState {
  return Object.freeze({
    ...state,
    permission: undefined,
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze(
        state.route.drawers.filter((drawer) => drawer.kind !== "live-permission"),
      ),
    }),
    restore: Object.freeze({ kind: "turn", turn }),
    // The drawer is over, so the window over it is too: the next request opens
    // at its own first row rather than at wherever this one was read to.
    viewports: Object.freeze({ ...state.viewports, permission: 0 }),
    refusal: undefined,
  });
}

/**
 * The state after the request a drawer was opened over stopped existing.
 *
 * Teardown and publication can both remove a request nobody answered. The drawer
 * it left behind can resolve to nothing, so it is withdrawn — and nothing here
 * claims a choice or a denial, because none was made.
 */
export function permissionWithdrawn(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    permission: undefined,
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze(
        state.route.drawers.filter((drawer) => drawer.kind !== "live-permission"),
      ),
    }),
    viewports: Object.freeze({ ...state.viewports, permission: 0 }),
  });
}

/**
 * The state to adopt at a history position the selected entry predates, or none.
 *
 * A prefix earlier than an entry's admission holds no such entry, so the entry
 * and the nested scopes beneath it name nothing there. The position is what was
 * asked for, so what goes is the suffix that has become invalid — and nothing
 * guesses another entry in its place, because the person chose a position
 * rather than a selection.
 *
 * Everything else stands: the draft, the surface, the conversation filter and
 * the marker itself. The drawers that go are the two that open over a scope; the
 * History drawer is how a person reached this position and belongs to no scope
 * at all.
 *
 * Only at a frozen position, and only when the entry is really absent. A
 * directly opened location naming an entry its prefix never admitted refuses
 * whole rather than arriving somewhere adjacent, and that path never comes here.
 */
export function withoutAbsentEntry(state: ReplState, model: ReplModel): ReplState | undefined {
  const selected = state.route.scopes[0];
  if (state.route.at === undefined || selected === undefined) {
    return undefined;
  }
  if (model.entries.some((entry) => entry.key === selected)) {
    return undefined;
  }
  return Object.freeze({
    ...state,
    route: Object.freeze({
      ...state.route,
      scopes: Object.freeze([]),
      drawers: Object.freeze(
        state.route.drawers.filter(
          (drawer) => drawer.kind === "history" || drawer.kind === "live-permission",
        ),
      ),
    }),
  });
}

/** The empty route one fresh execution starts at. */
export function initialRoute(execution: string): ReplRoute {
  return Object.freeze({
    execution,
    surface: "repl",
    scopes: Object.freeze([]),
    drawers: Object.freeze([]),
    at: undefined,
    inspect: false,
    draft: undefined,
    session: undefined,
  });
}

/** The state one fresh execution starts in. */
export function initialState(execution: string): ReplState {
  return Object.freeze({
    route: initialRoute(execution),
    draft: "",
    form: EMPTY_FORM,
    refusal: undefined,
    permission: undefined,
    restore: undefined,
    viewports: AT_TOP,
  });
}

/** Read one location into the state it names. */
export function stateFor(location: string): Result<ReplState> {
  const decoded = decodeLocation(location);
  if (!decoded.ok) {
    return decoded;
  }
  return Ok(
    Object.freeze({
      route: decoded.value,
      draft: decoded.value.draft ?? "",
      form: EMPTY_FORM,
      refusal: undefined,
      permission: undefined,
      restore: undefined,
      // Never decoded: a window position is this process's, so a location read
      // here opens the reading at its first row rather than at a row the
      // process that wrote the location happened to be on.
      viewports: AT_TOP,
    }),
  );
}

/**
 * Build one view, or say why there is none.
 *
 * The selection is resolved here and nowhere else, so every surface below reads
 * the same exact model objects rather than looking them up again and possibly
 * differently.
 */
export function viewFor(
  state: ReplState,
  model: ReplModel,
  live: ReplLive,
  size: ReplTerminalSize,
  focused?: string,
): Result<ReplView> {
  // This process is the only thing that can say a question is waiting, so it
  // says so here rather than leaving resolution to infer it from a history that
  // does not record it.
  const resolved = resolveLocation(model, state.route, availabilityOf(state, live));
  if (!resolved.ok) {
    return resolved;
  }
  // A frozen prefix shows nothing of the present. Stated once, here, rather
  // than remembered at each surface that would otherwise reach for the overlay.
  const shown: ReplLive =
    state.route.at === undefined
      ? live
      : {
          output: "",
          question: undefined,
          expansion: live.expansion,
          pausable: false,
          // A frozen prefix is a reading of the file, not of this process: it
          // fills nothing from the live head, and what the head is doing is not
          // a fact about the position being inspected.
          running: false,
          agent: NO_AGENT,
        };
  return Ok(
    Object.freeze({
      state,
      model,
      selection: resolved.value,
      live: shown,
      location: encodeLocation(state.route),
      // Not `state.refusal`: a view exists, and what one action refused is said in
      // the footer rather than in place of everything.
      refusal: undefined,
      size,
      focused,
    }),
  );
}

/** The one view a cold open that cannot be projected gets. */
export function refusedView(
  state: ReplState,
  reason: string,
  size: ReplTerminalSize = NARROW,
  focused?: string,
): ReplView {
  return Object.freeze({
    state,
    model: EMPTY_MODEL,
    selection: Object.freeze({
      route: state.route,
      surface: state.route.surface,
      entry: undefined,
      ancestry: Object.freeze([]),
      scope: undefined,
      session: undefined,
      drawers: Object.freeze([]),
    }),
    live: Object.freeze({
      output: "",
      question: undefined,
      expansion: "playing",
      pausable: false,
      running: false,
      agent: NO_AGENT,
    }),
    location: encodeLocation(state.route),
    refusal: reason,
    size,
    // Where focus actually is, once a commit has said: this screen has a control
    // on it, and a marker that named a different node would draw it on nothing.
    focused: focused ?? "refusal",
  });
}

/**
 * What this process can say about state no history holds.
 *
 * `permission` is not "a request is waiting": it is "the request this screen has
 * selected is still waiting". A drawer opens over one exact request, so a route
 * that named one which has since settled resolves to nothing rather than to
 * whatever is pending now.
 *
 * `sessions` is the conversations live turns have actually started under. A
 * queued turn has none yet, and the authored Session name, the Prompt name and
 * the agent are not conversations — inferring one from them would offer a filter
 * for a key the provider never issued.
 */
function availabilityOf(state: ReplState, live: ReplLive): ReplLiveAvailability {
  const selected = state.permission;
  const keys: string[] = [];
  for (const turn of live.agent.turns) {
    const key = turn.sessionKey;
    if (key !== undefined && key.length > 0 && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return {
    elicit: live.question !== undefined,
    permission:
      selected !== undefined && live.agent.requests.some((request) => request.key === selected),
    sessions: Object.freeze(keys),
  };
}

const EMPTY_MODEL: ReplModel = Object.freeze({
  selection: undefined,
  head: true,
  entries: Object.freeze([]),
  settled: false,
  terminal: undefined,
  checkpoints: Object.freeze([]),
  transcript: Object.freeze([]),
  turns: Object.freeze([]),
  sessions: Object.freeze([]),
});

/**
 * Answer one action.
 *
 * Total over the union, and pure: nothing here appends, opens, pauses or
 * answers. What needs doing comes back as an intent for the root to perform, so
 * the decision and the effect are separable and the decision is testable alone.
 */
export function reduceRepl(
  given: ReplState,
  action: ReplAction,
  model: ReplModel,
  live: ReplLive,
  // What the frame measured and admitted, for the decisions that depend on it:
  // how far each window may move, and from where. It is the same answer the
  // descriptions were built from, so a scroll cannot clamp against a capacity
  // the screen is not showing. A caller that states none moves no window — an
  // unmeasured frame has admitted nothing.
  admission: ReplAdmission = NOTHING_ADMITTED,
): ReplTransition {
  // Whoever pressed this key has moved on from wherever the last drawer put
  // focus, so the claim does not outlive the commit it was made for.
  const state =
    given.restore === undefined ? given : Object.freeze({ ...given, restore: undefined });
  const answering = state.route.drawers.some((drawer) => drawer.kind === "live-elicit");

  switch (action.kind) {
    // Typing is always typing the *next* entry. Which entry is selected, and
    // whether one is running, decide nothing here: an admitted entry is
    // immutable, so there is never an entry these keystrokes could be editing.
    case "type": {
      if (answering) {
        return editing(state, live, action.field, (value) => value + action.text);
      }
      return drafting(state, state.draft + action.text);
    }
    case "erase": {
      if (answering) {
        return editing(state, live, action.field, shortened);
      }
      return drafting(state, shortened(state.draft));
    }
    case "submit": {
      if (state.route.at !== undefined) {
        // Inspection freezes durable state, not the draft. Submitting from here
        // would have to choose an inheritance boundary, and the only one that is
        // not a fork is the live head — which is not what this view is of.
        return refuse(
          state,
          "this view is frozen at an earlier history position. Return to the live head to submit.",
        );
      }
      if (state.draft.length === 0) {
        return refuse(state, "there is nothing to submit yet.");
      }
      // The draft stays until the entry exists. Clearing it here would lose
      // somebody's document to a preflight refusal, which is the one moment they
      // most need it back — and whether this is a moment to submit at all is the
      // session's to answer, because only it knows whether the entry before this
      // one has both settled and joined.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "submit", source: state.draft },
      };
    }
    case "exit": {
      // No guard, from any state. Leaving is available while an entry runs, while
      // a question waits, while a request is pending and while a position is being
      // inspected — a person who cannot leave the screen they are on has not been
      // given a way out, they have been given four.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "exit" },
      };
    }
    case "select-surface": {
      return navigate(state, model, { ...state.route, surface: action.surface, drawers: [] }, live);
    }
    case "select-scope": {
      return navigate(
        state,
        model,
        {
          ...state.route,
          surface: "repl",
          scopes: Object.freeze([...action.scopes]),
          // A drawer named a thing inside the scope that was open. Selecting a
          // different scope cannot keep it.
          drawers: Object.freeze([]),
        },
        live,
      );
    }
    case "open-drawer": {
      if (action.drawer.kind === "live-elicit") {
        if (state.route.at !== undefined) {
          return refuse(
            state,
            "a historical view cannot answer the question this process is asking. " +
              "Activate [live] to return to the head.",
          );
        }
        if (live.question === undefined) {
          return refuse(state, "nothing is being asked right now.");
        }
      }
      // A drawer belongs to one surface, so activating a control that opens one
      // goes to that surface as part of the same explicit act. The alternative is
      // refusing somebody on the surface they are standing on for asking to see
      // something that exists — which is what a waiting question on Sessions used
      // to be. A surface this crosses starts a fresh stack: a drawer was opened
      // over a surface, and carrying it to another one would stack it over a
      // screen it was never in front of.
      const owning = surfaceForDrawer(action.drawer);
      const crossing = owning !== state.route.surface;
      return navigate(
        state,
        model,
        {
          ...state.route,
          surface: owning,
          // The question belongs to the entry still running, and that is the entry
          // whose transcript it has to be read against.
          scopes:
            action.drawer.kind === "live-elicit"
              ? askingEntry(model, state.route.scopes)
              : state.route.scopes,
          drawers: Object.freeze(
            crossing ? [action.drawer] : [...state.route.drawers, action.drawer],
          ),
        },
        live,
      );
    }
    case "close-drawer": {
      if (state.route.drawers.length === 0) {
        return refuse(state, "no drawer is open.");
      }
      const closing = state.route.drawers[state.route.drawers.length - 1];
      if (closing?.kind === "live-permission") {
        // Dismissing a permission request denies it, and a denial is something
        // only the authority can do. So this closes nothing yet: the drawer goes
        // when the request it was opened over is really gone, and until then a
        // screen that had already closed would be claiming an answer nobody gave.
        const pending =
          state.permission === undefined ? undefined : offered(state, live, state.permission);
        if (pending === undefined) {
          // Nothing left to deny — teardown or publication took it. The drawer is
          // withdrawn rather than answered.
          return settled(permissionWithdrawn(state));
        }
        return {
          state: Object.freeze({ ...state, refusal: undefined }),
          intent: {
            kind: "settle-permission",
            request: pending.key,
            option: undefined,
            turn: pending.turn,
          },
        };
      }
      const remaining = Object.freeze(state.route.drawers.slice(0, -1));
      const closed = navigate(state, model, { ...state.route, drawers: remaining }, live);
      // Dismissing the question's drawer discards what was typed into it. It is
      // not an answer, and keeping it would offer it again as though it were.
      return closing.kind === "live-elicit"
        ? {
            ...closed,
            // Still being asked, so what focus returns to is the invocation that
            // is asking — the one control that opens this drawer again.
            state: Object.freeze({
              ...closed.state,
              form: EMPTY_FORM,
              restore: Object.freeze({ kind: "asked" }),
            }),
          }
        : closed;
    }
    case "select-session": {
      // Only the filter moves: the surface, the scope path, the history marker,
      // the draft and the drawer stack are all left exactly as they stand. A key
      // that names no conversation is refused by the codec's own resolution, so
      // a stale one cannot become an empty Sessions view.
      //
      // The window goes back to the first row, because a filtered reading is a
      // different list: row forty of everything is not row forty of one
      // conversation, and keeping the number would open somewhere nobody chose.
      return navigate(atFirstRow(state), model, { ...state.route, session: action.session }, live);
    }
    case "all-sessions": {
      return navigate(atFirstRow(state), model, { ...state.route, session: undefined }, live);
    }
    case "scroll-sessions": {
      // From the clamp the frame is **showing**, over the window it measured for
      // the size and reading this action is being answered at. A delta added to
      // a stored number instead would spend a press normalizing state nobody can
      // see — a resize or a filter changes what the window holds, and the region
      // is already drawing the clamped position.
      const window = admission.windows.get(SESSIONS_WINDOW);
      if (window === undefined) {
        // Nothing measured a window here, so there is nothing to move. A reading
        // that fits its region is not scrolled; it is shown.
        return settled({ ...state, refusal: undefined });
      }
      return settled({
        ...state,
        viewports: Object.freeze({ ...state.viewports, sessions: scrolled(window, action.delta) }),
        refusal: undefined,
      });
    }
    case "scroll-entries": {
      // The same rule over the catalog's own measured window.
      const window = admission.windows.get(ENTRIES_WINDOW);
      if (window === undefined) {
        return settled({ ...state, refusal: undefined });
      }
      return settled({
        ...state,
        viewports: Object.freeze({ ...state.viewports, entries: scrolled(window, action.delta) }),
        refusal: undefined,
      });
    }
    case "select-permission": {
      // The key is taken first, because a `+permission` candidate resolves only
      // while the request it names is pending — so the state that navigates has
      // to be the one already holding it. A refusal keeps neither.
      const holding = Object.freeze({
        ...state,
        permission: action.request,
        // At its first row: this is a different request, and a window left where
        // the last one was read to would open part way down a question nobody
        // has read the start of.
        viewports: Object.freeze({ ...state.viewports, permission: 0 }),
      });
      // Declared, so the drawer this adds is the one the grammar defines rather
      // than a string this case happens to spell the same way.
      const opening: ReplDrawerRef = { kind: "live-permission" };
      const opened = navigate(
        holding,
        model,
        {
          ...state.route,
          drawers: Object.freeze([...state.route.drawers, opening]),
        },
        live,
      );
      return opened.state.refusal === undefined ? opened : refuse(state, opened.state.refusal);
    }
    case "choose-permission": {
      const pending = offered(state, live, action.request);
      if (pending === undefined) {
        return refuse(state, "that permission request is not the one being answered.");
      }
      if (!pending.choices.some((choice) => choice.optionId === action.option)) {
        // Re-checked against the reading as it stands: a choice drawn one frame
        // ago is not a choice the provider is still offering.
        return refuse(state, "that choice is not one this request offered.");
      }
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: {
          kind: "settle-permission",
          request: action.request,
          option: action.option,
          turn: pending.turn,
        },
      };
    }
    case "dismiss-permission": {
      const pending = offered(state, live, action.request);
      if (pending === undefined) {
        return refuse(state, "that permission request is not the one being answered.");
      }
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: {
          kind: "settle-permission",
          request: action.request,
          option: undefined,
          turn: pending.turn,
        },
      };
    }
    case "select-marker": {
      // Adopted rather than resolved here: a position is a *different reading* of
      // the file, and this model is the one the view being left was built from.
      // The root reprojects at the named position and verifies there, which is
      // the only place the answer exists.
      return settled({
        ...state,
        route: Object.freeze({ ...state.route, at: action.marker, inspect: true }),
        refusal: undefined,
      });
    }
    case "go-live": {
      return settled({
        ...state,
        route: Object.freeze({
          ...state.route,
          at: undefined,
          inspect: false,
          // A recorded drawer may name something the head no longer selects.
          drawers: Object.freeze([]),
        }),
        refusal: undefined,
      });
    }
    case "pause": {
      if (!live.pausable) {
        return refuse(state, "this process holds no live expansion to pause.");
      }
      return { state: Object.freeze({ ...state, refusal: undefined }), intent: { kind: "pause" } };
    }
    case "continue": {
      if (!live.pausable) {
        return refuse(state, "this process holds no live expansion to continue.");
      }
      if (live.expansion !== "paused") {
        // Nothing is held yet, so there is nothing to release. Resuming here
        // would withdraw a pause that has not finished taking effect.
        return refuse(state, "expansion is not paused, so nothing is held to continue.");
      }
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "continue" },
      };
    }
    case "answer": {
      if (state.route.at !== undefined) {
        return refuse(
          state,
          "a historical view cannot answer the question this process is asking.",
        );
      }
      if (live.question === undefined) {
        return refuse(state, "nothing is being asked right now.");
      }
      // The whole object, however it was assembled. Whether it is an answer is
      // the schema's to say, and the root asks it — a reducer that guessed here
      // would be a second validator disagreeing with the first.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "answer", values: state.form.values },
      };
    }
    case "select-field": {
      if (!answering || live.question === undefined) {
        return refuse(state, "nothing is being asked right now.");
      }
      if (!live.question.form.fields.some((one) => one.name === action.field)) {
        return refuse(state, "this question has no such field.");
      }
      return settled({
        ...state,
        form: Object.freeze({ ...state.form, field: action.field }),
        refusal: undefined,
      });
    }
    case "choose": {
      if (!answering || live.question === undefined) {
        return refuse(state, "nothing is being asked right now.");
      }
      const field = live.question.form.fields.find((one) => one.name === action.field);
      if (field === undefined) {
        return refuse(state, "this question has no such field.");
      }
      // Never a value the question did not offer: a stray identifier puts
      // nothing into the form rather than something the schema will reject.
      if (field.choices === undefined || !field.choices.includes(action.option)) {
        return refuse(state, "this field does not offer that value.");
      }
      // Activating an option is an answer attempt, like Enter anywhere else in
      // the form: the value goes in and the whole object is offered. Whether it
      // is an answer is the schema's to say — choosing "Request changes" with no
      // feedback yet leaves the same question open, carrying what it said.
      const chosen = written(state.form, action.field, action.option);
      return {
        state: Object.freeze({ ...state, form: chosen, refusal: undefined }),
        intent: { kind: "answer", values: chosen.values },
      };
    }
    case "scroll": {
      const open = state.route.drawers[state.route.drawers.length - 1];
      if (open === undefined) {
        return refuse(state, "no drawer is open to scroll.");
      }
      // The window the frame measured for the drawer that is open. One viewport
      // moves at a time, because one drawer is read at a time; which offset the
      // new position is stored in is decided by what is being read.
      const window = admission.windows.get(DRAWER_WINDOW);
      if (open.kind === "live-permission") {
        const pending =
          state.permission === undefined ? undefined : offered(state, live, state.permission);
        if (pending === undefined) {
          return refuse(state, "no permission request is being answered.");
        }
        if (window === undefined) {
          return settled({ ...state, refusal: undefined });
        }
        return settled({
          ...state,
          viewports: Object.freeze({
            ...state.viewports,
            permission: scrolled(window, action.delta),
          }),
          refusal: undefined,
        });
      }
      if (open.kind === "live-elicit") {
        if (!answering) {
          return refuse(state, "nothing is being asked right now.");
        }
        if (window === undefined) {
          return settled({ ...state, refusal: undefined });
        }
        return settled({
          ...state,
          form: Object.freeze({ ...state.form, offset: scrolled(window, action.delta) }),
          refusal: undefined,
        });
      }
      // A retained reading: History, a binding's value or a recorded answer.
      // Scrolling one changes that reading's own offset and nothing else — no
      // canonical location, no Journal, no History selection and no answer.
      const reading = readingKeyOf(state, open);
      if (reading === undefined || window === undefined) {
        return settled({ ...state, refusal: undefined });
      }
      return settled({
        ...state,
        viewports: Object.freeze({
          ...state.viewports,
          readings: Object.freeze({
            ...state.viewports.readings,
            [reading]: scrolled(window, action.delta),
          }),
        }),
        refusal: undefined,
      });
    }
  }
}

/** One field's value replaced, leaving every other field alone. */
function written(form: ReplFormState, field: string, value: string): ReplFormState {
  return Object.freeze({
    ...form,
    values: Object.freeze({ ...form.values, [field]: value }),
    // A value that has changed makes the last verdict about the old one stale,
    // so the messages go rather than sitting under a form they no longer
    // describe.
    messages: Object.freeze([]),
  });
}

/**
 * The field text and Backspace act on.
 *
 * Whichever field has focus, or the first one the question declares — so a
 * person who starts typing before selecting anything edits the field they are
 * looking at rather than nothing.
 */
function fieldNamed(live: ReplLive, name: string): ReplFormField | undefined {
  return live.question?.form.fields.find((one) => one.name === name);
}

function focused(state: ReplState, live: ReplLive): ReplFormField | undefined {
  const fields = live.question?.form.fields ?? [];
  const named = fields.find((one) => one.name === state.form.field);
  return named ?? fields[0];
}

/** Edit the focused field, and only it. */
function editing(
  state: ReplState,
  live: ReplLive,
  named: string | undefined,
  change: (value: string) => string,
): ReplTransition {
  const field = named === undefined ? focused(state, live) : fieldNamed(live, named);
  if (field === undefined) {
    return refuse(state, "nothing is being asked right now.");
  }
  const form = written(state.form, field.name, change(state.form.values[field.name] ?? ""));
  return settled({
    ...state,
    form: Object.freeze({ ...form, field: field.name }),
    refusal: undefined,
  });
}

/**
 * The request this action may act on, or none.
 *
 * One request: the one this screen selected *and* the one still pending. An
 * unknown key, a stale key and a key for a request that has since settled all
 * answer none, so nothing is settled on their behalf.
 */
function offered(
  state: ReplState,
  live: ReplLive,
  request: string,
): ReplLivePermission | undefined {
  if (state.permission !== request) {
    return undefined;
  }
  return live.agent.requests.find((candidate) => candidate.key === request);
}

/**
 * One offset, inside the window it is over.
 *
 * The one place either window decides where it is, so what a reducer moves from
 * and what a frame draws cannot be two different rows.
 */
function clamped(offset: number, furthest: number): number {
  return Math.min(Math.max(0, offset), furthest);
}

/**
 * The entry root a live question is answered against.
 *
 * The last entry this prefix admitted, because entries are serial and only that
 * one can still be asking. The scopes already selected are kept when they are
 * already inside it, so opening the drawer from a nested scope of the running
 * entry does not throw away the place somebody was reading.
 */
function askingEntry(model: ReplModel, scopes: readonly string[]): readonly string[] {
  const asking = model.entries[model.entries.length - 1];
  if (asking === undefined) {
    return scopes;
  }
  return scopes[0] === asking.key ? scopes : Object.freeze([asking.key]);
}

/**
 * The same route without the drawers only this process could mount.
 *
 * A waiting question and a pending request exist in this process and in no
 * history, so a location naming one is a location nobody — including this
 * machine, a moment later — can reopen. Printing the route a person left is only
 * useful if it is a route they can come back to, so the live-only members come
 * off on the way out. Nothing is settled to do it: the drawer is removed, not
 * answered, and what the file holds is untouched.
 */
export function withoutLiveDrawers(state: ReplState): ReplState {
  const remaining = state.route.drawers.filter(
    (drawer) => drawer.kind !== "live-elicit" && drawer.kind !== "live-permission",
  );
  if (remaining.length === state.route.drawers.length) {
    return state;
  }
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, drawers: Object.freeze(remaining) }),
  });
}

/**
 * The same state once the question its drawer was asking has gone.
 *
 * Teardown and a settlement elsewhere can both end a question while its drawer is
 * up. The drawer and what was typed into it go, and neither becomes an answer:
 * the form is discarded rather than submitted, because a person who was still
 * filling it in never offered it.
 */
export function elicitWithdrawn(state: ReplState): ReplState {
  const remaining = state.route.drawers.filter((drawer) => drawer.kind !== "live-elicit");
  if (remaining.length === state.route.drawers.length) {
    return state;
  }
  return Object.freeze({
    ...state,
    form: EMPTY_FORM,
    restore: undefined,
    route: Object.freeze({ ...state.route, drawers: Object.freeze(remaining) }),
  });
}

/** The same state with the Sessions reading back at its first row. */
function atFirstRow(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    viewports: Object.freeze({ ...state.viewports, sessions: 0 }),
  });
}

function settled(state: ReplState): ReplTransition {
  return { state: Object.freeze(state), intent: { kind: "none" } };
}

function refuse(state: ReplState, reason: string): ReplTransition {
  return { state: Object.freeze({ ...state, refusal: reason }), intent: { kind: "none" } };
}

/** The draft, and the canonical query that carries it. */
function drafting(state: ReplState, draft: string): ReplTransition {
  return settled({
    ...state,
    draft,
    // The draft is route state, so the location always says what would be
    // submitted. It is the one thing in the URL that is not yet durable.
    route: Object.freeze({ ...state.route, draft: draft.length === 0 ? undefined : draft }),
    refusal: undefined,
  });
}

/**
 * Adopt a candidate route, or keep the one that works.
 *
 * Resolved against the model first: a route that selects nothing is not a view
 * with empty regions, it is a navigation that did not happen.
 */
function navigate(
  state: ReplState,
  model: ReplModel,
  candidate: ReplRoute,
  live: ReplLive,
): ReplTransition {
  const route = Object.freeze({ ...candidate });
  // Against `state`, because what a candidate route may name depends on what
  // this screen has selected: a `+permission` drawer resolves only while the
  // selected request is still pending, so whoever selects one navigates from the
  // state that already holds its key.
  const resolved = resolveLocation(model, route, availabilityOf(state, live));
  if (!resolved.ok) {
    return refuse(state, resolved.error.message);
  }
  return settled({ ...state, route, refusal: undefined });
}

/** One text unit shorter, counted in scalar values rather than code units. */
function shortened(text: string): string {
  const units = [...text];
  units.pop();
  return units.join("");
}

/** How a value reads in one line of a list. */
function summarize(value: Json): string {
  const written = JSON.stringify(value) ?? "null";
  return written.length <= SUMMARY_WIDTH ? written : `${written.slice(0, SUMMARY_WIDTH - 1)}…`;
}

/** How much of a value one line of a list shows. */
const SUMMARY_WIDTH = 20;

/**
 * One long string as rows that fit, in order, losing nothing.
 *
 * Each row is padded to the full width. A renderer writes what changed, so a row
 * whose text got shorter would otherwise keep the tail of what used to be there —
 * and a location with somebody else's characters on the end of it is worse than
 * no location at all.
 */
function chunked(text: string, width: number): readonly string[] {
  if (width < 1) {
    // No surface to write on. A terminal too small to draw in draws a refusal
    // and nothing else, so this row is never placed — but it must still be a row.
    return [text];
  }
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += width) {
    parts.push(text.slice(at, at + width).padEnd(width, " "));
  }
  return parts.length === 0 ? ["".padEnd(width, " ")] : parts;
}

/**
 * A cell the layout can place, with the key its description was given and what
 * the row means.
 *
 * `style` travels with the row because this is where the facts that decide it
 * are: the record's kind, the entry's terminal status, whether the route is
 * pointing at this row. A later pass reading the finished string could only
 * guess, and guessing from text is how arbitrary document output comes to be
 * drawn as a failure because it happens to contain a word.
 */
interface Described {
  readonly key: string;
  readonly description: ReplDescription<ReplAction>;
  readonly style: ReplRowStyle;
  /**
   * The stretches this row's text is made of, where its characters mean
   * different things.
   *
   * Built here, with the text, from the same pieces — so the runs spell exactly
   * what the row draws. A row whose characters all mean one thing carries none.
   */
  readonly runs?: readonly ReplTokenRun[];
}

/**
 * One row's label as runs, padded to the room it has, the padding reading as the
 * row does.
 *
 * The same arithmetic `pad` does, in runs: a row is padded so that what it draws
 * is exactly as wide as the box it was measured in, and the cells it pads with
 * belong to the row rather than to whatever its last stretch happened to be.
 */
function padded(
  parts: readonly ReplTokenRun[],
  room: number,
  token: ReplPresentationRole,
): readonly ReplTokenRun[] {
  const text = runText(parts);
  if (room < 1 || text.length >= room) {
    return parts;
  }
  return tokenRuns([...parts, { text: "".padEnd(room - text.length, " "), token }]);
}

function row(
  key: string,
  label: string,
  select: { readonly [name: string]: Json },
  style: ReplRowStyle,
  options: {
    readonly focus?: true;
    readonly here?: string | undefined;
    /** The key this frame restores focus to, for the row that turns out to be it. */
    readonly claim?: string | undefined;
    /** What this row's label is made of, where it is made of more than one thing. */
    readonly runs?: readonly ReplTokenRun[];
  } = {},
): Described {
  const claims = options.focus === true || options.claim === key;
  // The marker is its own stretch, which is how a focused row keeps every
  // foreground it had and still says where the next keystroke lands.
  const here = options.here === key;
  const runs = tokenRuns([
    { text: focusPrefixed("", here), token: here ? "focus-marker" : style.role },
    ...(options.runs ?? [{ text: label, token: style.role }]),
  ]);
  return {
    key,
    style,
    runs,
    description: describeNode<ReplAction>({
      key,
      component: SELECT_ROW,
      input: { label, ...select, ...(options.here === key ? { focused: true } : {}) },
      ...(claims ? { focus: true } : {}),
    }),
  };
}

/**
 * Which control this frame claims focus for, because a drawer went.
 *
 * Resolved against what is mounted rather than stored: a claim naming a row this
 * view does not draw would be focus asked for on behalf of nothing, and the
 * commit that honoured it would throw. So the claim is silent for as long as the
 * row it names is not there — the answer's record has not been projected yet —
 * and the hint waits rather than being spent on nothing.
 */
export function focusClaim(view: ReplView): string | undefined {
  const { state, selection, live } = view;
  if (state.restore === undefined) {
    return undefined;
  }
  if (state.restore.kind === "asked") {
    return live.question === undefined || state.route.at !== undefined ? undefined : "footer:asked";
  }
  if (state.restore.kind === "turn") {
    const turn = state.restore.turn;
    return chronology(view.model, live).some((candidate) => candidate.key === turn)
      ? `sessions:turn:${turn}`
      : undefined;
  }
  // The record this answer caused: one the history did not hold when the answer
  // was taken, holding exactly what was sent. Not the newest record — by the time
  // a frame can draw this row, another invocation may have settled after it.
  const known = new Set(state.restore.known);
  const answer = state.restore.answer;
  const caused = (selection.scope?.elicitations ?? []).find(
    (one) => !known.has(one.marker) && sameJson(one.answer, answer),
  );
  if (caused === undefined) {
    return undefined;
  }
  // A narrow frame has no inspection region, so the record's own row is not one
  // this screen offers. Focus goes to the entry that owns the record instead:
  // the control the reader can see, in the one outlet a narrow frame draws. The
  // claim stays silent while that outlet is showing the other surface, exactly as
  // it does for any row this view does not draw.
  if (profileFor(view.size) === "narrow") {
    const owner = selection.entry?.key;
    return owner === undefined ? undefined : `entry:${owner}`;
  }
  return `elicit:${caused.marker}`;
}

/**
 * The state after a commit settled focus.
 *
 * A restoration claim is one claim, not a standing one. It survives the frames
 * between the answer and its record — nothing can be focused that is not there
 * yet — and is spent by the commit that puts focus where it asked. Focus
 * traversal is not an action, so a claim nobody retired would pull somebody back
 * after every Tab and traversal would never move.
 */
export function focusSettled(
  view: ReplView,
  focused: string | undefined,
  /**
   * What the frame that satisfied the claim admitted.
   *
   * Needed because a claim can *move* a window to show the row it names, and
   * the move was computed from the claim: spending the claim without keeping
   * the move would scroll the catalog straight back and take the row focus has
   * just landed on off the screen. A caller with no committed frame to hand —
   * one asking only whether a claim is spent — leaves it out.
   */
  admission?: ReplAdmission,
): ReplState {
  const claim = focusClaim(view);
  if (view.state.restore === undefined || claim === undefined || focused !== claim) {
    return view.state;
  }
  // The reveal this frame presented, retained before the claim that caused it is
  // spent. Only a claim on a catalog row can have moved that window, and only
  // the window's own admitted start is kept — the offset this process holds
  // becomes the one a person is actually looking at, so the next frame asks the
  // same question and gets the same answer without a claim to ask it for.
  const revealed = claim.startsWith("entry:")
    ? admission?.windows.get(ENTRIES_WINDOW)?.from
    : undefined;
  const viewports =
    revealed === undefined || revealed === view.state.viewports.entries
      ? view.state.viewports
      : Object.freeze({ ...view.state.viewports, entries: revealed });
  return Object.freeze({ ...view.state, restore: undefined, viewports });
}

/** Every answer this history already holds, wherever in its entries it holds it. */
function retainedAnswers(model: ReplModel): readonly string[] {
  const markers: string[] = [];
  const walk = (scope: ReplScope): void => {
    for (const elicitation of scope.elicitations) {
      markers.push(elicitation.marker);
    }
    for (const child of scope.scopes) {
      walk(child);
    }
  };
  for (const entry of model.entries) {
    walk(entry.scope);
  }
  return Object.freeze(markers);
}

/** Whether two Json values are the same value, whatever order they were written in. */
function sameJson(left: Json, right: Json): boolean {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((member, index) => sameJson(member, right[index] ?? null));
  }
  const names = Object.keys(left);
  if (names.length !== Object.keys(right).length) {
    return false;
  }
  return names.every((name) => {
    const mine = left[name];
    const theirs = right[name];
    return mine !== undefined && theirs !== undefined && sameJson(mine, theirs);
  });
}

/**
 * Two columns saying whether this row is the one being read.
 *
 * Its own channel, beside the focus marker rather than sharing it: focus is where
 * the next keystroke goes and selection is what the screen is showing, and a
 * reader who has tabbed away from the entry they are reading still needs to know
 * which one that is. Driven by the resolved route, so it survives focus moving,
 * a background repaint and a resize.
 */
function selected(on: boolean): string {
  return on ? "* " : "  ";
}

function line(
  key: string,
  label: string,
  style: ReplRowStyle,
  runs?: readonly ReplTokenRun[],
): Described {
  return {
    key,
    style,
    ...(runs === undefined ? {} : { runs }),
    description: describeNode<ReplAction>({ key, component: LINE, input: { label } }),
  };
}

/**
 * What the execution is doing, and what that means for submitting.
 *
 * One value, because the sentence a person reads and the decision about whether
 * a standing refusal still applies are the same judgement. Two functions each
 * deciding it separately is how a screen comes to say "Ready for Entry 2" above
 * a refusal explaining that Entry 1 has not finished.
 */
export type ReplReadiness =
  /** Frozen at an earlier position: nothing here submits, whatever the head does. */
  | { readonly kind: "history" }
  /** No entry and nothing running. */
  | { readonly kind: "first" }
  | { readonly kind: "running"; readonly order: number }
  | { readonly kind: "answer"; readonly order: number }
  | { readonly kind: "permission"; readonly order: number }
  /** Admitted, no outcome, and nothing running it. Nothing may follow. */
  | { readonly kind: "unfinished"; readonly order: number }
  /** The close is recorded and the task that produced it is still unwinding. */
  | { readonly kind: "settling"; readonly order: number }
  | { readonly kind: "ready"; readonly next: number };

/**
 * Read it from both halves: the file, and this process.
 *
 * Derived on the way to a frame and nothing more. It is in no location and no
 * record — a screen that explained itself differently would still be the same
 * execution.
 */
export function readinessOf(view: ReplView): ReplReadiness {
  const { state, model, live } = view;
  if (state.route.at !== undefined) {
    // A frozen position first, before any live fact is read. What the head is
    // doing is not a fact about the prefix being inspected, and a reading that
    // borrowed it would describe an execution this view is not of.
    return { kind: "history" };
  }
  const entries = model.entries;
  const last = entries[entries.length - 1];
  if (last === undefined) {
    return { kind: "first" };
  }
  const order = last.order;
  if (!model.settled) {
    if (live.question !== undefined) {
      return { kind: "answer", order };
    }
    if (live.agent.requests.length > 0) {
      return { kind: "permission", order };
    }
    // Admitted, no outcome, nothing running it: whatever was doing the work is
    // gone and the file still says the entry never finished. The Journal decides
    // that, so no successor can start however idle this looks.
    return live.running ? { kind: "running", order } : { kind: "unfinished", order };
  }
  // The outcome is recorded. Whether anything may follow it is still the live
  // half's to answer: the close is appended while the task that produced it is
  // unwinding, and a submission taken in that window has nowhere to go.
  return live.running ? { kind: "settling", order } : { kind: "ready", next: order + 1 };
}

/** Whether this readiness is one a submission would be admitted into. */
export function admitsSubmission(readiness: ReplReadiness): boolean {
  return readiness.kind === "first" || readiness.kind === "ready";
}

/**
 * The state, as one phrase.
 *
 * First in the row, and before any key guidance, because the row is as wide as
 * the terminal and the terminal decides where it stops: a sentence truncated
 * after "Entry 1 running" still told somebody the thing they could not have
 * worked out, while one truncated after "Tab/Shift+Tab move" told them what the
 * keys do and left them pressing Enter at an entry that cannot accept it.
 */
function statePhrase(readiness: ReplReadiness, narrow: boolean): string {
  switch (readiness.kind) {
    case "history":
      return "History";
    case "first":
      return "Ready for Entry 1";
    case "running":
      return `Entry ${readiness.order} running`;
    case "answer":
      // `question` rather than `waiting for an answer` where the row is 72
      // columns: thirteen columns back, which is the difference between the
      // movement hint being on the screen and being off it.
      return narrow
        ? `Entry ${readiness.order} question`
        : `Entry ${readiness.order} waiting for an answer`;
    case "permission":
      return narrow
        ? `Entry ${readiness.order} permission`
        : `Entry ${readiness.order} waiting for permission`;
    case "unfinished":
      return `Entry ${readiness.order} unfinished`;
    case "settling":
      return `Entry ${readiness.order} settling`;
    case "ready":
      return `Ready for Entry ${readiness.next}`;
  }
}

/**
 * What that state means for the keys, when it means anything.
 *
 * Only the facts a person acts on. A state whose keys work the ordinary way adds
 * nothing here, because a row explaining every state at every moment is one
 * nobody reads.
 */
function stateAdvice(readiness: ReplReadiness, narrow: boolean): string | undefined {
  switch (readiness.kind) {
    case "history":
      // Named without its brackets: a bracketed label in prose reads as a
      // control, and a person — or a pointer looking for one — would try to
      // activate a sentence.
      return narrow
        ? "Enter unavailable · activate live"
        : "Enter unavailable · activate live to return to the head";
    case "first":
    case "ready":
      return undefined;
    case "running":
      return narrow ? "Enter unavailable" : "Enter unavailable until it finishes";
    case "answer":
      return "activate answer";
    case "permission":
      // Named, not routed to. The request belongs to Sessions and the control
      // that answers it is there; saying so is not the same as going.
      return "open Sessions";
    case "unfinished":
      return narrow ? "no successor" : "no successor can start";
    case "settling":
      return narrow ? "Enter unavailable" : "Enter unavailable until teardown finishes";
  }
}

/**
 * The state as a drawer says it.
 *
 * A drawer is already the thing that is waiting, so the sentence above it does
 * not have to describe the waiting — it has to name which entry, and leave the
 * row enough columns for the keys. `Entry 1 question` instead of `Entry 1
 * waiting for an answer` is thirteen columns back, which is the difference
 * between `Esc closes` being on a 72-column screen and being off it.
 */
function drawerState(view: ReplView, readiness: ReplReadiness): string {
  const open = view.selection.drawers[view.selection.drawers.length - 1];
  const order = "order" in readiness ? readiness.order : undefined;
  if (order !== undefined && open?.kind === "live-elicit") {
    return `Entry ${order} question`;
  }
  if (order !== undefined && open?.kind === "live-permission") {
    return `Entry ${order} permission`;
  }
  // The compact spelling at every size, because a drawer is already the thing
  // that is waiting: what the row still has to name is which entry.
  return statePhrase(readiness, true);
}

/**
 * What Enter does on the node that actually holds focus.
 *
 * Classified by the focused node first, and by the drawer it sits in only after
 * every node it could be has been ruled out. The order is the whole point: a
 * permission drawer reparents the footer's own way out and way to History into
 * itself, so asking the *drawer* what Enter does would tell somebody standing on
 * `[exit]` that Enter decides a permission — and the next thing they do is press
 * it. A drawer's ring is not all one kind of control, so neither is this answer.
 */
function primaryAction(view: ReplView, narrow: boolean): string {
  const focused = view.focused;
  if (focused === "footer:history") {
    // Shortened where the row is 72 columns and not otherwise. The control under
    // the cursor is labelled `[history]`, so the narrow form is not vague — it is
    // the one word the label already supplies, given back to the keys.
    return narrow ? "Enter opens" : "Enter opens History";
  }
  if (focused === "footer:exit") {
    return "Enter exits";
  }
  if (focused === "drawer:close") {
    return "Enter closes";
  }
  if (focused !== undefined && focused.startsWith("drawer:permission:choice:")) {
    // An option the provider offered. Taking it settles the request, and only a
    // control that is one of those may say so.
    return "Enter decides";
  }
  if (focused !== undefined && focused.startsWith("drawer:scroll:")) {
    // It moves the window over a message too long to draw at once. Saying this
    // answers the question would promise an answer to somebody reading it.
    return "Enter scrolls";
  }
  if (focused !== undefined && focused.startsWith("drawer:choice:")) {
    // One offered value. Taking it fills the field rather than answering the
    // question, which still needs submitting.
    return "Enter chooses";
  }
  if (
    focused === "drawer:form:submit" ||
    (focused !== undefined &&
      (focused.startsWith("drawer:field:") || focused.startsWith("drawer:value:")))
  ) {
    // The field the answer is typed into, the row that names it, and the control
    // that sends it: all three are how this question gets answered.
    return "Enter answers";
  }
  // Nothing more specific is known about this node, so this says only what is
  // true of every control. Pointer equivalence is worth saying where there is
  // room for it, and the narrow row has other things to spend those columns on.
  return narrow ? "Enter activates" : "Enter or click activates";
}

/** What joins the parts of the guidance row. */
const GUIDANCE_SEPARATOR = " · ";

/** One part of the guidance row, and whether the row may be drawn without it. */
interface GuidancePart {
  readonly text: string;
  /** A part the row must carry: it is dropped only if nothing else can go. */
  readonly required?: true;
}

/**
 * One row, assembled so that what it must say is what survives.
 *
 * The parts are given in the order they are read, and an optional one is kept
 * only while the row still fits with every required part that follows it. So a
 * row that cannot hold everything loses its least important fact by decision
 * here, in its proper place, rather than its last characters by accident in the
 * renderer — which would cut `Esc closes` in half and leave nothing to say it
 * had been there.
 *
 * It takes a width rather than a size class because the arithmetic has to be
 * total: the parts hold an entry number, so a composition that fits for `Entry 1`
 * is a column longer for `Entry 10`, and this has to keep its promise for an
 * execution of any length.
 */
function fitted(width: number, parts: readonly GuidancePart[]): string {
  const kept: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.required === true) {
      kept.push(part.text);
      continue;
    }
    const after = parts
      .slice(index + 1)
      .filter((one) => one.required === true)
      .map((one) => one.text);
    const candidate = [...kept, part.text, ...after].join(GUIDANCE_SEPARATOR);
    if (candidate.length <= width) {
      kept.push(part.text);
    }
  }
  const said = kept.join(GUIDANCE_SEPARATOR);
  // A floor, not a policy. Choosing the vocabulary by room is what keeps the
  // required parts whole, and the supported sizes never come here. What this
  // refuses is the one outcome that is worse than a shortened sentence: a row
  // longer than its own width, which this engine does not clip but writes over
  // the row beneath.
  return said.length <= width ? said : fitLine([{ text: said, elide: true }], width);
}

/** What the row cannot be drawn without, at the length it would be drawn at. */
function requiredLength(parts: readonly GuidancePart[]): number {
  return parts
    .filter((part) => part.required === true)
    .map((part) => part.text)
    .join(GUIDANCE_SEPARATOR).length;
}

/**
 * The one guidance row, composed for the width it will be drawn at.
 *
 * Composed rather than written long and left to the renderer, because a row the
 * renderer cuts is a row whose last fact is missing with nothing to say that it
 * is missing. At `72x20` every required part is chosen to fit together; the wider
 * frames say the same things in full.
 *
 * What never moves is the order: the state, then what focus actually does, then
 * the way out, then movement.
 */
function guidance(view: ReplView, room: number): string {
  const width = Math.max(1, room);
  const readiness = readinessOf(view);
  // Which vocabulary this row speaks is decided by the room it was measured
  // for, not by the size of the terminal it is somewhere inside. The medium
  // profile is wide enough for the long phrases and its transcript column is
  // not: this row's three required parts come to seventy-one columns in a
  // sixty-three column pane, and the parts that do not fit are not dropped —
  // they are required — so the sentence ran onto the row below.
  //
  // A narrow frame keeps saying what it says today: it is already compact, and
  // a profile that has chosen the short phrases does not un-choose them because
  // its one column happens to be wide.
  const narrow = view.size.columns <= NARROW.columns;
  const full = guidanceParts(view, readiness, narrow);
  const parts = requiredLength(full) <= width ? full : guidanceParts(view, readiness, true);
  return fitted(width, parts);
}

/**
 * The parts of the guidance row, in the order they are read.
 *
 * `compact` chooses the shorter of the two vocabularies this row already has.
 * It is a question about room rather than about the terminal: the same screen
 * can want the long phrases in one region and the short ones in another.
 *
 * What never moves is the order: the state, then what focus actually does, then
 * the way out, then movement.
 */
function guidanceParts(
  view: ReplView,
  readiness: ReplReadiness,
  compact: boolean,
): readonly GuidancePart[] {
  const focused = view.focused;
  const modal = view.selection.drawers.length > 0;
  const editing = focused === undefined || focused === "footer:input";
  const narrow = view.size.columns <= NARROW.columns;
  const move: GuidancePart = { text: "Tab/Shift+Tab move" };
  if (modal) {
    // A drawer holds focus, so `Esc closes` is required and movement is not: Tab
    // is discoverable by pressing it, and being shut inside a modal whose way out
    // was cut from the row is not. The state stays, because a question does not
    // stop an entry from running and a reader still needs to know that it is.
    return [
      { text: drawerState(view, readiness), required: true },
      { text: primaryAction(view, compact), required: true },
      { text: "Esc closes", required: true },
      move,
    ];
  }
  const state: GuidancePart = { text: statePhrase(readiness, compact), required: true };
  if (!editing) {
    // No word here about submitting. Enter activates the control that has focus,
    // so a row explaining why Enter cannot submit would describe a key this node
    // does not use that way. The way back to the draft is required — it is the
    // one thing this screen used to say nothing about at all.
    return [
      state,
      { text: primaryAction(view, compact), required: true },
      move,
      { text: compact ? "Tab to draft" : "Tab to the draft to type", required: true },
    ];
  }
  const advice = stateAdvice(readiness, compact);
  const said: GuidancePart[] =
    advice === undefined ? [state] : [state, { text: advice, required: true }];
  if (readiness.kind === "history") {
    // The draft survives a frozen position and stays editable, but the fact a
    // person needs here is the way back to the head rather than that typing
    // works. The draft row below is visibly holding their text either way.
    return [...said, move];
  }
  // Focus is in the draft. Only here is Enter a submission, and only when the
  // readiness would take one — a row promising it in any other state is the one
  // thing this slice exists to stop saying.
  const enter: GuidancePart[] = admitsSubmission(readiness)
    ? [{ text: "Enter submits", required: true }]
    : [];
  return [...said, ...enter, { text: "Type here" }, move];
}

/**
 * A row of a drawer, padded so the drawer covers what it is in front of.
 *
 * A renderer writes what changed, so a row that only writes its own text leaves
 * whatever was underneath it visible from where its text ends — and a modal you
 * can read the transcript through is not a modal.
 */
function drawerLine(
  key: string,
  label: string,
  width: number,
  style: ReplRowStyle,
  /** What the label is made of, where it is made of more than one thing. */
  runs?: readonly ReplTokenRun[],
): Described {
  const text = width < 1 ? label : label.padEnd(width, " ");
  if (runs === undefined) {
    return line(key, text, style);
  }
  return line(key, text, style, padded(runs, text.length, style.role));
}

function field(
  key: string,
  prompt: string,
  text: string,
  purpose: "draft" | "answer",
  style: ReplRowStyle,
  options: {
    readonly focus?: true;
    readonly here?: string | undefined;
    /** The form field this line edits, for a line that edits one. */
    readonly field?: string;
    /** What the value on this line is, for a line showing something classified. */
    readonly classify?: (value: string) => readonly ReplTokenRun[];
  } = {},
): Described {
  const here = options.here === key;
  const parts = fieldParts(prompt, text, here);
  const runs = tokenRuns([
    { text: parts.marker, token: here ? "focus-marker" : style.role },
    { text: parts.prompt, token: style.role },
    { text: parts.earlier, token: style.role },
    ...(options.classify === undefined
      ? [{ text: parts.value, token: style.role }]
      : options.classify(parts.value)),
  ]);
  return {
    key,
    style,
    runs,
    description: describeNode<ReplAction>({
      key,
      component: FIELD,
      input: {
        prompt,
        text,
        purpose,
        ...(options.field === undefined ? {} : { field: options.field }),
        ...(options.here === key ? { focused: true } : {}),
      },
      ...(options.focus === undefined ? {} : { focus: options.focus }),
    }),
  };
}

/**
 * Describe the whole screen, for one measured frame.
 *
 * One flat set with keyed children for the drawer, because placement is not
 * nesting: where a row appears is the layout's decision, and the only nesting
 * that matters to the tree is what a modal must contain.
 *
 * The descriptions and the constraints that place them come from `presentationFor`
 * in one walk. This is the same walk asked only for the tree, which is what a
 * caller reconciling without drawing wants.
 */
export function describeApplication(
  view: ReplView,
  context: ReplPresentationContext,
): readonly ReplDescription<ReplAction>[] {
  return presentationFor(view, context).descriptions;
}

/**
 * One reading's rows, and what every one of them means.
 *
 * `rows` is every `Described` this screen built, nested drawer content included,
 * so the style a row was given is available wherever that row's box is made.
 * `items` is the top-level set, in order, which is what the tree reconciles.
 */
interface DescribedScreen {
  readonly items: readonly Described[];
  readonly rows: readonly Described[];
}

function described(view: ReplView, context: ReplPresentationContext): DescribedScreen {
  if (view.refusal !== undefined) {
    // A reason as long as its sentence, over rows that fit: a refusal is the only
    // thing on this screen, and one clipped to a single row is a refusal that has
    // not been given.
    const [first, ...rest] = chunked(view.refusal, context.widths?.surface ?? 0);
    // Where somewhere to go exists, the refusal itself is focusable and takes the
    // claim; otherwise focus starts on the way out. Declared, so the claim is a
    // typed member rather than a literal that has to be asserted into one.
    const claiming: { readonly focus?: true } =
      view.state.route.at === undefined ? {} : { focus: true };
    const items: Described[] = [
      {
        key: "refusal",
        style: styleOf("failed-outcome"),
        description: describeNode<ReplAction>({
          key: "refusal",
          component: REFUSAL,
          input: {
            label: first,
            // Somewhere to go only when there is somewhere: a cold open of a
            // history that cannot be read has no earlier view to return to.
            ...(view.state.route.at === undefined ? {} : { back: "live" }),
          },
          ...claiming,
        }),
      },
    ];
    for (const [offset, part] of rest.entries()) {
      items.push(line(`refusal:${offset}`, part, styleOf("failed-outcome")));
    }
    // And the way out, because this screen offers nothing else to do — at every
    // size this REPL draws at. A valid session that could only be left by a key
    // nobody documented would be one a person has to guess their way out of.
    //
    // Below the minimum there is no frame to place it in: that screen draws its
    // refusal and nothing else, so a control described there would be a focus
    // stop drawing nothing and a target behind nothing. It teaches Escape in the
    // sentence instead, which is the one thing it can offer.
    if (profileFor(view.size) !== "too-small") {
      items.push(
        row(
          "footer:exit",
          "[exit]",
          { select: "exit" },
          styleOf("action"),
          view.state.route.at === undefined
            ? { focus: true, here: view.focused }
            : { here: view.focused },
        ),
      );
    }
    return { items, rows: items };
  }

  const items: Described[] = [];
  const { model, selection, live, state } = view;
  const claim = focusClaim(view);
  // Narrow gives the whole screen to one routed surface, so the other one is not
  // described at all — not drawn small, not clipped, not placed in a region the
  // frame does not have. A node nothing can show is a focus stop that draws
  // nothing and a pointer target behind nothing.
  const narrow = profileFor(view.size) === "narrow";
  const routed = state.route.surface;
  const showSessions = !narrow || routed === "sessions";
  const showEntry = !narrow || routed === "repl";

  const turns = chronology(model, live);
  // Which surface to be on belongs to neither surface. A narrow frame mounts one
  // outlet, so a control that lives inside the outlet can only take somebody
  // where they already are — and the way back would be mounted on the screen
  // they cannot reach. Both controls are described at every size; the route
  // decides which outlet's rows follow them, never whether they exist.
  const inspected = state.route.at !== undefined;
  const toSessions = row(
    "sessions:heading",
    `${selected(routed === "sessions")}Sessions`,
    { select: "surface", surface: "sessions" },
    styleOf("pane-heading", { selected: routed === "sessions" }),
    { here: view.focused },
  );
  const toEntries = row(
    "entries:heading",
    `${selected(routed === "repl")}Entries`,
    { select: "surface", surface: "repl" },
    styleOf("pane-heading", { selected: routed === "repl" }),
    { here: view.focused },
  );
  items.push(toSessions);
  // In a narrow frame the two are one navigation bar above the routed outlet. In
  // a sidebar each heading stays with the list it names, which is where a reader
  // looks for it.
  if (narrow) {
    items.push(toEntries);
  }
  if (!showSessions) {
    // Nothing: this frame is showing the other surface.
  } else if (turns.length === 0) {
    // Present and empty. This REPL keeps one execution per invocation, and a
    // Sessions surface that vanished when it held nothing would read as a
    // feature that does not exist.
    items.push(line("sessions:empty", "  (none retained)", styleOf("metadata")));
  } else {
    // One window over the whole reading. Every conversation, turn, fact, audit
    // and request is built in order and then windowed: a list that described all
    // of them would have its tail placed nowhere, and a row layout cannot place
    // is not one a person can see, focus or point at.
    //
    // The window is what the frame measured, not what this boundary could work
    // out from the region's height — the rows above and below it are described
    // here, so only the engine knows what is left for the rows inside.
    const content = sessionRows(state, turns, view.focused, claim, context.widths?.list);
    // Outside the thing they move, like the drawer's: a control inside the
    // window would scroll away from whoever was reaching for it.
    items.push(
      row(
        "sessions:earlier",
        "  [^ earlier]",
        { select: "scroll-sessions", delta: -1 },
        styleOf("action"),
        {
          here: view.focused,
        },
      ),
    );
    items.push(...shown(content, context, SESSIONS_WINDOW));
    items.push(
      row(
        "sessions:later",
        "  [v later]",
        { select: "scroll-sessions", delta: 1 },
        styleOf("action"),
        {
          here: view.focused,
        },
      ),
    );
  }
  if (!narrow) {
    items.push(toEntries);
  }
  if (showEntry) {
    // One window over the whole catalog, for the same reason the Sessions
    // reading has one: a list that described every entry and every nested scope
    // beneath them would have its tail placed nowhere, and a row layout cannot
    // place is not one a person can see, focus or point at. The controls sit
    // outside the thing they move, and exist only where there is more catalog
    // than this frame can hold.
    const catalog = entryContent(
      model,
      view.focused,
      selection.entry?.key,
      context.widths?.list,
      claim,
    );
    if (context.entriesWindowed) {
      items.push(
        row(
          "entries:earlier",
          "  [^ earlier]",
          { select: "scroll-entries", delta: -1 },
          styleOf("action"),
          { here: view.focused },
        ),
      );
    }
    items.push(...shown(catalog, context, ENTRIES_WINDOW));
    if (context.entriesWindowed) {
      items.push(
        row(
          "entries:later",
          "  [v later]",
          { select: "scroll-entries", delta: 1 },
          styleOf("action"),
          { here: view.focused },
        ),
      );
    }
  }

  // What each shared column is, said once at the top of it. A pane that named
  // itself only when it held something would be a pane a reader has to recognize
  // by what happens to be in it, and an empty one would read as a gap. They are
  // read rather than activated: nothing here is a control, and the frame places
  // them only where there is a pane to put them in.
  // Not in a narrow frame: it routes one outlet and has neither column, so a
  // title described there would be a mounted node with no box to draw it in.
  // The two surface controls are that frame's own headings.
  if (!narrow) {
    items.push(line("transcript:heading", "Transcript", styleOf("pane-heading")));
    items.push(line("inspection:heading", "Bindings", styleOf("pane-heading")));
  }

  // The transcript of whatever is selected. Selecting an entry *is* selecting a
  // transcript locus, so the rows are that entry's own — not every entry's
  // concatenated, which would make the catalog a list of things that all show
  // the same reading. With nothing selected the whole execution is the locus,
  // which is what a one-entry execution has always shown.
  const inspectable = showEntry;
  // Not until a width has been measured. A transcript row is bounded to the
  // region it lands in, and an unbounded one makes that region wider than its
  // share — which would corrupt the very measurement that is about to answer
  // how wide it is.
  const surface = context.widths?.surface;
  for (const [index, transcript] of inspectable && surface !== undefined
    ? transcriptOf(model, selection).entries()
    : []) {
    // One cell is one row, so a recorded row that holds several lines of output
    // becomes several cells. A cell given more than one line would show only the
    // first, which is the whole of what a reader would then believe was there.
    for (const [offset, part] of transcriptLines(transcript, surface ?? 0).entries()) {
      items.push(line(`line:${index}:${offset}`, part.text, part.style));
    }
  }
  // The live overlay, explicitly below the recorded rows and explicitly labelled.
  // Once the durable close exists its recorded output is in the transcript and
  // this is empty, so the two never both claim to be the output.
  //
  // It belongs to the entry producing it, which is the last one this prefix
  // admitted — nothing earlier can still be running. A reader who has selected
  // an earlier entry is reading a settled transcript, and text from a run that
  // is not the one they are looking at would be attributed to it.
  if (inspectable && live.output.length > 0 && livesHere(model, selection)) {
    for (const [offset, text] of live.output.split("\n").entries()) {
      items.push(line(`line:live:${offset}`, `… ${text}`, styleOf("output")));
    }
  }

  // The inspection controls, and only where there is an inspection region to put
  // them in. A narrow frame has one routed outlet, so a binding row or a recorded
  // answer row described there would be mounted, focusable and placed nowhere — a
  // Tab stop that draws no cell and a pointer target behind nothing. What is
  // selected and which route is showing are unchanged: this is what the frame
  // offers, not what the reader has chosen.
  const scope = inspectable && !narrow ? selection.scope : undefined;
  if (scope !== undefined) {
    for (const binding of scope.bindings) {
      items.push(
        row(
          `binding:${binding.name}`,
          fitControl(
            [{ text: `${binding.name} = ` }, { text: summarize(binding.value), elide: true }],
            context.widths?.inspection,
          ),
          {
            select: "binding",
            name: binding.name,
          },
          // A binding row is a name and the value bound to it, so it reads as the
          // value: the whole reason the column is there is to say what the run
          // produced.
          styleOf("field-value", { inspected }),
          { here: view.focused },
        ),
      );
    }
    for (const elicitation of scope.elicitations) {
      items.push(
        row(
          `elicit:${elicitation.marker}`,
          fitControl(
            [{ text: "answered " }, { text: elicitation.location, elide: true }],
            context.widths?.inspection,
          ),
          {
            select: "recorded-elicit",
            marker: elicitation.marker,
          },
          // Where the answer was given, not the answer itself: the value is in the
          // drawer this row opens.
          styleOf("field-hint", { inspected }),
          { here: view.focused, claim },
        ),
      );
    }
  }

  // The way into history. The band above shows where the positions are; choosing
  // an exact one is a drawer, because a position is something you select and the
  // band is something you read.
  // The one way into history, and one node. While a drawer is mounted it is
  // reparented into the modal branch below rather than drawn again beside it:
  // two nodes with one key would be two controls claiming one name, and leaving
  // it out here would put it outside the active focus root where nothing could
  // reach it.
  const history = row(
    "footer:history",
    "[history]",
    { select: "history" },
    styleOf("action", { inspected }),
    {
      here: view.focused,
    },
  );
  // The way out, on every screen and in every state. Like `[history]` it is one
  // node: while a drawer is mounted it is reparented into the modal branch, so it
  // stays reachable without reaching past the focus trap, and layout still draws
  // it in the footer where it always is.
  const exit = row("footer:exit", "[exit]", { select: "exit" }, styleOf("action"), {
    here: view.focused,
  });
  // Whether the action row holds one control at all. A control the measured row
  // cannot hold whole is not described, so it mounts nothing: describing it and
  // leaving it out of the frame would be a focus stop that draws nothing and a
  // target behind nothing. The measuring pass offers every candidate, because
  // what each one costs is the question that pass is asking.
  const offering = (key: string): boolean =>
    context.measuring || context.admission.actions.has(key);
  // Not below the minimum size: that frame places no cell at all, so a control
  // described there is a focus stop that draws nothing and a target behind
  // nothing. The screen says Escape leaves instead, which is the one way out a
  // window too small to draw in can offer.
  const drawable = profileFor(view.size) !== "too-small";
  const modal = view.selection.drawers.length > 0;
  if (!modal) {
    if (offering("footer:history")) {
      items.push(history);
    }
    if (drawable && offering("footer:exit")) {
      items.push(exit);
    }
  }
  if (state.route.at !== undefined && offering("footer:live")) {
    items.push(
      row("footer:live", "[live]", { select: "live" }, styleOf("action"), { here: view.focused }),
    );
  }
  if (live.pausable) {
    if (offering("footer:pause")) {
      items.push(
        // The control is what it does; the state is what expansion is doing. One
        // label that changed between them would rename a control out from under
        // whoever was reaching for it.
        row(
          "footer:pause",
          live.expansion === "playing" ? "[pause]" : `[pause] ${live.expansion}`,
          { select: "pause" },
          styleOf("action"),
          { here: view.focused },
        ),
      );
    }
    // Continue releases a continuation, so it exists exactly while one is
    // held. Expansion that is *pausing* holds nothing yet — the walks it asked
    // to stop have not all stopped — and a Continue offered there would cancel
    // the pause somebody just asked for rather than resume anything.
    if (live.expansion === "paused" && offering("footer:continue")) {
      items.push(
        row("footer:continue", "[continue]", { select: "continue" }, styleOf("action"), {
          here: view.focused,
        }),
      );
    }
  }
  if (live.question !== undefined && state.route.at === undefined && offering("footer:asked")) {
    items.push(
      row(
        "footer:asked",
        // One fixed spelling, not a headline. A question's message is as long as
        // its author made it, and the action row is as wide as the terminal: a
        // control whose width came from the message is one the narrowest
        // supported frame drops, and a control that has been dropped is a waiting
        // question nobody can reach. The whole message is in the drawer this
        // opens, which is where there is room for it.
        "[answer]",
        { select: "live-elicit" },
        // What it announces is a question nobody has answered yet, which is why
        // it reads as waiting rather than as one more way out of the screen.
        styleOf("waiting"),
        { here: view.focused, claim },
      ),
    );
  }

  // Bounded to the surface it lands in, like every other row above it. The
  // sentence is as long as the state it describes, and the medium profile's
  // transcript column is narrower than the longest of them — a row wider than
  // its column is one the column beside it loses space to.
  if (surface !== undefined) {
    items.push(line("guidance", guidance(view, surface), styleOf("status", { inspected })));
  }

  // Why the last thing asked for changed nothing. Shown rather than swallowed: a
  // refusal nobody can read is a keystroke that appeared to do nothing.
  if (state.refusal !== undefined && offering("footer:refused")) {
    // One line: the footer is seven rows and the controls live in them, so a
    // refusal that wrapped would push the draft off the screen it is about.
    //
    // Cut to whatever the measured row had left, with an ellipsis, so a reader
    // can tell a shortened reason from a complete one. The controls come first:
    // a row too narrow for both keeps the way out and loses the sentence.
    const said = `! ${state.refusal.split("\n").join(" ")}`;
    const room =
      context.admission.shortened?.key === "footer:refused"
        ? context.admission.shortened.width
        : undefined;
    items.push(
      line(
        "footer:refused",
        room === undefined || said.length <= room
          ? said
          : `${said.slice(0, Math.max(1, room - 1))}…`,
        styleOf("failed-outcome"),
      ),
    );
  }

  // The draft, which is where typing goes. Always the next entry's text: an
  // admitted entry is immutable, so there is never one these keystrokes could
  // be editing, and a person may go on typing while an entry runs and while a
  // history position is being read.
  //
  // It claims focus only while nothing holds it. A claim is where focus *starts*,
  // not an assertion repeated every frame: the tree re-reads the claim at each
  // commit, and this screen commits on every frame, so a standing claim would
  // drag focus back here after every Tab and traversal would never move at all.
  // A restoration claim is somebody else's: exactly one description may claim
  // focus, and a drawer that just went says which one it is.
  const claiming =
    state.route.drawers.length === 0 && view.focused === undefined && claim === undefined;
  items.push(
    field(
      "footer:input",
      // Named, because the row below a reading has to say that it is where typing
      // goes rather than one more line of that reading. The marker in front of it
      // is still the focus cue `fieldText` writes, so this row reads `>> Draft: `
      // while it holds focus and ` > Draft: ` while it does not.
      "> Draft: ",
      state.draft,
      "draft",
      styleOf("draft"),
      claiming
        ? { focus: true, here: view.focused, classify: sourceRuns }
        : { here: view.focused, classify: sourceRuns },
    ),
  );

  const drawer = drawerFor(view, context, history, exit, drawable);
  if (drawer === undefined) {
    return { items, rows: items };
  }
  items.push(drawer.drawer);
  // The drawer's own rows are inside its description rather than beside it, so
  // they are collected here: a box built for one of them has to be able to ask
  // what that row meant.
  return { items, rows: [...items, ...drawer.rows] };
}

/**
 * The rows one measured window shows, of a whole ordered reading.
 *
 * Nothing at all while the frame is being measured: a viewport's capacity is
 * what the flow around it left, so the pass that asks describes the region empty
 * and the rows follow once there is an answer. A reading with no measured window
 * shows nothing rather than everything — "show all" is how a list comes to
 * describe rows the frame cannot place.
 */
function shown(
  content: readonly Described[],
  context: ReplPresentationContext,
  window: string,
): readonly Described[] {
  if (context.measuring) {
    return [];
  }
  const held = context.admission.windows.get(window);
  if (held === undefined) {
    return [];
  }
  return content.slice(held.from, held.from + held.count);
}

/**
 * The transcript rows the selected locus holds.
 *
 * An entry's own rows when one is selected, and the whole execution's when none
 * is. The model keeps both, so this chooses between two readings it already
 * holds rather than filtering one into the other.
 */
function transcriptOf(model: ReplModel, selection: ReplSelection): readonly ReplRow[] {
  const key = selection.entry?.key;
  if (key === undefined) {
    return model.transcript;
  }
  return model.entries.find((entry) => entry.key === key)?.transcript ?? model.transcript;
}

/**
 * Whether the entry producing live output is the one being read.
 *
 * Only the last entry a prefix admitted can still be running — entries are
 * serial, and an earlier one settled before this one was admitted. So output
 * this process has not retained belongs there, and nowhere else. Selecting
 * nothing is reading the execution, which includes whatever is running in it.
 */
function livesHere(model: ReplModel, selection: ReplSelection): boolean {
  const key = selection.entry?.key;
  return key === undefined || key === model.entries[model.entries.length - 1]?.key;
}

/**
 * The Sessions reading, as rows.
 *
 * One control per conversation and one per turn, with each turn's own facts
 * beneath it as lines. A turn's control is keyed by its slot, so a turn that
 * publishes keeps the node — and the focus — it already had.
 */
function sessionRows(
  state: ReplState,
  turns: readonly ReplSessionTurn[],
  focused: string | undefined,
  claim: string | undefined,
  /**
   * How wide the frame measured the region these rows land in.
   *
   * None where there is nothing to fit to: counting the reading needs the same
   * rows and no width, because what a label gives up does not change how many
   * rows there are.
   */
  width: number | undefined,
): readonly Described[] {
  const items: Described[] = [];
  const filter = state.route.session;
  const offered = conversations(turns);
  if (offered.length > 0) {
    // All is a control rather than the absence of one: clearing a filter is
    // something a person does, and a list that could only be narrowed would
    // leave them holding a view they cannot get out of.
    items.push(
      row(
        "sessions:all",
        filter === undefined ? "  All conversations" : "  All conversations (filtered)",
        { select: "all-sessions" },
        styleOf("action", { selected: filter === undefined }),
        { here: focused },
      ),
    );
    for (const key of offered) {
      items.push(
        row(
          `sessions:conversation:${key}`,
          fitControl(
            [{ text: `  ${filter === key ? "> " : ""}` }, { text: headline(key), elide: true }],
            width,
          ),
          { select: "session", session: key },
          styleOf("pane-heading", { selected: filter === key }),
          { here: focused },
        ),
      );
    }
  }
  for (const turn of turns) {
    if (filter !== undefined && turn.sessionKey !== filter) {
      continue;
    }
    items.push(
      row(
        `sessions:turn:${turn.key}`,
        // The state comes last and stays: it is why this row is on the screen,
        // and a prompt nobody bounded must not be what takes it off.
        fitControl(
          [
            { text: "  " },
            { text: headline(turn.prompt), elide: true },
            { text: " · " },
            { text: stateOf(turn), keep: true },
          ],
          width,
        ),
        // A turn is read at the position its record holds; a live one has none
        // to go to yet, so it selects the surface it is already on.
        turn.marker === undefined
          ? { select: "surface", surface: "sessions" }
          : { select: "marker", marker: turn.marker },
        // What was asked and how far it got, which is what this row exists to
        // say. The provider's session key, the path and the stop reason are the
        // subordinate rows below it.
        turnStyle(turn),
        // A settled permission sends focus back to the turn that was waiting, so
        // this is the row that may be claimed.
        { here: focused, claim },
      ),
    );
    if (turn.agent !== undefined || turn.sessionKey !== undefined) {
      const said = [turn.agent, turn.sessionKey].filter((fact) => fact !== undefined);
      items.push(
        line(
          `sessions:turn:${turn.key}:whose`,
          fitLine([{ text: "    " }, { text: said.join(" · "), elide: true }], width),
          styleOf("metadata"),
        ),
      );
    }
    if (turn.text.length > 0) {
      items.push(
        line(
          `sessions:turn:${turn.key}:text`,
          fitLine([{ text: "    " }, { text: headline(turn.text), elide: true }], width),
          styleOf("output"),
        ),
      );
    }
    if (turn.stopReason !== undefined) {
      items.push(
        line(
          `sessions:turn:${turn.key}:stop`,
          fitLine([{ text: "    stopped: " }, { text: turn.stopReason, elide: true }], width),
          styleOf("metadata"),
        ),
      );
    }
    if (turn.failure !== undefined) {
      items.push(
        line(
          `sessions:turn:${turn.key}:failed`,
          fitLine([{ text: "    " }, { text: headline(turn.failure), elide: true }], width),
          styleOf("failed-outcome"),
        ),
      );
    }
    const request = turn.request;
    if (request !== undefined) {
      // Inline, on the turn that is waiting. Focusable where it can be answered
      // and a plain fact where it cannot: the grammar answers a request on the
      // Sessions surface, and a control that refused when activated would be a
      // target that does nothing. Either way, arriving here opens nothing —
      // somebody activates it.
      const asks: readonly ReplLabelPart[] = [
        { text: "    asks: " },
        { text: headline(request.title ?? request.toolCallId), elide: true },
      ];
      items.push(
        state.route.surface === "sessions"
          ? row(
              `sessions:request:${request.key}`,
              fitControl(asks, width),
              { select: "permission", request: request.key },
              styleOf("waiting"),
              { here: focused },
            )
          : line(`sessions:request:${request.key}`, fitLine(asks, width), styleOf("waiting")),
      );
    }
    for (const [at, audit] of turn.audits.entries()) {
      // Read, never answered: a record is what a turn was granted, and offering
      // a control here would invite somebody to answer a question nobody asked.
      items.push(
        line(
          `sessions:audit:${turn.key}:${at}`,
          // The outcome comes last and stays, for the same reason a turn's state
          // does: it is the whole of what a retained audit says.
          fitLine(
            [
              { text: "    granted: " },
              { text: headline(audit.title ?? audit.toolCallId), elide: true },
              { text: " — " },
              { text: outcomeOf(audit), keep: true },
            ],
            width,
          ),
          styleOf("metadata"),
        ),
      );
    }
  }
  return items;
}

/**
 * How many rows the Sessions reading holds, whatever the window shows.
 *
 * Counted by building the same rows the window slices, so the number a scroll
 * clamps against cannot disagree with the list it is clamping: one definition of
 * what the reading is, asked twice.
 */
function sessionContentRows(state: ReplState, model: ReplModel, live: ReplLive): number {
  return sessionRows(state, chronology(model, live), undefined, undefined, undefined).length;
}

/**
 * The Entries catalog, as rows, in immutable admission order.
 *
 * Admission order and nothing else: not completion, not terminal outcome, not
 * publication and not latest activity. An entry's place in this list is a fact
 * about when it was admitted, so a row cannot move out from under somebody
 * because a later entry finished first.
 *
 * Each row is keyed by its entry's own stable key rather than by where it sits
 * in whatever window is showing, so scrolling moves the window and changes the
 * identity of nothing in it. Its nested scopes follow it, keyed by the path
 * that selects them — which begins with that entry, so two entries holding the
 * same component cannot collide.
 *
 * The outcome comes before the name, because the name is unbounded and the
 * column is not. A sidebar is 28 columns at its narrowest, and this row is the
 * one place a reader is promised an entry's outcome — put it after an
 * arbitrarily long root name and a long enough name takes the promise away.
 */
function entryContent(
  model: ReplModel,
  focused: string | undefined,
  reading: string | undefined,
  /** How wide the frame measured the region these rows land in, if it has. */
  width: number | undefined,
  /**
   * The key this frame restores focus to, for the entry row that turns out to be
   * it.
   *
   * A narrow frame draws no inspection region, so an answer given there is
   * restored to the entry that owns the record rather than to the record's own
   * row — which is the control a reader can actually see.
   */
  claim?: string | undefined,
): readonly Described[] {
  if (model.entries.length === 0) {
    return [line("entry:none", "  1. (not submitted)", styleOf("metadata"))];
  }
  const items: Described[] = [];
  for (const entry of model.entries) {
    items.push(
      row(
        `entry:${entry.key}`,
        // The outcome still comes before the name, and the marker takes the two
        // columns the indent already had — so a row that is not being read is
        // exactly as wide as it was.
        fitControl(
          [
            {
              text: `${selected(reading === entry.key)}${entry.order}. [${outcomeOfEntry(entry)}] `,
            },
            { text: entry.scope.name, elide: true },
          ],
          width,
        ),
        { select: "scope", scopes: [entry.key] },
        entryStyle(entry, reading === entry.key),
        { here: focused, claim },
      ),
    );
    for (const scope of nested(entry.scope, [entry.key])) {
      items.push(
        row(
          `scope:${scope.path.join("/")}`,
          fitControl([{ text: "    " }, { text: scope.label, elide: true }], width),
          { select: "scope", scopes: scope.path },
          styleOf("metadata"),
          { here: focused },
        ),
      );
    }
  }
  return items;
}

/**
 * What one catalog row says this entry came to.
 *
 * Four readings, because those are the four a reader has to tell apart: an
 * entry whose root has not closed is unfinished — running here, or interrupted
 * before it settled — and the three outcomes a root close carries are three
 * different answers rather than one "done".
 */
function outcomeOfEntry(entry: ReplEntry): string {
  return entry.terminal === undefined ? "unfinished" : entry.terminal.status;
}

/**
 * What one catalog row means, read from the outcome its root recorded.
 *
 * The same four readings the row spells out, so the colour and the word cannot
 * disagree. An entry still being read keeps its outcome: being selected says
 * which transcript is on screen, not that the entry came to something else.
 */
function entryStyle(entry: ReplEntry, selected: boolean): ReplRowStyle {
  const terminal = entry.terminal;
  if (terminal === undefined) {
    return styleOf("waiting", { selected });
  }
  if (terminal.status === "ok") {
    return styleOf("successful-outcome", { selected });
  }
  return styleOf(terminal.status === "err" ? "failed-outcome" : "waiting", { selected });
}

/**
 * How far one turn has got, in words a reader can act on.
 *
 * How it ended and whether the history holds it are separate facts, and a turn
 * that has finished is not the same as one that has been recorded: a person
 * looking at the second may go to its position, and a person looking at the
 * first is watching this process.
 */
/**
 * What one turn's row means, read from how far the turn itself has got.
 *
 * The same four readings the row spells out. A turn nobody has answered yet is
 * waiting whatever it will become; one that failed is a failure however it was
 * phrased; and a turn that finished is the result a reader came for.
 */
function turnStyle(turn: ReplSessionTurn): ReplRowStyle {
  if (turn.state === "queued" || turn.state === "active") {
    return styleOf("waiting");
  }
  if (turn.status === "failed" || turn.failure !== undefined) {
    return styleOf("failed-outcome");
  }
  return styleOf("output");
}

function stateOf(turn: ReplSessionTurn): string {
  if (turn.state === "queued") {
    return "queued";
  }
  if (turn.state === "active") {
    return "streaming";
  }
  const ended = turn.status ?? "finished";
  return turn.state === "terminal" ? `${ended}, not recorded yet` : `${ended}, recorded`;
}

/** What a retained audit says happened, without repeating the whole record. */
function outcomeOf(audit: ReplAgentPermission): string {
  if (audit.outcome === "cancelled") {
    return "cancelled";
  }
  const chosen = audit.options.find((option) => option.optionId === audit.selected);
  return chosen === undefined ? "answered" : chosen.name;
}

/**
 * The innermost open drawer, as a modal branch holding its own controls.
 *
 * Every reading it can show — a binding's value, a recorded answer, History's
 * positions, a pending permission, the waiting question's form — is built as one
 * ordered list and shown through one measured window. Only what that window
 * holds is described, so a row outside it contributes no mounted node, no drawn
 * cell, no keyboard stop and no pointer target. The title, both window controls
 * and `[close]` stay outside the thing they move, because a control inside a
 * window scrolls away from whoever was reaching for it.
 *
 * Its detail is one child per line rather than one multi-line label, because a
 * cell is a row: a label holding three lines would show one of them, and a reader
 * would have no way to know the other two existed.
 */
function drawerFor(
  view: ReplView,
  context: ReplPresentationContext,
  history: Described,
  exit: Described,
  drawable: boolean,
): { readonly drawer: Described; readonly rows: readonly Described[] } | undefined {
  const held = drawerContent(view, context.widths?.drawer ?? 0);
  if (held === undefined) {
    return undefined;
  }
  const { title, titleStyle, dismissing, entering, content } = held;
  const width = context.widths?.drawer ?? 0;
  const rows: Described[] = [];
  rows.push(
    row(
      "drawer:scroll:up",
      padControl("[^ earlier]", width),
      { select: "scroll", delta: -1 },
      styleOf("action"),
      { here: view.focused },
    ),
  );
  for (const placed of windowed(content, context, entering, view.focused)) {
    rows.push(placed);
  }
  rows.push(
    row(
      "drawer:scroll:down",
      padControl("[v later]", width),
      { select: "scroll", delta: 1 },
      styleOf("action"),
      { here: view.focused },
    ),
  );

  // The two nodes the footer would have drawn, inside the modal focus root. A
  // modal contains focus, so a way out mounted beside it would be one Tab could
  // not reach — and a drawer a person cannot leave the command from is a drawer
  // that has taken their terminal.
  //
  // Reparented, but still admitted: the action row is where their cells land, so
  // a control that row cannot hold whole is not described here either.
  const offered = (key: string): boolean => context.measuring || context.admission.actions.has(key);
  if (offered("footer:history")) {
    rows.push(history);
  }
  if (drawable && offered("footer:exit")) {
    rows.push(exit);
  }
  rows.push(
    row(
      "drawer:close",
      padControl("[close]", width),
      dismissing === undefined
        ? { select: "close" }
        : { select: "permission-dismiss", request: dismissing },
      styleOf("action"),
      { here: view.focused },
    ),
  );
  const drawer: Described = {
    key: "drawer:open",
    style: titleStyle,
    description: describeNode<ReplAction>({
      key: "drawer:open",
      component: DRAWER,
      input: { label: width < 1 ? title : title.padEnd(width, " ") },
      children: rows.map((one) => one.description),
      modal: true,
    }),
  };
  return { drawer, rows };
}

/** What one drawer reading holds, before any window decides what is shown. */
interface DrawerContent {
  readonly title: string;
  /**
   * What the title is, which is not the same for every drawer.
   *
   * A drawer holding something nobody has answered yet is named in the accent
   * this screen already uses for waiting, so the one drawer a reader has to act
   * on is the one that says so before they have read a word of it.
   */
  readonly titleStyle: ReplRowStyle;
  readonly dismissing: string | undefined;
  readonly entering: boolean;
  readonly content: readonly DrawerRow[];
}

/**
 * Everything the innermost open drawer holds, in order, or none if it has gone.
 *
 * One builder, asked twice: once for the rows a window shows and once for how
 * many rows there are to window. A second counter is how a clamp comes to
 * disagree with the list it is clamping.
 */
function drawerContent(view: ReplView, width: number): DrawerContent | undefined {
  const open = view.selection.drawers[view.selection.drawers.length - 1];
  if (open === undefined) {
    return undefined;
  }
  // Every row of this drawer reaches its own right edge. A modal that wrote only
  // its own text would let what it is in front of show through from where that
  // text stopped, because a renderer writes what changed and nothing else.
  const content: DrawerRow[] = [];
  let title: string;
  /** What the title reads as. Ordinary unless this drawer is a question. */
  let titleStyle: ReplRowStyle = styleOf("drawer-title");
  /**
   * The request this drawer's close control denies, when it is one.
   *
   * A permission drawer closes by *answering* — dismissal is the direct denial
   * path the authority owns — so its close control carries the request rather
   * than the generic close action that means "this changed nothing".
   */
  let dismissing: string | undefined;
  /** Whether a field line may take the focus claim this drawer opens with. */
  let entering = false;

  if (open.kind === "binding") {
    title = drawerTitle("Binding", open.name, width);
    for (const [offset, text] of detail(open.binding.value).entries()) {
      content.push({
        described: drawerLine(
          `drawer:value:${offset}`,
          text,
          width,
          styleOf("field-value"),
          jsonRuns(text),
        ),
      });
    }
  } else if (open.kind === "recorded-elicit") {
    title = drawerTitle("Recorded answer", open.elicitation.location, width);
    // The whole of what was asked and the whole of what was answered. A drawer is
    // where the retained value is, so a summary here would leave a reader with no
    // way to see what the record actually holds.
    content.push({
      described: drawerLine("drawer:schema", "schema", width, styleOf("field-label")),
    });
    for (const [offset, text] of detail(open.elicitation.schema).entries()) {
      content.push({
        // The schema stays the subordinate reading it already is. What was
        // asked for is the shape of the question, not the value this drawer
        // exists to show, and colouring it as a value would put the two
        // readings on the same footing.
        described: drawerLine(`drawer:schema:${offset}`, text, width, styleOf("field-hint")),
      });
    }
    content.push({
      described: drawerLine("drawer:answered", "answer", width, styleOf("field-label")),
    });
    for (const [offset, text] of detail(open.elicitation.answer).entries()) {
      content.push({
        described: drawerLine(
          `drawer:answer:${offset}`,
          text,
          width,
          styleOf("field-value"),
          jsonRuns(text),
        ),
      });
    }
  } else if (open.kind === "live-permission") {
    // The request this screen selected, read again here: a drawer draws what is
    // pending now, and the one it was opened over may have been answered or torn
    // down since.
    const request =
      view.state.permission === undefined
        ? undefined
        : view.live.agent.requests.find((candidate) => candidate.key === view.state.permission);
    if (request === undefined) {
      return undefined;
    }
    title = drawerTitle("Permission", request.title, width);
    titleStyle = styleOf("question-title");
    // One window over the whole of it. `options` is the provider's, and nothing
    // bounds how many it offers: a drawer that described every choice would have
    // layout clip the last ones, which are exactly the ones a person scrolled
    // down to find.
    for (const placed of permissionContent(view.model, view.live, request, width, view.focused)) {
      content.push({ described: placed });
    }
    dismissing = request.key;
  } else if (open.kind === "history") {
    title = "History";
    // Every retained position, through the same window. A marker outside it is
    // not described, so it is not a cell, not a target and not a Tab stop —
    // which is what makes reaching the last one a thing the controls do rather
    // than something clipping hides.
    for (const checkpoint of view.model.checkpoints) {
      content.push({
        described: row(
          `drawer:marker:${checkpoint.marker}`,
          padControl(checkpoint.label, width),
          { select: "marker", marker: checkpoint.marker },
          styleOf("history", {
            selected: view.state.route.at === checkpoint.marker,
            inspected: true,
          }),
          { here: view.focused },
        ),
      });
    }
  } else {
    const question = view.live.question;
    if (question === undefined) {
      return undefined;
    }
    const form = question.form;
    title = form.title ?? "Answer";
    titleStyle = styleOf("question-title");
    // One viewport over the whole ordered content. Everything a person has to
    // read or reach — the complete message, the form's description, every field
    // with its annotation, options, editable value, every validation message and
    // [submit] — is built in order and then windowed. A drawer too short to hold
    // all of it scrolls, rather than describing rows that have no frame to be
    // placed in.
    for (const [offset, text] of question.message.split("\n").entries()) {
      content.push({
        described: drawerLine(
          `drawer:message:${offset}`,
          text,
          width,
          styleOf("source"),
          sourceRuns(text),
        ),
      });
    }
    if (form.description !== undefined) {
      content.push({
        described: drawerLine("drawer:form:about", form.description, width, styleOf("field-hint")),
      });
    }
    // The same rule inside the modal: the first control claims focus when the
    // drawer opens, and afterwards traversal inside the drawer owns it.
    entering = view.focused === undefined || !view.focused.startsWith("drawer:");
    for (const one of form.fields) {
      const value = view.state.form.values[one.name] ?? "";
      const marked = requiredNow(form, view.state.form.values, one) ? "*" : " ";
      const label = one.title ?? one.name;
      // What the field is called and what is in it, on one row and told apart:
      // a reader scanning a form reads down the labels, and a label that looked
      // like its own value would make them read every row to find the one they
      // have not filled in yet.
      const named = padded(
        tokenRuns([
          { text: `${marked}${label}:`, token: "field-label" },
          { text: " ", token: "field-label" },
          { text: value, token: "field-value" },
        ]),
        width - FOCUS_MARKER,
        "field-label",
      );
      content.push({
        described: row(
          `drawer:field:${one.name}`,
          runText(named),
          { select: "form-field", field: one.name },
          styleOf("field-label"),
          { here: view.focused, runs: named },
        ),
      });
      if (one.description !== undefined) {
        content.push({
          described: drawerLine(
            `drawer:field:${one.name}:about`,
            `  ${one.description}`,
            width,
            styleOf("field-hint"),
          ),
        });
      }
      if (one.choices !== undefined) {
        // What this field accepts, said once. The controls below are how a value
        // is chosen; this is the line that names the whole set, and it is what a
        // reader scanning the form reads first.
        content.push({
          described: drawerLine(
            `drawer:form:${one.name}`,
            `${one.name}: ${one.choices.join(" | ")}`,
            width,
            styleOf("field-hint"),
          ),
        });
      }
      // Every offered value, each its own control. A form that drew only the
      // first would be offering a choice nobody could make.
      for (const option of one.choices ?? []) {
        content.push({
          described: row(
            `drawer:choice:${one.name}:${option}`,
            padControl(`  ${value === option ? "(x)" : "( )"} ${option}`, width),
            { select: "form-choice", field: one.name, option },
            styleOf("action", { selected: value === option }),
            { here: view.focused },
          ),
        });
      }
      // The one editable line for this field, which is where text and Backspace
      // land while it has focus. The first field's line claims focus when the
      // drawer opens — including an enum's, because typing an offered value and
      // pressing Enter is still a way to answer.
      content.push({
        described: field(
          `drawer:value:${one.name}`,
          "  = ",
          value,
          "answer",
          styleOf("field-value"),
          {
            here: view.focused,
          },
        ),
        field: { name: one.name, value },
      });
    }
    // What the last submission was told, under the form it is about.
    for (const [offset, message] of view.state.form.messages.entries()) {
      content.push({
        described: drawerLine(
          `drawer:invalid:${offset}`,
          message.field === undefined ? message.message : `${message.field}: ${message.message}`,
          width,
          styleOf("failed-outcome"),
        ),
      });
    }
    content.push({
      described: row(
        "drawer:form:submit",
        padControl("[submit]", width),
        { select: "form-submit" },
        styleOf("action"),
        { here: view.focused },
      ),
    });
  }

  return { title, titleStyle, dismissing, entering, content };
}

/**
 * One row of a drawer's ordered content, and what it would take to focus it.
 *
 * A field's editable line is built unfocused and the claim is placed afterwards,
 * once the window is known: focusing a row that scrolled out would put focus
 * where nothing is drawn, and which row is first inside the window is not
 * something the loop that builds them can see.
 */
interface DrawerRow {
  readonly described: Described;
  readonly field?: { readonly name: string; readonly value: string };
}

/**
 * The rows one drawer's measured window shows.
 *
 * Nothing while the frame is being measured, because the window is what that
 * pass is asking about. The drawer's opening focus claim goes to the first field
 * line the window actually holds.
 */
function windowed(
  content: readonly DrawerRow[],
  context: ReplPresentationContext,
  entering: boolean,
  focused: string | undefined,
): readonly Described[] {
  if (context.measuring) {
    return [];
  }
  const held = context.admission.windows.get(DRAWER_WINDOW);
  if (held === undefined) {
    return [];
  }
  const rows = content.slice(held.from, held.from + held.count);
  const index = entering ? rows.findIndex((candidate) => candidate.field !== undefined) : -1;
  return rows.map((candidate, at) => {
    const named = candidate.field;
    if (at !== index || named === undefined) {
      return candidate.described;
    }
    return field(
      `drawer:value:${named.name}`,
      "  = ",
      named.value,
      "answer",
      styleOf("field-value"),
      { focus: true, here: focused },
    );
  });
}

/**
 * Everything a permission drawer holds inside its window, in order.
 *
 * The kind, the call, whose turn is waiting, every choice the provider offered
 * and what closing does — one ordered whole rather than a fixed head and a
 * scrolling tail, because a reader who has scrolled to the choices no longer
 * needs the line saying which call they are for taking up a row.
 */
function permissionContent(
  model: ReplModel,
  live: ReplLive,
  request: ReplLivePermission,
  width: number,
  focused: string | undefined,
): readonly Described[] {
  const content: Described[] = [];
  // What is being asked, in the provider's own words. Never `rawInput` and
  // never the request object: a screen shows what a person decides about.
  if (request.kind !== undefined) {
    content.push(
      drawerLine("drawer:permission:kind", `  ${request.kind}`, width, styleOf("field-label")),
    );
  }
  content.push(
    drawerLine(
      "drawer:permission:call",
      `  call ${request.toolCallId}`,
      width,
      styleOf("metadata"),
    ),
  );
  // Whose turn is waiting, so a decision is not made about an anonymous one.
  const waiting = chronology(model, live).find((candidate) => candidate.key === request.turn);
  if (waiting !== undefined) {
    const whose =
      waiting.sessionKey === undefined
        ? headline(waiting.prompt)
        : `${headline(waiting.prompt)} · ${waiting.sessionKey}`;
    content.push(drawerLine("drawer:permission:turn", `  ${whose}`, width, styleOf("metadata")));
  }
  // Every choice the provider offered, in its order, each one its own control.
  for (const choice of request.choices) {
    content.push(
      row(
        `drawer:permission:choice:${choice.optionId}`,
        padControl(`[${choice.name}]${lasting(choice.kind)}`, width),
        { select: "permission-choice", request: request.key, option: choice.optionId },
        styleOf("action"),
        { here: focused },
      ),
    );
  }
  // Said rather than implied: dismissing is a denial of this request, and the
  // session goes on running either way.
  content.push(
    drawerLine(
      "drawer:permission:dismissal",
      "  Escape or close denies this request; the session keeps running.",
      width,
      styleOf("field-hint"),
    ),
  );
  return content;
}

/**
 * How many rows that drawer holds, whatever its window shows.
 *
 * The same builder, asked for its length: what a scroll clamps against is the
 * list it is clamping.
 */
function permissionContentRows(
  model: ReplModel,
  live: ReplLive,
  request: ReplLivePermission,
): number {
  return permissionContent(model, live, request, 0, undefined).length;
}

/**
 * What a lasting choice lasts for.
 *
 * This Agent session, and said so: a person reading "always" in a terminal has
 * every reason to think it means their machine, and nothing here can make a rule
 * that outlives the conversation asking.
 */
function lasting(kind: ReplLiveChoice["kind"]): string {
  return kind === "allow_always" || kind === "reject_always" ? " for this Agent session" : "";
}

/**
 * How many rows the drawer's ordered content holds in total.
 *
 * The complete message, the form's description, every field with its
 * annotation, enum summary, offered values and editable line, every validation
 * message, and `[submit]`. Counted the same way the rows are built, because the
 * reducer clamps a scroll against this before any of them exist.
 */
function drawerContentRows(question: ReplQuestion | undefined, form: ReplFormState): number {
  if (question === undefined) {
    return 0;
  }
  let rows = question.message.split("\n").length;
  rows += question.form.description === undefined ? 0 : 1;
  for (const one of question.form.fields) {
    rows += 2;
    rows += one.description === undefined ? 0 : 1;
    rows += one.choices === undefined ? 0 : 1 + one.choices.length;
  }
  rows += form.messages.length;
  // [submit] scrolls with the form it submits.
  return rows + 1;
}

/** The first line of a message, for a control that is one row tall. */
/**
 * One drawer's title: what kind of reading it is, and which one.
 *
 * The kind first, because it is the fixed part and the part a reader is looking
 * for — a drawer called `plan` says nothing about whether it holds a binding or
 * an answer. The name is whatever the record carries, so it is elided before the
 * word it belongs to is: losing the end of a long name costs a reader less than
 * losing what they are looking at.
 */
function drawerTitle(kind: string, name: string | undefined, width: number): string {
  if (name === undefined || name.length === 0) {
    return kind;
  }
  return fitLine(
    [{ text: `${kind} · ` }, { text: name, elide: true }],
    width < 1 ? undefined : width,
  );
}

function headline(message: string): string {
  const [first = ""] = message.split("\n");
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function pad(label: string, width: number): string {
  return width < 1 ? label : label.padEnd(width, " ");
}

/** One piece of a row's label, and whether a long one gives up its columns. */
interface ReplLabelPart {
  readonly text: string;
  /**
   * This part is a name nothing in this product bounds.
   *
   * How long a root name, a prompt, a tool call or a provider session key is
   * belongs to whoever wrote it, so these are the parts that shorten when a row
   * cannot hold the whole label. The rest is the row's own vocabulary and stays.
   */
  readonly elide?: true;
  /**
   * This part is the fact the row exists to carry.
   *
   * A row too narrow for its own vocabulary keeps this and loses the rest,
   * never the other way round: a sidebar is thirty-two columns and a turn's
   * state can be twenty-seven of them, so there are rows where the name and the
   * state cannot both be there. Which one a reader can act on is the state.
   */
  readonly keep?: true;
}

/**
 * One row's label, fitted to the room the frame measured for its row.
 *
 * A row's rectangle bounds its box and not its characters: the engine draws the
 * text it is given and clips none of it, so a label wider than its row paints
 * into the column beside it — or onto the row below — while the target map still
 * publishes the row's own bounds. A reader then sees a turn's state somewhere it
 * cannot be pointed at, over a cell belonging to something else.
 *
 * Fitted by part rather than cut at the end, because the end is where a row says
 * what it is *about*: the state a turn is in, the outcome an audit recorded.
 * Cutting there takes the one fact the row exists to carry and keeps the name
 * that pushed it off.
 */
function fitLabel(
  parts: readonly ReplLabelPart[],
  width: number | undefined,
  reserved: number,
): string {
  const whole = parts.map((part) => part.text).join("");
  // Unmeasured. The passes that answer what the widths are describe no windowed
  // row, so a row that reaches a person always has a width; a caller counting
  // rows has none and needs none, because fitting changes no count.
  if (width === undefined || width < 1) {
    return whole;
  }
  const room = width - reserved;
  if (whole.length <= room) {
    return whole;
  }
  const elidable = parts.filter((part) => part.elide === true);
  const bounded = parts.reduce(
    (total, part) => total + (part.elide === true ? 0 : part.text.length),
    0,
  );
  if (elidable.length === 0 || bounded >= room) {
    const kept = parts
      .filter((part) => part.keep === true)
      .map((part) => part.text)
      .join("");
    if (kept === "" || kept.length >= room) {
      // Nothing here is a name, or nothing was named as the fact to keep, or
      // keeping it would take the whole row. The row keeps what it can.
      return whole.slice(0, Math.max(0, room));
    }
    // The row's own vocabulary does not fit. What it named survives whole — a
    // state cut in half is a row saying something untrue — and the names keep
    // what is left in front of it, because two rows that are only their state
    // are two rows a reader cannot tell apart.
    const names = elidable.map((part) => part.text).join(" ");
    return `${elided(names, room - kept.length - 1)} ${kept}`;
  }
  const share = Math.floor((room - bounded) / elidable.length);
  let spare = room - bounded - share * elidable.length;
  const given = new Map<ReplLabelPart, number>();
  for (const part of elidable) {
    const extra = spare > 0 ? 1 : 0;
    spare -= extra;
    given.set(part, share + extra);
  }
  return parts
    .map((part) => (part.elide === true ? elided(part.text, given.get(part) ?? 0) : part.text))
    .join("");
}

/** One name in the columns it was given, with a mark where it was cut. */
function elided(text: string, room: number): string {
  if (text.length <= room) {
    return text;
  }
  return room < 1 ? "" : `${text.slice(0, room - 1)}\u2026`;
}

/** A selectable row's label, fitted to its measured row behind the marker. */
function fitControl(parts: readonly ReplLabelPart[], width: number | undefined): string {
  return fitLabel(parts, width, FOCUS_MARKER);
}

/** A plain line's label, fitted to its measured row. */
function fitLine(parts: readonly ReplLabelPart[], width: number | undefined): string {
  return fitLabel(parts, width, 0);
}

/**
 * Pad one *control's* label so the row it draws is exactly as wide as its box.
 *
 * A control is marked when it holds focus, and the marker is two columns wide, so
 * a label padded to the full width draws two columns past the box it is in. The
 * overflow is clipped, which means the last two columns of the box are never
 * written — and what was behind the drawer there stays on the screen.
 */
function padControl(label: string, width: number): string {
  return pad(label, width - FOCUS_MARKER);
}

/** The two columns `marked()` puts in front of a control's label. */
const FOCUS_MARKER = 2;

/**
 * Whether this field is required as the form currently stands.
 *
 * The root's own `required`, plus whatever the one conditional adds while its
 * field holds the value it tests for. Presentation only — what actually decides
 * is the compiled schema, which judges the assembled object.
 */
function requiredNow(
  form: ReplQuestionForm,
  values: Readonly<Record<string, string>>,
  field: ReplFormField,
): boolean {
  if (field.required) {
    return true;
  }
  const condition = form.condition;
  if (condition === undefined || values[condition.field] !== condition.equals) {
    return false;
  }
  return condition.requires.some((one) => one.name === field.name);
}

/** One value, as the lines a drawer shows it on. */
function detail(value: Json): readonly string[] {
  return (JSON.stringify(value, undefined, 2) ?? "null").split("\n");
}

/** Every nested scope beneath one, with the key path that selects it. */
/** One selectable nested scope: what to call it, and the path that selects it. */
interface NestedScope {
  readonly label: string;
  readonly path: string[];
}

function nested(scope: ReplScope, path: readonly string[]): readonly NestedScope[] {
  const found: NestedScope[] = [];
  for (const child of scope.scopes) {
    const here = [...path, child.key];
    found.push({ label: `${child.kind} ${child.name}`, path: here });
    found.push(...nested(child, here));
  }
  return found;
}

/** One line of a transcript record, and what that line is. */
interface TranscriptLine {
  readonly text: string;
  readonly style: ReplRowStyle;
}

/**
 * One transcript record, as the lines it is drawn in and what each of them is.
 *
 * Decided together, because a root close draws two different things. A root that
 * recorded a result shows that result — the rendered document, which is what a
 * reader came for — and a root that recorded none shows the outcome it closed
 * with instead. One role chosen from the record's kind alone paints a whole
 * rendered document in the accent that belongs to the word `ok`.
 *
 * Read from the typed fields as each line is built, never from the string that
 * came out: a document whose own output contains the word `failed` is still
 * output, and a root that closed `err` is a failure whatever it rendered.
 */
function transcriptLines(entry: ReplRow, width: number): readonly TranscriptLine[] {
  if (entry.kind !== "terminal") {
    return lined(
      describeRow(entry, width),
      entry.kind === "output" ? styleOf("output") : styleOf("metadata"),
    );
  }
  // Three outcomes rather than one "done", and a cancellation is not a failure:
  // it is a reading that stopped.
  const outcome =
    entry.status === "ok"
      ? styleOf("successful-outcome")
      : styleOf(entry.status === "err" ? "failed-outcome" : "waiting");
  const shown =
    entry.output.length > 0
      ? lined(entry.output, styleOf("output"))
      : lined(`closed ${entry.status}`, outcome);
  // Only a failure that recorded a reason, and only for a failure: an `ok`, a
  // cancellation and an entry that never settled have no reason to show, and
  // inventing text for them would describe a failure that did not happen.
  if (entry.status !== "err" || entry.message === undefined) {
    return shown;
  }
  // Its own line, so the outcome and the reason are two rows a window can scroll
  // rather than one row a region has to clip in the middle.
  return [...shown, { text: failedLine(entry.message, width), style: styleOf("failed-outcome") }];
}

/**
 * One string as the rows it is drawn in, each under one role.
 *
 * A cell is a row, so a record holding several lines of text becomes several
 * cells. A cell given more than one line would show only the first, which is the
 * whole of what a reader would then believe was there.
 */
function lined(text: string, style: ReplRowStyle): readonly TranscriptLine[] {
  return text.split("\n").map((one) => ({ text: one, style }));
}

/**
 * One ordinary transcript row, as a line that fits where it will be drawn.
 *
 * A root close is not one of these: what it draws depends on whether it recorded
 * a result, so the two cannot share a single string.
 *
 * The rows naming *where something came from* are bounded here. A path, a
 * component's name and a generated fragment's source are as long as somebody
 * else made them, and this engine clips no text — so a row longer than its pane
 * is drawn over the row beneath it, and the reader loses a line they were given
 * to keep one nobody bounded. The fixed part of each row is kept and the
 * unbounded part gives up its columns first, with the mark that says it was
 * shortened; the whole of it stays in the Journal, which is where something
 * unbounded belongs.
 *
 * What a document and a provider *said* is not bounded here. That text is the
 * thing a reader came for, and shortening it would be this screen editing the
 * content it exists to show.
 */
function describeRow(
  entry: Exclude<ReplRow, { readonly kind: "terminal" }>,
  width: number,
): string {
  const room = width < 1 ? undefined : width;
  switch (entry.kind) {
    case "entry":
      return fitLine([{ text: "entry " }, { text: entry.path, elide: true }], room);
    case "scope":
      return fitLine([{ text: `${entry.scope} ` }, { text: entry.name, elide: true }], room);
    case "binding":
      return `${entry.scope} bound ${entry.names.join(", ")}`;
    case "output":
      return entry.text;
    case "generated":
      // A fragment's source is read as the document it is: the Agent journey
      // reads the branch a program did *not* take off this screen, which only
      // whole source can show. Bounding it to one row is a decision about what
      // this screen owes a reader, not a formatting choice.
      return `generated ${entry.decision}${entry.source === undefined ? "" : `: ${entry.source}`}`;
    case "elicit":
      return `answered ${entry.location} ${summarize(entry.answer)}`;
    case "agent":
      // The status stays whatever the name costs: a row that said which agent
      // and not how it ended would have kept the part nobody bounded and lost
      // the part this row exists to carry.
      return fitLine(
        [
          { text: "agent " },
          { text: entry.turn.agent, elide: true },
          { text: ` ${entry.turn.status}`, keep: true },
        ],
        room,
      );
    case "effect":
      return `${entry.type} ${entry.status}`;
  }
}

/** What a failure row is introduced by, counted because it is part of the row. */
const FAILED_PREFIX = "failed: ";

/**
 * One recorded failure, as a single line that fits where it will be drawn.
 *
 * A message is whatever the thing that failed said, and what failed may be a
 * compiler: the measured ones run to hundreds of characters and embed a whole
 * `data:` URI of the generated module. Two things follow. It is flattened,
 * because every newline in a transcript row becomes another cell and a reason
 * that paid itself out over forty of them would push the footer and every
 * control below the screen. And it is cut to the region, *including* its own
 * introduction — bounding only the message would hand a 76-column row to a
 * 64-column column, where the renderer cuts it again and takes the ellipsis with
 * it, so the row would end mid-word with nothing saying it had been shortened.
 *
 * The whole of it stays in the Journal, which is where something unbounded
 * belongs.
 */
function failedLine(message: string, width: number): string {
  const flattened = message.replace(/\s+/g, " ").trim();
  // A reason that is only whitespace says nothing a reader can act on, and
  // `failed:` with nothing after it reads like the text went missing.
  const said = flattened.length === 0 ? "(no reason recorded)" : flattened;
  const line = `${FAILED_PREFIX}${said}`;
  if (width < 1 || line.length <= width) {
    return line;
  }
  // One column for the mark that says there is more.
  return `${line.slice(0, Math.max(FAILED_PREFIX.length, width - 1))}…`;
}

/** The Sessions reading's window. */
export const SESSIONS_WINDOW = "sessions";
/** The Entries catalog's window. */
export const ENTRIES_WINDOW = "entries";
/** The open drawer's content window, whichever reading it is showing. */
export const DRAWER_WINDOW = "drawer";
/** The action row's own structural id, which admission measures against. */
export const ACTION_ROW = "box:footer:actions";

/**
 * How wide each region that text must fit is, as the engine measured it.
 *
 * Asked by whoever has to *write* something that must land in one: a row longer
 * than its region is reflowed into rows the layout never allocated, and a
 * sentence shorter than its region leaves the text it covers showing through
 * from where it stops. Measured rather than recomputed, because a second width
 * calculator is a second answer to a question with one.
 */
export interface ReplMeasuredWidths {
  /** The surface carrying content: the transcript column, or the narrow outlet. */
  readonly surface: number;
  /** The column the Sessions reading and the Entries catalog share. */
  readonly list: number;
  /** The bindings and recorded-answer column. */
  readonly inspection: number;
  /** The drawer's own interior. */
  readonly drawer: number;
}

/**
 * What one paint has measured and admitted.
 *
 * The same value reaches the description builder and the reducer, so what a
 * scroll clamps against is what the screen is showing.
 */
export interface ReplPresentationContext {
  /**
   * The region widths this frame measured, or none before it has measured any.
   *
   * The first measurement's whole job is to answer this, and text is what makes
   * that answer unreliable: a column that grows into what is left still takes
   * its minimum from its content, so one unbounded row makes the column wider
   * than its share and squeezes the column beside it. Measured: an unwrapped
   * canonical location made a 92-column transcript report 128 and paint over the
   * inspection column. So the pass that asks describes no width-dependent text
   * at all, and every pass after it has a width to bound that text to.
   */
  readonly widths: ReplMeasuredWidths | undefined;
  readonly admission: ReplAdmission;
  /**
   * Whether this is the pass that asks the engine for geometry.
   *
   * It describes every scrolling viewport empty and offers every candidate
   * action control, so the answer it gets back describes the region rather than
   * whatever is currently overflowing it. Its descriptions are never reconciled.
   */
  readonly measuring: boolean;
  /** Whether the Entries catalog reserves its two window controls. */
  readonly entriesWindowed: boolean;
  /**
   * The catalog's own height when it fits, or none when it is windowed.
   *
   * Carried rather than counted from the rows this pass describes, because the
   * measuring pass describes none: a viewport sized by what the skeleton holds
   * would be a viewport of nothing.
   */
  readonly entriesRows: number | undefined;
  /**
   * Whether the drawer layer takes the engine's pointer off what it covers.
   *
   * Narrowing the engine's own hit test, and nothing more: a pointer is resolved
   * against this frame's detached bounds and containment is the reconciler's, so
   * turning this off must not make a control behind the modal reachable.
   */
  readonly capture: "capture" | "passthrough";
}

/** One reading's descriptions, paired with where the engine places them. */
export interface ReplPresentation {
  readonly descriptions: readonly ReplDescription<ReplAction>[];
  readonly manifest: ReplLayoutManifest;
}

/**
 * Which reading one retained drawer is showing, as its own identity.
 *
 * Not the title and not the position in the stack: two bindings called `name` in
 * different scopes are different readings and must not share a window position,
 * and a drawer reopened over the same reading must find the position it was left
 * at. The live question and a pending permission have their own offsets already,
 * so they have no key here.
 */
export function readingKeyOf(state: ReplState, open: ReplDrawerRef): string | undefined {
  // The prefix being read is part of the identity: the same binding at two
  // history positions is two readings of two different files.
  const at = state.route.at ?? "head";
  const execution = state.route.execution;
  if (open.kind === "history") {
    return `history:${execution}:${at}`;
  }
  if (open.kind === "binding") {
    return `binding:${execution}:${at}:${state.route.scopes.join("/")}:${open.name}`;
  }
  if (open.kind === "recorded-elicit") {
    return `elicit:${execution}:${at}:${open.marker}`;
  }
  return undefined;
}

/**
 * How far the open drawer's window is scrolled.
 *
 * A new reading starts at its first row; a reading being revisited uses its own
 * stored position, which admission then clamps against what this size and this
 * content actually allow.
 */
export function drawerOffsetOf(state: ReplState, open: ReplDrawerRef | undefined): number {
  if (open === undefined) {
    return 0;
  }
  if (open.kind === "live-elicit") {
    return state.form.offset;
  }
  if (open.kind === "live-permission") {
    return state.viewports.permission;
  }
  const reading = readingKeyOf(state, open);
  return reading === undefined ? 0 : (state.viewports.readings[reading] ?? 0);
}

/**
 * Which part of the frame one description belongs to.
 *
 * Read from the key the description was built with, which is the one place the
 * region a row belongs to is decided. A row's slot says whether it moves inside
 * a window or stays put around one — the distinction a measured capacity depends
 * on, because the rows that stay put are exactly what the viewport does not get.
 */
type ReplSlot =
  | "located"
  | "navigation"
  | "pane-heading"
  | "sessions-fixed"
  | "sessions"
  | "entries-fixed"
  | "entries"
  | "transcript"
  | "inspection"
  | "drawer-above"
  | "drawer-below"
  | "drawer"
  | "drawer-title"
  | "action"
  | "status"
  | "draft";

function slotOf(key: string): ReplSlot | undefined {
  if (key === "drawer:open") {
    return "drawer-title";
  }
  if (key === "drawer:scroll:up") {
    return "drawer-above";
  }
  if (key === "drawer:scroll:down" || key === "drawer:close") {
    return "drawer-below";
  }
  if (key.startsWith("drawer:")) {
    return "drawer";
  }
  if (key === "footer:input") {
    return "draft";
  }
  // Status, so it follows every control: a row too narrow for both keeps the way
  // out and loses the sentence, never the other way round. `footer:asked` is a
  // control as well as a status, which is why it is here rather than ahead of
  // them — the drawer it opens is also reachable by Tab.
  if (key === "footer:refused" || key === "footer:asked") {
    return "status";
  }
  if (key.startsWith("footer:")) {
    return "action";
  }
  if (key === "sessions:heading" || key === "entries:heading") {
    return "navigation";
  }
  if (key === "transcript:heading" || key === "inspection:heading") {
    return "pane-heading";
  }
  // The empty placeholder and both window controls stay put around the window
  // rather than inside it, so a measured viewport is the moving part alone.
  if (key === "sessions:empty" || key === "sessions:earlier" || key === "sessions:later") {
    return "sessions-fixed";
  }
  if (key.startsWith("sessions:")) {
    return "sessions";
  }
  if (key === "entries:earlier" || key === "entries:later" || key === "entry:none") {
    return "entries-fixed";
  }
  if (key.startsWith("entries:") || key.startsWith("entry:") || key.startsWith("scope:")) {
    return "entries";
  }
  if (key.startsWith("line:")) {
    return "transcript";
  }
  if (key.startsWith("binding:") || key.startsWith("elicit:")) {
    return "inspection";
  }
  if (key === "guidance") {
    return "located";
  }
  // Above the surface, where there is a row's full width for a sentence. On the
  // action row it would be one truncated line beside the control.
  if (key === "refusal" || key.startsWith("refusal:")) {
    return "located";
  }
  return undefined;
}

/** One classified candidate: what it is, and what measurement would draw. */
interface ReplCandidate {
  readonly key: string;
  readonly slot: ReplSlot;
  readonly text: string;
  readonly control: boolean;
  readonly style: ReplRowStyle;
  readonly runs: readonly ReplTokenRun[] | undefined;
}

/**
 * Every described row, classified, in the order it was described.
 *
 * Walked rather than read off the committed frame, because measurement happens
 * before anything is mounted: the pass that asks how many rows a region holds
 * cannot consult a tree that does not yet have them.
 */
function candidatesOf(
  descriptions: readonly ReplDescription<ReplAction>[],
  /**
   * What each described row meant, by the key it was described under.
   *
   * The walk below reads the finished descriptions, which no longer carry the
   * facts a role comes from — so the style is carried alongside rather than
   * recovered. A key the screen did not describe has no entry and reads as
   * ordinary prose.
   */
  styles: ReadonlyMap<string, ReplRowStyle>,
  /**
   * What each described row's characters are, by the key it was described under.
   *
   * Carried for the same reason the style is: the finished descriptions no
   * longer hold the pieces a row was built from, and a pass that recovered them
   * from the string would be classifying text it had already lost the facts for.
   */
  runs: ReadonlyMap<string, readonly ReplTokenRun[]>,
): readonly ReplCandidate[] {
  const found: ReplCandidate[] = [];
  const walk = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    const slot = slotOf(read.key);
    if (slot !== undefined) {
      found.push({
        key: read.key,
        slot,
        text: measurementTextOf(read.component, read.input),
        control: isControl(read.component, read.input),
        style: styles.get(read.key) ?? ORDINARY,
        runs: runs.get(read.key),
      });
    }
    for (const child of read.children) {
      walk(child);
    }
  };
  for (const description of descriptions) {
    walk(description);
  }
  return found;
}

/**
 * What one row would draw, for the pass that has no mounted node to ask.
 *
 * The same pure formatting the mounted component uses, so a control measured
 * without its focus prefix cannot come out two columns narrower than the one
 * drawn in its place.
 */
function measurementTextOf(component: ReplComponent<ReplAction>, input: ReplViewData): string {
  const named = fields(input);
  const focused = named?.["focused"] === true;
  if (component === FIELD) {
    const prompt = typeof named?.["prompt"] === "string" ? named["prompt"] : "";
    const text = typeof named?.["text"] === "string" ? named["text"] : "";
    return fieldText(prompt, text, focused);
  }
  const label = typeof named?.["label"] === "string" ? named["label"] : "";
  if (component === SELECT_ROW) {
    return focusPrefixed(label, focused);
  }
  return label;
}

/**
 * Whether one row is a control.
 *
 * Read from what the row *is* — the component it was described with — rather
 * than from how its key happens to be spelled. A turn's own facts, a retained
 * audit, the location somebody copies and the reason the last action changed
 * nothing are lines, and a line has nothing to activate; every control answers
 * Enter, so a pointer on one asks for exactly what Enter there asks for.
 *
 * Spelling could never have decided this. A conversation key carries a provider
 * session key and a field key carries a field name, so a conversation called
 * `text` or a field called `stop` would have lost its pointer to a rule about
 * suffixes — and a row that draws a control and refuses the pointer is a control
 * that is not one.
 */
function isControl(component: ReplComponent<ReplAction>, input: ReplViewData): boolean {
  if (component === SELECT_ROW || component === FIELD) {
    return true;
  }
  // A refusal is a control only when it offers somewhere to go back to.
  return component === REFUSAL && fields(input)?.["back"] !== undefined;
}

/**
 * One stacked row box, keyed by the description whose node draws it.
 *
 * As wide as the region it lands in, which the frame measured. A row that left
 * its width to the flow would take it from its own text instead, and a row
 * wider than its column both widens that column and publishes a hit box
 * reaching into the next one.
 */
function rowBox(candidate: ReplCandidate, region: ReplRegion, width: number | undefined): ReplBox {
  return box({
    id: `box:${region}:${candidate.key}`,
    key: candidate.key,
    region,
    props: rowProps(width),
    text: candidate.text,
    control: candidate.control,
    style: candidate.style,
    runs: candidate.runs,
  });
}

/**
 * One reading's descriptions and the constraints that place them.
 *
 * Built from one walk, so a drawn element and a mounted node cannot drift apart.
 * The measuring pass and the committed pass call this with the same view and
 * differ only in what they were told was admitted — which is what makes the
 * measured region and the region drawn into it the same region.
 */
export function presentationFor(
  view: ReplView,
  context: ReplPresentationContext,
): ReplPresentation {
  const screen = described(view, context);
  const descriptions = screen.items.map((item) => item.description);
  const styles = new Map<string, ReplRowStyle>();
  const runs = new Map<string, readonly ReplTokenRun[]>();
  for (const one of screen.rows) {
    styles.set(one.key, one.style);
    if (one.runs !== undefined) {
      runs.set(one.key, one.runs);
    }
  }
  const size = view.size;
  const profile = profileFor(size);
  const band = historyBand(
    view.model.checkpoints.map((checkpoint) => ({
      marker: checkpoint.marker,
      label: checkpoint.label,
    })),
    size.columns,
  );
  if (profile === "too-small") {
    // No cell beyond the sentence, so nothing this frame hides can be pointed
    // at: a control that is not in the frame is not in its target map either.
    return {
      descriptions,
      manifest: Object.freeze({
        profile,
        size: Object.freeze({ ...size }),
        root: box({
          id: "box:root",
          props: rootProps(size),
          children: [
            box({
              id: "box:refusal",
              // No key, because there is no row: below the minimum this is a
              // *layout* refusal, and the sentence is the frame's own rather
              // than something a described node contributed. A view-level
              // refusal at a drawable size is an ordinary row and goes with the
              // rest of them, above the surface.
              region: "refusal",
              props: refusalProps(),
              text: refusalText(size),
            }),
          ],
        }),
        viewports: Object.freeze([]),
        actions: undefined,
        regions: Object.freeze([Object.freeze({ region: "refusal", id: "box:refusal" })]),
        contents: Object.freeze([]),
        history: band,
      }),
    };
  }

  const candidates = candidatesOf(descriptions, styles, runs);
  const viewports: ReplViewportSlot[] = [];
  const regions: { region: ReplRegion; id: string }[] = [];
  /** The border-free inside of each pane that has edges. */
  const contents: { region: ReplRegion; id: string }[] = [];
  /**
   * How wide one region is, as this frame measured it.
   *
   * The footer is the exception and needs no measurement: it is a growing child
   * of a root fixed at the terminal's own size, so it is the terminal wide.
   */
  const widthOfRegion = (region: ReplRegion): number | undefined => {
    if (region === "footer") {
      return size.columns;
    }
    if (region === "drawer") {
      return context.widths?.drawer;
    }
    if (region === "inspection") {
      return context.widths?.inspection;
    }
    if (region === "transcript") {
      return context.widths?.surface;
    }
    // The sidebar and the narrow outlet both carry the two list readings.
    return context.widths?.list;
  };
  const of = (slot: ReplSlot): readonly ReplCandidate[] =>
    candidates.filter((candidate) => candidate.slot === slot);

  /** One list region: the rows that stay put, and the window they surround. */
  const listColumn = (
    region: ReplRegion,
    fixedSlot: ReplSlot,
    rowSlot: ReplSlot,
    window: string,
    rows?: number,
  ): readonly ReplBox[] => {
    const fixed = of(fixedSlot);
    // The window controls sit outside the thing they move, so they are siblings
    // of the viewport rather than rows inside it.
    const above = fixed.filter((candidate) => candidate.key.endsWith(":earlier"));
    const below = fixed.filter((candidate) => candidate.key.endsWith(":later"));
    const rest = fixed.filter(
      (candidate) => !candidate.key.endsWith(":earlier") && !candidate.key.endsWith(":later"),
    );
    const id = `box:${window}:viewport`;
    viewports.push(Object.freeze({ id, region, window }));
    return [
      ...rest.map((candidate) => rowBox(candidate, region, widthOfRegion(region))),
      ...above.map((candidate) => rowBox(candidate, region, widthOfRegion(region))),
      box({
        id,
        region,
        props: viewportProps(rows),
        children: of(rowSlot).map((candidate) => rowBox(candidate, region, widthOfRegion(region))),
      }),
      ...below.map((candidate) => rowBox(candidate, region, widthOfRegion(region))),
    ];
  };

  const located = of("located").map((candidate) =>
    rowBox(candidate, profile === "narrow" ? "content" : "transcript", context.widths?.surface),
  );
  const heading = (key: string, region: ReplRegion): readonly ReplBox[] => {
    const found = of("navigation").filter((candidate) => candidate.key === key);
    return found.map((candidate) => rowBox(candidate, region, widthOfRegion(region)));
  };
  /** One pane's own title, where there is a pane to put it in. */
  const paneTitle = (key: string, region: ReplRegion): readonly ReplBox[] => {
    const found = of("pane-heading").filter((candidate) => candidate.key === key);
    return found.map((candidate) => rowBox(candidate, region, widthOfRegion(region)));
  };
  /**
   * One pane with edges, and the border-free box its rows are measured in.
   *
   * The column keeps the width the product gives it; the inside is whatever the
   * engine leaves after the edges, and that inside is what `widthsOf` reads.
   */
  const edgedColumn = (
    region: ReplRegion,
    width: number | undefined,
    surface: number,
    children: readonly ReplBox[],
  ): ReplBox => {
    const id = `box:${region}:content`;
    contents.push({ region, id });
    return box({
      id: `box:${region}`,
      region,
      props: paneColumnProps(width, surface),
      children: [box({ id, region, props: paneContentProps(), children })],
    });
  };

  const columns: ReplBox[] = [];
  if (profile === "narrow") {
    // Exactly the routed surface, and nothing else. A narrow screen that stacked
    // every region would be a wide screen with the columns removed: the reader
    // would scroll past three lists to reach the one they asked for, and every
    // row of the other two would still be a target.
    const routed =
      view.state.route.surface === "sessions"
        ? listColumn("content", "sessions-fixed", "sessions", SESSIONS_WINDOW)
        : listColumn("content", "entries-fixed", "entries", ENTRIES_WINDOW);
    regions.push({ region: "content", id: "box:content" });
    columns.push(
      box({
        id: "box:content",
        region: "content",
        props: columnProps(undefined),
        children: [
          ...located,
          // Which surface to be on belongs to neither surface, so the way out of
          // an outlet cannot be inside it.
          ...heading("sessions:heading", "content"),
          ...heading("entries:heading", "content"),
          ...routed,
        ],
      }),
    );
  } else {
    regions.push(
      { region: "sidebar", id: "box:sidebar" },
      { region: "transcript", id: "box:transcript" },
      { region: "inspection", id: "box:inspection" },
    );
    columns.push(
      box({
        id: "box:sidebar",
        region: "sidebar",
        props: paneProps(sidebarWidth(size), REPL_PALETTE.sideSurface),
        children: [
          // Two groups, and only one of them grows: the Sessions reading takes
          // whatever the column has left, and the catalog states its own height.
          // Two growing siblings would split the remainder in the engine's
          // arithmetic, which is not whole.
          //
          // A sidebar keeps each heading with the list it names, which is where
          // a reader looks for it.
          box({
            id: "box:sidebar:sessions",
            region: "sidebar",
            props: stackProps("grow"),
            children: [
              ...heading("sessions:heading", "sidebar"),
              ...listColumn("sidebar", "sessions-fixed", "sessions", SESSIONS_WINDOW),
            ],
          }),
          box({
            id: "box:sidebar:entries",
            region: "sidebar",
            // A catalog that fits takes exactly its own length, so a one-entry
            // execution draws one row instead of claiming half a column it does
            // not need. One that does not takes its share and no more, which is
            // what keeps the two readings in this column independent.
            props: stackProps(context.entriesRows === undefined ? sharedColumnRows(size) : "fit"),
            children: [
              ...heading("entries:heading", "sidebar"),
              ...listColumn(
                "sidebar",
                "entries-fixed",
                "entries",
                ENTRIES_WINDOW,
                context.entriesRows,
              ),
            ],
          }),
        ],
      }),
      edgedColumn("transcript", undefined, REPL_PALETTE.centreSurface, [
        ...paneTitle("transcript:heading", "transcript"),
        ...located,
        box({
          id: "box:transcript:viewport",
          region: "transcript",
          props: viewportProps(),
          children: of("transcript").map((candidate) =>
            rowBox(candidate, "transcript", context.widths?.surface),
          ),
        }),
      ]),
      edgedColumn("inspection", inspectionWidth(size), REPL_PALETTE.bindingsSurface, [
        ...paneTitle("inspection:heading", "inspection"),
        box({
          id: "box:inspection:viewport",
          region: "inspection",
          props: viewportProps(),
          children: of("inspection").map((candidate) =>
            rowBox(candidate, "inspection", context.widths?.inspection),
          ),
        }),
      ]),
    );
  }

  const rect = drawerRect(size);
  const [title] = of("drawer-title");
  if (rect !== undefined && title !== undefined) {
    const id = `box:${DRAWER_WINDOW}:viewport`;
    viewports.push(Object.freeze({ id, region: "drawer", window: DRAWER_WINDOW }));
    regions.push({ region: "drawer", id: "box:drawer:layer" });
    columns.push(
      box({
        id: "box:drawer:layer",
        region: "drawer",
        props: drawerLayerProps(rect, context.capture),
        children: [
          rowBox(title, "drawer", context.widths?.drawer),
          ...of("drawer-above").map((candidate) =>
            rowBox(candidate, "drawer", context.widths?.drawer),
          ),
          box({
            id,
            region: "drawer",
            props: viewportProps(),
            children: of("drawer").map((candidate) =>
              rowBox(candidate, "drawer", context.widths?.drawer),
            ),
          }),
          ...of("drawer-below").map((candidate) =>
            rowBox(candidate, "drawer", context.widths?.drawer),
          ),
        ],
      }),
    );
  }

  const offered = [...of("action"), ...of("status")];
  // Every candidate while measuring, so each one's own width is an answer the
  // engine has given; only the admitted prefix once there is one.
  const placed = offered.filter(
    (candidate) => context.measuring || context.admission.actions.has(candidate.key),
  );
  const [draft] = of("draft");
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
          box({
            id: "box:body",
            props: bodyProps(profile !== "narrow"),
            children: columns,
          }),
          box({
            id: "box:footer",
            region: "footer",
            props: footerProps(),
            children: [
              box({
                id: ACTION_ROW,
                region: "footer",
                props: actionRowProps(),
                children: placed.map((candidate) =>
                  box({
                    id: `box:action:${candidate.key}`,
                    key: candidate.key,
                    region: "footer",
                    props: CONTROL_PROPS,
                    text: candidate.text,
                    control: candidate.control,
                    style: candidate.style,
                    runs: candidate.runs,
                  }),
                ),
              }),
              box({
                id: "box:footer:band",
                region: "footer",
                props: bandProps(),
                children: band.rows.map((text, at) =>
                  box({
                    id: `box:band:${at}`,
                    region: "footer",
                    props: rowProps(size.columns),
                    text,
                    // The one part of this screen that is not a mounted row, so
                    // its style comes from the band rather than from a candidate.
                    style: styleOf("history", {
                      inspected: view.state.route.at !== undefined,
                    }),
                  }),
                ),
              }),
              ...(draft === undefined ? [] : [rowBox(draft, "footer", size.columns)]),
            ],
          }),
        ],
      }),
      viewports: Object.freeze(viewports),
      actions: Object.freeze({
        id: ACTION_ROW,
        controls: Object.freeze(
          offered.map((candidate) => ({
            key: candidate.key,
            id: `box:action:${candidate.key}`,
            control: candidate.control,
          })),
        ),
      }),
      regions: Object.freeze(regions.map((region) => Object.freeze(region))),
      contents: Object.freeze(contents.map((content) => Object.freeze(content))),
      history: band,
    }),
  };
}

/**
 * What this frame admits, from what the engine measured.
 *
 * Capacity is the measured viewport, floored and bounded at zero; the row count
 * is the reading's own, counted by the builder that produces those rows. Nothing
 * here subtracts a heading, a control or a footer: that is the arithmetic the
 * measurement replaced.
 */
export function admissionFor(input: {
  readonly view: ReplView;
  readonly manifest: ReplLayoutManifest;
  readonly widths: ReplMeasuredWidths;
  readonly boundsOf: (id: string) => ReplBounds | undefined;
}): ReplAdmission {
  const { view, manifest, widths, boundsOf } = input;
  const windows = new Map<string, ReplWindow>();
  for (const slot of manifest.viewports) {
    const capacity = capacityOf(boundsOf(slot.id));
    windows.set(
      slot.window,
      admitRows({
        offset: offsetFor(view, slot.window, capacity),
        total: totalOf(view, widths, slot.window),
        capacity,
      }),
    );
  }
  const actions = manifest.actions;
  if (actions === undefined) {
    return Object.freeze({ windows, actions: new Set<string>(), shortened: undefined });
  }
  const row = admitActions({ row: boundsOf(actions.id), controls: actions.controls, boundsOf });
  return Object.freeze({ windows, actions: row.admitted, shortened: row.shortened });
}

/**
 * How many rows the Entries catalog holds, whatever a window shows.
 *
 * Asked by the preparation that decides whether the catalog needs its window
 * controls at all: a catalog shorter than the room it has keeps its natural
 * footprint and takes no row for a control nothing would scroll.
 */
export function entriesRowCount(model: ReplModel): number {
  return entryContent(model, undefined, undefined, undefined).length;
}

/**
 * How far one window is scrolled, with a row this frame claims focus for shown.
 *
 * The offset this process is holding, moved only as far as it takes to put a
 * claimed row inside the window: a claim naming a row the window does not hold
 * would be focus asked for on behalf of nothing, and an answer given at a narrow
 * size is restored to the entry that owns it — which may be above or below what
 * the catalog is showing. The window itself is the existing one and the offset is
 * the existing process-local one; nothing new scrolls and nothing is added to the
 * frame.
 */
function offsetFor(view: ReplView, window: string, capacity: number): number {
  const held = offsetOf(view, window);
  if (window !== ENTRIES_WINDOW || capacity < 1) {
    return held;
  }
  const claimed = focusClaim(view);
  if (claimed === undefined || !claimed.startsWith("entry:")) {
    return held;
  }
  const at = entryContent(view.model, undefined, undefined, undefined).findIndex(
    (item) => item.key === claimed,
  );
  if (at < 0) {
    return held;
  }
  // As little as it takes: a claimed row above the window brings it up to that
  // row, one below brings it down until that row is the last one shown, and a row
  // the window already holds moves nothing.
  return Math.min(Math.max(held, at - capacity + 1), at);
}

/** How far one window is scrolled, as this process is holding it. */
function offsetOf(view: ReplView, window: string): number {
  if (window === SESSIONS_WINDOW) {
    return view.state.viewports.sessions;
  }
  if (window === ENTRIES_WINDOW) {
    return view.state.viewports.entries;
  }
  return drawerOffsetOf(view.state, view.state.route.drawers[view.state.route.drawers.length - 1]);
}

/**
 * How many rows one reading holds, counted by whatever builds those rows.
 *
 * The view's own live overlay, which is the one the descriptions were built
 * from: a frozen prefix shows nothing of the present, so counting against the
 * live head would clamp a historical reading against rows it does not have.
 */
function totalOf(view: ReplView, widths: ReplMeasuredWidths, window: string): number {
  if (window === SESSIONS_WINDOW) {
    return sessionContentRows(view.state, view.model, view.live);
  }
  if (window === ENTRIES_WINDOW) {
    return entriesRowCount(view.model);
  }
  return drawerContent(view, widths?.drawer ?? 0)?.content.length ?? 0;
}

export { HISTORY_ROWS };
export type { ReplDrawerRef, ReplSurface };
