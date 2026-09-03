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
  -> build the run-profile syntax catalog
  -> execute the exact packaged plan command document, which is an adapter
       -> <Plan>, the packaged Component, with the request as its Prompt
            -> the authorship frame, and one Session inside it
            -> generate, check, repair, review, revise, approve, explain or fail
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

Writing a Plan is a conversation, and a conversation is not a run: the plan
command document runs on an invocation-owned in-memory durable stream that is
never persisted, reused or replayed. No invocation of this command writes a
journal.

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
| `--help`, `--version` | ordinary behaviour |

Every one of them is either about *who writes the Plan*, *what vocabulary they
write it in*, or *where the approved source goes*.

### What the command removed

Everything that configured **running** the approved program is gone, with no
alias and no inert placeholder:

- `--run`;
- the root-property options — the aggregate `--props` and every generated
  `--props-*` and `--no-props-*` name;
- `--raw`;
- `--verbose` and `-V`;
- `--journal` and `-j`;
- `--timeout-exec` and `--timeout-fetch`;
- `--approve-all`, `--approve-reads` and `--deny-all`; and
- `--secret-detection` and `--no-secret-detection`.

Each of them describes work this command never performs, and every one of them
is still `xmd run`'s. Accepting one silently would mean answering a caller who
asked for a journal, a permission mode or a root property with a command that
creates none of them.

The fixed grammar owns these refusals, before the general parser can drop a
token, coerce its value, or read it as a second positional. An option's name is
read up to its first `=`, so every valued spelling arrives under the name it was
written as; a removed option consumes no following token and inspects no
candidate schema. It is refused wherever it stands — before the request, after
it, beside a retained option, and in the place a retained option's value would
otherwise have swallowed it.

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

Help needs no request. It describes the request, `--output`, `--session`, the
authorship and catalog options and the deadline; it states that the approved
Plan is the only result, that stdout carries its exact bytes when `--output` is
absent, and that planning never runs the approved program — and it writes out
both explicit compositions. No removed option appears anywhere in it.

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

The host supplies three fixed internal inputs as that root's props:

- `request` — the original request text;
- `syntax` — the rendered syntax catalog for the current run profile and ordered
  `--include` values; and
- `session` — the resolved logical assistant-session name.

They are the adapter's own, and nothing a Plan declares is bound here: the
properties a Plan's root declares are resolved by whoever runs it.

**The root is an adapter, not the workflow.** It projects `props.request` into
`<Plan>` without adding whitespace, supplies `props.session`, captures the exact
source the Component renders, and returns it. It contains no Prompt, no check, no review, no revision
and no ending of its own. `props.syntax` is sealed by the host rather than
forwarded: the catalog the agent is shown is the one this command rendered, and
no prop on the adapter could supply another.

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

**The four private capabilities.** The Component's phases are components only these
exact bytes may write, declared by the host with the definition and revoked with
the execution: `<PlanInputs>` freezes the catalog, the instruction identity, the
session placement, the surface and whether that placement outlives the
invocation, and refuses a continuation whose instructions render differently —
as stale input, before a directory, a provider, a turn or a review exists; paired
`<PlanAuthorship>` installs the constrained frame and does not return until every
part of it has torn down; `<CheckDraft>` answers about one draft without
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

The component performs no candidate execution. For each source it calls
`validateDocumentStructure()` with the caller's ordered includes, the run
profile's identity-component declarations and the packaged `<Plan>` description
— the same vocabulary the catalog showed the agent.

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

The command document's rendered output is not command output. Everything you see
while a Plan is written reaches you through Elicitation, and that document's
successful public result is the approved Plan source and nothing else.

## Structural host validation, and the artifact

After the command document has completely torn down, the host treats the
returned string as untrusted again. It structurally validates the exact returned
bytes under the `<plan>` identity, the caller's ordered `--include` values and
the ordinary run profile declarations — the same structural contract `<Plan>`'s
own `<AdmitPlan>` applies, and for the same reason: what runs a Plan later
resolves the property values, so this gate asks only whether the source is a
program.

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
| an unknown `--agent-provider` | nothing |
| a catalog an include makes unreadable | no command document |
| a host that supplies no Agent context, or a provider that cannot establish the authorship profile's ceiling | no session, no turn |
| a turn that did not complete | no review, stdout or file |
| the command document's authored `<Fail>` — stopping, the automatic explanation, or the unexpected ending after neither | no stdout or file |
| command document teardown | no structural validation, stdout or file |
| structural validation of the approved bytes | no stdout or file |
| an `--output` path that exists, or a write that fails | no stdout |

## Acceptance

Tier PR. The evidence lives in `packages/cli/tests/plan-args.test.ts` (fixed
grammar), `packages/cli/tests/plan-command-document.test.ts` (the packaged
document executed as itself), `packages/cli/tests/plan.test.ts` (the host and
the packaged document writing a Plan together) and
`packages/cli/tests/plan-cli.test.ts` (the command lifecycle, its grammar as an
operator meets it, and the artifact).

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
| PS3 | The removed options | One representative of every other removed class, both short aliases, and the aggregate and generated property names return the exact generic refusal before authorship, ahead of the shared timeout and secret-detection grammar checks |
| PS4 | Help | The complete `xmd plan --help` output and the program summary contain only the retained grammar and both explicit compositions; no removed option appears anywhere in either |
| PS5 | Run is unchanged | `xmd run --help` still exposes its execution, prop, permission, timeout, presentation, journal and secret-detection options |
| PS6 | Stdout | Approval without `--output` writes the exact source once, with no wrapper and no added newline, and a source-named effect and runtime failure both stay inert |
| PS7 | The artifact | Approval with `--output` writes the same exact bytes, keeps stdout empty, creates the path only after authorship teardown and structural validation, and refuses an existing path without changing it |
| PS8 | Structure, not values | A structurally valid Plan declaring a required root property is produced successfully with no value supplied |
| PS9 | Endings | Stop, the ten-attempt explanation, a failed Agent turn, missing Agent context, cancellation, teardown failure and structural refusal each return non-zero with no stdout artifact, output file or program effect |
| PS10 | No execution anywhere | An explicitly named session continues the planning conversation and still starts no program; no execution callback, program journal or second-root identity exists to reach |
| PS11 | Adapter and Component | The command document remains the exact thin adapter, and `<Plan>` remains a bare-or-captured exact text component |
| PS12 | Product copy | Architecture, specifications, README and the homepage state that Plan produces source, Run executes source, and composition decides when it runs |
| C2–C5, C8, C9, C13, C14 | Authorship | The packaged adapter and Component, one Session, the profile ceiling, the repair and review bounds, safe presentation, the authored endings, directory lifetime and narrative preservation are unchanged by this command producing source only, and keep their evidence |
