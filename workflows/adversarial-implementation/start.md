---
required: [request, repository]

props:
  request: { type: string }
  repository: { type: string }
  base: { type: string, default: main }
  branch: { type: string, default: agent/adversarial-implementation }
  planner: { type: string, default: codex }
  implementor: { type: string, default: claude }

workflow:
  components:
    InstructionFiles: ./InstructionFiles.md
    Discovery: ./Discovery.md
    UserCheckpoint: ./UserCheckpoint.md
    Planning: ./Planning.md
    Implementation: ./Implementation.md
---

# Adversarial Implementation Workflow

- **Status:** Living end-goal target
- **Command:** `xmd workflow start` (#366, shipped)

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

<Output>

<Repository name="project" url={props.repository} base={props.base}>
  <Worktree
    name="implementation"
    branch={props.branch}
    as="worktree"
  />
  <Dir path={worktree}>
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
              # Awaiting direction: the pull-request review never passed

              The user kept approving and the verdict never passed, so the
              change was never offered for acceptance. This is not a rejection
              and not an acceptance: the workflow is asking what to do next.

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
            # Awaiting direction: the plan review never passed

            The user kept approving and the verdict never passed, so
            authorization was never requested. This is not a rejection and not
            an approval: the workflow is asking what to do next.

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
  </Dir>
</Repository>

</Output>

## The Workspace is composed, not implied

`xmd workflow start` gives the workflow run one retained root Workspace. That
Workspace is neither a repository nor a checkout: what it holds is named
composition this document writes (#293).

`<Repository name="project">` authorizes `props.repository`, resolves
`props.base` once, pins the resulting commit, and creates the named primary
checkout. The name is stable component identity inside the Workspace, not a
lookup key into hidden configuration — the locator and the base are ordinary
validated root props, and a value like `"project"` resolves through no alias
registry. A self-closing `<Worktree name="implementation" … as="worktree" />`
adds a linked checkout on its own branch — creating it, or restoring the
retained one — so discovery, planning, implementation, and review share one
filesystem without disturbing the primary checkout, and binds that checkout's
Workspace-relative path.

Binding the path and running the stages under it are two steps here, and that
is the settled composition rather than an accident of style. A generic component
invocation written with `as=` is an ordinary private capture: it binds its result
and contributes nothing to the document at the call site. `<Repository>` and
`<Worktree>` get no exception to that, so a lexical
`<Worktree … as="worktree">…</Worktree>` could not mean "bind the path *and*
emit these children" — it would capture the whole flow, and the root's `<Output>`
would emit no report. A workflow that needs both composes the two existing forms
instead: the self-closing `<Worktree>` binds the path and establishes no cwd for
what follows it, and the lexical `<Dir path={worktree}>` beneath it establishes
that bound path as cwd for the complete stage flow, renders its children
normally, and restores the enclosing `<Repository>` cwd when it closes. `<Dir>`
sits inside `<Repository>`, so the Repository context that `<Worktree>` and the
later Git and forge composition need is present throughout both.

Nothing here is implicit. A second repository is a second `<Repository>` with
its own name, locator, and base, and no transaction spans the two (#293, and
§7.6 of the workflow Workspace specification). The pinned commit is what keeps
every stage on one source revision even if the base branch moves.

`<Dir>` is lexical cwd and nothing else. It registers nothing with an Agent:
making a directory readable is `<Agent.AddDir>`, written inside the `<Agent>`
that reads it, which is why each stage that runs an Agent still takes the
`worktree` binding as a prop rather than inheriting access from cwd. The two are
separate operations on purpose (#302).

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
passes the gate, so neither starts implementation or any later durable effect.

Those two are reported differently, because they are different requests. A
decline is finished: the user said no. Exhaustion is not — it is the workflow
asking the user what to do after five rounds failed to converge (#290, settled).
Under a composed workflow that request is where the run suspends durably for
user direction (#367, shipped) and gives its executor lock back; here it is
where the report asks. Neither exhaustion nor an unchanged verdict is ever read
as approval, and nothing resumes the run on its own.

A checkpoint that found no material choice still produces an explicit
`proceed: true` with its reason, so nothing advances because a decision was
absent.

The root's direct top-level `<Output>` reports which gate the run reached,
telling a decline apart from a review that never passed. A rejected acceptance
finishes as rejected — the flow does not fall into the accepted branch — and a
document execution stopped earlier renders the artifact it stopped on rather than
a value it never produced.

That declaration wraps the whole flow — `<Repository>`, the self-closing
`<Worktree>`, and the `<Dir>` the stages run in — because `<Output>` is only ever
a direct top-level child of the document that declares it, and an invocation
cannot introduce or redefine one for its caller. Wrapping the flow selects no
more than the report: every stage invocation inside binds with `as`, and a
binding keeps a private buffer, so it contributes nothing to the document.
`<Dir>` is the one enclosing element that does render its children, which is how
the final-gate `<If>` tree — the only thing here that renders at all — reaches
this root's output.

## Waiting for the user is a suspension, not a stop

A checkpoint that reaches a person is a durable wait, and a durable wait is not
a failure. Under `xmd workflow` the elicitation is to record its pending request
and the Workspace frontier, release the executor, and return control with a run
ID and a stop reason on standard error, so that the process, the Workspace
attachment, and the Agent processes need not stay alive.
`xmd workflow resume <run-id>` already continues the same workflow run once the
answer is available: completed durable effects restore from the journal,
ephemeral attachments rebuild, and partial replay continues at the retained
frontier.

That is what the earlier drafts of this document were reaching for with a
`<Stage>` boundary. The construct was rejected — the root document is the
workflow — and the requirement it stood for now belongs to the retained
lifecycle, and most of that is now here. Foreground `start` and `resume` are
shipped (#366), and a resume restores completed durable effects from the journal,
rebuilds ephemeral attachments, and continues the partial remainder at the
retained frontier. Reading a run back is shipped too: `xmd workflow status`,
`list`, and `history` report immutable lifecycle snapshots without advancing
anything (#460). So is the authority underneath: the executor lock owns
lifecycle transitions, so single-executor ownership, atomic begin and settle,
cancellation and deletion are shipped (#466). What is still missing is the wait
itself — durable suspension, and releasing the executor at a checkpoint, remain
#367. So a question asked today is answered inside the document execution that
asked it. Gating is expressed by nesting, which
prevents the remaining stages from running but does not stop the document
execution: it still reaches the final-gate report inside the root's `<Output>`
and completes.

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

This document is a text root, and a text root is fail-capable. The `output` error
mode is installed for its whole body — by every text root and by every
`<Output>` region alike — so an uncaught, undecided failure anywhere above is
this run's outcome, whether or not the document declares `<Output>` at all
(#453, shipped). The root's direct top-level `<Output>` selects which regions
render and buffers the emission; it decides nothing about whether a failure
counts, and a root that declared none would settle a failure on identical terms.
Printing and carrying on is asked for with `<PrintErrors>`, and this workflow
writes none.

Within that, how a component fails depends on which kind it is.

A **text component** — `InstructionFiles` and `Discovery` — is split by its
`<Output>` boundary:

- Everything **outside** `<Output>` is documentation and runs under the `throw`
  error mode. The first error stops the body and fails the document execution,
  and no `<PrintErrors>` region can print it instead.
- The **`<Output>` region** runs under the `output` error mode: an *undecided*
  error there fails the document execution too, though a `<PrintErrors>` region
  may print it instead. Either way the region keeps what it had already rendered
  — that partial text reaches the output stream, and nothing after the failure
  does. Printing a decision a callee's `<Output>` region already made is the
  contract; the engine does not do it yet (#327), and nothing here needs it.

"Undecided" is the operative word, and `InstructionFiles` is where it shows.
Its `<File>` reads sit in its `<Output>` region, and `<File>` prints its own read
failures, so an unreadable instruction file is already decided as a
component-owned printed error and that region's mode never sees it. The stage
still cannot hand its caller a usable result: `as` refuses a body holding a
printed error, so `InstructionFiles ... as="instructions"` binds nothing and the
refusal is raised here, in this root's own body. Being fail-capable, this root
settles it — `Discovery` never starts, nothing after it starts, and the run ends
nonzero with whatever was already rendered preserved.

A **value component** — `UserCheckpoint`, `Planning`, `Implementation` — has no
such split. Declaring `returns` means it renders nothing, so `<Output>` inside
one is a structural error; its whole body runs fail-fast and a failure binds
nothing at all. There is no partially validated return for a caller to gate on.

Invoking a component never moves that line. Content this document projects into
one keeps the mode of the region it is written in here: a component's own
`printErrors(fn)` declaration decides the component's work, not its caller's
text, so a projected failure the component does not recover from passes outward
wherever this site does not print, and whatever the projection rendered first
reaches this document's output rather than the component's (#446). None of the
stages above projects content — each takes its material as a declared prop — so
the rule shows up here as an assurance rather than a mechanism: no stage
invocation can turn a failure this document would fail on into one it prints.

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

**Composed by the workflow host.** `<Repository>`, `<Worktree>` and `<Dir>` are
built and registered by `@executablemd/workflow/composition` (#293, shipped),
which is what makes the composition above executable under a workflow run.
Registration is scope-local and the workflow host is what installs it, so plain
`xmd run` — which composes no workflow — reports all three unresolved. That is
where a document ran, not whether a component exists.

**Not expressible.** Every component that performs a durable environmental
effect. These five names resolve to nothing under either host:

| Written above | Supplied by | Status |
| --- | --- | --- |
| `<Agent.AddDir>` and the read-only Agent ceiling | #302 | unbuilt |
| `<Expand>` for Agent-generated XMD | #369 | unbuilt; public name open |
| `<Git.Push>` | #370 | unbuilt |
| `<PullRequest>` | #295 | unbuilt |
| `<Issue>` | #296 | unbuilt |

`<Git.Switch>`, `<Git.Add>` and staged-only `<Git.Commit>` have left that list:
they are built as Workspace-local durable effects (#294, shipped), and the
shared Git-host reconciliation the remote effects will need is shipped too
(#297). What is still missing above them is the three components that reach a
remote or a forge, the Agent ceiling, and the constrained evaluator.

So what remains non-executable is the implementation stage's remote and forge
effects; the named checkouts the Workspace is composed from, and the local Git
effects inside them, are here. What can be exercised today is discovery through plan convergence and
the user gates around them, running in one document execution and one existing
working directory, with commits, pushes, pull requests, and issues performed as
explicit user-run steps between manual stages. Proving that shipped subset is
#290.

The command and the foundation underneath it are built.
`xmd workflow start [--id] [--props-*] <definition>` and
`xmd workflow resume <run-id>` create and continue a run on the Deno entrypoint
and the compiled binary ([#366](https://github.com/taras/executable.md/issues/366),
shipped): output streams in the foreground, run identity and status are reported
on standard error, the run gets one implicit retained root Workspace, `<File>`
effects are bound to its transaction, services are denied, and a resume replays
completed work and continues the partial remainder. Beneath that, retained
WorkflowRuns and filtered journals are stored and looked up by public run ID
([#291](https://github.com/taras/executable.md/issues/291), shipped), and one
Workspace mutation, its logical root, and its journal result publish in a single
transaction ([#365](https://github.com/taras/executable.md/issues/365), shipped).

The composition above is no longer what keeps *this* document from being started
that way: `<Repository>`, the self-closing `<Worktree>` and the lexical `<Dir>`
are registered by the workflow host (#293, shipped), so the run's Workspace does
get its checkout and the `<Glob>` above has a filesystem to search.

Reachability is settled, and the frontmatter above is how this document asks for
it. A run pins its definition to one committed Git object and still passes no
generic repository component search path — instead the root declares a closed
component bundle in its own frontmatter, and `xmd workflow start` and `xmd workflow resume` resolve exactly those
five names from the blobs that commit holds
([#493](https://github.com/taras/executable.md/pull/493), shipped, delivering
[#301](https://github.com/taras/executable.md/issues/301)'s component-bundle
slice).

What that buys is identity, not convenience. Each declared name normalizes to a
canonical repository-relative path and the blob's own object ID, and those
entries are part of workflow-definition identity and retained-history admission:
change what a stage says and it is a different definition, so a resume or a
replay reconstructs the component from its retained source rather than from
whatever a checkout holds now. A same-named file beside the definition answers
nothing, and an undeclared name resolves to nothing at all. Ordinary `xmd run`
resolution is unchanged — there the five resolve as ordinary repository
components on its search path, and `<Repository>`, `<Worktree>` and `<Dir>` do
*not* resolve, because plain `xmd run` composes no workflow.

What #301 still owes is the supervised composition itself — scheduling the loop
and continuing it unattended. The bundle makes the stage names reachable; it
does not make the workflow run.

## Rendered data flow

| Captured value         | Produced by                | Consumed by                                         |
| ---------------------- | -------------------------- | --------------------------------------------------- |
| `worktree`             | self-closing `Worktree` (Workspace-relative path) | `Dir`, which makes it cwd for the flow; and every stage that registers a directory with an Agent |
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
