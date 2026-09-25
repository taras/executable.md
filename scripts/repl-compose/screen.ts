/**
 * One resolved location, described as an interface.
 *
 * This is where the two halves meet. A `Result<ResolvedLocation>`, a session
 * snapshot and a viewport go in; keyed component descriptions come out. Nothing
 * here mounts anything, and nothing here reads history records: every value it
 * reads came out of `ReplModel` through the router, and every value it hands a
 * component is one of those or a plain viewport number.
 *
 * **A refusal is a whole screen, not a banner.** When the location did not
 * resolve, the description is the refusal and nothing else — so reconciliation
 * removes whatever was mounted for the last good location, and there is no
 * half-resolved interface still sitting behind it holding focus, input and
 * frames. That falls out of describing rather than being arranged: a screen the
 * parent does not describe is a screen that stops existing.
 *
 * **Layout is presentation, never existence.** The viewport reaches components
 * through their input and decides how a parent arranges what its children drew.
 * It decides nothing about which children there are: the same location
 * describes the same tree at every width, and only `present` reads the
 * viewport. The evidence holds that by composing one location at two viewports
 * and comparing the topology.
 */

import { spawn } from "effection";
import type { Operation, Result } from "effection";

import { component, describe } from "./component.ts";
import type { Component, Description } from "./component.ts";
import type { Entry, Scope, Suspension } from "./model.ts";
import type { ResolvedLocation, RouteSurface } from "./router.ts";

/** How much terminal there is. The only thing layout is allowed to read. */
export interface Viewport {
  readonly columns: number;
  readonly rows: number;
}

/**
 * What the session remembers that the URL deliberately does not.
 *
 * Scroll offsets survive a component being unmounted and remounted, which is
 * why they are here rather than in a component: the tree is derived from the
 * location, and anything it owns goes when its branch does.
 */
export interface SessionSnapshot {
  readonly scroll: Readonly<Record<string, number>>;
}

/** Side by side while there is room for it, stacked when there is not. */
function columnsFit(viewport: Viewport): boolean {
  return viewport.columns >= 100;
}

interface ControlInput {
  readonly label: string;
  readonly action: string;
}

const Control: Component<ControlInput> = component({
  name: "control",
  focusable: true,
  children: () => [],
  lifecycle: null,
  onPress: (input, key) =>
    key.key === "Enter" ? { kind: input.action, from: input.label } : undefined,
  present: (input) => [`[ ${input.label} ]`],
});

interface ScopeInput {
  readonly scope: Scope;
  /** The scopes below this one on the route's path, outermost first. */
  readonly below: readonly Scope[];
  readonly depth: number;
}

const ScopeView: Component<ScopeInput> = component({
  name: "scope",
  focusable: true,
  lifecycle: null,

  children({ below, depth }): readonly Description[] {
    const [next, ...rest] = below;
    if (next === undefined) {
      return [];
    }
    // A nested scope is a child branch, because that is what it is.
    return [describe(ScopeView, next.name, { scope: next, below: rest, depth: depth + 1 })];
  },

  present({ scope, depth }, children) {
    const indent = "  ".repeat(depth);
    const state = scope.settled ? "settled" : "open";
    return [`${indent}${scope.name} (${state})`, ...children];
  },
});

interface EntryInput {
  readonly entry: Entry;
  readonly scopes: readonly Scope[];
  readonly scroll: number;
}

const EntryView: Component<EntryInput> = component({
  name: "entry",
  focusable: true,
  lifecycle: null,

  children({ scopes }): readonly Description[] {
    const [first, ...rest] = scopes;
    if (first === undefined) {
      return [];
    }
    return [describe(ScopeView, first.name, { scope: first, below: rest, depth: 1 })];
  },

  present({ entry, scroll }, children) {
    const settled = entry.settled ? "settled" : "running";
    return [`${entry.id} — ${entry.title} (${settled})`, ...children.slice(scroll)];
  },
});

interface DrawerInput {
  readonly suspension: Suspension;
  /** The drawers stacked on top of this one, outermost first. */
  readonly above: readonly Suspension[];
}

const DrawerView: Component<DrawerInput> = component({
  name: "drawer",
  focusable: true,

  children({ suspension, above }): readonly Description[] {
    const controls = [
      describe(Control, `${suspension.kind}.answer`, {
        label: "Answer",
        action: "suspension.answer",
      }),
    ];
    const [next, ...rest] = above;
    if (next === undefined) {
      return controls;
    }
    // Stacked, not adjacent: the drawer above is a child branch of this one.
    return [...controls, describe(DrawerView, next.kind, { suspension: next, above: rest })];
  },

  *lifecycle({ node, input, frames, ready, updates }): Operation<void> {
    // Both subscriptions belong to this body's scope, and both are acquired
    // before the child that reads one is spawned.
    const later = yield* updates.receive();
    const clock = yield* frames.subscribe();
    let opened = 0;
    let current = input;
    node.set("opened", opened);
    node.set("prompt", current.suspension.prompt);

    yield* spawn(function* () {
      while (true) {
        const at = yield* clock.next();
        opened += 1;
        node.set("opened", opened);
        node.set("at", at);
      }
    });

    yield* ready();

    while (true) {
      current = yield* later.next();
      node.set("prompt", current.suspension.prompt);
    }
  },

  onPress({ suspension }, key) {
    return key.key === "Escape" ? { kind: "drawer.close", from: suspension.kind } : undefined;
  },

  present({ suspension }, children) {
    return [
      `▸ ${suspension.kind} — ${suspension.prompt}`,
      `  owner: ${suspension.scope.join("/")}`,
      ...children.map((line) => `  ${line}`),
    ];
  },
});

interface SurfaceInput {
  readonly surface: RouteSurface;
  readonly focused: boolean;
  readonly lines: readonly string[];
}

const SurfaceView: Component<SurfaceInput> = component({
  name: "surface",
  focusable: true,
  children: () => [],
  lifecycle: null,
  present({ surface, focused, lines }) {
    return [`${focused ? "*" : " "} ${surface}`, ...lines.map((line) => `    ${line}`)];
  },
});

interface WorkbenchInput {
  readonly location: ResolvedLocation;
  readonly session: SessionSnapshot;
  readonly viewport: Viewport;
}

const Workbench: Component<WorkbenchInput> = component({
  name: "workbench",
  focusable: false,
  lifecycle: null,

  children({ location, session }): readonly Description[] {
    const described: Description[] = [];

    for (const surface of ["sessions", "bindings", "history"] as const) {
      described.push(
        describe(SurfaceView, surface, {
          surface,
          focused: location.surface === surface,
          lines: [`${location.checkpoint.marker} @ ${location.checkpoint.at}s`],
        }),
      );
    }

    if (location.entry !== undefined) {
      described.push(
        describe(EntryView, location.entry.id, {
          entry: location.entry,
          scopes: location.scopes,
          scroll: session.scroll[location.entry.id] ?? 0,
        }),
      );
    }

    const [first, ...above] = location.drawers;
    if (first !== undefined) {
      described.push(describe(DrawerView, first.kind, { suspension: first, above }));
    }

    return described;
  },

  present({ location, viewport }, children) {
    // The viewport decides how this parent arranges what its children drew. It
    // decides nothing about which children exist — those came from the location.
    const heading = `${location.checkpoint.marker}${location.inspecting ? " (inspecting)" : ""}`;
    if (columnsFit(viewport)) {
      return [heading, ...children];
    }
    return [heading, "— narrow —", ...children.map((line) => line.trimStart())];
  },
});

interface RefusalInput {
  readonly message: string;
}

const RefusalView: Component<RefusalInput> = component({
  name: "refusal",
  focusable: true,
  children: () => [],
  lifecycle: null,
  present: (input) => ["This location does not exist in this execution.", `  ${input.message}`],
});

interface ScreenInput {
  readonly outcome: Result<ResolvedLocation>;
  readonly session: SessionSnapshot;
  readonly viewport: Viewport;
}

const Screen: Component<ScreenInput> = component({
  name: "screen",
  focusable: false,
  lifecycle: null,

  children({ outcome, session, viewport }): readonly Description[] {
    if (!outcome.ok) {
      // The refusal is the screen. Nothing else is described, so nothing else
      // stays mounted.
      return [describe(RefusalView, "refusal", { message: outcome.error.message })];
    }
    return [describe(Workbench, "workbench", { location: outcome.value, session, viewport })];
  },

  present: (_input, children) => children,
});

/** The whole interface one outcome describes. */
export function describeScreen(
  outcome: Result<ResolvedLocation>,
  session: SessionSnapshot,
  viewport: Viewport,
): readonly Description[] {
  return [describe(Screen, "screen", { outcome, session, viewport })];
}
