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
