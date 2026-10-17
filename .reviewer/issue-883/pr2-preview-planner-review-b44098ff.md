# Streamed Preview review: REQUEST CHANGES at b44098ff

A cold continuation can crash when a failed attempt is given an earlier reply's
screen identity. Correct that correlation and finish the missing observations
from the frozen matrix. The publisher/disclosure design is settled; no new
product or architecture ruling is needed.

## Exact revision and scope

- Reviewed: `b44098ffd18ebc2bb7f6f46a38a3f09a55889959`.
- Parent: `815233183c7c26cd40544347191b7ba5e1f975c3`, preserved.
- Branch agent/issue-883-pr2, signature G, signer tarasm@gmail.com.
- Worktree `.claude/worktrees/issue-883-pr2`, clean, no untracked files.
- Sixteen files, +1656/−47. Latest accepted prerequisite remains 81523318.

The governing sources are [the frozen plan](pr2-section5-preview-planner-handoff.md)
and [the completed Architect ruling](pr2-section5-preview-architect-decision.md).
The Planner changed no implementation, dependencies, cache or assertions in
the worktree. No commit, push, GitHub write, CI inspection or capture was made.

## PV-P1: a saved turn number is not a response identity

program.ts sidekickReadingOf(), line 1810, assigns an Incomplete item
`itemKey(conversation, responseOf(item.turn))`. responseOf(), lines 1880–1888,
claims the response name can be recovered as `response:<saved turn>`.

That equivalence is false under the accepted interrupted-message contract.
owner.ts names its response from nextTurn(), which considers saved message IDs
as well as attempted turns. Core numbers saved turns independently. The existing
request association deliberately allows those numbers to differ.

The real mounted reproducer does this without manufacturing records:

1. Send a message and Stop its held generation before a Prompt outcome lands.
   Exit, then reopen the same execution cold.
2. Send an ordinary successful message. Its reply is `response:2`, while its
   canonical saved turn is 1.
3. Send another message, show its live Preview, then let the provider fail.
   Its saved turn is 2. The new incomplete-item key is synthesized as
   `response:2`, colliding with the earlier successful reply.

The command raises:

```text
ReplRenderError: DUPLICATE_ID: An element with this ID was already previously
declared during this layout.
```

The same successful-predecessor/failed-successor sequence without the
unacknowledged first message stays readable. This proves the ruled identity
criterion is unmet; it is not an added retry or settings permutation.

[The paired probe](pr2-preview-correlation-probe-b44098ff.test.ts) runs against
the reviewed worktree. The decisive first runtime output is preserved in
[visible-input.log](pr2-preview-correlation-probe-b44098ff-visible-input.log):
the regression raises DUPLICATE_ID and its control passes. A diagnostic-only
follow-up also prints the predecessor's saved response/turn association in
[paired.log](pr2-preview-correlation-probe-b44098ff-paired.log).

The probe's initial typecheck used the serialized event as an object; it was
corrected to Core's existing parseDurableEvent reader. Its first runtime attempt
then used a message longer than the visible composer, so both arms stopped
before Send. The payloads were shortened to `saved` and `failed`; assertions
and product source were unchanged. Those earlier outputs remain as first.log
and run.log. They are probe adaptations, not product failures or flakes.

Bind the live slot to its actual acknowledged failed turn using the existing
registered response and bounded canonical request association. The Architect
already permits a process-local alias. Give cold failed items a truthful
identity without inferring a response name from a saved turn number. Preserve
both the earlier reply and failed attempt, and preserve one node across the live
transition. Do not hide the collision by dropping rows or weakening validation.

## PV-E1: finish the frozen observations

These are gaps in the existing PV1/PV2/PV5 scenarios, not a new matrix:

- **PV1 held controls:** the current first no-effects assertions occur before
  its second piece containing EntryInput/Submit has arrived (journey.test.ts
  lines 1091–1097). The next release also allows generation to finish. Hold
  after the complete candidate controls have arrived, before the provider
  terminal/return, and assert no control pair, fill or entry at that boundary.
- **PV1 item identity:** the current row counts one response record and checks
  text/labels (lines 1133–1140). It never compares the mounted item's identity.
  Complete the plan's same-node observation across Preview, evaluation and final
  reply/Incomplete, using production composition and the existing mounted or
  presentation fixtures. Counting matching text or journal records alone does
  not prove this criterion. PV-P1 exposes the consequence of omitting it.
- **PV2 parse refusal:** its loop stops before the final invalid prefix; the
  final absence of Preview is checked after a response record exists (lines
  1173, 1200–1213). Hold that invalid prefix before generation settles and
  observe withdrawal then, independently of evaluation's later refusal.
- **PV5 join and publication facts:** the observer-failure row uses a synchronous
  tears callback and checks only that it ran. Add the already assigned held
  cleanup observation, showing the failure has not returned/published while
  cleanup is held, then release and assert authoritative failure. The
  nonthrowing control supplies a checkpoint but does not assert its publication
  association and asks for no permission. Observe the actual checkpoint and
  retained permission audit with observe enabled, reusing the existing direct
  turn/audit fixture. Keep DP2/DP4's separate protection intact.

No additional mutation battery is required for these observations. Extend the
existing gates and paired rows; do not add a second terminal host, journal,
parser or hostile-policy corpus. Local testable factoring of detached screen
composition is within scope; a new production observer/debug API is not.

## What passes and the wakeup deviation

Core installs the exact optional observation shape on the host publisher,
validates begin, observes inline on the canonical consumer, clears whole
prefixes in the owning execution and routes host-observer failure through the
existing durability coordinator. The focused Core/ACP/policy commands pass,
including differing/empty return, handle identity, disclosure withdrawal,
counterfeit-policy refusal, replay, direct audit and ordinary publication rows.
No provider routing, journal grammar or scanner export was added.

The owner installs inside the held conversation, keeps raw source out of UI
facts and uses the pure reader. Existing partial-root, Stop/entry-independence,
configuration and recovery rows pass. These parts do not need redesign to fix
PV-P1 or complete PV-E1.

The Implementor reports the observation-wake mutation fails the incremental
PV2 row while the ordinary M3 completion control stays green. Its initial PV1
frame can be driven by the message's own acknowledgement, so that row is not a
second witness. The substitution is **accepted**: PV2 releases a later prefix
while no other work/input occurs, testing the same required wake connection.
Do not add another wake test or claim PV1 also discriminates. The other two
reported mutations discriminate and were restored byte-identically; the
Planner did not repeat those mutations or check = 0.

## Independent focused commands

All ten frozen commands ran against this exact revision. Each first-output log
below records its full invocation; none was overwritten or rerun.

| Selection | First result | Output |
| --- | --- | --- |
| Core canonical/ordinary turn consumers | 33 tests / 205 steps, green | [core](pr2-preview-review-b44098ff-core-first.log) |
| Pure preview / secret detection | 7 / 81, green | [policy](pr2-preview-review-b44098ff-policy-first.log) |
| ACP direct conversation / loaded copy | 4 / 11, green | [ACP](pr2-preview-review-b44098ff-acp-first.log) |
| Workflow checkpoints / CLI workflow hosts | 1 / 29 passed; 3 tests / 1 step failed in this environment | [workflow](pr2-preview-review-b44098ff-workflow-first.log) |
| Mounted Sidekick / owner lifecycle | 22 / 78, green | [mounted](pr2-preview-review-b44098ff-mounted-first.log) |
| Entries / history / response controls | 51 / 201, green | [entries](pr2-preview-review-b44098ff-entries-first.log) |
| Storage / recovery / configuration | 16 / 89, green | [recovery](pr2-preview-review-b44098ff-recovery-first.log) |
| Ordinary journeys / agent interface / forms | 71 / 185, green | [journey](pr2-preview-review-b44098ff-journey-first.log) |
| Route / layout / source reading | 28 / 130, green | [layout](pr2-preview-review-b44098ff-layout-first.log) |
| Execution / lifecycle | 6 / 39, green | [lifecycle](pr2-preview-review-b44098ff-lifecycle-first.log) |

Nine selections independently pass **238 tests / 1019 steps**. U2 did not recur.
The workflow checkpoint publisher passes all 12 rows and most CLI workflow rows
pass. WAL12 and the two workflow-session describes reach embedded adapter
installation and npm refuses mkdir/mkdtemp under the sandbox-inaccessible
`/Users/tarasmankovski/.npm/_cacache/tmp` with EPERM; two then report pending
Promise resolution. This is recorded as a review-environment limitation, not a
Preview production finding or intermittent green result. No shared cache,
dependency, test or production change was made to work around it.

The Implementor's all-green 242 / 1052 report is retained as reported evidence;
it is not the Planner's independent result. This verdict rests on the actual
reproduced correlation failure and missing frozen observations, not the npm
limitation. No full suite, CI, delivery or capture evidence was used.

## Disposition

Execute [the correction](pr2-preview-implementor-correction-b44098ff.md) from
this signed head, preserving it. Return the probe's passing pair, completed
PV-E1 observations and ten final focused commands in one signed feedback commit.
Keep Configure/Retry and all prior acceptances closed. The Preview slice remains
unaccepted; Sessions, complete terminal acceptance, captures and delivery remain
deferred.
