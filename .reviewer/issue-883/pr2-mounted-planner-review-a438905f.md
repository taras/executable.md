# Mounted Sidekick correction review at a438905f

**PASS — 2026-10-14.** M-P1 and M-P2 are closed. The section 5 mounted
message slice is accepted at this exact revision, with the original M1–M8
evidence and the two corrections. No further correction is assigned.

## Exact revision and scope

Reviewed `a438905f8fa98d245bb6444058bd470f1312411b`, parent
`86debcb96ba8f547d78712b2de66fcc1ed709ef9`, branch agent/issue-883-pr2.
Signature independently verifies G, tarasm@gmail.com. The worktree is clean.
The correction changes 10 files, +314/-37, preserving the mounted feedback
commit as its parent. Review changed no production or index files and made no
push, GitHub mutation or CI inspection.

## Findings closed

**M-P1:** upgradeExecution establishes its own scoped lifetime and registers
writer.release() with ensure before writer.hold(). Cancellation while hold
waits now releases the facade; success and ordinary failure release it when
the handoff ends. The separate scope matters: the destructor ends with this
operation rather than staying registered until the caller's message cycle
ends. The whole-publication hold and redirect order remain intact.

The preserved cancellation probe prints
`{"cancelledUpgradeNextAppend":"appended"}`; its ordinary-publication-failure
control also passes. R1u permanently covers cancellation while a real issued
append is held and proves a later record can use the same facade.

**M-P2:** submitForSidekick passes a start check closing over its exact
reservation. The check reads facts() at the moment the session asks after
preflight and calls the existing stillAdmissible predicate. program.ts forwards
it through current.submit(source, undefined, starting). Human Run and the
pending-Pause/admitting-record transition are untouched.

Making the private facts member a function is accepted. Both reservation and
start need current root facts at their own moment; one reader supplies those
without pretending a snapshot can answer a later question. The call-site
adaptations change that input shape and preserve existing assertions.

The preserved mounted probe now reports no entry for a Draft edited during
preflight, and entry-1 from the exact requested source for the unchanged
control. The permanent mounted regression also checks the newer Draft remains
exactly what the person typed. Existing refusal reporting and exact-entry
ownership remain in place.

## Independent focused evidence

All six assigned selections pass on the final verified source. Selection 4
had one intermittent permission assertion on its first run, recorded below;
its unchanged full rerun passes.

| Selection | Tests | Steps | Output |
| --- | ---: | ---: | --- |
| Mounted presentation / journey / lifecycle | 12 | 50 | [first](pr2-mounted-review-a438905f-mounted-first.log) |
| Entries / history / agent execution / controls / output | 51 | 201 | [first](pr2-mounted-review-a438905f-entries-first.log) |
| Storage / recovery / configuration | 11 | 63 | [first](pr2-mounted-review-a438905f-recovery-first.log) |
| Journey / agent interface / agent journey / forms | 71 | 185 | [green rerun](pr2-mounted-review-a438905f-journey-rerun.log) |
| Route / layout admission / presentation style / source reading | 28 | 130 | [first](pr2-mounted-review-a438905f-layout-first.log) |
| Execution / lifecycle | 6 | 39 | [first](pr2-mounted-review-a438905f-lifecycle-first.log) |
| Total | 179 | 668 | |

Exact commands, run in the implementation worktree:

```text
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts

deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts

deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts

deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts

deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts

deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

Both unchanged reviewer probes also pass, two tests / four steps total:

```text
deno test --allow-all --config ./deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-mounted-handoff-cancel-probe-86debcb9.test.ts

deno test --allow-all --config ./deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-mounted-start-recheck-probe-86debcb9.test.ts
```

Outputs: [writer cancellation](pr2-mounted-review-a438905f-cancel_probe-first.log),
[mounted start gate](pr2-mounted-review-a438905f-start_probe-first.log).

The supplied mutation outputs discriminate each fix independently:
[release registered after hold](pr2-mounted-review-a438905f-mutation-a.log)
fails the cancellation regression alone; [start check omitted](pr2-mounted-review-a438905f-mutation-b.log)
fails the edited-Draft regression alone. Their positive controls stay green.
The storage row was labelled R1s when that log was captured and is R1u in the
final commit; its observation is unchanged. The handback reports confirmation
and byte-identical restoration; review inspected the restored source and
reran the assigned evidence without mutating production. The unchanged
notification control from the original mounted increment stands.

One evidence-description correction is non-blocking: the new R1u control does
not force or assert an ordinary publication failure. It checks writer reuse
after an uncancelled handoff, so its title/comments alone cannot establish a
failure occurred. The required unchanged reviewer probe does explicitly cause
the ordinary failure and proves release on that path. That independent,
assigned evidence supplies the control; no additional acceptance test or
feedback commit is required for this wording observation.

## Intermittence recorded separately

The first selection-4 run fails one existing U2 assertion at
repl-agent-interface.test.ts:1524: the separate build turn was not yet visible.
[Its complete first output](pr2-mounted-review-a438905f-journey-first.log) is
preserved. No source changed before the isolated file passed (14 tests /
40 steps) and the full selection passed (71 / 185). The correction does not
change that file or its ordinary permission path.

[The local flake record](pr2-mounted-permission-u2-flake-a438905f.md)
holds the revision, runtime, commands, assertion and evidence of intermittence.
A green rerun does not establish a fix. A dedicated GitHub flake issue remains
to be created or updated when GitHub work is authorized; this review's explicit
no-GitHub-mutation limit is preserved. This does not reopen the settled mounted
contract or assign unrelated test repair to this correction.

## Continuity

Accepted head: signed clean a438905f. M-P1/M-P2 and the bounded mounted
message slice are closed. Configuration P1/P2, increment 4 and R2 stay closed.
The deferred section 4 program.ts owner-acquisition join is delivered by this
accepted mounted path.

Preview, mounted Sidekick question/Configure drawers, configuration controls,
Sessions integration, remaining terminal acceptance and the 36-frame packet
remain incomplete. No delivery verdict is implied. The next bounded assignment
is now [the Sidekick question drawer](pr2-section5-question-drawer-planner-handoff.md)
from this accepted head. No push, GitHub mutation, CI inspection or capture is
assigned.
