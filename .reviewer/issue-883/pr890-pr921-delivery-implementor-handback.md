# The two replacement PRs, restacked onto current main and published

**Planner continuity addendum:** the subsequent Implementor report advances
this handback to #890 merged at 98cd350b and PR2 7e7ffd27 with the L2 repair.
See [the current continuation](pr921-delivery-continuation-7e7ffd27.md).
The original author account below remains historical through c10a2062; it does
not establish CI completion or readiness for the new head.

Implementor handback for
[the final delivery continuation](pr890-pr921-final-delivery-continuation-c2536dd0.md)
and [the full delivery handoff](pr890-pr921-final-delivery-implementor-handoff-27da762b.md).
Both PRs are rebased, verified and published. Merging is the remaining step and
is reported at the end.

## Target and heads

**Main had moved.** The recorded target `4702890c` was stale: current main is
`fd8ae5214b3994e6ec32061e41783a386368b7fc` (#927), nineteen commits and four
merged #181 PRs ahead of PR1's old base `986948ea`. Rebased onto the actual
head, as the handoff directs.

| | Source | New head | Base |
| --- | --- | --- | --- |
| PR1 / #890 | `85da74b9` | **`dbc0fc92886ea7ad0b294e3a0f4277ff2bcbc998`** | main `fd8ae521` |
| PR2 / #921 | `c2536dd0` | **`879aba8489ea61d3e6df87c0c039a11aa648ecb4`** | `agent/issue-883-pr1` at `dbc0fc92` |

Every commit on both branches is signed G. #890 was `CONFLICTING` before the
restack and is `MERGEABLE` after it; #921 is `MERGEABLE`.

**No `deno task setup` was needed or run.** The integration plan recorded that
main's dependency inputs differ, and at this target they do not: `deno.lock`,
`pnpm-lock.yaml`, `package.json` and every `deno.json` are byte-identical
between `986948ea` and `fd8ae521`. Nothing was installed, no lockfile touched.

## Preservation

Fresh refs made before anything moved, all still in place:
`delivery-source/issue-883-pr1-85da74b9`,
`delivery-source/issue-883-pr2-c2536dd0`,
`delivery-source/issue-883-pr2-base-27da762b`,
`delivery-source/issue-883-pr2-padding-6ca23952`,
`delivery-source/issue-883-pr2-replies-2ac3cb28`,
`delivery-target/main-fd8ae521`.

Untouched, as before: `agent/issue-883-pr1` `79d404d0`, `agent/issue-883-pr2`
`d4b0e326`, `agent/issue-883-pr2-isolated` `99c27d92`,
`pre-integration/issue-883-pr2-d4b0e326` `d4b0e326`. The replacement heads were
published to the remote branch *names* by explicit refspec, so those local
source branches still point where they did. No unrelated worktree was touched
and the shared stash stack was never used.

## Publication

Remote SHAs read immediately before pushing, and both matched the handoff's
recorded observations exactly — `agent/issue-883-pr1` at `79d404d0` and
`agent/issue-883-pr2` at `940249af`. Each push carried its own explicit lease:

```
--force-with-lease=refs/heads/agent/issue-883-pr1:79d404d04d02c3840892473b6f1b2cf540f3edd1
--force-with-lease=refs/heads/agent/issue-883-pr2:940249af47159a3bbd960b8ca8df3f10bb53811c
```

Both leases held. Descriptions updated on both PRs with the new target, the
stack dependency, the restack account and the evidence below; the existing
bodies and review discussion were kept and appended to, not replaced.

## PR1 evidence — the five frozen selections

| Selection | Result |
| --- | --- |
| host-generated-root, generated-xmd-root, generated-xmd-preview, agent-conversation | 31 passed (141 steps) |
| generated-xmd, generated-composition, generated-selection, generated-owner-metadata, evaluation-profile, evaluate-provider-lifetime | 34 passed (266 steps) |
| execution-protocol, document-output-api, syntax-component, syntax-api, syntax-loaded-copy | 14 passed (143 steps) |
| agent-components, agent-function-components, agent-session-launch, acp host-conversation, acp loaded-copy | 24 passed (160 steps) |
| workflow generated-observations, evaluate-component, evaluate-workflow | 8 passed (33 steps) |

**111 tests, 743 steps, zero failures**, all exit 0. Gates: `check` 0, `lint` 0,
`validate:docs` 0, `check:jsr` ends `Success Dry run complete`.

`range-diff` against the reviewed source: both commits `=`. PR1 overlaps main's
nineteen-commit range on two documentation files only, and neither conflicted.

## PR2 evidence — the seven frozen selections

| Selection | Result |
| --- | --- |
| core host-generated-root, generated-xmd-root, agent-conversation, agent-function-components, agent-session-launch, agent-session-setup | 50 passed (278 steps) |
| acp provider, native-launch, host-conversation, loaded-copy | 29 passed (224 steps) |
| generated-xmd-preview, secret-detection, workflow-agent-checkpoints, workflow-agent, workflow-agent-sessions | 11 passed (114 steps) |
| repl-sidekick presentation, journey, lifecycle | 39 passed (141 steps) |
| repl-sidekick storage, recovery, configuration, controls, output | 32 passed (173 steps) |
| repl-entries, repl-history, repl-agent-execution, repl-journey, repl-forms | 90 passed (265 steps) |
| repl-route, repl-layout-admission, repl-presentation-style, repl-source-reading, repl-execution, repl-lifecycle | 46 passed (190 steps) |
| **the eight main-supplied consumers** | 17 passed (97 steps) |

**314 tests, 1,482 steps, zero failures.** Gates: `check` 0, `lint` 0,
`validate:docs` 0, `check:jsr` ends `Success Dry run complete`.

`range-diff` against the reviewed source: seven of eight commits `=`. Only the
first differs, and only by the conflict resolutions accounted for below.

## The integration, in detail

Six conflicts, all in PR2's first commit. Every one resolved by keeping both
sides' behaviour:

- **`cli.ts`** — main's entry-capability selection (`replHost.select()`) and its
  renamed install (`replHost.install()`), beside this PR's `sidekickAgent`
  option on `assembleReplProfile`. Main's ordering comment is honoured: select,
  then profile, then install.
- **`repl-profile.ts`** — main's `entryInstallation` member and its read, beside
  the four Sidekick profile members and `sidekickAgent`/`sidekickAssembly`.
- **`compiled-repl.ts`, `deno-repl.ts`** — union of imports; main's
  `HelperAssembly` parameter kept with this PR's `replHostFacts`/`XMD_VERSION`.
- **`git/run-composition/provider.ts`** — this PR's renamed module import plus
  main's `lazily`.
- **`architecture.md`, `specs/repl-spec.md`** — main's new sections kept whole;
  the one genuinely divergent line is the `xmd repl` options bullet, which now
  carries main's wording *and* `--sidekick-agent`.

**The rename main did not know about.** This PR renames
`git/src/deno/run-composition/placement.ts` to `checkout-layout.ts` (and
`composition/placement.ts` to `checkout-paths.ts`) as part of #883's vocabulary
retirement. Main has since added five importers of the old path — two sources
and three tests under `retained-repository/` — which auto-merged untouched and
pointed at a module that no longer exists. They now reach it under its successor
name. `module-partition.test.ts` already declared the renamed modules.

## What the delivery gates found

Three real failures, none waived.

**1. EH1 and UI10 — and UI11 and UI13, which are the same thing.** Four rows of
`repl-entries.test.ts` failed. The cause is this PR's own accepted width: the
36-column sidebar and two-cell gutters leave the Transcript six columns
narrower, so sentences that used to end on one row now wrap.

I checked whether anything was lost before changing a line, and nothing is:
guidance keeps its continuations as `guidance:row:1` and `guidance:row:2`, and a
caption keeps its own as `reading:caption:output+33` — the key carries the offset
it was cut at. Each row keeps the space the fitting cut at, exactly as `cutAt`
documents. So the four readers now join the rows their reading was cut into
instead of reading the first one. UI13 was already wrap-aware from #881 and
failed only because it trimmed each row *before* joining, deleting the one
character that stood between two words.

**This is the EH1/UI10 obligation discharged, not the exception reapplied.** No
assertion was weakened: each still requires the whole sentence, and a truncation
leaves words missing or a mark behind and still fails.

**2. Two PTY journeys.** `repl-issues-pty` and `repl-repositories-pty` waited
for `filed at <url>` and `again is <object-id>` on one row. The same six columns
now cut those tokens mid-word. Added one `showingAcross` helper beside
`showing`, used at exactly those three call sites, documented with what it
proves (every non-space character, in order, within four adjacent rows) and what
it gives up (inter-word spacing). An elided row keeps its `…`, so a truncated
token still fails.

**3. `check:jsr` on PR2.** `AgentConversationProvider` had no explicit type, and
a public symbol cannot have an inferred one. Annotated as `Context<… |
undefined>`, matching the six other exported contexts in `packages/core`. This
was a pre-existing defect in the accepted PR2 source, invisible until a delivery
gate ran: `check:jsr` was never one of the feedback commands.

All of it is in **one new eighth commit** on PR2, `879aba84`, rather than folded
into a reviewed increment, so the work the reviewers have not seen is the work
they can see.

## Two things I corrected in my own work

- **A stray file reached a commit.** Resolving the first conflict I used
  `git add -A`, which swept up `xmd-troubleshooting-recommendations.txt` — an
  untracked notes file in the worktree, in none of main, PR1 or the accepted PR2
  source. I rewrote that commit to drop the path and left the file on disk,
  untracked and unmodified. `preserve/pr2-rebase-with-stray-a7c1cd9c` holds the
  discarded line.
- **A doc comment lost its opener.** Keeping both sides of the
  `repl-profile.ts` member conflict left a comment body outside any comment,
  because the `/**` was in the shared text above the split. The whole stack
  stopped parsing; `deno task check` caught it immediately and the fix is folded
  into the commit whose resolution it belongs to.

## One recorded flake

`repl-lifecycle`'s `L2: an element waiting on a question says so` failed once
and passed on re-run, at the same revision. It is the known flake for that
question phase. First failure preserved; the rerun does not erase it.

## What CI found that no local selection runs

Local gates were green and CI still failed nine jobs on PR2's first published
head. Three distinct causes, all the accepted width meeting readers that assume
a row, and every one of them outside every frozen selection:

- **`repl-terminal.test.ts`** asserts the whole frame's geometry as an
  independent table of literal rectangles and still held the pre-#883 shares. It
  now states the accepted ones — 36/62/62 from 160 columns, 36/42/42 from 120 —
  and the implementation, asked for those numbers, agrees with the table. This
  file is in none of the twelve selections.
- **Two runtime refusals**, `no Repository composition provider is installed`
  and `no Issue provider is installed`, are sentences the narrower Transcript
  wraps. They only happen on runtimes that install no such provider, so a Deno
  run cannot reach them at all; they failed on Node and Bun only.
- **Two settled facts read off whichever frame was current** — the draft holding
  focus at startup, and the draft cleared by an admission.

  The boundary, which is what the fix is about: each of these facts is resolved
  in the frame that carries it, and both rows read them immediately after the
  preceding step instead of waiting for that frame. Nothing guarantees the
  frame has been built by then, so the rows were asserting a readiness they
  never established. Both now wait through the fixture's own `awaiting`, which
  is what the rest of the file already does and what `sendMessage` documents.
  The startup row additionally states that the Sidekick's box does *not* hold
  focus, which was only implied before.

  They failed in CI on two runs and passed locally throughout. I am not
  treating that as proof of determinism — repeated failure is not a proof — and
  the repair stands on the missing wait above rather than on how often it was
  observed.

Each fix was verified on the runtime that failed: both PTY files under Bun and
Node, the frame file under Deno and Node, and the whole presentation file under
Bun. Two further published commits carry them, `d8890e40` and `c10a2062`.

One Windows `filesystem-contract` job failed on `Install dependencies` with
`Failed caching npm package '@oxlint/binding-win32-x64-msvc' — error reading a
body from connection`. Infrastructure, not attributable; it passed on the next
run with no change of mine.

## Merge state

**#890 is MERGED.** Merge SHA `98cd350b08082d57c711b450973257fab6bb8973`, by
`taras`, 2026-10-17T01:01:38Z, at head `dbc0fc92`. A merge commit, so both PR1
commits are preserved as ancestors of `main` rather than squashed.

**Both PRs are merged. Delivery is complete.**

| PR | Final head | Checks | Merge SHA |
| --- | --- | --- | --- |
| #890 | `dbc0fc92886ea7ad0b294e3a0f4277ff2bcbc998` | 43 pass, 1 skipped | `98cd350b08082d57c711b450973257fab6bb8973` |
| #921 | `7e7ffd27f819073ccb02994dab8ff50bf075a4e7` | 43 pass, 1 skipped | `ec4ba00378107f13bf6adcce0fad208507e4a2a7` |

`main` is `ec4ba003`, and both heads are ancestors of it. Both were merge
commits rather than squashes, so every reviewed commit is preserved in `main`'s
history. Merged by `taras` at 01:01:38Z and 02:33:06Z on 2026-10-17 — the human
merges that resolved the approval barrier below.

#921 was rebased onto `98cd350b` after #890 merged — not by me. Verified
faithful before building on it: all ten commits `=` by `range-diff` and the tree
byte-identical to the head I had published. GitHub retargeted it to `main` and
it is no longer a draft. Its head now contains `main`, which is what the
ruleset's `strict: true` requires, and `green` passes on that exact head.

My own published line is preserved at `preserve/pr2-delivery-c10a2062`.

`main`'s ruleset requires one status check, the `green` aggregate, with
`strict: true`, and **zero approving reviews**. `green` passes on both exact
heads, and both heads were re-read against the local branches immediately
before each publication.

**Merging is the one step I did not take**, and this is the exact operation and
the exact reason.

`gh pr merge 890 --merge` is refused by GitHub itself:

```
GraphQL: This pull request is part of a stack and must be merged using the
asynchronous merge REST API. (mergePullRequest)
```

So the operation becomes:

```
gh api -X PUT repos/:owner/:repo/pulls/890/merge \
  -f merge_method=merge \
  -f sha=dbc0fc92886ea7ad0b294e3a0f4277ff2bcbc998
```

which was denied here, verbatim:

```
Permission for this action was denied by the Claude Code auto mode classifier.
Reason: [Merge Without Review].
```

I did not switch endpoint or tool, pass an admin flag, or retry it in another
shape. The repository ruleset allowing zero approvals does not override that
separate approval decision.

#890 was then merged by a human through the normal protected workflow, which is
how that barrier was resolved. Everything after it is done: #921 sits on that
main history with only its own delta, retargeted to `main`, ready rather than
draft, up to date with `main` as `strict: true` requires, and holding its own
main-target verdict — 43 passing checks with `green` passing on `7e7ffd27`,
which is the verdict its earlier stacked green did not substitute for.

**#921 was then merged by a human too**, for the same reason: the REST merge
call is denied to this session as a merge without review. Both merges went
through the normal protected workflow. No administrative bypass was needed or
requested, and nothing is outstanding.

## Carry-forward

**The L2 lifecycle flake — #935 — then failed CI and was repaired at the cause**,
not re-run. It was the single remaining failing check on #921.

The row sampled the lifecycle after a fixed five `sleep(0)` turns. The phases a
consumer is told travel through their own queue and the question is published
from inside the element, so how many turns that takes depends on what else the
runner has queued; with another suite beside it the sample catches
`Elicit:enter:`, the phase immediately before the one the row is about. It now
waits for a signal narrower than its claim — that *some* element has reported
waiting on something — and still asserts whole which element, which phase, what
it waits on, and that it is the only one.

Discriminating evidence, same revision either way: with the fixed count the
six-file selection failed once in three runs; with the wait it passed two of two
six-file, three of three two-file, and the file alone. The sibling fixed-turn
loop below it keeps its count, because that one asserts the reading stays
*empty*, where more turns only strengthen the claim.

`repl-lifecycle.test.ts` is a `main` file from #881; PR2 otherwise changes one
line of it. #935 carries both earlier occurrences and this repair; closing it is
for whoever accepts the fix, and intermittency means the passing runs are
supporting evidence rather than proof — the case rests on the cause plus the
control that reproduces the failure with only that line changed.

The Windows `filesystem-contract` failure was an infrastructure download
failure during `Install dependencies`. It is recorded as that, not as a product
fix, and nothing of mine changed before it passed.

## Deferred, unchanged

History self-stacking, conversation labels, the narrow pending-question layout
(Task D), Parse #922, #928–#933, unfamiliar-agent teaching and the 36-frame
capture packet all remain outside this delivery.
