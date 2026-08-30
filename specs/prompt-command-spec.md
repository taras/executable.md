# The `xmd prompt` command

Ask the configured agent for an executable Markdown document, prove it is one,
decide whether to run it, and run it.

```console
$ xmd prompt "ask me for my age and write the result to a file"
```

The command writes no code of its own. It adds *authorship* around one ordinary
document: the agent produces a complete root, `xmd` validates that root without
executing any of it, repairs the definite defects by asking again, shows a
person the exact bytes, and — once they approve — executes those bytes through
the same path `xmd run` uses for a supplied document. There is no second
execution model, no second props model and no second journal.

## The flow

```text
fixed CLI preflight
  -> structured syntax catalog
  -> fresh generator session
  -> candidate props + validation
  -> automatic repair, at most three turns
  -> live approval or human revision
  -> generator teardown
  -> optional exclusive save
  -> ordinary in-memory document execution
```

Each phase hands the next one a value. No phase after the first failure begins,
so a refused command line reaches no catalog, a failed generation reaches no
review, and an aborted review reaches no file and no run.

Generation, repair and approval are a conversation, and a conversation is not a
run: they create no journal, retain no durable identity and replay nothing. Only
the final document execution owns `--journal`.

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
the three timeout options — plus `--save`. Those options configure one
invocation: the same Agent and permission choices answer the generator's
requests and the executed document's, and the same includes describe the
vocabulary and resolve the run's components.

`-e`/`--eval` stays exclusive to `xmd run`. A prompt supplies a request, not a
document.

### `--save <path>`

Write the approved source to `path` before executing it. The path is resolved
against the contextual working directory and **created exclusively**: an
existing path is left exactly as it is, the command fails, and nothing runs.
There is no check-then-write — the exclusive create *is* the check.

The file holds the approved source and nothing else: no diagnostics, no
decision, no wrapper. Without `--save`, no generated-source file is created
anywhere; the approved document runs from memory.

### Help

```console
xmd prompt --help
```

Help needs no request. It describes the request, `--save`, the aggregate
`--props`/`XMD_PROPS` sources, that candidate-declared individual options follow
the request, and every shared execution flag. It describes no individual
property, because the document that would declare one does not exist yet —
answering otherwise would mean generating a document in order to describe one.

Help reads no catalog, contacts no provider, places no session, asks nobody
anything, creates no file and runs nothing.

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
the next.

For each candidate — the first draft, each repair and each answer to a human
revision — the command:

1. builds the root as supplied text under the `<prompt>` identity;
2. establishes that the root's own declaration is readable, from
   `validateDocument()`'s structured answer rather than from an exception's
   prose;
3. reads the usable props schema with `inspectDocument()`, once that declaration
   is known good;
4. builds the individual bindings that schema generates;
5. holds every supplied option to its frozen signature;
6. extracts the unchanged raw property arguments, reads their environment
   values, and resolves them; and
7. validates the exact candidate again with the resolved props, the ordered
   includes and the host's identity-component declarations.

### Frozen signatures

An individual option's **signature** is its generated option name, its token
arity — a bare switch or one value — and its accumulation behavior — scalar
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
agent is asked again:

- source, frontmatter and root declaration diagnostics;
- a generated binding-name collision — two declared properties producing one
  option or one environment variable;
- missing required root props and every other `props-invalid` result; and
- every other definite document diagnostic.

These are **terminal property-source failures**. The caller wrote them, so no
repair turn is spent and no review, save, journal or execution happens:

- a supplied individual option the usable candidate schema does not declare;
- malformed aggregate CLI or environment JSON;
- an individual CLI or environment value the candidate schema cannot decode;
- an extra positional the candidate's binding arity exposes; and
- a later candidate removing a frozen option or changing its signature.

The split is about authorship, not severity. A collision is repairable because
the candidate authored both colliding names; an undeclared option is terminal
because only the caller supplied it, and teaching the agent about it would spend
a repair turn on a defect the agent cannot fix.

An extra positional a candidate's arity exposes is decided as soon as the first
usable schema exists, and always before anything is presented.

## Generation

One catalog is built for the invocation, from the run profile's declarations in
the contextual working directory and the configured includes — the same
structured `SyntaxCatalog` value `xmd syntax` renders, rendered by the same
renderer. Nothing spawns `xmd syntax`, parses its Markdown, or keeps a second
catalog. Its statement that a repository TypeScript component's contract was not
read is the honest one, and it reaches the generator unchanged.

The system instruction layer states that the session writes complete executable
Markdown roots for the requests that follow, that every answer is replacement
source only with no enclosing fence and no prose, that a repair request carries
validation facts and needs another complete replacement, and that the appended
catalog is the complete available vocabulary. It is the session's system prompt,
not part of any user message.

The initial user turn is the request string itself, byte for byte.

The command resolves one logical session name unique to the invocation and one
exact `Session` value from it, and passes that same value to the initial turn,
every repair turn and every human revision turn. Placing the session contacts no
backend: a fresh placement materializes when the first subscribed turn is
accepted. A second `xmd prompt` places a different session, so no invocation
inherits another's history.

A candidate is the stream's complete close value from a terminal `completed`
turn. A failed, cancelled, unavailable or protocol-invalid turn is a generation
failure however much text it emitted: the partial candidate is discarded, and
nothing is presented, saved or executed.

The generator's scope closes after approval and before `--save` or execution. A
teardown failure fails the command and neither later phase happens.

## Repair

Each first draft, and each answer to a human `revise`, starts its own repair
budget of three. A candidate with repairable failures earns one repair turn
carrying a fixed instruction to return a complete replacement root, core's
complete versioned `DocumentValidation` value serialized as JSON when core
produced one, and the prompt-owned generated-binding diagnostic when that is the
failure. Nothing renders a diagnostic into prose and nothing parses one back
out.

The whole candidate is replaced by the new close value and validated again. The
base candidate is not repair turn one, so a candidate may be followed by at most
three replacements. A fourth invalid candidate is **exhausted** and goes to human
review carrying its diagnostics.

An opaque `not-statically-checkable` invocation is not a diagnostic and does not
make a document invalid. It may be approved and executed under the ordinary
permission model.

No fence is stripped and no Markdown-looking substring is extracted. The exact
close value is always the candidate: if a fenced reply is otherwise a valid
document, that exact document is shown and the person decides.

## Review

The command installs the CLI's WebForm elicitation provider around authorship —
outside any document and any journal — and asks through core's `elicit()`
operation.

A valid candidate is offered a draft-07 object schema with a required `decision`
of `approve`, `revise` or `abort`, an optional string `feedback`,
`additionalProperties: false`, and an `if`/`then` rule requiring `feedback` with
`minLength: 1` when the decision is `revise`. An exhausted invalid candidate is
offered the same schema allowing only `revise` and `abort`: there is no approve
value to reject later.

The message presents the exact candidate in a Markdown source fence whose
delimiter is at least three backticks and longer than every backtick run in the
candidate, so arbitrary source cannot close it. An invalid candidate's source is
followed by a `json` fence holding its complete structured diagnostics. Schemas,
session identifiers and repair budgets are machinery and stay out of what the
person reads.

- `approve` returns the candidate and the props resolved for that candidate.
- `revise` sends the feedback to the same generator session, asks for a complete
  replacement, resets the automatic repair budget to three, and reviews again.
  Human revision rounds have no numeric bound.
- `abort` fails the command and performs no save and no execution.

The contract is non-empty feedback, not non-whitespace feedback. A provider
failure, or an answer the schema rejects, fails the command the way an abort
does.

## Execution

After approval and successful generator teardown, `--save` writes, and then the
approved source executes as `retainedSource("<prompt>", source)` through the
same document runner `xmd run -e` uses, with the props resolved under that exact
source and the same includes, output, journal, secret detection, Agent,
permission and timeout configuration. No temporary Markdown file is created.

The `<prompt>` identity affects positions and diagnostics only. The contextual
working directory still resolves relative filesystem operations, repository
components and includes.

The executed program receives a fresh ordinary document Agent provider. It
inherits neither the generator session nor its system prompt.

`--journal` is created when execution starts, and only then. Generation,
repairs, review and abort never enter it. Rendered output, a value root's JSON
result, runtime failure reporting and exit codes are byte-for-byte ordinary
`xmd run` behavior. A runtime failure does not return the command to generation
or review; `--save` has already completed, and the source is there to hand-edit.

## Timeouts

`--timeout` bounds the whole command: preparation, catalog inspection,
generation, every repair, human review, generator teardown, the save and the
execution. Expiry is Effection cancellation, so structured teardown completes
before the failure is reported.

`--timeout-exec` and `--timeout-fetch` configure the final document's effects
only, exactly as under `xmd run`. Nothing bounds a generation turn but the
command deadline.

## Failures

Every failure below exits non-zero, and each one stops the phases after it:

| Failure | Reaches |
| --- | --- |
| a malformed command line | nothing |
| incompatible permission flags or an unknown `--agent-provider` | nothing |
| a catalog an include makes unreadable | no provider |
| a turn that did not complete | no review, save or run |
| a terminal property-source failure | no repair, review, save or run |
| `abort`, or a review the provider could not answer | no save or run |
| generator teardown | no save or run |
| a `--save` path that exists, or a write that fails | no run |
| the document's own runtime failure | nothing after it; the save stands |

## Acceptance

Tier PR. Rows P1–P6 are proven in `packages/cli/tests/prompt-args.test.ts`,
P5–P12 in `packages/cli/tests/prompt.test.ts`, and P2, P4 and P13–P16 in
`packages/cli/tests/prompt-cli.test.ts`. The ACPX runtime is a scriptable fake,
the review provider is a scripted `Elicitation` handler, and the contextual
working directory is a temporary one: no live agent, browser or network appears
in this evidence. Every refusal is proven by the phase tripwires that stayed at
zero rather than by output nobody produced.

| # | Criterion | Required observation |
| --- | --- | --- |
| P1 | Request grammar | Missing, repeated, empty and whitespace-only requests fail; a valid request reaches the initial Agent turn byte for byte |
| P2 | Ordering and help | An individual option before the request fails with zero downstream effects; aggregate props before it work; help needs no request and has zero effects |
| P3 | Fixed option safety | Built-in flags after generated props are parsed for generation and execution; a later signature change cannot consume one as a value |
| P4 | Scalar, boolean and aggregate props | Candidate-declared scalar and bare boolean CLI options plus aggregate CLI/environment JSON resolve with ordinary precedence and reach validation and execution |
| P5 | Candidate/source classification | An invalid declaration and a generated binding collision receive repair turns; an undeclared supplied option, malformed caller JSON and an invalid caller value terminate with no repair or review |
| P6 | Revision signature | Removing an option, changing boolean/scalar arity, changing scalar/array accumulation or rejecting the original value fails before extraction and presentation; unchanged signatures re-resolve from unchanged sources |
| P7 | Catalog and system layer | One structured run-profile catalog, including its origin-only TypeScript truth, becomes the fresh session's system prompt; no subprocess and no duplicate catalog exists |
| P8 | Fresh conversation | Initial, repair and human revision turns use one exact session object; a second invocation has a different placement; no backend is contacted before the first subscribed turn |
| P9 | Generation terminal | Only a completed terminal yields a candidate; a failed turn discards its partial text and causes no review, save or execution |
| P10 | Repair budget | The base candidate plus exactly three repairs are possible; the last invalid candidate is shown with complete diagnostics and cannot be approved |
| P11 | Human review | Valid source offers approve/revise/abort; invalid source offers revise/abort; revise requires non-empty feedback, continues the session and resets the repair budget |
| P12 | Exact source | Fences inside a candidate cannot close the review fence; approval, save and execution receive the Agent close value byte for byte; no fence stripping occurs |
| P13 | Abort and journal boundary | Abort, generation failure, a terminal props failure and an exhausted-invalid abort are non-zero with no save, journal or execution; an approval's journal contains only final document events |
| P14 | Save | Approved bytes are exclusively created before execution; an existing path is unchanged and prevents execution; no save flag creates no generated file |
| P15 | Ordinary execution | Approved source reports `<prompt>`, resolves the contextual cwd and includes normally, receives approved-candidate props and the shared Agent flags, and preserves run output, result and runtime-failure behavior |
| P16 | Lifetime | The whole-command deadline cancels every phase and awaits provider teardown; generator teardown failure prevents save and execution; exec and fetch timeouts remain document-only |
