# Integrate the two Sidekick PRs onto captured generated selection

**Integration feedback complete, 2026-10-16:** replacement PR1 remains PASS at
85da74b938434773d7faf3caa5e2ca007328fdca; replacement PR2 is
[PASS](pr921-replacement-planner-review-7613cddf.md) at
7613cddf4f8478b905d6a56d67fb0aa9a2588d25. The final two-live-owner observation
is closed with independent commands 4/5 at 69 tests / 301 steps. All bounded
integration findings are closed. Preserve the clean accepted heads, original
refs and backups; no duplicate feedback commit is needed. The reporting
Implementor is the designated next worktree owner and other sessions hold edits.
Queued UI decisions and delivery remain separate. Earlier start/correction
instructions below are historical where superseded.

**Latest feedback, 2026-10-16:** replacement PR2 at ed202610 has
[one remaining evidence correction](pr921-replacement-independent-review-ed202610.md):
observe two actual Sidekick owners with overlapping conversation lifetimes.
R3m currently exercises successive HostExecutions. All other bounded findings
are closed and independent commands 1/4/5 pass 118 tests / 578 steps. The
[continuation prompt](pr921-replacement-correction-prompt-ed202610.md) freezes
one real-owner journey and affected commands. The matrix, accepted PR1 and exact
EH1/UI10 exception are unchanged. No port restart or queued UI work is released.

**Current feedback, 2026-10-16:** PR1 remains PASS at 85da74b9. Replacement PR2
5a3d32bd6209744f0e7b837567fae87bc17b7d57 is
[REQUEST CHANGES](pr921-replacement-planner-review-5a3d32bd.md). Its selected
Elicit and run-produced old-chat fixture conform; four new casts and remaining
IN5/IN6 evidence need correction. The Planner assigns the lost stream-consumer
assertion to existing E1a on this PR2 successor, preserving the accepted PR1
parent. The [bounded prompt](pr921-replacement-correction-prompt-5a3d32bd.md)
names the next action and commands 1, 4 and 5. The finite architecture/matrix
and exact EH1/UI10 exception remain unchanged; earlier start instructions are
historical where superseded.

Preserve saved chats and the accepted Sidekick behavior while moving #890 and
#921 onto main's component capture and live authorization model. Evaluation
supplies source; its owning execution already holds the exact controls. Roots
write marker 5 and fragments retain main's marker 4.

The [Architect decision](pr890-pr921-main-integration-architect-decision.md)
settles the interfaces and compatibility policy. This plan freezes the two
replacement revisions and finite evidence. **Implementation is released by
[the exact-base release](pr890-pr921-main-integration-planner-release-d4b0e326.md).**
Replacement PR1 is accepted; proceed to PR2 on its exact accepted SHA below.
This is a re-implementation on new branches; do not rebase the original stack.

**Current feedback, 2026-10-16:** replacement PR1
85da74b938434773d7faf3caa5e2ca007328fdca is
[PASS](pr890-replacement-planner-review-85da74b9.md). IP1–IP4 and IE1 are closed
with independent five-command evidence of 111 tests / 743 steps and unchanged
probes at 2 / 5. The existing release's review gate is satisfied. Execute the
[updated prompt](pr890-pr921-main-integration-implementor-prompt.md) to create
replacement PR2 from that exact SHA in its owner's worktree, preserving C and
the original refs. The decision and finite matrix remain governing. Earlier
PR1 correction and queued-release instructions below are historical.

The release satisfies the start requirements, records C's preservation-ref requirement and
owner coordination, and explicitly excludes only the documented EH1/UI10
baseline truncations from integration feedback acceptance. Run/report their
command without skipping or weakening them. All earlier queued/gate updates
below are historical where superseded by the release.

**Accepted C, 2026-10-16:** the submission correction is now
[PASS](pr921-historical-identity-planner-review-d4b0e326.md) at signed clean
d4b0e326d76fa63c6ee7a97e189986bbd371243d, parent f83e3554. The production and
HI-P1/HI-E1 evidence findings are closed. The earlier in-flight inventory and
unaccepted-C entries below are historical. Remaining release work is the target
recheck, owner-worktree coordination and explicit disposition of EH1/UI10's
known baseline failures; those commands are not silently treated as passing.
No submission implementation remains and no branch move is released here.

**Gate update, 2026-10-16:** the independent correction is now committed as
f83e35549dcddad0791f9492b8cdfe56dd7b4bf1, clean, but its
[review](pr921-historical-identity-planner-review-f83e3554.md) requests a small
test/evidence successor. C is not yet accepted. The original work-in-flight
inventory below is historical; do not recover or reset that earlier state.
The review also records baseline EH1/UI10 failures in repl-entries.test.ts.
They predate f83e3554 but are not proven to predate this PR. Their separate
disposition must be explicit when finalizing the integration release; the
IN8 commands are not silently declared green by accepting the submission fix.

## Applies to and start gate

This applies to both PRs and their existing worktree owners. Follow the
implementation checkout's AGENTS.md and .agents/implementor.md. Read the
Architect decision completely, then affected architecture and specifications.
Use committed source for comparisons; the root checkout has unrelated edits.

| Reference inspected on 2026-10-16 | Exact SHA/state |
| --- | --- |
| Target origin/main | 986948eabd070c0ae7354c2a0db8df7feed63621 |
| Reviewed PR1 | 79d404d04d02c3840892473b6f1b2cf540f3edd1; clean |
| Accepted PR2 source C | d4b0e326d76fa63c6ee7a97e189986bbd371243d; signed clean; submission correction PASS |
| Existing PR1 safety ref | pre-rebase/issue-883-pr1 at 79d404d04d02c3840892473b6f1b2cf540f3edd1 |
| Existing PR2 safety ref | pre-rebase/issue-883-pr2 at d906c6360533aaf894f5424dd4689aceedf08c3b; preserve it and create a separate ref for C |

The earlier in-flight inventory is superseded. PR2 is committed and clean at C;
[HI1–HI6 is accepted](pr921-historical-identity-planner-review-d4b0e326.md).
Carry that correction intact. The release records preservation and sequential
worktree ownership; it grants no permission to reset another writer's changes.

The Planner's release records **C**, the exact accepted submission-correction
SHA and clean tree. C is deliberately not guessed from a dirty worktree. The
release also rechecks origin/main against the target above and coordinates
exclusive use with both worktree owners. A material later-main change returns
for reconciliation; the Implementor does not silently change this base. No
additional product interview is needed for the contracts already decided.

After that release, preserve PR1's reviewed ref and the existing safety ref;
create a separate preservation ref for C before any replay or port. Build two
local integration branches in the owners' worktrees:

- agent/issue-883-pr1-main-integration, based on the exact target main.
- agent/issue-883-pr2-main-integration, based on accepted replacement PR1.

Do not overwrite an existing integration/preservation ref without investigating
its owner. Original PR branches and remote refs remain at their reviewed heads
through feedback. Do not move a branch checked out elsewhere from the root
checkout. No force push, GitHub mutation, CI inspection, merge or cleanup is
assigned. Publication of both reviewed replacements is a later coordinated act.

## Two coherent replacement revisions

### Replacement PR1: reusable Core boundary

Port the four accepted PR1 commits onto main's contracts. Move the existing
Core-only bound-evaluation amendment from PR2 earlier in the stack:

- generated-root-owner.ts, the bound request runner, private journal views,
  readiness and authoritative completion handling;
- execute.ts and document workflow activation/cleanup, HostExecution wrapping
  and ordinary execute runtime separation;
- agent/conversation.ts's evaluation mailbox method, readiness bridge and
  generated-root sequence partition;
- generated-xmd.ts's execution-bound binder, protected Syntax route/reference
  handoff, root language, binding isolation and partial rendering;
- their host exports, Core tests/held-host fixture and associated documentation.

This explicitly redistributes work previously accepted at 01abab27 and its
later root/Syntax corrections. Port the final behavior from C, while separating
the later provider/Preview changes below. Do not copy whole old files over main
or restore an obsolete siteless/table-taking interface as an intermediate
feedback boundary.

PR1 includes the earlier conversation identity/cancellation work and ACP host
consumer adaptations needed by its public handles. It exposes the Architect's
final request `{ id, source, allow?, position? }`, a coherent host/conversation
resource and pure preview without any CLI Sidekick dependency.

### Replacement PR2: Sidekick and later reviewed consumers

Port the remaining accepted changes through C onto replacement PR1. Keep the
reviewed provider configuration/recording and direct-provider conversation
changes, streamed publication/Preview extensions, their Core/ACP tests and
Workflow publication adaptations with PR2. They do not have to move earlier to
make the bound root method usable. Do not drop these amendments merely because
some Core files now appear in both replacement diffs.

Keep CLI storage/recovery, owner, controls, Configure/Retry, questions, Preview,
Sessions, routing, presentation, responsiveness, composer, width/padding,
large-reading correction and the accepted submission correction in PR2. Retain
the existing unrelated-to-admission vocabulary migrations where they belong in
this branch; do not use the integration to rename further concepts.

The Core binding hunks moved into PR1 are not applied twice. PR2's surviving
Core/ACP changes build on the integrated version, preserving both main's
contracts and their existing accepted behavior. Spec/architecture paragraphs
are split by the behavior each replacement actually contains.

Each replacement receives its own stable feedback SHA and review. Finish and
offer PR1 after its assigned evidence passes; do not withhold its commit for
unfinished CLI integration. PR2 starts only after replacement PR1 is accepted.
This is one planned bottom-up integration, with two review boundaries.

## Ordered Core work

1. Preserve main's initialization, actual-definition resolution and owned
   Component.generated capture before public execution policy. Feed the bound
   root evaluator that captured selection alongside the exact minted Syntax
   implementation, guarded route and captured reference through Core-private
   arguments. No new Context authority, callback API or reference token.
2. Use main's per-form owner URL/effect metadata and canonical ordering. Remove
   the old public observations/mutations, Workspace inputs, request inventories,
   generated identity records and pinned factories. Keep private normalization
   only where the integrated evaluator consumes it. Authored Evaluate remains
   main's fragment surface; no public siteless evaluator returns.
3. Write/read closed marker-4 fragments unchanged and marker-5 roots as specified
   in the decision, at both result and policy. Reject cross-kind, unknown/mixed
   markers and extra members before effects. Do not add a legacy authorization
   reader, migrate files or scan unvisited old admissions to refuse inspection.
4. Keep generated_root:N sequence partition/allocation independent of record
   marker. New explicit roots allocate past all retained sequences. Opening a
   conversation evaluates no old response and resumes no interrupted suffix.
   Existing provider identity/configuration checks stay authoritative.
5. Install useNarrowedSyntax inside scoped expansion for both kinds from the
   actual admitted symbols and captured owner reference. Named package chapters
   remain available for explanation, without granting invocation. Include one
   exact canonical self-closing Syntax read; a competing implementation remains
   a collision and an absent host profile remains absent.
6. Preserve root-local bindings/passive draft capture, root output mode and
   ordinary Err/partial rendering; fragments keep throw behavior. Explicitly
   handled component failures keep their behavior. Fatal policy/infrastructure/
   integrity/teardown failures retain authority through both wrappers and main
   completion. Busy lasts through cleanup and cancellation joins.
7. Keep live authorization at the actual performer after transformations. An
   acknowledged effect restores its result without new transport or a fresh
   live permission decision; unrecorded work meets current restrictions. Earlier
   committed work survives a later denial. No evaluator Workspace inventory.

Private admission argument threading, scanner unfinished-input merging and
helper layouts are delegated. Main's owner/capture machinery is the basis;
restoring old inputs to save conflict-resolution effort is not an option.

## Ordered Sidekick work

1. Construct each conversation's complete REPL/Guide definitions and explicit
   generated selection before opening its execution. Install through existing
   trusted installation/component-answer contracts with owner-declared form
   URLs and effects. Do not inherit or union ordinary entry defaults. Keep
   canonical Elicit and its existing question provider.
2. Capture these definitions once per conversation. Their closures retain the
   existing owned REPL request handles so later reads see current bindings and
   draft, rather than a setup-time snapshot.
3. Bind the active response's journal, control ordering and Submit association
   in the CLI owner before evaluation. Clear it only after evaluation and
   cleanup join. A second response cannot write into the first response's
   journal; another conversation cannot borrow it. This is private owner state,
   not a replaceable caller Context or new public callback protocol.
4. Replace response calls with `{ id, source, allow }` on the bound handle.
   Derive the described response vocabulary from the same installed definitions
   and selection, preserving guide reads and designated feedback. Syntax remains
   ordinary output/capture; REPL.Syntax still reads the entry vocabulary.
5. Preserve control schemas/forms, exact draft revisions, shared admission,
   question lifetimes, feedback delivery, two-file storage and correct receipt
   handles. Include C's acknowledged-history reservation/recovery correction
   without changing its accepted criteria.
6. Read an older valid chat through existing projections, then send new explicit
   work under its same native identity/configuration. Preserve messages, replies,
   incomplete facts and controls. Do not rewrite history or synthesize turns as
   an upgrade mechanism. Genuine inconsistent-history refusals remain.

## Frozen integration evidence

Reuse existing tests and fixtures. Add only the distinct integration observations
below; one row may combine several observations. Runtime transports may be fake;
canonical capture, histories, execution owners and publications must be real.
Synchronize on held operations/cleanup, not sleeps used as readiness evidence.

| Row | Required observation | Revision / destination |
| --- | --- | --- |
| IN1 — record kind and continuation | Actual fragment records remain closed marker 4 and a retained fragment continues under unchanged selected rows without repeating its first acknowledged effect. Actual root records are closed marker 5. Cross-kind markers refuse before effects in both directions; unknown/mixed markers and extra fields preserve main's refusal. Existing source, form, URL, kind, effect and order comparisons stay intact. | PR1; generated-xmd.test.ts, generated-xmd-root.test.ts and generated-composition.test.ts |
| IN2 — standalone bound owner | A live HostExecution evaluates without an agent or ambient durable caller; ordinary execute has no evaluator at runtime. No-selection, unavailable-class, canonical Syntax collision, busy and closed cases refuse without work. A root's ordinary failure carries real partial Output; fragment failure propagates; fatal and held-cleanup failures survive both bound wrappers. Reuse E1/E2/E5/E7 and existing conversation cancellation rows rather than adding a new failure matrix. | PR1; host-generated-root.test.ts, generated-xmd-root.test.ts, agent-conversation.test.ts and execution-protocol.test.ts |
| IN3 — captured descriptions | Root and fragment bare Syntax name their actual admitted vocabulary. Named lookup returns an enclosing captured package chapter with correct availability and ordinary capture; late documentation/selection middleware grants nothing and cannot replace it. After expansion, the enclosing descriptive view is restored. Retain lazy and loaded-copy regressions. | PR1; host-generated-root.test.ts, generated-xmd-root.test.ts, syntax-component.test.ts, syntax-api.test.ts and syntax-loaded-copy.test.ts |
| IN4 — old roots are history, not authority | In a real host/conversation journal, old marker-2 root sequences remain partitioned from main continuation and are skipped on open; a new explicit root allocates beyond them and writes marker 5. Offering the older admission to authorize a current root refuses. Completed document replay retains its existing bypass rather than scanning old unvisited admissions. | PR1; host-generated-root.test.ts and agent-conversation.test.ts; existing execution replay tier |
| IN5 — old chat remains usable | Reopen a small sanitized paired-chat fixture produced by the pre-integration writer at C, with a completed response and an interrupted response holding an actual completed control. Cold opening changes no bytes, sends no prompt and replays no root suffix. A new explicit message uses the same established native conversation and compatible configuration, preserves old visible facts and produces a new marker-5 response. No replacement/migration record or repeated earlier control. Keep incompatible configuration and unresolved acceptance refusals. | PR2; repl-sidekick-recovery.test.ts and existing recovery phases, agent-conversation.test.ts |
| IN6 — captured controls, current response | Two live chats install different owned control handles. Entry or later middleware cannot replace their captured implementations or add entry-only names. In one chat, two responses read changed REPL facts and record their own ordered controls/feedback. Include ordinary failure and cancellation while cleanup is held: no association transfers before join and no later control uses the old response. Reuse owner/control/Stop fixtures. | PR2; repl-sidekick-controls.test.ts, repl-sidekick-journey.test.ts, repl-sidekick-lifecycle.test.ts |
| IN7 — live authorization | Preserve U5 selected implementation and live Files/Fetch authorization tests, including transformed requests and completed-effect replay. Preserve Workflow's captured bound reading and no partial selection. Root capture uses the same machinery without reintroducing generic inventory checks. | PR1; generated-selection.test.ts, generated-owner-metadata.test.ts, evaluation-profile.test.ts, generated-xmd.test.ts; Workflow/CLI Evaluate integration |
| IN8 — accepted consumers | Provider configuration/identity/direct-provider and observing publication behavior remain accepted; Preview still discloses only cleared whole prefixes and keeps failed-item identity. Mounted Sidekick, Configure/questions/Sessions, ordinary entry/history and HI1–HI6 remain passing. Report mechanical fixture adaptations explicitly. | PR2; commands below |

The old-chat fixture contains test-authored local source, not the user's private
session or native credentials. Retain a receipt of its old writer SHA and marker
shape. Build it before leaving C or preserve an already verified old-writer
fixture; do not present a new integrated writer's history as old-version evidence.
The original archived probes/logs remain immutable. If an API change invalidates
probe imports, adapt discovered test setup while preserving their assertions;
no obsolete probe is required to compile through a removed public API.

IN1 and IN4 must distinguish historical inspection from authorization. A test
that refuses every old chat fails this plan even if its marker-refusal assertions
pass. IN6 must observe response association, not merely definition identity.
No unrelated mutation battery, malformed-input cross product or full runtime
suite is assigned for feedback.

## Focused commands and preparation

Main changes dependency inputs relative to C: deno.lock and pnpm-lock.yaml differ
and package.json adds knip. After switching each owner worktree to its released
integration branch, run `deno task setup` once as AGENTS.md requires for the
changed dependency layout. This prepares main's committed dependencies; it does
not authorize a dependency update or lockfile rewrite. If setup cannot complete,
return its first output and preserve work. Do not make tests reinstall or repair
shared caches. Verify:clean and exhaustive checks remain delivery work before
authorized publication, not feedback prerequisites.

Replacement PR1 commands:

```sh
deno task test packages/core/tests/host-generated-root.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts
deno task test packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/generated-selection.test.ts packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts
deno task test packages/core/tests/execution-protocol.test.ts packages/core/tests/document-output-api.test.ts packages/core/tests/syntax-component.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/syntax-loaded-copy.test.ts
deno task test packages/core/tests/agent-components.test.ts packages/core/tests/agent-function-components.test.ts packages/core/tests/agent-session-launch.test.ts packages/acp/tests/host-conversation.test.ts packages/acp/tests/loaded-copy.test.ts
deno task test packages/workflow/tests/generated-observations.test.ts packages/cli/tests/evaluate-component.test.ts packages/cli/tests/evaluate-workflow.test.ts
```

Replacement PR2 commands:

```sh
deno task test packages/core/tests/host-generated-root.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-function-components.test.ts packages/core/tests/agent-session-launch.test.ts packages/core/tests/agent-session-setup.test.ts
deno task test packages/acp/tests/provider.test.ts packages/acp/tests/native-launch.test.ts packages/acp/tests/host-conversation.test.ts packages/acp/tests/loaded-copy.test.ts
deno task test packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/secret-detection.test.ts packages/workflow/tests/workflow-agent-checkpoints.test.ts packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts
deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

These commands deliberately include lifecycle consumers missed by earlier frozen
selections. Main's old session-placement test becomes session-setup only with
PR2's accepted vocabulary/activation amendments; the PR2 command names that
successor explicitly. Keep the assertions when adapting U5 fixtures to bound
roots and owner metadata. If a named test genuinely changes location, report its
exact successor; do not omit its behavior silently.

Capture every first failure before rerunning. Fix and rerun affected assigned
commands before feedback; record identical-revision intermittence under the
repository flake rule. No full lint/check/JSR/runtime/CI gate is added here.

## Documentation and feedback

Update architecture.md and specs/executable-mdx-spec.md for captured roots,
marker separation, live authorization, Syntax and bound lifetime. Align
specs/acp-client-spec.md with the conversation method. PR2 also aligns
specs/repl-spec.md and Sidekick module descriptions with setup-time controls
and per-response association. Preserve current main's removed-input contract.
Do not introduce new terms or copy unrelated root-checkout prose.

For each feedback revision, hand back exact SHA/parent/base/tree/signature,
the source revisions ported, allocation of moved hunks, every assigned result,
IN1–IN8 mapping as applicable, first failures and fixture adaptations. Signed
feedback commits are created promptly after their focused evidence passes.
The old PASS verdicts do not transfer to the new SHAs. Stop for PR1 review
before PR2; stop for PR2 review before any publication assignment.

Keep Parse #922, new binding publication/agent-result inspection, UI decisions
B–D, teaching, captures and unrelated cleanup outside this integration. Do not
rewrite the user's saved files. Submission correction C remains a separately
accepted change carried intact into PR2, not reclassified as integration work.

## Continuity

Contracts are settled by pr890-pr921-main-integration-architect-decision.md.
Produced: this plan and pr890-pr921-main-integration-implementor-prompt.md.
Accepted C is d4b0e326d76fa63c6ee7a97e189986bbd371243d. The
pr890-pr921-main-integration-planner-release-d4b0e326.md release satisfies the start
requirements with target verification, sequential owner-worktree coordination and the
explicit EH1/UI10 disposition. HI1–HI6 is closed; do not repeat it.
A fresh integration Implementor session is appropriate for this
cross-stack assignment. No implementation, rebase or branch mutation occurred
while preparing this plan.

Current continuation: replacement PR1 is PASS at
85da74b938434773d7faf3caa5e2ca007328fdca. The existing integration Implementor
can continue PR2 using the updated prompt; no new session or release is required.
Original C remains preserved, and the next review is PR2's signed feedback SHA
against the seven commands and applicable IN rows above.
