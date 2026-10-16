# Recovery

Read this when continuing work that was interrupted, or when a conversation has
been reopened and you need to know what actually happened.

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
- Read what an entry actually produced with `<REPL.EntryOutput />`, and read the
  current published values with `<REPL.Bindings />`, rather than assuming the
  state your earlier plan expected.
- A question that was interrupted is shown as waiting. It is not asked again:
  asking again is asking a second question.
- When the host cannot establish what happened, it refuses rather than guessing,
  and says so. That refusal is the answer — do not retry the same request hoping
  for a different reading of the same records.
- Reopening by itself starts nothing. Nothing is submitted and no turn is taken
  until the person asks for something.

## Example

```xmd
<REPL.EntryOutput entry={-1} />
```

The host returns a window of that entry's observed output as feedback, with the
instruction for reading the window beside it, then asks for your next response.

## Common mistake

Re-submitting the draft you prepared before the interruption, on the assumption
that it never ran. If the entry was admitted, its work is in the entry History
and submitting again performs it twice. Read the History and the entry's output
first, then continue from what is there.

## Read next

Read `<Guide.Bindings />` for reading published values, and `<Guide.Lifetimes />`
for what an interruption releases.
