# Replacement PR1 correction: PASS

Reviewed 85da74b938434773d7faf3caa5e2ca007328fdca on
agent/issue-883-pr1-main-integration. Parent fdcef4281ac15b059d3db1a4594ffb8972bcd269
is preserved; target is 986948eabd070c0ae7354c2a0db8df7feed63621. The tree is
059bb2670ae09a94637ef7c04d521ac076c86545, signature G / tarasm@gmail.com.
The PR1 worktree is clean. **IP1–IP4 and IE1 are closed. Replacement PR1 is
accepted; the existing integration release now permits PR2 to start on this
exact SHA.** This is implementation feedback, not delivery approval.

## Findings resolved

| Finding | Reviewed result | Permanent evidence |
| --- | --- | --- |
| IP1 — canonical Syntax duplicated | Canonical execution decides the complete selection once. It retains its captured Syntax guard when present and supplies its canonical definition otherwise. The evaluator no longer appends a second copy. Recognition uses protectedOrigin computed by ComponentRouting.project from the exact implementation in the execution-owned WeakMap; it is not a host's declared origin or a name comparison alone. Different definitions still collide. | E8a/E8b, GRM6; unchanged captured-Syntax probe |
| IP2 — availability refusal failed the owner | No profile returns Err(HostExecutionError); class selection happens inside the root's ordinary failure boundary. Expected refusal leaves the main document able to complete. Fatal failure and joined cleanup classifications remain unchanged. | E9a–E9c, existing E7 and conversation failure/lifecycle tiers; unchanged refusal probe |
| IP3 — public request/export mismatch | core/host exports GeneratedXmdRequest with id, source, allow?, position?, and GeneratedEffectClass. The internal table request is GeneratedFragmentRequest. GeneratedXmdRootRequest is removed, without an alias or a second public evaluator. | E9d and typed consumers in command 1 |
| IP4 — added form casts | Both formsOf helpers filter a typed InvocationForm list. Neither new array cast remains. | Typed root/conversation tiers |
| IE1 — marker and old-history gaps | Common legal source and equal retained rows reach the production marker reader in both directions, with zero effects on refusal and matched-marker controls. Old marker-2 sequences remain untouched and unvisited on host opening; the next evaluation writes marker 5 at generated_root:3. | GRM1–GRM6, E6b; existing marker/replay tiers |

GRM's private binder fixture is appropriate for cross-kind authorization:
the public owner's separate sequence allocation deliberately prevents one kind
from reaching the other's admission. GRM3 verifies identical retained rows,
and GRM4 shows both matched-marker arrangements actually perform the work.
The refusals therefore establish the marker check rather than illegal source,
changed tables or an unusable fixture.

E6b and GRM5 use hand-built old-format journals. I compared their admission
shape with 01abab27's admitSource and policyRecord: version 2 at both levels,
context root, ordered structural identities, allowed forms and requests. They
are sufficient for the assigned old-marker refusal and sequence-partition
observations. They are not run-produced compatibility evidence, and this review
does not describe them as such. PR2's separate IN5 requirement still calls for
a paired-chat fixture produced by the pre-integration writer at C.

The other correction edits are the public type rename, formatting and prose
alignment. They preserve the reviewed owner, journal, fatal failure and
captured selection boundaries. The documented lint repairs do not change the
frozen acceptance criteria.

## Independent verification

All commands below ran once against the exact reviewed SHA. Every command
exited 0; no failure was retried. Command 5 ran with local loopback access for
its assigned HTTP fixture.

| Command | Tests / steps | Complete first output |
| --- | --- | --- |
| 1 | 31 / 141 | [log](pr890-replacement-review-85da74b9-command-1-first.log) |
| 2 | 34 / 266 | [log](pr890-replacement-review-85da74b9-command-2-first.log) |
| 3 | 14 / 143 | [log](pr890-replacement-review-85da74b9-command-3-first.log) |
| 4 | 24 / 160 | [log](pr890-replacement-review-85da74b9-command-4-first.log) |
| 5 | 8 / 33 | [log](pr890-replacement-review-85da74b9-command-5-first.log) |
| Both unchanged review probes | 2 / 5 | [log](pr890-replacement-review-85da74b9-probes-first.log) |

The five frozen selections total **111 tests / 743 steps, zero failures**.
The probes independently show canonical Syntax succeeds, unavailable calls
refuse while their documents complete, and the available control succeeds.

```sh
deno task test packages/core/tests/host-generated-root.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts
deno task test packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/generated-selection.test.ts packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts
deno task test packages/core/tests/execution-protocol.test.ts packages/core/tests/document-output-api.test.ts packages/core/tests/syntax-component.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/syntax-loaded-copy.test.ts
deno task test packages/core/tests/agent-components.test.ts packages/core/tests/agent-function-components.test.ts packages/core/tests/agent-session-launch.test.ts packages/acp/tests/host-conversation.test.ts packages/acp/tests/loaded-copy.test.ts
deno task test packages/workflow/tests/generated-observations.test.ts packages/cli/tests/evaluate-component.test.ts packages/cli/tests/evaluate-workflow.test.ts
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr890-captured-syntax-probe-fdcef428.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr890-root-refusal-probe-fdcef428.test.ts
```

The Implementor reports check, lint and docs validation passing. This review
did not repeat those checks or inspect CI. No new mutation battery was required;
the correction's recorded controls and the unchanged reviewer probes suffice.

## Continuity and next action

Original PR1 remains 79d404d0; original PR2 remains accepted C
d4b0e326d76fa63c6ee7a97e189986bbd371243d with a clean worktree. The C preservation
ref and both older safety refs are intact. This review changed no implementation,
branch, dependency state or remote ref.

Use the [updated integration prompt](pr890-pr921-main-integration-implementor-prompt.md)
to start replacement PR2 from 85da74b9 in its owner's worktree. Keep the existing
Architect decision, IN1–IN8 matrix and seven PR2 commands. EH1/UI10 retain only
the exact baseline feedback exception in the release; their delivery obligation
is unchanged. Other UI decisions, Parse #922, teaching, captures, publication
and CI remain separate. No new approval is needed for this already released
second phase.
