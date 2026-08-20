/**
 * Which run each Issue record in a history was written under, established where
 * nothing replaceable can reach it and claimed one position at a time.
 *
 * An Issue effect is named by a digest that includes the run id, and its
 * natural key holds the run id outright, so a record a fork inherited would
 * compute a different name under the fork and replay would diverge before any
 * provider question arose — and the fork would then create a second issue for
 * an obligation already filed. Deciding the name therefore needs to know what
 * this run already retains at this position.
 *
 * This is a parallel module rather than a parameterization of the Git-host one,
 * and deliberately. The two request shapes differ — a Git-host request is named
 * by a `kind`, an Issue request by a resolved provider and a canonical target —
 * so a shared engine would take a parser and a projection as arguments and be
 * read at both call sites anyway. The Git-host table is also a settled
 * compatibility boundary that a second effect type should not be able to move.
 * If a third external effect appears, unifying them is a mechanical change with
 * both shapes already written down.
 *
 * The reasoning about *why* the table is built where it is belongs to
 * `git-host/identities.ts` and holds identically here: every obvious way of
 * carrying the answer is replaceable, so it is built once in the retained-run
 * installation's admission, inside core's own trusted journal read, and
 * published beside the run where every physical copy of this package reads it.
 * What makes a wrong answer safe is what happens to it: on replay the record
 * consumed is held to the request being made, and a request named by a retained
 * record that reaches live execution performs nothing at all.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { canonicalJson } from "../storage/record.ts";
import { ISSUE_EFFECT } from "./effect-type.ts";
import { parseIssueReconciliationRecord } from "./records.ts";
import type { CompleteIssueRequest } from "./records.ts";

/** One retained record's identity, and what it was a record of. */
export interface RetainedIssueIdentity {
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
export function retainedIssueIdentities(
  retained: readonly DurableEvent[],
): RetainedIssueIdentity[] {
  const identities: RetainedIssueIdentity[] = [];
  for (const event of retained) {
    const request = requestOf(event);
    if (request === undefined) {
      continue;
    }
    identities.push({ runId: request.identity.runId, asked: asked(request), claimed: false });
  }
  return identities;
}

/**
 * Take the rest of the inherited prefix out of use.
 *
 * Called when a call has run live: replay has left the prefix, and a later
 * record must not be borrowed by whatever happens next.
 */
export function exhaustRetainedIssueIdentities(held: RetainedIssueIdentity[] | undefined): void {
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
export function claimRetainedIssueIdentity(
  held: RetainedIssueIdentity[] | undefined,
  request: CompleteIssueRequest,
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

function exhaust(held: RetainedIssueIdentity[]): void {
  for (const identity of held) {
    identity.claimed = true;
  }
}

/**
 * What one request asks, apart from the run asking it.
 *
 * The run id is left out precisely because it is the thing being decided; the
 * expansion stays in, so a record never answers for a position somewhere else
 * in the document. The natural key is left out too — it is derived from the run
 * and the target, so including it would put the undecided run id back in.
 */
function asked(request: CompleteIssueRequest): string {
  return canonicalJson({
    expansionId: request.identity.expansionId,
    provider: request.provider,
    target: request.target,
    inputs: request.inputs,
  });
}

/**
 * Read the identity every settled Issue record in this history holds, in the
 * order the history holds them.
 *
 * Only a record that parses counts. A failed Issue effect retains none — its
 * outcome is the durable operation's failed result — and there is nothing there
 * to name an identity with.
 */
function requestOf(event: DurableEvent): CompleteIssueRequest | undefined {
  try {
    if (event.type !== "yield" || event.description.type !== ISSUE_EFFECT) {
      return undefined;
    }
    if (event.result.status !== "ok") {
      return undefined;
    }
    return parseIssueReconciliationRecord(event.result.value)?.request;
  } catch {
    return undefined;
  }
}
