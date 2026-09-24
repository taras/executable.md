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
import type { DrawerKind } from "./fixtures.ts";
import type { Moment } from "./journal.ts";
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
  readonly sessions: SessionsView;
  readonly transcript: TranscriptView;
  readonly bindings: BindingsView;
  readonly contextual: ContextualView;
  readonly history: HistoryView;
}

/** The identities a route may address, so the router can refuse what is absent. */
export interface ViewIndex {
  readonly surfaces: readonly RouteSurface[];
  readonly scopes: readonly string[];
  readonly markers: readonly string[];
  readonly drawers: readonly DrawerKind[];
}

function scopeIds(scopes: readonly ScopeView[]): string[] {
  return scopes.flatMap((scope) => [scope.id, ...scopeIds(scope.scopes)]);
}

export function indexOf(view: ReplView): ViewIndex {
  return {
    surfaces: ["sessions", "transcript", "bindings", "input", "history"],
    scopes: scopeIds(view.transcript.scopes),
    markers: view.history.markers.map((marker) => marker.id),
    drawers: view.contextual.drawers.map((drawer) => drawer.kind),
  };
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
function scopesOf(state: ReplState): ScopeView[] {
  const rows = fixtureFor(state).entry?.rows ?? [];
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

function controlsOf(state: ReplState): ControlView[] {
  const transport = state.moment.transport;
  if (state.moment.entry === "none") {
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
export function project(state: ReplState): ReplView {
  const subject = fixtureFor(state);
  const route: Route = state.route;
  const markers = markersOf(state);
  const runnable = state.moment.entry !== "running" && route.draft !== "";
  const drawers = route.drawers.flatMap((kind) => {
    const drawer = subject.drawer;
    if (drawer === undefined || drawer.kind !== kind) {
      return [];
    }
    return [drawerViewFrom(drawer, route.inspect)];
  });
  return {
    execution: route.execution,
    surface: route.surface,
    crumb: subject.crumb,
    badge: subject.badge,
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
      scopes: scopesOf(state),
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
    history: historyViewFrom(subject, state.moment.transport, controlsOf(state)),
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
