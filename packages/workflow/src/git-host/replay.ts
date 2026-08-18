/**
 * Which run a retained Git-host record was written under, for the run replaying
 * it now.
 *
 * A Git-host effect's external identity is the run and the expansion, and the
 * durable operation is named by a digest that includes it. That is what stops a
 * live attempt from observing under somebody else's identity and adopting a
 * completion it never produced.
 *
 * It also means a record written by one run cannot be *replayed* by another
 * whose id differs — the digest moves, and replay sees a different operation at
 * that position. For a fork that is the wrong answer twice over. The record is
 * already in the fork's own journal, put there by the admission the trusted
 * host committed; nothing about consuming it asks a provider anything; and the
 * remote was mutated once, by the source, exactly as the record says.
 *
 * So the rule this module supplies is narrow: **at a position where this run's
 * own retained history already holds a Git-host record, the operation is named
 * by the identity that record holds. Everywhere else it is named by this run's
 * own.** A live attempt is unaffected — there is no retained record for it —
 * so the run performing new work is always the authority for it.
 *
 * ## Why this cannot be used to adopt somebody else's completion
 *
 * The map is built from this run's retained events and from nothing else, inside
 * canonical core's own trusted journal read, before any middleware or document
 * code exists. An identity is admitted only because a record carrying it is
 * already retained here, and the only way another run's record arrives is the
 * fork admission — which copies the record itself along with it.
 *
 * It is fail-closed besides. The identity chosen here decides the operation's
 * name, and the shared reconciliation still holds the retained record to the
 * request being made now: a substituted identity produces a name that matches
 * no retained event, or a record whose request differs, and both are refusals
 * rather than adoptions.
 *
 * A run that is not a fork retains only its own records, so every identity in
 * its map is its own id and this changes nothing about it.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { ExecutionInstallation, JournalAdmission } from "@executablemd/core/host";
import { GIT_HOST_EFFECT } from "./effect-type.ts";
import { parseGitHostReconciliationRecord } from "./records.ts";

/**
 * Where the identities this run's retained Git-host records hold are kept.
 *
 * A stable, namespaced name and a plain value, on the same terms as the current
 * workflow run: another loaded copy reads the same binding. Nothing durable is
 * decided by trusting it — see the module note.
 */
const RetainedGitHostIdentities: Context<IdentitySlot | undefined> = createContext<
  IdentitySlot | undefined
>("executablemd.workflow.git-host.retained-identities", undefined);

interface IdentitySlot {
  identities?: ReadonlyMap<string, string>;
}

/**
 * The run one retained Git-host record at this expansion was written under, or
 * nothing when this run retains none there.
 *
 * Nothing is the ordinary answer: it means this position is live, and a live
 * attempt is named by the run performing it.
 */
export function* retainedGitHostIdentity(expansionId: string): Operation<string | undefined> {
  const slot = yield* RetainedGitHostIdentities.get();
  return slot?.identities?.get(expansionId);
}

/**
 * Read the identity every retained Git-host record in this history holds.
 *
 * Only a settled, successfully parsed record counts. A failed Git-host effect
 * retains no record — its outcome is the durable operation's failed result —
 * and there is nothing there to name an identity with.
 */
function retainedIdentities(retained: readonly DurableEvent[]): ReadonlyMap<string, string> {
  const identities = new Map<string, string>();
  for (const event of retained) {
    const record = recordOf(event);
    if (record === undefined) {
      continue;
    }
    // First wins. One expansion produces one Git-host effect, so a second entry
    // under the same expansion is a history that describes two, and replaying
    // under the later one would consume the earlier one's position.
    if (!identities.has(record.expansionId)) {
      identities.set(record.expansionId, record.runId);
    }
  }
  return identities;
}

/**
 * The identity one retained event's record holds, when the event is a settled
 * Git-host record at all.
 *
 * Read through the same total parse the shared reconciliation uses, so a value
 * that refuses to be read is an event this contributes nothing about rather
 * than an exception carrying journal text out.
 */
function recordOf(event: DurableEvent): { runId: string; expansionId: string } | undefined {
  try {
    if (event.type !== "yield" || event.description.type !== GIT_HOST_EFFECT) {
      return undefined;
    }
    if (event.result.status !== "ok") {
      return undefined;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    return record === undefined ? undefined : record.request.identity;
  } catch {
    return undefined;
  }
}

function admits(): JournalAdmission {
  return function* (retained: readonly DurableEvent[]): Operation<void> {
    const slot = yield* RetainedGitHostIdentities.get();
    if (slot === undefined) {
      return;
    }
    slot.identities = retainedIdentities(retained);
  };
}

/**
 * What a trusted host attaches so a retained Git-host record replays at the
 * position it occupies.
 *
 * An installation rather than something installed into an ambient scope: the
 * admission is a value the host hands to `executeInstalled()`, so canonical
 * core captures it before any middleware or document code exists.
 */
export function gitHostReplayInstallation(): ExecutionInstallation {
  return {
    admissions: [admits()],
    *install(): Operation<void> {
      // A fresh slot per invocation, so one execution cannot see another's.
      yield* RetainedGitHostIdentities.set({});
    },
  };
}
