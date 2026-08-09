/**
 * Fixture for `local/prefer-effection-operation` — a domain type is a value
 * however it is named.
 *
 * `SoundEffect` is a sound. It comes from nowhere near Effection and declares
 * none of an effect's contract, so a generator yielding one is iteration and
 * every spelling of it passes.
 *
 * `Doorway`, `Portal` and `Threshold` go further: each signs both of the
 * contract's member names. None signs both of its shapes — `Portal` describes
 * itself with a number, `Threshold` enters and returns nothing — so none is
 * assignable to `Effect<T>`, and each one fails on a different half of the
 * check.
 */

interface SoundEffect {
  name: string;
}

interface VisualEffect {
  frames: number;
}

interface Doorway {
  description: number;
  enter: boolean;
}

/** Enters exactly as an effect does, and describes itself as nothing like one. */
interface Portal {
  description: number;
  enter(
    resolve: (result: unknown) => void,
    routine: { scope: unknown },
  ): (resolve: (result: void) => void) => void;
}

type Threshold = {
  description: string;
  enter(guest: string): void;
};

export function* sounds(): Generator<SoundEffect, void, unknown> {
  yield { name: "bell" };
}

export type SoundSource = () => Generator<SoundEffect, void, unknown>;

export type QualifiedSoundSource = () => globalThis.Generator<SoundEffect, void, unknown>;

export type Overlaid = () => AsyncGenerator<SoundEffect | VisualEffect, void, unknown>;

export type DoorwaySource = () => Generator<Doorway, void, unknown>;

export type ThresholdSource = () => Generator<Threshold, void, unknown>;

export type PortalSource = () => Generator<Portal, void, unknown>;
