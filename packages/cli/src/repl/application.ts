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

import { describe as describeNode, fields, readDescription } from "./description.ts";
import type { ReplDescription } from "./description.ts";
import {
  drawerHeight,
  drawerWidth,
  HISTORY_ROWS,
  NARROW,
  profileFor,
  sessionsHeight,
  surfaceWidth,
} from "./layout.ts";
import type { ReplSurface as ReplPlacedSurface, ReplSurfaceCell } from "./layout.ts";
import type { ReplTerminalSize } from "./terminal.ts";
import { decodeLocation, encodeLocation, NO_LIVE, resolveLocation } from "./route.ts";
import type {
  ReplDrawerRef,
  ReplLiveAvailability,
  ReplRoute,
  ReplSelection,
  ReplSurface,
} from "./route.ts";
import type { ReplAgentPermission, ReplAgentTurn, ReplModel, ReplRow, ReplScope } from "./model.ts";
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
import { DRAWER, FIELD, LINE, REFUSAL, SELECT_ROW } from "./components/rows.ts";
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
      observed.add(slot.durable);
    }
  }
  const shown: ReplSessionTurn[] = [];
  for (const turn of model.turns) {
    if (!observed.has(turn.name)) {
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
  const record = model.turns.find((candidate) => candidate.name === slot.durable);
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
 * separate numbers because both windows are open at once — a drawer scrolls the
 * request it is asking while the reading behind it keeps the row it was left on.
 *
 * Each is clamped where it is read, because publication, a filter, a background
 * change and a resize all change how many rows there are with nobody pressing
 * anything.
 */
export interface ReplViewports {
  /** Rows the Sessions reading is scrolled by. */
  readonly sessions: number;
  /** Rows the open permission drawer is scrolled by. */
  readonly permission: number;
}

/** Both windows at their first row, which is where a fresh reading starts. */
export const AT_TOP: ReplViewports = Object.freeze({ sessions: 0, permission: 0 });

/** Everything typed and not yet committed anywhere. */
export interface ReplState {
  readonly route: ReplRoute;
  /** The entry draft, before an entry exists. */
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
    };

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
      agent: NO_AGENT,
    }),
    location: encodeLocation(state.route),
    refusal: reason,
    size,
    focused: "refusal",
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
  // What the frame can hold, for the one decision that depends on it: how far
  // the drawer's content may be scrolled. Narrow is the smallest accepted
  // frame, so a caller that states none clamps to the tightest capacity.
  size: ReplTerminalSize = NARROW,
): ReplTransition {
  // Whoever pressed this key has moved on from wherever the last drawer put
  // focus, so the claim does not outlive the commit it was made for.
  const state =
    given.restore === undefined ? given : Object.freeze({ ...given, restore: undefined });
  const answering = state.route.drawers.some((drawer) => drawer.kind === "live-elicit");

  switch (action.kind) {
    case "type": {
      if (answering) {
        return editing(state, live, action.field, (value) => value + action.text);
      }
      if (model.entries.length > 0) {
        return refuse(state, "this execution has admitted its entry, and an entry is immutable.");
      }
      return drafting(state, state.draft + action.text);
    }
    case "erase": {
      if (answering) {
        return editing(state, live, action.field, shortened);
      }
      if (model.entries.length > 0) {
        return refuse(state, "this execution has admitted its entry, and an entry is immutable.");
      }
      return drafting(state, shortened(state.draft));
    }
    case "submit": {
      if (model.entries.length > 0) {
        return refuse(state, "this REPL admits one entry, and this execution has admitted it.");
      }
      if (state.draft.length === 0) {
        return refuse(state, "there is nothing to submit yet.");
      }
      // The draft stays until the entry exists. Clearing it here would lose
      // somebody's document to a preflight refusal, which is the one moment they
      // most need it back.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "submit", source: state.draft },
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
            "a historical view cannot answer the question this process is asking.",
          );
        }
        if (live.question === undefined) {
          return refuse(state, "nothing is being asked right now.");
        }
      }
      return navigate(
        state,
        model,
        { ...state.route, drawers: Object.freeze([...state.route.drawers, action.drawer]) },
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
      // Clamped against the reading this state actually has, and stored clamped:
      // an offset kept past the last window would take several presses to have
      // any visible effect, so what is held is what the region is showing.
      const rows = sessionContentRows(state, model, live);
      const furthest = Math.max(0, rows - sessionsCapacity(state, model, size));
      // From where the frame is, not from the number that was stored. A resize
      // changes what a window holds, and the region is already drawing the
      // clamped position — so a delta added to a stale larger number would
      // spend a press normalizing state nobody can see, and the screen would
      // not move.
      const sessions = clamped(
        clamped(state.viewports.sessions, furthest) + action.delta,
        furthest,
      );
      return settled({
        ...state,
        viewports: Object.freeze({ ...state.viewports, sessions }),
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
      if (open?.kind === "live-permission") {
        const pending =
          state.permission === undefined ? undefined : offered(state, live, state.permission);
        if (pending === undefined) {
          return refuse(state, "no permission request is being answered.");
        }
        // The same clamp, over the drawer's own ordered content: the kind, the
        // call, whose turn is waiting, every choice the provider offered and
        // what closing does.
        const rows = permissionContentRows(model, live, pending);
        const furthest = Math.max(0, rows - drawerCapacity(size));
        // From where the drawer is, for the same reason.
        const permission = clamped(
          clamped(state.viewports.permission, furthest) + action.delta,
          furthest,
        );
        return settled({
          ...state,
          viewports: Object.freeze({ ...state.viewports, permission }),
          refusal: undefined,
        });
      }
      if (!answering) {
        return refuse(state, "nothing is being asked right now.");
      }
      // Clamped at both ends, and stored clamped. An offset kept past the last
      // window would take several presses to have any visible effect, so the
      // value held is the one the region is actually showing.
      // Clamped against the whole ordered content, not only the message: the
      // viewport is what moves, and the form rows are inside it.
      const rows = drawerContentRows(live.question, state.form);
      const capacity = drawerCapacity(size);
      const furthest = Math.max(0, rows - capacity);
      const offset = Math.min(Math.max(0, state.form.offset + action.delta), furthest);
      return settled({
        ...state,
        form: Object.freeze({ ...state.form, offset }),
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

/** A cell the layout can place, with the key its description was given. */
interface Described {
  readonly key: string;
  readonly description: ReplDescription<ReplAction>;
}

function row(
  key: string,
  label: string,
  select: { readonly [name: string]: Json },
  options: {
    readonly focus?: true;
    readonly here?: string | undefined;
    /** The key this frame restores focus to, for the row that turns out to be it. */
    readonly claim?: string | undefined;
  } = {},
): Described {
  const claims = options.focus === true || options.claim === key;
  return {
    key,
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
  return caused === undefined ? undefined : `elicit:${caused.marker}`;
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
export function focusSettled(view: ReplView, focused: string | undefined): ReplState {
  const claim = focusClaim(view);
  if (view.state.restore === undefined || claim === undefined || focused !== claim) {
    return view.state;
  }
  return Object.freeze({ ...view.state, restore: undefined });
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

function line(key: string, label: string): Described {
  return {
    key,
    description: describeNode<ReplAction>({ key, component: LINE, input: { label } }),
  };
}

/**
 * A row of a drawer, padded so the drawer covers what it is in front of.
 *
 * A renderer writes what changed, so a row that only writes its own text leaves
 * whatever was underneath it visible from where its text ends — and a modal you
 * can read the transcript through is not a modal.
 */
function drawerLine(key: string, label: string, width: number): Described {
  return line(key, width < 1 ? label : label.padEnd(width, " "));
}

function field(
  key: string,
  prompt: string,
  text: string,
  purpose: "draft" | "answer",
  options: {
    readonly focus?: true;
    readonly here?: string | undefined;
    /** The form field this line edits, for a line that edits one. */
    readonly field?: string;
  } = {},
): Described {
  return {
    key,
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
 * Describe the whole screen.
 *
 * One flat set with keyed children for the drawer, because placement is not
 * nesting: where a row appears is the layout's decision, and the only nesting
 * that matters to the tree is what a modal must contain.
 */
export function describeApplication(view: ReplView): readonly ReplDescription<ReplAction>[] {
  return described(view).map((one) => one.description);
}

function described(view: ReplView): readonly Described[] {
  if (view.refusal !== undefined) {
    return [
      {
        key: "refusal",
        description: describeNode<ReplAction>({
          key: "refusal",
          component: REFUSAL,
          input: {
            label: view.refusal,
            // Somewhere to go only when there is somewhere: a cold open of a
            // history that cannot be read has no earlier view to return to.
            ...(view.state.route.at === undefined ? {} : { back: "live" }),
          },
          focus: true,
        }),
      },
    ];
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
  const toSessions = row(
    "sessions:heading",
    "Sessions",
    { select: "surface", surface: "sessions" },
    { here: view.focused },
  );
  const toEntries = row(
    "entries:heading",
    "Entries",
    { select: "surface", surface: "repl" },
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
    items.push(line("sessions:empty", "  (none retained)"));
  } else {
    // One window over the whole reading. Every conversation, turn, fact, audit
    // and request is built in order and then windowed: a list that described all
    // of them would have its tail placed nowhere, and a row layout cannot place
    // is not one a person can see, focus or point at.
    const content = sessionRows(state, turns, view.focused, claim);
    const capacity = sessionsCapacity(state, model, view.size);
    const from = clamped(state.viewports.sessions, Math.max(0, content.length - capacity));
    // Outside the thing they move, like the drawer's: a control inside the
    // window would scroll away from whoever was reaching for it.
    items.push(
      row(
        "sessions:earlier",
        "  [^ earlier]",
        { select: "scroll-sessions", delta: -1 },
        {
          here: view.focused,
        },
      ),
    );
    items.push(...content.slice(from, from + capacity));
    items.push(
      row(
        "sessions:later",
        "  [v later]",
        { select: "scroll-sessions", delta: 1 },
        {
          here: view.focused,
        },
      ),
    );
  }
  // Read whether or not this frame draws the entry list: the footer's draft says
  // whether an entry exists at every size and on either surface.
  const entry = model.entries[0]?.scope;
  if (!narrow) {
    items.push(toEntries);
  }
  if (showEntry) {
    if (entry === undefined) {
      items.push(line("entry:none", "  1. (not submitted)"));
    } else {
      items.push(
        row(
          "entry:1",
          `  1. ${entry.name}`,
          { select: "scope", scopes: [entry.key] },
          { here: view.focused },
        ),
      );
      for (const scope of nested(entry, [entry.key])) {
        items.push(
          row(
            `scope:${scope.path.join("/")}`,
            `    ${scope.label}`,
            {
              select: "scope",
              scopes: scope.path,
            },
            { here: view.focused },
          ),
        );
      }
    }
  }

  for (const [index, transcript] of showEntry ? model.transcript.entries() : []) {
    // One cell is one row, so a recorded row that holds several lines of output
    // becomes several cells. A cell given more than one line would show only the
    // first, which is the whole of what a reader would then believe was there.
    for (const [offset, text] of describeRow(transcript).split("\n").entries()) {
      items.push(line(`line:${index}:${offset}`, text));
    }
  }
  // The live overlay, explicitly below the recorded rows and explicitly labelled.
  // Once the durable close exists its recorded output is in the transcript and
  // this is empty, so the two never both claim to be the output.
  if (showEntry && live.output.length > 0) {
    for (const [offset, text] of live.output.split("\n").entries()) {
      items.push(line(`line:live:${offset}`, `… ${text}`));
    }
  }

  const scope = showEntry ? selection.scope : undefined;
  if (scope !== undefined) {
    for (const binding of scope.bindings) {
      items.push(
        row(
          `binding:${binding.name}`,
          `${binding.name} = ${summarize(binding.value)}`,
          {
            select: "binding",
            name: binding.name,
          },
          { here: view.focused },
        ),
      );
    }
    for (const elicitation of scope.elicitations) {
      items.push(
        row(
          `elicit:${elicitation.marker}`,
          `answered ${elicitation.location}`,
          {
            select: "recorded-elicit",
            marker: elicitation.marker,
          },
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
    {
      here: view.focused,
    },
  );
  const modal = view.selection.drawers.length > 0;
  if (!modal) {
    items.push(history);
  }
  if (state.route.at !== undefined) {
    items.push(row("footer:live", "[live]", { select: "live" }, { here: view.focused }));
  }
  if (live.pausable) {
    items.push(
      // The control is what it does; the state is what expansion is doing. One
      // label that changed between them would rename a control out from under
      // whoever was reaching for it.
      row(
        "footer:pause",
        live.expansion === "playing" ? "[pause]" : `[pause] ${live.expansion}`,
        { select: "pause" },
        { here: view.focused },
      ),
    );
    // Continue releases a continuation, so it exists exactly while one is
    // held. Expansion that is *pausing* holds nothing yet — the walks it asked
    // to stop have not all stopped — and a Continue offered there would cancel
    // the pause somebody just asked for rather than resume anything.
    if (live.expansion === "paused") {
      items.push(
        row("footer:continue", "[continue]", { select: "continue" }, { here: view.focused }),
      );
    }
  }
  if (live.question !== undefined && state.route.at === undefined) {
    items.push(
      row(
        "footer:asked",
        // One line, bounded. The whole message is in the drawer this opens; a
        // footer that drew every line of a Plan draft would be the transcript.
        `? ${headline(live.question.message)}`,
        { select: "live-elicit" },
        { here: view.focused, claim },
      ),
    );
  }

  // The canonical location: how a person comes back to exactly this view, here
  // or in another process. It goes above whatever surface is being shown rather
  // than in the footer, which is seven rows and has controls in them.
  for (const [offset, part] of locationRows(view.location, view.size).entries()) {
    items.push(line(`location:${offset}`, part));
  }

  // Why the last thing asked for changed nothing. Shown rather than swallowed: a
  // refusal nobody can read is a keystroke that appeared to do nothing.
  if (state.refusal !== undefined) {
    // One line: the footer is seven rows and the controls live in them, so a
    // refusal that wrapped would push the draft off the screen it is about.
    items.push(line("footer:refused", `! ${state.refusal.split("\n").join(" ")}`));
  }

  // The draft, which is where typing goes until an entry exists.
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
      entry === undefined ? "> " : "  ",
      entry === undefined ? state.draft : "(one entry admitted)",
      "draft",
      claiming ? { focus: true, here: view.focused } : { here: view.focused },
    ),
  );

  const drawer = drawerFor(view, history);
  if (drawer !== undefined) {
    items.push(drawer);
  }
  return items;
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
        { here: focused },
      ),
    );
    for (const key of offered) {
      items.push(
        row(
          `sessions:conversation:${key}`,
          `  ${filter === key ? "> " : ""}${headline(key)}`,
          { select: "session", session: key },
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
        `  ${headline(turn.prompt)} · ${stateOf(turn)}`,
        // A turn is read at the position its record holds; a live one has none
        // to go to yet, so it selects the surface it is already on.
        turn.marker === undefined
          ? { select: "surface", surface: "sessions" }
          : { select: "marker", marker: turn.marker },
        // A settled permission sends focus back to the turn that was waiting, so
        // this is the row that may be claimed.
        { here: focused, claim },
      ),
    );
    if (turn.agent !== undefined || turn.sessionKey !== undefined) {
      const said = [turn.agent, turn.sessionKey].filter((fact) => fact !== undefined);
      items.push(line(`sessions:turn:${turn.key}:whose`, `    ${said.join(" · ")}`));
    }
    if (turn.text.length > 0) {
      items.push(line(`sessions:turn:${turn.key}:text`, `    ${headline(turn.text)}`));
    }
    if (turn.stopReason !== undefined) {
      items.push(line(`sessions:turn:${turn.key}:stop`, `    stopped: ${turn.stopReason}`));
    }
    if (turn.failure !== undefined) {
      items.push(line(`sessions:turn:${turn.key}:failed`, `    ${headline(turn.failure)}`));
    }
    const request = turn.request;
    if (request !== undefined) {
      // Inline, on the turn that is waiting. Focusable where it can be answered
      // and a plain fact where it cannot: the grammar answers a request on the
      // Sessions surface, and a control that refused when activated would be a
      // target that does nothing. Either way, arriving here opens nothing —
      // somebody activates it.
      const label = `    asks: ${headline(request.title ?? request.toolCallId)}`;
      items.push(
        state.route.surface === "sessions"
          ? row(
              `sessions:request:${request.key}`,
              label,
              { select: "permission", request: request.key },
              { here: focused },
            )
          : line(`sessions:request:${request.key}`, label),
      );
    }
    for (const [at, audit] of turn.audits.entries()) {
      // Read, never answered: a record is what a turn was granted, and offering
      // a control here would invite somebody to answer a question nobody asked.
      items.push(
        line(
          `sessions:audit:${turn.key}:${at}`,
          `    granted: ${headline(audit.title ?? audit.toolCallId)} — ${outcomeOf(audit)}`,
        ),
      );
    }
  }
  return items;
}

/**
 * How many rows a narrow frame gives the canonical location.
 *
 * Three, and the region is thirteen. A narrow frame draws the location, both
 * surface controls, the two window controls and the routed outlet in one
 * region, so what the location takes is what the rest cannot have.
 */
const NARROW_LOCATION_ROWS = 3;

/**
 * The canonical location, as the rows one frame places it in.
 *
 * In full wherever there is room: it is the one thing a person copies out of
 * this screen, and a prefix of it takes them somewhere else. A narrow frame is
 * where there is not room — the location shares its region with every control
 * on the screen, and a draft long enough to fill that region would leave the
 * surface controls and the whole outlet mounted, focusable and drawn nowhere,
 * which is a screen with no way off it.
 *
 * So a narrow frame bounds it and says what it is not showing. A person who
 * cannot see the whole location can still read that fact and act on it; a
 * person whose controls are all off the bottom of the screen cannot do
 * anything at all.
 */
function locationRows(location: string, size: ReplTerminalSize): readonly string[] {
  const rows = chunked(location, surfaceWidth(size));
  if (profileFor(size) !== "narrow" || rows.length <= NARROW_LOCATION_ROWS) {
    return rows;
  }
  const shown = rows.slice(0, NARROW_LOCATION_ROWS - 1);
  const hidden = location.length - shown.join("").length;
  // To the same width as the rows above it. This is the one location row whose
  // length changes — a count that loses a digit makes it shorter — and what
  // this application describes is a complete row either way: `chunked` already
  // pads every ordinary one, and covering what a shorter row no longer reaches
  // is this boundary's job rather than something to leave to whichever renderer
  // happens to draw it. The renderer in use fills a placed cell to its bounds,
  // so it repaints this cleanly whether or not the row arrives padded; that is
  // its behavior, and this is the contract.
  return Object.freeze([
    ...shown,
    pad(`… ${hidden} more characters, in a wider window`, surfaceWidth(size)),
  ]);
}

/**
 * How many rows the Sessions reading holds, whatever the window shows.
 *
 * Counted by building the same rows the window slices, so the number a scroll
 * clamps against cannot disagree with the list it is clamping: one definition of
 * what the reading is, asked twice.
 */
function sessionContentRows(state: ReplState, model: ReplModel, live: ReplLive): number {
  return sessionRows(state, chronology(model, live), undefined, undefined).length;
}

/**
 * How many rows of the Sessions reading one frame can place.
 *
 * The region carries more than the reading. A narrow content region also holds
 * the canonical location and both surface controls; a sidebar also holds the
 * entry list under its own heading. Whatever is not the moving window is
 * subtracted, because a window sized by the whole region would push exactly
 * those controls out of the frame — and a described row nothing places is a
 * focus stop that draws nothing.
 *
 * At least one row: a window showing nothing would say the reading is empty.
 */
function sessionsCapacity(state: ReplState, model: ReplModel, size: ReplTerminalSize): number {
  const narrow = profileFor(size) === "narrow";
  const shared = narrow ? locationRows(encodeLocation(state.route), size).length : entryRows(model);
  // Both controls in a narrow frame, where they are one bar above the outlet.
  // In a sidebar the entry list brings its own heading, counted with it.
  const navigation = narrow ? 2 : 1;
  /** `[^ earlier]` and `[v later]`, which are how the window moves. */
  const controls = 2;
  return Math.max(1, sessionsHeight(size) - shared - navigation - controls);
}

/** How many rows the entry list takes in a sidebar, its heading included. */
function entryRows(model: ReplModel): number {
  const entry = model.entries[0]?.scope;
  return entry === undefined ? 2 : 2 + nested(entry, [entry.key]).length;
}

/**
 * How far one turn has got, in words a reader can act on.
 *
 * How it ended and whether the history holds it are separate facts, and a turn
 * that has finished is not the same as one that has been recorded: a person
 * looking at the second may go to its position, and a person looking at the
 * first is watching this process.
 */
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
 * Its detail is one child per line rather than one multi-line label, because a
 * cell is a row: a label holding three lines would show one of them, and a reader
 * would have no way to know the other two existed.
 */
function drawerFor(view: ReplView, history: Described): Described | undefined {
  const open = view.selection.drawers[view.selection.drawers.length - 1];
  if (open === undefined) {
    return undefined;
  }
  const children: ReplDescription<ReplAction>[] = [];
  // Every row of this drawer reaches its own right edge. A modal that wrote only
  // its own text would let what it is in front of show through from where that
  // text stopped, because a renderer writes what changed and nothing else.
  const width = drawerWidth(view.size);
  let title: string;
  /**
   * The request this drawer's close control denies, when it is one.
   *
   * A permission drawer closes by *answering* — dismissal is the direct denial
   * path the authority owns — so its close control carries the request rather
   * than the generic close action that means "this changed nothing".
   */
  let dismissing: string | undefined;

  if (open.kind === "binding") {
    title = open.name;
    for (const [offset, text] of detail(open.binding.value).entries()) {
      children.push(drawerLine(`drawer:value:${offset}`, text, width).description);
    }
  } else if (open.kind === "recorded-elicit") {
    title = open.elicitation.location;
    // The whole of what was asked and the whole of what was answered. A drawer is
    // where the retained value is, so a summary here would leave a reader with no
    // way to see what the record actually holds.
    children.push(drawerLine("drawer:schema", "schema", width).description);
    for (const [offset, text] of detail(open.elicitation.schema).entries()) {
      children.push(drawerLine(`drawer:schema:${offset}`, text, width).description);
    }
    children.push(drawerLine("drawer:answered", "answer", width).description);
    for (const [offset, text] of detail(open.elicitation.answer).entries()) {
      children.push(drawerLine(`drawer:answer:${offset}`, text, width).description);
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
    title = request.title ?? "Permission";
    // One window over the whole of it. `options` is the provider's, and nothing
    // bounds how many it offers: a drawer that described every choice would have
    // layout clip the last ones, which are exactly the ones a person scrolled
    // down to find.
    const content = permissionContent(view.model, view.live, request, width, view.focused);
    const capacity = drawerCapacity(view.size);
    const from = clamped(view.state.viewports.permission, Math.max(0, content.length - capacity));
    children.push(
      row(
        "drawer:scroll:up",
        pad("[^ earlier]", width),
        { select: "scroll", delta: -1 },
        { here: view.focused },
      ).description,
    );
    for (const placed of content.slice(from, from + capacity)) {
      children.push(placed);
    }
    children.push(
      row(
        "drawer:scroll:down",
        pad("[v later]", width),
        { select: "scroll", delta: 1 },
        { here: view.focused },
      ).description,
    );
    dismissing = request.key;
  } else if (open.kind === "history") {
    title = "History";
    for (const checkpoint of view.model.checkpoints) {
      children.push(
        row(
          `drawer:marker:${checkpoint.marker}`,
          width < 1 ? checkpoint.label : checkpoint.label.padEnd(width, " "),
          {
            select: "marker",
            marker: checkpoint.marker,
          },
          { here: view.focused },
        ).description,
      );
    }
  } else {
    const question = view.live.question;
    if (question === undefined) {
      return undefined;
    }
    const form = question.form;
    title = form.title ?? "Answer";
    // The whole message, every line of it, through a window that scrolls. A
    // drawer that showed only the first line — or only the first window —
    // would be hiding the draft the question is about.
    // One viewport over the whole ordered content. Everything a person has to
    // read or reach — the complete message, the form's description, every
    // field with its annotation, options, editable value, every validation
    // message and [submit] — is built in order and then windowed. A drawer too
    // short to hold all of it scrolls, rather than describing rows that layout
    // has no frame to place.
    const lines = question.message.split("\n");
    const capacity = drawerCapacity(view.size);
    const last = Math.max(0, drawerContentRows(question, view.state.form) - capacity);
    const from = Math.min(Math.max(0, view.state.form.offset), last);
    const until = from + capacity;
    const content: ReplDescription<ReplAction>[] = [];
    /** Whether the row about to be built lands inside the viewport. */
    const showing = (): boolean => content.length >= from && content.length < until;
    children.push(
      row(
        "drawer:scroll:up",
        pad("[^ earlier]", width),
        { select: "scroll", delta: -1 },
        {
          here: view.focused,
        },
      ).description,
    );
    for (const [offset, text] of lines.entries()) {
      content.push(drawerLine(`drawer:message:${offset}`, text, width).description);
    }
    if (form.description !== undefined) {
      content.push(drawerLine("drawer:form:about", form.description, width).description);
    }
    // The same rule inside the modal: the first control claims focus when the
    // drawer opens, and afterwards traversal inside the drawer owns it.
    const entering = view.focused === undefined || !view.focused.startsWith("drawer:");
    let claimed = false;
    for (const one of form.fields) {
      const value = view.state.form.values[one.name] ?? "";
      const marked = requiredNow(form, view.state.form.values, one) ? "*" : " ";
      const label = one.title ?? one.name;
      content.push(
        row(
          `drawer:field:${one.name}`,
          pad(`${marked}${label}: ${value}`, width),
          { select: "form-field", field: one.name },
          { here: view.focused },
        ).description,
      );
      if (one.description !== undefined) {
        content.push(
          drawerLine(`drawer:field:${one.name}:about`, `  ${one.description}`, width).description,
        );
      }
      if (one.choices !== undefined) {
        // What this field accepts, said once. The controls below are how a
        // value is chosen; this is the line that names the whole set, and it
        // is what a reader scanning the form reads first.
        content.push(
          drawerLine(`drawer:form:${one.name}`, `${one.name}: ${one.choices.join(" | ")}`, width)
            .description,
        );
      }
      // Every offered value, each its own control. A form that drew only the
      // first would be offering a choice nobody could make.
      for (const option of one.choices ?? []) {
        content.push(
          row(
            `drawer:choice:${one.name}:${option}`,
            pad(`  ${value === option ? "(x)" : "( )"} ${option}`, width),
            { select: "form-choice", field: one.name, option },
            { here: view.focused },
          ).description,
        );
      }
      // The one editable line for this field, which is where text and Backspace
      // land while it has focus. The first field's line claims focus when the
      // drawer opens — including an enum's, because typing an offered value and
      // pressing Enter is still a way to answer.
      // Claimed only by a row the viewport actually shows: focusing one that
      // scrolled out would put focus where nothing is placed.
      const takes = entering && !claimed && showing();
      const focus: { readonly focus?: true } = takes ? { focus: true } : {};
      if (takes) {
        claimed = true;
      }
      content.push(
        field(`drawer:value:${one.name}`, "  = ", value, "answer", {
          ...focus,
          here: view.focused,
        }).description,
      );
    }
    // What the last submission was told, under the form it is about.
    for (const [offset, message] of view.state.form.messages.entries()) {
      content.push(
        drawerLine(
          `drawer:invalid:${offset}`,
          message.field === undefined ? message.message : `${message.field}: ${message.message}`,
          width,
        ).description,
      );
    }
    content.push(
      row(
        "drawer:form:submit",
        pad("[submit]", width),
        { select: "form-submit" },
        {
          here: view.focused,
        },
      ).description,
    );
    // Only what the viewport holds becomes a placed cell. A row outside it is
    // not described at all, so it is neither drawn nor pointable.
    for (const placed of content.slice(from, until)) {
      children.push(placed);
    }
    children.push(
      row(
        "drawer:scroll:down",
        pad("[v later]", width),
        { select: "scroll", delta: 1 },
        {
          here: view.focused,
        },
      ).description,
    );
  }

  // The same node the footer would have drawn, inside the modal focus root.
  children.push(history.description);
  children.push(
    row(
      "drawer:close",
      width < 1 ? "[close]" : "[close]".padEnd(width, " "),
      dismissing === undefined
        ? { select: "close" }
        : { select: "permission-dismiss", request: dismissing },
      {
        here: view.focused,
      },
    ).description,
  );
  return {
    key: "drawer:open",
    description: describeNode<ReplAction>({
      key: "drawer:open",
      component: DRAWER,
      input: { label: width < 1 ? title : title.padEnd(width, " ") },
      children,
      modal: true,
    }),
  };
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
): readonly ReplDescription<ReplAction>[] {
  const content: ReplDescription<ReplAction>[] = [];
  // What is being asked, in the provider's own words. Never `rawInput` and
  // never the request object: a screen shows what a person decides about.
  if (request.kind !== undefined) {
    content.push(drawerLine("drawer:permission:kind", `  ${request.kind}`, width).description);
  }
  content.push(
    drawerLine("drawer:permission:call", `  call ${request.toolCallId}`, width).description,
  );
  // Whose turn is waiting, so a decision is not made about an anonymous one.
  const waiting = chronology(model, live).find((candidate) => candidate.key === request.turn);
  if (waiting !== undefined) {
    const whose =
      waiting.sessionKey === undefined
        ? headline(waiting.prompt)
        : `${headline(waiting.prompt)} · ${waiting.sessionKey}`;
    content.push(drawerLine("drawer:permission:turn", `  ${whose}`, width).description);
  }
  // Every choice the provider offered, in its order, each one its own control.
  for (const choice of request.choices) {
    content.push(
      row(
        `drawer:permission:choice:${choice.optionId}`,
        pad(`[${choice.name}]${lasting(choice.kind)}`, width),
        { select: "permission-choice", request: request.key, option: choice.optionId },
        { here: focused },
      ).description,
    );
  }
  // Said rather than implied: dismissing is a denial of this request, and the
  // session goes on running either way.
  content.push(
    drawerLine(
      "drawer:permission:dismissal",
      "  Escape or close denies this request; the session keeps running.",
      width,
    ).description,
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
 * The rows the drawer keeps whatever the viewport shows.
 *
 * Its own title row, the two scroll controls and `[close]`: how a person moves
 * the viewport and leaves, so none of them is ever inside the thing it moves.
 * `[history]` is not among them — it is reparented into the drawer's subtree so
 * it stays inside the active focus root, but layout places it in the footer
 * region, where it costs the drawer no row.
 */
const FIXED_DRAWER_ROWS = 4;

/**
 * How many rows of ordered content this drawer can place at this size.
 *
 * At least one, because a viewport showing nothing would say the question was
 * empty.
 */
function drawerCapacity(size: ReplTerminalSize): number {
  return Math.max(1, drawerHeight(size) - FIXED_DRAWER_ROWS);
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
function headline(message: string): string {
  const [first = ""] = message.split("\n");
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function pad(label: string, width: number): string {
  return width < 1 ? label : label.padEnd(width, " ");
}

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

/** One transcript row, as a line. */
function describeRow(entry: ReplRow): string {
  switch (entry.kind) {
    case "entry":
      return `entry ${entry.path}`;
    case "scope":
      return `${entry.scope} ${entry.name}`;
    case "binding":
      return `${entry.scope} bound ${entry.names.join(", ")}`;
    case "output":
      return entry.text;
    case "generated":
      return `generated ${entry.decision}${entry.source === undefined ? "" : `: ${entry.source}`}`;
    case "elicit":
      return `answered ${entry.location} ${summarize(entry.answer)}`;
    case "agent":
      return `agent ${entry.turn.agent} ${entry.turn.status}`;
    case "effect":
      return `${entry.type} ${entry.status}`;
    case "terminal":
      return entry.output.length > 0 ? entry.output : `closed ${entry.status}`;
  }
}

/**
 * The surface one committed tree presents.
 *
 * Read from the frame, so a node the tree removed contributes nothing, and keyed
 * by the description's own key so the region a row belongs to is decided in one
 * place. The live node id travels with every cell, because that id is what a
 * pointer resolved against the drawn frame has to name.
 */
export function replSurface(tree: ReplTree<ReplAction>, view: ReplView): ReplPlacedSurface {
  const controls = controlsOf(view);
  /** The two surface controls, which belong to neither outlet. */
  const navigation: ReplSurfaceCell[] = [];
  const sessions: ReplSurfaceCell[] = [];
  /** The Sessions outlet without the heading above it. */
  const sessionsBody: ReplSurfaceCell[] = [];
  const entries: ReplSurfaceCell[] = [];
  /** The entry outlet without the heading above it. */
  const entriesBody: ReplSurfaceCell[] = [];
  const transcript: ReplSurfaceCell[] = [];
  const inspection: ReplSurfaceCell[] = [];
  const drawer: ReplSurfaceCell[] = [];
  const footer: ReplSurfaceCell[] = [];
  /** The location rows, which sit above whatever surface is being shown. */
  const located: ReplSurfaceCell[] = [];
  for (const cell of tree.frame().cells) {
    const key = tree.keyOf(cell.node);
    if (key === undefined) {
      continue;
    }
    const placed: ReplSurfaceCell = {
      node: cell.node,
      text: cell.cell,
      ...(controls.has(key) ? { targetable: true } : {}),
    };
    if (key.startsWith("drawer:")) {
      drawer.push(placed);
    } else if (key.startsWith("location:")) {
      located.push(placed);
    } else if (key === "sessions:heading" || key === "entries:heading") {
      // In both: a sidebar keeps each heading with the list it names, and a
      // narrow frame shows the pair as the bar above whichever outlet is routed.
      navigation.push(placed);
      (key === "sessions:heading" ? sessions : entries).push(placed);
    } else if (key.startsWith("sessions:")) {
      sessions.push(placed);
      sessionsBody.push(placed);
    } else if (key.startsWith("entries:") || key.startsWith("entry:") || key.startsWith("scope:")) {
      entries.push(placed);
      entriesBody.push(placed);
    } else if (key.startsWith("line:")) {
      transcript.push(placed);
    } else if (key.startsWith("binding:") || key.startsWith("elicit:")) {
      inspection.push(placed);
    } else if (key.startsWith("footer:") || key === "refusal") {
      footer.push(placed);
    }
  }

  return {
    // Narrow shows exactly the surface the route selected, under navigation that
    // is on neither of them: the outlet is what the route chooses, and the way
    // out of it cannot be inside it.
    content: [
      ...located,
      ...navigation,
      ...(view.state.route.surface === "sessions" ? sessionsBody : entriesBody),
    ],
    sessions,
    entries,
    transcript: [...located, ...transcript],
    inspection,
    drawer,
    footer,
    // The band's labels come from the model rather than from mounted nodes: a
    // history position is a place in the file, and offering twenty of them as
    // twenty focus stops in a seven-row footer would bury the controls that are
    // actually there. Selecting an exact one is what the History drawer is for.
    history: view.model.checkpoints.map((checkpoint) => ({
      marker: checkpoint.marker,
      label: checkpoint.label,
    })),
  };
}

/**
 * Which of this view's rows a pointer may activate.
 *
 * Read from what each row *is* — the component it was described with — rather
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
function controlsOf(view: ReplView): ReadonlySet<string> {
  const keys = new Set<string>();
  const walk = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    if (read.component === SELECT_ROW || read.component === FIELD) {
      keys.add(read.key);
    } else if (read.component === REFUSAL && fields(read.input)?.["back"] !== undefined) {
      // A refusal is a control only when it offers somewhere to go back to.
      keys.add(read.key);
    }
    for (const child of read.children) {
      walk(child);
    }
  };
  for (const description of describeApplication(view)) {
    walk(description);
  }
  return keys;
}

export { HISTORY_ROWS };
export type { ReplDrawerRef, ReplSurface };
