# Core PR 1 revised Planner review — REQUEST CHANGES

Reviewed commit: `2765a76be0916e1d7ae0201345eb7fe7b861ad2e`.
Parent: `d45bbfc6b4857684e4d51dc710837bb2f8bfa0a5`.
Stack base: `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`.
The reviewed worktree is clean.

P1 is resolved. The new caller cleanup waits for the worker's completion
acknowledgement, and busy remains set through that wait. The acknowledgement
cleanup is registered before spawning the turn. CV18/CV19 pass, and the
reviewer's original held-teardown probe passes unchanged.

P2 is partly resolved. CV21 now proves an established native identity mismatch
refuses before sending the next prompt. CV23/CV24 cover late conflicting
identity and inconsistent retained identities. The remaining blocker is the
original C3 pre-mapping reconciliation evidence. CLI PR 2 still waits for a
passing Core review. C1/C2 remain accepted from the first review and passing
focused evidence.

## Remaining P2 finding — CV22 does not interrupt mapping acknowledgement

At `packages/core/tests/agent-conversation.test.ts:782`, CV22 awaits a successful
`chat.prompt("first")`, closes its owner, and reopens with a stub configured to
return the same native id. The first Prompt is already completed and retained.
The stub has no mapping acknowledgement operation to hold or fail. The absence
of a mapping record in this stub is therefore not evidence of interruption
between provider acceptance and mapping acknowledgement.

As a corroborating check, CV22 also passes against the previous `d45bbfc6`
conversation implementation, using the revised test fixture. That implementation
does not read or compare retained native identity. This is not, by itself,
evidence of a production failure; it confirms that CV22's success does not
establish the new reconciliation claim.

The actual boundary is already defined by the canonical provider. In
`packages/acp/src/provider.ts`, `materialize()` observes the adapter's acceptance
and provider-store promotion, then calls `sessions.established`, then marks the
live session established. If acknowledgement fails, the provider's assertion
survives while the handle is abandoned. `packages/acp/tests/provider.test.ts`
SM9 demonstrates this window with `refuseFirstRetention: true`.

That window can occur before a successful canonical Prompt record exists.
Reading `agentSessionId` from completed Prompt records is useful for retained
turn comparisons, but does not demonstrate recovery from the earlier provider
assertion. The accepted C3 row and previous revision prompt require that
specific distinction, not another completed-turn reopening test.

Add one representative test through `useAgentConversation`, using the canonical
provider path with an injected transport/assertion fixture. Make acceptance
establish the provider's native identity, then interrupt or fail mapping
acknowledgement. Show the provider assertion survives, release the first owner,
and reopen against the actual retained state. Explicit new work must reconcile
to the same native identity, or refuse truthfully if its canonical facts cannot
establish it, without resending the accepted first prompt or creating a
replacement. Keep claimant issuance internal. This is the existing C3 scenario;
it does not require the CLI's fresh-process recovery battery or new architecture.

The production implementation may already satisfy this through its installed
canonical provider. The missing proof must determine that; change production
code only if the discriminating scenario reveals a defect. Update the handback
mapping and explanation accordingly.

## Reviewer evidence

At the exact revised feedback commit:

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts
```

**19 tests, 88 steps passed.**

Original cancellation probe, unchanged:

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr1-cancellation-probe.test.ts
```

**1 test, 1 step passed.**

Isolated CV22 with the parent conversation source, performed in scratch files
without changing the worktree:

```sh
deno test --allow-all --frozen --config deno.json /private/tmp/issue-883-cv22-control.test.ts
```

**1 test, 1 step passed.** The unchanged control inputs are archived as
[pr1-cv22-control.test.ts](pr1-cv22-control.test.ts) and
[pr1-cv22-parent-conversation.ts](pr1-cv22-parent-conversation.ts).
Their imports preserve the tested local paths; the control imports the parent
source at `/private/tmp/issue-883-old-conversation.ts`.

The remaining focused regression commands, touched-boundary tests, docs,
oxlint and formatting are reported passing by the Implementor. This review did
not repeat them or inspect CI. The reported negative controls and recovery from
the discarded local edits do not alter the verdict on this exact commit.

## Ready-to-send revision prompt

Revise Core PR 1 from `2765a76be0916e1d7ae0201345eb7fe7b861ad2e` against
`.reviewer/issue-883/pr1-planner-review-2765a76b.md`. P1 and the established
native identity mismatch evidence are accepted; retain those fixes and tests.
Complete the one remaining frozen C3 scenario: provider acceptance/assertion
before mapping acknowledgement, exercised through `useAgentConversation` and
the canonical provider path with an injected fixture. Use the actual ordering
shown by ACP provider SM9; a normally completed Prompt followed by reopening is
not that boundary. Prove same-identity reconciliation or truthful refusal, no
accepted-prompt resend and no replacement. Correct production behavior only
where this scenario exposes a defect. Update the handback to cite that evidence.

Run the handoff's three focused Core commands and any affected explicit
regressions. Commit promptly after they pass and return the exact SHA, parent,
commands/results and corrected criterion mapping for Planner review. PR 2
starts after Core acceptance. This revision authorizes no GitHub write or memory
restructuring.
