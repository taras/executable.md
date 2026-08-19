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
 * So the table is built in one place — the retained-run installation's
 * admission, inside core's own trusted journal read, from the snapshot core
 * admitted — and published beside the run itself, where every physical copy of
 * this package reads it. A second copy loaded from disk reconciles through the
 * same stable operation name (Tier DLG), and it must see the same retained
 * identities: a fork whose Git-host history replayed for one copy and diverged
 * for another would accept different history depending on which module object
 * asked.
 *
 * What makes an answer safe is not where it came from but what happens to a
 * wrong one. On replay the shared reconciliation holds the record it consumed
 * to the request being made, so an identity that is not that record's own is a
 * refusal. And a request named by a retained record that reaches live execution
 * performs nothing at all. A substituted answer can therefore deny this effect;
 * it cannot make it observe, perform or journal under another run.
 *
 * ## One record, one position, in order
 *
 * A retained identity belongs to the exact retained event it came from, and to
 * the position that event occupies. `reconcileGitHostEffect()` is a public
 * surface, so one expansion may reach it more than once, and a fork whose
 * inherited prefix ends after the first of those calls must not lend the
 * source's identity to the second — that call is live, and a live call is the
 * fork's own.
 *
 * So the records are consumed **in order**. A call is offered the next one that
 * has not been taken, and only when that record asks exactly what the call
 * asks; anything else leaves the inherited prefix behind for good. Matching by
 * shape alone was not enough: it let a call claim a *later* record while the
 * record actually at this position was a different one, so a mismatch there —
 * with public divergence policy choosing to run live — became live execution
 * under a source identity.
 *
 * Falling through to live is final. Once a call runs live, replay has left the
 * inherited prefix, and nothing after it may borrow: the reconciliation reports
 * that back through {@link exhaustRetainedGitHostIdentities}, so a borrowed name
 * that reaches the live path takes the rest of the prefix out of use with it.
 *
 * A caller holding a run object cannot enroll it, and a caller holding a
 * different object — a counterfeit run from a rebound slot — finds nothing and
 * falls back to the run it is holding. That is the pre-existing
 * `getWorkflowRun()` boundary the run installation already documents, unchanged
 * and unwidened: a forged run identifies itself, and this adds no way to borrow
 * somebody else's.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { canonicalJson } from "../storage/record.ts";
import { GIT_HOST_EFFECT } from "./effect-type.ts";
import { parseGitHostReconciliationRecord } from "./records.ts";
import type { CompleteGitHostEffectRequest } from "./records.ts";

/** One retained record's identity, and what it was a record of. */
export interface RetainedIdentity {
  readonly runId: string;
  /** The request it answers for, with the run it was written under left out. */
  readonly asked: string;
  claimed: boolean;
}

/**
 * The identities one admitted history holds, in the order it holds them.
 *
 * Built by the retained-run installation's admission, from the snapshot
 * canonical core admitted, and published where every physical copy of this
 * package reads it.
 */
export function retainedGitHostIdentities(retained: readonly DurableEvent[]): RetainedIdentity[] {
  return identitiesIn(retained);
}

/**
 * Take the rest of the inherited prefix out of use.
 *
 * Called when a call has run live: replay has left the prefix, and a later
 * record must not be borrowed by whatever happens next.
 */
export function exhaustRetainedGitHostIdentities(held: RetainedIdentity[] | undefined): void {
  if (held !== undefined) {
    exhaust(held);
  }
}

/**
 * Take the identity of the retained record at the next unconsumed position,
 * when that record asks exactly what this request asks.
 *
 * Nothing is the ordinary answer, and it is what every live position gives.
 */
export function claimRetainedGitHostIdentity(
  held: RetainedIdentity[] | undefined,
  request: CompleteGitHostEffectRequest,
): string | undefined {
  if (held === undefined) {
    return undefined;
  }
  const next = held.find((identity) => !identity.claimed);
  // In order, and only the next one. A call that does not ask what the record
  // at this position answers is past the inherited prefix, and every later
  // record goes with it rather than waiting to be matched by shape.
  if (next === undefined || next.asked !== asked(request)) {
    exhaust(held);
    return undefined;
  }
  next.claimed = true;
  return next.runId;
}

/**
 * What one request asks, apart from the run asking it.
 *
 * The run id is left out precisely because it is the thing being decided; the
 * expansion stays in, so a record never answers for a position somewhere else
 * in the document.
 */
function exhaust(held: RetainedIdentity[]): void {
  for (const identity of held) {
    identity.claimed = true;
  }
}

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
