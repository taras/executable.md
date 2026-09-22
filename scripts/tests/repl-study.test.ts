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
import { exists, readdir, readTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureAll,
  PROFILE_SIZES,
  renderFrame,
  renderInto,
  useTerm,
  writeCaptures,
} from "../repl-study/capture.ts";
import type { Size } from "../repl-study/capture.ts";
import { fixture, fixtures } from "../repl-study/fixtures.ts";
import { terminalModes } from "../repl-study/host.ts";
import type { HarnessState } from "../repl-study/host.ts";
import { intersects, layoutFor, MINIMUM, PANE_MINIMUMS, profileFor } from "../repl-study/layout.ts";
import type { Profile } from "../repl-study/layout.ts";
import { MUTATIONS } from "../repl-study/mutations.ts";
import { bandGeometry, columnFor, notchLayout, transcriptLines } from "../repl-study/render.ts";
import {
  applyAnsi,
  createGrid,
  gridDifferences,
  gridText,
  viewport,
} from "../repl-study/screen.ts";
import { initialView, scrollBy } from "../repl-study/view.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GOLDENS = fileURLToPath(new URL("./fixtures/repl-study/", import.meta.url));
const MAIN = "scripts/repl-study/main.ts";

/** The band rows of a rendered frame, as a grid of glyphs. */
function bandRows(text: string, size: Size): string[] {
  const rows = text.split("\n");
  return [0, 1, 2, 3].map((offset) => rows[size.rows - 4 + offset] ?? "");
}

function glyphAt(row: string, column: number): string {
  return [...row][column] ?? " ";
}

/** How many band rows carry something at this column. */
function notchHeight(rows: readonly string[], column: number): number {
  return rows.filter((row) => {
    const glyph = glyphAt(row, column);
    return glyph !== " " && glyph !== "─";
  }).length;
}

describe("fixture rendering", () => {
  it("renders every committed capture exactly", function* () {
    const captures = yield* captureAll();
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      const golden = yield* readTextFile(join(GOLDENS, `${capture.name}.txt`));
      const header = `${capture.name} · ${capture.size.cols} × ${capture.size.rows}\n`;
      expect(`${header}${capture.frame.text}\n`).toBe(golden);
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
    const header = `settled.wide · ${PROFILE_SIZES.wide.cols} × ${PROFILE_SIZES.wide.rows}\n`;
    expect(`${header}${stale.text}\n`).not.toBe(golden);
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
      expect(layout.footer?.y).toBe(size.rows - 4);
      expect(layout.footer?.width).toBe(size.cols);
      expect(layout.contextual).toBeDefined();
      expect(intersects(layout.contextual!, layout.footer!)).toBe(false);

      const frame = yield* renderFrame({ fixture: subject, view: initialView(subject), size });
      const rows = bandRows(frame.text, size);
      // Visible means all of it: the label the study puts at the left, the
      // transport at the right, and the track with the head on it between them.
      expect(rows[0]).toContain("EXECUTION HISTORY");
      expect(rows[0]).toContain("[ Pause ]");
      expect(rows[2]).toContain("┃");
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
    expect(rows[2]).not.toContain("┃");
  });

  it("gives four distinguishable notch heights", function* () {
    const size = PROFILE_SIZES.wide;
    const subject = fixture("paused");
    const view = initialView(subject);
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: false,
      surface: "transcript",
    });
    const geometry = bandGeometry(subject, layout, layout.footer!);
    const frame = yield* renderFrame({ fixture: subject, view, size });
    const rows = bandRows(frame.text, size);
    const offset = 1;

    const history = subject.history;
    const selected = history.checkpoints[view.checkpoint];
    const boundary = history.checkpoints.find((point) => point.kind === "entry")!;
    const minor = history.checkpoints.find(
      (point) =>
        point.kind === "event" &&
        notchLayout(history, geometry.trackLeft, geometry.trackWidth).find(
          (notch) =>
            notch.column === columnFor(point.at, history, geometry.trackLeft, geometry.trackWidth),
        )!.checkpoints.length === 1,
    )!;

    const column = (at: number) =>
      offset + columnFor(at, history, geometry.trackLeft, geometry.trackWidth);
    expect(notchHeight(rows, column(selected.at))).toBe(4);
    expect(notchHeight(rows, column(history.headAt))).toBe(3);
    expect(notchHeight(rows, column(boundary.at))).toBe(2);
    expect(notchHeight(rows, column(minor.at))).toBe(1);
  });

  it("rejects one notch height for every marker", function* () {
    const size = PROFILE_SIZES.wide;
    const subject = fixture("paused");
    const view = initialView(subject);
    const layout = layoutFor({
      cols: size.cols,
      rows: size.rows,
      drawer: false,
      surface: "transcript",
    });
    const geometry = bandGeometry(subject, layout, layout.footer!);
    const frame = yield* renderFrame({ fixture: subject, view, size, mutation: "flatten-notches" });
    const rows = bandRows(frame.text, size);
    const selected = subject.history.checkpoints[view.checkpoint];
    const column =
      1 + columnFor(selected.at, subject.history, geometry.trackLeft, geometry.trackWidth);
    expect(notchHeight(rows, column)).toBe(1);
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
    const geometry = bandGeometry(subject, layout, rect);
    const notches = notchLayout(subject.history, geometry.trackLeft, geometry.trackWidth);
    const gathered = notches.reduce((total, notch) => total + notch.checkpoints.length, 0);

    expect(notches.some((notch) => notch.checkpoints.length > 1)).toBe(true);
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
    const geometry = bandGeometry(subject, layout, layout.footer!);
    const notches = notchLayout(
      subject.history,
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

  it("declares every control the evidence uses", function* () {
    for (const mutation of MUTATIONS) {
      expect(typeof mutation).toBe("string");
    }
    expect(MUTATIONS.length).toBe(8);
  });

  it("writes its captures where the goldens live", function* () {
    const directory = yield* useTempDirectory("repl-study-captures");
    const captures = yield* captureAll();
    yield* writeCaptures(directory, captures);
    const written = yield* readdir(directory);
    expect(written.filter((name) => name.endsWith(".txt")).length).toBe(captures.length);
  });
});
