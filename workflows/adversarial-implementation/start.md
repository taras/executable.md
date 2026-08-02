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
Its component markup is the intended executable form. In this file, everything
inside `<Worktree>` uses shipped syntax; the three wrappers around it —
`<Workflow>`, `<Sandbox>`, and `<Worktree>` — are workflow-owned capabilities
that do not exist yet.

Each stage component is a text component: it declares no `returns`, so its
`<Output>` region is its return value and the caller's `as` binds that rendered
text. `<Glob>` declares `returns` and binds a `string[]` by reference instead.
The [executable MDX specification](../../specs/executable-mdx-spec.md) is the
authority for both. `<Workflow>` will create an internal run, persist those
captured results, and restore them when a later manual stage resumes; today
each stage's values live only in the executing process. Generated handoffs are
prompt content, not files that an agent must choose to read. Root `props`
supplies `request`, `base`, `planner`, and `implementor` (#179).

## Complete flow

<Workflow base={props.base} historyRef="refs/xmd/runs">
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
        planner={props.planner}
        as="handoff"
      >
        {props.request}
      </Discovery>
      <UserCheckpoint
        purpose="validate the planner handoff"
        agent={props.planner}
        as="handoffCheckpoint"
      >
        {handoff}
      </UserCheckpoint>
      <Planning handoff={handoff}
        handoffCheckpoint={handoffCheckpoint}
        instructions={instructions}
        planner={props.planner}
        implementor={props.implementor}
        as="plan" />
      <UserCheckpoint
        purpose="authorize implementation"
        agent={props.planner}
        as="authorization"
      >
        {plan}
      </UserCheckpoint>
      <Implementation plan={plan}
        authorization={authorization}
        instructions={instructions}
        planner={props.planner}
        implementor={props.implementor}
        as="implementationResult" />
      <UserCheckpoint
        purpose="accept the completed change"
        agent={props.planner}
        as="acceptance"
      >
        {implementationResult}
      </UserCheckpoint>
      <Output>{acceptance}</Output>
    </Worktree>
  </Sandbox>
</Workflow>

`Workflow` will resolve `props.base` to a source revision before creating the
worktree. Its internal run keeps discovery through implementation on that
pinned filesystem even if the branch moves while execution is in progress.

## What runs today

`InstructionFiles`, `Discovery`, `UserCheckpoint`, and `Planning` are written
entirely in shipped syntax: `<Glob>`, `<File>`, `<Parse>`, `<SafeParse>`,
`<Elicit>`, `<If>`/`<Else>`, `<Loop>`/`<Break>`, `<Each>`, `<Capture>`,
`<Output>`, and the `<Agent>`, `<Session>`, and `<Prompt>` agent components. A
caller that already knows an answer wraps a checkpoint in an `<Answers>` region
instead of reaching a person.

`<Workflow>`, `<Sandbox>`, `<Worktree>`, `<Stage>`, `<Commit>`,
`<PullRequest>`, and `<Issue>` are not implemented, and neither is sidecar run
history nor cross-process stage resumption. `Implementation` therefore does not
run yet — its agent, parsing, and control flow are shipped, but its loop
contains the three Git and GitHub effects. Until those exist, the flow above
runs in one process and one existing working directory, and its durable effects
remain explicit user-run steps between manual stages.

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
| `acceptance`           | acceptance checkpoint      | workflow output, automatic history snapshot         |

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
