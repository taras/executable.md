# Planner review: metadata refresh at c5bec458

REQUEST CHANGES at `c5bec4583b9c60ef68f2c52a84fa4e8d298a7dad`, parent
`01990ca4dfca3d9526908ac775469c28f1be7776`, branch `agent/issue-883-pr2`.
The signature verifies G for tarasm@gmail.com and the implementation worktree
is clean. Stop remains accepted at 01990ca4. One refresh requirement fails.

## P1: an unsuccessful refresh suppresses the next required refresh

projectSidekick assigns conversation.oriented from every reference record.
The owner appends that record before calling handle.prompt. If a conversation
already has a completed turn, a failed refresh still advances oriented to the
current digests. The next explicit message sees matching versions and omits
the updated orientation, even though no completed canonical turn established
its delivery.

This violates the existing handoff requirement to retain context actually
delivered with the canonical accepted turn. The prior owner correction already
established that a local record and an ordinal do not prove what an agent was
told. That rule applies to a refresh as well as first orientation and feedback.

The [delivery probe](pr2-metadata-delivery-probe-c5bec458.test.ts) reuses this
commit's real-owner/reopened-repository refresh scenario and older-build fixture.
Its successful-refresh control passes. Its regression changes the refresh turn
to the established max_tokens failure, then sends another explicit message.
That message contains only the current draft and person's text; it lacks the
required bootstrap/index/surface. The first failing output is preserved in
[the probe log](pr2-metadata-delivery-probe-c5bec458-first.log).

Keep a reference as a retained proposal until a completed canonical turn proves
that it carried the exact context. Derive the last delivered versions from
that evidence, rather than the most recently appended reference. Failed or
interrupted refreshes must not suppress the next required refresh. A completed
refresh must still suppress redundant delivery. Do not evaluate failed provider
source or resend an interrupted prompt automatically; the next explicit message
is the retry boundary.

Digest comparison, cold-open passivity, chapter bodies staying on demand,
unchanged response permissions and the successful once-only refresh are retained
from this increment. The synthetic older-build fixture is a legitimate way to
exercise a build boundary, but it does not prove delivery merely by appending a
reference. If the corrected projection validates its canonical context, align
that fixture with the canonical input an older build would have sent.

## Independently rerun evidence

All commands ran from `.claude/worktrees/issue-883-pr2` at the reviewed SHA.
Use the absolute root prefix
`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/`
for each probe below.

| Command | Result |
| --- | --- |
| deno test --config deno.json --allow-all ROOT/pr2-stop-startup-probe-88c482b7.test.ts | 1 test, 2 steps |
| deno test --config deno.json --allow-all ROOT/pr2-stop-join-probe-88c482b7.test.ts | 1 test, 2 steps |
| deno test --config deno.json --allow-all ROOT/pr2-feedback-receipt-probe-f5b60c99.test.ts | 1 test, 3 steps |
| deno test --config deno.json --allow-all ROOT/pr2-feedback-contract-probe-97f8cb79.test.ts | 1 test, 5 steps |
| deno test --config deno.json --allow-all ROOT/pr2-owner-failure-probe-e3aaa61e.test.ts | 1 test, 3 steps |
| deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts | 24 tests, 130 steps |
| deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts | 38 tests, 146 steps |
| deno test --config deno.json --allow-all ROOT/pr2-metadata-delivery-probe-c5bec458.test.ts | Successful-refresh control passes; failed-refresh retry fails |

The seven reported commands exit 0: 67 tests, 291 steps. Their logs are
`pr2-metadata-review-c5bec458-{startup,join,receipt,contract,owner,focused,consumers}.log`.
No full suite, CI inspection or GitHub action informs this verdict.

## Elicit ruling and continuity

The missing root-entry factory is real. Core's host surface exports
elicitWriteEntry for a fragment profile, but no GeneratedMutation factory for
canonical Elicit. The accepted response table already grants canonical paired
Elicit and assigns its provider to Sidekick. Adding the corresponding trusted
host factory implements that settled contract; it introduces no new ownership,
permission or conversation method. It does not need a new architecture interview.

Proceed with pinnedElicit under the
[focused implementation handoff](pr2-elicit-pinning-planner-handoff.md), after
closing P1. One correction to the proposal: elicit:ask is the fragment capability
label; elicitWriteEntry's retained identity key is Elicit. Reuse the actual
canonical identity and definition, not a copied body or a same-name CLI component.

Produced artifacts are this review, the
[metadata correction prompt](pr2-metadata-delivery-implementor-prompt.md), the
probe/first output, passing logs, Elicit handoff and updated planner-handoff.md.
Latest accepted head remains 01990ca4. Metadata refresh is unaccepted until P1
closes. Elicit, configuration, R2 cases 2/5/6 and section 5 remain incomplete.
No production files were changed. No push, GitHub or CI authorization is added.
