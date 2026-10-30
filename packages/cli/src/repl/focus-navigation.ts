/**
 * Where keyboard focus goes next, read from where each control says it sits.
 *
 * A screen is a short cycle of **regions** — Transcript, the selected work, the
 * Draft, the right pane's tabs and its reading, the Sidekick's message box,
 * History — and Tab moves between them however many controls each one holds.
 * Inside a region the arrows move between neighbours. That is the whole reason
 * this exists: a flat chain made reaching the next pane cost one press per
 * control on the way, and every row a list gained made the journey longer.
 *
 * Each focusable control's description carries a {@link ReplPlacement}: the
 * region it belongs to, the nested groups between that region and itself, and
 * whether ordinary entry to the region lands on it. Nothing here is stored. The
 * structure is derived from the mounted controls of the active focus root, in
 * their canonical mounted order, every time a key asks a question — so a control
 * that is not mounted is not a destination, and there is no second focus chain
 * to drift from the tree.
 *
 * ## The rules a key follows
 *
 * - **Tab / Shift+Tab** go to the next or previous region that has a control, at
 *   that region's fixed entry, and wrap. Entry never depends on where focus was
 *   last time: it is the control with the lowest `entry`, else the region's
 *   first control.
 * - **Arrows along a level's axis** — Up/Down in a vertical level, Left/Right
 *   in a horizontal one — move to the adjacent stop. At an edge they stay put;
 *   nothing wraps.
 * - **A group with an anchor** is entered from its anchor with the parent's
 *   forward perpendicular key (Right under a vertical parent, Down under a
 *   horizontal one) at its first control, and left back to the anchor with the
 *   group's own backward perpendicular key (Left in a vertical group, Up in a
 *   horizontal one). It contains the arrows otherwise.
 * - **A group without an anchor** is transparent: it occupies one position in
 *   its parent, moving onto it lands on its first control, and a key it has no
 *   use for is answered by its parent from that position. A breadcrumb row in a
 *   vertical region is one: Left/Right walk the crumbs and Up/Down leave the row.
 * - **Alt+Up / Alt+Down** take one step through the region's depth-first order,
 *   anchors before their members, without wrapping and without leaving it.
 *
 * Nothing here activates anything. A key that has a destination moves focus; a
 * key that has none moves nothing.
 *
 * ## Arrows are offered to the focused control first
 *
 * The tree asks the focused control and its ancestors before it navigates, so a
 * field keeps its arrows for its caret and a reading keeps them for scrolling.
 * Alt+arrows are offered too, which is how the last visible row of a windowed
 * list asks for the next logical row to be revealed rather than letting focus
 * jump past what the window is not showing. Tab and Shift+Tab are never offered:
 * moving between regions is the tree's alone.
 */

/** Which pair of arrows moves between a level's children. */
export type ReplAxis = "vertical" | "horizontal";

/**
 * One region of the Tab cycle.
 *
 * Declared identically on every control in it. `rank` orders the cycle; two
 * regions are never ordered by which happened to be described first. `home`
 * says where focus recovers when the region it was in no longer exists, or
 * when nothing holds it: the present region with the lowest `home` wins. The
 * narrow outlet's visible content is one such region and its surface bar the
 * next, which is an order the cycle itself cannot express.
 */
export interface ReplFocusRegion {
  readonly key: string;
  readonly rank: number;
  readonly axis: ReplAxis;
  readonly home?: number;
}

/** One nested group inside a region, declared identically by every control in it. */
export interface ReplFocusGroup {
  readonly key: string;
  readonly axis: ReplAxis;
}

/** Where one focusable control sits in keyboard navigation. */
export interface ReplPlacement {
  readonly region: ReplFocusRegion;
  /** The groups between the region and this control, outermost first. */
  readonly groups?: readonly ReplFocusGroup[];
  /**
   * This control heads the innermost of `groups` rather than being one of its
   * members: it is that group's stop in the parent, and the destination the
   * group is left for.
   */
  readonly anchor?: true;
  /**
   * Preference for ordinary entry to the region. The lowest wins and canonical
   * order breaks a tie; a region where nothing states one is entered at its
   * first control.
   */
  readonly entry?: number;
}

/** The keys this module answers, by what was pressed. */
export type ReplNavigationKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Alt+ArrowUp"
  | "Alt+ArrowDown";

/** One mounted focusable control, in canonical mounted order. */
export interface ReplStop {
  readonly id: string;
  readonly placement: ReplPlacement | undefined;
}

/** Whether this key is one the navigation rules answer. */
export function isNavigationKey(key: string): key is ReplNavigationKey {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "Alt+ArrowUp" ||
    key === "Alt+ArrowDown"
  );
}

interface Level {
  readonly axis: ReplAxis;
  readonly parent: Level | undefined;
  /** This level's position in its parent, when it is a group. */
  readonly at: number;
  anchor: string | undefined;
  readonly items: Item[];
  readonly children: Map<string, Level>;
}

type Item = { readonly stop: string } | { readonly group: Level };

interface Region {
  readonly spec: ReplFocusRegion;
  /** Where the region's first control was mounted, which orders unranked regions. */
  readonly first: number;
  readonly level: Level;
}

interface Position {
  readonly region: Region;
  readonly level: Level;
  readonly index: number;
}

/** The navigation structure one set of mounted controls describes. */
export interface ReplFocusLayout {
  readonly regions: readonly Region[];
  readonly where: ReadonlyMap<string, Position>;
}

function level(axis: ReplAxis, parent: Level | undefined, at: number): Level {
  return { axis, parent, at, anchor: undefined, items: [], children: new Map() };
}

/**
 * Derive the structure from mounted controls, outermost first.
 *
 * A control nothing placed is a region of its own after every ranked one, in
 * mounted order — a refusal's way back, or the one exit a too-small screen
 * offers, needs no declaration to be reachable.
 */
export function focusLayout(stops: readonly ReplStop[]): ReplFocusLayout {
  const regions = new Map<string, Region>();
  const where = new Map<string, Position>();
  for (const [index, stop] of stops.entries()) {
    const spec: ReplFocusRegion = stop.placement?.region ?? {
      key: `\u0000${stop.id}`,
      rank: Number.POSITIVE_INFINITY,
      axis: "vertical",
    };
    let region = regions.get(spec.key);
    if (region === undefined) {
      region = { spec, first: index, level: level(spec.axis, undefined, 0) };
      regions.set(spec.key, region);
    }
    let here = region.level;
    for (const group of stop.placement?.groups ?? []) {
      let nested = here.children.get(group.key);
      if (nested === undefined) {
        nested = level(group.axis, here, here.items.length);
        here.children.set(group.key, nested);
        here.items.push({ group: nested });
      }
      here = nested;
    }
    if (stop.placement?.anchor === true && here.parent !== undefined) {
      if (here.anchor === undefined) {
        here.anchor = stop.id;
        where.set(stop.id, { region, level: here.parent, index: here.at });
      }
      continue;
    }
    where.set(stop.id, { region, level: here, index: here.items.length });
    here.items.push({ stop: stop.id });
  }
  const ordered = [...regions.values()].sort(
    (a, b) => a.spec.rank - b.spec.rank || a.first - b.first,
  );
  return { regions: ordered, where };
}

/** Every stop of a level, depth first, each anchor before its members. */
function depthFirst(of: Level): string[] {
  const found: string[] = [];
  for (const item of of.items) {
    if ("stop" in item) {
      found.push(item.stop);
      continue;
    }
    if (item.group.anchor !== undefined) {
      found.push(item.group.anchor);
    }
    found.push(...depthFirst(item.group));
  }
  return found;
}

/** The stop one item offers to a move landing on it. */
function stopOf(item: Item): string | undefined {
  if ("stop" in item) {
    return item.stop;
  }
  return item.group.anchor ?? depthFirst(item.group)[0];
}

/** Where ordinary entry to one region lands. */
function entryOf(region: Region, stops: ReadonlyMap<string, ReplStop>): string | undefined {
  const order = depthFirst(region.level);
  let best: string | undefined;
  let rank = Number.POSITIVE_INFINITY;
  for (const id of order) {
    const preference = stops.get(id)?.placement?.entry;
    if (preference !== undefined && preference < rank) {
      best = id;
      rank = preference;
    }
  }
  return best ?? order[0];
}

function along(key: ReplNavigationKey, axis: ReplAxis): -1 | 1 | undefined {
  if (axis === "vertical") {
    return key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : undefined;
  }
  return key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : undefined;
}

/** The perpendicular key that goes into a group headed at this level. */
function enters(key: ReplNavigationKey, axis: ReplAxis): boolean {
  return axis === "vertical" ? key === "ArrowRight" : key === "ArrowDown";
}

/** The perpendicular key that leaves a group of this axis for its anchor. */
function leaves(key: ReplNavigationKey, axis: ReplAxis): boolean {
  return axis === "vertical" ? key === "ArrowLeft" : key === "ArrowUp";
}

function moved(
  from: Level,
  index: number,
  key: ReplNavigationKey,
  focused: string,
): string | undefined {
  const step = along(key, from.axis);
  if (step !== undefined) {
    for (let at = index + step; at >= 0 && at < from.items.length; at += step) {
      const target = stopOf(from.items[at]);
      if (target !== undefined) {
        return target;
      }
    }
  } else {
    const item = from.items[index];
    if (
      enters(key, from.axis) &&
      item !== undefined &&
      "group" in item &&
      item.group.anchor === focused
    ) {
      const first = depthFirst(item.group)[0];
      if (first !== undefined) {
        return first;
      }
    }
    if (leaves(key, from.axis) && from.anchor !== undefined) {
      return from.anchor;
    }
  }
  // A group with no anchor answers nothing it has no use for: its parent does,
  // from the position the group occupies.
  if (from.anchor === undefined && from.parent !== undefined) {
    return moved(from.parent, from.at, key, focused);
  }
  return undefined;
}

/**
 * Where one arrow or Alt+arrow takes focus from this control, if anywhere.
 *
 * `undefined` is the honest answer at an edge and for a key the position has no
 * use for: the caller leaves focus where it is.
 */
export function arrowTarget(
  layout: ReplFocusLayout,
  focused: string,
  key: ReplNavigationKey,
): string | undefined {
  const position = layout.where.get(focused);
  if (position === undefined) {
    return undefined;
  }
  if (key === "Alt+ArrowUp" || key === "Alt+ArrowDown") {
    const order = depthFirst(position.region.level);
    const at = order.indexOf(focused);
    return order[at + (key === "Alt+ArrowUp" ? -1 : 1)];
  }
  return moved(position.level, position.index, key, focused);
}

/** Where Tab (`1`) or Shift+Tab (`-1`) takes focus from this control. */
export function regionTarget(
  layout: ReplFocusLayout,
  stops: readonly ReplStop[],
  focused: string | undefined,
  direction: -1 | 1,
): string | undefined {
  const regions = layout.regions;
  if (regions.length === 0) {
    return undefined;
  }
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const current = focused === undefined ? undefined : layout.where.get(focused)?.region;
  const at = current === undefined ? -1 : regions.indexOf(current);
  const next =
    at === -1
      ? direction === 1
        ? 0
        : regions.length - 1
      : (at + direction + regions.length) % regions.length;
  return entryOf(regions[next], byId);
}

/** The present region focus recovers into, by the lowest `home`. */
function homeOf(layout: ReplFocusLayout): Region | undefined {
  let best: Region | undefined;
  for (const region of layout.regions) {
    const home = region.spec.home;
    if (home !== undefined && (best?.spec.home === undefined || home < best.spec.home)) {
      best = region;
    }
  }
  return best;
}

/**
 * Where focus starts when nothing holds it: the home region's entry, or the
 * first region's.
 */
export function homeTarget(
  layout: ReplFocusLayout,
  stops: readonly ReplStop[],
): string | undefined {
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const home = homeOf(layout) ?? layout.regions[0];
  return home === undefined ? undefined : entryOf(home, byId);
}

/**
 * Where focus goes when the control holding it is no longer there.
 *
 * Computed from where the departed control sat — its own level and ancestry in
 * `before` — and what `after` still holds: the next surviving sibling, then the
 * previous one, then the nearest surviving anchor up its ancestry, then its
 * region's entry. A region that is gone altogether gives way to the present
 * region with the lowest `home`, and otherwise to the next region in cycle
 * order. Never the first control anywhere on the screen.
 */
export function survivorTarget(
  before: ReplFocusLayout,
  after: ReplFocusLayout,
  afterStops: readonly ReplStop[],
  departed: string,
): string | undefined {
  const present = (id: string | undefined): id is string => id !== undefined && after.where.has(id);
  const position = before.where.get(departed);
  if (position === undefined) {
    return homeTarget(after, afterStops);
  }
  const within = (item: Item): readonly string[] =>
    "stop" in item
      ? [item.stop]
      : [
          ...(item.group.anchor === undefined ? [] : [item.group.anchor]),
          ...depthFirst(item.group),
        ];
  const candidates: string[] = [];
  const items = position.level.items;
  for (let at = position.index + 1; at < items.length; at += 1) {
    candidates.push(...within(items[at]));
  }
  for (let at = position.index - 1; at >= 0; at -= 1) {
    candidates.push(...within(items[at]));
  }
  for (let up: Level | undefined = position.level; up !== undefined; up = up.parent) {
    if (up.anchor !== undefined && up.anchor !== departed) {
      candidates.push(up.anchor);
    }
  }
  const survivor = candidates.find(present);
  if (survivor !== undefined) {
    return survivor;
  }
  const byId = new Map(afterStops.map((stop) => [stop.id, stop]));
  const same = after.regions.find((region) => region.spec.key === position.region.spec.key);
  if (same !== undefined) {
    return entryOf(same, byId);
  }
  const home = homeOf(after);
  if (home !== undefined) {
    return entryOf(home, byId);
  }
  const rank = position.region.spec.rank;
  const next = after.regions.find((region) => region.spec.rank > rank) ?? after.regions[0];
  return next === undefined ? undefined : entryOf(next, byId);
}
