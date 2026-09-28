# The XMD REPL

`xmd repl` opens one XMD entry in a full-screen terminal, runs it for real, and
lets you look at what it did — while it is running and afterwards, in this
process or in another one.

```bash
xmd repl                                  # a fresh execution with an empty draft
xmd repl 'xmd://repl/<execution>/repl'    # reopen exactly that retained history
```

## One live journey

Run `xmd repl`. The screen shows an empty draft, a Sessions list that says it is
empty, an Entries list with nothing in it yet, and a location of the form
`xmd://repl/<execution>/repl` — the execution already exists, as an empty history
file, before you have typed anything.

Type or paste one XMD entry and press Enter. What was in the draft is now the
entry, and the entry is immutable: this execution admits one, and typing after
that changes nothing. The run begins, and the screen fills in as it goes — the
scopes the entry admitted, the bindings its `eval` blocks published, the source a
generated fragment produced before that fragment was admitted, and each line the
document rendered.

When the entry asks a question, its drawer opens: the whole message — scrollable
when it is longer than the drawer — and then every field the schema declares,
with its title, its description, whether it is required, and exactly the values
it will accept. Fill them in, or activate one of an enum's offered values, and
press Enter from any of them to offer the whole object. The answer is recorded,
and what the document renders after it changes because of the recorded answer
rather than because of anything this process remembered. An answer the schema
rejects keeps the question open and says what is wrong with it, under the field
it belongs to. Escape closes the drawer without answering; the question stays
open. An answer the schema accepts ends the question, and the drawer goes with
it: it leaves the screen and it leaves the location, because a URL naming a
drawer nothing mounts describes a view nobody can be shown.

Press Enter on `[pause]` to stop expansion at its next boundary. `[continue]`
exists only while a continuation is actually held — not while a pause is still
being taken — and releases the holds. Pausing cancels nothing: the execution is
suspended, not abandoned. Open the History drawer to select an
earlier position; the whole view freezes there and is read only. `[live]` returns
to the head.

When the root settles, its recorded output is what the transcript shows, and the
screen stops asking for frames.

## One cold journey

The command prints the location it ended at. Pass that location to a new
`xmd repl` — on this machine, in a new process, with nothing carried over — and
the same view comes back: the same selected scope, the same binding values, the
same transcript, the same generated source, the same recorded question and answer,
the same History positions and the same terminal output.

Nothing is re-run to do it. No component source is read, no `eval` block is
compiled, and nobody is asked anything: everything on that screen was
reconstructed from the location and the retained events. A location naming a
history this version cannot read refuses, with nothing appended and no execution
started.

## What the screen does at each size

| terminal | what it shows |
| --- | --- |
| `160x36` and larger | Sessions/Entries sidebar, transcript, bindings and recorded questions, the drawer layer, and a fixed full-width footer holding five History rows and the input |
| `120x30` and larger | the same, with a narrower sidebar and inspection column |
| `72x20` and larger | one routed surface — the one the route selected — with the same drawer and footer |
| smaller than `72x20` | a refusal saying the minimum, showing nothing else; it recovers when the window grows |

At narrow, the surfaces the route did not select are still there in the model and
are not on the screen: they are in no cell, in no target map, and no pointer
reaches them. The History band is five rows at every size; when the labels of
several positions cannot all fit, they share a label and every position keeps its
own identity.

A refusal of one action — a second entry, a navigation that selects nothing, a
pause this process cannot perform — appears in the footer beside the control that
was refused. It does not replace the screen.

## One entry, and nothing else

This product admits zero or one entry per execution. There is no second entry, no
catalog of past runs, no fork, no agent, no snapshot and no sidecar file. The
Sessions surface exists and says it is empty.

## What is retained, and what is not

Each execution is one file of serialized ordinary `DurableEvent`s — the same
records any other XMD run writes. There is no manifest, no cache, no materialized
model, no checkpoint file and no record type of the REPL's own. The file and the
location are the whole of the state, which is what makes reconstruction from them
possible at all.

The location carries route state only: which surface, which scopes, which
drawers, which history position, and the draft before an entry exists. It never
carries focus, pause state, form internals, rendered cells or this process's
overlay.

## History is immutable; the present is explicit

A view frozen at a history position shows what the file held at that position and
nothing else. It fills nothing from the live head: no live output, no waiting
question, no pause capability, and it cannot open the question this process is
asking. Before the root closes, output this process has produced but the file has
not recorded appears as an explicit overlay; once the durable close exists, the
recorded output replaces it.

## Who owns what

Components receive immutable view data and answer with a typed semantic action.
They hold no events, no history, no session, no repository and no host operation,
so a keystroke cannot reach the file except through the one place that owns the
product's state. Focus belongs to the mounted tree: Tab and Backtab traverse it,
a drawer contains it while it is open, and the control that has it is marked.

Normalized input is decided once, at the host, which names an event shape and a
position and never an action. Text is its own event and goes to whichever field
has focus; a Control or Alt chord is dropped whole rather than typed as the letter
it was pressed with. A pointer is resolved against the exact frame that produced
its coordinates, so a stale frame, a node that has gone and a target behind a
drawer all reach nothing — and activating a control with a pointer produces the
same action as pressing Enter on it.

Presentation time has one owner: a single acknowledged frame stream, advanced only
once every subscriber has applied the previous timestamp. A settled screen
schedules no timer.

## Exclusions

- Two processes writing one execution is unsupported. There is no lease protocol;
  do not open the same location twice for writing.
- `xmd repl` takes one optional location and no options. It renders no file and
  takes no document reference.
- The REPL runs where a terminal is: it is not available over a pipe, and help
  acquires no terminal or filesystem capability. Whether there is a terminal is
  settled before a history exists, so a piped invocation leaves nothing behind.
- A location is resolved against the retained history before anything replays. A
  route naming a scope or a drawer the file does not hold is refused without the
  execution being started, so a typo cannot cause a record.
- A waiting question's drawer cannot be reopened from a URL. A Journal records
  answers, never a question that is still waiting, so no history can establish
  that drawer — it exists only while the process holding the question is running.
  A location carrying one is refused before anything replays.
