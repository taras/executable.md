/**
 * The durable type every external Git-host effect is journaled under.
 *
 * Its own module because two readers need it without needing the reconciliation
 * that writes it: forkability classifies a retained event by type, and the
 * replay-identity admission recognizes one in a history. Importing the shared
 * effect for a string would pull the provider surface into both.
 */
export const GIT_HOST_EFFECT = "git_host_effect";
