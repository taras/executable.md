# The XMD REPL

`xmd repl` is a full-screen terminal you keep working in. Submit an XMD entry,
watch it run for real, submit the next one when it settles, and look at what any
of them did — while they are running and afterwards, in this process or in
another one.

```bash
xmd repl                                  # a fresh execution with an empty draft
xmd repl 'xmd://repl/<execution>/entries' # reopen exactly that retained history
xmd repl --deny-all                       # the same, answering every agent request with no
xmd repl --sidekick-agent claude           # the same, with a Sidekick that talks to claude
xmd repl --include ../shared --include=/absolute/other
xmd repl 'xmd://repl/<execution>/entries' --include ../shared
```

## The command line, and the order it is read in

`xmd repl` takes one optional location and the five Agent options `xmd run`
takes, with the same spellings, the same descriptions and the same defaults:
`--agent-provider` (default `acpx`), `--default-agent` (falling back to
`DEFAULT_AGENT_NAME`), and the mutually exclusive `--approve-all`,
`--approve-reads` and `--deny-all`. An unstated permission line means
`--approve-reads`.

Its Sidekick selection is separate from the Agent options:
`--sidekick-agent` names the agent a fresh Sidekick conversation is opened
under. It is a separate selection rather than a second spelling of
`--default-agent` — that one is the agent a `<Session>` an entry writes means
by default, and who a person talks to about their entries is not the same
choice as who their entries talk to. Unstated, it falls back to
`DEFAULT_AGENT_NAME` and then to this build's own default; `--default-agent` is
never its fallback, and either one may be written without the other. Both
reach the one selected `--agent-provider`, and no permission option an entry
runs under grants the Sidekick a tool of its own — its conversations install
that same selected provider with constraints of their own rather than
inheriting what an entry runs under: no tools, no MCP servers, every native
request denied without asking, and no customization of the agent's own system
prompt. There is no data directory or second provider to select.

Use `--observe-worktree /absolute/linked-checkout` to allow the four local
Git observations in one existing linked checkout of the captured project
repository. `--observe-worktree=/absolute/linked-checkout` is equivalent.
Missing, relative and repeated values refuse before provider work. Omission
keeps the existing ambient and managed-checkout behavior.

The host validates the exact canonical root, linked registration, common Git
directory and repository identity before live targeting work, including a Dir
ensure. A missing or replaced root refuses without creation or repair. The
option adds no Git mutation, publication or retained Files placement. Ordinary
Files permission and outside-checkout behavior remain in force. HEAD and branch
are live ticket-policy facts rather than host pins.

Use `--include` to select existing component directories, as with `xmd run` and
`xmd test`. Both `--include <directory>` and `--include=<directory>` accept a
value. Repetition preserves occurrence order, and the first directory defining
an ordinary component wins. Explicit values replace the default search list
`["components", "."]`; omitting the option keeps both defaults. Relative paths
resolve from the invocation's contextual working directory, and absolute paths
stay absolute. The command captures them before workspace placement changes.
After the execution id is known, its session/components directory is appended
once. This effective list serves execution, validation, entry Syntax and the
packaged Plan's draft check. Configured definitions win over session definitions;
only genuine absence falls through, and a selected malformed or unreadable
component fails. These directories select ordinary components and grant no
permission; canonical protected components keep their implementations.

Everything that can be refused is refused in this order, and each step happens
before anything the next one would touch:

1. **The line.** A token that is not the location or one of those seven options,
   a switch given a value, a value option given none or an empty one, and a
   second location are each refused here — before a per-user directory is
   formed, a history file is created or the terminal's modes are touched.
2. **The Agent configuration.** Two permission switches together and an unknown
   `--agent-provider` are refused next, before any adapter exists.
3. **The command assembly.** Invocation cwd, configured absolute directories,
   selected Plugins, Agent stack, provider dependencies and permission mode are
   captured once in the command scope. After storage supplies the execution id,
   one immutable execution profile adds session/components and constructs the
   includes-dependent Plan declaration and vocabulary. No Plugin or Agent stack
   is installed again, and every entry uses the same finalized search list.
4. **The terminal.** Only then is a terminal asked for. Over a pipe the command
   refuses, having left nothing behind.

Nothing here starts an agent. An entry that asks for none materializes no
adapter at all; the provider validates availability the first time a turn wants
one.

## The session workspace

Sidekick responses and entries submitted through `<REPL.Submit />` start in the
existing paired session directory, beside `entries.jsonl` and `sidekick.jsonl`.
A manually submitted entry starts in the invocation's project directory. Writing
`notes.md` through a Sidekick entry puts it beside the journals; writing
`components/Greeting.md` makes that component discoverable by a later entry
without a new include option or restart. Writing a definition invokes none of it.

Fresh publication and legacy first-message publication ensure components before
the pair is ready. An existing directory and its files survive; a non-directory
refuses without replacement. Cold reading ensures nothing: an older pair missing
components remains unchanged, and a later authorized File write creates its
parents. Exit preserves the workspace; a second session has a different one.
Journal layout and legacy publication remain unchanged.

The host binds cwd on the actual response, validation and entry owners through
ordinary Env middleware at min. Nested Dir content uses its selected directory;
later siblings return to the workspace. Success, failure and cancellation leave
caller and sibling scopes at their own cwd. This grants no permission or native
tool, changes no source bytes and selects no Repository.

The original project cwd remains the basis for ambient repository discovery,
ordinary commit identity and invocation-relative options. To read project input,
enter its explicitly known path with Dir, capture the read, then write
`inputs/request.md` after Dir restores workspace cwd. Native Git likewise needs
a valid selected checkout at its authored cwd; it has no hidden project fallback.
The Sidekick's native conversation keeps project placement, or an explicitly
supplied agentCwd dependency, and its recorded native identity and configuration.

Read `<Guide.Environment />` and `<Guide.Entries />` for the component-writing,
discovery, later submission and output-reading journey. Current
`<REPL.Environment />` reports the response's actual cwd.

## Testing session components

After ordinary File entries create a component and its companion test, a
Sidekick response requests real tests explicitly:

```xmd
<REPL.Test path="components/Greeting.test.md" as="tests" />
<Output><Json value={tests} /></Output>
```

`REPL.Test` is a self-closing write control. Its only required prop is `path`;
ordinary `as` capture is optional. A directory target such as `components`
discovers `**/*.test.md` recursively, deduplicates documents and executes them
in normalized relative-path code-point order. Both target forms preserve the
finalized REPL component selection: configured directories, session components,
then registered defaults. They do not promote the document or target directory
as the CLI directory test command does.

Targets resolve against the paired session workspace, including inside a
response Dir. Empty, absolute and lexically escaping paths refuse before
execution. Literal `#` and `%` belong to the filename. A missing selected file
is an execution failure. Discovery failure before any document starts gives
control-refusal feedback with its diagnostic and no completed report.

A completed request returns this detached JSON-compatible value, and designated
feedback retains the same value whether or not it was captured:

```ts
{
  path: string,
  status: "passed" | "failed" | "no-tests",
  documents: [{
    path: string,
    status: "passed" | "failed" | "no-tests",
    tests: TestResult[],
    error: null | { name: string, message: string },
    report: string
  }]
}
```

The top-level path preserves the requested spelling; document paths are
normalized session-relative paths, including `components/`. Tests are actual
Testing results: status `pass` or `fail`, source location, optional name and
optional structured error with kind, full message and optional actual/expected
values. Output is drained independently and partial rendering survives document
failure. A successful execution has error null; otherwise the actual failure's
name and full message remain. No outcome is inferred from report text.

A document passes only after successful execution with reached tests. An
otherwise valid zero-test execution is `no-tests` with its genuine testing-policy
diagnostic. Parse or runtime failure before the first Test is `failed`, including
when there are no results. An empty explicit Testing boundary is still
`no-tests`. A suite passes only when every document passes; an empty selection
or all no-tests documents is `no-tests`; every other combination is `failed`.
Ordinary document failure allows later documents to run. Cancellation, refusal,
persistence, Files infrastructure, disclosure and owning-cleanup failures
produce no completed report and retain their authoritative failure paths.

Each document has a fresh execution scope and real useTesting session under
the clean command host, with its providers, immutable declarations and selected
TypeScript loader. Entry and response bindings or registrations are not copied.
Document cleanup joins before the next document starts. Nested Execution uses
the existing testing host. Testing grants no permission and adds no terminal
writer, pane or automatic chat summary. Only explicit Output publishes chat.

The root admits testing only when no entry reservation or active test exists
and the session is ready. Its test slot is acquired without suspension before
discovery and held through suite cleanup. Person Run, Sidekick Submit and a
second test refuse during this interval, including cancellation cleanup. A test
also refuses while an entry is preparing, executing, paused or tearing down.
Refusal queues nothing, preserves the draft and appends no entry.

The response owns testing. Stop cancels and joins its test work before releasing
the slot; Exit likewise joins it before shutdown completes. An already admitted
ordinary entry remains session-owned and survives Sidekick Stop. Completed
reports remain retained facts after source changes or removal. Reopening and
inspection execute no test, provider or component. An unmatched test intent is
unknown work; only a new explicit REPL.Test starts another run.

Read Guide.Entries for the executable create, test, fail, fix, retest and reuse
sequence. File availability follows actual File outcomes, not entry completion
alone.

## One live journey

Run `xmd repl`. The screen shows an empty draft, a Sessions list that says it is
empty, an Entries list with nothing in it yet, and a location of the form
`xmd://repl/<execution>/entries` — the execution already exists, as an empty history
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
typed into it — an *entry's* drawer, whose own close works this way and whose
rule the Sidekick's form does not share; the question stays open, so the row
that announces it is still there and activating it opens the drawer again. An answer the schema accepts ends
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
gives the terminal back once, prints what reopens the location it was at — minus
the drawers only a running process could have mounted, so what it prints is a
location a second process can be handed — and exits zero.

Press Enter on `[pause]` to stop expansion at its next boundary. `[continue]`
exists only while a continuation is actually held — not while a pause is still
being taken — and releases the holds. Pausing cancels nothing: the execution is
suspended, not abandoned. Open the History drawer to select an
earlier position; the whole view freezes there and is read only. `[live]` returns
to the head.

Pause is offered from the moment Run reserves the next entry, which is before
that entry exists. Submitting validates the document first, and validating reads
the definition of every component it names — so there is a window, as long as a
disk or an import takes, in which the person has pressed Run and nothing is
running yet. The control is there throughout it, and activating it asks that
this exact entry stop before it expands anything.

The button and what expansion is doing are separate: the control reads `[pause]`
in every state, and the state stands beside it as plain text that is neither a
button nor a keyboard stop.

```text
[pause] preparing
[pause] pausing
[pause] paused [continue]
```

`preparing` means a submission is being prepared and nobody has asked it to
stop. `pausing` means somebody has and nothing is held yet — the same word for a
preparation and for a live walk that has been asked and has not yet stopped,
because it is the same situation. `paused` means a continuation is really held,
and `[continue]` exists only then. Expansion that is playing shows the control
and no word at all.

The request is applied when that entry is admitted, which is the earliest moment
a hold means anything. Starting an entry imports `__root__` before it expands
anything its author wrote, and retaining that import is what gives the entry its
position; the request is taken in the same transition that establishes it, so
the hold is in place before the first authored step and after the entry is
something a person can walk back to. An entry held ahead of its position would
be paused expansion above a history that says nothing was submitted.

So a Pause pressed during startup — after Run, after validation, while the
execution is being built — is still a request and not a hold. It waits for that
entry's admission exactly as one pressed during validation does, and until then
there is no continuation, so no `[continue]`. The setup import is not an
authored expansion step: holding it would hold the very operation the position
comes from.

A pause request belongs to the one submission it was made against. It is in no
record and no location: a refusal, a withdrawal or closing the command discards
it, it cannot reach a later entry, and reopening a location restores no
preparation and starts no work. Pause asks and cancels nothing — neither the
preparation nor the entry — and asking twice asks for the same thing.

Preparation is not execution. A reserved entry is not running, paused, admitted
or settled; it adds no history position and no head state, and the footer keeps
its seven rows throughout.

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
frame can place, with `[\u2191 earlier]` and `[\u2193 later]` staying put while the
rows move beneath them. Those two controls are spelled the same way wherever a
reading has a window — this list, the catalog, Sessions and every drawer — and
they are controls you activate, not keys you press: no arrow shortcut and no
horizontal scrolling exist. What the window is not showing is not drawn, not focusable
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

A root `<Let>`, an ordinary component capture and an `eval` block's export all
reach the next entry. Writing

```xmd
<Let as="saved" value="alpha" />
```

is enough for the next entry to read `{saved}`, and the same is true of
`<Json value={{ answer: 42 }} as="saved" />`, of a Markdown component captured
with `as`, and of a `<Git.Commit as="commit" />` whose object id a later entry
consumes without committing again.

None of them is retained on its own. What the entry hands on is its **outcome**:
when the entry settles, the data its root holds is carried on the ordinary
result that settles it, and that is the one thing a later entry starts from. So
the question is never which construct wrote a name, or in what order — it is
what the root held when the entry finished.

That is also why the value that crosses is the value **as it stood then**,
rather than as it stood at the capture. The binding inside the entry is the
exact object the expression or the component produced, so the entry goes on
using it the way it always has; a change it makes to that object before it
settles is part of what the entry hands on, and a change made to a copy a later
entry received reaches nothing.

### Values that stay in the entry that made them

What crosses between entries is ordinary JSON data: text, numbers, `true`,
`false`, `null`, lists and plain objects of those. A function, a live handle, a
class instance, a cycle, a non-finite number and `undefined` are **entry-local**.
They bind exactly as they always have and stay usable for the rest of that
entry, and they are not converted into data, not kept alive past the entry, and
not published.

A name bound only to a value like that is simply absent from what the entry
hands on, which is not the same as clearing it — so the name keeps whichever
value an entry last settled under it:

```xmd
<Let as="saved" value="alpha" />
```

```xmd
<Handle as="saved" />
```

The second entry uses that handle. The third entry — and a cold reading of the
file — still reads `saved` as `"alpha"`, because the second entry's outcome
carried no `saved` to replace it with. A name only ever bound to a value like
that is absent from inheritance altogether: there is no removal, nothing is
deleted, and nothing warns.

What survives is what was retained. An entry that failed settles its entry and
hands on the root data its own failing outcome carried, because a failure is an
outcome.

A cancellation is not a result. An entry whose cancellation the file records
settles its entry too, but it carries no computed root data of its own: there
is no map on it, and none is reconstructed for it — whatever a cancelled run
had computed went with it rather than standing in for a result. What it does
not do is unretain the facts recorded before it. An `eval` export that entry
really made is a fact the file holds, and the entry after it inherits that
export exactly as it would from any other settled entry, while a capture the
entry reached and never recorded stays absent. Either way the next entry may
start.

"Nothing unretained crosses" is about outcomes, not about names. An entry that
mutated a value it inherited and never named again still hands the mutated
value on, because what its outcome carries is the root it actually had. What
does not cross is anything no outcome ever acknowledged — a value a running
entry holds, a value an entry that never settled computed, a value a discarded
result had. The reserved `props` namespace belongs to each entry's
own validated root and is never inherited.

An entry interrupted before its root closed is a different thing. The file holds
no close for it, so it is unfinished, and an unfinished entry permits no
successor — reopen that execution and it resumes where its records stop, and
another entry can be submitted once it has settled.

### A history written before captures were retained

A file whose entries were written before root captures were published is read
as it is. A completed entry there exposes the values it actually recorded, and
a capture it never recorded stays absent: nothing re-runs its source, repeats
an effect it already performed, or writes a value into it after the fact.

An entry such a file shows as unfinished simply continues. Nothing marks it and
there is no mode to continue in: its retained prefix is restored — its recorded
effects are not performed again — its remaining body runs, and the ordinary
outcome it settles carries the root data it then holds, including the captures
in the part that had never run. A file holding both kinds of entry is an
ordinary file, because the only difference between them is what their own
outcomes recorded.

What is refused is a history whose records say something this version cannot
read: an outcome carrying computed data it cannot parse, or a name no binding
could have. That is a refusal with nothing appended and no execution started,
and it is a different answer from an outcome that simply carries none.

This comes from the file and from nothing else, so a later entry begins from the
same values whether the earlier ones ran a moment ago in this process or were
read back cold from the journal.

## One cold journey

The command prints what reopens where it ended: a line saying so, and under it
the whole `xmd repl <location>`. Run that — on this machine, in a new process,
with nothing carried over — and the same view comes back: the same catalog of entries in the same order with the
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

You may supply the include options again when reopening a location. Completed
entries show their retained output and submitted entry source even after included
files change or disappear; inspecting them reads no live component source,
compiles no eval and asks no Agent. Imported component bytes remain retained for
replay. New entries use this command's selected directories.

A component called twice keeps two source readings. Each nested source and
recorded answer belongs to the call that produced it, while caller content
projected through `<Content />` keeps its caller's source. Current records name
the owning source import directly. Older records remain readable when their
ownership is unambiguous; an older ambiguous history still refuses without
repairing its bytes or repeating completed work.

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

The ordinary ceiling is the command's default rather than the entry's answer. The
session offers it in each entry's own execution scope as ordinary middleware that
delegates first and supplies the default only where nothing nearer stated one, so
a plugin or host installation that states its own selection is the one that entry
runs under — including a defined empty one, which refuses the entry's setup
instead of being replaced.

## Sessions: two owners, and which conversation you are reading

The Sessions surface shows the agent work this execution has, in two labelled
sections: **Entry agents**, then **Sidekick**. Two, because the two histories
are two files with two owners and no shared scheduling number — one interleaved
list would have to claim an order neither file establishes. Each section keeps
its own order, and an empty one says it holds no turns. A Sidekick history this
version cannot read says why instead, because an empty section for a file that
holds somebody's conversations is the one answer that cannot be corrected later.
An execution with no Sidekick installation has one list and says so when it is
empty.

**Entry agents** shows every Agent turn the entries did, in one order: the turns
the history retains, then the turns this process is watching, by the order they
were scheduled. A turn says how far it has got — queued, streaming, how it
ended, and whether the history holds it yet — and a turn that has finished is
not the same as one that has been recorded: only the second is a position you
can go to.

**Sidekick** shows every turn this execution's chat history holds, across every
conversation in it, in that history's own order — so the conversations that
preceded an agent change are still there. Each row says it is the Sidekick's,
which chat it belongs to and which agent answered in that chat, read from the
chat and the turn rather than from whichever agent is selected now. Its title is
the exact saved message a person sent; a turn that carried a previous response's
results is **Automatic feedback** rather than something anybody said, and its
machine input, bootstrap and reference chapters never become a person's words. A
turn whose request this history cannot establish says so instead of borrowing
the most recent message.

Progress and recording are separate. Before publication a row says only what
the owner has actually observed — a request asked, a turn generating, a reply
being evaluated — and never that a provider reported a start nobody reported. A
saved Prompt establishes its own completed, failed or cancelled status and
nothing about the program it returned: a completed turn with no
evaluated-response record reads **Turn saved; no evaluated reply recorded.**

A turn keeps its identity when its record arrives. The row a person is reading is
the same row before and after publication, and what replaces it is its own
record rather than a second row beside it. Entry rows and Sidekick rows are
never merged, whatever they have in common: they have different owners, so an
equal provider conversation or an equal turn number leaves two rows.

Conversations are the provider's own session keys, offered in Entry agents order
and then Sidekick order, each section earliest-observed first and a duplicate
key offered once. A queued turn belongs to none of them yet, and the name the
document gave its `<Session>` is not an answer to which conversation a provider
opened, so a turn without one appears under **All conversations** and nowhere
else. A Sidekick turn's key is the one its own saved record names — a failed or
cancelled record included — and an earlier turn's key is never substituted for a
later one's. The conversation a successful publication names belongs to its own
live turn before anything is acknowledged, and it still does not make that turn
saved.

Selecting a conversation filters both sections and changes nothing else: the
route gains a session and keeps its surface, its scopes and its history
position. Clearing it back to All restores both whole. The Sidekick's facts are
applicable beside any entry position, because freezing a prefix freezes *entry*
facts and a chat has no position in that history — so a Sidekick conversation
can be selected where the frozen prefix contains no such conversation, while an
entry-only key absent from that prefix is still refused. Work in the
conversations you are not reading — a turn starting, text streaming, a record
appending — moves neither the route, the history position nor the focused
control.

## Reading a previous chat

Activating a Sidekick turn opens the chat that contains it and brings that turn
into view. It sets `view=sidekick`, `right=sidekick` and that chat's own
identifier, and preserves the conversation filter, the saved surface, the
selected entry and its scopes, the history position and both texts. Bringing the
turn into view is ordinary process-local window navigation: a copied location
promises the same chat and no scroll offset. Selecting a reading starts no
provider, performs no generated program, creates no history record and stops
nothing that is running.

The turn to show is kept until a frame that measures the destination chat can
place it. The frame answering the selection is the one being left, and a frame
with no room for a chat beside the reading — or one showing Bindings — has
measured no chat window at all, so there is no offset it could compute. The
chat's own measurement is what puts the turn on screen, and what it lands on is
that turn's own evaluated reply or inert anchor rather than the first message
carrying its number.

What it lands on is also always a row that chat actually draws. Where the turn's
own reply said nothing to the person there is no such row, and the reveal is the
request that turn answered — its own, or, for a turn carrying a previous
response's results, the person request its chain began with, established from
the history's own request boundaries. Nothing is composed to be landed on, and a
turn whose containing request this history cannot establish reveals nothing
rather than a row chosen by resemblance. The next time somebody moves that
window themselves, the kept request is spent.

A turn that has no rendered reply still has somewhere to land — automatic
feedback, a saved turn with no evaluated reply, a turn that failed. What it says
there is what its records hold, and never a reply rebuilt from its source or an
extra message attributed to a person.

A chat whose own setup did not finish says so. One left prepared was
interrupted while it was being set up; one that failed kept the agent's own
reason and preserved the association before it. Either is a real saved chat a
location may name and a reader may open, and what it holds is that status — not
an absence of messages.

Omitting the chat follows the current one. An explicit identifier pins the
reading to that chat, and it has the usual controls only while it *is* the
active association. Every other saved chat is read-only: no composer, no
`[send]`, no `[retry]`, no Configure, no pending question and no `[stop]`
addressing it, absent from the screen, its focus order and its target map
rather than drawn and refused. A current-chat question or Configure drawer is
hidden while an older chat is read and keeps every value already typed into it.
Root actions still check the actual current conversation, so the selector can
never redirect an operation into old work.

**[Back to current chat]** sits outside the scrolling transcript. It clears only
the chat selector: the Sidekick stays the selected reading, and the current
message comes back exactly as it was. Selecting Entries, Sessions or Bindings
keeps the selection available for returning. Background work and resizing never
retarget a chat somebody explicitly selected and never take focus. An agent
change asked for from the chat being read returns to the new current chat by
clearing the selector; one that fails preserves both the reading and the
association it was asked of.

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

A route drawer begins below the whole contextual guidance block, so the screen
goes on saying how to close the drawer in front of it. The block is as many rows
as its words need at that width, and all of them stay visible: the drawer starts
at the later of its own old top and the row below the last of them. Its columns
and its bottom edge are unchanged, so the rows it moves down are spent out of
its own window rather than taken from the footer — a shorter window, still whole
by scrolling. The narrow outlet keeps its existing drawer, and the Sidekick's
pane-local question and Configure rectangles are its pane's own and unaffected.

The right pane's two tabs are its heading: `Bindings` and `Sidekick` side by
side on one row, in that order, each name said once and neither repeated by a
title of the column's own. Which one is showing is its active styling, and
keyboard focus is the separate mark it has always been — focus on a tab does not
select it until it is activated. Each tab is as wide as its own name, so a
pointer aimed at a name reaches the tab bearing it. When the Sidekick is the one
showing, the pane holds its acknowledged chat, the one box its messages are typed
into, and one control: `[send]` while it is idle, `[stop]` while it is working.
The tabs stay above the reading and the box below it, so the way between the two
readings and the place a person types do not scroll away with the conversation.

Every message keeps its own rows. A message is fitted to the width the pane was
measured at before anything counts rows, so its line breaks, blank lines and
whitespace survive and one that is wider than the pane is paid out over as many
rows as it needs — the message after it begins below the last of them. Nothing
is truncated and nothing earlier is dropped to make room.

The chat follows its newest messages. A message arriving, or a live preview
growing, moves the window far enough to keep the latest rows at the bottom;
earlier ones move up and stay reachable with the two controls that are already
there. Scrolling up is how you stop following, and that reading stays where you
left it while messages continue to arrive and be saved — reaching the end again
is how following resumes. A turn chosen from Sessions takes precedence over
following, and a previous chat stays where it was put while the current one
works. None of this is in the location: a copied location restores the chat
somebody selected and promises no scroll position.

Above the reading, one block says what the execution is doing, what the focused
control does, the way back to the draft and how to move. It takes as many rows
as its words need and says all of them: a direction you cannot see is a
direction you do not have, so nothing is shortened or dropped to keep it on one
row. The narrow profile's own shorter sentences already fit in one. A refusal's
explanation is paid out over rows the same way, at whole words.

Two input destinations, named: `Draft` runs a document as this execution's next
entry, and `Message Sidekick` asks the Sidekick. Enter in each one means its own
thing. Typing and Backspace reach whichever holds focus and leave the other
exactly as it was. Both texts survive switching tabs, navigating History and
resizing; the draft is in the location, and the message is this process's own and
appears in no location. An empty box sends nothing.

Each of the three columns keeps one blank row above its first heading. It is
layout space rather than a row of content: it holds no text, reaches no pointer
and is no stop for Tab, and both passes measure it, so what a column has left
for its reading is the engine's own remainder after it. Where a column has a
header band — the Transcript's and the right pane's — the band owns that row and
paints it with the header's own surface, so the space reads as the top of the
heading rather than as a strip of the reading pushed down. The sidebar has no
band and keeps its own surface there. The sidebar's lower `Entries` heading is
that column's second reading rather than the top of another column, and takes no
second gap. The narrow profile routes one outlet, heads no shared column and
takes no gap at all.

The Transcript's name is inset by the same two cells its body is, so the column's
heading lines up with what it names. The band around it keeps the whole inner
width: it draws the header surface and the rule that closes it, and only the row
holding the text moves.

The three columns share the row. The sidebar is thirty-six columns at both the
wide and the medium profile, and what is left is split equally between the
Transcript and the right pane, in whole cells, with the spare cell of an odd
remainder going to the Transcript. The right pane holds a conversation, which is
the reading that wants the room, and it is the same width under either of its two
tabs.

Thirty-six rather than a share of the terminal, because this column's two
readings are rows of text that have to be legible whole: `completed, not
recorded yet` is the longest state a turn carries and `All conversations
(filtered)` the widest control, and a row that cut a turn's state in half would
say something untrue. Thirty-six leaves thirty-two inside the body's gutter and
thirty past the focus marker, which is the room the column had before it was
inset — so the same rows fit, at the medium profile as well as the wide one.

The two controls that move a window — `[↑ earlier]` and `[↓ later]`, in
Sessions, Entries, the Transcript and the Sidekick — carry the surface of the
pane they navigate rather than the one every other control has. They are
activated, they are Tab stops and they read in the action's own ink; what changed
is only that they belong to the reading they move instead of standing apart from
it. Their background says which pane they are in and never where focus is: the
focus cue is the marker and the foreground, and moving focus on or off one leaves
its pane showing through. Everything else that is activated — `[send]`,
`[stop]`, a form's `[apply]`, the footer's own actions and a drawer's choices —
keeps the surface the draft has.

Every shared column's body sits two cells in from its pane on each side: the
Sidekick's chat with its window controls, composer and announcements; the
Transcript's directions, retained reading and the two controls around it; and the
sidebar's Sessions and Entries lists with theirs. Each column's heading — the
Transcript's band, the right pane's tab row, `Sessions` and `Entries` — spans the
whole column, because a column says what it is across its full width, and the
edge under a band spans it too. The gutters hold no text, are part of no row and
are no part of any pointer target; they carry the surface of the column they are
in. Bindings keeps its own layout, and the question and Configure drawers keep
the whole pane.

Text is fitted to the body that holds it rather than to the pane above it, so a
line too long for a narrowed body is paid out over more rows and the rows a
window cannot hold are reached with the controls that are already there. The
narrow profile routes one outlet, has no shared column and is given no inset of
its own.

`Message Sidekick` is drawn as a block: its name and focus marker on one row,
and the message itself in the rows the pane's measured width cut it into
beneath them. The name stays put, so you can still see what you are typing into
while the text scrolls inside it. An empty message is one blank row. The value
grows to at most six rows — the name is not one of them — and then shows its
newest rows, which is where you are typing; what is above them is still in the
message and Backspace brings it back. On a screen with less room the cap is
smaller: the composer is measured with its label and one value row, and it grows
only as far as leaves the chat a row. Growing it takes rows from the chat, which
keeps following its own newest messages as that room shrinks.

Wrapping is display only. The message Send carries is the text you typed, with
your own line breaks, blank lines and whitespace and none of the breaks the pane
drew — and long words are broken only between graphemes. The block is one field
throughout: one focus owner, one value, one Tab stop, and Enter and `[send]`
mean exactly what they meant on one row.

While the Sidekick is working the box stays editable, because composing the next
question while a reply comes back is the ordinary case — and what was typed then
is not sent by the cycle finishing. `[send]` offers nothing to activate while a
cycle is in flight, `[stop]` is what is offered instead, and Stop joins only the
Sidekick: an entry it already admitted belongs to the session and goes on
running.

What the response is saying arrives as it is written. The literal `<Output>` of
the source that has come back so far is shown in the chat as a preview, with
nothing pressed to make it appear, and the same item becomes the reply when
there is one. It is only ever what the agent has literally written: computed
text waits until something computes it, an example in a fence is an example, and
a prefix that cannot be read as a root shows nothing at all rather than source.
Nothing of it has happened — no control has run, no entry has been filled, no
turn is acknowledged — and a prefix that happens to read as finished is not
permission to run it.

A preview stays a preview while the response runs its controls, and only the
evaluated reply replaces it: actual Output, including the partial Output an
ordinary runtime failure leaves, with the effects it performed before failing
standing.

A reply that succeeded and selected no `<Output>` said nothing to the person,
and the chat shows nothing for it — no empty row, no sentence about the absence
and no bare name. It is not a failure and not an omission: running controls is
the work, and its account of itself is the saved turn in Sessions and its own
records. Its request stays where it is. A reply that *failed* keeps its recorded
reason in the chat whether or not it selected any Output, and where it had
rendered some, that text stands after the reason; a failure is a fact about the
evaluation, so what is shown of it never depends on what the response chose to
say. The turn a provider finished and whose evaluated reply nobody recorded is
neither of those, and keeps saying exactly that.

Generation can also end without a reply. A provider failure leaves the attempt
as this history saved it: the literal Output of what it had said, beside the
reason it stopped, and none of its controls run. That attempt stays in the item
its preview was in — one account of one failure, where the saved one takes the
live one's place inside the row rather than arriving beside it. A conversation
reopened later, which has no live row to keep, shows the same attempt as the
turn it was. A Stop leaves what was on the
screen as an attempt too, but claims nothing further — no turn, no acceptance,
no reply and no recorded failure — and nothing of it is written down to preserve
a screen, so a conversation reopened later has no account of it. A new message
replaces whatever was left that way.

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

Activating `[exit]`, pressing Control-C, Escape on the too-small refusal, EOF, a
renderer that cannot present, a terminal that fails mid-read and a cancelled
command scope all end the same way: the owner cancels and joins every Prompt, provider task, pending
permission operation, observer and frame subscription it started, appends nothing
after that, and gives the terminal's modes back exactly once. Work that was
interrupted leaves no record, because a record for it would be a record of
something that did not happen. What was already appended stays readable, and is
what a cold process shows.

One chord ends it, and it is the only one: Control-C, wherever it is pressed.
Raw mode clears `ISIG`, so no signal reaches this process and the byte is the
whole of the notice — which is why dropping it with the other chords left the
reflex every terminal program answers doing nothing, and saying nothing about why.
Every other Control or Alt combination is still dropped whole.

The command answers that key itself, where it answers end of input, rather than a
mounted control answering it: ending is a lifecycle outcome its owner decides, and
a key resolved by whichever row happened to have focus would stop meaning the same
thing from one screen to the next. It therefore leaves both screens a running
command can be sitting on, and they are not the same screen: the refusal below the
minimum size, which places no control at all and offers Escape besides; and the
one shown for a location this command cannot show, which does place a control.

Leaving that second one is still a refusal. The reason is reported, the status is
non-zero and no reopen command is printed, because a history that could not be
read is not a view anybody can be handed back — which is exactly what its own
Escape produces, and why this is one ending answered in two loops rather than two
different endings.

`[exit]` stays on the action row regardless, because leaving has to be a control a
person can see rather than a key they have to know — and because a pointer reaches
a control and reaches no keystroke.

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
row carries it and none is kept for it at any size. When the command ends it
prints the whole `xmd repl <location>`, under one line saying that is what
reopens this view: a person who has just had their terminal handed back wants
something they can run, and the screen that would have explained it has gone. The
command is indented rather than marked, so the line stays exactly what can be
pasted. The location is quoted, because it carries `?`, `&` and `=` structurally
and a shell would read them — and single-quoted safely, because every character
outside `[A-Za-z0-9-._~:@]` is percent-encoded, so a location can never contain
the quote that would close it. Source text, provider output and
an event's own origin are content and are shown as written, URLs included.

The History band is five rows at every size: its own name and the head on the
first, entry captions and which position is being read on the second, the tall
marks of entries on the third, the rule itself on the fourth, and the short
stems of everything else — with the head's own marker — on the fifth.

It is a map of the whole recorded order, which is the one thing on this screen
not read at the selected prefix. The positions after the selected one are
where a reader can go next, so a rail that stopped at the selection would be a
map of the part of the file they had already reached. What crosses is a marker
and a kind per position, and nothing of what any of them holds.

The map and the content are one reading, taken from one acknowledged array and
carried together through the frame. Nothing on this screen pairs a prefix with
a rail the file no longer has: a record retained while the terminal is being
measured changes the next reading, not half of this one. Where that reading
cannot be built at all, because the file holds a record this process can no
longer read, the whole screen is the refusal — not a rail standing beside a
prefix that still looks plausible.

Where a mark goes is a proportion of the rail's measured columns: the first at
the start, the last at the end, the rest evenly between, and a lone position
where the head is. It says where something is in the order and nothing about
when it happened. Two positions that land on one column are one *visual* group
and stay two positions — the drawer offers each its own row, so a compact band
never costs a reader an exact position. An entry keeps its tall mark and a
minor position its stem even when they share a column.

Everything the band reserves is measured. The right-hand caption is as wide as
the widest head label and the selection caption together, identically for every
head state, so a head changing from LIVE to SETTLING moves no mark and re-cuts
no caption; only the count, the selection or the size can do that. Entry
captions start one per entry, centred on its mark, and where two would touch
the leftmost pair becomes the span it actually covers — `Entry 4–7`, never a
number that is not there. A band that cannot fit its title and its head is the
frame refusal that already recovers on resize, never a clip.

The selection is amber above the rule and at its junction, with its place in
the full order beside it; a live reading says `SELECTED · HEAD` instead and has
no diamond. The head keeps its own colour below the rail's end, so a selection
on that same column keeps its diamond above and the head its marker below. The
rail is read, not operated: nothing on it is a control, and every position is
reached through the drawer.

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

The columns are told apart by more than what is in them. Each pane carries its
own surface across every cell it holds, a continuous one-cell rule parts it from
the column beside it, and a pane with a title draws that title on a surface of
its own — so the band naming a column reads as the chrome above a reading rather
than as the first line of it. The rule between two columns and the rule that
closes a header or opens the footer are different readings and are drawn
differently. A header's own edge is a row of the screen, taken out of the band
the title sits in and measured there, so a column with a title holds one row
fewer of its reading than a column without one — and the footer keeps its seven
rows at every size, because that edge is the header's and not the footer's. None of this is needed to operate the screen. Where
focus is, what the execution is doing and which of the two inputs you are typing
into are each said in text as well, so a terminal that ignores colour loses
nothing you need. The two pane tabs are the one exception: which of them is
selected is their styling, because the heading of the reading you are looking at
should not also spell out that you are looking at it. Which reading is showing is
legible without colour from the pane itself — the Sidekick's body is the box its
messages are typed into, and Bindings has none.

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

The Sessions surface presents the Agent work every entry did, in its own
**Entry agents** section, and an execution with no Agent work has one that says
so. The **Sidekick** section beside it is that execution's chat history, which
is not entry work and has no entry position.

## What this process is doing, element by element

While an entry runs, the screen can say where each element of it has reached:
entered, active, waiting, exited, and then settled, failed or cancelled. An
element that has returned stays in exit while its own cleanup runs, because
that is where it is — a component with a destructor has not finished until the
destructor has.

Waiting is counted, not guessed. An element waits when something it is actually
waiting on says so: a question nobody has answered, a permission request the
turn that asked for it owns, a hold the expansion controller is keeping. A
request nobody answers releases its wait when its scope goes, and decides
nothing on the way out. Each of those removes itself when it resolves, opening and closing a
drawer changes none of them, and ordinary suspension is not waiting at all. Two
questions at once are two waiting elements rather than one screen that is busy.

All of it is this process's, and none of it is written down. A cold process
reconstructs none of it, a reading frozen at an earlier position shows none of
it, and an entry that finishes takes its own with it. Source that is still on
the screen and a record the history retained prove only that something was
written and something was recorded — never that anything is running now.

## One entry, read as output and then source

The transcript pane holds one entry's reading: what it produced, and then the
source that produced it. A narrow frame has no transcript pane; its one routed
Entries outlet holds the catalog and the reading of the entry the catalog has
selected — the same two things the sidebar and the transcript are at a wider
size, stacked because there is one column for them. The catalog takes its own
height while it fits and its share when it does not, and the reading takes what
is left. The two share one vertical window, so going from an
answer to the reason for it is one movement rather than two panes to reconcile.
A reading belongs to an entry; with nothing selected it is the last entry the
prefix admitted, which is what a one-entry execution has always shown.

Output says which of four things is true, and never two of them. Text still
arriving is `Output · live`. The retained final result replaces it once and the
label becomes `Output`. A root that settled having rendered nothing reads `No
rendered output.` and then the outcome it closed with, and a recorded reason
beside it. A prefix that retained no output for its entry reads `No entry
output recorded at this checkpoint.` — never text borrowed from a later
position or from a run still going.

Which of those is shown is decided by what the record says, not by the words in
it. A document whose own prose contains `failed` is still output; a root that
closed `err` is a failure whatever it rendered. Nothing is attributed to an
`<Elicit>` or a `<File>`, reconstructed by concatenating block results, or
invented as a receipt for a bound value that emitted nothing.

Source is the exact text the entry admitted. Beside each row is a rail saying
which region the row is in, and against the pane's right inner edge is the
reading of the element that owns it — glyph and word together, so the reading
survives a reader who cannot tell two of these colours apart. Only the first
row of each delimiter carries one: a tag written across several rows is one
element, not two phases.

Nesting comes from where the delimiters are, and from nothing else. An element
whose span lies inside another's is that one's child; one that merely follows it
is its sibling.

A document that writes one element inside a `<Loop>`, or writes the same element
twice, makes several *calls* of it at one position. Each is its own reading, in
its own group, in the order they were observed: showing only the last would say
the earlier ones never happened, and one badge for all of them would say several
calls were one. An element nothing was observed of is read once, unobserved. Source nothing has been observed in gets the rail that means
exactly that, and acquires no phase from retained syntax.

An `<Evaluate>` that admitted a generated fragment shows that fragment where its
producer was written. The enclosure bytes stay exactly as authored and only what
they enclose is replaced, so the tags a reader sees are the ones in their file; a
self-closing one keeps its row and the fragment sits underneath it. The fragment
keeps its own offsets, because those are the only ones its own recorded
positions were ever counted in. A refused, absent or ambiguous admission keeps
the producer: nothing is matched by name or by sibling order.

Replacing what is displayed rewrites no submitted source and no record.

## Everything on this screen was measured

No text is clipped and none is estimated. Every width is an answer from the
engine that will draw it, asked through a probe that draws nothing, and every
break is at a grapheme boundary — a UTF-16 code unit is not a cell, and a cut
between a character and its combining mark makes two rows neither of which is a
character.

A line too long for its region is wrapped at the last word boundary that fits,
and a word longer than the region is broken at the longest grapheme that fits.
Whitespace is kept where it was typed, blank lines stay rows, and concatenating
one line's rows recovers exactly the line. A continuation is set in to the
column its own line was written at, so a wrapped line is still read at its own
depth; that indent is display, and no source byte or offset moves with it. The rail, the gap after it and the
status column are reserved first, from measurements rather than character
counts, and the column is wide enough for every reading a badge can hold —
including a cleanup wait, which says two things at once — so an element
settling cannot reflow the document beside it.

A question's own read-only preview is measured the same way, at the width its
drawer was given. A drawer row is one row, so a line left unwrapped has nowhere
to put its tail and the window has no second row to scroll to — reaching the
decisions below it is not the same as having read what they decide.

A region with no room for even one grapheme is the frame refusal that already
recovers on resize. It is never a clip: shortening somebody's source would be
this screen editing the content it exists to show.

## What is retained, and what is not

Include directories configure the current command. They add no location member,
manifest or profile record; pass them again when reopening if new work needs
them. The location remains route state, and existing events retain past work.

Each execution is one file of serialized ordinary `DurableEvent`s — the same
records any other XMD run writes. There is no manifest, no cache, no materialized
model, no checkpoint file and no record type of the REPL's own. The file and the
location are the whole of the state, which is what makes reconstruction from them
possible at all.

The location carries route state only: which surface, which entry and scopes,
which drawers, which history position, the draft for the next entry, which
reading is selected, which right-hand pane was being read and which saved
Sidekick chat is being read. Those members are independent — a location names a selected entry on either surface, beside a
drawer stack, a conversation filter and a frozen position, so going to Sessions
to follow a conversation and coming back returns you to the entry you left. The
Sidekick's two are independent in the same way: `view=sidekick` names it as the
reading while the surface underneath stays selected, `right=bindings` or
`right=sidekick` retains the pane, an omitted `view` selects the surface itself
and an omitted `right` means the Sidekick — so a location written before either
existed still names the view it described. `sidekick=<saved-chat-id>` is the
third, and independent of the other two and of `session`: `session` names an
actual provider conversation and filters the Sessions list, while `sidekick`
selects one saved CLI chat to read. Omitting it follows the current chat; an
explicit identifier has to name a chat this execution's readable Sidekick
history actually holds, including one whose setup was only prepared or failed
and has no provider conversation at all. An unknown identifier is refused rather
than answered with the current chat, a missing or unreadable chat history keeps
its own storage refusal, and an execution still held in the older single file
has no saved chat to select and is not upgraded by being read. It grants no
provider or execution capability: a stored location is no right to continue an
old conversation. It is encoded after every member that was canonical before it,
so a location written before it existed still comes back out spelled exactly as
it went in. A wide or medium frame therefore opens
with the Sidekick as the right pane's reading and the draft still holding focus;
a narrow frame routes one outlet and shows the Sidekick only where `view` names
it. The pane shows one of its two readings at a time: the one not selected is
absent from the frame, its targets and its focus order rather than hidden inside
it. Activating the Sidekick's own tab focuses its message box, because somebody
who asked to read it is about to type into it; default visibility claims no
focus. Selecting the Sidekick sets both and
changes nothing else; selecting Entries or Sessions clears the reading and
selects that surface; selecting Bindings retains the pane and puts the saved
surface back. Each of those keeps the selected chat available for returning to.
Resizing rewrites none of them. It never carries focus, pause state,
how far a window is scrolled, form internals, rendered cells, this process's
overlay, or the Sidekick's own question and Configure drawers, which belong to
the process that is asking. A copied location restores the chat somebody
selected and promises no row of it.

### The files an entry wrote in the checkout you are standing in

Start the REPL inside a Git checkout and an entry's file work is retained too,
under the ordinary records above and no record type of its own. Four things are
kept: a self-closing `<File path="…" as="…" />` text read; a paired
`<File path="…">…</File>` write, after its content has expanded; a self-closing
`<File.Delete path="…" />`; and the directory a paired `<Dir path="…">…</Dir>`
ensures, before its content is entered. The reads, writes and deletions an
admitted `<Evaluate>` fragment performs are kept on the same terms, because a
fragment's operations go to the same document filesystem an authored one does.

What that buys is the one thing experimentation needs: leave an entry at a
question, come back to the printed location, and the work it already did is not
done again. The question is offered again, and the write after it happens for
the first time when you answer.

A completed operation answers from what it produced, and reads nothing. So a
file somebody else changed in the meantime stays changed, a file somebody
deleted stays deleted, and a checkout you have since moved or removed does not
stop the entry continuing — only a *new* operation needs the checkout to be
there, and it fails or succeeds exactly as it would have the first time. The
honest cost of that is one window: work can happen and its outcome can fail to
be recorded, and a continuation then does that one operation again. Work that
*was* recorded before you left is answered from the record, so an edit somebody
made in the meantime survives the continuation untouched.

A retained read is the same rule, which is worth saying plainly because its
answer is a value you can see. The binding a completed read produced is the text
it read when it ran: a question showing that binding still shows it after the
file has changed, because nothing re-reads the file to answer an operation that
is already done. Type a *new* entry that reads the same path and it reads what
is there now. What is retained is each operation, not a value the session
remembers for a path.

Any of the four anywhere else — beside the document, in a temporary directory,
in any directory outside the selected checkouts and the marked entry's owned
workspace — is ordinary file work, is retained by nothing here, and happens again
if the entry is continued. A marked workspace entry retains the same four
operations in its workspace, including an ensure of the root, through existing
local-operation records and without a Git lease. Checkout routing and holds take
precedence where they apply. Completed workspace operations restore before live
resolution or I/O, just as checkout operations do. Searches and temporary directories are ordinary throughout, wherever
they point. The lexical path rules and the permission a `<File>` already answers
to are unchanged, and they are not checkout validation: a path this run may not
read or write is refused the same way it is anywhere else.

One entry at a time *changes* one repository. A second entry — in this process
or another — whose next new write, deletion or directory is in a checkout
somebody else is changing is told so immediately rather than waiting:

```text
Another XMD entry or process holds this checkout. End that work before trying
again. Nothing was read and nothing was changed.
```

Reading is not changing, so it is not excluded: an entry may read a file in a
checkout another entry is holding, and reading takes nothing that would stop
that entry carrying on. Only a new write, deletion or directory waits on the
hold, and a completed operation of any kind takes nothing at all.

Starting outside a checkout without an owned workspace retains none of this: the
entry performs ordinary file work, exactly as it would anywhere else, and never
looks for a repository twice. Selecting a Repository is a separate matter and
works from anywhere, which is the next section.

### The repositories and worktrees an entry selected

An entry may also work in a checkout it asks for rather than the one you are
standing in:

```xmd
<Repository name="project" url="/absolute/path/to/remote.git">
  <Worktree name="experiment" branch="experiment" as="worktree" />
  <Dir path={worktree}>
    <File path="note.md">first</File>
    <File path="note.md" as="held" />
    <Elicit schema={{ type: "string", enum: ["continue"] }} as="answer">Recorded value: {held}</Elicit>
    <File path="after.md">continued</File>
  </Dir>
</Repository>
```

`<Repository name=".." url={..}>` selects a persistent checkout beneath
`~/.xmd/repositories`, creating it the first time and reusing it afterwards.
`<Worktree name=".." branch={..}>` selects a linked checkout of the Repository
in scope, or — written outside one, in a directory inside a Git checkout — of
the repository you opened the session in. Written outside one with no checkout
around you, it refuses with the same actionable sentence it has always had: run
from inside a checkout, or write a `<Repository>` around it. Both forms behave
as they do anywhere else: paired, they scope their content and the working
directory; self-closing, they render nothing and return the checkout path, which
a sibling `<Dir>` may then render at. Who creates, reuses or refuses a managed
checkout, and in what words, is unchanged — it is the same selection an ordinary
`xmd run` performs.

What is new is that the selection is retained. Leave the entry at the question
above and come back to the printed location: the Repository and the Worktree
answer from what they recorded. No checkout is cloned, no `worktree add` runs, no
sidecar is read, no credential is opened and no lock is taken to answer them.
The file work inside them answers from its own records exactly as the ambient
section describes, and the write after the question happens for the first time
when you answer.

A completed selection says where the entry was working. It is not a claim that
the checkout is still there. Remove it between leaving and coming back and the
entry still continues — the selection answers, the completed reads and writes
answer, and nothing is recreated or repaired to make that true. Only *new* work
meets today's filesystem: a new read of a file that is not there fails exactly as
it would have the first time, and a new `<Dir>` creates the directory it names,
because `<Dir>` creates directories and is not checkout validation. A new entry
selecting the same Repository selects it afresh, which is an ordinary reuse of
whatever is on disk.

Two holds answer two different questions, and a message tells you which one you
met. One entry at a time *owns* a managed checkout: a second entry asking for
the same Repository or Worktree is refused immediately, naming the checkout, and
may have it once the first entry has been torn down. Separately, one entry at a
time *changes* one repository, which is the shared-Git-directory hold the
ambient section describes — a new `<Worktree>` takes it, because creating a
linked checkout writes into administration every checkout of that repository
shares, and a new write, deletion or directory takes it too. Neither hold is
taken to answer a completed selection or a completed file operation, and a read
takes only the ownership of the checkout it is reading in.

Publication remains unavailable here; the exclusions below say which components
those are. The two sections after this one say what else an entry retains: the
Git work it did in these checkouts, and the issues it filed and read, which need
no checkout at all.

### Staging, switching and committing in an entry

Inside a Git checkout with a commit in it, type this:

```xmd
<File path="note.md">first</File>
<Git.Commit message="Record experiment" as="commit">
  <Git.Add paths="note.md" />
</Git.Commit>
<Elicit schema={{ type: "string", enum: ["continue"] }} as="answer">Recorded commit: {commit}</Elicit>
<File path="after.md">continued</File>
```

The staging child finishes before the commit starts. The commit writes the
current index — nothing is staged for it and nothing is amended — and `commit`
binds its full object id. Leave at the question, change the file, stage
something else and make a commit of your own from a shell, then come back to the
printed location. The question still shows the object id the entry recorded.
Nothing ran again: not the write, not the staging, not the commit, and not a
single `git` command. Your file, your index and your HEAD are exactly as you left
them. Answering performs the write after the question for the first time.

That saved id describes the earlier commit. It is not today's HEAD, and nothing
re-resolves it. A *new* entry that stages and commits commits what the checkout
holds now.

The same body works inside a lexical `<Repository>` and inside a selected
`<Worktree>`, including a self-closing Worktree's captured path entered through
`<Dir>` while the enclosing Repository stays the owner. A new `<Git.Switch>`
uses the ordinary rules: named branches only; an existing branch ignores a
creation-only base; a missing branch starts at the base you supplied or at live
HEAD; Git refuses a branch another checkout of the same repository holds, and
refuses changes it would overwrite. A completed Switch restores its result
without switching anything back.

A refusal you asked for is retained as a refusal. Repair the checkout after it
was acknowledged and that historical answer stays a refusal — a *new* invocation
can succeed. `<Git.Add>` is not all-or-none: a pathspec naming an ignored path
stages what Git already matched and then refuses, and nothing here undoes that.
`<Git.Commit>` refuses an index that already matches HEAD rather than making an
empty commit, and refuses when this host cannot say who the commit would be by —
the message names the two commands that fix it, and no other identity is
substituted for yours. That refusal reaches Commit alone.

Who the commit is by is read from your own Git once per entry, and only when a
commit really runs. An entry that commits nothing, and a reopened entry whose
commit is already recorded, ask nothing about who you are. Hooks, signing,
filesystem monitors and repository credential helpers stay disabled.

What an entry writes down, it can read back. A result this build cannot parse,
or one that does not describe the operation it stands at, ends the entry before
anything is recorded rather than becoming a saved answer no continuation can
use.

Native completion and acknowledgement are different moments, and the gap is
real. Interrupt an entry after the commit object exists and before its result is
written down, and the journal holds no completion: the commit is in your
repository, and a continuation runs that `<Git.Commit>` live. It may then refuse
`empty-index`, because the earlier attempt already consumed the index. Nothing
adopts the commit that was made, predicts an id or rolls anything back.

The first new Git operation inside a restored placement takes that placement's
ownership of the managed checkout and then the hold on the repository it is
changing, in that order, and keeps both until the entry is torn down. A
completed Git operation takes neither. A no-op Add, a same-branch Switch and a
Commit that will refuse take them too: whether `git` will change anything is not
predicted.

### Reading the repository an entry is standing in

An explicitly configured observation worktree joins only the private read
routes. Its version 1 `observation-worktree` placement records the normalized
request and credential-free routing facts before any page is served. Completed
replay parses those facts and pages without native inspection or ownership.
New native reads require the current explicit grant and identity validation and
reacquire an entry-owned nonblocking observation lock outside the checkout.
This lock is separate from the mutation lease and serializes participating
observation owners; it does not exclude arbitrary external Git. Reads share the
entry's existing Git sequence turn. Failed or uncertain placement persistence
fences the entry and yields no successful observation. An incompatible record
or version refuses before reuse. Hosts that lack this record kind cannot reopen
histories containing it.

Inside the same checkout, type this:

```xmd
<Git.Files prefix="src/" limit={5} as="files" />
<Git.Changes compare="unstaged" as="changes" />
<Git.Diff compare="unstaged" limit={4096} as="diff" />
<Git.File commit="HEAD~1" path="src/expand.ts" as="before" />
<Json value={files.paths} />
```

Four reads and nothing changed. `<Git.Files>` lists the tracked paths the index
holds, relative to the repository root, excluding untracked files and the
contents of any checkout nested beside them. `<Git.Changes>` reports each
changed path with Git's own letter for what happened to it, for the index
against the working tree, HEAD against the index, or two commits you name
directly. `<Git.Diff>` answers the same comparison as patch text. `<Git.File>`
answers the text one commit holds at one path — the commit's bytes, not the
working copy, so it still answers after you have edited the file.

A page is bounded: 100 records, or 4096 characters of text, unless you ask for
more. Ask for more and you get more; nothing caps it beyond what a number can
represent. When something remains, `next` holds the complete arguments of the
read that continues it, so a later entry follows it by passing the value back:

```xmd
<Git.Files prefix={files.next.prefix} limit={files.next.limit} cursor={files.next.cursor} as="more" />
```

Follow one after the answer has changed and the read refuses rather than
stitching two repositories together: *The Git observation changed. Restart
`<Git.Files>` without cursor.* A change elsewhere that does not alter this
answer needs no restart, and raising `limit` between pages is safe — a limit is
how much of an answer to return, not which answer it is. `<Git.File>` carries
its resolved commit in `next`, so moving the branch under it changes nothing
about the file you are reading.

Leave an entry at a question after these reads, change every file behind it, and
come back. The saved pages answer again: the same paths, the same statuses, the
same patch window, the same commit — and not a single `git` command. The entry
after it inherits those bound values and can render members of them without
reading anything. Reads after the question run for the first time, against the
repository as it is now. Delete the checkout outright and the saved pages still
answer; reading one consults nothing.

A refusal you asked for is retained as a refusal, exactly as a transition's is.
A revision that names no commit, a path the commit does not hold, a directory or
a nested checkout's recorded commit where a file was asked for, and a file that
is not text each say which it was and what to write instead. A directory is a
directory under either spelling: `src` and `src/` both refuse, and neither
answers with something found inside it. None of them quotes
anything Git printed.

These reads change nothing, so they take no hold on the repository you are
changing: another entry committing in the same checkout does not wait for a
read, and a read does not wait for it. Inside *one* entry it is the other way
round, and deliberately: one read runs several Git commands against one private
index copy, so that entry's own `<Git.Add>`, `<Git.Switch>` or `<Git.Commit>`
waits for the read to finish and be written down before it runs. Nothing moves
under a sequence already in progress. The first new read inside a restored
managed placement takes that placement's ownership and nothing else; a completed
read takes neither. Hooks, signing, filesystem monitors, external diff programs,
text conversion, content filters and repository credential helpers stay
disabled, and no read reaches a remote — a missing object refuses instead.

### The branch an entry published

Inside a lexical `<Repository>` — or a `<Worktree>` of one, including a
self-closing Worktree's captured path entered through `<Dir>` — type this:

```xmd
<Repository name="project" url="/absolute/path/to/remote.git">
  <Git.Switch branch="review/push" />
  <File path="notes.md">Ready for review.</File>
  <Git.Add paths="notes.md" />
  <Git.Commit message="Prepare notes" as="commit" />
  <Git.Push />
  <Elicit schema={{ type: "string", enum: ["continue"] }} as="answer">
    The branch containing {commit} was published. Continue?
  </Elicit>
  <File path="after.md">Continued.</File>
</Repository>
```

`<Git.Push />` takes no props and no content, renders nothing and binds nothing.
It publishes the branch the selected checkout is on to that Repository's origin,
without forcing and without changing upstream tracking.

Leave at the question, make another commit on that branch from a shell, then come
back to the printed location. The branch on the remote still holds the commit
the entry published, nothing was pushed a second time, and no `git` ran at all.
Answering performs the write after the question for the first time. A *new*
`<Git.Push />` after that publishes what the checkout holds now, which is what
makes this retention rather than a cache.

What is written down before anything is contacted is the *request*: the branch,
the commit, the destination ref and the origin this publication asked for. So an
entry interrupted between asking and hearing back publishes that same request
when you continue it — the commit it named, not today's HEAD — and an entry whose
push the remote accepted and whose result was never written down adopts that
completion rather than repeating it. One publication happens, not two.

The decisions are the ones publication has everywhere else. A destination that
does not exist yet, and one holding a commit this branch already contains, are
published once with an exact non-force refspec. A destination already holding
this exact commit is adopted and nothing is pushed. A destination holding work
this branch does not contain is a conflict: nothing is published, nothing is
forced and nothing is fetched. Permanent ambiguity and a host that could not
answer are their own refusals, and an acknowledged refusal replays as itself
rather than being retried for you.

A detached HEAD refuses before anything is contacted, because a commit is not
somewhere to publish it. A checkout that records no usable origin refuses on the
same terms. Neither writes a request down, and neither reads a credential.

Your checkout's own configuration cannot redirect a publication: the transport
runs in a repository this run created, reading your objects through a read-only
door, so a `pushurl`, a URL rewrite, a `pre-push` hook or a credential helper
written into the checkout reaches nothing. The commit a saved request named has
to still be readable — a missing object refuses rather than being fetched — and a
moved branch or HEAD alone refuses nothing.

A publication takes ownership of the managed checkout it reads from, and takes
no hold on the repository itself: it changes no file, index, branch or
configuration there. Another entry committing in that repository does not stop
it; another entry holding the checkout does, before a request exists.

### The pull request an entry opened, and the feedback it read

Write the rest of the common path beside that publication:

```xmd
<Git.Push />
<PullRequest title="Prepare the release" as="pullRequest">Ready for review.</PullRequest>
<PullRequest.Reviews url={pullRequest.url} as="reviews" />
<PullRequest.Comments url={pullRequest.url} as="comments" />
<PullRequest.Checks url={pullRequest.url} as="checks" />
```

`<PullRequest>` opens a pull request for the branch this entry published, or
brings the one you numbered up to date, and binds its number, URL, state and
head and base commits. It publishes nothing itself: what admits it is this
entry's own last acknowledged `<Git.Push />` of that branch, from this checkout,
at this commit. A publication by another entry, by another checkout, or one a
handler answered without reaching the Git host authorizes nothing, and neither
does a failed or still-pending one. A refusal happens before a request is
written down, before a credential is read and before anything is contacted.

The three reads name a pull request by URL and need no Repository and no working
directory at all. Each binds its own array, and each is its own retained
snapshot: reviews are not comments, and a partial answer binds nothing.

Leave at a question after all four and come back to the printed location. The
pull request answers with the number and URL it was opened under, and each read
answers with the array it saw — no second pull request is opened, no collection
is asked for again, and no `git` runs. What you get back is what this entry
acknowledged, even if somebody has reviewed it since.

An entry interrupted between asking for a pull request and hearing back opens
*that* request when you continue it: the title, the verbatim body, the draft
state, the base and the original head commit it named, however far the checkout
has moved. One pull request is opened, not two, and one whose creation the
service accepted but whose result was never written down is adopted rather than
repeated.

A read written *after* the question is new work, so it reaches the service and
answers with the feedback that is there now. That is the difference between
reopening an entry and writing a fresh read in it.

Which pull requests you may read is the operator's to state, beside the
credential, rather than the document's. A URL outside what this host authorized
refuses — including on reopening, so permission withdrawn while you were away is
withdrawn for the continuation too.

### The issue an entry filed, and the one it read

An entry files and reads issues wherever you started the REPL, inside a checkout
or not. Nothing about it needs one: no repository is discovered, no managed root
is made and no lock is taken.

```markdown
<IssueTracker url="https://github.com/octo/project">
  <Issue title="The REPL loses a pasted newline" as="filed">
    Pasting two lines into the draft submits the first one.
  </Issue>
  <Issue url={filed.url} as="found" />
</IssueTracker>

Filed {found.url}, titled {found.title}.
```

`<Issue title=…>…</Issue>` files one issue in the enclosing `<IssueTracker>`,
using its expanded content as the description, and binds `{ url }`.
`<Issue url=… />` reads one and binds the fields every tracker has: the URL, the
title, the description, the tags and the assignee. Both are the ordinary
components the language already documents, and a REPL entry writes them exactly
as any other document does.

What is new is that both are retained. Leave the entry at a question and come
back to the printed location: the filed issue answers with the URL it was filed
under and the read answers with the snapshot it saw. No tracker is asked again,
no configuration is read and no credential is opened to answer either of them —
and the read still says what it said even if somebody has edited the issue since.

An issue lives at a service rather than in your checkout, so the interrupted
case is the one that matters. An entry whose upsert was accepted by the tracker
and interrupted before this end could write it down retains nothing: continue it
and the same attempt is made again, under the same key it used the first time.
The tracker recognizes that key as its own mark and answers with the issue that
is already there. One issue is filed, not two. A read has no key and reconciles
nothing — an interrupted one is simply made again, which is what a second
observation of a live object is.

A refused tracker stays refused. Whether this deployment may reach a target at
all is the operator's `XMD_WORKFLOW_GITHUB_ISSUES` ceiling, and a target outside
it sends no request and carries no credential. A conflict, an ambiguity or an
unavailable service keeps the provider's own vocabulary here exactly as it does
elsewhere.

## What the head says the execution is doing

Seven states and no eighth, in one precedence, each a fact about retained
records and about work this process actually owns:

| | Reading | When |
| --- | --- | --- |
| 1 | `HEAD · SETTLING` | an outcome is retained and the entry's work is still coming down |
| 2 | `HEAD · EXPANSION PAUSED` | no outcome, and the controller is paused |
| 3 | `HEAD · PAUSING EXPANSION` | no outcome, and it is pausing |
| 4 | `HEAD · LIVE` | work this process owns, and none of the above |
| 5 | `HEAD · EMPTY` | nothing retained and nothing owned |
| 6 | `HEAD · SETTLED` | no owned work, and the latest entry has an outcome |
| 7 | `HEAD · UNFINISHED` | no owned work, and it has none |

Owned work means every resource the entry acquired is still standing — its
outer Agent attachment and its consumers included. A body that returned and a
root Close that was recorded are both earlier than that, so neither of them
says an entry has finished; `SETTLING` is the window between them, and it is
the one a reader watching a run end is actually in. A retained success, a
failure and a cancellation all become a neutral `SETTLED`: which of them it
was belongs to the reading, not to the head. An entry with no outcome and
nothing holding it is `UNFINISHED` — stopped, never an inferred pause.

Pausing stops expansion, not work that has already started elsewhere. A head
that changes while nothing is appended publishes through the wake the session
and the controller already send; History has no clock of its own.

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

Repository and issue behavior belong to the entry that is executing, and to
nothing wider. The command selects it; the entry's own task prepares it, once, inside
that task, and everything it takes — the Git session it reads through, where it
looked for a checkout, the managed checkouts it selected, the hold on each of
those and the hold on the repository it changes — is released when the entry is
torn down. The selections an entry made are its own: a continuation rebuilds
which checkouts it was working in from what it recorded, and rebuilding them
reaches nothing. Each entry reads and writes its own range of the one history, so
the same text typed twice is two sets of records rather than one replayed, and
the entry after an interrupted one replays nothing of it however identical its
text. No second name for the entry appears in a record: which history an entry
may continue is the range it was given. Reading is not owning: a settled
history, a frozen position and a refused location prepare nothing, look for no
checkout and hold nothing. A host that registers no recording runs the same
file work with nothing retained, which is what Node and Bun do even in a marked
workspace. Deno and compiled hosts retain workspace file work through their
existing recorder; `<Issue>` and
`<Git.Push />` there report that no provider is installed, exactly as they do
under any other host that installs none.

An entry's publication and issue work are named by the execution and the
entry's own position in it, and by nothing else. Two entries holding identical
text are two entries; an entry of another execution is somebody else's; and a
tracker URL, a prop, a component answer and anything else a document can write
take no part in it. That is what makes the interrupted upsert above answerable:
the key is derived from facts that survive leaving and coming back.

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
is dropped whole rather than typed as the letter it was pressed with, except for
the two the host names: the newline inside a paste, and Control-C, which arrives
as a key the command answers by ending. A pointer is resolved against the exact frame that produced
its coordinates, so a stale frame, a node that has gone and a target behind a
drawer all reach nothing — and activating a control with a pointer produces the
same action as pressing Enter on it.

Presentation time has one owner: a single acknowledged frame stream, advanced only
once every subscriber has applied the previous timestamp. A settled screen
schedules no timer.

Submitting is not on the input loop. Validating a document and starting an entry
both suspend, and the keyboard belongs to the person throughout: the draft keeps
taking what they type, Pause and Exit keep working, and what the submission
finishes with is reported back to the loop rather than written from inside it, so
the screen has one writer. There is one next entry slot, reserved before the slow
part begins, and one gate decides who takes it — a person pressing Run and a
reply asking for the same thing are answered on the same terms.

What the gate decided is checked again when the entry actually starts, because
validating suspends and everything the decision rested on can move while it
does. A person who walked back to a recorded position, typed into the draft, or
withdrew the request has changed what they are asking for, and the submission is
refused at the start rather than admitted on the strength of the earlier answer.
A refusal there admits nothing, appends nothing and leaves the draft where it is.

A reply's submission is written down before the slot it took is acted on; a
person's Run is not. The difference is who is waiting: a person pressing Run can
see what happened if the process dies, and a reply asked for an entry inside a
response that is itself retained, so something will read its controls back. The
Submit intent therefore binds what it took: the entry id it claimed, the exact
source, the draft revision that source came from, how many entries preceded the
slot, and — separately from that count — the entry journal the slot was counted
in, as a record count with the byte count and digest of exactly those records.
New Sidekick intents additionally carry only optional `workspace: true` inside
that existing submit object. Its outcome is written once the entry has one.
A present marker other than true refuses. Absent markers retain project cwd,
including older Sidekick entries; a manual entry has no Submit marker. An older
binary that rejects unknown members refuses new marked histories rather than
silently downgrading them.

The count and the journal binding are different facts. A count of earlier
entries names a slot; it cannot say which records preceded that slot, so a
different valid history of the same length satisfies it. Only the retained bytes
distinguish them, and they are measured off the file rather than from re-encoded
records: re-encoding rebuilds an envelope in the reading process's own member
order, which is a valid encoding of the same history and not the same bytes.

They also have to be the bytes of the whole history, not of the prefix the
screen is reading. A screen opened at a recorded position keeps showing that
position, and that is deliberate — but where somebody is reading is not what the
next entry is called. Both submitters count the entries the file holds, so the
person's Run and a reply's Submit cannot disagree about the next slot, and a
reopening reconciles a reservation against every entry rather than against the
ones its opening happened to include. A history this process cannot read
supplies no count at all: it refuses, because an unreadable history is not an
empty one.

The bytes have to be *acknowledged* ones. Owning the next slot stops another
submitter taking it; it does not stop an append already issued from landing, and
a file that only grows still has a moment in which a record has been written and
not yet acknowledged. So the order is: establish that the session will take an
entry at all, let the entry writer settle, then bind, then acknowledge the
intent. A session that is ending, running an entry or following an unsettled one
refuses before any of that — a refusal is a refusal, not work that waits for the
entry in flight, and a refusal discovered after the intent was written leaves a
record claiming an attempt that was refused on terms it could have asked about.

Reopening answers any Submit intent that has no outcome before it admits
anything else, and answers which history first. If the entry journal no longer
begins with the records the reservation was taken against, that refuses — before
either finding, because reporting that nothing took a slot this reading cannot
locate is as much a claim about the history as reporting that something did.
Once the binding holds, the reservation is found by the slot's ordinal, the entry
id and the source together: the slot is either occupied by the entry it named
under the bytes it reserved, or nothing took it. Those are two real states — a
process that stopped before the entry existed, and one that stopped before the
receipt — and anything else is the two files disagreeing, which refuses rather
than picking. Records after the bound prefix are ordinary; the entry the
reservation reserved is one of them.

Placement matching happens before session opening can initialize or resume the
unfinished final entry. It reads the original relevant Submit even after its
control is settled, so another reopen preserves placement. A completed entry is
projected without execution, and old records are never rewritten.

The finding is projected cold, with nothing appended and no conversation opened,
and is retained at the next explicit mutating action. Nothing is acted on: an
entry that was never admitted is not submitted now, and one that was is not
re-run.

What a reply reads is about the history rather than about the screen. A person
standing at a recorded position, inside a nested scope or on either tab has
changed nothing the file says, so the reads answer from the acknowledged head —
and the bindings read is the projection's own record of durably published root
values, not the pane that displays them. A running entry's text is the one thing
no record holds; it is credited to the entry whose task is producing it, because
the overlay a screen shows answers at the position its session was opened at and
would otherwise report an earlier entry's retained output as the running one's.
No read starts an entry, resumes one or waits for one: a running entry's window
is a truthful snapshot of what it has printed so far rather than a promise of
more.

A reply's own vocabulary and an entry's are described separately, because they
differ: a construct that is ordinary in an entry can be unavailable in a reply.
What a reply may write is the compact surface derived from what is admitted; what
an entry may write is a read, answered from the same construction and renderer
that answers on the command line, over this command's own includes and plugins.
Describing a component neither resolves nor admits it.

The host's facts are read where they are known. The working directory and the
platform are contextual and read at the ask; the runtime, the build and the
release it belongs to are stated by the host a runtime entrypoint installed; and
the command's own come last — where a declared name is looked for, which Plugins
it installed, and how an Agent permission request is answered. The Plugin
selection is reported as names, in the command's order, and never as the values
that provide what they contribute. A fact the host cannot state is reported as
an explicit unknown rather than omitted or given a default, an empty Plugin
selection is reported as none rather than left out, and a host that describes
itself not at all refuses the read rather than returning a snapshot with a hole
in it.

The Sidekick belongs to the execution, and one explicit message is what makes it
act. One is acquired per running REPL — for a fresh execution, a cold reopening
and either storage shape alike — and selecting a tab, navigating History,
selecting an entry or resizing reaches that same conversation rather than
creating another. Reopening restores its conversation and its chat and asks a
provider for nothing: no handle is opened, no turn is sent and nothing is
written until somebody says something. An execution still held in the older
single file is upgraded by that first message and by nothing before it, and
while that handoff is in progress the screen holds new entry admissions and says
so — an entry already running continues through the same movable writer, keeps
its execution id, its route and its task, and its later appends reach the file
the pair published. Those appends wait for the handoff rather than racing it: a
record issued after the history's bytes have been copied is held until the
writer has moved, so nothing lands in the file the pair superseded and the
history the pair names is the whole of it. Typing, Send and Stop stay usable
while a record waits.

The screen is drawn again whenever the Sidekick's own reading or busy state
moves, not only when somebody presses a key: a reply arriving, an automatic
follow-up starting, a cycle failing and a joined Stop are all things no keystroke
announces. That notification carries nothing and authorizes nothing — the screen
reads the conversation afresh when it is told to look.

Sending a message captures the exact text and the revisions it was asked at, and
reserves the one cycle this screen may have in flight before any work starts, so
a second Send in the same burst asks for nothing rather than queueing a second
turn. The message box is cleared only once the message is physically in the chat
history, and only the revision that was sent: a person who typed again while the
append was in flight keeps what they typed, and one who went back to the shared
draft keeps the draft, because an instruction sent before their edit is not what
hands it back. The provider is asked nothing until that has been applied.

A reply may ask a question, and it is answered in the Sidekick's own pane. When
one is waiting, the pane says so and offers one control that opens its form; the
Sidekick's tab says so too while that pane is the hidden one. Arrival announces
and nothing more: it changes no selected tab, no route, no History position, no
focus and neither composer, and it opens nothing. Opening is a deliberate act,
and only that act opens it.

The form is the same bounded form an entry's question is asked through — the
complete message, the fields in their declared order, an enum's offered values,
the conditional required markers, what the last attempt was told was wrong, and
the control that submits — shown through one window inside the pane that owns it,
above the unchanged seven-row footer. It covers that pane while it is open, so
Stop comes with it: a question a reply is waiting on can be stopped from in
front of it. The way out of the form is its own close, exactly as an entry's
drawer is left before anything behind it can be reached.

What is typed into it is kept. An answer the schema rejects leaves the same
question waiting with every value where it was typed and says what is wrong;
closing the form, or going to another pane and coming back, keeps the question,
the values and those messages — and brings the form back only when it is opened
again. A field named `message` or `draft` edits that form and neither composer.
A different question starts with an empty form, because values typed for one
question are not an answer to another, and a question that ends takes its form
with it. None of this is in the location or in any record: it is a fact about
this process holding a suspended request, so a cold reopen shows what the
stopped process wrote and no live form at all.

An answer the schema accepts ends the question, is recorded once by the same
canonical operation that records an entry's, and reaches the reply that asked as
its own designated feedback. The two owners stay independent throughout: an
entry may be asking at the same moment, neither answer can be taken for the
other, and Stop withdraws the Sidekick's question — with no answer and no
outcome — while the entry's stays waiting and answerable.

The agent, the model and the thinking effort are configured in the Sidekick's
own pane. Configure says which agent this conversation is with, what has been
*asked for* and what the agent was last *verified* on — two separate lines,
because a preference is a request and only a turn that actually started says
what was applied. Opening Configure explicitly asks the agent what it offers;
while a turn is running that read refuses and says so, and the choices already
read for this conversation stay usable. Effort belongs to a model: choosing a
model leaves the previous model's levels behind rather than carrying them over,
and an unread model's levels say so instead of being filled in from another's.

Only one of these actions runs at a time, and each of them is one thing a
person asked for: while an inspection, an Apply or a replacement is running, a
message and another of those actions are both refused before anything is written
or asked of the agent, and the reason is said in the drawer that was pressed. A
preference Apply is the one action admitted beside a message already running,
because saving a preference is a record of this history rather than work the
conversation does.

An agent that advertises more choices than the drawer can draw is read by
scrolling it, with the drawer's own controls: a choice below the window is still
a choice, and nothing is dropped from the list to make it fit. Those controls
read **scroll up** and **scroll down**, because this window moves through a list
of settings rather than through a recorded order — every other window in this
program is a reading of something that happened, and those keep Earlier and
Later. `[close]` sits outside the window with them, so no length of list can
scroll the way out of this drawer off the screen.

Apply saves and closes — the selection that asked for it, and only that one. A
drawer closed and deliberately opened again, or edited while an Apply was still
running, is a different selection, so an answer arriving late leaves it as it
is rather than closing it or applying itself to what is on the screen now. That
it holds the same model or the same effort does not make it the selection that
asked: a drawer reopened after a save is initialized from exactly what that
save asked with. Close discards what was chosen and not applied and
changes nothing — the list the agent gave is not a selection, so reopening
reuses it and shows the saved preference again. A failed Apply keeps every
choice and says why.

Escape closes Configure, and closing it means that one thing: the visible
`[close]` control and Escape are two ways to ask for the same act, not two
meanings of it. Either way nothing is saved, no agent is asked, neither composer
is touched, a pending question keeps its own values, a preference already
acknowledged stays saved, and focus goes back to the control that opened the
drawer. A route drawer in front of Configure owns Escape while it is there: the
first one closes that drawer and exposes the Configure held underneath with
every choice still in it, and the next one closes Configure. A Configure that is
not the thing on the screen — behind another pane, another tab, or a drawer in
front of it — consumes no Escape at all. A saved model or effort is used by the *next* turn, which
is where an agent can actually be asked: saving asks nothing of it, stops
nothing, and leaves a turn already running on the settings it was given. A
setting left out asks for no change to it and resets nothing.

Entering a different agent is explicitly starting a new conversation, and the
control says so before it is pressed. The old chat and what it was with stay in
the history; the new conversation starts empty of them, and nothing of the old
agent's choices goes with it. A replacement that cannot be set up leaves the old
conversation active and its reason in the drawer.

A request whose turn failed can be asked again. Retry sends that request's own
saved text as a new message in the same conversation — not whatever is in the
message box, which is neither sent nor cleared by it — and it takes the same one
cycle a Send does. The failed attempt stays exactly where it is. A request whose
acceptance this history cannot establish is not offered again, because the agent
may already have it; neither is one this conversation has moved past, because
something asked after it has since been answered. Both stay in the chat and
stay readable — what goes is the offer to send them again.

A conversation is continued only under the configuration it was created with.
What the Sidekick's provider is building a session under — those tools, servers,
permission settings and that system prompt — is written into the conversation's
own history before anything native can be created, and the next explicit message
is checked against it. Reopening checks nothing, because reopening asks for
nothing. One unsupported difference refuses before the provider reattaches, and
the chat, its turns and what it was created under all stand; nothing is created
in their place, and the person is told why rather than being given a new
conversation that looks like the old one.

One message does these things in this order: establish storage, resolve the
conversation, open it, deliver the orientation if this conversation has not been
oriented, write down what the person said, send one turn, and evaluate
what came back. Each step that can be read back is written before the work it
describes, so a process that stops in the middle leaves an account of what it
was doing. A fresh conversation is recorded as prepared before it is opened and
as activated only once setup succeeded; a failed setup is recorded as failed and
activates no replacement.

Which agent answers is the conversation's own, settled when it was opened and
never changed in place — so reopening continues a conversation under the agent
it was opened with, whatever this process was started with, and choosing a
different agent explicitly starts another conversation. The chat a person has
already read stays in front of them, and the new conversation records which
association it replaced. It becomes the one in use only once it is set up and
the agent has answered for itself; an agent that cannot be reached is refused in
its own words, leaving the conversation a person was in exactly where it was.
Nothing falls back to another agent, and making the change sends nothing.

Which model and effort it runs under is a request this history holds and the
next turn puts into effect, because a configuration can only be asked of an
agent on a turn. It is applied model first — effort levels belong to a model —
and read back, so a turn that happened ran under what was asked for. An agent
that refuses the request leaves the turn unsent and says what it does offer, and
the request stays recorded: a Sidekick that quietly dropped it would answer as
something nobody chose. What a person chooses between is the agent's own answer,
read only when they ask for it, through a session the provider takes and gives
up again — so opening Configure costs no turn. A setting an agent does not offer
is reported as offering nothing, which is not the same as offering an empty list.

The orientation — the bootstrap, the derived guide index, the compact
description of the admitted response controls — travels with a turn when the
conversation has no canonically completed turn. The draft travels with every
turn, because it is the piece that changes. Exactly what was delivered is
retained, with a digest of those bytes, as a fact about that turn.

It travels again, once, when the orientation this build would give differs from
the orientation the conversation was last *given* — and given means delivered,
not offered. A reference record is written before the turn that carries it, so
by itself it says only what was meant to be sent; what establishes delivery is a
canonically completed turn whose retained input actually carried that text.
Neither half is enough alone: a record with no completed turn is an offer whose
fate is unknown, and a completed turn whose input carried something else is a
record about a different turn. An offer is reconciled rather than dropped: the
turn that owns it is the first completed turn recorded after it that was sent
exactly that text, so a delivery whose own marker never landed is still read off
the conversation. What cannot be matched that way stays unresolved — it is not
promoted to delivered and not discarded because the work that composed it is
over — and nothing resends it, because guessing whether a provider already
accepted a turn is the one thing that cannot be corrected afterwards. So a refresh whose turn fails is still owed by the next
explicit message, and the record it left stays readable without claiming to have
superseded anything. Nothing inside one run can
differ — the assets and the admitted ceiling are fixed for its lifetime — so the
case is a conversation continued by a later build, and the only honest way to
notice is to compare the digests retained against the ones current. A refresh
re-orients and nothing more: chapter bodies stay on demand, the ceiling is
unchanged, and no provider or admission policy widens. It is recorded like any
other orientation, so the turn after it carries none again.

A successful complete reply is evaluated as a root under the selection this
conversation's execution captured, through that execution, on a durable sequence
separate from the turn that produced it. Only the root's Output reaches the
person.

The controls are captured once, when the conversation opens: each control the
REPL defines is published as a component answer under its own name and the
selection naming them is offered from the same installation, so canonical
capture resolves and seals them before any response exists and a response's
request states no table — only which evaluation it is, the bytes, and the
classes it may draw on. Two conversations are two captures, and a control a
reply names that the capture did not seal reaches no body. What is still each
response's own is where a control's pair is filed and which slot a Submit binds,
and that is given up only once the response's work and its cleanup have joined.

A provider turn that failed, was cancelled or stopped early runs no control at
all — it is source nobody finished writing — and nothing is written down for it.
A reply belongs to a turn the canonical journal says completed, and that
requirement holds: a record naming a reply for a turn that never completed
makes the history unreadable, which is the whole reason the requirement exists.
The account of a failed attempt is already retained, in the canonical record
that holds its status and whatever it streamed, and the chat shows it as the
incomplete attempt it is rather than as a reply. A failure takes its turn
ordinal and establishes neither a completed response nor a delivered
orientation, so the next explicit message continues the same conversation at the
next ordinal and is oriented again.

Only an explicit Output region is chat. A response that declared none still ran
its controls and still rendered its body — the chapter a read returned, the
receipt a Submit was given — and none of that is shown to the person: it is the
reply's own working rather than an answer anybody asked for.

A reply may also ask the person. The captured selection names `Elicit`, so a
reply may write canonical paired `<Elicit>` — the same component an entry
writes, with the same bounded form, the
same compiled schema, the same validated answer and the same durable record — it
is in the write class because asking is not reading, and paired because the
question is its content. The question belongs to the conversation rather than to
the entry: a reply's question and an entry's are two pending questions with two
answers, answering either leaves the other where it was, and Stop withdraws the
reply's without touching the entry's. A question this surface cannot draw is
refused before anybody is asked, and what the refusal says is which schemas it
accepts.

What the reply asked for comes back to it. Once the response has finished and
its scope has joined, the results are sent, in admission order, as one next turn
of the same conversation. Every control in the ceiling is included, writes as
well as reads: a reply that asked the root to fill the draft or admit an entry
has to be told what happened, or its next response is written against a guess,
and a reply that asked a question has to be told the answer. Canonical syntax
self-description is the one exception — its return is the reply's to render or
capture — and an ordinary component return is never intercepted.

A question's answer is retained the way every other operation's is: an intent
before anybody is asked and an outcome once they have answered. So a question
still waiting when a process stops is readable as an operation that began and
whose result nobody knows, and it is reported as that rather than re-asked or
given an answer nobody gave.

Each answer is in its own terms, read back from what was retained. The binding
map is the map itself, with no provenance or status put inside it. A filled
draft is acknowledged and never echoed back as its own source. A submission is
the exact entry's terminal outcome once its teardown has joined, followed by the
read instruction for that entry, with no output body or summary; a submission
that was refused before it reserved anything says so and names no entry, which
is a different thing from an entry that ran and failed. An output read is the
window the read itself renders, fenced long enough to hold its text, with its
adjacent instructions pinned to that entry.

A reply reads one entry's saved evidence through four reads of its own, and
each of them answers with a page rather than with prose:

```xmd
<REPL.Entry.Source entry={22} offset={0} limit={4096} />
<REPL.Entry.Prompt entry={22} prompt={9} field="reply" />
<REPL.Entry.Output entry={22} />
<REPL.Entry.Journal entry={22} offset={0} limit={20} />
```

Source is the exact source that entry was admitted with. Prompt is one saved
agent turn's text — its reply, the request it was sent, or the complete message
it failed with. Output is what the entry printed. Journal says where that
evidence is: the entry's complete saved failure, how its turns ended, and a
record for each thing it saved, in the order the file holds them. Journal
locates and Prompt reads, which is why neither carries the other's body — a
record states a turn's number, its kind, its status and where it was written,
and never a reply, a request, a result payload, a checkpoint or a stack.

`entry` and `prompt` are nonzero whole numbers. A positive entry number is
immutable admission order counting from one, and a positive prompt number is a
saved turn's own sequence plus one rather than its position in the list, so two
turns that finished in the order their providers answered keep the numbers
their records state and a number no turn saved refuses rather than being
renumbered into its neighbour. Omitted and `-1` are the latest, and a further
negative counts back from it. Each selector resolves once, when the read
happens.

Text windows count Unicode code points and default to 4096 of them; Journal
counts records and defaults to twenty. Source and Prompt start at the
beginning. Output's omitted offset is the last window, which is what a reader
of output wants, and an explicit zero is the beginning, which omission cannot
express. A negative offset counts back from what is available and clamps there,
and a positive one past the end stays where it was asked for and answers with
an empty window. A limit is a positive whole number with no maximum of its own,
and what comes back is bounded by the evidence. Every page carries `previous`
and `next`: either null, or the complete arguments of the read beside it, with
the entry and prompt stated as the numbers they resolved to, an absolute offset,
the limit that was asked for and the same Prompt field. A continuation followed
after another entry has been admitted therefore reads the entry it was about.

A page states the entry's status and, for a Prompt read, the turn's own
separately. An entry is completed, failed, cancelled, running or unfinished; a
saved turn is completed, failed or cancelled, and a turn that returned
well-formed text and ended failed is failed. A turn that saved nothing for the
field being read answers `text: null` with no window either side of it, which
is a different answer from the empty string a turn that saved emptiness gives.
Evidence the history does not hold refuses, as does a zero, fractional or
out-of-range selector, an unknown field and a limit that is not a positive
whole number; a refusal is that operation's outcome and the response goes on.

Terminal evidence decides an entry's status even while the task that produced
it is still unwinding. Without one, the entry this process is executing is
running and any other is unfinished, so a cold reader of an interrupted history
is told it is unfinished rather than that it is still going. Output is the
retained terminal output where there is one, the text this process has observed
for exactly that entry where there is not, and an empty window otherwise —
nothing invents output a cold reader cannot have. These reads take the
acknowledged head whatever position, scope or tab the screen is on, and they
open no entry, resume none, wait for none, execute no source, reach no entry's
provider and change nothing they read.

A successful read answers with its page object. An ordinary `as` binds that
object, an uncaptured read renders nothing, and the page goes back to the
conversation as the read's own result either way — capturing one does not
switch its feedback off. Only an explicit Output region is chat, so a reply
that wants a page in front of the person composes one:

```xmd
<REPL.Entry.Prompt entry={22} prompt={9} as="turn" />
<Output>{turn}</Output>
```

A submission's receipt names the entry that was admitted and the read that
explains it: an entry that completed is pointed at its output, and one that
failed or was cancelled at its Journal, because an entry that failed may have
printed nothing at all. The number is the admitted entry's, whatever entry or
recorded position the screen is showing.

These reads are of the validated journal projection and of this process's own
observed output, and of nothing else. They reach no provider session file, and
the retained publication, secret and persistence protections stand in front of
anything a page carries.

These four are what a response reads an entry with. The single output read they
replaced is no longer one a reply may write, and a response that names it is
refused at admission like any other name the capture did not seal. What a chat
saved before the replacement holds still reads as what it was: its retained
observation comes back as the rendered window it was recorded as, under the
name that produced it, and nothing re-evaluates the record to show it.

One result is its own value, because one question has one answer — a binding map
delivered alone is the map, parseable as it stands, with no heading, fence or
envelope. Several each get a short heading naming the control that produced
them, and a value that was serialized is fenced there, in a fence longer than
any run of backticks inside it: it is sitting among other things now, and a
published string may hold a fence of its own. Canonical text beside it — a
chapter, the entry vocabulary, the environment snapshot — was never serialized
and keeps its own formatting.

A failure is its reason, and which failure it is matters. An operation that did
not happen is refused; an operation that answered with bad news answered. A
submission whose entry ran and failed produced that entry's receipt — the entry,
its reason and that entry's read instruction — and the receipt is the answer, so
it is never introduced as a refused submission. The two are told apart from the
retained facts, the intent that reserved the entry and the outcome that observed
its terminal status, rather than from the text that distinction chooses the
wording of. Nothing internal crosses — no correlation id, no order number, no
wrapper, no status word for something that worked. An ordinary failure of the
response goes back with them, so the reply can continue from what already
happened rather than repeating it, and the results that succeeded stay retained
and are not sent again.

Stop ends the asking and nothing else. It cancels the generation in flight, the
controls of the response being evaluated and the wait for an entry's outcome,
and it stops any turn that would have followed — and it returns only once all of
that has come down, so nobody is told their Sidekick stopped while it is still
writing to their history. Everything already done stands: the chat, the drafts,
the records, and an entry that was admitted, which belongs to the session and
runs on its own terms.

The boundary is the exact entry's durable admission, and nothing else stands in
for it. A passed validation, a taken slot, a live session and an allocated task
are all true before any entry exists: a task is started before the record that
gives its entry a position, and the execution installs its providers and
composes its envelope in between. A submission cancelled anywhere in that
interval withdraws its own request *and* cancels the startup it allocated,
joining it, so nothing can go on to admit an entry nobody is waiting for. Past
that acknowledgement the entry is the session's: cancelling a caller's wait is
not cancelling an entry, and the entry keeps running while its later completion
starts no turn.

A cancelled startup leaves nothing behind it — no admission, no terminal, no
settlement, and no entry for a later reading to find. The slot it held is free,
because there is no entry for anything to follow; an *entry* that was
interrupted still occupies it. The Submit intent stands as what it is: a
reserved request whose result was never acknowledged, and no completion receipt
is manufactured for it. The history is re-read before Stop
answers, because the cycle was writing to it and its own reading never finished;
an intent with no outcome is what Stop leaves, and that is what a reopened or
refreshed view shows. Stopping when nothing is running does nothing at all:
Stop is not a way to discard a conversation.

A turn interrupted this way retains nothing of its own. The turn ordinal it
would have taken belongs to the open conversation rather than to the file, so a
later message takes the next one the conversation gives it; every claim this
host writes about what a turn carried is read back from that turn's canonical
record rather than from an ordinal predicted before it was sent.

A saved message carries a **message ID** of this host's own, written before its
turn and never rewritten. Which turn that message became is read from the
records for its own request — the message, then everything up to the next
message or feedback text in the same conversation — and a request whose records
hold no turn has none: unknown rather than unsent, because a turn whose record
never landed may well have been taken. The two numbers are never compared, and
their happening to agree establishes nothing. A reply belongs to the turn its
own records hold, so the chat stays in the order things were said even where a
message has no turn beside it and the message after it does.

Which conversation a turn ran in is established by that turn's own record, so a
conversation whose mapping nothing acknowledged separately is still established
and a later process continues it where it was. When even that record did not
land, the provider's own retained account is what the next turn resolves to, and
the message nothing acknowledged is not sent again. A turn the provider says ran
somewhere else is retained as a turn that happened and is not published as this
conversation's reply: showing a person words from a conversation they have never
been in is the one answer that cannot be corrected later. The turn's own
operations do not run, nothing replaces the established association, and a
history that has come to name two conversations refuses to be continued at all
rather than choosing one.

An explicit message carries what an interrupted response of this conversation
actually did, when one is still unaccounted for: the operations that answered,
in the words each control answers in, and the question that was asked and never
answered, in the words it was asked in — in the order they happened, beside the
draft as it stands now and the person's own message. It is one ordinary turn
rather than an automatic recovery: nothing is filled again, nothing is asked
again, no answer or outcome is invented, and an old fill does not come back over
text a person has since typed. The account is carried once; a later message does
not repeat it.

A submission refused before it took a slot writes nothing down, because a
reservation that was never taken has no outcome to record — and it still reaches
the next turn, carried as the refusal it was, in the place in the order it
happened. It claims no entry and reserves nothing.

A response that asked for nothing and failed at nothing ends the exchange: the
next move is the person's. A turn the provider did not finish ends it too,
because a turn that produced nothing is not a reply to correct. There is no
limit on how many turns one message may take: each one costs a provider turn, a
response that asks for nothing ends it, and a provider failure pauses.

A delivery is claimed before it is sent, claiming nothing, and established
afterwards against the turn that carried it: a completed turn whose canonical
input is exactly that text. An ordinal alone would count a delivery against
whatever turn happened to be in that position, and this host's own record of
having sent something is never what proves a turn took it.

A root that fails after it began rendering keeps what it rendered. The partial
text and whether the root declared an output region are the evaluator's own
answer, retained as they are rather than recomputed or blanked, and the controls
that ran before the failure stay retained while nothing after it runs. An
admission refusal rendered nothing, so nothing is reported about what it
rendered. A durability, Files, secret-policy or teardown failure keeps its own
classification and is not read as a root that rendered something.

Submit's intent is the one control pair the root writes rather than the control
wrapper. That intent binds the reservation it took, and the reservation does not
exist until the session's terms are established, the entry writer has settled
and the slot is held — all inside the work. An intent written before that would
bind nothing, and a response's history would hold two intents for one
submission.

Filling the shared draft starts nothing, and submitting is a separate request. A
fill is applied by the loop that owns the draft and the request waits for it, so
a submission after one reserves the text the fill put there. While a person has
taken the draft over, a fill refuses and stays refused until they ask the
Sidekick for something.

A pause request is the root's, as process-local state on the exact reservation it
was made against; the session owns the entry task and the expansion controller,
and the controller stays absent until there is an admitted entry to pause. An
allocated task is busy, not admitted: offering a controller for one would let a
hold land on the import the entry's position comes from. Preparation never turns
Pause into something an idle or historical entry can be asked to do. The session
takes the request in the one synchronous transition that establishes its entry's
admission — the record is persisted and the work that would expand the body has
not resumed — rather than from a scheduled waiter, a frame, an acknowledgement or
whichever entry happens to be latest, and it takes it once. From that transition
on the controller owns the hold, Continue releases it, and an entry already
admitted keeps its own control when a submission behind it is refused.

An entry can also be admitted, hold the mode it was asked for, and then fail
before any boundary is crossed: its root metadata and document envelope are
composed in that interval. Cleanup belonging to the entry clears the mode before
a successor starts, without releasing a continuation nobody is standing in.

A burst of input is one frame but not one tree. Keys typed faster than the screen
draws arrive together, and an action that changes which controls are offered
mounts them before the next key of that burst is dispatched — otherwise the key
reaching for a control that has just appeared reaches whatever used to be there.
Nothing is drawn and no frame is acknowledged for it, and a pointer is still
resolved against the frame that published its coordinates.

## Exclusions

- Two processes writing one execution is unsupported. There is no lease protocol;
  do not open the same location twice for writing. The hold on a checkout is a
  different thing: it says one entry at a time may mutate one repository, and it
  says nothing about who may write this execution's history.
- Pull requests are not part of this. `<PullRequest>` refuses in a REPL entry
  exactly as it does under any host that installs no provider for it, and
  neither a retained local result nor a retained publication authorizes one.
  What an entry retains is `<Repository>` and `<Worktree>` selection, the file
  and directory work inside those checkouts and the one it was started in,
  `<Git.Add>`, `<Git.Switch>` and `<Git.Commit>` in them, the page each of
  `<Git.Files>`, `<Git.Changes>`, `<Git.Diff>` and `<Git.File>` answered with,
  the branch `<Git.Push />` published, and the issues it filed and read. A
  runtime that installs no repository provider — Node and Bun — refuses the Git
  components, the four reads and publication included, before any native
  operation or remote contact, while ordinary `<File>` and `<Dir>` work keeps
  working there.
- A read confers nothing. Nothing a page holds authorizes a mutation, a
  publication, a pull request or an Agent, and the opaque `cursor` a `next`
  carries is continuation data rather than permission: a follow-up read
  authenticates and routes on its own terms and then checks that the cursor
  describes the checkout it reached.
- A read is not a snapshot. One observation may run several Git commands against
  one private index copy and one pair of resolved commit ids, and that is as much
  as it promises: nothing locks the repository, watches it or compares every
  write that happened while it ran. What continuation checks is whether the
  *answer* changed, not whether the filesystem did.
- `<Issue>` is the same component here as under every other host: one
  implementation, the same props, forms and return contract, asking a semantic
  issue operation for its work. The `repl` command registers it as an ordinary
  default like every other command does; what an entry supplies is the policy
  beneath it, declared to that entry's own execution over the default — and a
  repository component of that name keeps its ordinary precedence over both.
  What such a component does not get is the identity an entry's own issue work
  is named by.
- Generated selection is unchanged. An admitted generated `<File>` read, write
  or `<File.Delete />` is retained exactly as an authored one is, because both
  cross the one document filesystem. `<Glob>` stays ordinary and is retained by
  nothing here, authored or generated. A generated `<Repository>`, `<Worktree>`
  or `<Dir>` refuses before any provider is asked.
- Nothing inventories the managed root. There is no listing of the checkouts an
  entry or a session has selected, no snapshot of their contents, and no
  restoration pass; a managed checkout is somebody's work and nothing here
  deletes one.
- Continuing an entry is explicit. Returning to the live head starts the one
  unfinished entry, once; a frozen position starts nothing at all.
- A continuation does not reconcile what is on disk. Nothing compares a saved
  file result with the filesystem, reports a difference or offers to repair one
  — if what you are looking at is not what you expected, that is for you to
  read and act on. An issue is the one exception, and it is the provider's
  rather than this command's: an interrupted upsert presents the key it used
  the first time, and the tracker answers with the issue it already filed under
  that mark.
- `xmd repl` takes one optional location, the five Agent options above and
  `--sidekick-agent`, plus `--include` and `--observe-worktree` as described
  above. It renders no file and takes no document reference.
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
