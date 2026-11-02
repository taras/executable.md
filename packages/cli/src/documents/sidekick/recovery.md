# Recovery

Read this when continuing work that was interrupted, when a conversation has
been reopened, or when an entry failed and you need to find out what it actually
did.

## Applies to

Sidekick responses deciding what to do next, and the entries they go on to
prepare.

## Instructions

- When the person chooses recovery, treat the supplied new instruction as a
  distinct request in the original conversation. Earlier feedback acceptance
  remains unknown. Do not resend that feedback, re-evaluate its response, or
  submit established work again. Read the retained entry results before
  proposing the next step.
- A failed or cancelled provider turn runs no response controls, even when its
  saved text contains valid XMD. Keep its failure and partial text as evidence.
- Only the person can choose a different conversation. In a parent-owned child,
  that choice first shows an actual fresh attachment command and
  `{sessionId: "<fresh-sessionId>"}`. The original conversation stays selected
  until the person chooses `[saved reference; continue]`. Applying the receipt
  frame or losing the UI connection does not acknowledge it. Continuing
  disconnects that UI; explicit attachment with the saved reference reaches the
  same live REPL and sends nothing. The old reference never follows the new
  conversation; the owning parent can still use it for Shutdown.
- Two different records exist. This conversation's history is what was said and
  what your controls returned. The REPL's entry History is what was *run*. They
  answer different questions, and neither is a summary of the other.
- An operation that began and never answered is reported to you as unfinished.
  It is a fact, not a gap: something started and its result is unknown.
- Act on actual results. A completed effect stays completed — a later failure
  does not undo an earlier success — so correct the failure that happened
  without repeating the work that already did.
- Start a failed entry at its Journal. `<REPL.Entry.Journal entry={2} />`
  selects that entry's complete failure, prompt counts and saved records under
  `value`. If the result exceeds the response bound, select the relevant records
  or a command channel with `yq` as shown below.
- Distinguish commands from agent turns and document output. An `exec` record's
  `.exec.exitCode` is the actual saved command exit; its protocol `status: "ok"`
  does not mean exit zero. `.exec.stdout` and `.exec.stderr` are independently
  retained channels, including output hidden by `silent`. An absent member was
  not retained; an empty string was retained empty. An error, cancellation or
  missing result supplies no invented exit or channel content.
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

The failed receipt names entry 2. Find its saved commands, including any beyond
an earlier record page:

```xmd
<REPL.Entry.Journal entry={2} yq={'[.records[] | select(.type == "exec" and .exec.exitCode == 1)]'} />
```

The host returns the selected records as feedback, then asks for your next
response. A silent command can have empty document output and still answer:

```json
{
  "value": [
    {
      "marker": "entry-2:yield:root:1",
      "type": "exec",
      "name": "exec:startup",
      "status": "ok",
      "position": null,
      "prompt": null,
      "agent": null,
      "exec": {
        "exitCode": 1,
        "stdout": "",
        "stderr": "startup refused: pass --profile local\n"
      }
    }
  ],
  "next": null,
  "prev": null,
  "last": null
}
```

Use the retained diagnostic to prepare a correction. Reading leaves the failed
entry failed; submitting the correction is a separate action. For an agent
record, use its `prompt` number to read the saved turn:

```xmd
<REPL.Entry.Prompt entry={2} prompt={9} field="error" />
```

## Reading more than one page

Journal applies `yq` to the complete permitted retained entry before paging its
result. You can search all records or all retained channel text in one query.
Small results keep their exact JSON type. A large object or indivisible array
item refuses with a narrower-query direction; directly selected strings remain
fully readable in 4096-code-point pages:

```xmd
<REPL.Entry.Journal entry={2} yq=".records[1].exec.stderr" as="diagnostic" />
<Output><Json value={diagnostic} /></Output>
```

For a continuation, copy the returned `next`, `prev` or `last` string into the
`yq` prop and keep `entry={2}`. Within the same response, a returned next query
can be used directly:

```xmd
<REPL.Entry.Journal entry={2} yq=".records[1].exec.stderr" as="first" />
<If condition={first.next}>
  <REPL.Entry.Journal entry={2} yq={first.next} as="second" />
  <Output><Json value={second} /></Output>
</If>
```

These examples require record 1 to be the command you selected; use its array
index from the complete Journal value. A read of the next page recomputes the
query over that entry's current retained data. Growth may shift pages. An omitted
or negative entry resolves at each read, so reuse the receipt's positive entry
number after another entry has been admitted. Generated windows refuse another
entry rather than following it. Each response starts with empty bindings; a
query string received as feedback is data to copy into the next response.

Source, Prompt and Output keep `previous` and `next` argument objects. Text
windows default to 4096 code points; copy their exact entry, prompt, field,
offset and limit when continuing:

```xmd
<REPL.Entry.Prompt entry={2} prompt={9} field="reply" offset={4096} limit={4096} />
```

## Common mistake

Re-submitting the draft you prepared before the interruption, on the assumption
that it never ran. If the entry was admitted, its work is in the entry History
and submitting again performs it twice. Read its Journal first, then continue
from what is there.

## Read next

Read `<Guide.Bindings />` for reading published values, and `<Guide.Lifetimes />`
for what an interruption releases.
