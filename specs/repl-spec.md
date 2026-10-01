# The XMD REPL

`xmd repl` opens one XMD entry in a full-screen terminal, runs it for real, and
lets you look at what it did — while it is running and afterwards, in this
process or in another one.

```bash
xmd repl                                  # a fresh execution with an empty draft
xmd repl 'xmd://repl/<execution>/repl'    # reopen exactly that retained history
xmd repl --deny-all                       # the same, answering every agent request with no
```

## The command line, and the order it is read in

`xmd repl` takes one optional location and the five Agent options `xmd run`
takes, with the same spellings, the same descriptions and the same defaults:
`--agent-provider` (default `acpx`), `--default-agent` (falling back to
`DEFAULT_AGENT_NAME`), and the mutually exclusive `--approve-all`,
`--approve-reads` and `--deny-all`. An unstated permission line means
`--approve-reads`. There is no sixth option: no include, no data directory and
no REPL-only knob.

Everything that can be refused is refused in this order, and each step happens
before anything the next one would touch:

1. **The line.** A token that is not the location or one of those five options,
   a switch given a value, a value option given none, and a second location are
   each refused here — before a per-user directory is formed, a history file is
   created or the terminal's modes are touched.
2. **The Agent configuration.** Two permission switches together and an unknown
   `--agent-provider` are refused next, before any adapter exists.
3. **The profile.** What this command's REPL runs under is assembled once, in the
   command's own scope: the selected Plugins, the Agent identity vocabulary, the
   packaged `<Plan>` Component, the ordinary evaluation ceiling and the settled
   permission mode. It is read from then on and never rebuilt, so two entries of
   one session cannot run under different rules.
4. **The terminal.** Only then is a terminal asked for. Over a pipe the command
   refuses, having left nothing behind.

Nothing here starts an agent. An entry that asks for none materializes no
adapter at all; the provider validates availability the first time a turn wants
one.

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

When the entry asks a question, its drawer opens: the whole message, and then
every field the schema declares, with its title, its description, whether it is
required, and exactly the values it will accept. All of that is one ordered
whole, and it is that whole — not the message alone — that scrolls when it is
taller than the drawer. The earlier and later controls, the title and the close
control stay put while the content moves beneath them, so however short the
drawer is, scrolling reaches every field, every offered value and the control
that submits. Fill them in, or activate one of an enum's offered values, and
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

## The packaged Plan, in the REPL's own drawer

`<Plan>` is the same packaged Component `xmd plan` runs, declared by this command
rather than reimplemented by it. Its authorship turns go to the configured
provider, and its review is asked through the REPL's own Elicitation provider —
so the plan you are reviewing appears in the drawer in front of you rather than
in a readline this process is not reading.

The review is a bounded form: approve, request changes, or stop. Choosing
"request changes" without the feedback that option requires is refused like any
other invalid answer — the review stays open, no answer is recorded and no turn
begins. Supplying it resumes the same provider conversation, and what comes back
is reviewed again. Approving admits exactly the source the provider returned: the
returned program is rendered at the `<Plan>` invocation and executed inline by the
enclosing `<Evaluate>`, never appended as unrelated output.

A returned program is a generated fragment, so it runs under the ordinary ceiling
and the generated-expression grammar: it may ask questions, write files and
compose values it holds, and it may not compute one
(`specs/executable-mdx-spec.md` §5.3.3). Canonical `<Elicit>` is in that ceiling's
write table, so a generated program can preview what it is about to do and ask
before doing it — and its validated answer drives what follows through ordinary
bindings.

## Sessions: one chronology, and which conversation you are reading

The Sessions surface shows every Agent turn this execution has, in one order:
the turns the history retains, then the turns this process is watching, by the
order they were scheduled. A turn says how far it has got — queued, streaming,
how it ended, and whether the history holds it yet — and a turn that has finished
is not the same as one that has been recorded: only the second is a position you
can go to.

A turn keeps its identity when its record arrives. The row a person is reading is
the same row before and after publication, and what replaces it is its own
record rather than a second row beside it.

Each turn says what is known about it at that moment: its prompt, what it has
said so far, which agent and which conversation it joined, and how it ended.

Conversations are the provider's own session keys, offered earliest-observed
first. A queued turn belongs to none of them yet, and the name the document gave
its `<Session>` is not an answer to which conversation a provider opened, so a
turn without one appears under **All conversations** and nowhere else. Selecting
one filters the surface to that conversation and changes nothing else: the route
gains a session and keeps its surface, its scopes and its history position.
Clearing it back to All restores the whole chronology. Work in the conversations
you are not reading — a turn starting, text streaming, a record appending —
moves neither the route, the history position nor the focused control.

The list is windowed rather than clipped: it moves through as many rows as the
frame can place, with its earlier and later controls — and the way to the other
surface — staying put while the rows move beneath them. What the window is not
showing is not drawn, not focusable and reaches no pointer.

## Permission: a live request, and a retained audit

A turn waiting for permission says so on its own row, and that is all arriving
does: nothing moves, nothing takes focus, and nothing else stops. Activate it and
a drawer shows what is being asked — its kind, the call, whose turn is waiting,
and every choice the provider offered in the provider's order. A choice that
lasts says it lasts *for this Agent session*, because nothing here can make a
rule that outlives the conversation asking. The drawer is windowed like the list
behind it, so however many options a provider offers, each one can be reached and
`[close]` never scrolls away.

Choosing one answers that request; closing the drawer denies it, which is the
same decision the session's own policy would make and is recorded as such. Either
way the drawer closes only when the request is settled — a screen that closed
first would be claiming an answer nobody gave — and focus returns to the turn
that was waiting.

A retained audit is inert. What the history holds is what was granted, read and
never answered again — a recorded request offers no control, and a cold process
shows the audit without offering to decide anything. Ending the command answers
nothing: a torn-down process does not fabricate a denial, a selection or a
cancelled audit on the person's behalf.

## The form language a question is drawn in

A question's schema is read whole before anybody is asked. What this REPL draws
is a closed object of string fields, each with its title, description, whether it
is required, its minimum length and the exact enum values it accepts, plus at
most one `if`/`then` condition that requires further fields when one field takes a
stated value. A schema outside that language is refused by the provider, naming
the exact path that put it outside — and the refusal has asked nobody, published
no drawer and moved no counter.

Every answer is validated by the compiler that will judge it, so what the screen
enforces and what the record accepts cannot disagree. An invalid answer keeps the
question open with its issues under the fields they belong to. A field that was
deliberately cleared is present and empty; one nobody touched is absent.

## Cold Agent reconstruction

A cold process over a retained location shows the Agent work the history holds:
the turns, their conversations, their text, how each ended, the questions that
were asked and the answers that were given, the program a generated fragment
admitted and what it wrote.

Work a packaged Component did on the entry's behalf is shown under that
Component. A declared component's record retains the origin it is known by and
the bytes it is, so the scope every effect inside it is recorded against is the
one the history already describes — and the program that Component returned is a
scope of its own beneath it, owning the questions the program asked, which carry
a place in the generated source and no path at all. A turn whose provider failed or was cancelled
restores with the text it had streamed and the status it ended with, as terminal
retained state — never as queued, streaming or reconnecting.

No provider is reached to do it, no adapter is materialized, and nothing is
appended: the history file is byte-identical before and after a cold run.

## How this command ends

EOF, a renderer that cannot present, a terminal that fails mid-read and a
cancelled command scope all end the same way: the owner cancels and joins every
Prompt, provider task, pending permission operation, observer and frame
subscription it started, appends nothing after that, and gives the terminal's
modes back exactly once. Work that was interrupted leaves no record, because a
record for it would be a record of something that did not happen. What was
already appended stays readable, and is what a cold process shows.

## What the screen does at each size

| terminal | what it shows |
| --- | --- |
| `160x36` and larger | Sessions/Entries sidebar, transcript, bindings and recorded questions, the drawer layer, and a fixed full-width footer holding five History rows and the input |
| `120x30` and larger | the same, with a narrower sidebar and inspection column |
| `72x20` and larger | one routed surface — the one the route selected — under the two surface controls, with the same drawer and footer |
| smaller than `72x20` | a refusal saying the minimum, showing nothing else; it recovers when the window grows |

At narrow, the surface the route did not select is still there in the model and
is not on the screen: it is in no cell, in no target map, and no pointer reaches
it. What stays is the way between them: both surface controls are on the screen
at every size, because a screen you cannot leave is not one this route may put
you on.

The location is drawn in full wherever there is room for it. A narrow frame
draws it in at most three rows and says how much it is not showing: there, the
location shares one region with every control on the screen, and a draft long
enough to fill that region would leave you with a URL and no way to do anything
else. The command still prints the whole location when it ends, and a wider
window still shows all of it. The History band is five rows at every size; when the labels of
several positions cannot all fit, they share a label and every position keeps its
own identity.

A refusal of one action — a second entry, a navigation that selects nothing, a
pause this process cannot perform — appears in the footer beside the control that
was refused. It does not replace the screen.

## One entry, and nothing else

This product admits zero or one entry per execution. There is no second entry, no
catalog of past runs, no fork, no snapshot and no sidecar file. The Sessions
surface presents the Agent work that entry did, and an execution with no Agent
work has one that says so.

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
- `xmd repl` takes one optional location and the five Agent options above. It
  renders no file and takes no document reference.
- `<Session.Launch>` is unavailable. This command has no terminal to give away —
  it is using it — so a document that reaches for a native agent UI refuses
  through the established missing-launcher contract, starts no foreground
  process, and leaves terminal ownership and restoration with the REPL.
- There is no browser elicitation and no readline permission handling. A question
  is answered in the drawer and a permission request in the surface, or not at
  all.
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
