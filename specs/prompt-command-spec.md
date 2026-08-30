# The `xmd prompt` command

`xmd prompt` turns your **Prompt** — the request you typed, in ordinary language
— into a **Plan**: an Executable Markdown document that states what you asked
for in ordinary language and places the components that perform the work
alongside those words.

```console
$ xmd prompt "ask me for my age and write the result to a file"
```

A Plan is not merely executable code. It preserves the Prompt's intent as
reader-facing prose interleaved with the components that fulfil it, so the
request above should produce a document shaped like this:

```markdown
Ask me for my age.

<Elicit as="answer" schema={{ type: "object", properties: { age: { type: "number" } } }} />

Write it to a file.

<File path="age.txt">{answer.age}</File>
```

and an execution organized by the same narrative: the first sentence, the
interaction, the second sentence, the file. The Prompt need not be copied
literally — it may be divided, clarified and rewritten into natural prose — but
every requested outcome, their meaningful ordering, and their relationship to the
components performing them are preserved.

The command writes no policy of its own. It executes two root documents with a
complete scope boundary between them: first the **prompt command document**, a
checked-in first-party Markdown value root that implements this conversion and
its review workflow — what the assistant is asked, how many drafts may be
repaired, what you are shown, and what happens when you approve nothing — and
then the Plan that document returned, through the same path `xmd run` uses for a
supplied one. The prompt command document is not itself a Plan. There is no
second execution model, no second props model and no second journal.

## The flow

```text
fixed command preflight
  -> build the run-profile syntax catalog
  -> execute the exact packaged prompt command document
       -> one Session
       -> generate, check, repair, review, revise, approve or fail
       -> Return the exact approved Plan source
  -> await that execution and provider teardown
  -> validate the returned source again
  -> optionally save the exact bytes
  -> execute retainedSource("<prompt>", source) through the ordinary run path
```

Each phase hands the next one a value. No phase after the first failure begins,
so a refused command line reaches no catalog, a failed turn reaches no review,
and an aborted review reaches no file and no run.

Writing a Plan is a conversation, and a conversation is not a run: the prompt
command document runs on an invocation-owned in-memory durable stream that is
never written to `--journal`, persisted, reused or replayed. Only the approved
Plan's execution owns `--journal`.

## Command grammar

```console
xmd prompt <request> [options] [--props-<name> <value>]…
```

The request is one positional argument and is text for the agent, never a path.
It must hold at least one non-whitespace character; that is the only test
applied to it. Its original text is preserved and sent byte for byte, so leading
and trailing whitespace survives.

No request, more than one request, an empty string and a whitespace-only string
each fail the invocation. There is no stdin form and no editor form: a request
nobody wrote is never guessed, and no token is silently dropped.

`--` ends option parsing, so a request that begins with `-` is written after it:

```console
xmd prompt -- "--this is the request"
```

`xmd prompt` takes the complete `xmd run -e` execution flag set — `--include`,
`--verbose`, `--journal`/`-j`, `--raw`, `--agent-provider`, `--default-agent`,
`--approve-all`, `--approve-reads`, `--deny-all`, `--no-secret-detection`, and
the three timeout options — plus `--save` and `--session`.

Agent provider selection, default agent selection and `--timeout` configure how
the Plan is written. The permission flags and the exec and fetch timeouts
configure only the approved Plan; authorship does not inherit the final run's
permission mode, and no permission flag widens the prompt profile's ceiling
below.

`-e`/`--eval` stays exclusive to `xmd run`. A prompt supplies a request, not a
document. Supplying one anyway is refused in the command's own preflight, with
`unrecognized option for xmd prompt: --eval — inline documents are exclusive to
xmd run`, before the catalog, the command document, the review, the save, the
journal or any execution exists.

Those options are resolved into one Agent configuration once per invocation —
one `--agent-provider`, one `--default-agent` or `DEFAULT_AGENT_NAME`, one
permission mode — and that settled answer is what both the prompt profile and
the approved Plan's installation are configured from. Incompatible permission
flags and an unknown provider fail there, before the catalog is built.

### `--save <path>`

Write the approved source to `path` before executing it. The path is resolved
against the contextual working directory and **created exclusively**: an
existing path is left exactly as it is, the command fails, and nothing runs.
There is no check-then-write — the exclusive create *is* the check.

The file holds the approved Plan and nothing else: no problems, no decision, no
wrapper. Without `--save`, no file is created anywhere; the approved Plan runs
from memory.

### `--session <name>`

Use this logical assistant session instead of one unique to the invocation. The
name must be non-empty; `--session` with an empty value is refused by fixed
grammar rather than read as absent, so a caller who asked for a named session
never falls back to the generated one by accident.

Ordinary provider session continuation applies when the configured provider
already holds that name. The prompt command document still supplies the current
request and the current catalog in this invocation's initial turn.

### Help

```console
xmd prompt --help
```

Help needs no request. It describes the request, `--save`, `--session`, the
aggregate `--props`/`XMD_PROPS` sources, that candidate-declared individual
options follow the request, that the permission flags configure the approved
document, and every shared execution flag. It describes no individual property,
because the document that would declare one does not exist yet — answering
otherwise would mean generating a document in order to describe one.

Help reads no catalog, contacts no provider, places no session, asks nobody
anything, creates no file and runs nothing.

## The packaged prompt command document

The host executes one immutable packaged Markdown value root,
`packages/cli/src/documents/prompt-command.md`, under the stable internal source
identity `<prompt-command>`. Its declared return schema is exactly
`{ type: "string" }`. It is located from the CLI module's own URL — never from
the working directory and never through the component search path — so the same
policy is found whatever directory a person stands in, and no repository file can
answer for it ([release process](./release-process-spec.md)).

The host supplies three fixed internal inputs as that root's props:

- `request` — the original request text;
- `syntax` — the rendered syntax catalog for the current run profile and ordered
  `--include` values; and
- `session` — the resolved logical assistant-session name.

They are not Plan root props and consume none of the approved Plan's property
sources.

The document contains one enclosing `<Session>` expansion whose body holds every
initial, repair and human-revision `<Prompt>`. A loop inside that one Session
creates no second placement; sibling Sessions are not used, because sibling
placements stay distinct even when their authored names match.

The host owns the provider instruction layer and the Agent ceiling. The Markdown
document owns the text of each generation, repair and revision request: the
initial prompt preserves the Prompt, includes the host's catalog, and asks for
one complete replacement root as source only — written as a Plan, with every
requested outcome kept as reader-facing prose and each component placed
immediately after the sentences describing the action it performs. That
authorship rule is repeated in every repair and revision request, so the
narrative survives a draft being replaced.

`<Prompt>` remains one Agent turn. It gains no hidden repair, retry, review or
approval behaviour.

## The prompt profile

The prompt profile is the trusted-host assembly used only for that exact root. It
supplies the document's inputs, a constrained Agent provider, Elicitation, the
fixed first-party components and the host-declared draft validator. It uses no
repository component search — that execution's include list is empty — and
exposes no custom root.

### Agent authority under the prompt profile

The assistant that writes a Plan is assembled separately from the final run
provider:

- one host-owned directory dedicated to the logical prompt session, created
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
grant the Agent a native network tool.

`--approve-all`, `--approve-reads` and `--deny-all` do not change this ceiling.
They apply to the approved Plan later. A provider that cannot establish this
ceiling refuses before session materialization or a turn; there is no silent
downgrade.

The profile's working directory is
`~/.xmd/prompt/sessions/<sha256(logical-session-name)>`. It is dedicated to that
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

- an **invocation-unique default** directory is the command's own. Exactly one
  cleanup is attempted, after the command document and every provider, Prompt
  task and Elicitation resource inside it has torn down, and it settles before
  final validation, the save or the execution begins. Success, abort, a failed
  turn and cancellation all reach it. It has exactly two outcomes:
  - **still empty** — that exact leaf is removed, non-recursively;
  - **no longer empty** — the directory and everything in it are preserved and
    the command fails terminally. It is not a warning and not a silent skip, and
    no final admission, save or execution follows.
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

The approved Plan later receives the caller-selected ordinary run Agent and
permission configuration. It inherits neither the assistant Session nor its
instruction layer.

### The assistant Session

Without `--session`, the host generates a logical name unique to the invocation.
The exact name is supplied to the command document, and its one enclosing
`<Session>` materializes only at the first consuming `<Prompt>`. Every turn
within this invocation uses that one Session.

A turn produces a draft only from its complete successful close value. The host
decides, for the whole command document execution, that a failing `<Prompt>` ends
it: a failed, cancelled, unavailable or protocol-invalid turn discards its
partial text and reaches no human review, save or final execution, and the
document cannot opt out of that.

That execution closes after approval or failure. The host observes its result
only after every Prompt task, Agent provider resource, Elicitation resource and
other child has completed teardown. A teardown failure wins over a selected Plan
and prevents final validation, save and execution.

### A draft is data

An Agent reply is an inert string while the Plan is being written. The command
document may bind it, pass it to the validator, serialize its problems, present
it with `<CodeBlock>` and return it. It never evaluates the draft and never
dynamically imports it. Only after approval, teardown and final host validation
may those exact bytes enter ordinary execution.

## Host-declared draft validation

The prompt profile declares one internal value component to the execution:

```md
<ValidateCandidate source={candidate} as="assessment" />
```

Canonical execution supplies its invocation identity, so repository resolution
cannot replace it. Its result is a closed candidate assessment: either
`{ valid: true, diagnostics: {} }`, or `{ valid: false, diagnostics }` where
`diagnostics` carries the complete versioned `DocumentValidation` when core
produced one and the structured generated-binding diagnostic when property
binding failed.

The component performs no candidate execution. For each source it:

1. validates the supplied root declaration without executing it;
2. once a usable root props schema exists, derives that schema's bindings;
3. checks every frozen supplied individual-option signature before consuming
   tokens;
4. resolves the original CLI and invocation-environment property sources under
   that schema; and
5. calls `validateDocument()` with those exact props, the caller's includes and
   the run profile's identity-component declarations.

## Generated document properties

An `xmd prompt` invocation resolves root props exactly as `xmd run` does — same
sources, same precedence, same decoding ([Root Document
Props](./root-document-props-spec.md)) — with one difference: the schema comes
from the *candidate*, and there may be several candidates.

```console
xmd prompt "greet someone" --props-name Ada --props-loud
```

The aggregate `--props` may be written before the request, because its meaning
never depends on a document. An individual `--props-*` option before the request
fails in preflight, before any catalog, Agent, elicitation, save, journal or
document operation.

The original argv is the command line source for every candidate. `XMD_PROPS`
and the candidate's `XMD_PROPS_*` variables are read through the contextual
runtime environment. No resolved props object is carried from one candidate to
the next, or from any candidate to the approved bytes.

### Frozen signatures

An individual option's **signature** is its generated option name, its token
arity — a bare switch or one value — and its accumulation behaviour — scalar
last-wins or repeated array. The first candidate that successfully binds a
supplied option freezes that option's signature.

Before a later candidate extracts anything, every frozen supplied option is
compared with that candidate's binding. A removed option, a changed arity or a
changed accumulation is a terminal caller-source failure. The comparison happens
*before* extraction, so a switch that became a value option cannot reach forward
and read the `--raw`, `--include` or other built-in option written after it.

A built-in option is never read as a generated property's value. A value that
really begins with `-` is written in the unambiguous inline form:

```console
xmd prompt "<request>" --props-name=-Ada
```

### Candidate failures and caller failures

These are **repairable candidate failures**. The agent authored them, so the
assessment answers `valid: false` and the command document may ask again:

- source, frontmatter, target, root-props and return-declaration diagnostics;
- a generated binding-name collision — two declared properties producing one
  option or one environment variable;
- missing required root props and every other `props-invalid` result; and
- every other definite document diagnostic.

These are **terminal caller-source failures**. The caller wrote them, so they
raise out of the validator and end the command document immediately, with no
repair turn, no presentation, no approval, no save, no final journal and no final
execution:

- a supplied individual option the usable candidate schema does not declare;
- malformed aggregate CLI or environment JSON;
- an individual CLI or environment value the candidate schema cannot decode;
- an extra positional the candidate's binding arity exposes; and
- a later candidate removing a frozen option or changing its signature.

The split is about authorship, not severity. A collision is repairable because
the candidate authored both colliding names; an undeclared option is terminal
because only the caller supplied it. The command document has no way to catch a
terminal failure and no way to recategorize it as draft feedback.

An opaque `not-statically-checkable` invocation is not a diagnostic and does not
by itself make a candidate invalid.

## The policy the prompt command document owns

The following is the shipped program's behaviour, not the host's. It is stated
here because it is what a caller sees; it is changed by editing
`prompt-command.md`, and nothing in TypeScript decides it. Prose quality is that
document's instructions and your review, never a hidden TypeScript validation
rule: `<ValidateCandidate>` reports structural facts and executes nothing.

**Automatic repair.** The initial draft and every human-requested revision each
start a fresh repair budget: the base candidate is attempt one, at most three
repair turns may replace it, every repair prompt carries the complete structured
diagnostics, and every answer must be another complete replacement root. The
fourth invalid candidate is repair-exhausted and goes to human review with its
diagnostics. No fence is stripped, no Markdown substring is extracted and no
patch is applied.

**Human review.** At most ten candidate presentations: the initial review plus at
most nine human revisions. Rounds one through nine offer `approve`, `revise` or
`abort` for a valid candidate, and `revise` or `abort` for an invalid
repair-exhausted one. `revise` requires non-empty feedback, sends one
complete-replacement request through the same enclosing Session, and resets the
three-turn repair budget. Round ten offers no further revision: a valid
candidate offers `approve` or `abort`, and an invalid one offers only `abort`.

**Presentation.** The review message presents the exact draft with `<CodeBlock>`,
whose fence is longer than every backtick run the draft holds, so draft text
cannot close it and is never interpreted. An invalid draft is followed by its
complete JSON problems, serialized by `<Json>`. Prose outside `<Prompt>`
addresses you; text inside `<Prompt>` instructs the assistant.

**Failure.** `approve` selects the draft, and one exhaustive branch after the
Session returns its source unchanged. Stopping reaches `<Fail>` with one of two
authored messages, and which one depends on whether an approvable Plan ever
existed:

- the tenth presentation of a draft that still has problems offers only `abort`,
  and taking that sole choice is **exhaustion** — ten drafts were reviewed and
  none was approved;
- every other `abort`, including one on a tenth draft that could have been
  approved, is the ordinary ending: you decided to stop.

The branch after the Session stays as an exhaustive fallback for a body that
somehow reached it having approved nothing. Failure is authored in Markdown
rather than hidden in the host or represented by a missing-`<Return>` accident.

The command document's rendered output is not command output. Everything you see
while a Plan is written reaches you through Elicitation, and that document's
successful public result is the approved Plan source and nothing else.

## Final admission, save and execution

After the command document has completely torn down, the host treats the
returned string as untrusted again. It repeats candidate validation and property resolution using the exact
returned source, the original raw CLI and invocation-environment property
sources, the individual-option signatures frozen while it was written, the
caller's
ordered includes and the ordinary run profile declarations.

A final caller-source failure or document validation failure exits non-zero
before save or execution. It does not re-enter the command document or ask for a
repair. The final resolved props belong to those exact source bytes; no props
object from an earlier candidate is reused.

`--save` then exclusively creates the target with those exact bytes. The host
then executes `retainedSource("<prompt>", source)` through the ordinary
supplied-source run path, with the same includes, output, value result, secret
detection, Agent configuration, permission mode and timeouts `xmd run -e` uses.
No temporary Markdown file is created.

The `<prompt>` identity affects positions and diagnostics only. The contextual
working directory still resolves relative filesystem operations, repository
components and includes. The executed program receives a fresh ordinary document
Agent provider and inherits neither the assistant Session nor its instruction
layer.

`--journal` is created when the final execution starts, and only then. That
journal contains no command document, assistant Session, Agent turn, draft
validation, repair or human-review event. Rendered output, a value root's JSON
result, runtime failure reporting and exit codes are byte-for-byte ordinary
`xmd run` behaviour — including a failing `<Testing>` boundary, which is reported
under its own `tests failed:` heading rather than as a bare message. A runtime
failure does not send the command back to authorship; `--save` has already
completed,
and the source is there to hand-edit.

## Timeouts

`--timeout` bounds the whole command: preflight, catalog construction, the
command document's execution, Elicitation, its teardown, final validation, the
save and the execution. Expiry is Effection cancellation, so structured teardown completes
before the failure is reported. A teardown failure prevents every later phase.

`--timeout-exec` and `--timeout-fetch` configure the final document's effects
only, exactly as under `xmd run`. Nothing bounds an authoring turn but the
command deadline.

## Failures

Every failure below exits non-zero, and each one stops the phases after it:

| Failure | Reaches |
| --- | --- |
| a malformed command line | nothing |
| incompatible permission flags or an unknown `--agent-provider` | nothing |
| a catalog an include makes unreadable | no command document |
| a provider that cannot establish the prompt profile's ceiling | no session, no turn |
| a turn that did not complete | no review, save or run |
| a terminal caller-source failure | no repair, review, save or run |
| the command document's authored `<Fail>` | no save or run |
| command document teardown | no final validation, save or run |
| final validation of the approved bytes | no save or run |
| a `--save` path that exists, or a write that fails | no run |
| the document's own runtime failure | nothing after it; the save stands |

## Acceptance

Tier PR. The evidence lives in `packages/cli/tests/prompt-args.test.ts` (fixed
grammar and signatures), `packages/cli/tests/prompt-command-document.test.ts`
(the packaged document executed as itself), `packages/cli/tests/prompt.test.ts`
(the host and the packaged document writing a Plan together) and
`packages/cli/tests/prompt-cli.test.ts` (the command lifecycle, filesystem,
journal and execution).

The ACPX runtime is a scriptable fake, the review provider is a scripted
`Elicitation` handler, and the contextual working directory is a temporary one:
no live agent, browser or network appears in this evidence. Every refusal is
proven by the phase tripwires that stayed at zero rather than by output nobody
produced.

| # | Criterion | Required observation |
| --- | --- | --- |
| C1 | Fixed grammar and help | Request cardinality, individual-property ordering, aggregate props before the request, `--session` including its empty-value refusal, and effect-free generic help |
| C2 | Exact packaged root | The command executes the checked-in Markdown value root under `<prompt-command>`; the turn text is that document's own words, and no TypeScript authorship loop or custom root chooses policy |
| C3 | Visible policy | Generation, three-turn repair, ten-round review, revision, approval, abort and exhaustion are present in Markdown; `<Prompt>` remains one turn |
| C4 | One Session | One enclosing Session expansion carries every turn; two default invocations get different profile directories and session keys, two `--session` invocations get the same directory and key with the raw name absent from the path, and two named invocations sharing one ACPX store continue the established record rather than placing a second |
| C5 | Prompt profile ceiling | This session's own host-owned directory, empty while the command document runs, no MCP servers, no native tools, strict private denial, no Files/command/network capability for the command document, and final-run permission flags that cannot widen any of it; pre-existing content in that directory refuses before any provider, session, turn, review, save or execution and is left untouched |
| C6 | Draft inertness | A draft is only data while the Plan is written, and no draft effect occurs before the final execution |
| C7 | Validation classification | Candidate failures return structured facts; caller-source failures escape immediately; frozen signatures are checked before token extraction |
| C8 | Bounds | One base plus three automatic repairs per draft, and no more than ten human presentations, with no revision offered on the last |
| C9 | Safe presentation and authored failure | Arbitrary source cannot close `<CodeBlock>`; an ordinary abort and a tenth invalid presentation's sole `abort` reach their two distinct authored `<Fail>` messages, not host policy and not a missing `<Return>` |
| C10 | Final gate | The host revalidates after the command document has completely torn down — a component removed during that teardown makes the unchanged approved bytes fail admission, with no save, journal or execution — and resolves props for the exact returned bytes |
| C11 | Exact bytes | Approval, exclusive save and `<prompt>` execution receive the Agent close value without rewriting or fence removal |
| C12 | Journal separation | Authorship uses only disposable in-memory history; the final journal begins with the approved Plan |
| C13 | Lifetime | Cancellation and every teardown failure settle before final validation, save or execution; a default session's directory is empty while its turn runs and gone after teardown on success, abort, a failed turn and cancellation alike; and one that gained content is preserved whole while the command fails terminally, with no admission, save, journal or execution after it |
| C14 | Narrative preservation | The shipped generation, repair and revision instructions carry the narrative-plus-components rule, the assistant receives it with the request and the catalog, and a scripted Plan of prose interleaved with components returns byte for byte after approval |
| C15 | Ordinary run | The approved source keeps normal cwd, includes, props, output/value, permission, timeout, failure and save behaviour |
