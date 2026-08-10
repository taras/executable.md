---
required: [request, repository]

props:
  request: { type: string }
  repository: { type: string }
  base: { type: string, default: main }
  branch: { type: string, default: agent/adversarial-implementation }
  planner: { type: string, default: codex }
  implementor: { type: string, default: claude }
---

# Adversarial Implementation Workflow

- **Status:** Living end-goal target
- **Command:** `xmd workflow start` (#366), unbuilt

This entry document is the complete workflow map. The linked files define the
prompts, effects, and authority boundaries used by each stage. Its component
markup is the intended executable form.

The root document *is* the workflow. There is no `<Workflow>` wrapper and no
`<Stage>` construct: `xmd workflow start` selects the environment, and a durable
workflow continues across several document executions without subdividing the
document ([#298](https://github.com/taras/executable.md/issues/298), closed as
superseded). What the command supplies — one retained Workspace per workflow
run, restored durable effects, and a read-only Agent ceiling — is described by
the [workflow Workspace specification](../../specs/workflow-workspace-spec.md).
"What runs today" below says exactly which parts exist.

Components here split by what their caller needs from them. `InstructionFiles`
and `Discovery` are **text components**: they declare no `returns`, so an
`<Output>` region is the return value and `as` binds that rendered text, which
is all a prompt downstream needs. `Planning`, `Implementation`,
`UserCheckpoint`, and `<Glob>` declare `returns` instead: they render nothing,
require `as`, and bind a JSON value validated against a clone of what they
produced. A stage that resolves a user decision inside itself has to be in the
second group — a controller cannot discard its control state as prose and still
let its caller gate on it. The [executable MDX
specification](../../specs/executable-mdx-spec.md) is the authority for both.

## Complete flow

<Repository name="project" url={props.repository} base={props.base}>
  <Worktree name="implementation" branch={props.branch} as="worktree">
    <Glob
      include={["AGENTS.md", "**/AGENTS.md"]}
      exclude={[".git/**", "**/node_modules/**"]}
      as="instructionPaths"
    />
    <InstructionFiles paths={instructionPaths} as="instructions" />
    <Discovery
      instructions={instructions}
      planner={props.planner}
      request={props.request}
      worktree={worktree}
      as="handoff"
    />
    <UserCheckpoint
      purpose="validate the planner handoff"
      agent={props.planner}
      material={handoff}
      as="handoffCheckpoint"
    />
    <If condition={handoffCheckpoint.proceed}>
      <Planning handoff={handoff}
        handoffCheckpoint={handoffCheckpoint}
        instructions={instructions}
        planner={props.planner}
        implementor={props.implementor}
        worktree={worktree}
        as="planning" />
      <If condition={planning.decision.proceed && planning.verdictPassed}>
        <Capture as="planReport">
          ## Implementation plan

          {planning.plan}

          ## Planner review

          {planning.review}
        </Capture>
        <UserCheckpoint
          purpose="authorize implementation"
          agent={props.planner}
          material={planReport}
          as="authorization"
        />
        <If condition={authorization.proceed}>
          <Implementation plan={planning.plan}
            authorization={authorization}
            instructions={instructions}
            planner={props.planner}
            implementor={props.implementor}
            worktree={worktree}
            as="implementation" />
          <If condition={implementation.decision.proceed && implementation.verdictPassed}>
            <UserCheckpoint
              purpose="accept the completed change"
              agent={props.planner}
              material={implementation.report}
              as="acceptance"
            />
          </If>
        </If>
      </If>
    </If>
    <Output>
      <If condition={handoffCheckpoint.proceed}>
        <If condition={planning.decision.proceed && planning.verdictPassed}>
          <If condition={authorization.proceed}>
            <If condition={implementation.decision.proceed && implementation.verdictPassed}>
              <If condition={acceptance.proceed}>
                # Accepted

                {acceptance.rationale}

                {implementation.report}
                <Else>
                # Rejected at acceptance

                The change was completed and reviewed, but the user did not
                accept it.

                {acceptance.rationale}

                {implementation.report}
                </Else>
              </If>
              <Else>
              <If condition={implementation.decision.proceed}>
              # Stopped: the pull-request review never passed

              The user kept approving and the verdict never passed, so the
              change was never offered for acceptance.

              {implementation.review}

              {implementation.report}
                <Else>
                # Stopped: the pull-request review was declined

                {implementation.decision.rationale}

                {implementation.report}
                </Else>
              </If>
              </Else>
            </If>
            <Else>
            # Stopped: implementation was not authorized

            {authorization.rationale}

            {planning.plan}
            </Else>
          </If>
          <Else>
            <If condition={planning.decision.proceed}>
            # Stopped: the plan review never passed

            The user kept approving and the verdict never passed, so
            authorization was never requested.

            {planning.review}

            {planning.plan}
              <Else>
              # Stopped: the plan review was declined

              {planning.decision.rationale}

              {planning.plan}
              </Else>
            </If>
          </Else>
        </If>
        <Else>
        # Stopped: the handoff was not validated

        {handoffCheckpoint.rationale}

        {handoff}
        </Else>
      </If>
    </Output>
  </Worktree>
</Repository>

## The Workspace is composed, not implied

`xmd workflow start` gives the workflow run one retained root Workspace. That
Workspace is neither a repository nor a checkout: what it holds is named
composition this document writes (#293).

`<Repository name="project">` authorizes `props.repository`, resolves
`props.base` once, pins the resulting commit, and creates the named primary
checkout. The name is stable component identity inside the Workspace, not a
lookup key into hidden configuration — the locator and the base are ordinary
validated root props, and a value like `"project"` resolves through no alias
registry. `<Worktree name="implementation">` adds a linked checkout on its own
branch, so discovery, planning, implementation, and review share one filesystem
without disturbing the primary checkout. Both install contextual cwd while they
render their children, and `as` binds the Workspace-relative path.

Nothing here is implicit. A second repository is a second `<Repository>` with
its own name, locator, and base, and no transaction spans the two (#293, and
§7.6 of the workflow Workspace specification). The pinned commit is what keeps
every stage on one source revision even if the base branch moves.

`<Dir>` is lexical cwd and nothing else. Making a directory readable by an Agent
is `<Agent.AddDir>`, written inside the `<Agent>` that reads it — which is why
each stage that runs an Agent takes the `worktree` binding as a prop. The two
are separate operations on purpose (#302).

## Agents inspect; XMD mutates

Under `xmd workflow` an Agent is read-only, and the host enforces that ceiling
in its permission bridge, its provider-native sandbox, and the filesystem view
it presents. A document cannot raise it, so there is no `<Sandbox>` component to
write: the command selects the environment and the ceiling comes with it (#302).

An implementor that cannot write files proposes changes instead. It returns an
XMD fragment, and a constrained evaluator preflights the whole fragment and
expands only pinned, explicitly allowed component identities (#369). Every file
the workflow writes is therefore an ordinary durable XMD effect with its own
expansion identity, journal result, and Workspace transaction — not a side
effect of an agent process. `Implementation` is where that happens.

## User authority is a gate, not a report

Every material transition is gated on a decision, and a decision never crosses a
component boundary as prose.

Two of the gates read a checkpoint this document invoked directly:
`handoffCheckpoint.proceed` before `Planning`, and `authorization.proceed`
before `Implementation`. The other two read a decision a stage resolved
*internally* and returned, together with that stage's verdict:

```
planning.decision.proceed && planning.verdictPassed
implementation.decision.proceed && implementation.verdictPassed
```

A plan that was approved but never passed review cannot reach authorization, and
one that passed review but was declined cannot either.

That second pair is what keeps authority from leaking across a boundary. A stage
that asks the user a question and then returns only a report leaves its caller
guessing; the caller would ask the next question anyway and could accept a change
whose review the user rejected. Returning the decision itself makes it the
caller's gate.

The gate is computed here rather than returned by the stage, and that is
deliberate. A returned `authorized` field would be a second copy of the same
answer, and no return schema can require the copy to agree with its sources — a
record pairing a declining decision with an approving flag would validate. One
authoritative pair, read where it is used.

The same pair distinguishes the failure modes without a separate label. After a
loop, `decision.proceed` false means the user declined; `decision.proceed` true
with `verdictPassed` false means the loop reached `max` still failing. Neither
passes the gate. What an exhausted loop *should* do remains an unresolved
product decision under #290 — refusing to advance is not an answer to it.

A checkpoint that found no material choice still produces an explicit
`proceed: true` with its reason, so nothing advances because a decision was
absent.

`<Output>` reports which gate the run reached, telling a decline apart from a
review that never passed. A rejected acceptance finishes as rejected — the flow
does not fall into the accepted branch — and a document execution stopped
earlier renders the artifact it stopped on rather than a value it never
produced.

## Waiting for the user is a suspension, not a stop

A checkpoint that reaches a person is a durable wait, and a durable wait is not
a failure. Under `xmd workflow` the elicitation records its pending request and
the Workspace frontier, releases the executor, and returns control with a run ID
and a stop reason on standard error. The process, the Workspace attachment, and
the Agent processes need not stay alive. `xmd workflow resume <run-id>`
continues the same workflow run once the answer is available: completed durable
effects restore from the journal, ephemeral attachments rebuild, and partial
replay continues at the retained frontier.

That is what the earlier drafts of this document were reaching for with a
`<Stage>` boundary. The construct was rejected — the root document is the
workflow — and the requirement it stood for now belongs to the retained
lifecycle: durable suspension and foreground `start`/`resume` are #366, and
status, history, cancellation, and deletion are #367. Neither is built. Until
they are, gating is expressed by nesting, which prevents the remaining stages
from running but does not stop the document execution: it still expands to
`<Output>` and completes.

## How props are read

Root and component props are namespaced under `props`, in expression props and
in text alike: `planner={props.planner}` selects the agent, and
`{props.instructions}` interpolates it inside a prompt body. Declaring a prop
creates no bare binding, so `{planner}` stays verbatim
([#305](https://github.com/taras/executable.md/issues/305), shipped).

Authored bindings are the other half and stay bare. `as="worktree"` on
`<Worktree>` creates the binding `worktree`, and `worktree={worktree}` passes it
down. Bare `{name}` resolves an authored eval, capture, loop, or return binding;
dotted `{props.name}` traverses the validated props namespace.

## Error modes in a stage

How a component fails depends on which kind it is.

A **text component** — `InstructionFiles` and `Discovery` — is split by its
`<Output>` boundary:

- Everything **outside** `<Output>` is documentation and runs under the `throw`
  error mode. The first error stops the body and fails the document execution,
  and no `<PrintErrors>` region can print it instead.
- The **`<Output>` region** runs under the `output` error mode: an *undecided*
  error there fails the document execution too, though a `<PrintErrors>` region
  may print it instead. Either way the region keeps what it had already rendered
  — that partial text reaches the output stream, and nothing after the failure
  does. Printing an `output` decision is the contract; the engine does not do it
  yet (#327).

"Undecided" is the operative word. `InstructionFiles` puts its `<File>` reads in
its `<Output>` region, and `<File>` prints its own failures, so an unreadable
instruction file is already decided as a printed error and the region's mode
never sees it. Execution continues; what stops the caller is that `as` refuses a
body holding a printed error, so `instructions` stays unbound.

A **value component** — `UserCheckpoint`, `Planning`, `Implementation` — has no
such split. Declaring `returns` means it renders nothing, so `<Output>` inside
one is a structural error; its whole body runs fail-fast and a failure binds
nothing at all. There is no partially validated return for a caller to gate on.

By one route or another a caller receives a complete result or nothing —
never a half-record. The `throwOnError` on each `<Prompt>` is load-bearing for
the same reason: a failed prompt without it records its failure and returns its
text, raising nothing for the error mode to decide.

## What runs today

**Expressible now.** The document logic in
[`InstructionFiles`](./InstructionFiles.md), [`Discovery`](./Discovery.md),
[`UserCheckpoint`](./UserCheckpoint.md), and [`Planning`](./Planning.md) is
written entirely in shipped syntax: `<Glob>`, `<File>`, `<Parse>`,
`<SafeParse>`, `<Elicit>`, `<If>`/`<Else>`, `<Loop>`/`<Break>`, `<Each>`,
`<Capture>`, `<Output>`, `<Return>`, and the `<Agent>`, `<Session>`, and
`<Prompt>` agent components. A caller that already knows an answer wraps a
checkpoint in an `<Answers>` region instead of reaching a person.
`InstructionFiles` and `UserCheckpoint` run as written; `Discovery` and
`Planning` each name `<Agent.AddDir>`, which does not exist, so their bodies run
only once that registration is supplied or removed.

**Not expressible.** Everything that composes the Workspace or performs a
durable environmental effect:

| Written above | Supplied by | Status |
| --- | --- | --- |
| `xmd workflow start` / `resume` | #366 | unbuilt |
| `<Repository>` / `<Worktree>` | #293 | unbuilt |
| `<Agent.AddDir>` and the read-only Agent ceiling | #302 | unbuilt |
| `<Expand>` for Agent-generated XMD | #369 | unbuilt; public name open |
| `<Git.Add>` / `<Git.Commit>` | #294 | unbuilt |
| `<Git.Push>` | #370 | unbuilt |
| `<PullRequest>` | #295 | unbuilt |
| `<Issue>` | #296 | unbuilt |

So the complete flow is non-executable at two levels: the workflow spine that
selects the retained environment and composes named checkouts, and the
implementation stage's durable Git and forge effects. What can be exercised
today is discovery through plan convergence and the user gates around them,
running in one document execution and one existing working directory, with
commits, pushes, pull requests, and issues performed as explicit user-run steps
between manual stages. Proving that shipped subset is #290.

The foundation underneath is built. Retained WorkflowRuns and filtered journals
are stored and looked up by public run ID
([#291](https://github.com/taras/executable.md/issues/291), closed), and one
Workspace mutation, its logical root, and its journal result publish in a single
transaction ([#365](https://github.com/taras/executable.md/issues/365), closed).
What is missing above them is public reachability, not durability.

## Rendered data flow

| Captured value         | Produced by                | Consumed by                                         |
| ---------------------- | -------------------------- | --------------------------------------------------- |
| `worktree`             | `Worktree` (Workspace-relative path) | every stage that registers a directory with an Agent |
| `instructionPaths`     | `Glob` (`string[]`)         | `InstructionFiles`                                  |
| `instructions`         | `InstructionFiles` (text)  | every agent prompt                                  |
| `handoff`              | `Discovery` (text)          | handoff `UserCheckpoint`, `Planning`                |
| `handoffCheckpoint`    | handoff `UserCheckpoint` (decision) | the `Planning` gate, and `Planning`         |
| `planning`             | `Planning` (structured)     | the authorization gate (`.decision.proceed`, `.verdictPassed`), the authorization checkpoint (`.plan`), and `Implementation` (`.plan`) |
| `authorization`        | authorization checkpoint (decision) | the `Implementation` gate, and `Implementation` |
| `implementation`       | `Implementation` (structured) | the acceptance gate (`.decision.proceed`, `.verdictPassed`), the acceptance checkpoint (`.report`) |
| `acceptance`           | acceptance checkpoint (decision) | workflow output, terminal record               |

`instructions` and `handoff` are rendered text. `planning` and `implementation`
are structured stage results: the plan or report, the parsed verdict's fields,
and the complete `UserDecision` that stage resolved — the sources a gate reads,
with nothing derived from them. The three checkpoints bind decisions. This
document renders the human-readable reports from those returned fields rather
than receiving them pre-rendered.

Neither stage returns the pull-request handle. `Implementation` creates the pull
request, reviews it, and keeps the handle internal, because `start.md` gates on
the verdict and the decision rather than on forge state, and the filtered
journal records the effect independently (#291). A return field typed `string`
would let a conforming `<PullRequest>` perform its external effect and only then
fail the stage's return validation.

## Details

- [Runtime and isolation](./runtime.md)
- [Instruction materialization](./InstructionFiles.md)
- [Discovery](./Discovery.md)
- [User checkpoint](./UserCheckpoint.md)
- [Planning](./Planning.md)
- [Implementation](./Implementation.md)
- [Retained run state](./artifacts.md)
- [Primitive inventory](./primitives.md)

The governing role, review, pull-request, and deferral contracts remain in the
[workflow specification](../../specs/adversarial-implementation-workflow.md).
