# U4 landed receipt for U5 planning

PR [#919](https://github.com/taras/executable.md/pull/919) merged on 2026-10-15 at
11:47:49Z. Read-only GitHub API and local object checks establish:

| Item | Exact revision |
| --- | --- |
| Merge and remote main at planning freeze | `3a1fade9246db937e11da6cdadc4751ec924be97` |
| Merge tree | `b92762664a24d7b5636b08c98d96907a614d76f0` |
| Published PR head | `4c05e45b468a80db7370a8163d82ce20ede94262` |
| Published head tree | `b92762664a24d7b5636b08c98d96907a614d76f0` |
| Merge parents | `b5a2b3ccdab5d862b411d948f3ebfa4b0a1da718`, `4c05e45b468a80db7370a8163d82ce20ede94262` |
| Earlier Planner PASS revision | `eef612edcf86dd2416b2cb3dbbdd85dcb4e3e9d4` |
| Earlier reviewed tree | `38b43cff89640a293fbbd338f4bcb5046cec8dd7` |

The published head and merge have the same tree. The earlier [Planner
review](../upstream-u4-review-eef612ed/planner-review.md) remains attached to its exact
feedback SHA; this receipt does not transfer that verdict or assert a new
Architect/Product Owner verdict for a later revision. U5 source inspection uses the
landed tree.

Commands: `gh api repos/taras/executable.md/commits/main --jq '{sha: .sha, tree:
.commit.tree.sha}'`; `gh pr view 919 --json
number,state,mergedAt,mergeCommit,headRefOid,url`; local `git show -s` for
merge/head/tree/parents. No CI was inspected.

The source archive beside this receipt is unprepared and was compared against the
merge's Git blobs. See the Planner status for the inventory verification. No branch,
worktree, preservation ref or production code was changed by this planning receipt.
