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

Each stage component is a text component: it declares no `returns`, so its
`<Output>` region is its return value and the caller's `as` binds that rendered
text. `<Glob>` is the exception: it declares `returns`, so it renders nothing,
requires `as`, and binds a `string[]` validated against a clone of what it
produced. The [executable MDX
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
        as="handoff"
      >
        {props.request}
      </Discovery>
      <UserCheckpoint
        purpose="validate the planner handoff"
        agent={planner}
        as="handoffCheckpoint"
      >
        {handoff}
      </UserCheckpoint>
      <Planning handoff={handoff}
        handoffCheckpoint={handoffCheckpoint}
        instructions={instructions}
        planner={planner}
        implementor={implementor}
        as="plan" />
      <UserCheckpoint
        purpose="authorize implementation"
        agent={planner}
        as="authorization"
      >
        {plan}
      </UserCheckpoint>
      <Implementation plan={plan}
        authorization={authorization}
        instructions={instructions}
        planner={planner}
        implementor={implementor}
        as="implementationResult" />
      <UserCheckpoint
        purpose="accept the completed change"
        agent={planner}
        as="acceptance"
      >
        {implementationResult}
      </UserCheckpoint>
      <Output>{acceptance}</Output>
    </Worktree>
  </Sandbox>
</Workflow>

`Workflow` will resolve `base` to a pinned source revision before creating the
worktree. Its run identity keeps discovery through implementation on that
pinned filesystem even if the branch moves while execution is in progress.

## How props are read

Two spellings, and they are not interchangeable today:

- **Text and content** read the namespace: `{props.request}` above, and
  `{props.instructions}` inside every stage's prompt.
- **Expression props** read the **bare** binding: `planner={planner}`, not
  `planner={props.planner}`. A `props.` reference in an expression prop fails
  with `props is not defined`.

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
| `instructions`         | `InstructionFiles`         | every agent prompt                                  |
| `handoff`              | `Discovery`                 | handoff `UserCheckpoint`, `Planning`                |
| `handoffCheckpoint`    | handoff `UserCheckpoint`    | `Planning`                                          |
| `plan`                 | `Planning`                  | authorization `UserCheckpoint`, `Implementation` |
| `authorization`        | authorization checkpoint   | `Implementation`                                   |
| `implementationResult` | `Implementation`            | acceptance `UserCheckpoint`                         |
| `acceptance`           | acceptance checkpoint      | workflow output, terminal record                    |

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
