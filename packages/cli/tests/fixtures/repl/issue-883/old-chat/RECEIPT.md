# IN5 old-chat fixture — writer receipt

A paired Sidekick chat, produced by running the **pre-integration writer at
accepted source C** before the PR2 worktree left that commit.

- Writer SHA: `d4b0e326d76fa63c6ee7a97e189986bbd371243d` (accepted source C)
- Produced: 2026-10-16, in `.claude/worktrees/issue-883-pr2` while it was still
  checked out at C
- How: the production storage path, through three real subprocess phases of
  `packages/cli/tests/fixtures/repl/issue-883/recovery-phase.ts` —
  `chat-open`, then `chat-say` with one completed reply, then `chat-say` with
  `stopAtQuestion` — over a real repository root. Nothing was appended by hand.
- Source and transport are test-authored throughout: agent `stub`, command
  `stub-cmd`, root `agent/conversation.md` holding `<AgentConversationHost />`.
  No saved conversation of the user's and no native credential is involved.

## What it holds

`xmd/repl/v1/chat/sidekick.jsonl` — 20 records, 25407 bytes,
sha256 `1097cd1700c5c6ca70a5ebe1b3c4e6f151fc976f164fa217cab016b0350cdea6`

Its two `message` records were brought to the current record format in place
when `id` and `origin` became required of every saved message: there is one
supported format, so a stored record moves to it rather than being read as an
earlier one. That edit added those two fields to those records and changed
nothing else — the run-produced content, record count and order are the ones
the phases below produced.

| kind | count |
| --- | --- |
| owner | 1 |
| ready | 1 |
| conversation | 2 |
| event | 9 |
| reference | 1 |
| message | 2 |
| response | 1 |
| control | 2 |
| control-outcome | 1 |

`xmd/repl/v1/chat/entries.jsonl` — empty, sha256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The chat
authored no entry, so its entry half is the empty file the pair is created with.

## The two responses

**Turn 1 — completed.** The person said `tell me something`; the reply was
`<Output>The first reply.</Output>`, which completed and is retained as a
`response` record with `outcome.status: "ok"`, `hasOutput: true` and output
`The first reply.`

**Turn 2 — interrupted, holding a settled control.** The person said
`prepare something`; the reply filled the shared draft with
`<REPL.EntryInput>Prepared body.</REPL.EntryInput>` and then asked
`<Elicit …>Which one?</Elicit>`. The process ended with the question pending.
So the chat holds a `control` and its `control-outcome` for the fill that
*did* happen, and a second `control` with no outcome for the question that was
still waiting — which is what an interrupted ask is.

Read cold at C, that is:

```
chat        person/reply/person/saved
operations  [{ response: "response:2", order: 0, component: "REPL.EntryInput", status: "ok" }]
unfinished  [["Elicit", "unfinished"]]
```

Both turns ran in the native conversation `native-old`, which the retained
canonical turns name. There is no separate mapping record, by design.

## Marker receipt

Both root evaluations are **marker 2** — the record shape the writer at C
wrote — each on its own `generated_root:N` sequence:

| sequence | coroutine | durable name | marker | decision |
| --- | --- | --- | --- | --- |
| 5 | `generated_root:1` | `generated:response:1` | **2** | admitted |
| 8 | `generated_root:2` | `generated:response:2` | **2** | admitted |

This is the old marker-2 root history IN4 and IN5 name, produced by the old
writer rather than built by hand. Replacement PR1's `E6b`/`GRM5` fixtures are
hand-built to this same shape and were accepted only for the marker-refusal and
sequence-partition observations; this one is the run-produced article.

## What was deliberately left out

The run also wrote the fake provider's own store at
`acpx/sessions/xmd%3Av1%3A…%3A9c5b471b74ed5c75.json`. It is **not** part of the
fixture, for two reasons that agree:

- it is the provider's account, not the chat's, and the established native
  conversation is read from the retained canonical turn rather than from a
  mapping record; and
- its `cwd` names this machine's worktree and its file name digests that
  directory, so it is machine-specific and would be the one unsanitary byte in
  the fixture.

Nothing else in either `.jsonl` file names a host path, a home directory or a
credential — checked, and the chat journal holds zero occurrences of `/Users/`
or `/var/folders`.
