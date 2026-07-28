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
component. `<RunHistory>` persists captured results and restores them when a
later manual stage resumes. Generated handoffs are prompt content, not files
that an agent must choose to read. Root `props` supplies `request`, `base`,
`planner`, and `implementor`.

## Complete flow

<RunHistory ref="refs/xmd/runs" base={props.base}>
  <Sandbox policy="supervised-implementation">
    <Glob
      include={["AGENTS.md", "**/AGENTS.md"]}
      exclude={[".git/**", "**/node_modules/**"]}
      as="instructionPaths"
    />
    <Capture as="instructions">
      <InstructionFiles paths={instructionPaths} />
    </Capture>
    <PlannerHandoff
      instructions={instructions}
      planner={props.planner}
      as="handoff"
    >
      {props.request}
    </PlannerHandoff>
    <UserGate
      purpose="validate the planner handoff"
      agent={props.planner}
      as="handoffGate"
    >
      {handoff}
    </UserGate>
    <Worktree>
      <PlanConvergence handoff={handoff}
        handoffGate={handoffGate}
        instructions={instructions}
        planner={props.planner}
        implementor={props.implementor}
        as="planResult" />
      <UserGate
        purpose="authorize implementation"
        agent={props.planner}
        as="authorizationGate"
      >
        {planResult}
      </UserGate>
      <ImplementationReview planResult={planResult}
        authorizationGate={authorizationGate}
        instructions={instructions}
        planner={props.planner}
        implementor={props.implementor}
        as="implementationReviewResult" />
      <UserGate
        purpose="accept the completed change"
        agent={props.planner}
        as="acceptanceGate"
      >
        {implementationReviewResult}
      </UserGate>
      <Output>{acceptanceGate}</Output>
    </Worktree>
  </Sandbox>
</RunHistory>

`RunHistory` resolves `props.base` to a source revision before discovery. The
worktree is created only when implementor planning begins and uses that pinned
revision even if the branch moves while discovery is in progress.

## Rendered data flow

| Captured value               | Produced by               | Consumed by                                                |
| ---------------------------- | ------------------------- | ---------------------------------------------------------- |
| `instructionPaths`           | `Glob`                    | `InstructionFiles`                                         |
| `instructions`               | `InstructionFiles` capture | every agent prompt                                         |
| `handoff`                    | `PlannerHandoff`          | handoff `UserGate`, `PlanConvergence`                       |
| `handoffGate`                | handoff `UserGate`        | `PlanConvergence`                                          |
| `planResult`                 | `PlanConvergence`         | authorization `UserGate`, `ImplementationReview`           |
| `authorizationGate`          | authorization `UserGate`  | `ImplementationReview`                                     |
| `implementationReviewResult` | `ImplementationReview`    | acceptance `UserGate`                                      |
| `acceptanceGate`             | acceptance `UserGate`     | workflow output, automatic `RunHistory` snapshot            |

## Details

- [Runtime and isolation](./runtime.md)
- [Instruction materialization](./InstructionFiles.md)
- [Planner handoff](./PlannerHandoff.md)
- [User involvement gate](./UserGate.md)
- [Plan convergence](./PlanConvergence.md)
- [Implementation and review](./ImplementationReview.md)
- [Artifacts and structured results](./artifacts.md)
- [Primitive inventory](./primitives.md)

The governing role, review, pull-request, and deferral contracts remain in the
[workflow specification](../../specs/adversarial-implementation-workflow.md).
