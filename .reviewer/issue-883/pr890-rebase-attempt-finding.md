# Rebasing #890 onto main is a re-implementation, not a conflict resolution

Attempted 2026-10-16 against `origin/main` at `986948ea` (PR #920 / U5 merged).
**Aborted with nothing moved.** `agent/issue-883-pr1` is still `79d404d0` local
and remote, `agent/issue-883-pr2` is still `940249af` local and remote, and the
safety branch `pre-rebase/issue-883-pr1` points at `79d404d0`.

The rebase ran in a throwaway worktree on a copy branch, because
`agent/issue-883-pr1` is checked out in
`.claude/worktrees/issue-883-pr1` and belongs to that worktree's writer. Both
the worktree and the copy branch are removed.

## What happened

`git rebase origin/main` stopped on the first of four commits, `d45bbfc6`, with
five conflicted files:

| File | Hunks | Character |
| --- | ---: | --- |
| `packages/core/src/scanner.ts` | 1 | **mechanical** — resolved during the attempt |
| `packages/core/host.ts` | 1 | re-export list; depends on the file below |
| `architecture.md` | 2 | prose |
| `specs/executable-mdx-spec.md` | 1 | prose |
| `packages/core/src/generated-xmd.ts` | **34** | **two different refactorings of one call graph** |

`scanner.ts` resolved cleanly and is the shape of a real merge: main had
collapsed two checks into `pos >= text.length || text[pos] !== ">"` and dropped
a comment; #883 needs the `pos >= text.length` branch separate so it can
`unfinished?.push({ start, name, attributed })`. Keeping #883's branch and
main's comment cleanup satisfies both.

`generated-xmd.ts` does not work that way.

## Why generated-xmd.ts is not a merge

Both sides restructured how the admission is threaded through the same
functions, in incompatible ways. The same divergence accounts for roughly
twenty of the thirty-four hunks:

```text
main:  walk(segments, table, named, new Set<string>())
#883:  walk({ table, ceilings, context, named }, segments, new Set<string>(), TOP_LEVEL)

main:  transparent(segment.children, table, named, scope, lexical)
#883:  transparent(admission, segment.children, scope, inner)

main:  preflight(id, source, table)
#883:  preflight(id, source, table, ceilings, context)

main:  expand(id, segments, named, componentRouting, syntax)
#883:  expand(id, segments, named, context, componentRouting, syntax, rendering?.owner)
```

main threads `table`/`named`/`Planned` positionally — the #181 U-series work.
#883 bundles them into one `admission` object and adds `ceilings`, `context` and
a `TOP_LEVEL` lexical state. Each is coherent on its own. Combining them means
rewriting one slice's threading onto the other's signatures throughout the file.

Two of the hunks are worse than that, because they are settled contracts:

- **Hunk 9 — the durable record's shape.** main's `currentPolicy` returns
  `{ allow, allowed }`. #883's returns
  `{ allow, context, workspace?, allowed, requests, recordVersion }`. The
  record is replayed, so what it holds is a durability decision, not a merge
  preference. main's accompanying prose describes "every admitted spelling, in
  the order the selection resolved them: composition first, then the read
  table, then the write table"; #883's describes a root-versus-fragment ceiling
  and a Workspace basis. A record carrying both is a record neither side
  specified.
- **Hunk 32 — error mode against narrowed syntax.** main adds
  `yield* useNarrowedSyntax(syntax)` for the fragment's admission; #883 changes
  `ErrorMode.set("throw")` to `ErrorMode.set(context === ROOT_CONTEXT ?
  "output" : "throw")`. Whether a *root* also takes narrowed syntax, and what
  its error mode is when it does, is a behavioural question neither side
  answered because neither existed alongside the other.

The exported surface follows from this. main's `host.ts` exports only
`GeneratedXmdError`, because #903's dead-code gate removed the rest as unused;
#883 exports `evaluateGeneratedXmdRoot`, `GeneratedXmdRootError`,
`pinnedMutation` and the others, which PR 2 consumes. Restoring those exports is
correct, but their *signatures* are the ones in dispute above — main's
`pinnedFetch()` takes no arguments and `pinnedJson()` returns a
`CompositionEntry`, while #883's `pinnedFetch(requests)` takes them and
`pinnedJson()` returns a `GeneratedObservation`.

## What this means

This is #883 PR 1 re-implemented against #181's restructured admission model,
and it changes a durable record format and an admission ceiling on the way. That
is Architect and Planner work, not a conflict resolution, and the consolidated
handoff already places stack reconciliation in a later delivery assignment:
"Later delivery reconciles main overlap."

It is also work on a branch under review. #890's reviewed revision is
`79d404d0`; rewriting it mid-review replaces what the reviewing role is holding.

Finally, rebasing #890 alone would not leave the stack coherent. PR #921's base
ref is `agent/issue-883-pr1`, so moving it recomputes #921's merge-base back to
`e61d6ce0` and #921's diff would grow from its own 73 commits to the whole
stack until PR 2 is rebased onto the new PR 1 as well.

## Recommendation

Settle two things before any rebase of this stack:

1. What the durable admission record holds when #883's `context`/`workspace`/
   `requests`/`recordVersion` meet #181's ordered admitted spellings — and
   whether that is a new `recordVersion`.
2. Whether a generated **root** takes narrowed syntax, and its error mode when
   it does.

Then rebase bottom-up in one bounded assignment — `agent/issue-883-pr1` first,
force-pushed with `--force-with-lease`, then `agent/issue-883-pr2` onto it —
with the Core verification both slices already have. Note that the local
`agent/issue-883-pr1` lives in another worktree, so whoever does it should work
there rather than moving the ref from outside it.

Nothing in this attempt changed production source, a commit, a ref, a remote or
a PR.
