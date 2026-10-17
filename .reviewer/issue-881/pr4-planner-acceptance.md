# REPL responsiveness — Planner acceptance

**PASS at `6f5f150a630774d207ae3688f29f93834c08abdd`.**

This closes R1 and R2 from `pr4-planner-review.md`. The accepted implementation base is `05ba70d567cb80be4bfdea67e7ae0267376e2376`; the follow-up contains signed commits `06080c640d5cae1fe96c355045177a462dcc040a` and `6f5f150a630774d207ae3688f29f93834c08abdd`. The revision changes tests only relative to the first feedback commit. The implementation worktree is clean.

## What is accepted

The running command owns one geometry store. It reuses fitted cuts when the text/depth sequence, measured room and terminal dimensions agree, and derives current decoration from current reading lines. Live lifecycle observations, head derivation, coherent history readings, refusal behavior and persistence boundaries remain unchanged.

Non-geometry actions skip pre-action preparation. Traversal focus is read before composition, removing the redundant paint while retaining post-commit focus correction and reveal handling. The previously accepted J2 read-count adjustment stands.

R1 is closed. RS2 observes complete commits against a real mounted tree and engine pair, and compares short and long selected readings after a draft change. RS3 observes the real command loop for typing, erasing, Tab and Backtab at both entry lengths. KR4 bypasses the gate at its production call site and fails RS3 with five size reads instead of four. KR5 removes the store argument at the preparation-to-fitting boundary and fails RS2, while the direct fitter checks remain green. These reach the wiring the earlier isolated evidence did not.

R2 is closed. Each invalidation case warms the exact inputs, changes only depth, room, size or one line's text, observes new measurement work and compares the resulting fit with a fresh unretained fit. Depth and size have separate mutation controls that fail their own named assertions.

## Independent verification

From `.claude/worktrees/issue-881-pr4`:

```text
deno task test packages/cli/tests/repl-source-reading.test.ts \
  packages/cli/tests/repl-presentation-style.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts \
  packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-forms.test.ts
52 passed / 218 steps; exit 0

deno task test packages/cli/tests/repl-journey.test.ts \
  packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-terminal.test.ts
56 passed / 146 steps; exit 0

git diff --check 05ba70d5 HEAD
exit 0
```

The packet's SHA-256 manifest verifies all 30 listed files. The seven recorded controls fail their named assertions, and the restored-file hashes match current production bytes. The reviewer inspected their mutations and complete failure records; mutations were not rerun against the implementation worktree.

The reviewer reran both supplied complete-frame measurement scripts, each from its own revision's worktree with `deno run --allow-all --node-modules-dir=manual --cached-only --frozen --config deno.json <script>`. The selected 12-line and 222-line fixtures reproduce:

| Selected source | Base subsequent frame | Accepted subsequent frame |
| --- | ---: | ---: |
| 12 lines | 127 measurements | 5 measurements |
| 222 lines | 2,247 measurements | 5 measurements |

These are complete committed-frame counts for those fixtures, not total input-to-present latency or a universal count for all drawers and History states. They establish that the unchanged source no longer adds engine fitting work to subsequent frames. The isolated fitter's zero-measurement count and approximately 1.1 ms timing remain evidence for that narrower boundary. The external real-CLI timings measure input to the first output bytes, including tmux and frame cadence; no timing threshold forms part of acceptance.

The retained reading construction and row decoration still scale with the reading. Further caching is not required for this acceptance.

## Delivery boundary

No production edits, push, PR update, merge or CI inspection were performed by this review. Delivery verification remains separate. The existing published PR stack is unchanged.

Independent commands and results are retained in `pr4-planner-acceptance-evidence/`; the supplied handback and packet remain at `pr4-implementation-handback.md` and `pr4-evidence/`.

No implementation blockers remain for this responsiveness slice. The Implementor's next action is to stop; publication or delivery proceeds only when assigned.
