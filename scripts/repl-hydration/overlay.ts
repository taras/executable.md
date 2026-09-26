/**
 * What only a live process knows, kept where it cannot be mistaken for
 * evidence.
 *
 * #841 established that the pause controller is generator state in a scope
 * outside the subtree it holds: ephemeral, never journaled, and gone with the
 * process. #842 has to show that nothing durable depends on it, which needs
 * the thing to exist somewhere — so it exists here, in a module the pure
 * boundary does not import and cannot be handed.
 *
 * The overlay answers two questions and owns no state of its own:
 *
 * - which marker expansion is currently held at, if any;
 * - whether Continue is offered, which is true only while this process still
 *   holds that exact continuation.
 *
 * Both are `live`. After process loss there is no overlay at all — not an
 * overlay reporting `false`, which would still be a claim about a pause — and
 * `cold()` is what that absence is spelled as. A reconstruction from Journal
 * and URL alone gets `cold()`, and a UI reading it has nothing to say about
 * EXPANSION PAUSED because there is nothing there that could say it.
 *
 * Nothing in this module may be passed to `parseJournal()`, `projectPrefix()`
 * or `resolveLocation()`. None of them has a parameter it would fit, and the
 * import evidence holds them to never acquiring one.
 */

/**
 * A process that is holding XMD expansion.
 *
 * The expansion pause point is fixed while this exists; the live History head
 * is free to move past it, because background work keeps recording.
 */
export interface LiveOverlay {
  readonly held: true;
  /** The marker whose record expansion is held at. */
  readonly pauseMarker: string;
  /** Offered only while this process owns the original held continuation. */
  readonly canContinue: boolean;
}

/** No process is holding anything: either it never was, or it is gone. */
export interface ColdOverlay {
  readonly held: false;
}

export type Overlay = LiveOverlay | ColdOverlay;

/** The overlay of a process holding expansion at one marker. */
export function live(pauseMarker: string): LiveOverlay {
  return { held: true, pauseMarker, canContinue: true };
}

/**
 * The same process after the continuation is discarded.
 *
 * Expansion is still held at the same marker — a held routine does not resume
 * because its continuation was dropped — but Continue is no longer something
 * this process can offer.
 */
export function released(overlay: LiveOverlay): LiveOverlay {
  return { held: true, pauseMarker: overlay.pauseMarker, canContinue: false };
}

/** What survives process loss, which is nothing. */
export function cold(): ColdOverlay {
  return { held: false };
}
