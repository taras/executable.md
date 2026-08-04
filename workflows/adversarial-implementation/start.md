---
required: [request]

props:
  request: { type: string }
  base: { type: string, default: main }
  planner: { type: string, default: codex }
  implementor: { type: string, default: claude }
---

# Adversarial Implementation Workflow

- **Status:** Living end-goal target
- **Execution:** Manual, one stage at a time

This entry document is the complete workflow map. The linked files define the
prompts, artifacts, permissions, and deterministic effects used by each stage.
Its component markup is the intended executable form. The three wrappers —
`<Workflow>`, `<Sandbox>`, and `<Worktree>` — are workflow-owned capabilities
that do not exist yet, and one of the stages they wrap is not expressible
either. "What runs today" below says exactly which.

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
`<Workflow>` will create a run identity, record those captured results as
artifact versions, and restore them when a later stage resumes (#289, #291);
today each stage's values live only in the executing process. Generated handoffs
are prompt content, not files that an agent must choose to read. Root `props`
supplies `request`, `base`, `planner`, and `implementor` (#179).

## Complete flow

<Workflow base={base} historyRef="refs/xmd/runs">
  <Sandbox policy="supervised-implementation">
    <Worktree>
      <Glob
        include={["AGENTS.md", "**/AGENTS.md"]}
        exclude={[".git/**", "**/node_modules/**"]}
        as="instructionPaths"
      />
      <InstructionFiles paths={instructionPaths} as="instructions" />
      <Discovery
        instructions={instructions}
        planner={planner}
        request={request}
        as="handoff"
      />
      <UserCheckpoint
        purpose="validate the planner handoff"
        agent={planner}
        material={handoff}
        as="handoffCheckpoint"
      />
      <If condition={handoffCheckpoint.proceed}>
        <Planning handoff={handoff}
          handoffCheckpoint={handoffCheckpoint}
          instructions={instructions}
          planner={planner}
          implementor={implementor}
          as="planning" />
        <If condition={planning.authorized}>
          <Capture as="planReport">
            ## Implementation plan

            {planning.plan}

            ## Planner review

            {planning.review}
          </Capture>
          <UserCheckpoint
            purpose="authorize implementation"
            agent={planner}
            material={planReport}
            as="authorization"
          />
          <If condition={authorization.proceed}>
            <Implementation plan={planning.plan}
              authorization={authorization}
              instructions={instructions}
              planner={planner}
              implementor={implementor}
              as="implementation" />
            <If condition={implementation.authorized}>
              <UserCheckpoint
                purpose="accept the completed change"
                agent={planner}
                material={implementation.report}
                as="acceptance"
              />
            </If>
          </If>
        </If>
      </If>
      <Output>
        <If condition={handoffCheckpoint.proceed}>
          <If condition={planning.authorized}>
            <If condition={authorization.proceed}>
              <If condition={implementation.authorized}>
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
                # Stopped in implementation: {implementation.terminal}

                The pull-request review ended `{implementation.terminal}`, so
                the change was never offered for acceptance.

                {implementation.decision.rationale}

                {implementation.report}
                </Else>
              </If>
              <Else>
              # Stopped: implementation was not authorized

              {authorization.rationale}

              {planning.plan}
              </Else>
            </If>
            <Else>
            # Stopped in planning: {planning.terminal}

            The plan review ended `{planning.terminal}`, so authorization was
            never requested.

            {planning.decision.rationale}

            {planning.plan}
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
  </Sandbox>
</Workflow>

`Workflow` will resolve `base` to a pinned source revision before creating the
worktree. Its run identity keeps discovery through implementation on that
pinned filesystem even if the branch moves while execution is in progress.

## User authority is a gate, not a report

Every material transition is gated on a decision, and a decision never crosses a
component boundary as prose.

Two of the gates read a checkpoint this document invoked directly:
`handoffCheckpoint.proceed` before `Planning`, and `authorization.proceed`
before `Implementation`. The other two read a decision a stage resolved
*internally* and returned: `planning.authorized` and
`implementation.authorized`. Each is `proceed && verdict.passed` — a plan that
was approved but never passed review cannot reach authorization, and one that
passed review but was declined cannot either.

That second pair is what keeps authority from leaking across a boundary. A stage
that asks the user a question and then returns only a report leaves its caller
guessing; the caller would ask the next question anyway and could accept a change
whose review the user rejected. Returning `authorized` and `terminal` makes the
internal decision the caller's gate.

An exhausted loop fails closed. `terminal` distinguishes `converged`, `declined`,
and `exhausted`, and `authorized` is false for the last two, so neither advances.
What an exhausted planning loop *should* do remains an unresolved product
decision under #290 — failing closed is not an answer to it.

A checkpoint that found no material choice still produces an explicit
`proceed: true` with its reason, so nothing advances because a decision was
absent.

`<Output>` reports which gate the run reached, naming the stage's `terminal`
where a stage stopped. A rejected acceptance finishes as rejected — the flow does
not fall into the accepted branch — and a run stopped earlier renders the
artifact it stopped on rather than a value it never produced.

**Missing: stopping at the boundary.** Nesting expresses the gate, and it is
what the language supports today, but it is not the same as *stopping*. The run
still expands to `<Output>` and completes; there is no clean halt at a stage
boundary that a later invocation resumes from, and no stop reason recorded for
one. That is `<Stage>` (#298) over `<Workflow>`'s run identity (#289). Until
they exist, a declined checkpoint means the remaining stages do not run and the
outcome says so — not that the process stopped where the user answered.

## How props are read

Two spellings, and they are not interchangeable today:

- **Text and content** read the namespace: `{props.instructions}` and
  `{props.material}` inside a stage's prompt body.
- **Expression props** read the **bare** binding: `planner={planner}` and
  `request={request}`, not `planner={props.planner}`. A `props.` reference in an
  expression prop fails with `props is not defined`.

Removing that asymmetry is [issue
#305](https://github.com/taras/executable.md/issues/305), whose acceptance
includes expression props reading `props.name`. Until it lands these documents
use the bare spelling in expression props, and #305 migrates them.

## Error modes in a stage

Every stage component is split by its `<Output>` boundary, and the two halves
fail differently:

- Everything **outside** `<Output>` is documentation and runs under the `throw`
  error mode. The first error stops the body and fails the run, and no
  `<PrintErrors>` region can print it instead — which is what makes each
  stage's final `<Parse>` a real gate rather than a formality.
- The **`<Output>` region** runs under the `output` error mode: an undecided
  error there fails the run too, though a `<PrintErrors>` region may print it
  instead. Either way the region keeps what it had already rendered — that
  partial text reaches the output stream, and nothing after the failure does.
  Printing an `output` decision is the contract; the engine does not do it yet
  (#327).

So a stage either returns a complete, schema-validated result or it fails. It
never returns a half-record. The `throwOnError` on each `<Prompt>` is
load-bearing for the same reason: a failed prompt without it records its
failure and returns its text, raising nothing for the error mode to decide.

## What runs today

**Expressible now.** Four of the five authored stages —
[`InstructionFiles`](./InstructionFiles.md), [`Discovery`](./Discovery.md),
[`UserCheckpoint`](./UserCheckpoint.md), and [`Planning`](./Planning.md) — are
written entirely in shipped syntax: `<Glob>`, `<File>`, `<Parse>`,
`<SafeParse>`, `<Elicit>`, `<If>`/`<Else>`, `<Loop>`/`<Break>`, `<Each>`,
`<Capture>`, `<Output>`, and the `<Agent>`, `<Session>`, and `<Prompt>` agent
components. A caller that already knows an answer wraps a checkpoint in an
`<Answers>` region instead of reaching a person.

**Not expressible.** [`Implementation`](./Implementation.md) is the fifth
stage and does not run. Its agent prompts, schema parsing, bounded repair
turns, and control flow are all shipped, but its loop body invokes `<Commit>`
(#294), `<PullRequest>` (#295), and `<Issue>` (#296), none of which exist.
Those three names resolve to nothing, so the stage cannot expand — the missing
capability is inside the stage, not only around it.

**Not expressible.** The three wrappers in the flow above — `<Workflow>`
(#289), `<Sandbox>` (#302), and `<Worktree>` (#293) — do not exist, and neither
does `<Stage>` (#298), the artifact ledger in sidecar Git history (#291), or
cross-process continuation (#298).

So the complete flow is non-executable at two levels: the workflow spine that
pins a source revision, owns a workspace, enforces capabilities, and persists
run state; and the implementation stage's durable Git and GitHub effects. What
can be exercised today is discovery through plan convergence and the user gates
around them, running in one process and one existing working directory, with
commits, pull requests, and issues performed as explicit user-run steps between
manual stages.

## Rendered data flow

| Captured value         | Produced by                | Consumed by                                         |
| ---------------------- | -------------------------- | --------------------------------------------------- |
| `instructionPaths`     | `Glob` (`string[]`)         | `InstructionFiles`                                  |
| `instructions`         | `InstructionFiles` (text)  | every agent prompt                                  |
| `handoff`              | `Discovery` (text)          | handoff `UserCheckpoint`, `Planning`                |
| `handoffCheckpoint`    | handoff `UserCheckpoint` (decision) | the `Planning` gate, and `Planning`         |
| `planning`             | `Planning` (structured)     | the authorization gate (`.authorized`), the authorization checkpoint (`.plan`, `.review`), and `Implementation` (`.plan`) |
| `authorization`        | authorization checkpoint (decision) | the `Implementation` gate, and `Implementation` |
| `implementation`       | `Implementation` (structured) | the acceptance gate (`.authorized`), the acceptance checkpoint (`.report`) |
| `acceptance`           | acceptance checkpoint (decision) | workflow output, terminal record               |

`instructions` and `handoff` are rendered text. `planning` and `implementation`
are structured stage results carrying `authorized` and `terminal` alongside the
plan or report, the parsed verdict's fields, and the complete `UserDecision`
that stage resolved. The three checkpoints bind decisions. This document renders
the human-readable reports from those returned fields rather than receiving them
pre-rendered.

## Details

- [Runtime and isolation](./runtime.md)
- [Instruction materialization](./InstructionFiles.md)
- [Discovery](./Discovery.md)
- [User checkpoint](./UserCheckpoint.md)
- [Planning](./Planning.md)
- [Implementation](./Implementation.md)
- [Artifacts and structured results](./artifacts.md)
- [Primitive inventory](./primitives.md)

The governing role, review, pull-request, and deferral contracts remain in the
[workflow specification](../../specs/adversarial-implementation-workflow.md).
