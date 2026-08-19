/**
 * Which run each Git-host record in a history was written under, established
 * where nothing replaceable can reach it.
 *
 * A Git-host effect is named by a digest that includes the run id, so a record
 * a fork inherited would compute a different name under the fork and replay
 * would diverge before any provider question arose. Deciding the name therefore
 * needs to know what this run already retains at this position.
 *
 * Every obvious way of carrying that answer is replaceable. An Effection
 * context is identified by its name, so a component, a public middleware or a
 * separately loaded copy can bind the same name and answer for it — and that
 * includes the durable machinery's own `DurableContext`, whose replay index a
 * stateful counterfeit can forge one peek of and then delegate. An identity
 * chosen that way would reach a live observation, a live performance and the
 * journal.
 *
 * So the association is held here, in a table this module closes over. It is
 * keyed by the exact frozen `WorkflowRun` canonical core admitted, and it is
 * written in one place: the retained-run installation's admission, inside
 * core's own trusted journal read, from the snapshot core admitted. There is no
 * name to bind, no value to substitute, and no setter anything outside this
 * package's own installation can reach.
 *
 * A caller holding a run object cannot enroll it, and a caller holding a
 * different object — a counterfeit run from a rebound slot — finds nothing and
 * falls back to the run it is holding. That is the pre-existing
 * `getWorkflowRun()` boundary the run installation already documents, unchanged
 * and unwidened: a forged run identifies itself, and this adds no way to borrow
 * somebody else's.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import type { WorkflowRun } from "../journal.ts";
import { GIT_HOST_EFFECT } from "./effect-type.ts";
import { parseGitHostReconciliationRecord } from "./records.ts";

const retainedIdentities = (() => {
  // Canonical-module-local, on the same terms as journal provenance: a loaded
  // copy cannot read this copy's associations or add to them.
  const byRun = new WeakMap<WorkflowRun, ReadonlyMap<string, string>>();

  return {
    remember(run: WorkflowRun, identities: ReadonlyMap<string, string>): void {
      byRun.set(run, identities);
    },
    at(run: WorkflowRun, expansionId: string): string | undefined {
      return byRun.get(run)?.get(expansionId);
    },
  };
})();

/**
 * Associate one admitted run with the Git-host identities its history holds.
 *
 * Called by the retained-run installation's admission and by nothing else, with
 * the run canonical core admitted and the snapshot it admitted it from.
 */
export function rememberRetainedGitHostIdentities(
  run: WorkflowRun,
  retained: readonly DurableEvent[],
): void {
  retainedIdentities.remember(run, identitiesIn(retained));
}

/**
 * The run one retained Git-host record at this expansion was written under.
 *
 * Nothing is the ordinary answer, and it is what every live position gives: a
 * history holding no record there has no identity to lend, so the effect is
 * named by the run making the request.
 */
export function retainedGitHostIdentityFor(
  run: WorkflowRun,
  expansionId: string,
): string | undefined {
  return retainedIdentities.at(run, expansionId);
}

/**
 * Read the identity every settled Git-host record in this history holds.
 *
 * Only a record that parses counts. A failed Git-host effect retains none — its
 * outcome is the durable operation's failed result — and there is nothing there
 * to name an identity with.
 */
function identitiesIn(retained: readonly DurableEvent[]): ReadonlyMap<string, string> {
  const identities = new Map<string, string>();
  for (const event of retained) {
    const identity = identityOf(event);
    if (identity === undefined) {
      continue;
    }
    // First wins. One expansion produces one Git-host effect, so a second entry
    // under the same expansion describes two, and the later one would name a
    // position the earlier one occupies.
    if (!identities.has(identity.expansionId)) {
      identities.set(identity.expansionId, identity.runId);
    }
  }
  return identities;
}

function identityOf(event: DurableEvent): { runId: string; expansionId: string } | undefined {
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
