# Recovery

Read this when continuing work that was interrupted, when a conversation has
been reopened, or when an entry failed and you need to find out what it actually
did.

## Applies to

Sidekick responses deciding what to do next, and the entries they go on to
prepare.

## Instructions

- Two different records exist. This conversation's history is what was said and
  what your controls returned. The REPL's entry History is what was *run*. They
  answer different questions, and neither is a summary of the other.
- An operation that began and never answered is reported to you as unfinished.
  It is a fact, not a gap: something started and its result is unknown.
- Act on actual results. A completed effect stays completed — a later failure
  does not undo an earlier success — so correct the failure that happened
  without repeating the work that already did.
- Start a failed entry at its Journal. `<REPL.Entry.Journal entry={2} />`
  answers with that entry's complete failure message, how its agent turns ended,
  and a record for each thing it saved. An entry that printed nothing still has
  all of that.
- Read the turn the Journal located. A record with a `prompt` number names a
  saved agent turn, and `<REPL.Entry.Prompt entry={2} prompt={9} />` reads it.
  `field="reply"` is what the agent said, `field="request"` is what it was
  asked, and `field="error"` is the complete message the turn failed with.
- Read `<REPL.Entry.Source entry={2} />` for the exact source that was admitted,
  and `<REPL.Entry.Output entry={2} />` for what the entry printed. Ask for them
  when you need them; a Journal read is usually enough to decide what went
  wrong.
- Inspect before retrying. Submitting the same draft again performs its work a
  second time, and an entry that failed late may have completed most of it.
- A reply you can parse is not a turn that succeeded. A turn whose
  `promptStatus` is `failed` failed, whatever its text looks like — read
  `field="error"` before treating its JSON as an answer.
- Say what you suspect as a hypothesis, and name the evidence you read it from.
  The records say what was saved; why it happened is your reading of them.
- Missing evidence is missing evidence. A turn with no saved record did not
  record an outcome; it does not establish that nothing reached the outside
  world, so do not report that nothing happened.
- `text: null` and `text: ""` are different answers. Null is a turn that
  recorded nothing for that field — a completed turn has no error — and the
  empty string is a turn that recorded emptiness.
- `status: "running"` is the entry this process is executing now. `unfinished`
  is an entry whose outcome was never recorded, which is what an interrupted
  run leaves behind. Neither is a failure, and a read waits for neither.
- Reading performs nothing. No read opens an entry, resumes one, runs its
  source or asks an agent anything, so an entry you inspect is left exactly as
  it was.
- When the host cannot establish what happened, it refuses rather than guessing,
  and says so. That refusal is the answer — do not retry the same request hoping
  for a different reading of the same records.
- Reopening by itself starts nothing. Nothing is submitted and no turn is taken
  until the person asks for something.

## Example

```xmd
<REPL.Entry.Journal entry={2} />
```

The host answers with that entry's page as feedback, then asks for your next
response:

```json
{
  "entry": 2,
  "status": "failed",
  "failure": "agent prompt failed with stop reason \"refusal\"",
  "prompts": { "completed": 8, "failed": 1, "cancelled": 0 },
  "records": [
    {
      "marker": "entry-2:yield:root:18",
      "type": "agent_prompt",
      "name": "prompt:<eval>:9:1#0",
      "status": "failed",
      "position": { "path": "<eval>", "generatedSource": null, "offset": 632, "line": 9, "column": 1 },
      "prompt": 9,
      "agent": "claude"
    }
  ],
  "offset": 0,
  "length": 20,
  "limit": 20,
  "previous": null,
  "next": null
}
```

The failed record names prompt 9, so that is the turn to read:

```xmd
<REPL.Entry.Prompt entry={2} prompt={9} field="error" />
```

## Reading more than one page

Every page is bounded — 4096 code points of text, or 20 records — and `previous`
and `next` hold the complete arguments of the read beside it, or `null` where
there is none. Write them back as they came:

```xmd
<REPL.Entry.Prompt entry={2} prompt={9} field="reply" offset={4096} limit={4096} />
```

Those arguments state the entry and the prompt as exact numbers, so the read
they describe stays the same read after another entry has been admitted. An
omitted `entry` means the latest entry, and a negative one counts back from it;
both resolve when the read happens rather than when you write it.

## Common mistake

Re-submitting the draft you prepared before the interruption, on the assumption
that it never ran. If the entry was admitted, its work is in the entry History
and submitting again performs it twice. Read its Journal first, then continue
from what is there.

## Read next

Read `<Guide.Bindings />` for reading published values, and `<Guide.Lifetimes />`
for what an interruption releases.
