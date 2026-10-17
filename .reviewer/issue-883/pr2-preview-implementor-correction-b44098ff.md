# Correct Preview correlation and complete its frozen evidence

**Continued at f8b4e035, 2026-10-14:** the original collision, held-controls/
parse-withdrawal and observing audit/checkpoint findings are closed.
[The latest review](pr2-preview-planner-review-f8b4e035.md) keeps failed-settlement
identity and the held failure-return observation open. Execute
[the narrow correction](pr2-preview-implementor-correction-f8b4e035.md) from
that signed head; do not restart this completed portion at b44098ff.

Correct the reviewed streamed-Preview slice from signed clean
`b44098ffd18ebc2bb7f6f46a38a3f09a55889959`, parent
`815233183c7c26cd40544347191b7ba5e1f975c3`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Verify HEAD/tree, preserve the signed commits and unrelated work, and reconcile
any advancement without reset, amend or discard. Follow .agents/implementor.md.

Read these main-checkout records fully:

- `.reviewer/issue-883/pr2-preview-planner-review-b44098ff.md`
- `.reviewer/issue-883/pr2-section5-preview-planner-handoff.md`
- `.reviewer/issue-883/pr2-section5-preview-architect-decision.md`

The verdict is REQUEST CHANGES. PV-P1 is a reproduced violation of the settled
response/turn correlation contract. PV-E1 names incomplete observations already
frozen in PV1/PV2/PV5. No new product or architecture ruling is needed.

## Required correction

1. Remove the inference in program.ts that a failed saved turn N belonged to
   `response:N`. The response registered before prompting and Core's saved turn
   are independent facts. Bind the live slot to the actual acknowledged attempt
   using its existing response registration and bounded request association.
   Keep any alias process-local as the Architect allows. Cold failed items must
   have truthful distinct keys without deriving a response identity from a turn
   number. Preserve one item/node across the live transition.
2. Preserve both the earlier successful reply and later failed attempt in the
   reproduced history. Do not deduplicate away either item, rewrite history,
   restart numbering, guess a missing association, change the renderer validator
   or add a durable mapping/record. Keep Retry's saved message association and
   failure/Incomplete semantics intact. Keep raw source/handles out of UI facts.
3. Run this probe unchanged and promote its regression/control into the existing
   mounted PV tier. It stops a held first generation, exits, reopens cold, sends
   a successful message and then a failed successor. Current source crashes with
   DUPLICATE_ID; the same sequence without the unacknowledged first message is
   green. The preserved baseline is sufficient discrimination; no new mutation
   matrix is required for PV-P1.

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-correlation-probe-b44098ff.test.ts
```

## Complete PV-E1 in the existing scenarios

- In PV1, hold after complete candidate controls have actually arrived but before
  provider completion. Check no control pair, fill or entry there. Currently the
  no-effects assertions precede the piece containing the controls. Keep the
  separate held response-evaluation stage and real ordered feedback assertions.
- Observe actual item/node identity across Preview and acknowledged reply or
  Incomplete. The current one-response-record count and text assertions are not
  this observation. Reuse the existing mounted/presentation fixtures and the
  production detached composition. Factoring that composition into a testable
  CLI-local helper is permitted; no new host/debug callback API or second UI
  tree is assigned. If the existing fixture cannot expose the observation, return
  that concrete seam conflict before widening a production surface.
- In PV2, hold the invalid final prefix before the provider settles and observe
  Preview withdrawal then. The current assertion after the response record can
  be satisfied by evaluation's later refusal instead.
- In PV5, hold the provider's own cleanup when observe throws. Show no failure
  return or fabricated publication while cleanup remains held, then release and
  assert the existing authoritative host-failure result. Keep the synchronous
  cleanup observation as a consequence, not the proof of a join.
- In PV5's nonthrowing observing control, exercise a real permission request and
  assert its retained audit plus the actual checkpoint publication association,
  with the same begin handle and exactly one append. Reuse the direct turn/audit
  fixture; preserve DP2/DP4 and ordinary nonobserving publisher assertions.

These are bounded extensions of the assigned rows, not new behavior or a new
parser/policy/settings matrix. Extend existing gates/fixtures only as necessary,
and report adaptations. Keep authentic disclosure, accumulated-prefix scanning,
exact return, immutable view ownership, inline consumption, host-failure routing,
Stop/entry independence, preferences and canonical acknowledgement unchanged.
Align only prose made inaccurate by the correction.

## Evidence and feedback commit

The substitution of PV2 for PV1 as the deterministic no-input wake-mutation
witness is accepted. Do not add another wake test, claim PV1 also discriminates,
or repeat the three mutations unless their actual connections change. The
existing parent failure plus passing corrected probe supplies PV-P1's broken
baseline. The frozen ten commands remain assigned; run them after the final
edit and preserve first failure output. Keep every previous accepted assertion.

The Planner independently passed nine selections but hit npm EPERM installing
embedded adapters in command 4; its first log is preserved in the review. Do not
repair shared caches, dependencies or production code on account of this review
environment. Report your actual command result. U2 did not recur; unrelated
flake repair remains outside scope.

Once the focused probe, completed frozen observations and ten commands pass,
commit promptly with signing enabled and return exact SHA/parent/branch,
signature, clean/untracked status, every command/result, PV-P1/PV-E1 mapping and
adaptations. Continue to that signed handback with progress updates rather than
ending after files/rows; stop early only for a concrete contract conflict.
No full-suite/check/lint/JSR, packaging, CI or capture prerequisite is added.

Configure/Retry and all prior acceptances stay closed. No Core/public provider
API redesign, journal grammar, Sessions work, complete terminal/capture packet,
main-checkout production edit, dependency change, push, GitHub mutation or CI
inspection. The next action is this correction from b44098ff, then Planner review
of its signed feedback SHA; the Preview slice remains unaccepted meanwhile.
