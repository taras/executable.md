# Architecture review of #921 at d906c636

PASS for the settled structural architecture. No structural correction is
assigned. Two reproduced presentation regressions are recorded separately below
for the Planner; this verdict does not accept those product deviations or claim
delivery readiness.

## Exact review boundary

- PR: https://github.com/taras/executable.md/pull/921.
- Head: `d906c6360533aaf894f5424dd4689aceedf08c3b`.
- Parent: `25227d38cb8087743cd404533c7960de9423a442`.
- Branch: `agent/issue-883-pr2`; signature G, signer tarasm@gmail.com.
- PR base: `agent/issue-883-pr1` at
  `79d404d04d02c3840892473b6f1b2cf540f3edd1` (#890).
- Worktree: `.claude/worktrees/issue-883-pr2`, independently clean before and
  after the commands. GitHub still names the same head and base.
- Cumulative slice: 71 commits, 197 changed files. The last increment changes
  14 files; earlier work has the accepted incremental reviews in this packet.

The accepted Sessions decision, direct-provider ruling, Preview decision,
configuration timing decision and terminal/responsiveness review remain the
structural reference. The released composer, width and guidance/padding
amendments govern the latest increment. This review does not reopen accepted
contracts or treat the PR description as a replacement for them.

## Structural result

The direct conversation provider is selected once for the conversation's
lifetime. Core keeps configuration admission, the one-use request and private
evidence of the exact settled Session. Activation compares and acknowledges the
saved configuration before native provider work; ordinary Agent middleware is
still compositional. The direct turn uses the canonical runner, journal and
audit rather than a second definition of a turn.

The Sidekick owner retains its one publisher and exact begin-handle correlation.
Only cleared observations feed Preview, and acknowledged request records
establish saved turns. Message IDs and response identities do not stand in for
turn numbers. Generated roots use the execution-owned route and admitted ceiling;
failed or unfinished generation is not evaluated as a complete response.

Paired storage keeps chat out of entry History. The writer serializes physical
append and in-memory acknowledgement under one owned turn. Submission binds the
acknowledged entry prefix while holding the shared reservation and checks the
actual draft/readiness again when the entry starts. Stop joins Sidekick work and
does not cancel an entry already admitted on its own terms. A saved identity or
unknown acceptance is not replaced by a new conversation during recovery.

Sessions composes detached entry and Sidekick readings at the root. Actual
provider-key filtering and the `sidekick` chat selector stay distinct. Old-chat
reading keeps its own agent and viewport, exposes no continuation controls and
does no provider work. Entry checkpoint selection freezes entry facts while
Sidekick remains current.

The final presentation changes leave those ownership boundaries intact. Soft
wrapping uses the original message as its editing and submission value, with
revision-based acknowledgement. Value rows are inert; the existing field owns
input. Engine measurements precede admission and commit. Chat, composer and
guidance have separate command-owned fitting stores; reused cuts decorate the
current text rather than authorizing a cached body. Withdrawal and hidden-chat
behavior retain their accepted path.

## Independent focused evidence

All three commands ran from the implementation worktree at the reviewed SHA.
Every first output is preserved; all passed on their first invocation.

| Selection | Result | Complete output |
| --- | --- | --- |
| Core conversation, generated-root host, session setup; ACP host conversation and loaded copy | 22 tests / 94 steps | [Boundary output](pr921-review-d906c636-boundaries-first.log) |
| Sidekick presentation, journey, lifecycle, style, configuration, controls and forms | 75 / 303 | [Sidekick output](pr921-review-d906c636-sidekick-first.log) |
| Ordinary journey, Agent interface/journey, execution, lifecycle, layout admission and source reading | 73 / 225 | [Ordinary output](pr921-review-d906c636-ordinary-first.log) |

Total: **170 tests / 622 steps passed**, zero failures in these selections.
Their logs retain the exact invocations. No full suite, broad typecheck, lint,
JSR, CI or capture was used for this architecture verdict.

## Presentation regressions: Planner follow-up

These violate accepted product behavior, but neither changes execution,
authorization, durable identity, publication, replay or resource ownership.
Under the Architect's structural checklist they do not change the architecture
PASS. They remain ordinary correctness findings for the Planner to disposition.

### 1. The narrow current chat can lose every chat row

At 72x20, select the current chat through Sessions so its `sidekick` selector is
present, then let that Sidekick wait on a question. The normal mounted reading
contains Back, Configure, question announcement/answer, the minimum composer,
working status and Stop. Even with only one value row, the measured chat viewport
has height **0**. The same reading without the question has height **2**.

`program.ts:3515–3520` clamps zero capacity up to one when choosing composer
height. That creates no additional room for chat and does not report the
minimum-composer conflict required by the released plan. The pane draws its
controls and footer while all previous reply text is absent.

The real renderer/presenter probe supplies a valid explicit current-chat route
and pending-question facts. The pending arm fails; its no-question control
passes. This is a layout observation, not evidence from the unfinished separate
mounted-program probe in this directory.

Correction: preserve at least one measured chat row in this supported state,
with question, Send/Stop, drafts and footer still usable. Do not treat a zero
capacity as proof that the minimum fits. If a correction requires changing the
accepted controls or minimum drawable size, return the concrete product conflict
rather than choosing that change in implementation. Add the representative
current-selector/question case to the existing small-screen composer evidence.

### 2. Sidekick padding is also applied to Bindings

`application.ts:7897–7900` wraps the right-hand body in `sidekickBody()`
unconditionally. The `chatColumn()` path also supplies ordinary binding rows,
so selecting Bindings inherits Sidekick's two-cell inset on both sides.

The real presenter reports:

| Frame | Expected Bindings content x / width | Actual binding x / width |
| --- | --- | --- |
| 160x36 | 97 / 63 | 99 / 59 |
| 120x30 | 75 / 45 | 77 / 41 |

The guidance/padding amendment explicitly preserves Bindings' body layout.
PW1's outer column widths pass because this regression is inside the correct
outer column. Correction: restrict the inset and its measured body-width usage
to Sidekick, preserving the unchanged Bindings interior. Add an actual binding
row to the existing both-tab geometry observation.

Both existing targeted probes were read and independently executed together
against this head. The command exits 1: **two tests fail in three steps, and the
one no-question control step passes**. Their first output is preserved in
[the Architect probe log](pr921-architect-display-probes-d906c636-first.log).
The probe sources were not edited:
[Bindings](pr921-bindings-padding-probe-d906c636.test.ts) and
[narrow chat](pr921-narrow-question-capacity-probe-d906c636.test.ts).
These failures are additional to the green focused selections, not hidden by
their totals and not flaky reruns.

## Non-blocking description mismatch

The PR's “Intentionally unchanged” paragraph says there are no journal, route or
provider interface changes and no new URL member or durable record. That fits
the final composer assignment, not the complete PR. This branch includes the
accepted conversation-provider contract, paired chat history and `sidekick=`
selector. Revise that paragraph to describe the whole PR and put latest-increment
exclusions in their own context. No GitHub description was edited by this review.

## Continuity

#890 remains the explicit stack dependency at its reviewed base. #181 remains
open and its overlapping prerequisite work is accounted for in the PR's stated
integration boundary. This review performs no stack integration and bases no
verdict on CI or mergeability. The separate teaching walkthrough, 36-frame
capture packet and delivery checks remain separate work.

Next action: Planner dispositions the two presentation findings and freezes the
bounded correction/evidence. An architecture return is needed only if the
correction changes a settled product or structural contract. No production
source, assertion, dependency, cache, commit or push was changed; no GitHub
comment, review, description or CI operation was performed.
