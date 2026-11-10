# 1234 legacy-orphan fixture — writer receipt

A paired Sidekick chat whose only response is numbered differently from the
canonical turn it ran in, produced by the writer that numbered responses from
the host's message ordinal.

- Writer SHA: `a45f6f1e3bf8af328e33294f9235b1e3c7981ae6`
- How: the production storage path, through four real subprocess phases of
  `packages/cli/tests/fixtures/repl/issue-883/recovery-phase.ts` over a real
  repository root — `chat-open`; `chat-say` with `stop: "turn"`, so the first
  message is saved and its canonical Prompt is never written; `chat-say` with
  `stopAtQuestion`; then a cold `chat-read`. Nothing was appended by hand.
- Source and transport are test-authored throughout: agent `stub`, native
  conversation `native-1234-legacy`. No saved conversation of the user's and no
  native credential is involved, and neither file names a host path.

## What it holds

`sidekick.jsonl` — 17 records, 29697 bytes, sha256
`620c73e51ec01f0ce0041617fcaa46cfe95085727024ea85c21e5e1709388889`

`entries.jsonl` — empty, sha256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The chat
submitted no entry.

Two saved messages, ordinals 1 (`interrupted request`, no canonical turn) and 2
(`prepare something`, canonical `turn:1`). The second message's reply filled
the draft with `<REPL.EntryInput>Legacy draft.</REPL.EntryInput>` and then asked
`<Elicit …>Which one?</Elicit>`; the process ended with the question pending.
So canonical `turn:1` holds, under `response:2`:

| record | order | component | outcome |
| --- | --- | --- | --- |
| `control` | 0 | `REPL.EntryInput` | `control-outcome` ok |
| `control` | 1 | `Elicit` | none |

There is no `response` record: the evaluation never finished. Its root
evaluation is `generated:response:2` on `generated_root:1`.

Read cold at the writer SHA, it is readable, asks the provider nothing and
appends nothing:

```
chat        person(1, turn null) / person(2, turn 1) / saved(turn 1)
operations  [{ response: "response:2", order: 0, component: "REPL.EntryInput", status: "ok" }]
unfinished  [["Elicit", "unfinished"]]
```

A response named after its actual turn would call the next canonical turn's
response `response:2` and file its first control in this orphan's order-0
slot, which is why the fixture has to come from the old writer rather than
from the one under test.
