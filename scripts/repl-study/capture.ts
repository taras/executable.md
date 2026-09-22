/**
 * One frame, rendered away from a terminal, in bytes and in cells.
 *
 * `@bomb.sh/tty` does no I/O, so the same frame the interactive harness writes
 * to a real terminal can be produced here and read back as text. That is what
 * makes the captures reviewable: the `.txt` files are the interface as a person
 * would see it, and they are also what the evidence compares against.
 */

import { createTerm } from "@bomb.sh/tty";
import type { Term } from "@bomb.sh/tty";
import { until } from "effection";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";

import { fixture, fixtures } from "./fixtures.ts";
import type { Fixture } from "./model.ts";
import type { Profile, SurfaceName } from "./layout.ts";
import { layoutFor } from "./layout.ts";
import { renderScreen } from "./render.ts";
import { applyAnsi, createGrid, gridText } from "./screen.ts";
import { initialView } from "./view.ts";
import type { View } from "./view.ts";
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
}

export interface FrameRequest {
  readonly fixture: Fixture;
  readonly view: View;
  readonly size: Size;
  readonly mutation?: Mutation;
  readonly surface?: SurfaceName;
}

export function* useTerm(size: Size): Operation<Term> {
  return yield* until(createTerm({ width: size.cols, height: size.rows }));
}

/** Render one frame into a fresh terminal, which is always a complete repaint. */
export function* renderFrame(request: FrameRequest): Operation<Frame> {
  const term = yield* useTerm(request.size);
  return renderInto(term, request);
}

export function renderInto(term: Term, request: FrameRequest): Frame {
  const { view, size, mutation } = request;
  // A frame drawn from state the harness has already left behind. The renderer
  // cannot tell the difference — only a reader, or a golden, can.
  const subject = mutation === "stale-frame" ? fixture("empty") : request.fixture;
  const layout = layoutFor({
    cols: size.cols,
    rows: size.rows,
    drawer: subject.drawer !== undefined && view.drawerOpen,
    surface: request.surface ?? view.surface,
    mutation,
  });
  const result = term.render(renderScreen({ fixture: subject, view, layout, mutation }));
  if (result.errors.length > 0) {
    throw new Error(`the renderer reported ${JSON.stringify(result.errors)}`);
  }
  const ansi = Uint8Array.from(result.output);
  const grid = applyAnsi(createGrid(size.cols, size.rows), ansi);
  return { ansi, text: gridText(grid) };
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
  return captures;
}

export function* writeCaptures(directory: string, captures: readonly Capture[]): Operation<void> {
  yield* ensureDir(directory);
  for (const capture of captures) {
    const header = `${capture.name} · ${capture.size.cols} × ${capture.size.rows}\n`;
    yield* writeTextFile(
      join(directory, `${capture.name}.txt`),
      `${header}${capture.frame.text}\n`,
    );
    yield* writeTextFile(
      join(directory, `${capture.name}.ansi`),
      new TextDecoder().decode(capture.frame.ansi),
    );
  }
}
