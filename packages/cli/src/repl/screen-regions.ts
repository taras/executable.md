/**
 * Which keyboard region and group each control of this screen belongs to.
 *
 * One classification by key, beside the one that says which layout slot a row
 * lands in, and for the same reason: where a control sits is a fact about the
 * composition rather than about the control. It is applied after the screen is
 * described, so the rows that build a reading do not each need to know which
 * Tab stop they are part of — and a control added to the screen is placed by
 * adding its key here.
 *
 * The normal screen is seven regions in a fixed cycle; narrow puts a surface bar
 * in front of the one routed outlet and recovers focus into that outlet; a
 * drawer is three regions of its own. See `focus-navigation.ts` for what the
 * keys do once these placements exist.
 */

import { describe as describeNode, readDescription, fields } from "./description.ts";
import type { ReplDescription, ReplViewData } from "./description.ts";
import type { ReplFocusGroup, ReplFocusRegion, ReplPlacement } from "./focus-navigation.ts";

/** The facts a placement depends on besides the key. */
interface ReplRegionFacts {
  /** Whether the frame routes one narrow outlet. */
  readonly narrow: boolean;
}

const TRANSCRIPT_REGION: ReplFocusRegion = Object.freeze({
  key: "transcript",
  rank: 1,
  axis: "vertical",
});
const SELECTED_REGION: ReplFocusRegion = Object.freeze({
  key: "selected",
  rank: 2,
  axis: "vertical",
});
const DRAFT_REGION: ReplFocusRegion = Object.freeze({
  key: "draft",
  rank: 3,
  axis: "horizontal",
});
const TABS_REGION: ReplFocusRegion = Object.freeze({
  key: "tabs",
  rank: 4,
  axis: "horizontal",
});
const READING_REGION: ReplFocusRegion = Object.freeze({
  key: "reading",
  rank: 5,
  axis: "vertical",
});
const MESSAGE_REGION: ReplFocusRegion = Object.freeze({
  key: "message",
  rank: 6,
  axis: "vertical",
});
const HISTORY_REGION: ReplFocusRegion = Object.freeze({
  key: "history",
  rank: 7,
  axis: "horizontal",
});
/** Narrow's way between outlets, ahead of the outlet it routes. */
const SURFACE_REGION: ReplFocusRegion = Object.freeze({
  key: "surface",
  rank: 0,
  axis: "horizontal",
});
const DRAWER_CONTENT_REGION: ReplFocusRegion = Object.freeze({
  key: "drawer-content",
  rank: 1,
  axis: "vertical",
});
const DRAWER_ACTIONS_REGION: ReplFocusRegion = Object.freeze({
  key: "drawer-actions",
  rank: 2,
  axis: "vertical",
});
const DRAWER_EXIT_REGION: ReplFocusRegion = Object.freeze({
  key: "drawer-exit",
  rank: 3,
  axis: "horizontal",
});

const vertical = (key: string): ReplFocusGroup => Object.freeze({ key, axis: "vertical" });
const horizontal = (key: string): ReplFocusGroup => Object.freeze({ key, axis: "horizontal" });

const CHOICES = vertical("choices");
const TURNS = vertical("turns");
const CRUMBS = horizontal("crumbs");
const FIXED_ACTIONS = horizontal("fixed");

/**
 * Narrow routes one outlet, and that outlet is where focus recovers when the
 * region it was in is not drawn at this size — then the surface bar, when the
 * outlet holds no control.
 */
function outlet(region: ReplFocusRegion, facts: ReplRegionFacts): ReplFocusRegion {
  return facts.narrow ? Object.freeze({ ...region, home: 0 }) : region;
}

/** Narrow's way between outlets, which focus recovers into after the outlet. */
const SURFACE_HOME: ReplFocusRegion = Object.freeze({ ...SURFACE_REGION, home: 1 });

/** The groups a catalog row sits under: its entry, then each scope down to its own. */
function catalogGroups(path: readonly string[]): readonly ReplFocusGroup[] {
  return path.map((_, at) =>
    vertical(at === 0 ? `entry:${path[0]}` : `scope:${path.slice(0, at + 1).join("/")}`),
  );
}

function drawerPlacement(key: string, input: ReplViewData): ReplPlacement {
  const field = fields(input)?.["field"];
  if (key === "drawer:configure:agent" || key.startsWith("drawer:permission:choice:")) {
    return { region: DRAWER_CONTENT_REGION, entry: 0 };
  }
  if (key === "drawer:reading:anchor") {
    return { region: DRAWER_CONTENT_REGION, entry: 1 };
  }
  if (key === "drawer:form:submit") {
    return { region: DRAWER_ACTIONS_REGION, groups: [FIXED_ACTIONS], entry: 0 };
  }
  if (key.startsWith("drawer:value:") && typeof field === "string") {
    return { region: DRAWER_CONTENT_REGION, groups: [vertical(`field:${field}`)], entry: 0 };
  }
  if (
    (key.startsWith("drawer:field:") || key.startsWith("drawer:choice:")) &&
    typeof field === "string"
  ) {
    return {
      region: DRAWER_CONTENT_REGION,
      groups: [vertical(`field:${field}`)],
      ...(key.startsWith("drawer:field:") ? { anchor: true } : {}),
    };
  }
  if (key === "footer:history" || key === "footer:top:history") {
    return { region: DRAWER_EXIT_REGION, entry: 0 };
  }
  if (key === "footer:exit" || key === "footer:top:exit") {
    return { region: DRAWER_EXIT_REGION };
  }
  if (key === "drawer:close") {
    return { region: DRAWER_ACTIONS_REGION, groups: [FIXED_ACTIONS], entry: 1 };
  }
  if (key === "drawer:sidekick:stop") {
    return { region: DRAWER_ACTIONS_REGION, groups: [FIXED_ACTIONS] };
  }
  if (key.startsWith("entry:")) {
    return {
      region: DRAWER_CONTENT_REGION,
      groups: catalogGroups([key.slice("entry:".length)]),
      anchor: true,
    };
  }
  if (key.startsWith("scope:")) {
    return {
      region: DRAWER_CONTENT_REGION,
      groups: catalogGroups(key.slice("scope:".length).split("/")),
      anchor: true,
    };
  }
  return { region: DRAWER_CONTENT_REGION };
}

/**
 * Where one control of the normal screen sits, by its key.
 *
 * `turn` is the turn row described most recently, which is the turn a request
 * row beneath it belongs to: a request is drawn under the turn that is waiting
 * on it, and its own key names the request rather than the turn.
 */
function screenPlacement(
  key: string,
  facts: ReplRegionFacts,
  turn: string | undefined,
): ReplPlacement | undefined {
  if (
    facts.narrow &&
    (key === "sessions:heading" || key === "entries:heading" || key === "surface:sidekick")
  ) {
    return { region: SURFACE_HOME, ...(key === "sessions:heading" ? { entry: 0 } : {}) };
  }
  const transcript = outlet(TRANSCRIPT_REGION, facts);
  if (key === "transcript:selector") {
    return { region: transcript, groups: [CHOICES], anchor: true, entry: 0 };
  }
  if (key === "sessions:all" || key.startsWith("sessions:conversation:")) {
    return { region: transcript, groups: [CHOICES] };
  }
  if (key.startsWith("sessions:request:")) {
    return turn === undefined
      ? { region: transcript, groups: [TURNS] }
      : { region: transcript, groups: [TURNS, vertical(`turn:${turn}`)] };
  }
  if (key.startsWith("sessions:")) {
    return { region: transcript, groups: [TURNS, vertical(`turn:${key}`)], anchor: true };
  }
  const selected = outlet(SELECTED_REGION, facts);
  if (key === "entries:heading") {
    return { region: selected, groups: [CRUMBS], entry: 0 };
  }
  if (key.startsWith("work:crumb:")) {
    return { region: selected, groups: [CRUMBS], entry: 0 };
  }
  if (key === "reading:anchor") {
    return { region: selected, entry: 1 };
  }
  if (key === "footer:input") {
    return { region: DRAFT_REGION, entry: 0 };
  }
  if (key === "draft:send" || key === "draft:stop") {
    return { region: DRAFT_REGION };
  }
  if (key.startsWith("tab:")) {
    return { region: TABS_REGION, ...(key === "tab:bindings" ? { entry: 0 } : {}) };
  }
  const reading = outlet(READING_REGION, facts);
  if (key === "sidekick:anchor" || key === "binding:anchor") {
    return { region: reading, entry: 0 };
  }
  if (key === "sidekick:configure") {
    return facts.narrow ? { region: reading } : { region: TABS_REGION };
  }
  if (
    key === "sidekick:back" ||
    key.startsWith("sidekick:retry:") ||
    key.startsWith("binding:") ||
    key.startsWith("elicit:")
  ) {
    return { region: reading };
  }
  if (key === "sidekick:message") {
    return { region: MESSAGE_REGION, entry: 0 };
  }
  if (key.startsWith("queue:") && key.endsWith(":remove")) {
    return { region: MESSAGE_REGION, groups: [vertical("queue")] };
  }
  if (
    key === "follow" ||
    key === "sidekick:answer" ||
    key === "sidekick:send" ||
    key === "sidekick:stop" ||
    key === "sidekick:resume"
  ) {
    return { region: MESSAGE_REGION };
  }
  if (key === "footer:history") {
    return { region: HISTORY_REGION, entry: 0 };
  }
  if (key.startsWith("footer:")) {
    return { region: HISTORY_REGION, entry: 1 };
  }
  return undefined;
}

/** Whether a key names a turn row, which heads the requests drawn beneath it. */
function turnRow(key: string): boolean {
  return (
    key.startsWith("sessions:") &&
    !key.startsWith("sessions:request:") &&
    !key.startsWith("sessions:conversation:") &&
    key !== "sessions:all" &&
    key !== "sessions:heading"
  );
}

/**
 * The same descriptions, each control placed in keyboard navigation.
 *
 * Everything under a modal branch is placed in that drawer's three regions,
 * including the footer's History and Exit it holds while it is open. A control
 * this screen does not place is left unplaced, which makes it a region of its
 * own; a description that is not a control is left exactly as it was.
 */
export function placeScreen<Action>(
  descriptions: readonly ReplDescription<Action>[],
  facts: ReplRegionFacts,
  control: (description: ReplDescription<Action>) => boolean,
): readonly ReplDescription<Action>[] {
  let turn: string | undefined;
  const place = (description: ReplDescription<Action>, modal: boolean): ReplDescription<Action> => {
    const read = readDescription(description);
    const children = read.children.map((child) => place(child, modal || read.modal));
    let navigation: ReplPlacement | undefined;
    if (control(description)) {
      if (!modal && turnRow(read.key)) {
        turn = read.key;
      }
      navigation = modal
        ? drawerPlacement(read.key, read.input)
        : screenPlacement(read.key, facts, turn);
    }
    if (navigation === undefined && children.every((child, at) => child === read.children[at])) {
      return description;
    }
    return describeNode<Action>({
      key: read.key,
      component: read.component,
      input: read.input,
      layout: read.layout,
      children,
      ...(read.modal ? { modal: true as const } : {}),
      ...(read.focus ? { focus: true as const } : {}),
      ...(navigation === undefined ? {} : { navigation }),
    });
  };
  return descriptions.map((description) => place(description, false));
}
