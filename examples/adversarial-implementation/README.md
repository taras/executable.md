# Adversarial implementation

Use this workflow when an API can make a large consumer migration predictable.
The Planner implements and tests the API before handing it over. The Implementor
then challenges that API with real consumers, finishes the migration and removes
the obsolete machinery.

```text
accepted outcome
      |
Planner / Opus: API code + representative consumers + focused tests
      |
verify committed examples
      |
Implementor / Sonnet: migrate remaining consumers and retire old code
      |                         |
      |                   concrete API conflict
      |                         |
      |                 same Planner repairs API
      |                         |
      +<---------------- same Implementor resumes
      |
selected independent reviews -> retirement check -> Sidekick running Codex
```

## Applies to

Ordinary XMD runs and REPL entry programs. Each work item has an isolated source
checkout, a fresh artifact directory outside that checkout, and distinct named
Planner, Implementor and Architect conversations. One role runs at a time.

These components are a repository example. Adding the example does not change a
running REPL, an existing role's model or the live workflow's include directory.

## Run a work item

Prepare this repository with `deno task setup`. Run from its root so the entry
can read the two role guides. Copy `task.example.json` to a local file, replace
its paths and request, and choose unused conversation names. The source checkout
is prepared separately using its own repository instructions. Its feedback
commits use its configured Git signing and verification.

```bash
deno task xmd run examples/adversarial-implementation/run.md \
  --props-task /absolute/path/to/task.json \
  --include examples/adversarial-implementation/components
```

The entry's `task` prop becomes `--props-task`. Inspect its complete CLI with:

```bash
deno task xmd run examples/adversarial-implementation/run.md --help
```

In a REPL, put the same component include directory on the session's include
path, read the role guides from this repository, and invoke `<Adversarial.Run>`
with the task and guide contents. Keep that execution's journal and original
session identities. Reopening a completed run is an observation; starting a
fresh ordinary run at the same artifact directory refuses before another role.
An interrupted ordinary command's diagnostic journal is not a continuation
checkpoint. Reconcile its saved calls and partial effects before another run.

The roles use the normal agent permission policy. Running this example invokes
paid native coding agents and permits the assigned implementation work. It does
not authorize a push, merge, issue edit or PR edit.

## Responsibilities and models

| Owner | Work | Model and effort |
| --- | --- | --- |
| Planner | Plan, implement the API, validate representative consumers, repair API conflicts | Claude `opus`, high |
| Implementor | Challenge the API, migrate consumers, delete obsolete machinery | Claude `sonnet`, high |
| Planner reviewer | Inspect the migration against the accepted outcome and evidence | Same Opus session, medium; high for a concrete recorded risk |
| Architect | Answer a concrete structural question or review structural impact | Codex `gpt-6.1-sol`, medium; high for a concrete recorded risk |
| Sidekick running Codex | Author and apply issue/PR titles and descriptions; own publication and delivery | Existing coordinating Sidekick |

Aliases select the provider's available Opus and Sonnet models. The two Claude
roles do not draft or edit issue/PR titles or descriptions. The phase runner
refuses editorial assignments; technical handoffs and API documentation remain
part of the roles' work.

Architect is conditional: reserving its conversation name starts no discovery
call. A Planner can return `needs_architect` with one structural question. An
implemented change's impact selects architecture review. Existing repository
rules still govern material product decisions and architectural choices.
When the API foundation has structural impact, Architect reviews that committed
foundation before migration starts. A non-passing verdict holds with its saved
request for the Sidekick to resolve; migration cannot hide the foundation's diff.

## The API handoff

The Planner returns a signed commit, an API guide, API-owned file paths and at
least two named behavioral examples. The guide describes purpose, the task the
API is optimized for, friction removed, necessary friction retained and expected
maintenance. Representative consumers exercise the real supported path; a
typecheck or a mock-only sketch is insufficient.

The workflow verifies actual clean HEAD, ancestry and signature, confirms the
initial foundation changes an API-owned path, reads the committed consumer
files, and runs each example command. It saves the command's full result before
deciding whether migration can start. A failed example holds with its first
output and starts no migration role. The source and HEAD must remain unchanged
by validation.

`api.migration` names the remaining work, literal repository-relative paths to
retire and observable acceptance. Completion checks those paths are absent,
including symlinks. Passing reviews do not waive this outcome.

This workflow executes trusted role-supplied commands in the selected checkout.
It is not a sandbox for untrusted commands. Shape validation and green tests do
not prove that examples cover the right behavior; the roles and independent
review remain responsible for that judgment.

## Challenge, repair and review

The Implementor keeps passing work in a focused commit and saves a failed API
witness outside the source checkout. It returns `needs_discovery` with
`apiConflict: { expected, observed, reproducer, artifact }`, failed command
evidence and a handoff to Planner. The workflow routes that exception back to
the original Planner and resumes the original Implementor after validation.
Other discovery conflicts retain their existing Architect/decision hold.

An ordinary migration cannot complete after changing an API-owned file. That
change goes through Planner's validated foundation. A dirty partial checkout,
provider failure, malformed response, unanswered decision or exhausted bound
holds with saved evidence. It does not trigger an uncertain prompt retry.

`maxApiRepairs` bounds consumer-driven API repairs; `maxCorrections` bounds the
existing implementation-review corrections. Both default to three and accept
zero through ten. Repeated redesign is evidence that the split is not paying
for itself: inspect the saved consumer conflicts before extending either bound.

The imported feedback loop retains impact-selected reviews, bounded response
format repair and exact-patch conditional corrections. A known exact correction
can close after its authorized patch and checks match; ordinary corrections go
only to affected responsibilities. `feedback_ready` is neither CI completion
nor permission to merge. The Sidekick running Codex handles metadata and the
repository's normal delivery gates afterwards.

## Test without paid agents

```bash
deno task xmd test examples/adversarial-implementation/tests/Workflow.test.md \
  --include examples/adversarial-implementation/tests/components \
  --include examples/adversarial-implementation/components
```

Only the role boundaries are replaced. These journeys use real signed scratch
Git repositories, committed shell consumers, focused command failures, the
production Markdown routing and the existing feedback verifier. The fake role
boundaries launch no model and publish nothing. Put them first only for tests.
The runtime test launcher runs the Markdown suite under each runtime and uses
the Deno CLI for its nested Git workflow, where the ordinary Git provider is
installed.

## Provenance and adoption

`components/Phase`, `Ticket`, `Discovery.Schema`, `ReviewPolicy`,
`ExactCorrection` and `Guide.ExactCorrection` package the existing local feedback
workflow. This version adds the validated foundation, Opus/Sonnet role profiles,
API-conflict route, retirement check and Codex editorial ownership. Delivery
automation, task-specific attachment/routing programs and historical trial
artifacts are outside this example.

Adopt the version at a completed checkpoint. Keep the old execution's journal
and evidence, use the new example's include directory for the new work item,
and refresh its accepted inputs against the actual source revision. Do not
replace a running role's conversation or reinterpret an old result as this
version's API handoff.

## Common mistake

Do not accept shorter selected examples while the promised fixture or legacy
adapter remains. Do not ask Sonnet to validate a paper API by designing it from
scratch. The first handoff contains working consumer code and passing evidence;
the final handoff contains the finished retirement and review evidence.

## Read next

Read [Planner](../../.agents/planner.md) and
[Implementor](../../.agents/implementor.md) for role assignments.
Read `<Adversarial.Schema />` for the API handoff shape and `<ReviewPolicy />`
for impact-based review selection.
