# REPL responsiveness architecture review — #889

**PASS** on `22b9d2e2bbd3893c55a2149acfa12b5a5e1bca1f`.
The geometry reuse preserves the accepted history, execution, mounted-tree and
frame ownership boundaries. No architecture blockers remain at this commit.

## Reviewed boundary

Reviewed [PR #889](https://github.com/taras/executable.md/pull/889) on 2026-10-10
against main `b88da5ea979fa17fe217507ecaae2e224856bace`. Its immediate parent is
`ca57ab07b67e7b992db4653ac3246169456b7c0d`. The remote head and base were checked
again after verification and remain unchanged.

#885, #886 and #887 are merged. The published optimization's three production
files and five changed test/fixture files match Planner-accepted feedback
`6f5f150a630774d207ae3688f29f93834c08abdd` byte for byte. Differences elsewhere
come from the integrated predecessors. The #887 squash differs from the exact
architecture-reviewed #887 tree only in its History test. The separate #805
session-rendering proof remains outside this private REPL implementation.

Authority: the existing architecture and REPL specification, the frozen
[PR 3 structural checks](pr3-planner-handoff.md), and the responsiveness
[implementation handback](pr4-implementation-handback.md) and
[Planner acceptance](pr4-planner-acceptance.md). This is a conforming private
optimization; no new public interface or architecture amendment is required.

## Structural findings

1. **One coherent reading remains authoritative.** The root still calls
   `session.reading(state.route.at)` on each loop rebuild. Model and navigation
   travel together through resolution and resize composition. The cache cannot
   bypass full retained-history validation, replace a selected prefix, supply
   future payloads or restore a live overlay into historical inspection.

2. **The command owns copied geometry.** `drive()` creates one `ReplFitStore`.
   It retains copied text/depth inputs, dimensions, room, and immutable fitted
   cuts and widths. It holds no Journal, session, invocation, mounted node,
   engine-memory view, subscription or task. Input comparison checks every
   line in order, including count, text and depth, plus room and both terminal
   dimensions. Only successful fits are retained. Reuse has no durable effect
   or lifetime beyond the command.

3. **Current decoration stays current.** Each preparation builds reading lines
   from the current view. On a hit, `decorate()` uses those lines for keys,
   token runs, rails, badges, selection and inspection. Retained cuts do not
   retain an earlier occurrence or phase. History rail preparation, preview
   fitting and structural measurements still run from the current view.

4. **Admission and target authority remain intact.** The reducer's only
   admission readers are the four scroll branches, exactly those selected by
   `readsGeometry()`. Other actions continue through the same tree dispatch,
   reducer and root-owned authority calls. Skipping their unused preparation
   neither admits a control nor supplies execution authority. Every committed
   frame still measures structural regions, admits from one prepared reading,
   revalidates size before reconciliation, and draws targets from mounted nodes.
   An abandoned resize attempt may leave reusable inert geometry, but the next
   attempt must match its dimensions and inputs before using it.

5. **Freedom retains focus and resources retain their owners.** Traversal
   updates the root's presentation cue by reading the focus Freedom already
   chose. Post-commit focus correction and reveal handling remain. Conditional
   startup repaint removes only an unnecessary frame. Frame subscriptions,
   acknowledgement, failure unwinding, session teardown and terminal restoration
   keep their existing scope owners; reuse introduces no reader, timer or
   concurrency path. Persistence, replay and fatal-outcome selection are untouched.

## Independent verification

Prepared the isolated exact-head worktree
`/private/tmp/xmd-pr889-architecture-review` with `deno task setup`, then ran:

```text
deno task test packages/cli/tests/repl-source-reading.test.ts \
  packages/cli/tests/repl-presentation-style.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts \
  packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-forms.test.ts
52 passed / 218 steps; exit 0

deno task test packages/cli/tests/repl-journey.test.ts \
  packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-terminal.test.ts \
  packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-composition.test.ts
71 passed / 215 steps; exit 0

git diff --check b88da5ea979fa17fe217507ecaae2e224856bace HEAD
exit 0

git status --porcelain
empty
```

Total: **123 tests / 433 steps**, all passing. This includes cache invalidation,
fresh lifecycle decoration, integrated frame work counts, real input/focus,
resize refusal before mounting, cold history, modal containment and terminal
cleanup. The accepted J2 fixture adjustment still places its resize between
measurement and revalidation; its behavioral assertions are unchanged.

Logs: [fitting and forms](evidence/pr889-architecture-fitting.log) and
[journeys and ownership](evidence/pr889-architecture-ownership.log).
The Planner owns the accepted performance and mutation evidence; this review
does not add a timing threshold or a new visual matrix.

No production edits, commit, push, GitHub review or CI inspection were performed.
Architecture feedback for this exact commit is complete. No Implementor revision
prompt is needed. Delivery verification remains separate.
