# PR 2, section 2 Planner review

REQUEST CHANGES at `ec118e26d0fe44ec7d9e6e9aae90f4910be3f321`.
Its parent is the accepted Core revision,
`79d404d04d02c3840892473b6f1b2cf540f3edd1`.

All three findings are closed by the
[PASS review at 43d53df7](pr2-section2-planner-review-43d53df7.md).
The findings and failing evidence below describe `ec118e26`.

This reviews the paired-history implementation and R1 evidence offered in this
feedback commit. It does not review the remaining CLI implementation or give a
delivery verdict. The implementation worktree stayed clean throughout review.

## Accepted implementation choices

The separate `sidekick/repository.ts` is ordinary module organization within
the accepted ownership boundary. It chooses the storage shape while
`journal.ts` retains entry writing and `sidekick/history.ts` retains the chat
protocol. Putting `movableWriter` in `journal.ts` is consistent with its entry
writer responsibility. No architecture amendment or further approval is needed.

The required `ReplChatStorage` discriminator is also accepted. Explicit
`legacy` and `paired` members make the required distinction visible to callers
without changing the agreed compatibility or migration behavior.

The facade and the held-append test establish useful parts of the handoff:
publication waits for the acknowledged append, and the same facade subsequently
writes to the new file. Root admission gating, the actual running entry task,
route preservation and provider ordering still require the forthcoming root
wiring and recovery evidence. A held facade alone is not that completed
integration evidence.

## Findings

### P1 — Upgrade re-encodes the acknowledged prefix

`sidekick/history.ts:808` reads and fingerprints the original text, but then
`publishPair` writes parsed events through `serializeDurableEvent` at line 728.
`parseDurableEvent` rebuilds event envelopes and descriptions in its own member
order. Serialization expressly preserves the object's insertion order; it does
not promise a canonical encoding.

The archived probe creates a valid event with a different member order using
the repository's ordinary serializer. Upgrade succeeds, but the copied bytes
differ from the original bytes. The owner's digest describes the original,
not the copied prefix. R1c passes only because its fixture happens to use the
parser's ordering.

The storage contract requires copying acknowledged entry bytes exactly. Keep
parsing for validity and the retained stream's event values, but publish the
exact acknowledged source bytes rather than re-serializing parsed events.
Fingerprint and copy the same acknowledged snapshot.

### P1 — Reopen does not establish the claimed retained origin

`openPair` at `sidekick/history.ts:765` checks an origin only when the owner has
one. `verifyRetainedOrigin` compares only the older file with the owner's byte
count and hash. Neither checks the copied entry prefix; `origin.records` is
never used to validate that prefix.

Two real-filesystem probes demonstrate successful opens that the accepted
contract requires to refuse:

- Upgrade an execution, leave its older file unchanged, then replace the new
  entry prefix with a different valid event. Reopen accepts the replacement.
- Create a new pair with no declared origin, then place an older execution file
  beside it. Reopen accepts both shapes despite having no retained-origin claim
  connecting them.

Validate the copied initial prefix against the declared origin, including its
record boundary/count, byte count and digest. Later entry records remain
permitted; the positive control for that case passes. When an older file exists,
require it to be the exact declared origin rather than ignoring it when the
owner has no origin. Refuse conflicts without modifying either history.

### P2 — The typed reader accepts malformed records and conflicting ownership

`parseSidekickRecord` at `sidekick/history.ts:300` casts a partially checked
object to the entire protocol. For example, `outcome` at line 320 admits
`{ "status": "err", "error": null }`, although `SerializedError` requires a
string message. The probe receives a typed ResponseRecord containing that null
error instead of a refusal. Other declared fields are similarly unchecked:
reference versions need not map strings to strings, conversation optional
fields are not parsed, and a control need not contain its declared arguments.
Closed record shapes also admit undeclared fields despite the parser's stated
contract.

At file level, `readPublishedPair` checks only the first two records. Appending
a second owner naming another execution after `ready` still opens successfully.
That is conflicting ownership, already part of R1's refusal contract.

Parse and construct typed records from checked members, including nested
canonical data, rather than asserting their types. Enforce the publication
grammar across the file so a later owner/ready cannot redefine it. Keep
diagnostics free of retained payloads. This finding does not demand the
unfinished model or every R2 recovery scenario in this section review.

## Evidence

Commands ran in `.claude/worktrees/issue-883-pr2` at the exact reviewed commit:

```sh
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-admission.test.ts
deno task test packages/cli/tests/repl-history.test.ts
pnpm exec oxlint -c .oxlintrc.json packages/cli/src/repl/journal.ts packages/cli/src/repl/sidekick/history.ts packages/cli/src/repl/sidekick/repository.ts packages/cli/tests/repl-sidekick-storage.test.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section2-storage.probe.ts
```

The first command passes: 29 tests, 112 steps. The second passes: 6 tests,
24 steps. Together these reproduce the 13 storage cases and the 32 existing
regression tests with 123 steps. The targeted lint command exits 0.

The reviewer probe has five failing assertions and one passing control, all
within one BDD group. The failures are exact-byte preservation, changed copied
prefix refusal, undeclared older origin refusal, conflicting later owner
refusal, and null serialized-error refusal. The passing control appends later
entry work and reopens successfully. The probe and its output are retained in
[pr2-section2-storage.probe.ts](pr2-section2-storage.probe.ts) and
[pr2-section2-storage.probe.log](pr2-section2-storage.probe.log).

An initial command named nonexistent `repl-journal.test.ts` and stopped before
running tests. The corrected commands above are the review evidence. Node/Bun
results are the Implementor's reported evidence; this review independently ran
Deno. No CI was inspected.

## Revision prompt

Correct PR 2 section 2 from `ec118e26` without changing the accepted module split
or the required legacy/paired discriminator. Preserve the existing draft and
unrelated work.

1. Copy the exact acknowledged legacy entry bytes into the pair. Validate and
   fingerprint the same snapshot; do not use parsed-event reserialization as
   the migration copy. Preserve the append wait and synchronous writer switch.
2. On opening a pair, validate its copied prefix against the declared origin
   and reject an older file with no matching declared origin. Permit later
   entry appends. Every refusal leaves both histories unchanged.
3. Replace assertion-based record admission with complete typed parsing, using
   canonical serialized data conventions. Reject malformed serialized errors
   and conflicting publication records anywhere in the file, with sanitized
   diagnostics.

Add the five demonstrated regressions to the storage tier and retain the later
append control. Run the storage file and the four existing regression files
listed above. Commit once the focused evidence passes and return the exact
SHA/parent, commands/results and corrected R1 mapping. Broad checks and CI are
separate delivery evidence. Then continue the already planned model, root
wiring, R2 and sections 3–5; this correction does not enlarge R1–R8 or the
36-frame threshold.

## Continuity

Reviewed base: `79d404d04d02c3840892473b6f1b2cf540f3edd1`.
Reviewed feedback: `ec118e26d0fe44ec7d9e6e9aae90f4910be3f321`.
Accepted choices: repository module split, entry-writer placement and required
storage discriminator. Blockers: the three findings above. Next Implementor
action: return a focused correction feedback commit for this section.
