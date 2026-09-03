# The `xmd plan` command

`xmd plan` turns your **Prompt** — the request you typed, in ordinary language
— into a **Plan**: an Executable Markdown document that states what you asked
for in ordinary language and places the components that perform the work
alongside those words.

```console
$ xmd plan "ask me for my age and write the result to a file"
```

A Plan is not merely executable code. It preserves the Prompt's intent as
reader-facing prose interleaved with the components that fulfil it, beginning
with one descriptive level-one heading, so the request above should produce a
document shaped like this:

```markdown
# Ask for and save your age

Ask me for my age.

<Elicit as="answer" schema={{ type: "object", properties: { age: { type: "number" } } }} />

Write it to a file.

<File path="age.txt">{answer.age}</File>
```

and an execution organized by the same narrative: the title, the first sentence,
the interaction, the second sentence, the file. The Prompt need not be copied
literally — it may be divided, clarified and rewritten into natural prose — but
the descriptive title, every requested outcome, their meaningful ordering, and
their relationship to the components performing them are preserved. Every
Plan-producing turn — the first draft, each repair and each revision — states
that whole requirement for itself, so a replacement can add or correct a title
rather than only carry one forward.

`xmd plan` maps one request to one reviewed program and stops there. What runs
that program, and when, is a separate command you write yourself.

## Common paths

Write the exact approved source to standard output:

```console
$ xmd plan "Prepare the release program."
```

Compose planning and execution explicitly through standard input:

```console
$ xmd plan "Prepare the release program." | xmd run -
```

Or preserve the artifact first and run the saved file later:

```console
$ xmd plan "Prepare the release program." --output release.md && xmd run release.md
```

Those three are the whole of it, and the relationship they express is the
lasting one:

```text
Plan produces a program.
Run executes a program from the host/CLI.
Composition decides whether and when a planned program runs.
```

Planning never runs the approved program: the command that wrote a program does
not also decide when it happens, so a Plan you have not read is a file or a pipe
rather than an effect.

The command implements no authorship workflow of its own. It executes exactly
one root document: the **plan command document**, a checked-in first-party
Markdown value root that is an adapter — it projects the request into the
packaged `<Plan>` Component and returns the source that Component approved. The
workflow itself — what the coding agent is asked, how many drafts may be
repaired, what you are shown, and what happens when you approve nothing —
belongs to `<Plan>`. The plan command document is not itself a Plan. There is
no second root, no second execution model, no second props model and no journal.

## The flow

```text
fixed command preflight
  -> --journal: exclusively create the named path
  -> execute the exact packaged plan command document, which is an adapter
       -> <Plan>, the packaged Component, with the request as its Prompt
            -> announce Preparing, then build the run-profile syntax catalog
            -> the authorship frame, and one Session inside it
            -> generate, check, repair, review, revise, approve, explain or fail,
               announcing each phase on stderr before it happens
            -> teardown, then structural admission of the exact approved bytes
       -> Return what <Plan> approved
  -> await that execution and provider teardown
  -> structurally validate the returned source again
  -> --output: exclusively create the file with the exact bytes
     otherwise: write the exact bytes to stdout
```

Each phase hands the next one a value. No phase after the first failure begins,
so a refused command line reaches no catalog, a failed turn reaches no review,
and a review that stopped reaches no stdout and no file.

Writing a Plan is a conversation, and a conversation is not a run. The durable
stream that conversation records itself on belongs to the host: one fresh
invocation-owned `InMemoryStream` by default, or the file `--journal` named. It
is written and never read — no invocation opens a journal as input, resumes from
one, or runs a program that could be resumed.

## Command grammar

```console
xmd plan <request> [options]
```

The request is one positional argument and is text for the agent, never a path.
It must hold at least one non-whitespace character; that is the only test
applied to it. Its original text is preserved and sent byte for byte, so leading
and trailing whitespace survives.

No request, more than one request, an empty string and a whitespace-only string
each fail the invocation. There is no stdin form and no editor form: a request
nobody wrote is never guessed, and no token is silently dropped.

```console
$ xmd plan "…" extra
unrecognized argument for xmd plan: extra — the command takes exactly one request
```

`--` ends option parsing, so a request that begins with `-` is written after it:

```console
xmd plan -- "--this is the request"
```

### What the command accepts

The grammar is fixed and complete. There is no generated document whose
declarations could add an option later, because the generated document *is* the
result.

| Option | What it configures |
| --- | --- |
| `--include <dir>…` | the ordered component search path the syntax catalog and the structural checks resolve through |
| `--agent-provider <name>` | which provider writes the Plan |
| `--default-agent <name>` | which agent that provider defaults to, overriding `DEFAULT_AGENT_NAME` |
| `--session <name>` | the logical assistant session the planning conversation belongs to |
| `--timeout <duration>` | the deadline for the whole planning invocation |
| `--output <path>` | the exclusive artifact sink, in place of stdout |
| `--verbose` | adds the generated drafts and the failed checks' diagnostics to the progress on stderr |
| `--journal <path>` | records this authorship as diagnostic JSONL at a path that must not exist |
| `--help`, `--version` | ordinary behaviour |

Every one of them is either about *who writes the Plan*, *what vocabulary they
write it in*, *where the approved source goes*, or *how much of the writing you
watch*.

`--verbose` and `--journal` are spelled in full and have no short aliases.
`xmd run` gives those spellings `-V` and `-j` for options about a *program's*
run; these two observe this command's own authorship and nothing after it, so
each short form is refused by naming the long one:

```console
$ xmd plan "…" -j trace.jsonl
unrecognized option for xmd plan: -j — write `--journal <path>`
```

`--journal` takes exactly one non-empty path, and a token that names an option
this command defines is that option rather than a filename. Reading one as a
path would exclusively create a file called `--verbose` and quietly drop the
verbosity the caller asked for, so the value is read by fixed grammar rather
than left to the parser:

```console
$ xmd plan "…" --journal --verbose
--journal needs a path — write `--journal <path>` or leave it out to record no journal
```

Only that position is affected. `--journal <path> --verbose` and
`--verbose --journal <path>` are both ordinary command lines, `--journal=-x`
takes whatever follows the `=`, and a removed spelling written there keeps its
own more specific refusal.

### What the command removed

Everything that configured **running** the approved program is gone, with no
alias and no inert placeholder:

- `--run`;
- the root-property options — the aggregate `--props` and every generated
  `--props-*` and `--no-props-*` name;
- `--raw`;
- `--timeout-exec` and `--timeout-fetch`;
- `--approve-all`, `--approve-reads` and `--deny-all`; and
- `--secret-detection` and `--no-secret-detection`.

Each of them describes work this command never performs, and every one of them
is still `xmd run`'s. Accepting one silently would mean answering a caller who
asked for a permission mode or a root property with a command that creates none
of them.

The fixed grammar owns these refusals, before the general parser can drop a
token, coerce its value, or read it as a second positional. An option's name is
read up to its first `=`, so every valued spelling arrives under the name it was
written as; a removed option consumes no following token and inspects no
candidate schema. It is refused wherever it stands — before the request, after
it, beside a retained option, and in the place a retained option's value would
otherwise have swallowed it.

**Including beside `--help`.** `--help` is lifted out of the command line before
any command's own grammar runs, so a removed option written beside it would
otherwise be answered with a page describing a command that would refuse the
caller. The removal is decided first, in either order, from the same
classification the rest of the grammar uses — so a spelling cannot be removed to
one and unknown to the other. Help that names no removed option is still help.

The root-property options are exactly the aggregate `--props`, the generated
`--props-<name>` and the generated `--no-props-<name>`. A name that merely
begins like one — `--propspective`, `--no-propspective`, a bare `--no-props` —
is an option this command does not define and is answered as one: sending a
caller to `xmd run` would be answering a question they did not ask.

Every `--run` spelling — the bare switch, `--run=true`, `--run=false`, `--run=`,
any other valued form, and repeated occurrences — reports the migration:

```console
$ xmd plan "…" --run
xmd plan --run was removed because xmd plan only produces approved source.
Run the program explicitly:
  xmd plan "..." | xmd run -
  xmd plan "..." --output release.md && xmd run release.md
```

Every other removed option reports one line naming the spelling that was
written:

```console
$ xmd plan "…" --journal trace.jsonl
unrecognized option for xmd plan: --journal — configure the program when you run the approved source with xmd run
```

An option this command does not define is refused by name in the same preflight,
because the ordinary parser stops at the first option it does not recognize and
drops the rest — accepting a command line nobody honoured. `--save` is named in
particular: it was replaced by `--output` before release, so there is no alias,
and the refusal says where an approved Plan goes now.

`-e`/`--eval` stays exclusive to `xmd run`. A plan supplies a request, not a
document. Supplying one anyway is refused in the command's own preflight, with
`unrecognized option for xmd plan: --eval — inline documents are exclusive to
xmd run`, before the catalog, the command document, the review or the file
exists.

`--agent-provider` and `--default-agent` are resolved into one authorship
configuration once per invocation, and an unknown provider fails there, before
the catalog is built. No permission mode is settled: this command starts no
program, and the ceiling its authorship runs under is the host's rather than the
command line's.

### The retired spelling is refused, not absorbed

`prompt` is not a command. It is not registered, aliased, listed in help or kept
as a tombstone that runs anything, and it does not fall through to the default
`run` command: a first token naming no command is a *document reference*, so a
file called `prompt` in the working directory would be rendered and executed by
a caller who wrote what they believed was a command.

So an invocation whose exact first token is `prompt` is refused in preflight —
before the inline-document scan, before command selection, and before anything
reads a path:

```console
$ xmd prompt
xmd prompt is not a command — use `xmd plan "<Prompt>"` to create a Plan, or `xmd run ./prompt` to run a document named `prompt`
```

The message answers both readings, because the token is ambiguous by
construction. Nothing else changes: only the exact first token is recognized, so
`xmd run ./prompt`, `xmd run prompt` and `xmd ./prompt` still execute a document
that is legitimately called that. The refusal exits nonzero and establishes
nothing — no catalog, no Agent, no Session, no authorship directory and no
output.

### `--session <name>`

Use this logical assistant session instead of one unique to the invocation. The
name must be non-empty; `--session` with an empty value is refused by fixed
grammar rather than read as absent, so a caller who asked for a named session
never falls back to the generated one by accident.

Ordinary provider session continuation applies when the configured provider
already holds that name. The plan command document still supplies the current
request and the current catalog in this invocation's initial turn. A continued
conversation still produces source and starts no program.

### Help

```console
xmd plan --help
```

Help needs no request. It describes the request, `--output`, `--session`,
`--verbose`, `--journal`, the authorship and catalog options and the deadline;
it states that the approved Plan is the only result, that stdout carries its
exact bytes when `--output` is absent, and that planning never runs the approved
program — and it writes out both explicit compositions. No removed option
appears anywhere in it.

It ends with what a journal costs, separated from everything above it:

```text
Secret detection checks journal entries before they are recorded, but it may not catch every sensitive detail. The journal can contain prompts, drafts, and review answers.
```

Help reads no catalog, contacts no provider, places no session, asks nobody
anything, creates no file and runs nothing.

## The packaged plan command document

The host executes one immutable packaged Markdown value root,
`packages/cli/src/documents/plan-command.md`, under the stable internal source
identity `<plan-command>`. Its declared return schema is exactly
`{ type: "string" }`. It is located from the CLI module's own URL — never from
the working directory and never through the component search path — so the same
document is found whatever directory a person stands in, and no repository file
can answer for it ([release process](./release-process-spec.md)).

The host supplies two fixed internal inputs as that root's props:

- `request` — the original request text; and
- `session` — the resolved logical assistant-session name.

They are the adapter's own, and nothing a Plan declares is bound here: the
properties a Plan's root declares are resolved by whoever runs it. The catalog
is not among them: it is built inside `<PlanInputs>`, from a closure the host
captured, so an authored phase can say that the preparation is starting before
it happens.

**The root is an adapter, not the workflow.** Its whole body is two elements: it
projects `props.request` into `<Plan>` without adding whitespace, supplies
`props.session`, captures the exact source the Component renders, and returns it.
It contains no Prompt, no check, no review, no revision, no ending — and no prose
of its own. This root's rendered transcript *is* what the command writes to
stderr as progress, so a sentence the adapter explained itself with would be
printed to an operator in the middle of a Plan being written. What the command is
for belongs in its help.

## The packaged `<Plan>` Component

Everything the command used to hold is `packages/cli/src/documents/Plan.md`, the
one packaged Markdown text component the public `<Plan>` name resolves to
([executable MDX](./executable-mdx-spec.md) §5.3). The command and an ordinary
document invoking `<Plan>` expand the same bytes, under the same origin
`@executablemd/cli/Plan.md` and the same digest, in every distribution. There is
no generated TypeScript copy and no second Markdown implementation.

The Component contains one enclosing `<Session>` expansion whose body holds every
initial, repair and human-revision `<Prompt>`. A loop inside that one Session
creates no second placement; sibling Sessions are not used, because sibling
placements stay distinct even when their authored names match.

The host owns the provider instruction layer and the Agent ceiling. The Markdown
owns the text of each generation, repair and revision request: the initial prompt
preserves the Prompt, includes the host's catalog, and asks for one complete
replacement root as source only — written as a Plan, with every requested outcome
kept as reader-facing prose and each component placed immediately after the
sentences describing the action it performs. That authorship rule is repeated in
every repair and revision request, so the narrative survives a draft being
replaced.

`<Prompt>` remains one Agent turn. It gains no hidden repair, retry, review or
approval behaviour.

**One sealed discriminator, and no host prose.** The only thing the host adds to
the Component's own language is which surface asked, as the closed value `command` or
`component`. Every sentence a person reads is in the Markdown, including both
surfaces' endings, each written once. The command's wording is unchanged; the
component's says that no Plan was returned rather than that nothing was output or
run. TypeScript supplies neither the words nor the choice between them.

**The five private capabilities.** The Component's phases are components only these
exact bytes may write, declared by the host with the definition and revoked with
the execution: `<PlanInputs>` builds and freezes the catalog, the instruction
identity, the
session placement, the surface and whether that placement outlives the
invocation, and refuses a continuation whose instructions render differently —
as stale input, before a directory, a provider, a turn or a review exists; paired
`<PlanAuthorship>` installs the constrained frame and does not return until every
part of it has torn down; paired `<PlanProgress>` says which phase is running;
`<CheckDraft>` answers about one draft without
executing it; and `<AdmitPlan>` structurally admits the approved bytes after that
teardown and retains them as one Plan artifact — the invocation identity, the
instruction identity, the approved source, its digest and that successful
admission — before the Component renders them.

Whether the placement is durable is carried across that boundary rather than
re-derived, because `<PlanInputs>` is the last thing that sees the public
`session` prop: a placement cannot be asked whether somebody wrote it. An
authored name gets the existing durable named-directory lifetime — the same name
at the same site reaches the same directory next time — and an omitted one gets
an expansion-owned placement that is site- and iteration-unique, replay-stable,
and handed back non-recursively after complete teardown. Sibling sites stay
distinct even when they write one name, and the name never becomes a path: the
directory is keyed by the digest of the placement.

**A host with no coding agent still has the Component.** `<Plan>` is declared to
every ordinary run profile, including the `<Execution host="run">` child an
`xmd test` document launches. A host that cannot establish the ACPX ceiling
refuses there — before any placement, directory or turn — rather than reporting
a component nothing supplies, because the profile does have `<Plan>` and what is
missing is an agent to write one with. The `xmd test` root itself is a different
profile and does not gain the component. None of them is syntax any document may write — not
the caller's root, not the Prompt the caller projected, not a sibling `<Plan>`,
not an imported component, and nothing middleware can answer.

## The authorship profile

The authorship profile is the trusted-host assembly the packaged `<Plan>`
Component runs its authored turns under. It supplies the frozen inputs, a constrained Agent provider,
Elicitation, the fixed first-party components and the host-declared draft check.
The command's own execution uses no repository component search — that
execution's include list is empty — and exposes no custom root.

The frame is installed by `<PlanAuthorship>`, inside the invocation that owns it,
rather than around the execution. That is what makes it the same ceiling on both
surfaces: an ordinary document has an execution of its own, with its own
provider and its own capabilities, and a Plan written inside it is still written
under this one. Broader authority in the calling document widens nothing, and the
constrained provider reaches nothing outside the content the Component projects.

### Agent authority under the authorship profile

The assistant that writes a Plan is assembled separately from the final run
provider:

- one host-owned directory dedicated to the logical session, created
  empty, required to be empty on the way in, and — for an invocation-unique
  default session — handed back non-recursively on the way out;
- no additional directories;
- no MCP servers — stated as an empty set, not omitted;
- an empty requested native-tool allowlist on a fresh session;
- strict denial of every native permission request, answered inside the provider
  without consulting an authored approval scope; and
- no Files, command, service or XMD-mediated network capability for the command
  document itself.

The provider may use its own transport to perform the model turn; that does not
grant the Agent a native network tool. Nor do the two acts the command performs
as the host — putting this build's own ACP adapter on disk, and opening the
review form in a browser — each of which runs a command in the scope that invoked
`xmd plan`. The document is refused a command; the host still installs the
adapter it is about to launch and opens the form it is already serving
([`xmd run` and `xmd plan`](./acp-client-spec.md)).

No permission flag reaches this ceiling, because `xmd plan` defines none: the
flags that select a permission mode belong to `xmd run`, and what settles
authorship carries a provider and a default agent and nothing else. A provider
that cannot establish this ceiling refuses before session materialization or a
turn; there is no silent downgrade.

The profile's working directory is
`~/.xmd/plan/sessions/<sha256(logical-session-name)>`. It is dedicated to that
one logical session rather than shared by every invocation, so two conversations
never see one ambient directory. The leaf is the digest and never the name
itself: a logical session name is a caller's string, and a caller's string that
becomes a path is one that can escape a path.

The digest also carries the identity `--session` needs. A generated
invocation-unique name reaches a location nothing else does; the same explicit
name reaches the same one, and because a session's key includes the directory it
lives in, that is what lets the provider continue the session it established.

The directory is created empty and **required to be empty** before the provider
is constructed or a session is materialized. A non-empty one is a terminal,
actionable refusal naming the path: nothing is deleted or cleaned, because
whatever is in there was put there by something this host did not authorize.
Nothing this profile grants can write there, so what is created empty stays
empty.

The two kinds of session then have different directory lifetimes, because only
one of them has an identity worth keeping:

- an **invocation-unique default** directory is the command's own, held as a
  scope-owned resource: the release is registered *before* the first filesystem
  call that could create it, so a leaf this invocation made and then failed on is
  still a leaf this invocation hands back. Exactly one cleanup is attempted, after
  the command document and every provider, Prompt task and Elicitation resource
  inside it has torn down, and it settles before final validation and every way a
  Plan could leave the command. Success, stopping, a failed turn and cancellation all reach
  it. Once the directory has been established, it has exactly two outcomes:
  - **still empty** — that exact leaf is removed, non-recursively;
  - **anything else** — the directory and whatever is in it are preserved and the
    command fails terminally. A leaf that has gained content, and one that has
    disappeared, are both interference: something acted on a directory this host
    authorized nothing to touch. Neither is a warning and neither is a silent
    skip, and no final admission, stdout or file follows.

  A directory establishment never handed over — refused as non-empty, or never
  created at all — is a different question, already answered by what
  establishment reported. The release then removes an empty leaf it did create
  and otherwise leaves both the report and the directory's contents alone.
- an **explicitly named** directory survives the invocation and is not subject to
  that cleanup at all, because a later `--session <name>` derives the same
  location and therefore the same ACPX session identity from it. It is required
  empty again on the way in every time, and its contents are never cleaned or
  overwritten.

Which of the two applies is a trusted host value — whether the caller wrote
`--session` — not something read back out of the name, and the command document
is told neither the directory nor which kind it is.

Where those directories live is a host dependency as well. No flag, environment
variable, document prop or replaceable context selects it; production uses its
own default, and a harness that owns a temporary tree is given that tree
directly.

A later `xmd run` of the approved Plan is an ordinary invocation with an Agent
configuration of its own. It inherits neither the assistant Session nor its
instruction layer, because there is nothing between the two commands but the
source.

### The assistant Session

Without `--session`, the host generates a logical name unique to the invocation.
The exact name is supplied to the command document, and its one enclosing
`<Session>` materializes only at the first consuming `<Prompt>`. Every turn
within this invocation uses that one Session.

A turn produces a draft only from its complete successful close value. The host
decides, for the whole command document execution, that a failing `<Prompt>` ends
it: a failed, cancelled, unavailable or protocol-invalid turn discards its
partial text and reaches no human review and no result, and the document cannot
opt out of that.

That execution closes after approval or failure. The host observes its result
only after every Prompt task, Agent provider resource, Elicitation resource and
other child has completed teardown. A teardown failure wins over a selected Plan
and prevents structural validation and every way a Plan could leave the command.

### A draft is data

An Agent reply is an inert string while the Plan is being written. The command
document may bind it, pass it to the validator, serialize its problems, present
it with `<CodeBlock>` and produce it as source. It never evaluates the draft and
never dynamically imports it, and neither does the command that delivers it:
approved source is bytes on stdout or bytes in a file, and only a later `xmd run`
turns either into a program.

## Host-declared draft validation

The Component's own private closure declares one value component only these
bytes may write:

```md
<CheckDraft source={draft} as="check" />
```

Canonical execution supplies its invocation identity, so repository resolution
cannot replace it. Its result is a closed candidate assessment: either
`{ valid: true, diagnostics: {} }`, or `{ valid: false, diagnostics }` carrying
the complete versioned `DocumentValidation` core produced.

The component performs no candidate execution. It asks the invocation's one
structural check — `validateDocumentStructure()` under the ordinary run-profile
registry, the `<plan>` identity, the caller's ordered includes and the run
profile's declarations, which include `<Plan>` itself because the catalog the
agent was shown says the profile has it. The admission that follows teardown and
the command's own gate ask that same check, so the three cannot come to differ
about what a program is for a reason nobody chose.

**Structure, not values.** Every check `validateDocument()` makes is made here
except one: the root's own props are not validated against values, because there
are none to validate against. `xmd plan` has no property source — the aggregate
and generated options belong to `xmd run` — and the values a Plan's root
declares belong to whoever runs the program later. A Plan that declares required
properties is therefore a Plan, and refusing it here would refuse a program for
not having been given arguments nobody has offered it yet.

Every defect this check reports is one the agent authored, so the assessment
answers `valid: false` and the command document may ask again:

- source, frontmatter, target, root-props and return-declaration diagnostics;
- an unresolved or misused component; and
- every other definite structural diagnostic.

There is no caller-source failure to tell them apart from. The command line is
settled by fixed grammar before a draft exists, and nothing about a candidate
can make an already-accepted command line mean something else.

An opaque `not-statically-checkable` invocation is not a diagnostic and does not
by itself make a candidate invalid.

## The authorship workflow the `<Plan>` Component owns

The following is the shipped program's behaviour, not the host's. It is stated
here because it is what a caller sees; it is changed by editing `Plan.md`, and
nothing in TypeScript decides it. Prose quality is that
document's instructions and your review, never a hidden TypeScript validation
rule: `<CheckDraft>` reports structural facts and executes nothing.

**A complete titled Plan.** Every Plan begins with one descriptive level-one
Markdown heading, as the first body content after optional frontmatter, naming
what the Plan produces. The generation, repair and revision instructions each
require it, together with the Prompt's sequence of readable steps in a
meaningful order and each component beside the step it performs, so the
structure survives every replacement. It is an authorship and human-review
requirement: `<CheckDraft>` does not enforce it, and a titleless Plan is
something you send back rather than something the checker refuses.

**Automatic repair.** The initial draft and every human-requested revision each
start a fresh repair budget: the base draft is attempt one, at most three repair
turns may replace it, every repair prompt carries the complete structured
diagnostics, and every answer must be another complete replacement Plan. The
fourth draft with problems is repair-exhausted and goes to human review with its
diagnostics. No fence is stripped, no Markdown substring is extracted and no
patch is applied.

**Human review.** At most ten draft presentations: the initial review plus at
most nine revisions. The choices are the words shown, and they are the values the
provider answers with — there is no internal spelling behind them:

| Round | Draft | Choices |
| --- | --- | --- |
| 1–9 | passed its check | **Approve**, **Request changes**, **Stop** |
| 1–9 | problems remain | **Request changes**, **Stop** |
| 10 | passed its check | **Approve**, **Stop** |
| 10 | problems remain | *no review — see the explanation turn below* |

**Request changes** requires non-empty feedback, sends one complete-replacement
request through the same enclosing Session, and resets the three-turn repair
budget.

**The explanation turn.** A tenth draft that still has problems after its
repairs leaves nothing to approve and nothing left to revise into, so no review
opens for it: there is no decision to offer. The workflow instead makes exactly
one more `<Prompt>` in the same enclosing Session, automatically. The Session already holds the original Prompt, the catalog,
every draft, every earlier diagnostic and every revision request, so nothing is
resent: the turn carries only the final diagnostics, which were produced after
the agent's last draft and have not appeared in the conversation. It asks for a
brief explanation and explicitly not another Plan.

That turn is not a draft, a repair, a revision or a review round; it cannot
reopen the ten-draft limit; its answer is inert text that is never interpreted as
XMD; and it is reported to you and then ends the command with no approved
source and no file. It is subject to the host's failed-turn
policy like every other turn, so a turn that fails ends the command immediately.

**Presentation.** The review message presents the exact draft with `<CodeBlock>`,
whose fence is longer than every backtick run the draft holds, so draft text
cannot close it and is never interpreted. An invalid draft is followed by its
complete JSON problems, serialized and captured by `<Json … as>`. Prose outside
`<Prompt>` addresses you; text inside `<Prompt>` instructs the assistant.

**Failure.** **Approve** selects the draft, and the branch after the Session
returns its source unchanged. Stopping reaches `<Fail>` with one of two
authored messages, and which one depends on whether an approvable Plan ever
existed:

- a tenth draft that still has problems is **exhaustion** — ten drafts were
  written and none was approvable — and it ends through the automatic
  explanation above rather than through a decision;
- every **Stop**, including one on a tenth draft that could have been approved,
  is the ordinary ending: you decided to stop.

The branch after the Session is only an unexpected-no-decision fallback and says
so; exhaustion is decided where the tenth draft's check is, not duplicated
there. Failure is authored in Markdown rather than hidden in the host.

The command document's rendered output is not the command's result. What it
renders is the progress an operator reads on stderr, described below; the draft
itself, the choices and the diagnostics reach you through Elicitation; and that
document's successful public result is the approved Plan source and nothing
else.

## Watching a Plan being written

Writing a Plan takes minutes and asks you a question in the middle. So the
command reports what it is doing while it does it, on stderr, as readable
Markdown — and stdout stays exactly what it was: the approved source, or
nothing at all when `--output` was named.

Each phase is announced **before** the work it names, so what you read is what
is happening rather than an account of what already finished. The phases are:

| Phase | Announced before |
| --- | --- |
| Preparing the Plan | the syntax catalog is built and the session is set up |
| Drafting the Plan | the first Agent turn, naming which of the ten attempts this is |
| Checking the draft | every structural check, including the ones after a repair |
| Repairing the draft | each repair turn, naming which of the three repairs this is |
| Waiting for your review | each actionable review |
| Revising the Plan | a requested-change turn, naming the attempt it begins |
| Finalizing the Plan | leaving authorship after an approval |
| Stopping planning | the authored ending a **Stop** raises |
| Could not generate a Plan | the automatic explanation turn a tenth unrepaired draft gets |

The counters are the workflow's own. `Plan.md` binds ten attempts and three
repairs once, and every loop bound, every condition and every sentence above is
derived from those two bindings — so what you are told and what the workflow
does cannot come to disagree.

**Finalizing says the session is closing.** It is not a claim that anything was
delivered: the final host validation and the artifact sink both happen after
authorship has torn down, and neither has a phase. Nothing on this channel ever
says a Plan was produced, written or output.

**Default progress discloses nothing.** It holds none of the request, the draft
source, the structural diagnostics, your review feedback, the Agent's output,
provider or tool chatter, or the approved source.

`--verbose` adds exactly two blocks, in phase order:

- **Generated draft**, after every Agent result that committed, holding that
  draft; and
- **Problems found in the draft**, after every check that committed and found
  the draft invalid, holding its exact structured JSON.

Both are reachable only *after* the durable event that supplies them has
cleared the secret gate and committed, which is why a rejected draft or a
rejected diagnostic is never displayed: the binding the block reads does not
exist.

### The channel is the command's, not the document's

Progress is a private output side effect of the packaged `<Plan>` Component, not
something `<Plan>` produces. The paired private `<PlanProgress>` renders its
content and sends it through the current document-output operation as ordinary
prose, then returns the empty string.

Returning it instead would put a phase heading inside `<Plan as="approved">`'s
capture and inside the declaration's exact-source disposition — contaminating
the approved program and bypassing the presentation every other line of progress
gets. So:

- on the **component** surface it returns before its content is expanded at all,
  and an ordinary document that writes `<Plan>` announces nothing;
- on the **command** surface with `verbose`, while this invocation did not ask
  for long-form progress, it returns before expanding too; and
- otherwise it renders, writes, and returns nothing.

Which surface is asking and whether `--verbose` was written are sealed host
facts the declaration carries. There is no public progress syntax, no segment
marker, no authored opt-in and no context a document could set.

### Who owns the stream and the terminal

The command execution installs whitespace normalization for every invocation,
and terminal formatting only when the host says its stderr is a terminal. Both
the writer and that fact are host dependencies: the CLI owns `process.stderr`
and the `isTTY` answer, no shared module detects a runtime, and no document
inspects a terminal. A non-terminal stderr therefore receives normalized
Markdown, and a terminal one receives it rendered.

The transcript is drained while the document is still producing it, inside the
scope that owns the execution. A destination that stops accepting bytes fails
that consumer, which cancels the producer and waits for the provider, the Prompt
tasks, Elicitation, the session directory and the execution to tear down before
anything is reported:

```text
Could not write planning progress to stderr: <reason>

Planning was cancelled, and no Plan was output.
```

That message is offered to stderr, because a stream that refused once is not a
stream that refuses forever. A stderr that never recovers gets no stdout
fallback: an approved Plan's sink is not a channel for a message about progress.
Bytes stderr already accepted are not rolled back, and no `--output` file is
created.

## The `--journal` file

`--journal <path>` exclusively creates the named path and records this
authorship on it. The format is the existing `serializeDurableEvent()` JSONL
sequence — the command root's ordinary live durable events, in commit order:
cleared Agent turns, draft checks, review decisions, admission and the terminal
outcome. There is no curated projection and no format of this command's own.

It records no later program execution, because there is no later program
execution. It is written and never read: nothing opens it as input, replays it,
or treats it as resume authority.

Without `--journal`, no file is created anywhere.

### What the file holds when the invocation ends

**Whatever committed is complete and readable, however the invocation ended.**
An entry reaches the file only after it has cleared the pre-append gate, and it
is appended whole. So the file is always a prefix of the sequence this
authorship would have recorded — never a truncated record, a half-written line
or a line without its terminator — and every line in it parses as the durable
event it is. That holds for all four endings:

| Ending | The file holds |
| --- | --- |
| the Plan was approved and delivered | the whole authorship, ending in its terminal event |
| an ordinary failure — a failed turn, a Stop, exhaustion, cancellation, a teardown failure, the final structural refusal | everything that committed before it, complete |
| an entry the file would not take | everything that committed before that entry, complete |
| an event the secret gate rejected | everything that committed before that event, complete, and nothing of the rejected one |

The middle two rows are the ones worth stating: an invocation that ends badly
still leaves usable evidence, which is the whole reason to ask for a journal in
the first place. An ordinary failure is not a journal failure — the file took
every entry it was offered, and no journal diagnostic is reported for it.

**Secret detection covers it.** Every live durable event crosses the serialized
pre-append gate, so a rejected event reaches neither the file nor the in-memory
committed sequence, and the file prefix recorded before it stays readable. Help
says plainly that the gate may not catch every sensitive detail and that the
journal can contain prompts, drafts and review answers.

An existing path is refused before catalog preparation, session placement, Agent
startup, review or artifact creation, and is left byte-identical:

```text
Journal file already exists: <path>. Choose a different --journal path.
```

A path this command cannot create at all reports why, and where to go next:

```text
Could not create journal file <path>: <reason>

Choose a different --journal path and try again.
```

An entry the file will not take ends authorship. Teardown completes, the
committed prefix is preserved complete, and no Plan is delivered:

```text
Could not write the next entry to journal file <path>: <reason>

The journal still contains the entries recorded before this failure.
```


## Structural host validation, and the artifact

After the command document has completely torn down, the host treats the
returned string as untrusted again. It structurally validates the exact returned
bytes under the `<plan>` identity, the caller's ordered `--include` values and
the ordinary run profile declarations.

It is not a second contract. The invocation settles **one** structural check and
hands the same one to the draft check inside `<CheckDraft>`, to the admission
inside `<AdmitPlan>` and to itself — so what those three can disagree about is
not the question but *when* it was asked. `<AdmitPlan>` answers while the
Component still exists; this gate answers after the whole conversation, its
provider, its Elicitation and its session directory have gone, about a tree that
had all of that time to move. A component the approved Plan names, removed after
a successful admission, is refused here and nowhere else.

What it asks is structure alone, for the same reason `<AdmitPlan>` does: what
runs a Plan later resolves the property values.

A validation failure exits non-zero before any result at all: no stdout and no
file. It does not re-enter the command document or ask for a repair.

The approved bytes then reach exactly one destination.

**Without `--output`**, stdout carries the approved source and nothing else: no
fence, no label, no delimiter and no newline this command added. What a caller
reads is what the coding agent wrote, so it can be piped into `xmd run -`, a
file, a diff or another program. No file is created anywhere.

**With `--output <path>`**, the path is resolved against the contextual working
directory and **created exclusively**: an existing path is left exactly as it
is, the command fails, and nothing else happens. There is no check-then-write —
the exclusive create *is* the check.

```console
$ xmd plan "…" --output release.md
/tmp/work/release.md already exists — choose another --output path; the approved Plan was not written
```

The file holds the approved Plan and nothing else: no problems, no decision, no
wrapper. It is created after approval, after complete authorship teardown and
after this validation — never opened early, and never truncated. Stdout stays
empty, so a caller who named a file does not also get a copy.

The `<plan>` identity affects positions and diagnostics only. Nothing is
executed on any path: no ordinary repository provider, journal, Agent stack or
runtime identity is assembled, because there is no second root to assemble one
for. Whether the approved program ever runs is the composition the caller
writes.

## Timeouts

`--timeout` bounds the whole command: preflight, catalog construction, the
command document's execution, Elicitation, its teardown, the structural
validation and the artifact. It covers no later program, because this command
starts none. Expiry is Effection cancellation, so structured teardown completes
before the failure is reported, and a teardown failure prevents every later
phase.

Nothing bounds an authoring turn but that deadline. `--timeout-exec` and
`--timeout-fetch` configure a document's effects and belong to `xmd run`.

## Failures

Every failure below exits non-zero, and each one stops the phases after it. None
of them writes an artifact, and none of them starts a program — because no
ending of this command does.

| Failure | Reaches |
| --- | --- |
| a malformed command line, a removed option, an unknown option, or `--save` | nothing |
| a `--journal` path that exists, or one this command cannot create | no catalog, session, turn, review, stdout or file |
| an unknown `--agent-provider` | nothing |
| a catalog an include makes unreadable | no turn, review, stdout or file |
| a `--journal` entry the file will not take | no stdout or file; the committed prefix stays |
| a progress destination that stops accepting bytes | no stdout or file; accepted bytes stay |
| a host that supplies no Agent context, or a provider that cannot establish the authorship profile's ceiling | no session, no turn |
| a turn that did not complete | no review, stdout or file |
| the command document's authored `<Fail>` — stopping, the automatic explanation, or the unexpected ending after neither | no stdout or file |
| command document teardown | no structural validation, stdout or file |
| structural validation of the approved bytes | no stdout or file |
| an `--output` path that exists, or a write that fails | no stdout |

## Acceptance

Tiers PR and PO. The evidence lives in `packages/cli/tests/plan-args.test.ts`
(fixed grammar), `packages/cli/tests/plan-command-document.test.ts` (the packaged
document executed as itself, and the authored phases and counters),
`packages/cli/tests/plan-component.test.ts` (the ordinary `<Plan>` surface),
`packages/cli/tests/plan.test.ts` (the host and
the packaged document writing a Plan together) and
`packages/cli/tests/plan-cli.test.ts` (the command lifecycle, its grammar as an
operator meets it, the artifact, the channels, the journal and the failures each
of them can have).

The ACPX runtime is a scriptable fake, the review provider is a scripted
`Elicitation` handler, and the contextual working directory is a temporary one:
no live agent, browser or network appears in this evidence. Every refusal is
proven by the phase tripwires that stayed at zero rather than by output nobody
produced, and non-execution is proven by an approved program that writes a file
and then fails — a command that succeeded, produced the exact bytes, and left
neither observation never interpreted what it wrote.

| # | Criterion | Required observation |
| --- | --- | --- |
| PS1 | Fixed grammar | Every retained option is accepted before and after the request, one request is preserved byte for byte, and a second positional is refused with the approved sentence |
| PS2 | The removed switch | Bare, valued, repeated, before-request, after-request and value-position `--run` forms all return the exact migration text, before any catalog, Agent, session, review, filesystem or document activity |
| PS3 | The removed options | One representative of every other removed class, both short aliases, and the aggregate and generated property names return the exact generic refusal before authorship, ahead of the shared timeout and secret-detection grammar checks; a name that merely begins like a property option keeps the generic unknown-option refusal |
| PS4 | Help | The complete `xmd plan --help` output and the program summary contain only the retained grammar and both explicit compositions; no removed option appears anywhere in either. Help beside every retained option is still help; help beside a removed one, in either order, is that option's refusal |
| PS5 | Run is unchanged | `xmd run --help` still exposes its execution, prop, permission, timeout, presentation, journal and secret-detection options |
| PS6 | Stdout | Approval without `--output` writes the exact source once, with no wrapper and no added newline, and a source-named effect and runtime failure both stay inert |
| PS7 | The artifact | Approval with `--output` writes the same exact bytes, keeps stdout empty, creates the path only after authorship teardown and structural validation, and refuses an existing path without changing it |
| PS8 | Structure, not values | A structurally valid Plan declaring a required root property is produced successfully with no value supplied |
| PS9 | Endings | Stop, the ten-attempt explanation, a failed Agent turn, missing Agent context, cancellation, teardown failure and the host's own structural refusal each return non-zero with no stdout artifact, output file or program effect. The refusal row drives the one shared structural check: the draft check and `<AdmitPlan>` both really validate and both succeed, the tree moves immediately after that admission, and the gate this command keeps for itself is the only thing left to catch it |
| PS10 | No execution anywhere | An explicitly named session continues the planning conversation and still starts no program; no execution callback, program journal or second-root identity exists to reach |
| PS11 | Adapter and Component | The command document remains the exact thin adapter, and `<Plan>` remains a bare-or-captured exact text component |
| PS12 | Product copy | Architecture, specifications, README and the homepage state that Plan produces source, Run executes source, and composition decides when it runs |
| C2–C5, C8, C9, C13, C14 | Authorship | The packaged adapter and Component, one Session, the profile ceiling, the repair and review bounds, safe presentation, the authored endings, directory lifetime and narrative preservation are unchanged by this command producing source only, and keep their evidence |
| PO1 | Progress precedes the work | Preparing arrives before the catalog is built, Drafting before the first turn, Checking before validation, Waiting before review and Finalizing before authorship teardown; an early phase reaches the operator while a turn is still blocked |
| PO2 | Counters come from the bounds | One invalid attempt uses repair ordinals 1st–3rd with a check before each result; a requested change announces the 2nd attempt; the counters reach the 10th and there is no 11th |
| PO3 | Terminal phases | Stop announces itself before teardown and keeps its exact final diagnostic; a tenth-attempt exhaustion announces itself before the automatic explanation, opens no review and produces no Plan |
| PO4 | The ordinary surface is silent | A bare `<Plan>` emits only exact approved source, a captured `<Plan as>` binds the same bytes and emits nothing, and neither expands a progress body whatever verbosity the declaration carries |
| PO5 | Disclosure | Default progress excludes the request, the drafts, the diagnostics, the feedback and every Agent, provider and tool output; verbose adds every cleared draft and each invalid check's exact structured JSON, in phase order, and nothing else |
| PO6 | Channels | A non-terminal stderr receives normalized Markdown, a stated terminal receives it rendered, and stdout and `--output` stay byte-identical exact source in both |
| PO7 | The two options | `--verbose` and `--journal` are accepted on either side of the request, help contains them and the journal warning, and `-V`, `-j`, `--trace` and every removed spelling refuse before the catalog or a session exists; a retained option written where the journal path goes is that option rather than a filename, and refuses before any catalog, session, provider, filesystem or artifact work |
| PO8 | The journal file | With no `--journal` no file appears; with one, the path exists before the catalog and the first turn, a successful trace parses as the existing JSONL events in commit order and ends terminally, and it holds no program-execution event |
| PO9 | Journal refusals | A pre-existing journal is byte-identical and refuses with the exact copy before any catalog, session, turn, review or artifact work; a path that cannot be created reports the other exact copy |
| PO10 | A secret in a draft | It reaches neither the progress nor the journal, the earlier prefix stays readable, teardown completes, and no source or artifact is delivered — while the same draft without it is displayed and recorded |
| PO11 | A secret in a diagnostic | The same, for a failed check's structured findings |
| PO12 | A refused entry | An append failure after a committed entry reports the exact journal-write diagnostic, preserves a readable prefix, completes teardown and delivers no Plan |
| PO16 | An ordinary failure | A journal-backed invocation that fails for its own reason — a failed turn, with neither a secret rejection nor a write failure — exits non-zero, delivers no source and no artifact, completes teardown, and leaves a file whose every committed entry parses and whose bytes are exactly those entries re-serialized: no partial or unterminated trailing record |
| PO13 | A failed destination | A consumer that fails while a turn is live cancels that turn, waits for every owned teardown, attempts no artifact sink, keeps the bytes stderr accepted, and uses the exact progress-failure diagnostic |
| PO14 | Ordering is unchanged | Cancellation, teardown failure, final validation refusal, the `--output` refusal and a successful delivery all keep their order, and no phase claims an artifact was delivered |
| PO15 | The adapter and the catalog | The packaged adapter emits no prose of its own, and the catalog is built exactly once, from `<PlanInputs>`, after Preparing |
