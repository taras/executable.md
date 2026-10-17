# Sidekick implementation foundation after #881

#883 can start with its accepted Core slice. All three original Terminal
Interface parity slices are merged. The remaining layout performance work is
independent; it introduces no required Sidekick interface or product decision.

## Delivered foundation

The delivered parity foundation on October 10, 2026 is
`b88da5ea979fa17fe217507ecaae2e224856bace`.

| Slice | Merged PR | Merge commit |
| --- | --- | --- |
| Colours, pane surfaces and drawers | [#885](https://github.com/taras/executable.md/pull/885) | `160e354e47f6fbeb1c792e6799c1fe26b2f155fc` |
| Component lifecycle and source reading | [#886](https://github.com/taras/executable.md/pull/886) | `9fe494d78d1b2f65d8efb12fffae5ea68da6c17b` |
| History navigation and measured rail | [#887](https://github.com/taras/executable.md/pull/887) | `b88da5ea979fa17fe217507ecaae2e224856bace` |

The Product Owner confirms #881 delivery. The final PR describes completion of
the original parity work. Issue #881 still appears open in the fetched tracker
record; that administrative state does not negate the merged delivery. This
record supersedes the earlier prerequisite status in this packet and the stale
slice statuses in the local predecessor planning record.

[base-state.json](base-state.json) distinguishes the verified foundation from
the older planning checkout and the implementation worktree, which has not yet
been created. The Implementor records the actual resolved worktree base when
starting. Later main changes are integrated and their effect recorded normally.

## Contracts preserved by Sidekick

Core now exposes canonical complete-expansion observation. Its lifetime covers
resolution, validation, execution, middleware cleanup and final acceptance.
Sidekick uses that boundary rather than inferring completion from generated
source, a provider delta or rendered output. Observation phases carry lifecycle
facts, not values, bindings or canonical Error identity. Observation cannot hold
up or cancel the work it observes.

The new source-inspection surface scans complete source without importing,
resolving or evaluating it. Reuse its lexical rules. It does not by itself
provide the incomplete-prefix parser required for Sidekick Preview.

REPL content and History navigation now share one acknowledged reading.
Validation covers the whole retained history even when an earlier prefix is
selected. Preserve that coherence through measurement and painting; do not
combine a cached content projection with a newer navigation snapshot. Sidekick
binding reads continue to inspect the current live execution independently of
the selected historical reading.

The session owner releases and joins entry resources before publishing its
settled lifecycle. Submit waits for that exact entry teardown. A RootClose or
result publication alone does not satisfy completion. Preserve the measured
History rail, source/output structure and accepted pane boundaries when adding
the Sidekick tab and drawers.

The handoff adds the delivered expansion, source-inspection, History, lifecycle,
source-reading and presentation regressions to the corresponding focused test
commands. These are evidence for the already accepted boundaries, derived under
product-verification rule 4; the product journeys and two-PR split stay settled.

## Independent performance work

[PR #889](https://github.com/taras/executable.md/pull/889) merged at
2026-10-10T10:32:50Z as e61d6ce072735b5d0cf683eeaca0f2eefddc2d59.
The refreshed GitHub main ref and local origin/main both name that commit.
Its reviewed head was 22b9d2e2bbd3893c55a2149acfa12b5a5e1bca1f, based on
the same parity foundation.
Its patch avoids unnecessary pre-action geometry reads and reuses fitted row
cuts when source shape and terminal geometry match. Current decoration is still
applied each frame, and the program scope owns the fit store. It changes CLI
application, fitting and program code plus their evidence; it adds no Core or
persistence contract.

Core PR 1 can proceed immediately from current main, which now includes #889;
b88da5ea remains the recorded parity foundation. The performance diff changes
only CLI source/tests and has no Core file overlap. CLI PR 2 incorporates that
merged work through its resolved base. Preserve the single scope-owned fit store, invalidation
inputs, fresh decoration, coherent session readings and geometry requirements
of scrolling actions. File overlap calls for ordinary integration; #889 is not
a prerequisite, and this assessment is not a review verdict on that PR.

## Scope of this refresh

Evidence consists of merged PR metadata, remote/local main refs, the merged
architecture and affected interface diffs, and the performance patch. No CI
status was inspected. No production source, checkout, dependency state or
GitHub record was changed, and no implementation test or feedback commit is
claimed. The [implementation handoff](planner-handoff.md) remains authoritative
for the accepted work and its evidence.
