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

import { describe as describeNode } from "./description.ts";
import type { ReplDescription } from "./description.ts";
import { drawerWidth, HISTORY_ROWS, NARROW, surfaceWidth } from "./layout.ts";
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
import type { ReplModel, ReplRow, ReplScope } from "./model.ts";
import type { ReplQuestion } from "./elicitation.ts";
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
}

/** Everything typed and not yet committed anywhere. */
export interface ReplState {
  readonly route: ReplRoute;
  /** The entry draft, before an entry exists. */
  readonly draft: string;
  /** The answer being typed into the waiting question. */
  readonly answer: string;
  /** Why the last action changed nothing, or none. */
  readonly refusal: string | undefined;
}

/** What the root must perform, because a component cannot. */
export type ReplIntent =
  | { readonly kind: "none" }
  | { readonly kind: "submit"; readonly source: string }
  | { readonly kind: "pause" }
  | { readonly kind: "continue" }
  | { readonly kind: "answer"; readonly choice: string };

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
 * The question is over, so the drawer that was asking it is over too. Leaving
 * `+elicit` in the route would print a location naming a drawer the topology no
 * longer mounts — a URL that describes a screen nobody can be shown — and
 * leaving the typed text in `answer` would offer it again as though it were
 * still waiting to be sent.
 */
export function answered(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    answer: "",
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze(state.route.drawers.filter((drawer) => drawer.kind !== "live-elicit")),
    }),
    refusal: undefined,
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
    answer: "",
    refusal: undefined,
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
      answer: "",
      refusal: undefined,
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
  const resolved = resolveLocation(model, state.route, availabilityOf(live));
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
 * A live question is the only one of them this slice has: no Agent runtime runs
 * in the REPL yet, so there is no pending permission request and no conversation
 * that has started without settling anything.
 */
function availabilityOf(live: ReplLive): ReplLiveAvailability {
  return {
    elicit: live.question !== undefined,
    permission: false,
    sessions: NO_LIVE.sessions,
  };
}

const EMPTY_MODEL: ReplModel = Object.freeze({
  selection: undefined,
  head: true,
  entry: undefined,
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
  state: ReplState,
  action: ReplAction,
  model: ReplModel,
  live: ReplLive,
): ReplTransition {
  const answering = state.route.drawers.some((drawer) => drawer.kind === "live-elicit");

  switch (action.kind) {
    case "type": {
      if (answering) {
        return settled({ ...state, answer: state.answer + action.text, refusal: undefined });
      }
      if (model.entry !== undefined) {
        return refuse(state, "this execution has admitted its entry, and an entry is immutable.");
      }
      return drafting(state, state.draft + action.text);
    }
    case "erase": {
      if (answering) {
        return settled({ ...state, answer: shortened(state.answer), refusal: undefined });
      }
      if (model.entry !== undefined) {
        return refuse(state, "this execution has admitted its entry, and an entry is immutable.");
      }
      return drafting(state, shortened(state.draft));
    }
    case "submit": {
      if (model.entry !== undefined) {
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
      const remaining = Object.freeze(state.route.drawers.slice(0, -1));
      const closed = navigate(state, model, { ...state.route, drawers: remaining }, live);
      // Dismissing the question's drawer discards what was typed into it. It is
      // not an answer, and keeping it would offer it again as though it were.
      return closing.kind === "live-elicit"
        ? { ...closed, state: Object.freeze({ ...closed.state, answer: "" }) }
        : closed;
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
      if (state.answer.length === 0) {
        return refuse(state, "type one of the offered choices first.");
      }
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "answer", choice: state.answer },
      };
    }
  }
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
  const resolved = resolveLocation(model, route, availabilityOf(live));
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
  options: { readonly focus?: true; readonly here?: string | undefined } = {},
): Described {
  return {
    key,
    description: describeNode<ReplAction>({
      key,
      component: SELECT_ROW,
      input: { label, ...select, ...(options.here === key ? { focused: true } : {}) },
      ...(options.focus === undefined ? {} : { focus: options.focus }),
    }),
  };
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
  options: { readonly focus?: true; readonly here?: string | undefined } = {},
): Described {
  return {
    key,
    description: describeNode<ReplAction>({
      key,
      component: FIELD,
      input: { prompt, text, purpose, ...(options.here === key ? { focused: true } : {}) },
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

  items.push(
    row(
      "sessions:heading",
      "Sessions",
      { select: "surface", surface: "sessions" },
      { here: view.focused },
    ),
  );
  // Present and empty. This REPL keeps one execution per invocation, and a
  // Sessions surface that vanished when it held nothing would read as a feature
  // that does not exist.
  items.push(line("sessions:empty", "  (none retained)"));
  items.push(
    row(
      "entries:heading",
      "Entries",
      { select: "surface", surface: "repl" },
      { here: view.focused },
    ),
  );

  const entry = model.entry;
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

  for (const [index, transcript] of model.transcript.entries()) {
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
  if (live.output.length > 0) {
    for (const [offset, text] of live.output.split("\n").entries()) {
      items.push(line(`line:live:${offset}`, `… ${text}`));
    }
  }

  const scope = selection.scope;
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
          { here: view.focused },
        ),
      );
    }
  }

  // The way into history. The band above shows where the positions are; choosing
  // an exact one is a drawer, because a position is something you select and the
  // band is something you read.
  items.push(row("footer:history", "[history]", { select: "history" }, { here: view.focused }));
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
        `? ${live.question.message}`,
        { select: "live-elicit" },
        { here: view.focused },
      ),
    );
  }

  // The canonical location, as it stands and in full. It is the one thing a
  // person copies out of this screen — how they come back to exactly this view,
  // here or in another process — so a prefix of it is no use to them. A location
  // carrying a draft is longer than a row, so it is as many rows as it needs,
  // above whatever surface is being shown rather than in the footer, which is
  // seven rows and has controls in them.
  for (const [offset, part] of chunked(view.location, surfaceWidth(view.size)).entries()) {
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
  const claiming = state.route.drawers.length === 0 && view.focused === undefined;
  items.push(
    field(
      "footer:input",
      entry === undefined ? "> " : "  ",
      entry === undefined ? state.draft : "(one entry admitted)",
      "draft",
      claiming ? { focus: true, here: view.focused } : { here: view.focused },
    ),
  );

  const drawer = drawerFor(view);
  if (drawer !== undefined) {
    items.push(drawer);
  }
  return items;
}

/**
 * The innermost open drawer, as a modal branch holding its own controls.
 *
 * Its detail is one child per line rather than one multi-line label, because a
 * cell is a row: a label holding three lines would show one of them, and a reader
 * would have no way to know the other two existed.
 */
function drawerFor(view: ReplView): Described | undefined {
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
    title = question.message;
    // The retained normalized schema, as a form: the one field it asks for and
    // the exact values it will accept.
    children.push(
      drawerLine(
        "drawer:form",
        `${question.form.field}: ${question.form.choices.join(" | ")}`,
        width,
      ).description,
    );
    // The same rule inside the modal: the field claims focus when the drawer
    // opens, and afterwards traversal inside the drawer owns it.
    const entering = view.focused === undefined || !view.focused.startsWith("drawer:");
    const claim: { readonly focus?: true } = entering ? { focus: true } : {};
    children.push(
      field("drawer:answer", "= ", view.state.answer, "answer", {
        ...claim,
        here: view.focused,
      }).description,
    );
  }

  children.push(
    row(
      "drawer:close",
      width < 1 ? "[close]" : "[close]".padEnd(width, " "),
      { select: "close" },
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
  const sessions: ReplSurfaceCell[] = [];
  const entries: ReplSurfaceCell[] = [];
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
      ...(targetable(key) ? { targetable: true } : {}),
    };
    if (key.startsWith("drawer:")) {
      drawer.push(placed);
    } else if (key.startsWith("location:")) {
      located.push(placed);
    } else if (key.startsWith("sessions:")) {
      sessions.push(placed);
    } else if (key.startsWith("entries:") || key.startsWith("entry:") || key.startsWith("scope:")) {
      entries.push(placed);
    } else if (key.startsWith("line:")) {
      transcript.push(placed);
    } else if (key.startsWith("binding:") || key.startsWith("elicit:")) {
      inspection.push(placed);
    } else if (key.startsWith("footer:") || key === "refusal") {
      footer.push(placed);
    }
  }

  return {
    // Narrow shows exactly the surface the route selected.
    content: [...located, ...(view.state.route.surface === "sessions" ? sessions : entries)],
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

/** Whether a pointer may activate the row this key names. */
function targetable(key: string): boolean {
  // A line is text. Everything a pointer may activate is a control, and the two
  // footer lines that are not — the location somebody copies and the reason the
  // last action changed nothing — are lines.
  return (
    !key.startsWith("line:") &&
    key !== "sessions:empty" &&
    key !== "entry:none" &&
    key !== "footer:location" &&
    key !== "footer:refused"
  );
}

export { HISTORY_ROWS };
export type { ReplDrawerRef, ReplSurface };
