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
import { JOURNEY, journeyPlan, PLAYBACKS, transitionOf } from "./playback.ts";
import { useFrames } from "./animation.ts";
import type { Playback, Transition } from "./playback.ts";
import type { Fixture } from "./model.ts";
import type { Profile, SurfaceName } from "./layout.ts";
import { layoutFor } from "./layout.ts";
import { paint } from "./paint.ts";
import { projectFixture } from "./view.ts";
import type { ReplView } from "./view.ts";
import { useReplTree } from "./tree.ts";
import type { ReplTree } from "./tree.ts";
import { enterRoute } from "./drive.ts";
import { hydrate } from "./store.ts";
import { journalThrough, markerShowing } from "./journal.ts";
import { formatRoute } from "./route.ts";
import type { Node } from "./vendor/freedom/upstream/index.ts";
import { applyAnsi, createGrid, gridText } from "./screen.ts";
import { initialView } from "./store.ts";
import type { View } from "./store.ts";
import { fixtureFor, viewOf } from "./store.ts";
import { FRAMES, useFrame } from "./frames.ts";
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

/**
 * One mounted composition: the tree a frame is rendered by, and its view.
 *
 * A frame is drawn by walking a mounted tree, so a caller that wants frames
 * mounts one first. `playFrames` and the journey mount one and reuse it, which
 * is also what makes a transition a change to a tree rather than a new one.
 */
export interface Composition {
  /** The one mounted tree this frame is rendered by. */
  readonly tree: ReplTree;
  readonly root: Node;
  readonly view: ReplView;
}

/**
 * Compose a moment **into an already mounted tree**.
 *
 * Projection only, and synchronous. It reads the fixture and returns the view;
 * it mounts nothing, syncs nothing and focuses nothing.
 *
 * That is the whole correction. Composing used to hydrate a synthetic state
 * from a fabricated URL, sync the tree to it and enter its route — on every
 * repaint. A person who tabbed to the bindings pane had focus dragged back to
 * the transcript by the next frame, because a repaint was quietly re-deciding
 * where they were. Topology belongs to the store's own sync and focus belongs
 * to the person; drawing is allowed to read both and change neither.
 */
/**
 * A second mounted tree, for the control that renders from one.
 *
 * Mounted lazily and kept, so the control is a *different* tree rather than a
 * fresh one each call — which is what a parallel rendering hierarchy would
 * actually be.
 */
let foreign: Composition | undefined;

export function useForeignTree(subject: Fixture, view: View): Operation<Composition> {
  return {
    *[Symbol.iterator]() {
      foreign = yield* useComposition(subject, view, PROFILE_SIZES.wide);
      return foreign;
    },
  };
}

export function composeInto(
  tree: ReplTree,
  subject: Fixture,
  view: View,
  surface: SurfaceName = view.surface,
  mutation?: Mutation,
): Composition {
  if (mutation === "second-tree") {
    // The control: render from a tree of its own. Each tree is internally
    // consistent, which is exactly why nothing notices without an oracle that
    // asks whether the ids rendered belong to the tree focus came from.
    if (foreign === undefined) {
      throw new Error("the second-tree control needs its foreign tree mounted first");
    }
    return foreign;
  }
  return {
    tree,
    root: tree.root.node,
    view: projectFixture(subject, {
      execution: "e1",
      surface,
      scopes: [],
      drawerOpen: subject.drawer !== undefined && view.drawerOpen,
      // A reconstruction makes what is drawn a recording. Hardcoding this false
      // drew a recorded drawer as though it were live and actionable, which is
      // exactly what the tree refuses to make it.
      inspect: view.inspect,
      draft: "",
      transport: subject.history.transport,
      running: subject.entry?.state === "running",
      selectedAt: subject.history.checkpoints[view.checkpoint]?.at,
      notice: view.notice,
    }),
  };
}

export interface FrameRequest {
  readonly fixture: Fixture;
  readonly view: View;
  /** The mounted composition this frame is drawn by. */
  readonly composition: Composition;
  readonly size: Size;
  readonly mutation?: Mutation;
  readonly surface?: SurfaceName;
  /** Present only while a playback is running between two fixtures. */
  /** Present only while a moment is being played into rather than cut to. */
  readonly transition?: Transition;
  /**
   * Ordinary UI state: whether the numbered overlay is drawn.
   *
   * Nothing here says where focus is. There is no longer anywhere to say it:
   * the tree owns focus, and a frame is drawn by walking the tree.
   */
  readonly overlay?: boolean;
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
export function* renderFrame(request: Omit<FrameRequest, "composition">): Operation<Frame> {
  const term = yield* useTerm(request.size);
  const composition = yield* useComposition(
    request.fixture,
    request.view,
    request.size,
    request.surface ?? request.view.surface,
  );
  return renderInto(term, { ...request, composition });
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
  const subject = request.fixture;
  // A playback's first frame still shows the moment it is leaving, so a drawer
  // about to open is not open yet: that is what gives the renderer two
  // geometries to interpolate between rather than one it has already arrived at.
  const opening = request.transition === undefined || request.transition.begun;
  const layout = layoutFor({
    cols: size.cols,
    rows: size.rows,
    drawer: subject.drawer !== undefined && view.drawerOpen && opening,
    surface: request.surface ?? view.surface,
    mutation,
  });
  // A frame drawn from state the harness has already left behind. The renderer
  // cannot tell the difference — only a reader, or a golden, can.
  const shown =
    mutation === "stale-frame"
      ? projectFixture(fixture("empty"), {
          execution: "e1",
          surface: "transcript",
          scopes: [],
          drawerOpen: false,
          inspect: false,
          draft: "",
          transport: "idle",
          running: false,
        })
      : request.composition.view;
  const painted = paint({
    tree: request.composition.tree,
    view: shown,
    layout,
    anchor: view.anchor,
    options: { overlay: request.overlay, mutation, transition: request.transition },
  });
  const result = term.render(
    painted.ops,
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
    const rendered = painted.ids[id];
    bounds[id] = rendered === undefined ? undefined : result.info.get(rendered)?.bounds;
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
  // The clock this playback supplies time to. Components subscribed to it when
  // the tree below was mounted, so advancing it is the whole of how they move.
  const clock = yield* useFrames();
  const composition = yield* useComposition(subject, view, size);
  const term = yield* useTerm(size);
  const frames: Frame[] = [];
  // A frame in the middle of a transition is a handful of changed cells, not a
  // screen. The screen is what those changes have added up to, so the grid
  // carries across frames exactly as a terminal's does.
  const screen = createGrid(size.cols, size.rows);
  for (let index = 0; index < limit; index += 1) {
    const transition = transitionOf(playback, index > 0);
    const deltaSeconds = index === 0 ? 0 : frameMs / 1000;
    // The clock, then the picture: every component has taken this frame before
    // anything is drawn from it.
    yield* clock.advance((index * frameMs) / 1000);
    const frame = renderInto(term, {
      fixture: subject,
      view,
      composition,
      size,
      transition,
      deltaSeconds,
    });
    applyAnsi(screen, frame.ansi);
    frames.push({ ...frame, text: gridText(screen) });
    if (!clock.wanted() && !frame.animating) {
      return frames;
    }
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
  const compositions = new Map<string, Composition>();
  let rebuilds = 0;
  const screen = createGrid(size.cols, size.rows);
  const frames: JourneyFrame[] = [];
  const clock = yield* useFrames();
  for (const planned of journeyPlan(JOURNEY, frameMs)) {
    const subject = fixture(planned.fixture);
    const view = initialView(subject);
    // One composition per moment, reused across that moment's frames: a
    // transition is a change to a mounted tree, never a new one.
    let composition = compositions.get(planned.fixture);
    if (composition === undefined) {
      composition = yield* useComposition(subject, view, size);
      compositions.set(planned.fixture, composition);
    }
    // Mounted, then told the time, then drawn. A component that was handed its
    // first frame before it existed would start its transition from a moment it
    // never saw.
    yield* clock.advance(planned.elapsedMs / 1000);
    const request: FrameRequest = {
      fixture: subject,
      view,
      composition,
      size,
      transition: planned.transition,
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
    const profiles: Profile[] = NARROW_FRAMES.includes(subject.id) ? ["wide", "narrow"] : ["wide"];
    for (const profile of profiles) {
      const size = PROFILE_SIZES[profile];
      // One tree per composition. Topology follows the profile — a narrow
      // drawer owns the screen and offers no way out to a band that is not on
      // it — so a single tree cannot stand in for both.
      const { state, tree } = yield* useFrame(subject, size);
      const term = yield* useTerm(size);
      // The frame's own tree draws the frame. It used to be told where focus
      // was and then rendered by a second tree mounted for the occasion, which
      // is how a capture could show focus on a node the rendering tree had
      // never heard of. One tree answers both.
      const frame = renderInto(term, {
        fixture: fixtureFor(state),
        view: viewOf(state),
        size,
        overlay: true,
        composition: composeInto(tree, fixtureFor(state), viewOf(state)),
      });
      captures.push({ name: `frame-${subject.id}.${profile}`, profile, size, frame });
    }
  }
  return captures;
}

/**
 * A moment, with a tree of its own.
 *
 * For a caller that owns the whole composition — a capture, a playback — where
 * mounting one tree is exactly right. A caller that already has a tree uses
 * `composeInto` so that one tree keeps answering everything.
 */
export function useComposition(
  subject: Fixture,
  view: View,
  composed: Size,
  surface: SurfaceName = view.surface,
): Operation<Composition> {
  return {
    *[Symbol.iterator]() {
      const state = hydrate(
        formatRoute({
          execution: "e1",
          surface,
          scopes: [],
          drawers:
            subject.drawer !== undefined && view.drawerOpen && subject.drawer !== undefined
              ? [subject.drawer.kind]
              : [],
          inspect: false,
          draft: "",
        }),
        journalThrough(markerShowing(subject.name)),
      );
      const tree = yield* useReplTree(state, composed);
      // A caller that owns the whole composition brings its tree to the moment
      // once, at mount. A repaint never does this.
      yield* tree.sync(state);
      yield* enterRoute(tree, state);
      return composeInto(tree, subject, view, surface);
    },
  };
}
