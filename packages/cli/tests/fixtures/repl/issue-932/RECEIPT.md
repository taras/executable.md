# Issue 932 saved-failure fixture — producer receipt

Produced by running
`deno run --allow-all packages/cli/tests/fixtures/repl/issue-932/produce.ts`
against the production REPL session, entry execution, canonical Prompt path
and paired chat storage assembled by
`packages/cli/tests/fixtures/repl/issue-883/sidekick-harness.ts`. The only
scripted part is the agent: `createFakeAcp()` answers each turn with the
reply `history.ts` states, and the ninth turn settles with stop reason
`refusal`, which is how a saved turn that streamed a complete reply and
still failed is produced. Nothing was appended by hand.

## What it holds

`entries.jsonl` — 22 records, 9983 bytes,
sha256 `981217b81c6a4ef01da4c73568b9b9e7f9f07394cad1dd78223bfd56151aec2a`

- **Entry 1 — failed, printed nothing.** Nine saved agent turns: eight
  completed, and a ninth that streamed a valid ballot JSON object and ended
  failed. Every prompt captures its reply with `as`, so the entry rendered
  nothing before the failure stopped it.
- **Entry 2 — completed.** A later settled entry, so the latest entry and
  the failed one are different entries.

`sidekick.jsonl` — 22 records, 27847 bytes,
sha256 `fbd0175e4195a88063191f49c015a9732fba3ae72eee3e7d9ff72d4e0e22b68b`

One exchange whose reply wrote `<REPL.EntryOutput entry="entry-2" />`, so the
chat retains a genuine control and control-outcome pair for that historical
read.

## Sanitation

Every string in both files is written in `history.ts` or by the harness: the
entry source, the prompts, the replies, the failure message and the chat.
The producing run's temporary data root is removed with its scope, and the
fake provider's own session store is no part of the fixture.

One byte of the run is not kept. The failed entry's close retains its error
the way the stream serializes one, and that includes the stack of the
process that raised it, which names the producing checkout's absolute paths.
The producer replaces exactly that member with
`the producing machine's stack is not part of this fixture; see RECEIPT.md`, and nothing else. No reader of this history looks
at it: the projection takes a failed outcome's message alone, so the stack
reaches no page, no record and no screen.
