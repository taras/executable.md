# Issue 932 saved-failure fixture — receipt

Two halves of one paired execution, produced by real runs of this REPL against
the scripted provider. They were taken at different revisions, and the
difference matters, so each is stated separately below. This receipt is
maintained by hand; `produce.ts` writes `entries.jsonl` and prints its digest.

## `entries.jsonl` — the saved failure

22 records, 9983 bytes, sha256
`981217b81c6a4ef01da4c73568b9b9e7f9f07394cad1dd78223bfd56151aec2a`.

- **How:** `deno run --allow-all packages/cli/tests/fixtures/repl/issue-932/produce.ts`,
  against the production REPL session, entry executions, canonical Prompt path
  and paired storage assembled by
  `packages/cli/tests/fixtures/repl/issue-883/sidekick-harness.ts`. The only
  scripted part is the agent: `createFakeAcp()` answers each turn with the
  reply `history.ts` states, and the ninth settles with stop reason `refusal`,
  which is how a saved turn that streamed a complete reply and still failed is
  produced. Nothing was appended by hand.
- **Entry 1 — failed, printed nothing.** Nine saved agent turns: eight
  completed, and a ninth that streamed a valid ballot JSON object and ended
  failed. Every prompt captures its reply with `as`, so the entry rendered
  nothing before the failure stopped it.
- **Entry 2 — completed.** A later settled entry, so the latest entry and the
  failed one are different entries.

This half does not depend on which controls a response may write, so
`produce.ts` reproduces it on any current revision.

## `sidekick.jsonl` — a pinned pre-retirement chat

22 records, 27847 bytes, sha256
`fbd0175e4195a88063191f49c015a9732fba3ae72eee3e7d9ff72d4e0e22b68b`.

One exchange whose reply wrote `<REPL.EntryOutput entry="entry-2" />`, so the
chat retains that control's own `control` and `control-outcome` pair with its
retained window observation. `repl-sidekick-recovery.test.ts` reads that pair
through `designatedResults` to establish that a saved result of the retired
read still renders as the window it was.

**It is pinned, and a current ceiling cannot produce it.** `REPL.EntryOutput`
was removed from response admission when `<REPL.Entry.Output />` replaced it,
so a reply written now that names it is refused before any control runs — which
is what `repl-sidekick-controls.test.ts` asserts. These bytes were produced
**before that retirement**, by `produce.ts` as it stood at signed commit
`b6eb083e0838db1a80632ff43921917a2b21a769`, where the name was still admitted.

The recipe, for reproducing it at that revision or any earlier one that still
admitted the name: after the two entries above, script

```
<REPL.EntryOutput entry="entry-2" />
```

then `<Output>Read it.</Output>`, and send the message
`what did the second entry print?` through the harness owner.

Do not regenerate this half by re-admitting the retired name on a corrected
ceiling, and do not replace it with a dotted read: what it exists to prove is
that a chat saved before the replacement is still readable.

## Sanitation

Every string in both files is written in `history.ts` or by the harness: the
entry source, the prompts, the replies, the failure message and the chat. The
producing runs' temporary data roots are removed with their scopes, and the
fake provider's own session store is no part of the fixture.

One byte of the entry half is not the run's. A failed entry's close retains its
error the way the stream serializes one, and that includes the stack of the
process that raised it, which names the producing checkout's absolute paths.
`produce.ts` replaces exactly that member with
`the producing machine's stack is not part of this fixture; see RECEIPT.md`,
and nothing else. No reader of this history looks at it: the projection takes a
failed outcome's message alone, so the stack reaches no page, no record and no
screen.

A provider session key digests the working directory its run was made in, and
each run gets a fresh temporary one. Regenerating either half therefore changes
its bytes and its digest; the figures above describe the checked-in files.
