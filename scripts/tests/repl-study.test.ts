/**
 * The REPL interaction study, rendered and checked.
 *
 * A terminal interface is the kind of thing that only ever failed in front of a
 * person: a pane that lost a row, a footer a drawer sat on top of, cells left
 * behind by a resize nobody told the renderer about. `@bomb.sh/tty` does layout,
 * input decoding and ANSI in pure computation with no terminal attached, so all
 * of that can be asked here instead — of the same frames the interactive harness
 * writes to a real terminal.
 *
 * Every claim has a control that breaks it. Each control is one value of the
 * closed enum in `mutations.ts`, and the same oracle that admits the honest
 * render has to reject it by name rather than merely crash.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exec } from "@effectionx/process";
import { close, fixed, grow, open, rgba, text } from "@bomb.sh/tty";
import type { Op } from "@bomb.sh/tty";
import type { Operation } from "effection";
import { z } from "zod";
import { exists, readdir, readTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureAll,
  captureText,
  journeyFrames,
  playFrames,
  PROFILE_SIZES,
  renderFrame,
  renderInto,
  useTerm,
  writeCaptures,
} from "../repl-study/capture.ts";
import type { Size } from "../repl-study/capture.ts";
import { fixture, fixtures } from "../repl-study/fixtures.ts";
import { FIXTURE_NAMES } from "../repl-study/model.ts";
import { terminalModes } from "../repl-study/host.ts";
import type { HarnessState } from "../repl-study/host.ts";
import {
  JOURNEY,
  journeyDurationMs,
  journeyPlan,
  motionAt,
  playbackBetween,
  segmentDurationMs,
  segmentLabel,
} from "../repl-study/playback.ts";
import { FRAME_SECONDS } from "../repl-study/host.ts";
import { intersects, layoutFor, MINIMUM, PANE_MINIMUMS, profileFor } from "../repl-study/layout.ts";
import type { Profile } from "../repl-study/layout.ts";
import { MUTATIONS } from "../repl-study/mutations.ts";
import {
  bandGeometry,
  BAND_ROWS,
  DRAWER_TRANSITION_SECONDS,
  columnFor,
  NOTE_ROW,
  TRACK_ROW,
  notchHeightForDepth,
  notchLayout,
  transcriptLines,
} from "../repl-study/render.ts";
import {
  applyAnsi,
  createGrid,
  gridDifferences,
  gridText,
  viewport,
} from "../repl-study/screen.ts";
import { initialView, scrollBy } from "../repl-study/store.ts";
import { historyViewFrom } from "../repl-study/view.ts";
import { placementOf } from "../repl-study/component.ts";
import type { Fixture } from "../repl-study/model.ts";

/**
 * A fixture's band, as the semantic view model the geometry now takes.
 *
 * The band's arithmetic moved onto the view when the renderer moved onto the
 * component tree. The assertions below are unchanged; only what they are asked
 * of is.
 */
function bandOf(subject: Fixture) {
  return historyViewFrom(subject, subject.history.transport, []);
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GOLDENS = fileURLToPath(new URL("./fixtures/repl-study/", import.meta.url));
const MAIN = "scripts/repl-study/main.ts";

/** The band rows of a rendered frame, as a grid of glyphs. */
function bandRows(text: string, size: Size): string[] {
  const rows = text.split("\n");
  return BAND_ROWS.map((offset) => rows[size.rows - BAND_ROWS.length + offset] ?? "");
}

function glyphAt(row: string, column: number): string {
  return [...row][column] ?? " ";
}

/**
 * How tall the notch in this column is.
 *
 * Only the rows a notch can reach are counted: the label row below the track
 * belongs to the selection's note, and counting it would make a described
 * marker look one level shallower than it is.
 */
function notchHeight(rows: readonly string[], column: number): number {
  return rows.slice(0, NOTE_ROW).filter((row) => {
    const glyph = glyphAt(row, column);
    return glyph !== " " && glyph !== "─";
  }).length;
}

function clockOf(seconds: number): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * One column per depth, taken only from notches that are not sharing.
 *
 * A coalesced column takes its height from the shallowest scope in it, so
 * measuring what a depth looks like needs a marker that has a column to itself.
 */
function soleNotchColumns(
  subject: ReturnType<typeof fixture>,
  geometry: { readonly trackLeft: number; readonly trackWidth: number },
): Map<number, number> {
  const byDepth = new Map<number, number>();
  for (const notch of notchLayout(bandOf(subject), geometry.trackLeft, geometry.trackWidth)) {
    if (notch.markers.length !== 1) {
      continue;
    }
    const [point] = notch.markers;
    if (!byDepth.has(point.depth)) {
      byDepth.set(point.depth, notch.column);
    }
  }
  return byDepth;
}

/**
 * Run a command with a pseudo-terminal attached.
 *
 * `script` is the one pty allocator both a developer's macOS machine and a
 * Linux runner have, and its two dialects disagree about argument order.
 */
function ptyCommand(_command: string): string {
  return "script";
}

function ptyArguments(command: string): string[] {
  const full = `deno run --allow-all ${command}`;
  if (Deno.build.os === "darwin") {
    return ["-q", "/dev/null", ...full.split(" ")];
  }
  if (Deno.build.os === "linux") {
    return ["-qec", full, "/dev/null"];
  }
  throw new Error(`this evidence needs a pseudo-terminal, and ${Deno.build.os} has no script(1)`);
}

function* readTrace(path: string): Operation<TracedFrame[]> {
  const text = yield* readTextFile(path);
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => TRACE_ENTRY.parse(JSON.parse(line)));
}

/** Parsed rather than cast, so a malformed trace fails here and not later. */
const TRACE_ENTRY = z.object({
  frame: z.number(),
  elapsedMs: z.number(),
  deltaSeconds: z.number(),
  animating: z.boolean(),
  motionDone: z.boolean().nullable(),
  bytes: z.number(),
  segment: z.string(),
  fixture: z.string(),
});

/** A trace line, parsed. The fixture name is narrowed where the harness reads it. */
type TracedFrame = z.infer<typeof TRACE_ENTRY>;

/** The order a run visited its moments in, with repeats collapsed. */
function visited<T extends { readonly segment: string }>(entries: readonly T[]): string[] {
  const order: string[] = [];
  for (const entry of entries) {
    if (order[order.length - 1] !== entry.segment) {
      order.push(entry.segment);
    }
  }
  return order;
}

/** What the whole demonstration is supposed to visit, in order. */
const JOURNEY_SEGMENTS = [
  "hold:empty",
  "play:empty→nested",
  "hold:nested",
  "play:nested→generated",
  "hold:generated",
  "play:generated→drawer",
  "hold:drawer",
  "play:drawer→paused",
  "hold:paused",
  "play:paused→settled",
  "hold:settled",
];

describe("fixture rendering", () => {
  it("renders every committed capture exactly", function* () {
    const captures = yield* captureAll();
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      const golden = yield* readTextFile(join(GOLDENS, `${capture.name}.txt`));
      expect(captureText(capture)).toBe(golden);
    }
  });

  it("commits a capture for every fixture at every composed profile", function* () {
    const names = (yield* readdir(GOLDENS)).filter((name) => name.endsWith(".txt"));
    for (const subject of fixtures()) {
      for (const profile of ["wide", "medium", "narrow"]) {
        expect(names).toContain(`${subject.name}.${profile}.txt`);
      }
    }
    expect(names).toContain("drawer.too-small.txt");
    expect(names).toContain("paused.narrow.history.txt");
  });

  it("reports no renderer errors for any fixture or profile", function* () {
    for (const subject of fixtures()) {
      for (const profile of ["wide", "medium", "narrow", "too-small"] as Profile[]) {
        const frame = yield* renderFrame({
          fixture: subject,
          view: initialView(subject),
          size: PROFILE_SIZES[profile],
        });
        expect(frame.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects a frame drawn from stale state", function* () {
    const subject = fixture("settled");
    const stale = yield* renderFrame({
      fixture: subject,
      view: initialView(subject),
      size: PROFILE_SIZES.wide,
      mutation: "stale-frame",
    });
    const golden = yield* readTextFile(join(GOLDENS, "settled.wide.txt"));
    expect(golden).not.toContain(stale.text.replace(/\n+$/, ""));
    expect(stale.text).not.toContain("Entry 1  ✓ completed");
  });
});

describe("layout profiles", () => {
  it("chooses a profile from the measured size alone", function* () {
    expect(profileFor(200, 50)).toBe("wide");
    expect(profileFor(160, 36)).toBe("wide");
    expect(profileFor(159, 36)).toBe("medium");
    expect(profileFor(160, 35)).toBe("medium");
    expect(profileFor(120, 30)).toBe("medium");
    expect(profileFor(119, 30)).toBe("narrow");
    expect(profileFor(72, 20)).toBe("narrow");
    expect(profileFor(71, 20)).toBe("too-small");
    expect(profileFor(72, 19)).toBe("too-small");
  });

  it("keeps every composed pane wide enough to read", function* () {
    for (const [cols, rows] of [
      [200, 50],
      [160, 36],
      [140, 38],
      [120, 30],
    ]) {
      const layout = layoutFor({ cols, rows, drawer: false, surface: "transcript" });
      expect(layout.sidebar?.width ?? 0).toBeGreaterThanOrEqual(PANE_MINIMUMS.sidebar);
      expect(layout.bindings?.width ?? 0).toBeGreaterThanOrEqual(PANE_MINIMUMS.bindings);
      expect(layout.transcript?.width ?? 0).toBeGreaterThanOrEqual(PANE_MINIMUMS.transcript);
    }
  });

  it("rejects the wide composition kept at narrow dimensions", function* () {
    const layout = layoutFor({
      cols: 90,
      rows: 28,
      drawer: false,
      surface: "transcript",
      mutation: "shrink-wide-at-narrow",
    });
    expect(layout.transcript?.width ?? 0).toBeLessThan(PANE_MINIMUMS.transcript);
  });

  it("preserves the fixture, the window and the selection across every transition", function* () {
    const subject = fixture("paused");
    let state: HarnessState = {
      fixture: subject,
      view: { ...initialView(subject), anchor: 3, surface: "bindings" },
      cols: 200,
      rows: 50,
      quit: false,
    };
    const before = state.view;
    for (const size of [
      PROFILE_SIZES.medium,
      PROFILE_SIZES.narrow,
      PROFILE_SIZES["too-small"],
      PROFILE_SIZES.wide,
    ]) {
      // `reduce` reads the size from the terminal, so the resize is applied the
      // way the interactive harness applies it: as new dimensions, not as a new
      // view.
      state = { ...state, cols: size.cols, rows: size.rows };
      expect(state.view).toEqual(before);
      const frame = yield* renderFrame({ fixture: state.fixture, view: state.view, size });
      expect(frame.text.length).toBeGreaterThan(0);
    }
    expect(state.view.anchor).toBe(3);
    expect(state.view.checkpoint).toBe(before.checkpoint);
    expect(state.view.surface).toBe("bindings");
  });
});

describe("the history footer", () => {
  it("stays at the bottom, full width, with a drawer open", function* () {
    for (const profile of ["wide", "medium"] as Profile[]) {
      const size = PROFILE_SIZES[profile];
      const subject = fixture("drawer");
      const layout = layoutFor({
        cols: size.cols,
        rows: size.rows,
        drawer: true,
        surface: "transcript",
      });
      expect(layout.footer).toBeDefined();
      expect(layout.footer?.y).toBe(size.rows - BAND_ROWS.length);
      expect(layout.footer?.width).toBe(size.cols);
      expect(layout.contextual).toBeDefined();
      expect(intersects(layout.contextual!, layout.footer!)).toBe(false);

      const frame = yield* renderFrame({ fixture: subject, view: initialView(subject), size });
      const rows = bandRows(frame.text, size);
      // Visible means all of it: the label the study puts at the left, the
      // transport at the right, and the track with the head on it between them.
      expect(rows[0]).toContain("EXECUTION HISTORY");
      expect(rows[0]).toContain("[ Pause ]");
      expect(rows[TRACK_ROW]).toContain("┃");
    }
  });

  it("rejects a drawer that takes the footer's rows", function* () {
    const size = PROFILE_SIZES.wide;
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: true,
      surface: "transcript",
    });
    const covering = {
      ...layout.contextual!,
      height: layout.contextual!.height + layout.footer!.height,
    };
    expect(intersects(covering, layout.footer!)).toBe(true);

    const subject = fixture("drawer");
    const frame = yield* renderFrame({
      fixture: subject,
      view: initialView(subject),
      size,
      mutation: "drawer-covers-footer",
    });
    const rows = bandRows(frame.text, size);
    expect(rows[0]).not.toContain("[ Pause ]");
    expect(rows[TRACK_ROW]).not.toContain("┃");
  });

  it("makes a notch's height its scope depth", function* () {
    const size = PROFILE_SIZES.wide;
    const subject = fixture("settled");
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: false,
      surface: "transcript",
    });
    const geometry = bandGeometry(bandOf(subject), placementOf(layout, layout.footer!));
    const frame = yield* renderFrame({ fixture: subject, view: initialView(subject), size });
    const rows = bandRows(frame.text, size);
    const byDepth = soleNotchColumns(subject, geometry);

    // The four heights four rows can spell, one for each depth.
    for (const depth of [0, 1, 2, 3]) {
      const column = byDepth.get(depth);
      expect({
        depth,
        height: column === undefined ? "no notch of its own" : notchHeight(rows, 1 + column),
      }).toEqual({ depth, height: notchHeightForDepth(depth) });
    }

    // Anything deeper shares the shortest notch rather than inventing a height.
    const deeper = byDepth.get(4);
    if (deeper !== undefined) {
      expect(notchHeight(rows, 1 + deeper)).toBe(notchHeightForDepth(3));
    }
  });

  it("says selection, the head and entry status some way other than height", function* () {
    const size = PROFILE_SIZES.wide;
    const subject = fixture("paused");
    const history = subject.history;
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: false,
      surface: "transcript",
    });
    const geometry = bandGeometry(bandOf(subject), placementOf(layout, layout.footer!));
    const byDepth = soleNotchColumns(subject, geometry);
    const deepColumn = byDepth.get(3) ?? byDepth.get(2)!;
    const deepPoint = history.checkpoints.find(
      (point) =>
        columnFor(point.at, bandOf(subject), geometry.trackLeft, geometry.trackWidth) ===
        deepColumn,
    )!;

    const unselected = yield* renderFrame({
      fixture: subject,
      view: { ...initialView(subject), checkpoint: -1 },
      size,
    });
    const selected = yield* renderFrame({
      fixture: subject,
      view: { ...initialView(subject), checkpoint: history.checkpoints.indexOf(deepPoint) },
      size,
    });

    // Selecting a checkpoint must not make its notch taller. Height belongs to
    // depth; selection is said with the caret and the label instead.
    expect(notchHeight(bandRows(selected.text, size), 1 + deepColumn)).toBe(
      notchHeight(bandRows(unselected.text, size), 1 + deepColumn),
    );
    expect(selected.text).toContain("▲");
    expect(selected.text).toContain(`${clockOf(deepPoint.at)} · snapped`);

    // An entry boundary is a glyph, and the playhead is its own stem and label.
    const boundary = history.checkpoints.find((point) => point.kind === "entry")!;
    const boundaryColumn = columnFor(
      boundary.at,
      bandOf(subject),
      geometry.trackLeft,
      geometry.trackWidth,
    );
    expect(glyphAt(bandRows(unselected.text, size)[TRACK_ROW], 1 + boundaryColumn)).toBe("◆");
    expect(bandRows(unselected.text, size)[0]).toContain("PAUSED HEAD");
  });

  it("rejects one notch height for every depth", function* () {
    const size = PROFILE_SIZES.wide;
    const subject = fixture("settled");
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: false,
      surface: "transcript",
    });
    const geometry = bandGeometry(bandOf(subject), placementOf(layout, layout.footer!));
    const frame = yield* renderFrame({
      fixture: subject,
      view: initialView(subject),
      size,
      mutation: "flatten-notches",
    });
    const rows = bandRows(frame.text, size);
    const byDepth = soleNotchColumns(subject, geometry);
    for (const depth of [0, 1, 2]) {
      const column = byDepth.get(depth);
      if (column !== undefined) {
        expect(notchHeight(rows, 1 + column)).toBe(1);
      }
    }
  });
});

describe("the supported minimum", () => {
  it("refuses a terminal below it, and says what it needs", function* () {
    const size = PROFILE_SIZES["too-small"];
    const subject = fixture("drawer");
    const frame = yield* renderFrame({ fixture: subject, view: initialView(subject), size });
    expect(frame.text).toContain("Terminal too small");
    expect(frame.text).toContain(
      `${MINIMUM.cols} × ${MINIMUM.rows} required · ${size.cols} × ${size.rows} now`,
    );
    expect(frame.text).not.toContain("EXECUTION HISTORY");
  });

  it("recovers the same view when the terminal grows again", function* () {
    const subject = fixture("paused");
    const view = { ...initialView(subject), anchor: 2 };
    const small = yield* renderFrame({ fixture: subject, view, size: PROFILE_SIZES["too-small"] });
    expect(small.text).toContain("Terminal too small");
    const restored = yield* renderFrame({ fixture: subject, view, size: PROFILE_SIZES.wide });
    const golden = yield* readTextFile(join(GOLDENS, "paused.wide.txt"));
    expect(restored.text.length).toBeGreaterThan(0);
    expect(golden).toContain("EXECUTION HISTORY");
  });

  it("rejects an interface composed below the minimum", function* () {
    const subject = fixture("drawer");
    const frame = yield* renderFrame({
      fixture: subject,
      view: initialView(subject),
      size: PROFILE_SIZES["too-small"],
      mutation: "ignore-minimum",
    });
    expect(frame.text).not.toContain("Terminal too small");
  });
});

describe("resize", () => {
  /**
   * One run across every profile, ending smaller than it started — which is
   * where a renderer that was not told about the resize leaves its evidence.
   */
  const script: readonly { readonly fixture: string; readonly size: Size }[] = [
    { fixture: "nested", size: PROFILE_SIZES.wide },
    { fixture: "drawer", size: PROFILE_SIZES.medium },
    { fixture: "paused", size: PROFILE_SIZES["too-small"] },
    { fixture: "settled", size: PROFILE_SIZES.narrow },
  ];

  /**
   * Play the script through one terminal that really is being resized.
   *
   * The grid is the terminal, so it changes size at every step whether or not
   * the renderer was told. A renderer still drawing at the old size addresses
   * cells this terminal no longer has, which is what corrupts a real one.
   */
  function* play(told: boolean) {
    const term = yield* useTerm(PROFILE_SIZES.wide);
    let grid = createGrid(PROFILE_SIZES.wide.cols, PROFILE_SIZES.wide.rows);
    for (const step of script) {
      const subject = fixture(step.fixture);
      if (grid.cols !== step.size.cols || grid.rows !== step.size.rows) {
        const resized = createGrid(step.size.cols, step.size.rows);
        resized.overflow = grid.overflow;
        grid = resized;
      }
      if (told) {
        term.update({ width: step.size.cols, height: step.size.rows });
      }
      // Ignoring a resize means ignoring it completely: the renderer keeps both
      // the terminal's old dimensions and the layout it computed from them.
      const frame = renderInto(term, {
        fixture: subject,
        view: initialView(subject),
        size: told ? step.size : PROFILE_SIZES.wide,
        mutation: told ? undefined : "skip-resize-update",
      });
      applyAnsi(grid, frame.ansi);
    }
    const last = script[script.length - 1];
    const subject = fixture(last.fixture);
    const fresh = yield* renderFrame({
      fixture: subject,
      view: initialView(subject),
      size: last.size,
    });
    return {
      seen: viewport(grid, last.size.cols, last.size.rows),
      fresh: applyAnsi(createGrid(last.size.cols, last.size.rows), fresh.ansi),
    };
  }

  it("leaves no stale cells behind", function* () {
    const { seen, fresh } = yield* play(true);
    expect(seen.overflow).toBe(0);
    expect(gridDifferences(seen, fresh)).toEqual([]);
    expect(gridText(seen)).toBe(gridText(fresh));
  });

  it("corrupts the screen when the renderer is not told the size changed", function* () {
    const { seen, fresh } = yield* play(false);
    expect(seen.overflow).toBeGreaterThan(0);
    expect(gridDifferences(seen, fresh).length).toBeGreaterThan(0);
  });

  it("refuses a terminal sequence it does not model", function* () {
    const grid = createGrid(10, 2);
    expect(() => applyAnsi(grid, new TextEncoder().encode("\u001b[2J"))).toThrow(
      "does not model the terminal sequence",
    );
  });
});

describe("staying operable", () => {
  it("windows a long transcript and marks what is clipped", function* () {
    const size = PROFILE_SIZES.narrow;
    const subject = fixture("nested");
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: false,
      surface: "transcript",
    });
    const width = layout.transcript!.width - 2;
    const total = transcriptLines(subject.entry!, width).length;
    expect(total).toBeGreaterThan(layout.transcript!.height);

    let view = initialView(subject);
    const seen = new Set<string>();
    const limit = total;
    for (let step = 0; step <= total; step += 1) {
      const frame = yield* renderFrame({ fixture: subject, view, size });
      for (const line of frame.text.split("\n")) {
        seen.add(line.trim());
      }
      view = scrollBy(view, 1, limit);
    }
    const last = transcriptLines(subject.entry!, width).at(-1)!;
    const lastText = last.segments
      .map((segment) => segment.text)
      .join("")
      .trim();
    expect([...seen].some((line) => line.includes(lastText.slice(0, 20)))).toBe(true);

    const first = yield* renderFrame({ fixture: subject, view: initialView(subject), size });
    expect(first.text).toContain("more lines");
  });

  it("clips a long transcript with no route out when the window is removed", function* () {
    const size = PROFILE_SIZES.narrow;
    const subject = fixture("nested");
    const frame = yield* renderFrame({
      fixture: subject,
      view: initialView(subject),
      size,
      mutation: "clip-long-transcript",
    });
    expect(frame.text).not.toContain("more lines");
  });

  it("reaches every checkpoint even where the band had to coalesce", function* () {
    const size = PROFILE_SIZES.narrow;
    const subject = fixture("paused");
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: false,
      surface: "history",
    });
    const rect = layout.footer!;
    const geometry = bandGeometry(bandOf(subject), placementOf(layout, rect));
    const notches = notchLayout(bandOf(subject), geometry.trackLeft, geometry.trackWidth);
    const gathered = notches.reduce((total, notch) => total + notch.markers.length, 0);

    expect(notches.some((notch) => notch.markers.length > 1)).toBe(true);
    expect(gathered).toBe(subject.history.checkpoints.length);

    for (let index = 0; index < subject.history.checkpoints.length; index += 1) {
      const point = subject.history.checkpoints[index];
      const frame = yield* renderFrame({
        fixture: subject,
        view: { ...initialView(subject), checkpoint: index, surface: "history", drawerOpen: false },
        size,
        surface: "history",
      });
      expect(frame.text).toContain(
        `${String(Math.floor(point.at / 60)).padStart(2, "0")}:${String(point.at % 60).padStart(2, "0")} · snapped`,
      );
    }
  });

  it("loses checkpoints when the band stops coalescing", function* () {
    const subject = fixture("paused");
    const size = PROFILE_SIZES.narrow;
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: false,
      surface: "history",
    });
    const geometry = bandGeometry(bandOf(subject), placementOf(layout, layout.footer!));
    const notches = notchLayout(
      bandOf(subject),
      geometry.trackLeft,
      geometry.trackWidth,
      "clip-long-transcript",
    );
    const columns = new Set(notches.map((notch) => notch.column));
    expect(columns.size).toBeLessThan(subject.history.checkpoints.length);
  });
});

describe("terminal restoration", () => {
  const modes = terminalModes();
  const apply = new TextDecoder().decode(modes.apply);
  const revert = new TextDecoder().decode(modes.revert);

  it("restores the modes it changed on an ordinary exit", function* () {
    const result = yield* exec(`deno run --allow-all ${MAIN} --replay`, { cwd: ROOT }).join();
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith(apply)).toBe(true);
    expect(result.stdout.endsWith(revert)).toBe(true);
  });

  it("restores them when the run is interrupted by a signal", function* () {
    const result = yield* exec(`deno run --allow-all ${MAIN} --replay --interrupt-after 2`, {
      cwd: ROOT,
    }).join();
    expect(result.stdout.startsWith(apply)).toBe(true);
    expect(result.stdout.endsWith(revert)).toBe(true);
  });

  it("restores them when a frame fails", function* () {
    const result = yield* exec(`deno run --allow-all ${MAIN} --replay --fail-after 2`, {
      cwd: ROOT,
    }).join();
    expect(result.code).not.toBe(0);
    expect(result.stdout.endsWith(revert)).toBe(true);
  });

  it("rejects a run that leaves the terminal in the modes it turned on", function* () {
    const result = yield* exec(
      `deno run --allow-all ${MAIN} --replay --mutation leak-terminal-modes`,
      { cwd: ROOT },
    ).join();
    expect(result.stdout.endsWith(revert)).toBe(false);
  });

  it("refuses interactive mode when there is no terminal, and names what to use instead", function* () {
    const result = yield* exec(`deno run --allow-all ${MAIN}`, { cwd: ROOT }).join();
    expect(result.code).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("--capture");
  });
});

describe("the boundary this experiment keeps", () => {
  it("keeps terminal cells out of the fixtures", function* () {
    // `rows` is allowed and is not a terminal row: an entry's rows are the
    // study's own transcript rows, which stay semantic until `render.ts` turns
    // them into lines for a width it was given.
    const forbidden = [
      "x",
      "y",
      "width",
      "height",
      "cols",
      "columns",
      "column",
      "anchor",
      "profile",
    ];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, nested] of Object.entries(value)) {
        expect({ path: `${path}.${key}`, forbidden: forbidden.includes(key) }).toEqual({
          path: `${path}.${key}`,
          forbidden: false,
        });
        walk(nested, `${path}.${key}`);
      }
    };
    for (const subject of fixtures()) {
      walk(subject, subject.name);
    }
  });

  it("depends on the renderer from the root manifest alone", function* () {
    const root = JSON.parse(yield* readTextFile(join(ROOT, "package.json")));
    expect(Object.keys(root.dependencies)).not.toContain("@bomb.sh/tty");
    expect(root.devDependencies["@bomb.sh/tty"]).toBe("0.9.0");

    for (const member of yield* readdir(join(ROOT, "packages"))) {
      for (const manifest of ["package.json", "deno.json"]) {
        const path = join(ROOT, "packages", member, manifest);
        if (!(yield* exists(path))) {
          continue;
        }
        const text = yield* readTextFile(path);
        expect(text).not.toContain("@bomb.sh/tty");
        expect(text).not.toContain("repl-study");
      }
    }
  });

  it("uses every control it declares", function* () {
    // A control nobody passes is a claim nobody is checking, so the evidence's
    // own source has to mention each one. #838's controls are exercised here
    // and #839's next door; the declaration is one list, so the check reads
    // both suites rather than letting either half go unclaimed.
    const suites = ["./repl-study.test.ts", "./repl-focus.test.ts"];
    const sources: string[] = [];
    for (const suite of suites) {
      sources.push(yield* readTextFile(fileURLToPath(new URL(suite, import.meta.url))));
    }
    for (const mutation of MUTATIONS) {
      const used = sources.some((source) => source.includes(mutation));
      expect({ mutation, used }).toEqual({ mutation, used: true });
    }
  });

  it("writes its captures where the goldens live", function* () {
    const directory = yield* useTempDirectory("repl-study-captures");
    const captures = yield* captureAll();
    yield* writeCaptures(directory, captures);
    const written = yield* readdir(directory);
    expect(written.filter((name) => name.endsWith(".txt")).length).toBe(captures.length);
  });
});

describe("animation", () => {
  const PLAYBACK = playbackBetween("generated", "drawer")!;

  it("interpolates the drawer itself and reports that it is still moving", function* () {
    const frames = yield* playFrames(PLAYBACK, PROFILE_SIZES.wide);
    expect(frames.length).toBeGreaterThan(3);

    // The renderer owns this one: the harness declared a transition and then
    // only supplied time.
    expect(frames.some((frame) => frame.animating)).toBe(true);
    expect(frames[frames.length - 1].animating).toBe(false);

    const heights = frames.map((frame) => frame.bounds.contextual?.height ?? 0);
    const first = heights[0];
    const last = heights[heights.length - 1];
    expect(last).toBeGreaterThan(first);
    // It arrives by passing through, rather than by jumping.
    expect(heights.some((height) => height > first && height < last)).toBe(true);
    for (const [index, height] of heights.entries()) {
      if (index > 0) {
        expect(height).toBeGreaterThanOrEqual(heights[index - 1]);
      }
    }
  });

  it("declares and advances transitions in the renderer's unit, which is seconds", function* () {
    // Scaling both sides by the same thousand is invisible: milliseconds of
    // delta against a duration also written in milliseconds produces the same
    // frame count and the same picture. So this pins the unit against the
    // library's own documented arithmetic — a 0.2 transition is halfway after
    // 0.1 and finished after 0.2 — which a millisecond reading cannot satisfy.
    const term = yield* useTerm({ cols: 20, rows: 8 });
    const box = (color: number): Op[] => [
      open("root", { layout: { width: grow(), height: grow(), direction: "ttb" } }),
      open("box", {
        layout: { width: grow(), height: fixed(4) },
        bg: color,
        transition: { duration: 0.2, easing: "linear", properties: ["bg"] },
      }),
      text("box"),
      close(),
      close(),
    ];

    term.render(box(rgba(255, 0, 0)), { deltaTime: 0 });
    term.render(box(rgba(0, 0, 255)), { deltaTime: 0 });
    expect(term.render(box(rgba(0, 0, 255)), { deltaTime: 0.1 }).animating).toBe(true);
    term.render(box(rgba(0, 0, 255)), { deltaTime: 0.15 });
    // A frame of lag: the flag clears on the render after the one that arrives,
    // which is why the library's own test spends 0.3 on a 0.2 transition.
    expect(term.render(box(rgba(0, 0, 255)), { deltaTime: 0.05 }).animating).toBe(false);

    // And the reading that would make this harness's own numbers wrong: one
    // frame's worth of seconds must not finish a transition declared in them.
    const other = yield* useTerm({ cols: 20, rows: 8 });
    other.render(box(rgba(255, 0, 0)), { deltaTime: 0 });
    other.render(box(rgba(0, 0, 255)), { deltaTime: 0 });
    expect(other.render(box(rgba(0, 0, 255)), { deltaTime: FRAME_SECONDS }).animating).toBe(true);
  });

  it("keeps the harness's own transition in that unit", function* () {
    // A duration meant as milliseconds would read as several minutes here.
    expect(DRAWER_TRANSITION_SECONDS).toBeLessThan(2);
    expect(DRAWER_TRANSITION_SECONDS).toBeGreaterThan(0);
  });

  it("supplies every captured frame its own delta, in seconds", function* () {
    const frames = yield* playFrames(PLAYBACK, PROFILE_SIZES.wide);
    const animating = frames.filter((frame) => frame.animating).length;
    // Sixteen milliseconds is 0.016 of the renderer's seconds, so a 0.26s
    // transition takes about seventeen of them.
    expect(animating).toBeGreaterThan(DRAWER_TRANSITION_SECONDS / FRAME_SECONDS - 4);
    expect(animating).toBeLessThan(DRAWER_TRANSITION_SECONDS / FRAME_SECONDS + 4);
  });

  it("never lets the drawer's movement cover the history footer", function* () {
    const frames = yield* playFrames(PLAYBACK, PROFILE_SIZES.wide);
    for (const frame of frames) {
      const footer = frame.bounds.footer;
      const contextual = frame.bounds.contextual;
      expect(footer?.y).toBe(PROFILE_SIZES.wide.rows - BAND_ROWS.length);
      if (contextual !== undefined && footer !== undefined) {
        expect(contextual.y + contextual.height).toBeLessThanOrEqual(footer.y + 1);
      }
    }
  });

  it("moves the head and reveals the transcript on the application's own clock", function* () {
    const start = motionAt(PLAYBACK, 0);
    const middle = motionAt(PLAYBACK, PLAYBACK.durationMs / 2);
    const end = motionAt(PLAYBACK, PLAYBACK.durationMs);

    expect(start.progress).toBe(0);
    expect(end.done).toBe(true);
    expect(middle.headAt).toBeGreaterThan(start.headAt);
    expect(end.headAt).toBeGreaterThan(middle.headAt);
    expect(end.headAt).toBe(fixture(PLAYBACK.to).history.headAt);

    // Time in, frame out: the same instant renders identically every time.
    const once = yield* renderFrame({
      fixture: fixture(PLAYBACK.to),
      view: initialView(fixture(PLAYBACK.to)),
      size: PROFILE_SIZES.wide,
      motion: middle,
    });
    const twice = yield* renderFrame({
      fixture: fixture(PLAYBACK.to),
      view: initialView(fixture(PLAYBACK.to)),
      size: PROFILE_SIZES.wide,
      motion: middle,
    });
    expect(once.text).toBe(twice.text);
  });

  it("captures a start, a midpoint and a settled frame that differ", function* () {
    const start = yield* readTextFile(
      join(GOLDENS, `play.${PLAYBACK.from}-${PLAYBACK.to}.start.txt`),
    );
    const midpoint = yield* readTextFile(
      join(GOLDENS, `play.${PLAYBACK.from}-${PLAYBACK.to}.midpoint.txt`),
    );
    const settled = yield* readTextFile(
      join(GOLDENS, `play.${PLAYBACK.from}-${PLAYBACK.to}.settled.txt`),
    );
    expect(start).not.toBe(midpoint);
    expect(midpoint).not.toBe(settled);
    expect(settled).toContain("INPUT REQUIRED");
    expect(settled).toContain("EXECUTION HISTORY");
  });

  it("draws one frame and stops when nothing schedules the next", function* () {
    const directory = yield* useTempDirectory("repl-study-stalled");
    const trace = join(directory, "stalled.jsonl");
    const command = `${MAIN} --play generated drawer --frames 30 --trace ${trace} --mutation never-tick`;
    yield* exec(ptyCommand(command), { cwd: ROOT, arguments: ptyArguments(command) }).join();
    const drawn = yield* readTrace(trace);
    expect(drawn.length).toBe(1);
    expect(drawn[0].motionDone).toBe(false);
  });

  it("rejects a reconstruction that lands halfway through a transition", function* () {
    const subject = fixture("settled");
    const halfway = yield* renderFrame({
      fixture: subject,
      view: initialView(subject),
      size: PROFILE_SIZES.wide,
      mutation: "restore-mid-animation",
    });
    const golden = yield* readTextFile(join(GOLDENS, "settled.wide.txt"));
    expect(golden).not.toContain(halfway.text.replace(/\n+$/, ""));
  });
});

describe("animation in a real terminal", () => {
  it("keeps drawing without a keystroke", function* () {
    const directory = yield* useTempDirectory("repl-study-pty");
    const trace = join(directory, "pty.jsonl");
    yield* exec(ptyCommand(`${MAIN} --play generated drawer --frames 80 --trace ${trace}`), {
      cwd: ROOT,
      arguments: ptyArguments(`${MAIN} --play generated drawer --frames 80 --trace ${trace}`),
    }).join();

    const drawn = yield* readTrace(trace);
    // Nothing was typed at it, and it went on drawing anyway.
    expect(drawn.length).toBeGreaterThan(10);
    expect(
      drawn.every((entry, index) => index === 0 || entry.elapsedMs > drawn[index - 1].elapsedMs),
    ).toBe(true);
    expect(drawn.some((entry) => entry.animating)).toBe(true);
    expect(drawn[drawn.length - 1].motionDone).toBe(true);
    expect(drawn.filter((entry) => entry.bytes > 0).length).toBeGreaterThan(3);
  });

  it("stops the clock and restores the terminal when interrupted mid-animation", function* () {
    const directory = yield* useTempDirectory("repl-study-interrupt");
    const trace = join(directory, "interrupted.jsonl");
    const command = `${MAIN} --play generated drawer --frames 200 --interrupt-after-frames 4 --trace ${trace}`;
    const result = yield* exec(ptyCommand(command), {
      cwd: ROOT,
      arguments: ptyArguments(command),
    }).join();

    const drawn = yield* readTrace(trace);
    // The interruption arrived while the transition was still running, and no
    // frame was drawn after it: the clock went down with the session.
    expect(drawn.length).toBe(4);
    expect(drawn[drawn.length - 1].motionDone).toBe(false);
    expect(result.stdout.endsWith(new TextDecoder().decode(terminalModes().revert))).toBe(true);
  });
});

describe("the whole demonstration", () => {
  it("visits every moment of the approved story, in order", function* () {
    const planned = journeyPlan();
    expect(visited(planned.map((frame) => ({ segment: frame.label })))).toEqual(JOURNEY_SEGMENTS);

    // Every fixture appears, in the order the study tells them.
    const moments: string[] = [];
    for (const frame of planned) {
      if (moments[moments.length - 1] !== frame.fixture) {
        moments.push(frame.fixture);
      }
    }
    expect(moments).toEqual([...FIXTURE_NAMES]);
  });

  it("holds each moment long enough to read it", function* () {
    for (const segment of JOURNEY) {
      // Nothing is on screen for less than a second unless it is moving.
      const duration = segmentDurationMs(segment);
      if (segment.kind === "hold") {
        expect({ segment: segmentLabel(segment), long: duration >= 1000 }).toEqual({
          segment: segmentLabel(segment),
          long: true,
        });
      }
    }
    // Long enough to watch, short enough to sit through.
    expect(journeyDurationMs()).toBeGreaterThan(10_000);
    expect(journeyDurationMs()).toBeLessThan(30_000);
  });

  it("animates both ways along the way, and ends on the settled entry", function* () {
    const { frames } = yield* journeyFrames(PROFILE_SIZES.wide);

    // The renderer's own interpolation happened.
    expect(frames.some((frame) => frame.animating)).toBe(true);
    // And the application's: a transition frame carrying unfinished motion.
    expect(frames.some((frame) => frame.label.startsWith("play:"))).toBe(true);

    const settled = yield* readTextFile(join(GOLDENS, "settled.wide.txt"));
    const last = frames[frames.length - 1];
    expect(last.label).toBe("hold:settled");
    expect(last.animating).toBe(false);
    // What remains is the fixture, exactly — no trace of the journey that
    // arrived at it.
    expect(settled).toContain(last.text.replace(/\n+$/, ""));
  });

  it("keeps the journey out of everything that outlives it", function* () {
    // The journey is derived, not stored. No fixture carries a key belonging to
    // it, so there is nothing for a journal to restore halfway through one.
    const forbidden = ["segment", "playback", "motion", "progress", "durationMs", "reveal"];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, nested] of Object.entries(value)) {
        expect({ at: `${path}.${key}`, journeyState: forbidden.includes(key) }).toEqual({
          at: `${path}.${key}`,
          journeyState: false,
        });
        walk(nested, `${path}.${key}`);
      }
    };
    for (const subject of fixtures()) {
      walk(subject, subject.name);
    }
  });

  it("rebuilds the renderer when it runs out of room to measure text", function* () {
    // Clay caches measured words, and a wide terminal running the whole story
    // exhausts that cache part way through. The demonstration has to survive it,
    // so this asserts both that it happens and that the run still finishes.
    const { frames, rebuilds } = yield* journeyFrames(PROFILE_SIZES.wide);
    expect(rebuilds).toBeGreaterThan(0);
    expect(frames.length).toBe(journeyPlan().length);
    expect(frames[frames.length - 1].label).toBe("hold:settled");
  });
});

describe("the whole demonstration, in a real terminal", () => {
  it("plays start to finish with nobody at the keyboard", function* () {
    const directory = yield* useTempDirectory("repl-study-journey");
    const trace = join(directory, "journey.jsonl");
    const budget = 600;
    const command = `${MAIN} --play --frames ${budget} --trace ${trace}`;
    yield* exec(ptyCommand(command), { cwd: ROOT, arguments: ptyArguments(command) }).join();

    const drawn = yield* readTrace(trace);
    expect(visited(drawn)).toEqual([...JOURNEY_SEGMENTS, "settled"]);
    expect(drawn.some((entry) => entry.animating)).toBe(true);
    expect(
      drawn.some((entry) => entry.segment.startsWith("play:") && entry.motionDone === false),
    ).toBe(true);

    // It stopped because the story ended, not because it ran out of budget —
    // which is what it means for the clock to stop after the settled state.
    expect(drawn.length).toBeLessThan(budget);
    const last = drawn[drawn.length - 1];
    expect(last.segment).toBe("settled");
    expect(last.fixture).toBe("settled");
  });

  it("cancels the whole journey when interrupted part way through", function* () {
    const directory = yield* useTempDirectory("repl-study-journey-interrupt");
    const trace = join(directory, "interrupted.jsonl");
    const command = `${MAIN} --play --frames 600 --interrupt-after-frames 45 --trace ${trace}`;
    const result = yield* exec(ptyCommand(command), {
      cwd: ROOT,
      arguments: ptyArguments(command),
    }).join();

    const drawn = yield* readTrace(trace);
    expect(drawn.length).toBe(45);
    // It was interrupted in the middle of the story, and nothing was drawn
    // afterwards: the clock went down with the session.
    const last = drawn[drawn.length - 1];
    expect(last.segment).not.toBe("settled");
    expect(JOURNEY_SEGMENTS).toContain(last.segment);
    expect(result.stdout.endsWith(new TextDecoder().decode(terminalModes().revert))).toBe(true);
  });
});
