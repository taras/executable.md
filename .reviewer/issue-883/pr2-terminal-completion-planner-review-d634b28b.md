# Terminal completion review: REQUEST CHANGES at d634b28b

**Additional Product Owner finding, 2026-10-15:** the
[chat-flow addendum](pr2-chat-flow-planner-addendum-d634b28b.md) reproduces
multiline messages overwriting earlier lines and a current chat that does not
show newly acknowledged replies after its window fills. Its first output is
preserved, with the short-message control green. The current correction now
includes CF1–CF3 and the explicitly named private chat/frame paths.

TE1–TE3 are accepted. TE4 implements the accepted pane/header fills and column
dividers, but omits both header edges. Its tests check the footer edge and do
not check header edges. Finish that frozen requirement and its evidence.

The Product Owner additionally corrects the spelling to **--sidekick-agent** and
asks for every active sidekit name to become sidekick. That is a new authorized
change to the former exact-spelling instruction, not a deviation by the
Implementor. Incorporate it in the same bounded correction.

Execute [the correction prompt](pr2-terminal-completion-implementor-correction-d634b28b.md).

## Exact revision

- SHA: `d634b28b24afa9a16a0a10ec7906c09d924c9db9`.
- Parent: `ab681d4acd824665188f2c6ab9997eecbbf178e0`, preserved.
- Branch agent/issue-883-pr2; signature G, tarasm@gmail.com.
- Implementation worktree: `.claude/worktrees/issue-883-pr2`.
- Independently verified clean, with no untracked files.
- Twelve files, +829/−46; four production modules, tests/fixtures and two documents.

The [frozen plan](pr2-terminal-completion-planner-handoff.md) governs TE1–TE5,
subject only to the Product Owner's new spelling correction. Sessions and all
previous acceptances remain closed.

## Accepted implementation and evidence

TE1 drives the real mounted seed, detached binding feedback, shared Draft,
ordinary Submit and greeting/table entries. Both data arms execute Each over
the actual published binding; changing Linus to Margaret changes both real
outputs. The held fill runs nothing, admitted source matches captured Draft
bytes, receipts name the actual entries, and the earlier greeting source/output
remains intact. Existing M3 supplies the already accepted admission-clears-Draft
observation. The scripted transport makes no teaching-quality claim.

The small eval seed is approved here for this fixture's durable root export.
The earlier planning suggestion that Json/as could publish the seed was wrong
for this REPL's retained root map. The corrected diagnostic
[reads an empty exported map after Json/as](pr2-terminal-seed-probe-d634b28b-corrected-json-form.log);
model.ts reads durable eval exports for entry inheritance. This does not
authorize new JS machinery or expand the production language. The diagnostic's
earlier reader-property and paired-Json errors were reviewer probe mistakes,
preserved in their separate logs, not product failures or flakes. This
diagnostic is not an unchanged required-green regression.

TE2 connects a real failed entry to its owning receipt/read instruction and a
different successful entry, in the same conversation. Its failure is retained;
provider failure and held teardown remain covered by the accepted separate rows.

TE3 observes two actual provider sessions and results through the entry's
unstated default and Sidekick's own choice. The additive fixture options use
the production assembly; existing callers keep their defaults. Layered argv
and mounted evidence is described honestly.

The independent #883 reference fixture has the correct refinement digest and
does not change #881's archive. Semantic/syntax/focus/History values stay intact.
The sequential-entry help and positional diagnostic correction are accepted.

## T-P1 — header edges are absent

The accepted reference has a bottom edge on the Transcript header and on the
right tab header, both #3f5363. The frozen plan requires header/footer edges and
direct production-cell evidence for them.

headerRowProps() currently adds only a background. chromeEdge is used once,
by bodyProps() for the footer rule. No header construction draws it. The new
TE4 row samples header backgrounds and a footer foreground but never a header
edge. Passing it therefore cannot establish the required separation.

The [paired committed-grid probe](pr2-terminal-header-edge-probe-d634b28b.test.ts)
observes this on the exact revision:

```text
headerChrome: { transcript: 0, inspection: 0 }
footerChrome: 160
```

It searches every possible non-footer interior cell of the two empty columns,
so a different choice of header-edge row cannot explain the absence. Its
header regression fails while the existing-footer control passes.
[First output](pr2-terminal-header-edge-probe-d634b28b-first.log) is preserved.
No production source or test was edited to obtain it.

Draw the actual two header edges in existing chrome and test their actual
positions. Complete TE4's direct sidebar/right body-fill assertions under
both tabs as originally prescribed; the current new row checks header fills,
central body, dividers and footer, leaving the other body fills to a single
older assertion. Keep the same finite size/tab matrix, seven-row footer and
honest geometry.

## TE5 — correct two evidence descriptions

The R6 authoritative-classification row cites an unsupported form-schema refusal
and cancellation of a waiting save. Neither tests fatal failure classification.
The plan explicitly accepts previously reviewed Core evidence here. Cite that
actual retained boundary: agent-conversation.test.ts's CV32 journal failure and
PV5 throwing-observer/held-cleanup row, together with the accepted owner/Preview
reviews. Mark it as reused prior evidence, not a new command in this slice.
No new Core suite or failure permutation is assigned.

Correct command references as well: CFG5 and CLI/configuration rows run under
command 4, not the R6 command-3 heading or the R7 command-2 heading. Accepted
observations do not need new tests merely to repair their bibliography.

## Independent verification

Counts are tests / steps. All first output is retained.

| # | Exact command | Result | Output |
| --- | --- | --- | --- |
| 1 | `deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts` | 12 / 63, green | [first output](pr2-terminal-review-d634b28b-command-1-first.log) |
| 2 | `deno task test packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-history.test.ts` | 46 / 194, green | [first output](pr2-terminal-review-d634b28b-command-2-first.log) |
| 3 | `deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-source-reading.test.ts` | 36 / 187, green | [first output](pr2-terminal-review-d634b28b-command-3-first.log) |
| 4 | `deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/cli-help.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-exit-pty.test.ts packages/cli/tests/repl-presentation-style.test.ts` | 45 / 167 passed; 1 test / 2 steps failed | [first output](pr2-terminal-review-d634b28b-command-4-first.log) |
| 5 | `deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-execution.test.ts` | 58 / 142, green | [first output](pr2-terminal-review-d634b28b-command-5-first.log) |
| 6 | `deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-correlation-probe-b44098ff.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-preview-single-item-probe-f8b4e035.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-populated-probe-4ee4f448.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-cross-chat-probe-4ee4f448.test.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-sessions-reveal-probe-4ee4f448.test.ts` | 5 / 10, green | [first output](pr2-terminal-review-d634b28b-command-6-first.log) |

Commands 1, 2, 3, 5 and 6 pass on their first invocations.
Command 4's two real-PTY rows fail before reaching their REPL screen because
their private tmux socket cannot be read. All other rows pass. The unchanged
[isolated PTY rerun](pr2-terminal-review-d634b28b-pty-isolated-rerun.log)
reports the same missing sockets: 1 / 3 passed, 1 test / 2 steps failed.
This review environment obtained no real-PTY proof. It is not evidence of a
header failure, not a demonstrated L2/U2 recurrence, and not an assigned
product or dependency repair. The Implementor reports all six commands green
on this exact signed tree; that report remains separate from these results.

No L2 or U2 recurrence appeared in the independent runs. No broad lint/check,
JSR, runtime suite, CI or capture was run. No cache/dependency workaround or
GitHub mutation occurred.

## Two reported observations

REPL_DESCRIPTION's singular entry describes an activity without imposing the
retired exactly-one limit. It is non-blocking and is not a prerequisite for
this correction. SIDEKICK_QUIET is unused and predates the slice; it likewise
creates no acceptance gap. Leave both outside this feedback correction.
No speculative issue or extra test is assigned for either.

## Continuity

Latest accepted head remains ab681d4a. Preserve d634b28b and its ancestors;
continue from it through the linked correction. No architecture interview is
needed. The Product Owner's spelling supersedes the older exact sidekit flag
instruction in active governing documents. Prior signed-commit descriptions
and preserved first outputs remain historical evidence.

Produced: this review, the correction prompt, header-edge probe/first output,
independent command logs and updated readiness/spelling pointers. Next
Implementor action: finish the header-edge requirement, apply the requested
spelling consistently, correct the evidence mapping and return one signed
feedback commit. Teaching, the 36-frame packet and delivery remain separate.
