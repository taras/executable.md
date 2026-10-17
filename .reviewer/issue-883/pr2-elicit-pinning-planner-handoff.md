# Admit canonical paired Elicit in Sidekick responses

Factory completed and accepted at `32fc3c2a8065b5dd84000a4430f88035455d9fb4`
in the [Planner review](pr2-elicit-pinning-planner-review-32fc3c2a.md). The
factory instructions below record completed work. Owner/provider integration
is also accepted at `3d363e38977cbfe548f4d4b8f89f67a59b1da232` in the
[owner review](pr2-elicit-owner-planner-review-3d363e38.md). Continue from
3d363e38 with section 4 configuration and remaining R2 evidence. Mounted
question drawers and complete R6 remain section 5 work.

Use this handoff now that the metadata delivery correction is accepted at
`8b45ee24b254697b72e4479ef7f47a78c9c57f1d` in the
[Planner review](pr2-metadata-planner-review-8b45ee24.md). It resolves
the missing Core factory reported at `c5bec4583b9c60ef68f2c52a84fa4e8d298a7dad`.
The exact implementation base is 8b45ee24, branch `agent/issue-883-pr2` in
`.claude/worktrees/issue-883-pr2`. Continue from this accepted head.

## Ruling

Proceed with `pinnedElicit(): GeneratedMutation` in Core's existing
generated-xmd.ts and export it from the trusted `@executablemd/core/host` surface.
This is the missing constructor for a capability already granted by the accepted
response table in remaining-architecture.md, part 1. It follows the canonical
factory mechanism already used for File. It adds no request member, conversation
method, provider authority or new response permission. No new architecture or
product decision is required.

The fragment entry and generated mutation are different shapes. Do not cast
elicitWriteEntry into a GeneratedMutation or expose CORE_REGISTRY to the CLI.
Do not create a CLI component named Elicit, copy its function body, or resolve it
through a replaceable component-answer chain.

Use Core's exact canonical Elicit definition with paired form. Reuse the retained
identity's actual origin, key and revision from the canonical machinery.
elicitWriteEntry() calls coreEntry(ELICIT_COMPONENT, ELICIT_COMPONENT,
"elicit:ask"): its retained key is Elicit, while elicit:ask is the capability
label. Do not invent a different retained key or a legacy alias for this factory.
The fragment entry and its existing behavior remain unchanged.

## Implementation and focused evidence

Deliver the factory as a focused Core feedback commit before the rest of the
owner's Elicit integration. Its concrete consumer is the Sidekick response
ceiling in the next increment. Keep documentation on the trusted host surface
consistent with this canonical paired grant. No new ordinary-core export is
needed.

Extend generated-xmd-root.test.ts using the existing held execution and canonical
Elicitation seam. The finite factory evidence is:

1. A paired canonical Elicit with a complete schema asks the installed provider
   once, validates its answer and makes the structured value available through
   ordinary `as` capture. Evaluate through the bound execution root operation.
2. Self-closing Elicit refuses complete-source admission before an earlier
   counted component or a provider question runs. Do not change fragment forms.
3. A same-name replacement cannot answer the pinned generated invocation; the
   canonical component still reaches its installed Elicitation provider. Reuse
   existing substitution fixtures where appropriate.

Run the affected Core evidence:

```text
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/elicit-component.test.ts
```

The released-fragment rows are the compatibility evidence. No full package suite,
runtime matrix, new dependency, CI check or packaging build is assigned. Commit
as soon as this focused evidence passes and return the signed SHA, parent,
commands/results and worktree state for review.

## Owner integration remains the next increment

After acceptance, add that canonical mutation to Sidekick's per-response ceiling
and derive its surface from the admitted table. Install the Sidekick-owned
Elicitation provider through the existing mechanism in the conversation owner's
execution lifetime, independently of the entry's question owner. Use Core's
schema preparation, validation, durable answer and ordinary capture mechanisms.
Do not add a second question journal or a CLI implementation of Elicit.

The existing R6 evidence still governs valid, invalid and partial answers,
drawer/tab ownership, simultaneous entry and Sidekick questions, and Stop joining
the response question without inventing an answer. The designated validated
answer and follow-up stay under the accepted feedback contract. A factory alone
does not close that integration or its terminal evidence; section 5 owns the
mounted question drawer, Exit and Control-C.

Produced artifact is this handoff, linked from the metadata review and main
planner-handoff.md. The public factory choice is resolved and the metadata
delivery finding is closed. Configuration, R2 cases 2/5/6 and section 5 remain
incomplete. No push, GitHub-write or CI authorization is added.
