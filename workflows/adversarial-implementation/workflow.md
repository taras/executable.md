---
inputs:
  type: object
  properties:
    request: { type: string }
    base: { type: string, default: main }
    planner: { type: string, default: codex }
    implementor: { type: string, default: claude }
  required: [request]
  additionalProperties: false
---

# Adversarial Implementation Workflow

- **Status:** Executable design sketch
- **Execution:** Manual, one stage at a time

This file is the complete workflow map. The linked files define the prompts,
artifacts, permissions, and deterministic effects used by each stage. Its
component markup is the intended executable form even where the current runtime
does not yet provide the required primitive.

Each invoked component renders its result through its `<Output>` region. The
caller's `as` prop captures that result and passes it explicitly to the next
component. `<Workflow>` creates an internal run, persists its captured results,
and restores them when a later manual stage resumes. Generated handoffs are
prompt content, not files that an agent must choose to read. Root `props`
supplies `request`, `base`, `planner`, and `implementor`.

## Complete flow

<Workflow base={props.base} historyRef="refs/xmd/runs">
  <Sandbox policy="supervised-implementation">
    <Worktree>
      <Glob
        include={["AGENTS.md", "**/AGENTS.md"]}
        exclude={[".git/**", "**/node_modules/**"]}
        as="instructionPaths"
      />
      <Capture as="instructions">
        <InstructionFiles paths={instructionPaths} />
      </Capture>
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

`Workflow` resolves `props.base` to a source revision before creating the
worktree. Its internal run keeps discovery through implementation on that
pinned filesystem even if the branch moves while execution is in progress.

## Rendered data flow

| Captured value         | Produced by                | Consumed by                                         |
| ---------------------- | -------------------------- | --------------------------------------------------- |
| `instructionPaths`     | `Glob`                      | `InstructionFiles`                                  |
| `instructions`         | `InstructionFiles` capture | every agent prompt                                  |
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
