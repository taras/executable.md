# Finish the accepted Sidekick feedback receipts

Completed and accepted at `2fddcf6b49859e630fc21ec3372a6bd765fb415c` in the
[Planner review](pr2-feedback-planner-review-2fddcf6b.md). R1/R2 are closed.
The instructions below record the completed correction. Continue with the main
handoff's remaining section 4 work; do not repeat these fixes.

Correct `f5b60c9957e7cc08ef0748e7144425d4b9921ee2`, parent
`97f8cb794752bc89047cea13d618aba8bce28be2`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.

The [review](pr2-feedback-planner-review-f5b60c99.md) closes the original missing
designations and pre-reservation refusal path. Preserve those fixes, the shared
designation source, per-control successful rendering, response loop, Output-only
chat and canonical delivery proof. Two receipt requirements from the previous
assignment remain. No new product or architecture decision is required.

## R1: distinguish an entry failure from refusing admission

An admitted entry may settle with a failed Result. Keep that durable Result and
its safe diagnostic. Its Submit intent and retained terminal observation also
establish an actual entry outcome, so the derived feedback must deliver that
entry's failed completion/read receipt without labeling it REPL.Submit refused.
Use those retained facts to distinguish the two cases before the batch formatter
chooses failure wording; do not infer the distinction from rendered prose.

A failed entry names the actual entry, its failure reason and that entry's read
instruction. A refused submission says REPL.Submit refused and names no fabricated
admitted entry. Preserve the existing behavior for a refusal both before and
after reservation, successful completion, exact-entry joining and authoritative
fatal failures. Do not change admission ordering, journal grammar or the retained
entry failure into a success merely to suppress the false prefix.

## R2: fence JSON inside a mixed feedback batch

Preserve whether a designated result is a JSON value or canonical text through
batch rendering. For several results, keep short headings in admission order
and put each JSON value in a fence longer than any backtick run in the serialized
value. Canonical chapter, syntax and environment text keeps its formatting;
do not wrap all strings or guess their kind by trying to parse rendered text.

A single Bindings result remains the raw detached JSON object, directly parseable
without a heading, fence or envelope. Several results require the accepted JSON
fences. No provenance, correlation IDs, status or wrapper becomes a binding.
Use the existing formatter ownership; no new component catalogue or persistence
family is needed.

## Finite evidence and feedback

Integrate the [receipt probe](pr2-feedback-receipt-probe-f5b60c99.test.ts)'s two
regressions and refusal control into the existing owner journey tier. Its
[first output](pr2-feedback-receipt-probe-f5b60c99-first.log) is preserved.

1. A real entry is admitted and fails ordinarily. Assert its actual err terminal,
   cleared admitted draft, failure reason and exact-entry read receipt on the
   next canonical turn, with no REPL.Submit refused claim. The fixture uses
   literal capture and the ordinary entry compiler/session, not a fabricated
   terminal or retained receipt.
2. A real entry publishes a JSON binding containing a triple-backtick run.
   Bindings plus Environment returns the actual map under the first heading
   in an adequate fence, then the canonical Environment text. Parsing the fenced
   JSON recovers the published value. Keep the existing single raw-map row green.
3. Empty-draft Submit still reaches the next turn as an explicit refusal and
   creates no entry or reservation. Preserve the original four regressions,
   Guide control, successful completion and prior owner-failure evidence.

This restores the already assigned entry/refusal distinction and JSON presentation;
it adds no permutation matrix, terminal work or interruption-boundary claim.
Align any affected specification/architecture wording with the actual distinction
and mixed-result formatting.

Run from the implementation worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-receipt-probe-f5b60c99.test.ts
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-contract-probe-97f8cb79.test.ts
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts
deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts
```

These are the frozen feedback commands for this remaining correction. The earlier
consumer command already passes at f5b60c99; repeat it only if the correction
changes a session, admission, output-read or other boundary those consumers use.
No full suite, CI inspection or terminal rerun is assigned.

Commit promptly when focused evidence passes. Hand back the exact signed SHA and
parent, every focused command/result, worktree state and remaining incomplete
work. Stop for Planner review before proceeding. No push or GitHub mutation is
authorized.

Exact correction base is f5b60c99. Produced artifacts are this prompt, its linked
review/probe/output, passing focused logs and updated planner-handoff.md. R1/R2
above remain blocking. Stop, Elicit, configuration, metadata refresh, program
binding, interruption cases 2/5/6 and section 5 remain outside this correction.
