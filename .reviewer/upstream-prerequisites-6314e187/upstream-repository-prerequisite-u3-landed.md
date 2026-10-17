# U3 landed receipt

U3 is landed through [PR #912](https://github.com/taras/executable.md/pull/912). Read-only GitHub API checks during U4 planning returned:

| Item | Verified value |
| --- | --- |
| PR merged | true |
| Merge commit / main | `6314e187dc89c3e0f2b393b60d6f5963f847a881` |
| Merge tree | `3c4f45ca509e0de6ee820341c602319c7482386d` |
| Published PR head | `bc2c59c8b6f7a5854dda7b6a8bc70970003987ba` |
| Published head tree, verified locally | `3c4f45ca509e0de6ee820341c602319c7482386d` |
| PR base | `a0320347ff676f76735f42be86ff0bdb07a52980` |

The published head and merge have identical trees. The earlier [Planner PASS](upstream-repository-prerequisite-u3-planner-review-ac466780.md) reviewed `ac466780cda608eafe974951c13c09c02b2b1cd4` against landed U2. The published branch subsequently incorporated main and documentation corrections; this receipt does not misidentify the earlier feedback SHA as the merged tree or issue a new independent implementation verdict.

U4 planning uses an exact Git archive of the merge in `u4-planner-source/`. It contains no dependency installation and is not an implementation worktree. Neither CI nor main health was inspected for this receipt. User-reported merge was independently confirmed by PR/main API data; root workspace and existing worktrees were not changed.

Next: [U4 handoff](upstream-repository-prerequisite-u4-implementor-handoff.md), followed by separate implementation authorization. U5 follows landed U4; #902 remains held through U4–U5 and removal of consumer-owned forwarding.
