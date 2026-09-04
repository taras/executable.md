/**
 * A failure the Workspace effect publishes instead of raising.
 *
 * The distinction is not "what went wrong" but "who this belongs to". A failure
 * of this kind is part of what the effect *did*: it is written into the journal
 * as the effect's result, the Workspace root stays where it was, and a replay
 * reproduces it without performing anything. Every other failure is the run
 * failing, and travels as an ordinary raise.
 *
 * It is a base class rather than a predicate over shapes so that being
 * publishable is something a failure declares by construction. A module that
 * wants its own refusal published extends this; nothing acquires the property
 * by resembling something.
 *
 * Shared because both coordinators have to make the same choice, and two
 * classifiers would eventually disagree about which failures are the run's.
 */
export abstract class JournaledEffectFailure extends Error {}

/**
 * Whether this failure is the effect's outcome rather than the run's failure.
 *
 * Asked by the one place in each host that has to choose between writing a
 * result and letting a failure through.
 */
export function isJournaledEffectFailure(error: unknown): error is Error {
  return error instanceof JournaledEffectFailure;
}
