# Handback at d4b0e326 — HI-P1 and HI-E1 corrected

Tests only, in `repl-sidekick-recovery.test.ts`. No production source changed;
the submission correction at `f83e3554` is untouched.

## Revision

- SHA: `d4b0e326d76fa63c6ee7a97e189986bbd371243d`.
- Parent: `f83e35549dcddad0791f9492b8cdfe56dd7b4bf1`, preserved, as is every
  ancestor. No rebase, reset, amend, merge or push.
- Branch `agent/issue-883-pr2`; signature G, tarasm@gmail.com; clean before and
  after.
- One file, +119 / −50.
- **Not pushed.** PR #921 still names `940249af`.

## HI-P1 — the two new casts are gone

`frozenLocation()` and the entry reader both parsed with
`JSON.parse(line) as DurableEvent`. Both now call
`parseEntryRecords(body)` from `sidekick/history.ts`, which validates each
record and returns `DurableEvent[]`, and that typed result feeds `projectRepl`.
No other helper, assertion or local parser was introduced.

The file's two older `as unknown as DurableEvent` casts, at lines 144 and 1352,
are left exactly where they are: they construct deliberately malformed events
for other rows, and as the review says, they were never a licence for new ones.

## HI-E1 — the four assertions now establish their claims

**1. Byte equality across the cold opening.** `pairBytes()` reads both
`entries.jsonl` and `sidekick.jsonl` as exact strings before the mount, and the
row compares them again after opening and *before* any mutating action. Record
kinds and entry keys are satisfied by several different histories; byte equality
is what "a cold opening appends nothing" actually means.

**2. The reservation's own source.** `reservationOf()` reads the retained
Submit intent from the records, and the row first asserts that intent names
`entry-3` at ordinal 2 — the identity recovery has to find. Its `source` is then
counted in the admitted entries **three times**: on opening, while the successor
is held, and after it settled. Once in HI4's admitted arm, zero in HI5's absent
arm. The previous count was of `FIRST`, the first prior's source, which
established nothing about the reservation; no phase constant is duplicated here
any more.

**3. The finding before the successor's admission.** The row installs the
existing `operationGate()` through `useMountedRepl`, then holds the next append
to the entries file:

```text
holdNext(path.endsWith(ENTRIES_FILE))  →  Run  →  admission.started()
   read sidekick.jsonl   → one resolution, this history's outcome, its observed entry
   read entries.jsonl    → still exactly the entries the opening found
admission.release()      →  successor asserted as before
```

Holding the *operation* is what makes this an ordering claim: an append already
handed to the filesystem could not be stopped before the admission landed. The
`during` read asserts the entry keys are unchanged, so the resolution read above
is about order and not merely about existence. Afterwards the resolution is still
written exactly once.

**4. Cold provider inactivity, across the counters.** `ensured`, `prompts` and
`turns` are all empty and `started` is `false`, rather than a turn count alone.

Unchanged: the real subprocess-produced histories, the production-encoded
historical location, the outcome/observed-entry assertions, the head-opening
controls, and R2i/R2j/R2k.

**Break-it control.** Reverting only `coldReservation`'s acknowledged read still
fails both rows, so the strengthening did not cost the discrimination.

## Command

```sh
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
```

Exit 0 — **14 tests / 72 steps, 0 failed**, first run, no rerun needed.
[Output preserved](pr921-hie-command-2-first.log). `deno task check` exits 0.

Commands 1 and 3 were not repeated, as the prompt directs: their source
boundaries are untouched by this test-only change. Their results from the
review stand, including **command 3 red**.

## The returned limit stands, stated as the review states it

`EH1` and `UI10` in `repl-entries.test.ts` remain failing. They are
**pre-existing relative to `f83e3554`** — I am not claiming they predate #921,
and their exact onset is unestablished. They are not fixed, not weakened and not
bisected here, and command 3 is not reported as green.

## Continuity

Base `f83e3554`. Produced `d4b0e326` and this handback. Settled: HI-P1 and
HI-E1. Open: EH1/UI10 as a separate bounded assessment; integration queued;
#922 and B–D separate. Next action: review this commit.
