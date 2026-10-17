# Upstream prerequisite stack — preservation copy at `6314e187`

A durable copy of the U4 handoff package and the authority and evidence files it
links, taken from the volatile bench directory
`/private/tmp/xmd-pr181-bench-rXAXyb/` on 2026-10-14.

**This copy authorizes nothing.** U4 implementation authorization is outstanding.
Nothing here was committed, pushed or cleaned up, and the originals were left in
place. `u4-planner-source/` is an unprepared source tree, not a place to build.

## What is here

| Group | Entries |
| --- | --- |
| U4 package | `upstream-repository-prerequisite-u4-{implementor-handoff,implementor-prompt,planner-status}.md`, `u4-base-AGENTS.txt`, `u4-frozen-evidence.json`, `u4-source-reference-inventory.txt` |
| U3 landed receipt | `upstream-repository-prerequisite-u3-landed.md` |
| Linked authority chain | stack plan, stack planner handoff, PR-stack plan and architecture review, reusable-interface prerequisite, consumer integration note, U1 and U3 handoffs, U3 planner/architect reviews, the Syntax and named-lookup architecture requests and resolutions |
| Linked evidence | the `u3-*` and `architect-pr1-*` logs, probes and prototypes those documents cite |
| Source trees | `u4-planner-source/` and `u4-planner-source.tar` (main at `6314e187`), `u3-planner-source/` (cited by the U3 handoff) |
| Point-in-time snapshots | `planner-installer-amendment-56723fe3/`, `planner-review-2b475121/`, copied whole |
| Off-bench evidence | `external/claude-501-6ed03464-scratchpad/` — four command receipts the PR1 planner reviews cite by absolute path |

Files were selected by transitively following every link from the four seed
documents (U4 handoff, U4 prompt, U4 planner status, U3 landed receipt) and
keeping each target that existed, plus every `u4-*` file in the bench root.

## Verification

| Check | Result |
| --- | --- |
| Files copied | 3505, each hash-compared to its source at copy time |
| Independent re-verification | `shasum -a 256 -c SHA256SUMS.txt` → 3505 OK, 0 failures |
| Relative-link behavior vs. originals | 34 markdown files, unresolved-link sets identical; **0 links broken by the copy**, 0 accidentally resolved |
| `u4-planner-source/` provenance | byte-exact match for git tree `3c4f45ca` of commit `6314e187`: 1713 blobs, 0 differing, 0 missing, 0 extra |
| Originals | untouched, mtimes unchanged |

`SHA256SUMS.txt` holds a SHA-256 for every copied file, paths relative to this
directory. Re-verify with `shasum -a 256 -c SHA256SUMS.txt` from here.

## Known pre-existing defects, reproduced rather than repaired

Nine relative links already dangled in the originals, all inside the two
point-in-time snapshot directories, which are partial copies whose siblings were
never snapshotted. The copy reproduces them exactly; repairing them would have
altered preserved content.

## External paths these documents still depend on

Eight of the copied documents cite
`/private/tmp/xmd-retained-repl-repositories/` (180 MB, present on 2026-10-14) by
`file:line` for the retained-repository consumer tree. That tree is outside this
authorization and was **not** copied, so those citations remain volatile.
Citations into the repository itself (`packages/...:line`) are stable in git.
