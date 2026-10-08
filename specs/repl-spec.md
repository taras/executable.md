# The XMD REPL

`xmd repl` is a full-screen terminal you keep working in. Submit an XMD entry,
watch it run for real, submit the next one when it settles, and look at what any
of them did — while they are running and afterwards, in this process or in
another one.

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
entry, and an admitted entry is immutable. The run begins, and the screen fills
in as it goes — the scopes the entry admitted, the bindings its `eval` blocks
published, the source a generated fragment produced before that fragment was
admitted, and each line the document rendered.

Keep typing. The draft is always the *next* entry's, so it goes on taking
keystrokes while this entry runs and while you are reading an earlier position:
an admitted entry is immutable, so there is never one those keystrokes could be
editing. Press Enter before the entry ahead of it is done and Run says so, and
what you typed stays exactly as you typed it, character for character. When that
entry has both settled and finished coming down, the same draft becomes the next
entry — and only then does it leave the input and the location.

When the entry asks a question, the footer says so on one row and nothing else
happens: no drawer opens itself, nothing takes focus, the route does not move and
the Sessions filter does not change. Activate that row — with Enter or a pointer —
and the question's drawer opens: the whole message, and then
every field the schema declares, with its title, its description, whether it
is required, and exactly the values it will accept. All of that is one ordered
whole, and it is that whole — not the message alone — that scrolls when it is
taller than the drawer. The earlier and later controls, the title and the close
control stay put while the content moves beneath them, so however short the
drawer is, scrolling reaches every field, every offered value and the control
that submits. Fill them in, or activate one of an enum's offered values, and
press Enter from any of them to offer the whole object. The answer is recorded,
and what the document renders after it changes because of the recorded answer
rather than because of anything this process remembered. An answer the schema
rejects keeps the question open and says what is wrong with it, under the field
it belongs to. Escape closes the drawer without answering and discards what was
typed into it; the question stays open, so the row that announces it is still
there and activating it opens the drawer again. An answer the schema accepts ends
the question, and the drawer goes with it: it leaves the screen and it leaves the
location, because a URL naming a drawer nothing mounts describes a view nobody can
be shown. A question that disappears some other way — teardown, or a settlement
elsewhere — takes its drawer with it in the same way, and nothing becomes an
answer, because none was given.

A question belongs to the entry that is asking it, which is read on the Entries
surface. Activating the announcement therefore goes to that surface, selects the
entry still running, and leaves the draft and the Sessions filter where they
were — so a question is reachable from either surface without the screen moving
on its own first. A location naming that drawer beside Sessions, beside an earlier
history position, or beside an entry that has already settled is refused.

Press Enter on `[exit]` to leave. It is on the screen in every state — while an
entry runs, while a question or a request waits, and while an earlier position is
being read — and while a drawer is open it belongs to that drawer, so it is
reachable without reaching past the modal. Leaving is lifecycle and nothing else:
it answers no question, decides no permission request, and appends no close, no
cancellation and no audit. An entry whose root never closed stays unfinished,
because that is what it is. The command cancels and joins everything it owns,
gives the terminal back once, prints the location it was at — minus the drawers
only a running process could have mounted, so what it prints is a location a
second process can be handed — and exits zero.

Press Enter on `[pause]` to stop expansion at its next boundary. `[continue]`
exists only while a continuation is actually held — not while a pause is still
being taken — and releases the holds. Pausing cancels nothing: the execution is
suspended, not abandoned. Open the History drawer to select an
earlier position; the whole view freezes there and is read only. `[live]` returns
to the head.

When the root settles, its recorded output is what the transcript shows, and the
screen stops asking for frames.

## Entries: a catalog you come back to

The Entries surface lists every entry this execution has admitted, numbered in
the order they were submitted. That order is what it is: an entry's place comes
from when it was admitted, so one that finished first, published first or failed
cannot move ahead of one submitted before it. Each row carries its outcome
before its name — `[unfinished]` while it is running or if it was interrupted
before closing, and then `[ok]`, `[err]` or `[cancelled]` — because a root name
is as long as its author made it and the sidebar is not.

Each entry has a stable key from that same order — `entry-1`, `entry-2`, and so
on — and it is the key a location names, so a link to what you are reading keeps
meaning it. The first entry's key and every marker spelling it ever had are
unchanged, so a location written before an execution could hold more than one
entry still opens on exactly what it always did.

Selecting a row changes what you are reading and nothing else. The transcript
becomes that entry's own, its scopes and published values become the ones to
inspect, and the entry you selected is part of the location. Live execution, the
draft, the history position, the Sessions chronology, the Sessions filter and
focus outside the list all stay where they were — and output from the entry
that is still running appears under that entry, never under the settled one you
are reading.

The list is windowed rather than clipped: it moves through as many rows as the
frame can place, with its earlier and later controls staying put while the rows
move beneath them. What the window is not showing is not drawn, not focusable
and reaches no pointer, and every row can be scrolled to, activated by Enter and
activated by a pointer.

Entries run one at a time. There is no queue: a submission while one is running,
while one has settled but its work is still coming down, or while you are
reading an earlier position is refused, and refusing it starts nothing.

## What a later entry starts from

The root values an earlier entry durably published are what the next one begins
with. For each name it is the last value any earlier entry retained, in Journal
order, and the values are the entry's own to change — they behave like values
authored earlier in the same environment, and a later export replaces one
through the ordinary rules.

What survives is what was retained. An entry that failed, and one whose
cancellation the file records, each settle their entry: they hand on everything
they published before that, hand on nothing they never durably published, and
let the next entry start. The reserved `props` namespace belongs to each entry's
own validated root and is never inherited.

An entry interrupted before its root closed is a different thing. The file holds
no close for it, so it is unfinished, and an unfinished entry permits no
successor — reopen that execution and it resumes where its records stop, and
another entry can be submitted once it has settled.

This comes from the file and from nothing else, so a later entry begins from the
same values whether the earlier ones ran a moment ago in this process or were
read back cold from the journal.

## One cold journey

The command prints the location it ended at. Pass that location to a new
`xmd repl` — on this machine, in a new process, with nothing carried over — and
the same view comes back: the same catalog of entries in the same order with the
same outcomes, the same selected entry and scope, the same binding values, the
same transcript, the same generated source, the same recorded question and
answer, the same History positions and the same terminal output.

Nothing is re-run to do it. No component source is read, no `eval` block is
compiled, and nobody is asked anything: everything on that screen was
reconstructed from the location and the retained events. Settled entries are
projected and never performed again; only a final entry the file shows as
unfinished is given back to the engine to continue. A location naming a history
this version cannot read, or naming an entry its selected prefix never admitted,
refuses whole — with nothing appended and no execution started.

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

## Every drawer is a window

A drawer shows as much of what it holds as the frame has room for, and its
earlier and later controls reach the rest. That is true of all five readings a
drawer can show: the question being asked, a pending permission request, a
History position, a binding's retained value and a recorded answer. A retained
value is as long as whatever produced it — a compiler's reason, a whole JSON
document — so a drawer that described all of it at once would have its tail
placed nowhere, which is the one part you opened the drawer to read.

Only what is in the window is on the screen. A row above or below it is in no
cell, reaches no pointer and is no stop for Tab, so the last position in a long
History is genuinely absent until the window reaches it — and then it is an
ordinary control that selects that position. Scrolling is only scrolling: it
moves the window and changes nothing else. It selects no position, answers no
question, writes nothing to the file and does not touch the location, so moving
through a long record cannot change what you are reading.

A drawer is bounded. A rule along the top of its rectangle says where the reading
behind it stops, and its title and its rows start one cell in from each side, so a
title cannot be read as one more line of what the drawer is covering. Both belong
to the rectangle and both are measured: the window is measured at what is left
after them, so a reading one row longer than that window is reached with one more
`later` rather than drawn over the rule. A drawer holding a question nobody has
answered yet — the question itself, or a pending permission request — is named in
the accent this screen uses for waiting, so the drawer you have to act on says so
before you have read a word of it.

The title, both window controls and `[close]` stay outside the thing they move,
and the footer keeps its own seven rows — `[history]` and `[exit]` stay reachable
from inside an open drawer, where they belong to that drawer.

How far each reading is scrolled belongs to that reading, and to this process
alone. Two bindings that happen to share a name in different scopes are two
readings and keep two positions; a reading you come back to opens where you left
it, bounded by what the window now holds; and a reading you have not opened
starts at its first row. No location and no record carries any of it, so another
process opening the same URL opens each reading at its start.

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

Activating `[exit]`, Escape on the too-small refusal, EOF, a renderer that cannot
present, a terminal that fails mid-read and a cancelled command scope all end the
same way: the owner cancels and joins every Prompt, provider task, pending
permission operation, observer and frame subscription it started, appends nothing
after that, and gives the terminal's modes back exactly once. Work that was
interrupted leaves no record, because a record for it would be a record of
something that did not happen. What was already appended stays readable, and is
what a cold process shows.

No chord ends it. A Control or Alt combination is dropped whole wherever it is
pressed, so leaving is a control a person can see rather than a key they have to
know — which is also why the one screen with no control on it, the refusal below
the minimum size, says that Escape leaves.

Leaving takes no further keystroke. The terminal's bytes arrive on a stream the
command owns, and releasing it cancels the read it was holding rather than asking
the terminal to finish one: a release that waited for the next key would make
leaving cost the very thing the person has stopped doing.

The location it prints is the one it was showing, minus the drawers only a running
process could have mounted: a waiting question and a pending request are in no
history, so a location naming one is a location nobody could reopen. Everything a
second process can reconstruct stays — the history position, the surface, the
selected entry, the conversation filter and the draft.

## What the screen does at each size

| terminal | what it shows |
| --- | --- |
| `160x36` and larger | a Sessions/Entries sidebar, a Transcript pane and a Bindings pane — each with its own surface and the edge that starts it — the drawer layer, and a fixed full-width footer holding the contextual action row, five History rows and the draft |
| `120x30` and larger | the same, with a narrower sidebar and inspection column |
| `72x20` and larger | one routed surface — the one the route selected — under the two surface controls, with the same drawer and footer |
| smaller than `72x20` | a refusal saying the minimum, that growing the window recovers, and that Escape leaves; it shows nothing else, and offers no control to point at |

Resizing the window is ordinary. Dragging a corner produces a stream of sizes,
and each one redraws the screen for the size that is actually there: the
execution you are in, the surface you are on, what you had selected and what you
had typed all survive it, and none of it ends the command. A size this REPL does
not support shows the refusal above and recovers when the window grows.

At narrow, the surface the route did not select is still there in the model and
is not on the screen: it is in no cell, in no target map, and no pointer reaches
it. What stays is the way between them: both surface controls are on the screen
at every size, because a screen you cannot leave is not one this route may put
you on.

A narrow frame has no inspection column, so the bindings and the recorded
questions are not on it in any sense — not drawn, not something a pointer can
reach, and not a stop Tab or Shift+Tab visits. What a wider window shows there,
the narrow one does not pretend to offer. Answering a question at that size
therefore leaves you on the entry the answer belongs to, which is a control you
can see, and the catalog moves as far as it has to for that entry to be showing.
Which entry and which scope you had selected does not change, and a wider window
shows the record itself again.

The location is not on the screen. It is the longest thing this command could
draw and the one thing a reader never has to act on while they are reading, so no
row carries it and none is kept for it at any size. The command prints the whole
location when it ends, which is where it is useful: that is the string you pass
back to reopen exactly what you were looking at. Source text, provider output and
an event's own origin are content and are shown as written, URLs included.

The History band is five rows at every size and says which band it is on the
first of them; when the labels of several positions cannot all fit, they share a
label and every position keeps its own identity.

The footer is seven rows at every size, in one order: the contextual status and
action row, then the five History rows, then the draft. The draft owns the last of
them, says `Draft:` so the row below a reading is not read as one more line of it,
and shares it with nothing — so what a person is typing stays visible however many
controls a state happens to offer. The drawer layer sits above the footer rather
than across it, so a question and the draft are readable at once.

The action row holds the controls that are available now, side by side, each as
wide as its own label so a pointer on one reaches that one. Order is priority: a
row too narrow for everything keeps the controls and shortens the sentence beside
them, and a control that will not fit whole is not drawn at all rather than drawn
half off the row. It is not there in any sense — not a cell, not something a
pointer can reach, and not a stop Tab visits — because a control you can neither
see nor hit is worse than one that is honestly absent. The controls it keeps are
the first ones in that order, without exception: where a wide control will not
fit, a narrower one after it is left out too, so the row you read at one size is
a prefix of the row you read at a larger one and nothing moves under your hand.

Every row says what it has room to say. A row is as wide as the region the frame
measured for it, and so is its text: a name nobody bounded — a prompt, a root, a
tool call — is shortened with an ellipsis so that what the row is *about* stays
on it. A turn keeps its state, a retained grant keeps its outcome, an entry keeps
its outcome, and where a row is too narrow even for that, the fact survives and
the name keeps whatever is left in front of it. What the row shows is shortened;
what the product holds is not, and the whole of it is still in the record, the
transcript and the drawer that shows it.

What fits is measured rather than counted. The screen asks the terminal how much
room each region actually has — with every scrolling list empty, but with the
headings, the window controls and the complete labels in place — and only then
decides which rows and which controls exist. So what you can see, focus and click
are the same set, at every size, and a row the frame has no room for is never
described as though it had somewhere to be.

A refusal of one action — a submission the entry ahead of it has not made room
for, a navigation that selects nothing, a pause this process cannot perform —
appears on that row beside the control that was refused, shortened with an
ellipsis when the row is too narrow for all of it. It does not replace the
screen.

Above whatever surface is showing, one row says how to operate what is in front
of you: where typing goes, what Enter does on the control that has focus, that
Tab and Shift+Tab move between controls, that a pointer does what Enter does, and
how to close a drawer when one is open. It is read off what is mounted rather than
fixed, so it never names an action this screen does not have — and when focus is on
a control rather than a field it says how to get back to the draft, because that
is the one moment a person's keystrokes reach nothing.

## What the screen says the execution is doing

One row says it, and it says the state first. That row is the contextual guidance
at the top of the surface being read — not a new row, and not one of the
footer's. The footer is unchanged and still holds exactly what it held: its
action row, the five History rows, and the draft.

The state comes first because the row is as wide as the region it is drawn in and
that region decides where it stops. A sentence cut after "Entry 1 running" still told somebody
the thing they could not have worked out; one cut after the key guidance told them
what the keys do and left them pressing Enter at an entry that cannot accept it.
What follows the state is what the state means for the keys, then what the focused
node does, then the way out, then movement. At the narrowest supported frame the
row is composed to fit rather than written long and cut, because a row the
renderer cuts loses its last fact with nothing to say that it is missing.

**Readiness is read from the file and from this process together.** The durable
side cannot answer it alone: a root close is recorded the moment a document
settles, while the task that produced it is still coming down, and a submission
taken in that window has nowhere to go. So there is a state between "settled" and
"ready" — the close is retained, the entry's task has not been joined, and no
successor may start yet. It resolves without anybody typing: when the teardown
finishes, the row says the next entry may start.

The states a person can tell apart: no entry yet; an entry running; an entry
waiting for an answer; an entry waiting for a permission; an entry whose close is
retained while its teardown finishes; an entry admitted that never reached an
outcome, which no successor may follow; and a settled execution ready for the next
entry. A frozen position is its own state and says so before any of them.

**A refusal that was only ever true of a moment stops being shown.** When the
readiness refuses a submission it says why, keeps the draft exactly as it is,
starts nothing and appends nothing. When the entry it named finishes, that refusal
goes rather than contradicting the sentence above it. A document that cannot be
admitted and an answer a schema rejected are refusals of the thing itself: they
stay until the thing changes, and the schema's complaint stays under the field it
is about rather than in the row that says what the execution is doing.

**A failed entry says what it failed with.** The reason the Journal recorded is
drawn beside the compact outcome, on its own row, flattened to one line and cut to
the region it is drawn in — the whole of it, introduction included. A reason is
whatever the thing that failed said, and what failed may be a compiler; the
unbounded text stays in the file, which is where something unbounded belongs. An
entry that did not fail is given no failure text.

**A waiting permission is announced, not taken.** Permission belongs to Sessions.
A request arriving while another surface is being read says that it is waiting and
where it is answered; it moves no route, opens no drawer, takes no focus, and
changes neither the selected entry, the conversation filter, the draft nor the
history position. The control that answers it is the one Sessions already had.

**A frozen position says what it cannot do.** It begins by naming itself, states
that submitting is unavailable there, and offers the way back to the head as a
control on the screen. The live head's status does not reach it — not what is
running, not what is waiting, not what could be paused — because a prefix is a
reading of the file and the head is not part of it. The draft belongs to no
position and is unchanged.

None of this is retained. The status, the guidance and the emphasis are computed
on the way to a frame from the resolved view; they are in no location member and
no record, and replay neither produces nor consumes them. A cold reopen shows the
same state because the file and the location say the same things, not because
anything stored what a previous process was displaying.

## What the emphasis says

Every row of this screen is drawn as the thing it is. What a run produced stands
ahead of the facts about the events that produced it; an entry that closed `ok`,
one that closed `err` and one still running are three different readings rather
than three spellings of the same one; a question nobody has answered yet reads as
waiting; and a retained position reads as history until you return to the head.
A drawer says which kind of reading it is showing before it says which one — a
binding, a recorded answer, a permission request — and separates what a field is
called from what it means from the value you are editing. Whatever acts carries
the same surface wherever it is, in a drawer or in the footer, so you can tell
what you can press from what you can only read.

Two of these are independent and stay that way. The row you have **selected**
keeps its own surface for its whole measured width, and keyboard **focus** marks
the row your next keystroke reaches and adds weight to it — so moving focus never
takes the selection off what you were reading, and both are visible at once.
Focus takes no colour off a row: what a row's characters are stays readable while
you are standing on it, and the marker in front of the row is the one thing the
focus colour belongs to.

Source and JSON are read character by character. In a draft, in a read-only
source row and in the source a question shows you, a heading, the characters that
open and close a tag, a tag's name, an attribute's name, a quoted value, the
braces around a reference and what the reference names are each drawn as the
thing they are; and a binding's or a recorded answer's complete value shows its
keys, its strings, its numbers, its booleans, its nulls and its punctuation
apart. Reading is all it is. Nothing is validated, evaluated, rejected or
rewritten, every character you typed is still there — a half-written `as="ans`
included — and anything the screen cannot classify reads as ordinary source. Nor
is anything guessed at: a value is read as JSON because this product serialized
one, not because some text happens to begin with a brace.

A reading of this screen with the colour thrown away loses nothing it needs. An
outcome is spelled `[ok]` or `[err]`, a selected row keeps its `*`, a focused
control keeps its `>`, the draft keeps its `>>`, and every state the emphasis
distinguishes is also said in words. The emphasis is how the screen is read
quickly; the text is how it is read at all.

## Sequential entries, and nothing else

One execution admits entries in submission order, one at a time, into one
append-only journal. There is no concurrent entry, no submission queue, no fork
from a history position, no renaming, deleting, reordering, importing or
exporting an entry, no snapshot and no sidecar file. Two processes writing one
execution is unsupported.

The Sessions surface presents the Agent work every entry did, as one chronology,
and an execution with no Agent work has one that says so.

## What is retained, and what is not

Each execution is one file of serialized ordinary `DurableEvent`s — the same
records any other XMD run writes. There is no manifest, no cache, no materialized
model, no checkpoint file and no record type of the REPL's own. The file and the
location are the whole of the state, which is what makes reconstruction from them
possible at all.

The location carries route state only: which surface, which entry and scopes,
which drawers, which history position, and the draft for the next entry. Those
members are independent — a location names a selected entry on either surface,
beside a drawer stack, a conversation filter and a frozen position, so going to
Sessions to follow a conversation and coming back returns you to the entry you
left. It never carries focus, pause state, how far a window is scrolled, form
internals, rendered cells or this process's overlay.

## History is immutable; the present is explicit

A view frozen at a history position shows what the file held at that position and
nothing else: exactly the entries admitted by then, each with the outcome it had
reached by then. It fills nothing from the live head: no live output, no waiting
question, no pause capability, and it cannot open the question this process is
asking. What it does not freeze is the draft, which is the next entry's and
belongs to no position — it stays editable, and `[live]` brings it back to the
head with the current catalog. Choosing a position from before the selected
entry was admitted clears that entry and the scopes beneath it rather than
guessing another, and keeps the draft, the surface, the conversation filter and
the position itself. Before the root closes, output this process has produced but the file has
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
has focus, and to nothing at all when a control has it rather than a field — so a
keystroke never edits a field nobody is looking at, and the row above the surface
says how to get back to the draft while that is the case. A Control or Alt chord
is dropped whole rather than typed as the letter it was pressed with. A pointer is resolved against the exact frame that produced
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
