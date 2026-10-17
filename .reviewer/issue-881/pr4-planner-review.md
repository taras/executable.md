# REPL responsiveness — Planner review

**REQUEST CHANGES at `06080c640d5cae1fe96c355045177a462dcc040a`.**

Reviewed parent: `05ba70d567cb80be4bfdea67e7ae0267376e2376`.
The commit has a valid signature and its worktree is clean. No production
changes, pushes, PR updates or CI inspection were performed during this review.

The implementation separates measured text cuts from current decoration,
compares the geometry inputs directly, and retains the store in the running
command. The four admission readers match `readsGeometry`. Taking traversal
focus before composition removes the redundant correction frame while retaining
the post-commit safety net. J2's adjustment is accepted: the removed action
preparation accounts for the read-count change, the resize remains between the
frame size read and revalidation, and the behavioral assertions are unchanged.

The remaining requests concern evidence for the approved behavior, not a new
cache design or a further optimization target.

## R1 — Guard and measure the production path

`pr4-evidence/measure.ts` calls only `prepareReading()` ten times. It neither
types into the draft nor runs `prepareFrame()`, `commitReplFrame()`, the action
gate or focus traversal. Its “before” is the new fitter without a store, not
execution of the parent revision. Its “empty” case is a one-line Json source.
These are useful isolated fitting measurements, but the handback labels them
as complete per-keystroke work and uses them to characterize the remaining
application cost. Zero fitting measurements does not mean zero frame
measurements: an independent warmed `commitReplFrame()` probe still observes
four measurement calls with its empty navigation, for both an empty model and
the selected retained 222-line entry.

The same boundary gap exists in the regressions and controls. S5 calls the
fitter directly, and EU2 checks the action classifier and reducer rather than
the gate in `act()`. KR2 changes `readsGeometry` and is caught by its explicit
predicate assertion. It does not prove that production dispatch obeys the
predicate. Omitting the production store threading or bypassing the gate is
not guarded by a structural work-count assertion on real input. RS1 correctly
guards one presented frame for traversal, but does not count its fitting work.

Required correction:

- Keep the isolated benchmark, labeling its actual boundary and comparison.
  Correct the empty fixture description and check each fitting result before
  counting or timing it.
- Add a focused regression through production input dispatch, preparation and
  reconciliation after warmup, using a selected long entry. Observe actual
  engine work for draft typing, erasing, Tab and Backtab. Distinguish source
  fitting from the fixed measurements a complete frame still performs.
- Prove the regression reaches both production optimizations with named
  controls: bypass the gate at its call site; separately remove production
  store threading while leaving the fitter's direct tests intact. Each must
  fail the intended integrated work-count assertion.
- Report before/after complete-path work counts for short and long readings
  and focus traversal, using the parent revision as the baseline. Report
  timings as observations, with their measured boundary stated. Keep the
  existing external real-CLI timings labeled as input-to-first-output-byte
  measurements including tmux and frame cadence.

Do not optimize the remaining tree construction merely to satisfy this
request. First describe its cost accurately. No machine-dependent timing
threshold, new public API, exhaustive suite or full gallery rerun is required.

## R2 — Make invalidation evidence discriminate each input

The S5 case named “measures again when the source, the depth or the room
actually changed” never changes depth. Its terminal-size assertion follows a
fit of edited text, then supplies the original text at the narrow size. The
source change already causes a miss, so that assertion passes even if size is
removed from the cache key. It also checks success and positive work rather
than the resulting fit for the room and size changes.

Required correction:

- Warm the exact inputs immediately before each invalidation assertion, then
  change only depth, only available room, or only terminal size. Keep the text
  and other inputs identical within each pair.
- Use a wrapping/depth-sensitive reading and compare the cached-path result
  with a fresh measured result: cuts, widths and recovered text. Verify actual
  measurement work occurs for each changed input.
- Include controls dropping the depth comparison and the size comparison;
  each must fail its own named invalidation assertion.

This covers the existing invalidation contract. Do not expand it into an
unbounded permutation matrix.

## Independent verification

Run from `.claude/worktrees/issue-881-pr4`:

```text
deno task test packages/cli/tests/repl-source-reading.test.ts \
  packages/cli/tests/repl-presentation-style.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts \
  packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-forms.test.ts
51 passed / 214 steps; exit 0

deno task test packages/cli/tests/repl-journey.test.ts \
  packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-terminal.test.ts
55 passed / 144 steps; exit 0

git diff --check HEAD^ HEAD
exit 0

shasum -a 256 -c sha256sums.txt
exit 0, run in the supplied pr4-evidence directory
```

Independent logs and the frame probe are retained under
`/private/tmp/issue881-pr4-planner-review/`. The probe supplies an empty
navigation and is evidence that whole-frame measurements remain, not a
benchmark of every real History rail state. The reported controls were read;
this review did not rerun mutations against the implementation worktree.

## Implementor revision prompt

Address R1 and R2 above on the responsiveness follow-up based on
`06080c640d5cae1fe96c355045177a462dcc040a`. The cache design and J2 adjustment
stand; no additional optimization or parity redesign is requested. Add the
integrated counting regression and discriminating invalidation cases, run
their named controls with exact byte restoration, correct the benchmark and
handback boundary claims, and rerun the affected focused tests. Commit the
revision promptly once focused evidence passes, return its exact SHA and
commands, and stop for review before pushing or updating the PR stack.

Delivery verification remains separate.
