/**
 * What the interface is showing, as data a component may be handed.
 *
 * `ReplView` is the one immutable projection between the fixtures and the
 * component tree. It is built above the tree and flows down through it, and it
 * carries **semantic content only** — identity, text, lifecycle, selection and
 * redaction. It carries no journal, no store handle, no Freedom node, no
 * terminal geometry, no callback and no way to mutate anything, because a
 * component that could reach any of those could act on the application without
 * saying so as an action.
 *
 * The subtrees are isolated on purpose: a component receives its own and
 * nothing else, so what it can render is bounded by what it was given rather
 * than by what it remembered to ignore.
 */

import type { Binding, Checkpoint, Phase, TranscriptRow } from "./model.ts";
import { isDrawerKind } from "./fixtures.ts";
import type { DrawerKind } from "./fixtures.ts";
import { siblingsOf } from "./journal.ts";
import type { Moment } from "./journal.ts";
import { ROUTE_SURFACES } from "./route.ts";
import type { Route, RouteSurface } from "./route.ts";
import { fixtureFor } from "./store.ts";
import type { ReplState } from "./store.ts";

/** A value a component must not be able to reveal, whatever it renders. */
export interface Redacted {
  readonly redacted: true;
  /** What kind of answer is required, which is all a person may be told. */
  readonly kind: "secret";
  readonly state: "required" | "answered";
}

export function isRedacted(value: unknown): value is Redacted {
  return typeof value === "object" && value !== null && "redacted" in value;
}

export interface SessionView {
  readonly id: string;
  readonly agent: string;
  readonly state: "queued" | "active" | "completed";
  readonly label: string;
  readonly turn: string;
  readonly selected: boolean;
  readonly note?: string;
}

export interface SessionsView {
  readonly tab: "sessions" | "journal" | "state";
  readonly heading?: string;
  readonly subheading?: string;
  readonly placeholder: readonly string[];
  readonly sessions: readonly SessionView[];
  /** The recorded markers, when the sidebar is showing the journal. */
  readonly markers: readonly MarkerView[];
}

export interface MarkerView {
  readonly id: string;
  readonly at: number;
  readonly label: string;
  readonly scope: string;
  readonly depth: number;
  readonly boundary: boolean;
  readonly selected: boolean;
  /** True for a marker recorded after the one being inspected. */
  readonly later: boolean;
  readonly records: readonly string[];
}

/** One visible scope inside an entry: the unit the router mounts. */
export interface ScopeView {
  readonly id: string;
  readonly name: string;
  readonly phase: Phase;
  readonly rows: readonly TranscriptRow[];
  readonly scopes: readonly ScopeView[];
}

export interface TranscriptView {
  readonly entry?: {
    readonly id: string;
    readonly title: string;
    readonly state: "running" | "completed";
    readonly elapsed: string;
    readonly scopeNote: string;
  };
  readonly rows: readonly TranscriptRow[];
  /** The visible scopes the route may address, in source order. */
  readonly scopes: readonly ScopeView[];
  readonly placeholder: readonly string[];
  readonly readOnly: boolean;
}

export interface BindingsView {
  readonly scopeName: string;
  readonly bindings: readonly (Binding | Redacted)[];
  readonly placeholder: readonly string[];
}

export interface ControlView {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}

/**
 * One suspension's drawer, as content rather than as a form.
 *
 * The shape follows the study's three drawers. `historical` says the drawer is
 * a recording: every control is disabled and the components render what was
 * recorded rather than an affordance that would do nothing.
 */
export type DrawerView = {
  readonly heading: string;
  readonly origin: string;
  readonly controls: readonly ControlView[];
  readonly historical: boolean;
} & (
  | {
      readonly kind: "project";
      readonly prompt: string;
      readonly fields: readonly { readonly label: string; readonly value: string }[];
      readonly schema: readonly string[];
      readonly validation: string;
      readonly submit: string;
    }
  | {
      readonly kind: "review";
      readonly plan: readonly string[];
      readonly more: string;
      readonly decisions: readonly {
        readonly label: string;
        readonly chosen: boolean;
        readonly note?: string;
      }[];
      readonly submit: string;
    }
  | {
      readonly kind: "confirm";
      readonly prompt: string;
      readonly preview: readonly string[];
      readonly actions: readonly { readonly label: string; readonly primary: boolean }[];
      readonly hint: string;
    }
);

export interface InputView {
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly draft: string;
  readonly run?: ControlView;
}

export interface ContextualView {
  /** The drawer stack. Only the last is visible and interactive. */
  readonly drawers: readonly DrawerView[];
  readonly input: InputView;
}

export interface HistoryView {
  /** The entry the band is recording, for the line under its label. */
  readonly entryId?: string;
  readonly elapsed: string;
  readonly headAt: number;
  readonly selectedAt?: number;
  readonly transport: Moment["transport"];
  readonly controls: readonly ControlView[];
  readonly markers: readonly MarkerView[];
  readonly compressed?: { readonly at: number; readonly note: string };
}

export interface ReplView {
  readonly execution: string;
  readonly surface: RouteSurface;
  readonly crumb: string;
  readonly badge?: string;
  /** What the interface last refused, in words. Empty where it refused nothing. */
  readonly notice: string;
  /** What a route may address in this projection. */
  readonly located: ViewIndex;
  readonly sessions: SessionsView;
  readonly transcript: TranscriptView;
  readonly bindings: BindingsView;
  readonly contextual: ContextualView;
  readonly history: HistoryView;
}

/**
 * One place a route may address, and the places inside it.
 *
 * A tree rather than a list, because a scope is only where it actually is. A
 * flattened set would accept `document/plan` and `plan/document` alike, and one
 * of those is a location the execution never went.
 */
export interface ScopeLocation {
  readonly id: string;
  readonly scopes: readonly ScopeLocation[];
}

/**
 * The identities this projection represents, so the router can refuse the rest.
 *
 * It is part of the view because the view is what the interface is showing, and
 * a URL may address exactly what is shown. The router reads this and nothing
 * else — no journal, no fixture, no store.
 *
 * These are **not** the display identities beside them. A `ScopeView` is named
 * by the authored component it came from; this is named by the segment a URL
 * spells it with, which is the execution's own scope name.
 */
export interface ViewIndex {
  readonly surfaces: readonly RouteSurface[];
  /** The entry, by the name a route spells it with. Absent until one is submitted. */
  readonly entry?: string;
  readonly scopes: readonly ScopeLocation[];
  readonly markers: readonly string[];
  /** What a drawer segment may name here. Empty while nothing is waiting. */
  readonly drawers: readonly DrawerKind[];
}

/**
 * The band's own view of a fixture's recorded history.
 *
 * Exported because the composition path that still draws from rectangles needs
 * exactly this projection, and two projections of the same thing would be two
 * answers. It goes when that path does.
 */
export function historyViewFrom(
  subject: ReturnType<typeof fixtureFor>,
  transport: Moment["transport"],
  controls: readonly ControlView[],
  /** Which recorded second is selected, when it is not the fixture's own. */
  selectedAt?: number,
): HistoryView {
  const selected = selectedAt ?? subject.history.selectedAt;
  return {
    entryId: subject.entry?.id,
    elapsed: subject.history.elapsed,
    headAt: subject.history.headAt,
    selectedAt: selected,
    transport,
    controls,
    markers: subject.history.checkpoints.map((point) => ({
      id: `cp-${point.at}`,
      at: point.at,
      label: point.label,
      scope: point.scope,
      depth: point.depth,
      boundary: point.kind === "entry",
      selected: selected !== undefined && point.at === selected,
      later: selected !== undefined && point.at > selected,
      records: point.records,
    })),
    compressed: subject.history.compressed,
  };
}

/** Which recorded markers the sidebar and the band show, and how. */
function markersOf(state: ReplState): MarkerView[] {
  const subject = fixtureFor(state);
  const selected = subject.history.selectedAt;
  return subject.history.checkpoints.map((point: Checkpoint) => ({
    id: `cp-${point.at}`,
    at: point.at,
    label: point.label,
    scope: point.scope,
    depth: point.depth,
    boundary: point.kind === "entry",
    selected: selected !== undefined && point.at === selected,
    later: selected !== undefined && point.at > selected,
    records: point.records,
  }));
}

/**
 * The visible scopes of an entry, in source order.
 *
 * Only a component with a body is a visible nesting level, which is what the
 * router addresses and what the scrubber's notch height follows. An invisible
 * helper scope produces no level here, and therefore no marker and no nesting.
 */
function scopesFrom(subject: ReturnType<typeof fixtureFor>): ScopeView[] {
  const rows = subject.entry?.rows ?? [];
  // Built mutably and frozen on the way out: a view is immutable to everything
  // that receives it, and this is the one place that is true by construction
  // rather than by everyone remembering.
  interface Building {
    readonly id: string;
    readonly name: string;
    readonly phase: Phase;
    readonly rows: TranscriptRow[];
    readonly scopes: Building[];
  }
  const opened: Building[] = [];
  const stack: Building[] = [];
  for (const row of rows) {
    if (row.kind !== "lifecycle" || row.pair === undefined) {
      stack[stack.length - 1]?.rows.push(row);
      continue;
    }
    if (row.close) {
      stack.pop();
      continue;
    }
    const scope: Building = {
      id: row.pair,
      name: row.source.trim(),
      phase: row.phase,
      rows: [],
      scopes: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.scopes.push(scope);
    } else {
      opened.push(scope);
    }
    stack.push(scope);
  }
  const settle = (built: Building): ScopeView => ({
    id: built.id,
    name: built.name,
    phase: built.phase,
    rows: built.rows,
    scopes: built.scopes.map(settle),
  });
  return opened.map(settle);
}

function controlsFor(transport: Moment["transport"], recorded: boolean): ControlView[] {
  if (!recorded) {
    return [];
  }
  if (transport === "live") {
    return [{ id: "control:transport.pause", label: "Pause", enabled: true }];
  }
  if (transport === "paused") {
    return [
      { id: "control:transport.continue", label: "Continue", enabled: true },
      { id: "control:transport.return-head", label: "Return to paused head", enabled: true },
    ];
  }
  if (transport === "inspecting") {
    return [
      { id: "control:transport.continue", label: "Continue", enabled: false },
      { id: "control:transport.return-head", label: "Return to paused head", enabled: true },
      { id: "control:transport.fork", label: "Fork from here", enabled: true },
    ];
  }
  return [];
}

/**
 * One state, projected into the view its components are handed.
 *
 * Everything below this line is data. Nothing a component receives from here
 * can reach the journal, the store, the tree or the terminal.
 */
/**
 * Where a route may go, read off the execution that happened.
 *
 * The scopes come back as a tree because that is what they are: a scope is only
 * inside the parent that opened it, and asking `siblingsOf` level by level is
 * what keeps `document/plan` from meaning the same as `plan/document`.
 */
function locate(journal: ReplState["journal"], parents: readonly string[]): ScopeLocation[] {
  return siblingsOf(journal, parents).map((id) => ({
    id,
    scopes: locate(journal, [...parents, id]),
  }));
}

/**
 * The drawer a route may open here.
 *
 * The suspension at this moment, and only this one. A reconstruction shows what
 * was waiting at the checkpoint it reconstructs — scanning the journal for any
 * suspension that eventually existed would let a URL open a form at a moment
 * before the question had been asked.
 *
 * It comes from the fold because the journal is the only thing that knows.
 * `contextual.drawers` is the other half of the projection — what is drawn —
 * and it is open because the URL says so, which is why the router may not read
 * it to decide whether the URL is allowed.
 */
function drawersAt(state: ReplState): DrawerKind[] {
  return state.moment.suspension === undefined ? [] : [state.moment.suspension];
}

export function locationsOf(state: ReplState): ViewIndex {
  return {
    surfaces: [...ROUTE_SURFACES],
    // One entry at a time in this study, so there is one name — and it is there
    // because something was submitted, not because a URL was well formed.
    entry: state.journal.some((record) => record.kind === "entry.submitted")
      ? "entry-1"
      : undefined,
    scopes: locate(state.journal, []),
    markers: state.journal.map((record) => record.marker),
    drawers: drawersAt(state),
  };
}

export function project(state: ReplState): ReplView {
  const subject = fixtureFor(state);
  return projectFixture(subject, {
    located: locationsOf(state),
    execution: state.route.execution,
    surface: state.route.surface,
    scopes: state.route.scopes,
    drawerOpen: state.route.drawers.length > 0,
    inspect: state.route.inspect,
    draft: state.route.draft,
    transport: state.moment.transport,
    running: state.moment.entry === "running",
    selectedAt: undefined,
    notice: state.notice,
  });
}

/**
 * What a projection needs beyond the fixture itself.
 *
 * Kept explicit so the same projector serves a live state and a fixture that
 * was never routed to — the #838 captures are of a moment, not of a location,
 * and one projector for both is what keeps them the same interface.
 */
export interface ProjectionInputs {
  readonly execution: string;
  readonly surface: RouteSurface;
  readonly scopes: readonly string[];
  readonly drawerOpen: boolean;
  readonly inspect: boolean;
  readonly draft: string;
  readonly transport: Moment["transport"];
  readonly running: boolean;
  /** Overrides the fixture's own selected second, for a capture that chose one. */
  readonly selectedAt?: number;
  /** What the interface last refused. A capture of a moment refused nothing. */
  readonly notice?: string;
  /**
   * What a route may address here.
   *
   * A view of a fixture is a view of one moment rather than of a location, so
   * it represents exactly the route it was projected for — nothing resolves
   * against it, and a capture has no URL to refuse.
   */
  readonly located?: ViewIndex;
}

export function projectFixture(
  subject: ReturnType<typeof fixtureFor>,
  inputs: ProjectionInputs,
): ReplView {
  const route = {
    execution: inputs.execution,
    surface: inputs.surface,
    scopes: inputs.scopes,
    inspect: inputs.inspect,
    draft: inputs.draft,
  };
  const history = historyViewFrom(
    subject,
    inputs.transport,
    controlsFor(inputs.transport, inputs.running || subject.entry !== undefined),
    inputs.selectedAt,
  );
  const markers = history.markers;
  // The button is drawn whenever the fixture offers it. Whether `Run` joins the
  // focus ring is a different question, asked of the tree: #838 draws the
  // affordance, #839 decides when Tab may land on it.
  const runnable = subject.input.runEnabled;
  const drawers =
    inputs.drawerOpen && subject.drawer !== undefined
      ? [drawerViewFrom(subject.drawer, inputs.inspect)]
      : [];
  return {
    execution: route.execution,
    surface: route.surface,
    crumb: subject.crumb,
    badge: subject.badge,
    notice: inputs.notice ?? "",
    located: inputs.located ?? {
      surfaces: [...ROUTE_SURFACES],
      entry: inputs.scopes[0],
      scopes: [],
      markers: [],
      drawers: subject.drawer === undefined ? [] : [subject.drawer.kind],
    },
    sessions: {
      tab: subject.sidebar.tab,
      heading: subject.sidebar.heading,
      subheading: subject.sidebar.subheading,
      placeholder: subject.sidebar.placeholder ?? [],
      sessions: subject.sessions.map((session) => ({
        id: session.id,
        agent: session.agent,
        state: session.state,
        label: session.label,
        turn: session.turn,
        selected: session.selected === true,
        note: session.note,
      })),
      markers,
    },
    transcript: {
      entry:
        subject.entry === undefined
          ? undefined
          : {
              id: subject.entry.id,
              title: subject.entry.title,
              state: subject.entry.state,
              elapsed: subject.entry.elapsed,
              scopeNote: subject.entry.scopeNote,
            },
      rows: subject.entry?.rows ?? [],
      scopes: scopesFrom(subject),
      placeholder:
        subject.entry === undefined
          ? [
              "Submitted blocks append here as immutable entries. Each entry keeps its source, its rendered output, and the bindings it published.",
            ]
          : [],
      readOnly: subject.readOnly === true,
    },
    bindings: {
      scopeName: subject.bindings.scopeName,
      bindings: subject.bindings.bindings,
      placeholder: subject.bindings.placeholder ?? [],
    },
    contextual: {
      drawers,
      input: {
        label: subject.input.label,
        hint: subject.input.hint,
        placeholder: subject.input.placeholder ?? "",
        draft: route.draft,
        run: runnable ? { id: "control:input.run", label: "Run", enabled: true } : undefined,
      },
    },
    history,
  };
}

export function drawerViewFrom(
  drawer: NonNullable<ReturnType<typeof fixtureFor>["drawer"]>,
  historical: boolean,
): DrawerView {
  const shared = { heading: drawer.heading, origin: drawer.origin, historical };
  const control = (id: string, label: string): ControlView => ({
    id,
    label,
    enabled: !historical,
  });
  if (drawer.kind === "project") {
    return {
      ...shared,
      kind: "project",
      prompt: drawer.prompt,
      fields: drawer.fields,
      schema: drawer.schema,
      validation: drawer.validation,
      submit: drawer.submit,
      controls: [
        control("field:drawer.project.name", "Project name"),
        control("field:drawer.project.description", "Description"),
        control("control:drawer.project.schema", "Schema disclosure · ⌥S"),
        control("control:drawer.project.submit", "Submit"),
      ],
    };
  }
  if (drawer.kind === "review") {
    return {
      ...shared,
      kind: "review",
      plan: drawer.plan,
      more: drawer.more,
      decisions: drawer.decisions,
      submit: drawer.submit,
      controls: [
        control("control:drawer.review.scroll", "Plan review · scroll region"),
        control("control:drawer.review.approve", "Approve"),
        control("control:drawer.review.request", "Request changes"),
        control("control:drawer.review.stop", "Stop"),
        control("control:drawer.review.submit", "Submit"),
      ],
    };
  }
  return {
    ...shared,
    kind: "confirm",
    prompt: drawer.prompt,
    preview: drawer.preview,
    actions: drawer.actions,
    hint: drawer.hint,
    controls: [
      control("control:drawer.confirm.preview", "README preview · scroll region"),
      control("control:drawer.confirm.approve", "Approve"),
      control("control:drawer.confirm.decline", "Decline"),
    ],
  };
}
