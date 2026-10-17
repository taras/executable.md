# Replacement PR2 correction: REQUEST CHANGES

Reviewed exact commit `ed20261025ed66da1fe473785a189e8a458af865` on
`agent/issue-883-pr2-main-integration`, parent
`5a3d32bd6209744f0e7b837567fae87bc17b7d57`, integration base
`85da74b938434773d7faf3caa5e2ca007328fdca`, tree
`c34df63b3b7ef0ab8b08bae41729a196e4f961b2`. Signature verifies G /
`tarasm@gmail.com`; the inspected worktree is clean. Neither implementation
line, branch nor fixture was changed. CI was not inspected.

One part of R-E1 remains unmet: the frozen two-live-Sidekick-owner observation.
This is the scenario explicitly assigned by the bounded correction prompt,
not an additional acceptance permutation. The remaining corrections pass
source review against that prompt.

## Accepted corrections

- R-P1: the four new casts are removed. Definitions are compiler-checked;
  offering() supplies typed partial GeneratedForms; canonicalProps narrows with
  isJsonObject; chatKinds checks subprocess values. No replacement cast appears
  in this increment.
- R-E2: canonicalTurns uses parseEntryRecords/parsePromptRecord, identifies
  turn:3 and asserts its own native identity. Preparation/activation records,
  old turns and the old byte prefix are compared; marker and non-repeated-fill
  assertions remain. The fixture and receipt are unchanged in this commit.
- IN6 single-owner evidence: the real entry changes a binding between responses;
  later captured-control reads see the new value. An ordinary failure preserves
  exact per-response ordered pairs. The held-cleanup Stop extension establishes
  the successor control's own response and leaves the stopped fill unfinished.
- Late-interception evidence: R3n installs interception inside the document's
  own execution chain and observes the holding-element lookup while the captured
  control bypasses it. R3o tests an omitted ordinary File component against a
  later selection, rather than a structural-language refusal. These remain
  useful canonical capture regressions.
- E1a actually consumes the document output stream through completion, requires
  the document's text and excludes the root's text from chunks and close value.
  The accepted PR1 production implementation is unchanged.
- The assigned stale comments are corrected. No broader prose or lint cleanup
  is required by this review.

## Remaining R-E1 finding

At `packages/cli/tests/repl-sidekick-controls.test.ts:1746`, R3m calls reply()
for one stub and then calls reply() for the other. The helper at line 267 opens
one HostExecution, evaluates a root, releases its holding element, waits for
canonical completion, and closes its scoped execution before returning. The
second invocation therefore starts after the first capture's lifetime ended.
Neither invocation constructs a SidekickOwner or AgentConversation. Both stubs
also return the same Ada payload; their separate counters prove per-call
closure selection, not simultaneous conversation ownership.

That test proves two sequential canonical host captures use their supplied
handles. It does not prove the accepted requirement that two live Sidekick
owners install and retain different conversation-owned controls. A Sidekick
assembly that accidentally reused the most recently opened owner's controls
while both conversations were alive could pass this helper test, since the
helper bypasses that assembly and never holds both owners open.

The new R5 rows exercise one actual owner, and the Stop extension exercises
successive responses of one owner. They do not supply this missing two-owner
boundary. The prior review already distinguished history-selection two-chat
rows from this observation.

## Evidence examined

The three complete independent logs supplied with this review request report:

| Frozen command | Result | Log |
| --- | --- | --- |
| 1 | exit 0; 50 tests / 278 steps | /private/tmp/xmd-ed202610-command-1.log |
| 4 | exit 0; 36 tests / 130 steps | /private/tmp/xmd-ed202610-command-4.log |
| 5 | exit 0; 32 tests / 170 steps | /private/tmp/xmd-ed202610-command-5.log |

This Planner inspected those logs and the exact committed diff; it did not
launch another redundant run. Commands 2, 3, 6 and 7 remain excused for this
bounded test/typing/comment increment as the prompt specifies. Command 6's
previously recorded EH1/UI10 failures remain red under the exact feedback
exception and remain delivery work. They do not cause this verdict.

## Ready-to-send Implementor prompt

Continue from signed clean `ed20261025ed66da1fe473785a189e8a458af865` in
`.claude/worktrees/issue-883-pr2` on `agent/issue-883-pr2-main-integration`.
Preserve this commit, its parent, accepted PR1, original/safety refs, the old
fixture/receipt and the isolated implementation line. No reset, amend, rebase,
publication, GitHub write, CI inspection or unrelated cleanup.

Close only the existing R-E1 two-live-owner observation. Replace or complement
R3m with one representative scenario through the existing real Sidekick owner /
conversation fixture. Acquire two owners and keep both conversations alive
before evaluating the observation. Give their owned request handles
observably different answers or real REPL facts. Send identical authored control
source through both actual owners and assert each answer/control record belongs
to its own conversation, with no call or record transferred to the other.
Use existing owned fixture lifetimes and an explicit readiness/hold if needed;
sequentially closing one owner before opening the other does not establish
this criterion. Retain R3n/R3o's useful late-interception evidence and the accepted
single-owner failure/Stop rows. No new public testing hook, identity protocol,
authority Context or cross-product of scenarios is assigned.

Place this real-owner observation in the existing journey suite if that best
reuses useHarness(); remove the misleading two-live-owner claim from a retained
sequential helper row. Run frozen command 4 for a journey-suite change and
command 5 if its controls row changes. Command 1 need not repeat for this
fixture/test-only successor. Other commands remain excused unless a concrete
production fix reaches their boundary. Preserve first failures and fix/rerun
assigned evidence before a signed successor. Return exact SHA/parent/tree/
signature, changed scenario mapping and exact command results. Report a concrete
contract conflict if exposed; do not broaden scope to work around one.

No change from isolated `99c27d92` is required by this review. Its null-contract
and stream findings are already addressed on the reviewed line. Its HI1-helper
or lint work has not been reviewed here and is not a reason to expand this
bounded successor. Preserve that branch; no deletion is authorized.

## Continuity

Reviewed SHA: `ed20261025ed66da1fe473785a189e8a458af865`.
Produced artifact: this review and its embedded revision prompt. Accepted:
R-P1, R-E2, stream restoration, comments, and the single-owner/late-interception
parts of R-E1. Remaining: one actual two-live-Sidekick-owner observation from
the frozen matrix. Next Implementor action: complete that bounded test and
return a signed successor with its affected focused results. No production
failure is alleged and no new architecture decision is required.
