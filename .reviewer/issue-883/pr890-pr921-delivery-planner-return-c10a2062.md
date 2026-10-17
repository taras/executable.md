# Delivery planning review: accepted; merge execution remains blocked

2026-10-16. The replacement branches are rebased and published according to
[the Implementor handback](pr890-pr921-delivery-implementor-handback.md).
No new product or architecture correction is assigned. Continue with protected
bottom-up delivery after the reported automatic-review barrier is resolved.
The Planner only reviews and maintains this plan; it performs no PR-state,
publication, branch or merge operation.

## Exact observed revisions and evidence limits

Read-only local verification establishes:

- PR1 integration head: `dbc0fc92886ea7ad0b294e3a0f4277ff2bcbc998`, signed G.
  Parent `cc652f695986f73b9162cefe0fb29e257f82b4f0`, based on
  `fd8ae5214b3994e6ec32061e41783a386368b7fc`. Its owner worktree is clean.
- PR2 integration head: `c10a20622461663c4f4ceb06c51687dabc0bab71`, signed G,
  parent `d8890e4018e1ef460b840b18b3b914e99aac729c`.
  No tracked changes remain in its owner worktree. The intentionally retained
  `xmd-troubleshooting-recommendations.txt` is still untracked; leave it alone.

The handback reports both published heads match these revisions, each with
43 passing checks and composability skipped, aggregate green passing and CLEAN
merge state. It reports strict green as the required check and zero required
approvals. These are reported remote observations, not a fresh independent
GitHub/CI inspection by this planning review. The Implementor must re-read
heads and applicable requirements immediately before an executable merge.

Reported local evidence: PR1 five selections 111 tests / 743 steps; PR2 seven
selections plus the eight main-supplied consumers total 314 / 1,482. Each PR's
check, lint, docs and JSR gates pass. Runtime-specific CI repairs were verified
on the failing runtimes. No test or CI command was repeated in this planning
turn. Prior exact-commit feedback acceptances remain recorded separately.

## Reviewed delivery changes

Read the full eight-file delta from rebased Configure head fd62f65f through
c10a2062. The changes fit the authorized delivery reconciliation:

- Whole guidance/caption/reason readers reconstruct wrapped text instead of
  assuming one row. Expected complete sentences remain required, including
  EH1/UI10 and the related UI11/UI13 claims.
- The independent terminal rectangle table states the accepted 36-cell sidebar
  and equal remaining pane shares at wide and medium.
- PTY checks retain complete non-space tokens across bounded adjacent rows;
  they explicitly relinquish spacing, not token completeness. Runtime-only
  provider refusals use the same reader.
- Startup/admission observations wait for the frame carrying the settled fact;
  the required focus and cleared-draft outcomes remain.
- AgentConversationProvider gains the explicit public Context annotation JSR
  requires, with the same payload, context name and default.
- The retained-repository import is reformatted after the module rename.

The handback also accounts for main's capability/install/profile integration,
the successor imports, signatures, preservation refs and range-diff. No new
persistence format, control capability, failure policy or UI feature is
introduced by these delivery fixes. No additional architecture return is
needed on the presented evidence. This acceptance is not an assertion that
this planning turn independently reproduced the delivery battery.

## Remaining sequence for the existing Implementor

1. Resolve the reported merge-execution barrier through the authorized review
   or human merge process. Preserve the exact rejected operation and stated
   reason in the handback. The report says automatic approval review denied
   GitHub's asynchronous REST merge as a merge without review. Repository rules
   allowing zero approvals do not override that separate approval decision.
   Do not switch tools/endpoints, use admin flags or retry a disguised operation
   to evade the denial. A human can merge #890 through the normal protected
   workflow, or the applicable approval/review barrier can be satisfied before
   the same authorized operation is retried.
2. Merge #890 only after re-reading its exact head, current main and current
   required checks/reviews. Expected published head is dbc0fc92. If the head
   changed, account for it rather than merging the historical observation.
3. Record the actual #890 merge SHA. Keep only PR2's own delta when reconciling
   it onto that main history, including after a squash merge. Preserve all
   accepted UI corrections and source refs. Do not replay PR1 as PR2 work.
4. Retarget #921 to main and mark it ready. If rewriting is needed, keep the
   commits signed, use an explicit freshly observed remote-SHA lease and rerun
   affected integration checks. Do not repeat completed checks solely for
   confidence when no changes or unresolved concern justify it.
5. Obtain #921's own main-target required verdict on its actual final head.
   Its current stacked green does not replace the main-target verdict. Strict
   base requirements and main health remain authoritative. Resolve attributable
   failures under the existing delivery assignment.
6. Merge #921 through the normal protected workflow only when that exact head
   and all applicable checks/reviews permit it, subject to the same automatic
   approval boundary. Return PR URLs, final heads, required-check/run links,
   actual merge SHAs and any remaining gate precisely. Do not declare delivery
   complete while either merge or required gate is outstanding.

The earlier final delivery handoff remains the authorization and full contract;
this return replaces its obsolete “begin rebase” starting action. The same
Implementor owns execution. No new writer or feature assignment is released.

## Carry-forward records and scope

Keep the known L2 flake open. Carry its first failure, same-revision rerun and
runtime into its dedicated flake tracking issue as AGENTS.md requires; a green
rerun is not a repair. Link the existing issue or create/update it within the
authorized delivery tracking work. The Windows download failure is reported as
infrastructure; do not call it a product fix. Repeated failures alone do not
prove determinism, so describe the repaired focus/admission readiness defects
by their observed boundary and actual fix rather than that inference.

#928–#933, History stacking, conversation labels, narrow pending-question
layout, Parse #922, unfamiliar-agent teaching and the 36-frame packet remain
outside this delivery. REPL.EntryTrace remains proposed. Entry 22's missing
file cause is unproven. No source file, implementation ref, PR or CI state was
changed by this planning review.
