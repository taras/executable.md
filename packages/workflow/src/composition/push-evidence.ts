/**
 * Proving that this run published the branch it is about to open a pull request
 * for.
 *
 * A pull request says "here is work I have pushed". The branch it names lives
 * at a Git host, where anything at all could have put it, so the only thing
 * that makes it *this run's* branch is this run's own record of publishing it —
 * a successful `<Git.Push>` for the same Repository identity, the same head
 * branch, the same destination ref and the same commit. Direct remote
 * observation cannot stand in for that: a branch that happens to be there
 * proves who has write access, not who wrote it.
 *
 * The scan is closed and deterministic, and it fails closed. Three things can
 * go wrong and each has its own word:
 *
 * - **missing** — no such Push is recorded. The document has to write one.
 * - **conflicting** — this run published this branch at another commit. The
 *   pull request would name a head this run never published.
 * - **unreadable** — a successful Git-host record this scan cannot read as one
 *   whole thing. A shape that will not parse, and a record whose natural key,
 *   inputs and result do not name the same publication, are both refused rather
 *   than skipped: neither can be shown to be about something else, and "I could
 *   not read it" must never come out as "there is nothing there".
 *
 * Nothing here quotes a journal value. What is refused is exactly what must not
 * be repeated.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { GIT_HOST_EFFECT } from "../git-host/effect.ts";
import { parseGitHostReconciliationRecord } from "../git-host/records.ts";
import {
  destinationRefFor,
  GIT_PUSH,
  PUSH_REMOTE,
  parseGitPushInputs,
  parseGitPushNaturalKey,
  parseGitPushRecord,
  pushExpectation,
  sameRepositoryIdentity,
} from "./git-push-records.ts";
import { PullRequestAuthorityError } from "./errors.ts";
import type { PullRequestInputs } from "./pull-request-records.ts";

function refuse(reason: "missing" | "conflicting" | "unreadable"): never {
  if (reason === "missing") {
    throw new PullRequestAuthorityError(
      "missing-push-evidence",
      "this run holds no successful <Git.Push> result for the branch and commit it would open a " +
        "pull request from. Write <Git.Push /> before <PullRequest>: a pull request names work " +
        "this run published, and publishing it is an explicit act.",
    );
  }
  if (reason === "conflicting") {
    throw new PullRequestAuthorityError(
      "conflicting-push-evidence",
      "this run published that branch at a different commit than the one the checkout is on " +
        "now, so a pull request opened from it would name a head this run never published.",
    );
  }
  throw new PullRequestAuthorityError(
    "unreadable-push-evidence",
    "this run holds a successful Git-host result whose record cannot be read, so whether the " +
      "branch was published cannot be decided. Nothing is assumed about a record this version " +
      "cannot account for.",
  );
}

/**
 * That these inputs are authorized by a Push this run already performed.
 *
 * Every successful Git-host result in the run is inspected. A record of another
 * kind, and a Push of another Repository or another destination, are ignored —
 * a workflow may publish several branches, and one of them being irrelevant is
 * ordinary. Everything else is decided:
 *
 * A relevant Push at another commit is conflicting rather than missing, because
 * the run did publish that branch and saying "push it first" would be advice to
 * do something it already did. One or more exact records authorize, and they
 * cannot disagree with each other: each of them was held to this same branch
 * and this same commit before it was counted.
 *
 * Failed Git-host outcomes are not evidence of anything. A refused push
 * published nothing, and a record of it never authorizes.
 */
export function admitPushEvidence(
  events: readonly DurableEvent[],
  inputs: PullRequestInputs,
): void {
  const destinationRef = destinationRefFor(inputs.headBranch);
  let proofs = 0;

  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== GIT_HOST_EFFECT) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    if (record === undefined) {
      // A successful Git-host record this scan cannot parse. Its kind is inside
      // the part that would not read, so it cannot be excluded as unrelated.
      refuse("unreadable");
    }
    if (record.request.kind !== GIT_PUSH) {
      continue;
    }
    const key = parseGitPushNaturalKey(record.request.naturalKey);
    if (key === undefined) {
      refuse("unreadable");
    }
    if (
      !sameRepositoryIdentity(key.repository, inputs.repository) ||
      key.destinationRef !== destinationRef
    ) {
      continue;
    }
    const pushed = parseGitPushInputs(record.request.inputs);
    if (pushed === undefined) {
      refuse("unreadable");
    }
    // The key said this record is about our destination. The inputs are what
    // the result is then read against, so a record whose two halves name
    // different places cannot be read at all — and reading it anyway would
    // admit a push of somebody else's branch on the strength of a key that
    // merely mentioned ours. Both comparisons are written out: one of them
    // follows from the other and the relevance test above, and a closure this
    // load-bearing should not ask a reader to chain implications.
    if (
      !sameRepositoryIdentity(pushed.repository, key.repository) ||
      pushed.remote !== key.remote ||
      pushed.destinationRef !== key.destinationRef ||
      !sameRepositoryIdentity(pushed.repository, inputs.repository) ||
      pushed.remote !== PUSH_REMOTE ||
      pushed.branch !== inputs.headBranch ||
      pushed.destinationRef !== destinationRef
    ) {
      refuse("unreadable");
    }
    if (pushed.sourceCommit !== inputs.headSha) {
      refuse("conflicting");
    }
    if (parseGitPushRecord(record, pushExpectation(pushed)) === undefined) {
      refuse("unreadable");
    }
    proofs += 1;
  }

  if (proofs === 0) {
    refuse("missing");
  }
}
