/**
 * The route and the focus model, checked against the approved focus study.
 *
 * The study states fourteen frames as numbered target lists with a focused
 * number and a `meta` record naming what Tab and Shift+Tab do from there. That
 * is the acceptance source, so most of this suite is the same question asked of
 * every frame: rebuild the state from its URL, and ask the registry, the map
 * and the ring whether they agree with the study.
 *
 * Two claims are driven as **bytes** rather than as synthetic events, because
 * synthetic events are what hid the defects this slice repairs. A lone `ESC`
 * never reached the harness at a real keyboard, and a real Shift+Tab arrives as
 * `Backtab` with no shift flag — both were handled, tested, and unreachable.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createInput } from "@bomb.sh/tty";
import type { Input, InputEvent } from "@bomb.sh/tty";
import { readTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { until } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureFocus, captureText, PROFILE_SIZES, renderFrame } from "../repl-study/capture.ts";
import { FRAMES, frame, stateFor } from "../repl-study/frames.ts";
import type { StudyFrame } from "../repl-study/frames.ts";
import {
  counterpartOf,
  focusMap,
  mapOrder,
  numbering,
  ownerOf,
  registry,
  resolve,
  step,
} from "../repl-study/focus.ts";
import { scanKeys } from "../repl-study/host.ts";
import { fold, JOURNAL, journalThrough, markers } from "../repl-study/journal.ts";
import { formatRoute, navigationFor, parseRoute, ROUTE_SURFACES } from "../repl-study/route.ts";
import type { Route } from "../repl-study/route.ts";
import {
  fixtureFor,
  focusIn,
  hydrate,
  layoutOf,
  mapOf,
  openDrawer,
  projection,
  reduce,
  targets,
  viewOf,
} from "../repl-study/store.ts";
import type { HarnessEvent, ReplState, Size } from "../repl-study/store.ts";
import type { Mutation } from "../repl-study/mutations.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GOLDENS = fileURLToPath(new URL("./fixtures/repl-focus/", import.meta.url));
const MAIN = "scripts/repl-study/main.ts";

const WIDE: Size = PROFILE_SIZES.wide;
const NARROW: Size = PROFILE_SIZES.narrow;

function context(size: Size, mutation?: Mutation) {
  return { size, mutation, scrollLimit: 40 };
}

/** One keystroke, as the decoder would report it. */
function key(code: string, extra: Record<string, unknown> = {}): HarnessEvent {
  return { kind: "key", event: { type: "keydown", key: code, code, ...extra } };
}

function press(state: ReplState, code: string, size: Size = WIDE, mutation?: Mutation): ReplState {
  return reduce(state, key(code), context(size, mutation));
}

/** The identities in the ring, in the order Tab walks them. */
function ring(state: ReplState, size: Size = WIDE, mutation?: Mutation): string[] {
  return targets(state, size, mutation).map((target) => target.id);
}

function bytes(...codes: number[]): Uint8Array {
  return Uint8Array.from(codes);
}

/**
 * Feed raw bytes to the harness's own decoding path.
 *
 * Nothing synthesises an event here: the escape sequence goes in and whatever
 * the decoder produces comes out, including whatever the pending flush
 * eventually releases.
 */
function* decoded(input: Input, chunk: Uint8Array, mutation?: Mutation): Operation<InputEvent[]> {
  const events: InputEvent[] = [];
  yield* scanKeys(input, chunk, (event) => events.push(event), mutation);
  return events;
}

const ESC = 0x1b;

describe("the URL that says where you are", () => {
  it("round-trips every frame's location", function* () {
    for (const subject of FRAMES) {
      const parsed = parseRoute(subject.url);
      expect({ id: subject.id, ok: parsed.ok }).toEqual({ id: subject.id, ok: true });
      if (!parsed.ok) {
        continue;
      }
      expect(formatRoute(parsed.value)).toBe(subject.url);
    }
  });

  it("parses every part of the schema, and refuses what is not in it", function* () {
    const parsed = parseRoute(
      "xmd://repl/e1/transcript/entry-1/plan/+project?at=cp-07&draft=%3CPlan%3E",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value).toEqual({
      execution: "e1",
      surface: "transcript",
      scopes: ["entry-1", "plan"],
      drawers: ["project"],
      at: "cp-07",
      draft: "<Plan>",
    });

    const refusals = [
      "https://repl/e1/transcript",
      "xmd://repl/e1/nowhere",
      "xmd://repl//transcript",
      "xmd://repl/e1/transcript/+project/plan",
      "xmd://repl/e1/transcript?zoom=2",
      "xmd://repl/e1/transcript?at=",
    ];
    for (const url of refusals) {
      const result = parseRoute(url);
      expect({ url, ok: result.ok }).toEqual({ url, ok: false });
    }
  });

  it("spells the live head exactly one way", function* () {
    // There is no `at=head` sentinel, so two URLs cannot render the same state
    // and hydrate differently.
    const following = hydrate("xmd://repl/e1/history", journalThrough("cp-16"));
    expect(following.route.at).toBeUndefined();
    expect(following.moment.transport).toBe("paused");
    const inspecting = hydrate("xmd://repl/e1/history?at=cp-04", journalThrough("cp-16"));
    expect(inspecting.moment.transport).toBe("inspecting");
  });

  it("keeps a drawer from being mistaken for a scope of the same name", function* () {
    const parsed = parseRoute("xmd://repl/e1/transcript/project/+project");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.scopes).toEqual(["project"]);
    expect(parsed.value.drawers).toEqual(["project"]);
  });

  it("names a surface for every region focus can be in", function* () {
    expect([...ROUTE_SURFACES]).toEqual(["sessions", "transcript", "bindings", "input", "history"]);
  });
});

describe("every frame of the approved focus study", () => {
  it("rebuilds each frame's targets, numbering and focus from its URL", function* () {
    for (const subject of FRAMES) {
      const state = stateFor(subject);
      const layout = layoutOf(state, WIDE);
      const map = focusMap(state, layout);
      const numbers = numbering(map);
      // The study's overlay draws only the focused target when the map is off,
      // and numbers every visible one when it is on.
      const ordered = mapOrder(map);
      const shown = subject.overlay
        ? ordered
        : ordered.filter((target) => target.id === subject.focus);
      expect({
        frame: subject.id,
        targets: shown.map((target) => ({
          n: numbers.get(target.id),
          id: target.id,
          kind: target.kind,
        })),
      }).toEqual({
        frame: subject.id,
        targets: subject.targets.map((target) => ({
          n: target.n,
          id: target.id,
          kind: target.kind,
        })),
      });
      expect({ frame: subject.id, fixture: state.moment.shows }).toEqual({
        frame: subject.id,
        fixture: subject.fixture,
      });
      expect({ frame: subject.id, focus: focusIn(state, WIDE) }).toEqual({
        frame: subject.id,
        focus: subject.focus,
      });
    }
  });

  it("moves where the study says Tab and Shift+Tab move", function* () {
    for (const subject of FRAMES) {
      const live = targets(stateFor(subject), WIDE);
      expect({ frame: subject.id, tab: step(subject.focus, live, 1) }).toEqual({
        frame: subject.id,
        tab: subject.tab,
      });
      expect({ frame: subject.id, shift: step(subject.focus, live, -1) }).toEqual({
        frame: subject.id,
        shift: subject.shift,
      });
    }
  });

  it("walks the whole ring in both directions and comes back to the start", function* () {
    for (const subject of FRAMES) {
      const live = targets(stateFor(subject), WIDE);
      let forward = subject.focus;
      const visited: string[] = [];
      for (let at = 0; at < live.length; at += 1) {
        forward = step(forward, live, 1);
        visited.push(forward);
      }
      expect({ frame: subject.id, at: forward }).toEqual({ frame: subject.id, at: subject.focus });
      expect({ frame: subject.id, seen: new Set(visited).size }).toEqual({
        frame: subject.id,
        seen: live.length,
      });
      let back = subject.focus;
      for (let at = 0; at < live.length; at += 1) {
        back = step(back, live, -1);
      }
      expect({ frame: subject.id, at: back }).toEqual({ frame: subject.id, at: subject.focus });
    }
  });

  it("keeps the drawer's trap closed, with the footer inside it", function* () {
    for (const subject of FRAMES.filter((one) => one.meta.trap)) {
      const state = stateFor(subject);
      const ids = ring(state);
      expect({ frame: subject.id, last: ids[ids.length - 1] }).toEqual({
        frame: subject.id,
        last: "region:history",
      });
      expect({ frame: subject.id, panes: ids.filter((id) => id.startsWith("region:")) }).toEqual({
        frame: subject.id,
        panes: ["region:history"],
      });
    }
  });

  it("lets Tab escape the trap when the ring is rebuilt from the panes", function* () {
    const state = stateFor(frame("07")!);
    const leaked = ring(state, WIDE, "leak-drawer-trap");
    expect(leaked).toContain("region:transcript");
    expect(leaked).not.toContain("field:drawer.project.name");
  });

  it("numbers a disabled control in the map and skips it in the ring", function* () {
    const state = stateFor(frame("12")!);
    const map = mapOf(state, WIDE).map((target) => target.id);
    expect(map).toContain("control:transport.continue");
    expect(ring(state)).not.toContain("control:transport.continue");
  });

  it("admits a disabled control into the ring when the two lists are conflated", function* () {
    const state = stateFor(frame("12")!);
    expect(ring(state, WIDE, "focus-hidden-target")).toContain("control:transport.continue");
  });
});

describe("restoring focus when a target disappears", () => {
  it("walks to the nearest surviving owner", function* () {
    // Study frame 12: the reconstruction removed the drawer of frame 07, so its
    // trapped controls left the sequence.
    const suspended = stateFor(frame("07")!);
    const reconstructed = hydrate(
      "xmd://repl/e1/history/entry-1/document/plan?at=cp-04",
      suspended.journal,
    );
    expect(resolve("field:drawer.project.name", targets(reconstructed, WIDE))).toBe(
      "region:transcript",
    );
  });

  it("prefers a transport control's live counterpart over its owner", function* () {
    expect(counterpartOf("control:transport.continue")).toBe("control:transport.pause");
    const live = targets(stateFor(frame("13")!), WIDE);
    expect(resolve("control:transport.continue", live)).toBe("control:transport.pause");
  });

  it("reads ownership from the identity, so a target that is gone still has one", function* () {
    expect(ownerOf("control:transport.fork")).toBe("region:history");
    expect(ownerOf("control:input.run")).toBe("region:input");
    expect(ownerOf("field:drawer.project.name")).toBe("region:transcript");
    expect(ownerOf("region:history")).toBeUndefined();
  });

  it("falls back to the first target when the chain is exhausted", function* () {
    const live = targets(stateFor(frame("02")!), WIDE);
    expect(resolve("control:nothing.at.all", live)).toBe("region:sessions");
  });
});

describe("drawers, their trap and what they restore", () => {
  const opened = (): ReplState => {
    const base = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-12"));
    return openDrawer(base, "project", "region:transcript", WIDE);
  };

  it("puts focus on the drawer's first meaningful control", function* () {
    expect(opened().focus).toBe("field:drawer.project.name");
  });

  it("keeps only the top of a nested stack interactive", function* () {
    const nested = openDrawer(opened(), "confirm", "field:drawer.project.name", WIDE);
    expect(nested.route.drawers).toEqual(["project", "confirm"]);
    const ids = ring(nested);
    expect(ids).toEqual([
      "control:drawer.confirm.preview",
      "control:drawer.confirm.approve",
      "control:drawer.confirm.decline",
      "region:history",
    ]);
  });

  it("restores the identity that invoked it when Escape closes it", function* () {
    const nested = openDrawer(opened(), "confirm", "field:drawer.project.name", WIDE);
    const closed = press(nested, "Escape");
    expect(closed.route.drawers).toEqual(["project"]);
    expect(closed.focus).toBe("field:drawer.project.name");
    const outer = press(closed, "Escape");
    expect(outer.route.drawers).toEqual([]);
    expect(outer.focus).toBe("region:transcript");
  });

  it("closes the drawer without answering it", function* () {
    // The study's frame 09 gives the confirmation drawer `esc declines`.
    // Navigation is what this experiment owns, so Escape closes and answers
    // nothing: the suspension is still waiting afterwards.
    const state = stateFor(frame("09")!);
    const closed = press(state, "Escape");
    expect(closed.route.drawers).toEqual([]);
    expect(closed.moment.suspension).toBe("confirm");
  });

  it("leaves focus where it was when the invoker is forgotten", function* () {
    const closed = press(opened(), "Escape", WIDE, "forget-drawer-invoker");
    expect(closed.focus).toBe("field:drawer.project.name");
    expect(closed.route.drawers).toEqual([]);
  });
});

describe("inspecting a recorded moment", () => {
  const paused = (): ReplState =>
    hydrate("xmd://repl/e1/history/entry-1/document", journalThrough("cp-16"));

  const inspecting = (): ReplState =>
    hydrate("xmd://repl/e1/history/entry-1/document/plan?at=cp-04", journalThrough("cp-16"));

  it("refuses a mutation while a reconstruction is open", function* () {
    const state = { ...inspecting(), focus: "region:input" };
    const typed = press(state, "x");
    expect(typed.route.draft).toBe("");
    expect(typed).toBe(state);
  });

  it("permits that mutation when the read-only rule is removed", function* () {
    const state = { ...inspecting(), focus: "region:input" };
    expect(press(state, "x", WIDE, "mutate-while-inspecting").route.draft).toBe("x");
  });

  it("keeps every recorded marker visible, including the ones after it", function* () {
    const state = inspecting();
    const checkpoints = fixtureFor(state).history.checkpoints;
    const later = checkpoints.filter((point) => point.at > state.moment.at);
    expect(later.length).toBeGreaterThan(0);
  });

  it("withholds Continue until the paused head is regained", function* () {
    expect(ring(inspecting())).not.toContain("control:transport.continue");
    const returned = press({ ...inspecting(), focus: "control:transport.return-head" }, "Enter");
    expect(returned.route.at).toBeUndefined();
    expect(ring({ ...returned, focus: "region:history" })).toContain("control:transport.continue");
  });

  it("holds the transport slot across freezing and resuming", function* () {
    // Study frame 13: leaving history with Continue focused lands on Pause.
    const held = { ...paused(), focus: "control:transport.continue" };
    expect(focusIn(held, WIDE)).toBe("control:transport.continue");
    const resumed = press(held, "Enter");
    expect(resumed.moment.transport).toBe("live");
    expect(focusIn(resumed, WIDE)).toBe("control:transport.pause");
  });
});

describe("push versus replace", () => {
  const start = (): ReplState =>
    hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-12"));

  it("replaces the URL while a draft is typed", function* () {
    let state: ReplState = { ...start(), focus: "region:input" };
    const before = state.history.length;
    for (const glyph of ["a", "b", "c"]) {
      state = press(state, glyph);
    }
    expect(state.route.draft).toBe("abc");
    expect(state.history.length).toBe(before);
    expect(navigationFor("draft")).toBe("replace");
  });

  it("pushes one entry for a drawer and one for entering inspection", function* () {
    const drawer = openDrawer(start(), "project", "region:transcript", WIDE);
    expect(drawer.history.length).toBe(1);
    const scrubbed = press({ ...drawer, focus: "region:history" }, "ArrowLeft");
    const inspected = press(scrubbed, "Enter");
    expect(inspected.route.at).toBeDefined();
    expect(inspected.history.length).toBe(2);
    expect(navigationFor("drawer")).toBe("push");
    expect(navigationFor("inspection")).toBe("push");
  });

  it("returns Back to the head rather than through every scrubbed marker", function* () {
    let state = press({ ...start(), focus: "region:history" }, "ArrowLeft");
    state = press(state, "Enter");
    const entered = state.history.length;
    for (let at = 0; at < 6; at += 1) {
      state = press(state, "ArrowLeft");
    }
    expect(state.history.length).toBe(entered);
    expect(navigationFor("scrub")).toBe("replace");
    const back = press(state, "Escape");
    expect(back.route.at).toBeUndefined();
  });

  it("fills the navigation stack when every keystroke pushes", function* () {
    let state: ReplState = { ...start(), focus: "region:input" };
    for (const glyph of ["a", "b", "c"]) {
      state = press(state, glyph, WIDE, "push-draft-edits");
    }
    expect(state.history.length).toBe(3);
  });
});

describe("background updates", () => {
  const streaming = (): HarnessEvent => ({
    kind: "background",
    record: {
      marker: "cp-live",
      at: 50,
      kind: "session.started",
      scope: "document",
      detail: "review-b72e1d",
      shows: "drawer",
    },
  });

  it("changes nothing about where the person is", function* () {
    // Study frame 06. Reference equality, not deep equality: a reducer that
    // rebuilt an equal route would pass a deep comparison having already lost
    // the property this is about.
    const before = stateFor(frame("06")!);
    const after = reduce(before, streaming(), context(WIDE));
    expect(after.route).toBe(before.route);
    expect(after.focus).toBe(before.focus);
    expect(after.selection).toBe(before.selection);
    expect(after.anchor).toBe(before.anchor);
    expect(after.journal.length).toBe(before.journal.length + 1);
  });

  it("is rejected when the update moves focus", function* () {
    const before = stateFor(frame("06")!);
    const after = reduce(before, streaming(), context(WIDE, "steal-focus-on-background"));
    expect(after.focus).not.toBe(before.focus);
  });
});

describe("rebuilding from the URL and the journal alone", () => {
  /** A long interaction: typing, traversal, a drawer, inspection and back. */
  function journey(): ReplState {
    let state = hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-12"));
    state = press(state, "4");
    for (const glyph of ["<", "P", "l", "a", "n", ">"]) {
      state = press(state, glyph);
    }
    state = press(state, "Tab");
    state = press(state, "Backtab");
    state = openDrawer(state, "project", "region:transcript", WIDE);
    state = press(state, "Tab");
    state = press(state, "Escape");
    state = press(state, "5");
    state = press(state, "ArrowLeft");
    state = press(state, "ArrowLeft");
    state = press(state, "Enter");
    state = press(state, "ArrowLeft");
    return state;
  }

  it("comes back to the same semantic state with nothing else", function* () {
    const original = journey();
    expect(original.route.at).toBeDefined();
    expect(original.route.draft).toBe("<Plan>");
    expect(original.history.length).toBeGreaterThan(0);

    const rebuilt = hydrate(formatRoute(original.route), original.journal);
    expect(projection(rebuilt)).toEqual(projection(original));
  });

  it("lands the rebuilt state on a legitimate target", function* () {
    const rebuilt = hydrate(formatRoute(journey().route), journey().journal);
    const live = targets(rebuilt, WIDE);
    expect(live.map((target) => target.id)).toContain(focusIn(rebuilt, WIDE));
  });

  it("throws away the disposable half rather than pretending to restore it", function* () {
    const rebuilt = hydrate(formatRoute(journey().route), journey().journal);
    expect(rebuilt.anchor).toBe(0);
    expect(rebuilt.selection).toBe(-1);
    expect(rebuilt.history).toEqual([]);
  });

  it("folds the journal rather than reading the fixtures", function* () {
    // The journal is authored by hand from the study. A journal derived from
    // `fixtures.ts` would make this comparison the fixtures against themselves.
    const moment = fold(journalThrough("cp-08"));
    expect(moment.scope).toBe("Plan scope");
    expect(moment.published).toEqual(["inputs", "draft"]);
    expect(moment.suspension).toBe("review");
    expect(moment.sessions).toBe(2);
    expect(markers(JOURNAL).length).toBe(JOURNAL.length);
  });
});

describe("the same route at two profiles", () => {
  it("says the same thing wide and narrow", function* () {
    for (const subject of FRAMES) {
      const state = stateFor(subject);
      const before = projection(state);
      // The route is not where the profile is recorded, so composing it two
      // ways cannot lose it — which is a claim about a state that has actually
      // been through both compositions, not about one that was asked twice.
      expect(layoutOf(state, WIDE).profile).toBe("wide");
      expect(layoutOf(state, NARROW).profile).toBe("narrow");
      let moved = reduce(state, { kind: "resize", ...NARROW }, context(NARROW));
      moved = reduce(moved, { kind: "resize", ...WIDE }, context(WIDE));
      expect({ frame: subject.id, after: projection(moved) }).toEqual({
        frame: subject.id,
        after: before,
      });
      expect({ frame: subject.id, focus: focusIn(state, NARROW) }).toEqual({
        frame: subject.id,
        focus: focusIn(state, WIDE),
      });
    }
  });

  it("composes every frame at both profiles", function* () {
    for (const subject of FRAMES) {
      const state = stateFor(subject);
      for (const size of [WIDE, NARROW]) {
        const rendered = yield* renderFrame({
          fixture: fixtureFor(state),
          view: viewOf(state),
          size,
          focus: { here: focusIn(state, size), map: mapOf(state, size), overlay: true },
        });
        expect({ frame: subject.id, drew: rendered.text.trim().length > 0 }).toEqual({
          frame: subject.id,
          drew: true,
        });
      }
    }
  });

  it("keeps the route across a resize", function* () {
    const state = stateFor(frame("07")!);
    const resized = reduce(state, { kind: "resize", cols: 90, rows: 28 }, context(NARROW));
    expect(resized.route).toBe(state.route);
    expect(formatRoute(resized.route)).toBe(frame("07")!.url);
  });

  it("loses the route when a resize rebuilds it from the profile", function* () {
    const state = stateFor(frame("07")!);
    const resized = reduce(
      state,
      { kind: "resize", cols: 90, rows: 28 },
      context(NARROW, "drop-route-on-resize"),
    );
    expect(formatRoute(resized.route)).not.toBe(frame("07")!.url);
  });

  it("has nothing to focus on a terminal too small to compose one", function* () {
    const state = stateFor(frame("07")!);
    expect(focusMap(state, layoutOf(state, PROFILE_SIZES["too-small"]))).toEqual([]);
  });
});

describe("through a real decoder", () => {
  it("delivers a lone Escape only after the pending flush", function* () {
    const input: Input = yield* until(createInput({}));
    const immediate = input.scan(bytes(ESC));
    // The defect, stated as the library states it: the event list is empty and
    // the caller is asked to come back.
    expect(immediate.events).toEqual([]);
    expect(immediate.pending?.delay).toBeGreaterThan(0);

    const flushed = yield* decoded(yield* until(createInput({})), bytes(ESC));
    expect(flushed.map((event) => event.type)).toEqual(["keydown"]);
    expect(flushed.map((event) => ("code" in event ? event.code : ""))).toEqual(["Escape"]);
  });

  it("acts on the Escape those bytes produced", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC));
    let state = openDrawer(
      hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-12")),
      "project",
      "region:transcript",
      WIDE,
    );
    for (const event of events) {
      state = reduce(state, { kind: "key", event }, context(WIDE));
    }
    expect(state.route.drawers).toEqual([]);
  });

  it("swallows every Escape when the pending flush is dropped", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC), "swallow-pending-escape");
    expect(events).toEqual([]);
  });

  it("reads a real Shift+Tab, which arrives as Backtab with no shift flag", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC, 0x5b, 0x5a));
    expect(events.length).toBe(1);
    const [event] = events;
    expect("code" in event ? event.code : "").toBe("Backtab");
    expect("shift" in event ? event.shift : undefined).toBeUndefined();

    const state = stateFor(frame("03")!);
    let moved = state;
    for (const decodedEvent of events) {
      moved = reduce(moved, { kind: "key", event: decodedEvent }, context(WIDE));
    }
    expect(moved.focus).toBe(frame("03")!.shift);
  });

  it("traverses forward when only a synthetic Tab+shift counts as reverse", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC, 0x5b, 0x5a));
    let moved = stateFor(frame("03")!);
    for (const event of events) {
      moved = reduce(moved, { kind: "key", event }, context(WIDE, "ignore-backtab"));
    }
    expect(moved.focus).toBe(frame("03")!.tab);
  });

  it("decodes the modified arrows structural navigation is specified on", function* () {
    const input: Input = yield* until(createInput({}));
    const events = yield* decoded(input, bytes(ESC, 0x5b, 0x31, 0x3b, 0x35, 0x41));
    expect(events.length).toBe(1);
    const [event] = events;
    expect("code" in event ? event.code : "").toBe("ArrowUp");
    expect("ctrl" in event ? event.ctrl : undefined).toBe(true);
  });
});

describe("Ctrl+C, three ways", () => {
  const running = (): ReplState =>
    hydrate("xmd://repl/e1/transcript/entry-1/document", journalThrough("cp-06"));

  it("interrupts the entry that is running, and stays open", function* () {
    const state = running();
    const interrupted = press(state, "c", WIDE, undefined);
    expect(interrupted).toBe(state);
    const control = reduce(state, key("c", { ctrl: true }), context(WIDE));
    expect(control.quit).toBe(false);
    expect(control.interrupts).toBe(1);
  });

  it("clears a draft when nothing is running", function* () {
    const settled = hydrate("xmd://repl/e1/input?draft=%3CPlan%3E", journalThrough("cp-19"));
    const cleared = reduce(settled, key("c", { ctrl: true }), context(WIDE));
    expect(cleared.route.draft).toBe("");
    expect(cleared.quit).toBe(false);
  });

  it("leaves when the draft is empty and nothing is running", function* () {
    const settled = hydrate("xmd://repl/e1/input", journalThrough("cp-19"));
    expect(reduce(settled, key("c", { ctrl: true }), context(WIDE)).quit).toBe(true);
  });
});

describe("the frames, as pictures", () => {
  it("renders every committed focus capture exactly", function* () {
    const captures = yield* captureFocus();
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      const golden = yield* readTextFile(join(GOLDENS, `${capture.name}.txt`));
      expect(captureText(capture)).toBe(golden);
    }
  });

  it("draws the focused region and the numbered map", function* () {
    const subject = frame("12")!;
    const state = stateFor(subject);
    const rendered = yield* renderFrame({
      fixture: fixtureFor(state),
      view: viewOf(state),
      size: WIDE,
      focus: { here: focusIn(state, WIDE), map: mapOf(state, WIDE), overlay: true },
    });
    expect(rendered.text).toContain("FOCUS MAP");
    expect(rendered.text).toContain("Fork from here");
    expect(rendered.text).toContain("Continue · disabled while");
    expect(rendered.text).toContain("▸ 8");
  });

  it("says nothing about focus in a frame that was not asked about it", function* () {
    const state = stateFor(frame("07")!);
    const rendered = yield* renderFrame({
      fixture: fixtureFor(state),
      view: viewOf(state),
      size: WIDE,
    });
    expect(rendered.text).not.toContain("FOCUS MAP");
  });
});

describe("the documented command", () => {
  it("opens at a route, a frame and with the map on", function* () {
    for (const argument of [
      "--route xmd://repl/e1/transcript/entry-1/plan/+project",
      "--frame 07",
      "--frame 07 --focus-map",
    ]) {
      const result = yield* exec(`deno run --allow-all ${MAIN} ${argument}`, { cwd: ROOT }).join();
      // There is no terminal here, so the harness refuses interactive mode —
      // which is the proof that the invocation was understood rather than
      // rejected at the command line.
      expect({ argument, code: result.code }).toEqual({ argument, code: 2 });
      expect(`${result.stdout}${result.stderr}`).toContain("--capture");
    }
  });

  it("refuses a route it cannot parse, and a frame that does not exist", function* () {
    const bad = yield* exec(`deno run --allow-all ${MAIN} --route xmd://repl/e1/nowhere`, {
      cwd: ROOT,
    }).join();
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("is not a surface");

    const missing = yield* exec(`deno run --allow-all ${MAIN} --frame 99`, { cwd: ROOT }).join();
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain("--frame needs one of");
  });
});
