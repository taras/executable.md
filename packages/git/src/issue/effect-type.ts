/**
 * The durable type every external Issue effect is journaled under.
 *
 * Its own module for the reason the Git-host one has its own: the retained
 * identity admission classifies an event by type without needing the
 * reconciliation that writes it, and importing the effect for a string would
 * pull the provider surface in with it.
 */
export const ISSUE_EFFECT = "issue_effect";
