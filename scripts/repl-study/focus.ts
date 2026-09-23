/**
 * Where focus is, derived rather than remembered.
 *
 * Focus is never a coordinate and never an index into a list that was true last
 * frame. It is a semantic identity — `region:transcript`, `control:transport.pause`,
 * `field:drawer.project.name` — and every frame a registry of the identities
 * that exist *now* is built from the route, the journal and the layout. Asking
 * where focus is means resolving one identity against that registry.
 *
 * That is the whole answer to two of #839's acceptance criteria at once. A
 * background update cannot steal focus, because nothing ever writes focus when
 * one arrives. And a route transition restores a stable identity or the nearest
 * surviving owner, because a vanished identity is resolved by walking its owner
 * chain rather than by remembering to move anything.
 *
 * Two lists, and conflating them is the trap. The **registry** is visible and
 * enabled, and is what Tab moves through. The **map** is visible whether enabled
 * or not, and is what the `F1` overlay numbers — study frame 12 numbers a dimmed
 * `Continue` and says Tab skips it.
 */

import type { Layout } from "./layout.ts";
import type { Mutation } from "./mutations.ts";
import type { ReplState } from "./store.ts";
import { DRAWER_KINDS } from "./fixtures.ts";
import type { DrawerKind } from "./fixtures.ts";

export interface FocusTarget {
  readonly id: string;
  readonly kind: "region" | "control" | "field";
  readonly label: string;
  /** The identity resolution walks to when this one disappears. */
  readonly owner?: string;
  readonly enabled: boolean;
}

/** The five regions, in the study's forward order. */
export const REGIONS = ["sessions", "transcript", "bindings", "input", "history"] as const;

/**
 * Who owns an identity, read from the identity itself.
 *
 * Resolution has to answer this for a target that is already gone, so it cannot
 * be a lookup in the registry that no longer contains it. The naming scheme is
 * the ownership, which is why identities are structured rather than opaque.
 */
export function ownerOf(identity: string): string | undefined {
  if (identity.startsWith("region:")) {
    return undefined;
  }
  if (identity.startsWith("control:input.")) {
    return "region:input";
  }
  if (identity.startsWith("control:transport.")) {
    return "region:history";
  }
  if (identity.startsWith("control:drawer.") || identity.startsWith("field:drawer.")) {
    return "region:transcript";
  }
  return undefined;
}

/**
 * The live counterpart of a transport control.
 *
 * Study frame 13 requires that leaving history with `Continue` focused lands on
 * `Pause` — the control that undoes what the focused one did — rather than on
 * the region that owned it. A counterpart is preferred over the owner walk.
 */
export function counterpartOf(identity: string): string | undefined {
  if (identity === "control:transport.continue") {
    return "control:transport.pause";
  }
  if (identity === "control:transport.pause") {
    return "control:transport.continue";
  }
  return undefined;
}

interface DrawerTarget {
  readonly id: string;
  readonly kind: "control" | "field";
  readonly label: string;
}

/** Each drawer's own sequence, taken from study frames 07, 08 and 09. */
const DRAWER_TARGETS: Record<DrawerKind, readonly DrawerTarget[]> = {
  project: [
    { id: "field:drawer.project.name", kind: "field", label: "Project name" },
    { id: "field:drawer.project.description", kind: "field", label: "Description" },
    { id: "control:drawer.project.schema", kind: "control", label: "Schema disclosure · ⌥S" },
    { id: "control:drawer.project.submit", kind: "control", label: "Submit" },
  ],
  review: [
    { id: "control:drawer.review.scroll", kind: "control", label: "Plan review · scroll region" },
    { id: "control:drawer.review.approve", kind: "control", label: "Approve" },
    { id: "control:drawer.review.request", kind: "control", label: "Request changes" },
    { id: "control:drawer.review.stop", kind: "control", label: "Stop" },
    { id: "control:drawer.review.submit", kind: "control", label: "Submit" },
  ],
  confirm: [
    {
      id: "control:drawer.confirm.preview",
      kind: "control",
      label: "README preview · scroll region",
    },
    { id: "control:drawer.confirm.approve", kind: "control", label: "Approve" },
    { id: "control:drawer.confirm.decline", kind: "control", label: "Decline" },
  ],
};

export function drawerTargets(kind: DrawerKind): readonly DrawerTarget[] {
  return DRAWER_TARGETS[kind];
}

/** True while the identity is the history region itself or one of its controls. */
function withinHistory(identity: string): boolean {
  return identity === "region:history" || identity.startsWith("control:transport.");
}

function regionLabel(state: ReplState, region: (typeof REGIONS)[number]): string {
  if (region === "sessions") {
    const journal = state.selection >= 0;
    return journal ? "Journal · checkpoint list" : `Sessions · ${state.moment.sessions}`;
  }
  if (region === "transcript") {
    return state.route.inspect ? "Transcript · read-only" : "Transcript";
  }
  if (region === "bindings") {
    return "Bindings";
  }
  if (region === "input") {
    return state.moment.entry === "running" ? "REPL input · Run disabled" : "REPL input";
  }
  return "Execution History";
}

/**
 * The transport controls the footer is exposing.
 *
 * `history` is an **explicit** region: its controls join the sequence only once
 * the region has been entered, which is what study frame 03 shows by focusing
 * region 5 and listing no controls at all. Being entered is being focused
 * within it. There is nothing to expose before an execution has been recorded,
 * so an empty REPL has no transport however focus got there.
 */
function transportTargets(state: ReplState): FocusTarget[] {
  if (state.moment.entry === "none" || !withinHistory(state.focus)) {
    return [];
  }
  const owner = "region:history";
  if (state.moment.transport === "live") {
    return [
      { id: "control:transport.pause", kind: "control", label: "Pause", owner, enabled: true },
    ];
  }
  if (state.moment.transport === "paused") {
    return [
      {
        id: "control:transport.continue",
        kind: "control",
        label: "Continue",
        owner,
        enabled: true,
      },
      {
        id: "control:transport.return-head",
        kind: "control",
        label: "Return to paused head",
        owner,
        enabled: true,
      },
    ];
  }
  if (state.moment.transport === "inspecting") {
    return [
      // Visible, dimmed, and numbered — but skipped by Tab. Resuming from a
      // reconstruction is not a thing this state can do.
      {
        id: "control:transport.continue",
        kind: "control",
        label: "Continue · disabled while inspecting",
        owner,
        enabled: false,
      },
      {
        id: "control:transport.return-head",
        kind: "control",
        label: "Return to paused head",
        owner,
        enabled: true,
      },
      {
        id: "control:transport.fork",
        kind: "control",
        label: "Fork from here",
        owner,
        enabled: true,
      },
    ];
  }
  return [];
}

/**
 * Every visible target, in traversal order.
 *
 * The ring is the five regions with **each region's own controls inlined
 * immediately after it**, which is why the study's numbers are not the Tab
 * order: numbering assigns 1–5 to the regions and 6 upward to the controls,
 * while traversal visits `Run` between the input and the footer. Study frames
 * 05, 11 and 14 only agree with each other under that reading.
 *
 * While a drawer is open the sequence is the top drawer's own controls and the
 * Execution History region, and nothing else. The footer is inside the trap
 * deliberately: the study calls it "the one way out", and it is how the fixed
 * history footer stays reachable through a suspension.
 */
export function focusMap(
  state: ReplState,
  layout: Layout,
  mutation?: Mutation,
): readonly FocusTarget[] {
  if (layout.profile === "too-small") {
    return [];
  }
  const top = state.route.drawers[state.route.drawers.length - 1];
  const trapped = top !== undefined && (DRAWER_KINDS as readonly string[]).includes(top);
  if (trapped && mutation !== "leak-drawer-trap") {
    const kind = DRAWER_KINDS.find((one) => one === top)!;
    return [
      ...DRAWER_TARGETS[kind].map((target) => ({
        ...target,
        owner: ownerOf(target.id),
        enabled: true,
      })),
      {
        id: "region:history",
        kind: "region" as const,
        label: "Execution History · still reachable",
        enabled: true,
      },
    ];
  }

  const targets: FocusTarget[] = [];
  for (const region of REGIONS) {
    targets.push({
      id: `region:${region}`,
      kind: "region",
      label: regionLabel(state, region),
      enabled: true,
    });
    if (region === "input") {
      // `input` is an **adjacent** region: Run is listed whenever it is enabled,
      // with no Enter required. It is enabled when there is something to run and
      // nothing already running, which is why the empty REPL of frames 01–04
      // numbers five targets and the settled entry of frame 14 numbers six.
      const runnable = state.moment.entry !== "running" && state.route.draft !== "";
      if (runnable) {
        targets.push({
          id: "control:input.run",
          kind: "control",
          label: "Run",
          owner: "region:input",
          enabled: true,
        });
      }
    }
    if (region === "history") {
      targets.push(...transportTargets(state));
    }
  }
  return targets;
}

/** The map, less every target Tab is not allowed to land on. */
export function registry(
  state: ReplState,
  layout: Layout,
  mutation?: Mutation,
): readonly FocusTarget[] {
  const map = focusMap(state, layout, mutation);
  // The control admits a target the overlay shows but the ring excludes, which
  // is the one distinction between the two lists.
  return mutation === "focus-hidden-target" ? map : map.filter((target) => target.enabled);
}

/**
 * The number the `F1` overlay writes beside a target.
 *
 * Regions take 1–5 and controls take 6 upward, which is assigned separately
 * from traversal order. Inside a drawer the trap is numbered straight through,
 * as frames 07, 08 and 09 do.
 */
export function numbering(targets: readonly FocusTarget[]): Map<string, number> {
  const numbers = new Map<string, number>();
  const regions = targets.filter((target) => target.kind === "region");
  const rest = targets.filter((target) => target.kind !== "region");
  if (regions.length !== REGIONS.length) {
    targets.forEach((target, index) => numbers.set(target.id, index + 1));
    return numbers;
  }
  regions.forEach((target, index) => numbers.set(target.id, index + 1));
  rest.forEach((target, index) => numbers.set(target.id, regions.length + index + 1));
  return numbers;
}

/**
 * The identity focus actually lands on.
 *
 * An identity that is present and enabled is returned unchanged. Otherwise a
 * declared counterpart is preferred, then the owner chain is walked upward to
 * the nearest surviving enabled target, and an exhausted chain falls back to the
 * first target in the ring. Nothing has to remember to move focus, because this
 * is asked fresh every frame.
 */
export function resolve(identity: string, targets: readonly FocusTarget[]): string {
  const alive = (id: string): boolean =>
    targets.some((target) => target.id === id && target.enabled);
  if (alive(identity)) {
    return identity;
  }
  const counterpart = counterpartOf(identity);
  if (counterpart !== undefined && alive(counterpart)) {
    return counterpart;
  }
  let owner = ownerOf(identity);
  const seen = new Set<string>([identity]);
  while (owner !== undefined && !seen.has(owner)) {
    if (alive(owner)) {
      return owner;
    }
    seen.add(owner);
    owner = ownerOf(owner);
  }
  return targets.find((target) => target.enabled)?.id ?? "";
}

/** One step around the ring, forward or in reverse, wrapping at both ends. */
export function step(identity: string, targets: readonly FocusTarget[], delta: 1 | -1): string {
  const enabled = targets.filter((target) => target.enabled);
  if (enabled.length === 0) {
    return "";
  }
  const from = resolve(identity, targets);
  const at = Math.max(
    0,
    enabled.findIndex((target) => target.id === from),
  );
  const next = (at + delta + enabled.length) % enabled.length;
  return enabled[next].id;
}

/**
 * The map in the order the overlay numbers it.
 *
 * Traversal order and numbering order are not the same list, which is the whole
 * reason the study's numbers look out of sequence: `Run` is numbered after the
 * Execution History region and traversed before it, because it belongs to the
 * input. The ring is what `focusMap` returns; this is what `F1` draws.
 */
export function mapOrder(targets: readonly FocusTarget[]): readonly FocusTarget[] {
  const numbers = numbering(targets);
  return [...targets].toSorted(
    (one, other) => (numbers.get(one.id) ?? 0) - (numbers.get(other.id) ?? 0),
  );
}
