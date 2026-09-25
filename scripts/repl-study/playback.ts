/**
 * Moving between two moments, rather than cutting between them.
 *
 * The six fixtures stay what they are: stable, reconstructable states that the
 * captures and the journal both describe. A playback is the path between two of
 * them, and it exists only while it is running — its phase and its elapsed time
 * live in the frame loop's own local state, never in a fixture and never in
 * anything a journal would restore. Reconstruction lands on a fixture; it never
 * lands halfway through a transition.
 *
 * Two kinds of motion run here. The renderer owns one — a drawer that grows out
 * of the contextual band, interpolated by `@bomb.sh/tty` from a declared
 * transition — and the application owns the other: the recorded head travelling
 * along the track, and the target's transcript arriving a few rows at a time.
 */

import { fixture } from "./fixtures.ts";
import type { FixtureName } from "./model.ts";

export interface Playback {
  readonly from: FixtureName;
  readonly to: FixtureName;
  readonly durationMs: number;
}

/** The path the harness plays, in the order the study tells its story. */
export const PLAYBACKS: readonly Playback[] = [
  { from: "empty", to: "nested", durationMs: 640 },
  { from: "nested", to: "generated", durationMs: 640 },
  { from: "generated", to: "drawer", durationMs: 640 },
  { from: "drawer", to: "paused", durationMs: 640 },
  { from: "paused", to: "settled", durationMs: 640 },
];

/**
 * One stretch of the demonstration: a moment held, or a transition played.
 *
 * A hold is not dead time. The study's moments are dense — a nested transcript,
 * a form, a band with fourteen checkpoints on it — and a demonstration that cut
 * between them as fast as it could render would show everything and let a
 * person read nothing.
 */
export type Segment =
  | { readonly kind: "hold"; readonly fixture: FixtureName; readonly durationMs: number }
  | { readonly kind: "play"; readonly playback: Playback };

/**
 * The whole approved story, start to finish, with nobody at the keyboard.
 *
 * Holds are proportional to how much there is to take in: the empty REPL is one
 * sentence, the nested transcript and the paused band are the densest screens in
 * the study. The last hold ends the journey, and what remains on screen is the
 * settled entry.
 */
export const JOURNEY: readonly Segment[] = [
  { kind: "hold", fixture: "empty", durationMs: 1200 },
  { kind: "play", playback: PLAYBACKS[0] },
  { kind: "hold", fixture: "nested", durationMs: 2600 },
  { kind: "play", playback: PLAYBACKS[1] },
  { kind: "hold", fixture: "generated", durationMs: 2400 },
  { kind: "play", playback: PLAYBACKS[2] },
  { kind: "hold", fixture: "drawer", durationMs: 2400 },
  { kind: "play", playback: PLAYBACKS[3] },
  { kind: "hold", fixture: "paused", durationMs: 2600 },
  { kind: "play", playback: PLAYBACKS[4] },
  { kind: "hold", fixture: "settled", durationMs: 1600 },
];

export function segmentDurationMs(segment: Segment): number {
  return segment.kind === "hold" ? segment.durationMs : segment.playback.durationMs;
}

/** The moment a segment is showing, which is a fixture either way. */
export function segmentFixture(segment: Segment): FixtureName {
  return segment.kind === "hold" ? segment.fixture : segment.playback.to;
}

/** What a trace calls this segment, so a run can be read back as a journey. */
export function segmentLabel(segment: Segment): string {
  return segment.kind === "hold"
    ? `hold:${segment.fixture}`
    : `play:${segment.playback.from}→${segment.playback.to}`;
}

/** How long the whole demonstration takes, holds included. */
export function journeyDurationMs(journey: readonly Segment[] = JOURNEY): number {
  return journey.reduce((total, segment) => total + segmentDurationMs(segment), 0);
}

export function playbackFrom(from: FixtureName): Playback | undefined {
  return PLAYBACKS.find((playback) => playback.from === from);
}

export function playbackBetween(from: FixtureName, to: FixtureName): Playback | undefined {
  return PLAYBACKS.find((playback) => playback.from === from && playback.to === to);
}

export interface Motion {
  /** Eased 0…1. */
  readonly progress: number;
  /** Where the recorded head sits while it travels between the two moments. */
  readonly headAt: number;
  /** How much of the target's transcript has arrived, as a share of its rows. */
  readonly reveal: number;
  readonly done: boolean;
}

function easeInOutCubic(fraction: number): number {
  return fraction < 0.5
    ? 4 * fraction * fraction * fraction
    : 1 - Math.pow(-2 * fraction + 2, 3) / 2;
}

/**
 * The motion of one playback at one moment.
 *
 * Pure, and a function of elapsed time alone, so the same instant can be
 * rendered from a capture, from a test, or from the frame loop and come out
 * identical.
 */
export function motionAt(playback: Playback, elapsedMs: number): Motion {
  const fraction =
    playback.durationMs <= 0 ? 1 : Math.max(0, Math.min(1, elapsedMs / playback.durationMs));
  const progress = easeInOutCubic(fraction);
  const from = fixture(playback.from).history.headAt;
  const to = fixture(playback.to).history.headAt;
  return {
    progress,
    headAt: from + (to - from) * progress,
    reveal: progress,
    done: fraction >= 1,
  };
}

/** The moment a playback settles on, which is the state anything restores to. */
export function settledFixture(playback: Playback): FixtureName {
  return playback.to;
}

/** One frame of a journey, described before anything is rendered. */
export interface PlannedFrame {
  readonly label: string;
  readonly fixture: FixtureName;
  readonly motion?: Motion;
  readonly deltaMs: number;
  readonly elapsedMs: number;
}

/**
 * The whole demonstration as a list of frames, at a fixed step.
 *
 * The live loop is driven by a real clock and draws a held moment once; this
 * walks the same journey with time supplied instead of measured, so a test or a
 * capture sees exactly the frames a viewer would, in the same order, without
 * waiting sixteen seconds for them.
 */
export function journeyPlan(journey: readonly Segment[] = JOURNEY, frameMs = 16): PlannedFrame[] {
  const planned: PlannedFrame[] = [];
  let elapsed = 0;
  for (const segment of journey) {
    const duration = segmentDurationMs(segment);
    if (segment.kind === "hold") {
      planned.push({
        label: segmentLabel(segment),
        fixture: segment.fixture,
        deltaMs: planned.length === 0 ? 0 : frameMs,
        elapsedMs: elapsed,
      });
      elapsed += duration;
      continue;
    }
    for (let within = 0; within <= duration; within += frameMs) {
      planned.push({
        label: segmentLabel(segment),
        fixture: segment.playback.to,
        motion: motionAt(segment.playback, within),
        deltaMs: planned.length === 0 ? 0 : frameMs,
        elapsedMs: elapsed + within,
      });
    }
    elapsed += duration;
  }
  return planned;
}
