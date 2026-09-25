/**
 * One frame, rendered away from a terminal, in bytes and in cells.
 *
 * `@bomb.sh/tty` does no I/O, so the same frame the interactive harness writes
 * to a real terminal can be produced here and read back as text. That is what
 * makes the captures reviewable: the `.txt` files are the interface as a person
 * would see it, and they are also what the evidence compares against.
 */

import { createTerm } from "@bomb.sh/tty";
import type { BoundingBox, Term } from "@bomb.sh/tty";
import { until } from "effection";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";

import { fixture, fixtures } from "./fixtures.ts";
import { JOURNEY, journeyPlan, motionAt, PLAYBACKS } from "./playback.ts";
import type { Motion, Playback } from "./playback.ts";
import type { Fixture } from "./model.ts";
import type { Profile, SurfaceName } from "./layout.ts";
import { layoutFor } from "./layout.ts";
import { renderScreen } from "./render.ts";
import type { FocusView } from "./render.ts";
import { applyAnsi, createGrid, gridText } from "./screen.ts";
import { initialView } from "./store.ts";
import type { View } from "./store.ts";
import { fixtureFor, viewOf } from "./store.ts";
import { FRAMES, useFrame } from "./frames.ts";
import { overlayOf } from "./tree.ts";
import type { Mutation } from "./mutations.ts";

export interface Size {
  readonly cols: number;
  readonly rows: number;
}

/**
 * The dimensions each profile is captured at.
 *
 * These are representative terminals, not thresholds: `layout.ts` owns where one
 * profile ends and the next begins, and these sit inside each range.
 */
export const PROFILE_SIZES: Record<Profile, Size> = {
  wide: { cols: 200, rows: 50 },
  medium: { cols: 140, rows: 38 },
  narrow: { cols: 90, rows: 28 },
  "too-small": { cols: 64, rows: 18 },
};

export interface Frame {
  readonly ansi: Uint8Array;
  readonly text: string;
  /** True while the renderer is still interpolating a declared transition. */
  readonly animating: boolean;
  /** Where each region landed, in cells, as the renderer reports it. */
  readonly bounds: Readonly<Record<string, BoundingBox | undefined>>;
}

/** The regions whose geometry the evidence asks about. */
const MEASURED = [
  "root",
  "header",
  "sidebar",
  "transcript",
  "bindings",
  "contextual",
  "footer",
  "surface-bar",
  "too-small",
];

export interface FrameRequest {
  readonly fixture: Fixture;
  readonly view: View;
  readonly size: Size;
  readonly mutation?: Mutation;
  readonly surface?: SurfaceName;
  /** Present only while a playback is running between two fixtures. */
  readonly motion?: Motion;
  /** Where focus is. Left out, the frame says nothing about focus at all. */
  readonly focus?: FocusView;
  /**
   * Seconds since the previous frame, which is the unit the renderer measures
   * transitions in. Leaving it out hands the renderer its own monotonic clock;
   * supplying it — including `0` — overrides that, which is what makes a
   * captured transition reproducible.
   */
  readonly deltaSeconds?: number;
}

export function* useTerm(size: Size): Operation<Term> {
  return yield* until(createTerm({ width: size.cols, height: size.rows }));
}

/** Render one frame into a fresh terminal, which is always a complete repaint. */
export function* renderFrame(request: FrameRequest): Operation<Frame> {
  const term = yield* useTerm(request.size);
  return renderInto(term, request);
}

/**
 * The renderer ran out of room to measure text.
 *
 * Clay keeps a cache of measured words — 16 384 of them — and a long-lived Term
 * rendering an interface this wordy exhausts it. It is not a failure of the
 * frame: the answer is a new Term, which starts the cache again.
 */
export class RendererCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendererCapacityError";
  }
}

export function renderInto(term: Term, request: FrameRequest): Frame {
  const { view, size, mutation } = request;
  // A frame drawn from state the harness has already left behind. The renderer
  // cannot tell the difference — only a reader, or a golden, can.
  const subject = mutation === "stale-frame" ? fixture("empty") : request.fixture;
  const motion =
    mutation === "restore-mid-animation" && request.motion === undefined
      ? // Reconstruction must land on a state, never halfway through a transition.
        // This control makes it land halfway.
        { progress: 0.5, headAt: subject.history.headAt / 2, reveal: 0.5, done: false }
      : request.motion;
  // A playback's first frame still shows the moment it is leaving, so a drawer
  // about to open is not open yet: that is what gives the renderer two
  // geometries to interpolate between rather than one it has already arrived at.
  const opening = motion === undefined || motion.progress > 0;
  const layout = layoutFor({
    cols: size.cols,
    rows: size.rows,
    drawer: subject.drawer !== undefined && view.drawerOpen && opening,
    surface: request.surface ?? view.surface,
    mutation,
  });
  const result = term.render(
    renderScreen({ fixture: subject, view, layout, mutation, motion, focus: request.focus }),
    request.deltaSeconds === undefined ? {} : { deltaTime: request.deltaSeconds },
  );
  if (result.errors.length > 0) {
    const capacity = result.errors.find(
      (error) => error.type === "TEXT_MEASUREMENT_CAPACITY_EXCEEDED",
    );
    if (capacity !== undefined) {
      throw new RendererCapacityError(capacity.message);
    }
    throw new Error(`the renderer reported ${JSON.stringify(result.errors)}`);
  }
  const ansi = Uint8Array.from(result.output);
  const grid = applyAnsi(createGrid(size.cols, size.rows), ansi);
  const bounds: Record<string, BoundingBox | undefined> = {};
  for (const id of MEASURED) {
    bounds[id] = result.info.get(id)?.bounds;
  }
  return { ansi, text: gridText(grid), animating: result.animating, bounds };
}

/**
 * One playback, rendered frame by frame with an explicit delta.
 *
 * Nothing here waits: time is supplied rather than measured, so the same
 * sequence comes out of a test, a capture and a review identically. The run
 * ends when the application's motion has finished *and* the renderer has
 * stopped interpolating, which is the same condition the frame loop uses to
 * stop scheduling.
 */
export function* playFrames(
  playback: Playback,
  size: Size,
  options: { readonly frameMs?: number; readonly limit?: number } = {},
): Operation<Frame[]> {
  const frameMs = options.frameMs ?? 16;
  const limit = options.limit ?? 200;
  const subject = fixture(playback.to);
  const view = initialView(subject);
  const term = yield* useTerm(size);
  const frames: Frame[] = [];
  // A frame in the middle of a transition is a handful of changed cells, not a
  // screen. The screen is what those changes have added up to, so the grid
  // carries across frames exactly as a terminal's does.
  const screen = createGrid(size.cols, size.rows);
  let elapsed = 0;
  for (let index = 0; index < limit; index += 1) {
    const motion = motionAt(playback, elapsed);
    const frame = renderInto(term, {
      fixture: subject,
      view,
      size,
      motion,
      deltaSeconds: index === 0 ? 0 : frameMs / 1000,
    });
    applyAnsi(screen, frame.ansi);
    frames.push({ ...frame, text: gridText(screen) });
    if (motion.done && !frame.animating) {
      return frames;
    }
    elapsed += frameMs;
  }
  return frames;
}

/**
 * Every frame of the whole demonstration, rendered deterministically.
 *
 * The screen carries across frames the way a terminal's does, so what comes
 * back is what a person would have seen at each moment rather than the handful
 * of cells that changed.
 */
export interface JourneyFrame extends Frame {
  readonly label: string;
  readonly fixture: string;
}

export interface JourneyRun {
  readonly frames: JourneyFrame[];
  /** How many times the renderer had to be rebuilt to get to the end. */
  readonly rebuilds: number;
}

export function* journeyFrames(
  size: Size,
  options: { readonly frameMs?: number } = {},
): Operation<JourneyRun> {
  const frameMs = options.frameMs ?? 16;
  let term = yield* useTerm(size);
  let rebuilds = 0;
  const screen = createGrid(size.cols, size.rows);
  const frames: JourneyFrame[] = [];
  for (const planned of journeyPlan(JOURNEY, frameMs)) {
    const subject = fixture(planned.fixture);
    const request: FrameRequest = {
      fixture: subject,
      view: initialView(subject),
      size,
      motion: planned.motion,
      deltaSeconds: planned.deltaMs / 1000,
    };
    let frame: Frame;
    try {
      frame = renderInto(term, request);
    } catch (error) {
      if (!(error instanceof RendererCapacityError)) {
        throw error;
      }
      // A fresh Term starts with an empty measurement cache and repaints
      // everything, so the screen this frame lands on is complete.
      term = yield* useTerm(size);
      rebuilds += 1;
      frame = renderInto(term, { ...request, deltaSeconds: 0 });
    }
    applyAnsi(screen, frame.ansi);
    frames.push({
      ...frame,
      text: gridText(screen),
      label: planned.label,
      fixture: planned.fixture,
    });
  }
  return { frames, rebuilds };
}

export function captureName(fixtureName: string, profile: Profile): string {
  return `${fixtureName}.${profile}`;
}

export interface Capture {
  readonly name: string;
  readonly profile: Profile;
  readonly size: Size;
  readonly frame: Frame;
}

/**
 * Every fixture at every profile.
 *
 * `too-small` is captured for two fixtures only: the refusal does not vary with
 * what is behind it, and capturing six identical screens would say six times
 * less than capturing two and saying so.
 */
export function* captureAll(): Operation<Capture[]> {
  const captures: Capture[] = [];
  const profiles: Profile[] = ["wide", "medium", "narrow"];
  for (const subject of fixtures()) {
    for (const profile of profiles) {
      const size = PROFILE_SIZES[profile];
      const frame = yield* renderFrame({ fixture: subject, view: initialView(subject), size });
      captures.push({ name: captureName(subject.name, profile), profile, size, frame });
    }
  }
  for (const name of ["drawer", "paused"]) {
    const subject = fixture(name);
    const size = PROFILE_SIZES["too-small"];
    const frame = yield* renderFrame({ fixture: subject, view: initialView(subject), size });
    captures.push({ name: captureName(name, "too-small"), profile: "too-small", size, frame });
  }

  // The promoted surfaces only exist in narrow, so the wide captures never show
  // them. These are the routed views themselves.
  const routed: readonly { readonly fixture: string; readonly surface: SurfaceName }[] = [
    { fixture: "paused", surface: "history" },
    { fixture: "drawer", surface: "sessions" },
    { fixture: "nested", surface: "bindings" },
  ];
  for (const route of routed) {
    const subject = fixture(route.fixture);
    const size = PROFILE_SIZES.narrow;
    const frame = yield* renderFrame({
      fixture: subject,
      view: { ...initialView(subject), surface: route.surface, drawerOpen: false },
      size,
      surface: route.surface,
    });
    captures.push({
      name: `${route.fixture}.narrow.${route.surface}`,
      profile: "narrow",
      size,
      frame,
    });
  }
  // Three moments of one playback, so a reader can see a transition without
  // running it: where it starts, where it is halfway, and where it settles.
  const playback = PLAYBACKS.find((one) => one.from === "generated" && one.to === "drawer")!;
  const frames = yield* playFrames(playback, PROFILE_SIZES.wide);
  const moments: readonly { readonly label: string; readonly at: number }[] = [
    { label: "start", at: 0 },
    { label: "midpoint", at: Math.floor((frames.length - 1) / 2) },
    { label: "settled", at: frames.length - 1 },
  ];
  for (const moment of moments) {
    captures.push({
      name: `play.${playback.from}-${playback.to}.${moment.label}`,
      profile: "wide",
      size: PROFILE_SIZES.wide,
      frame: frames[moment.at],
    });
  }

  return captures;
}

/**
 * One capture as a file: what it is, how big the terminal was, and the screen.
 *
 * Trailing blank rows are dropped, because the header already says how tall the
 * terminal was and a file that ends in empty lines is a file git complains
 * about. Both the writer and the evidence read the screen through here, so a
 * golden cannot disagree with what `--capture` writes.
 */
export function captureText(capture: Capture): string {
  const header = `${capture.name} · ${capture.size.cols} × ${capture.size.rows}`;
  return `${header}\n${capture.frame.text.replace(/\n+$/, "")}\n`;
}

export function* writeCaptures(directory: string, captures: readonly Capture[]): Operation<void> {
  yield* ensureDir(directory);
  for (const capture of captures) {
    yield* writeTextFile(join(directory, `${capture.name}.txt`), captureText(capture));
    yield* writeTextFile(
      join(directory, `${capture.name}.ansi`),
      new TextDecoder().decode(capture.frame.ansi),
    );
  }
}

/**
 * The study's frames, at the profiles a reader can check them at.
 *
 * Every frame is drawn with the numbered overlay on, because the study states
 * its frames as numbered targets: numbering them on screen is what makes a
 * capture legible as evidence against the frame it reproduces. The narrow set
 * is representative rather than exhaustive — the suite checks all fourteen at
 * both profiles, and a golden's job here is to be read.
 */
const NARROW_FRAMES = ["01", "05", "07", "12", "14"];

export function* captureFocus(): Operation<Capture[]> {
  const captures: Capture[] = [];
  for (const subject of FRAMES) {
    const { state, tree } = yield* useFrame(subject);
    const profiles: Profile[] = NARROW_FRAMES.includes(subject.id) ? ["wide", "narrow"] : ["wide"];
    for (const profile of profiles) {
      const size = PROFILE_SIZES[profile];
      const frame = yield* renderFrame({
        fixture: fixtureFor(state),
        view: viewOf(state),
        size,
        focus: { here: tree.focused().name, map: overlayOf(tree), overlay: true },
      });
      captures.push({ name: `frame-${subject.id}.${profile}`, profile, size, frame });
    }
  }
  return captures;
}
