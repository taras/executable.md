# PR #890 Planner correction — REQUEST CHANGES

Resolved in the [Planner PASS at 79d404d0](pr890-planner-review-79d404d0.md).
The historical finding and evidence at `05d03afb` below remain recorded.

Reviewed head: `05d03afb0ff1356707f66f2f1b741a5d8ec6ba95`.
Base: `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`.
This supersedes the Planner PASS for Core PR 1 and PR #890 at this revision.

The Architect finding is confirmed. Core refuses the already-approved
`Let select="code"` capture followed by
`<REPL.EntryInput>{code}</REPL.EntryInput>`. The initial response environment is
empty, but the response can create and use its own lexical bindings. Entry-only
references inside captured passive source remain literal entry text. This
contract is already stated in the handoff's worked example and accepted agent
instructions; restoring it adds no product decision.

The Planner review accepted GR17's blanket root interpolation refusal without
checking it against that worked example. The original C1 evidence row omitted
the draft-fill boundary, so passing those selected cases did not prove that the
CLI consumer could use the Core seam. C1 now explicitly includes the missing
accepted flow. The earlier cancellation and native-identity findings remain
closed; C2 and C3 are not reopened by this correction.

## Reproduced evidence

At the exact head, with the reviewed worktree clean, Planner ran the Architect's
unchanged probe:

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr890-passive-draft-probe.test.ts
```

| Case | Observed |
| --- | --- |
| Literal draft fill | Pass; receives `Hello` once. |
| Passive `Hello` capture followed by local `{code}` | Admission refusal; receives nothing. |
| Accepted Each/greeting entry with entry-only references | Admission refusal; receives nothing. |

Both failures report `a generated fragment reads a binding through
interpolation, which it may not.` The host execution succeeds in all three
cases. The existing 20 tests/91 steps still provide their recorded evidence;
they do not cover this contract. The original behavioral output is retained in
[the Architect probe log](pr890-passive-draft-probe.log).

## Correction and feedback threshold

Apply [the Architect correction prompt](pr890-architect-review.md#next-agent-prompt)
in Core. Generated-root evaluation must extract the literal passive entry
source and pass it exactly once to the pinned paired receiver. Response-local
binding use follows the accepted generated grammar and lexical environment;
entry braces and nested passive fences remain literal, and no entry component
runs during response evaluation. Whole-source admission still precedes effects.
Ambient bindings, JavaScript, executable response fences and unpinned resolution
remain unavailable. The CLI supplies no workaround or substitute evaluator.

Replace the blanket-root refusal evidence and conflicting prose. Keep a
literal-fill control, the simple captured string and the accepted entry-only
binding example, including nested passive fences. These are the finite C1
observations restored by the Architect finding. Preserve released fragment
behavior and records, root/fragment admission separation, and existing forbidden
response execution tests.

Run the handoff's focused generated-root/preview/conversation row and
released-fragment/composition/profile/expansion/source-inspection row. Include
known affected scanner/parse regressions if that boundary changes. Conversation
and canonical ACP behavior remain accepted; rerun their affected integration
row if the correction changes that boundary. Commit after the selected evidence
passes, and return the exact stable SHA, parent, commands/results and corrected
criterion mapping for review.

## Continuity

Produced correction: `.reviewer/issue-883/pr890-planner-correction.md`.
The handoff's Core instructions and C1 evidence now explicitly cover this flow;
README and old verdicts identify the current REQUEST CHANGES status.
No architecture decision remains open. The Implementor corrects Core PR #890
before CLI PR 2 consumes its revised accepted feedback commit. No production
code or GitHub state was changed by this Planner correction.
