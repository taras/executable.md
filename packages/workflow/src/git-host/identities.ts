/**
 * Which run each Git-host record in a history was written under, established
 * where nothing replaceable can reach it and claimed one position at a time.
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
 * ## One record, one position
 *
 * A retained identity belongs to the exact retained event it came from, not to
 * the expansion that produced it. `reconcileGitHostEffect()` is a public
 * surface, so one expansion may reach it more than once, and a fork whose
 * inherited prefix ends after the first of those calls must not lend the
 * source's identity to the second — that call is live, and a live call is the
 * fork's own. So each retained record is *claimed* once: it answers for a
 * request that matches it exactly, and only until something has taken it.
 * Everything after the inherited prefix runs out finds nothing, which is what
 * makes reaching a live position enough to be named by the run making it.
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
import { canonicalJson } from "../storage/record.ts";
import { GIT_HOST_EFFECT } from "./effect-type.ts";
import { parseGitHostReconciliationRecord } from "./records.ts";
import type { CompleteGitHostEffectRequest } from "./records.ts";

/** One retained record's identity, and what it was a record of. */
interface RetainedIdentity {
  readonly runId: string;
  /** The request it answers for, with the run it was written under left out. */
  readonly asked: string;
  claimed: boolean;
}

const retainedIdentities = (() => {
  // Canonical-module-local, on the same terms as journal provenance: a loaded
  // copy cannot read this copy's associations or add to them.
  const byRun = new WeakMap<WorkflowRun, RetainedIdentity[]>();

  return {
    remember(run: WorkflowRun, identities: RetainedIdentity[]): void {
      byRun.set(run, identities);
    },
    claim(run: WorkflowRun, asked: string): string | undefined {
      const identity = byRun.get(run)?.find((held) => !held.claimed && held.asked === asked);
      if (identity === undefined) {
        return undefined;
      }
      identity.claimed = true;
      return identity.runId;
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
 * Take the identity the retained record for exactly this request was written
 * under, if this run retains one nothing has taken yet.
 *
 * Nothing is the ordinary answer, and it is what every live position gives: a
 * request the inherited prefix holds no unclaimed record for is one this run is
 * making itself, so it is named by the run making it.
 */
export function claimRetainedGitHostIdentity(
  run: WorkflowRun,
  request: CompleteGitHostEffectRequest,
): string | undefined {
  return retainedIdentities.claim(run, asked(request));
}

/**
 * What one request asks, apart from the run asking it.
 *
 * The run id is left out precisely because it is the thing being decided; the
 * expansion stays in, so a record never answers for a position somewhere else
 * in the document.
 */
function asked(request: CompleteGitHostEffectRequest): string {
  return canonicalJson({
    expansionId: request.identity.expansionId,
    kind: request.kind,
    inputs: request.inputs,
    naturalKey: request.naturalKey,
  });
}

/**
 * Read the identity every settled Git-host record in this history holds, in the
 * order the history holds them.
 *
 * Only a record that parses counts. A failed Git-host effect retains none — its
 * outcome is the durable operation's failed result — and there is nothing there
 * to name an identity with.
 */
function identitiesIn(retained: readonly DurableEvent[]): RetainedIdentity[] {
  const identities: RetainedIdentity[] = [];
  for (const event of retained) {
    const request = requestOf(event);
    if (request === undefined) {
      continue;
    }
    identities.push({ runId: request.identity.runId, asked: asked(request), claimed: false });
  }
  return identities;
}

function requestOf(event: DurableEvent): CompleteGitHostEffectRequest | undefined {
  try {
    if (event.type !== "yield" || event.description.type !== GIT_HOST_EFFECT) {
      return undefined;
    }
    if (event.result.status !== "ok") {
      return undefined;
    }
    return parseGitHostReconciliationRecord(event.result.value)?.request;
  } catch {
    return undefined;
  }
}
