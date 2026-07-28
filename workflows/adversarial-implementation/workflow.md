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
component. A content-writing `<File>` persists its rendered content without
replacing it with a path. Root `props` supplies `request`, `base`, `planner`,
and `implementor`.

## Complete flow

<RunHistory ref="refs/xmd/runs">
  <Sandbox policy="supervised-implementation">
    <Worktree base={props.base}>
      <Glob
        include={["AGENTS.md", "**/AGENTS.md"]}
        exclude={[".git/**", "**/node_modules/**"]}
        as="instructionPaths"
      />
      <File path="planner-handoff.md" as="handoff">
        <PlannerHandoff
          instructionPaths={instructionPaths}
          planner={props.planner}
        >
          {props.request}
        </PlannerHandoff>
      </File>
      <File path="handoff-user-gate.md" as="handoffGate">
        <UserGate purpose="validate the planner handoff"
          agent={props.planner}>
          {handoff}
        </UserGate>
      </File>
      <PlanConvergence handoff={handoff}
        handoffGate={handoffGate}
        instructionPaths={instructionPaths}
        planner={props.planner}
        implementor={props.implementor}
        as="planResult" />
      <File path="authorization-user-gate.md" as="authorizationGate">
        <UserGate purpose="authorize implementation"
          agent={props.planner}>
          {planResult}
        </UserGate>
      </File>
      <ImplementationReview planResult={planResult}
        authorizationGate={authorizationGate}
        instructionPaths={instructionPaths}
        planner={props.planner}
        implementor={props.implementor}
        as="implementationReviewResult" />
      <File path="acceptance-user-gate.md" as="acceptanceGate">
        <UserGate purpose="accept the completed change"
          agent={props.planner}>
          {implementationReviewResult}
        </UserGate>
      </File>
      <Output>{acceptanceGate}</Output>
    </Worktree>
  </Sandbox>
</RunHistory>

## Rendered data flow

| Captured value               | Rendered by               | Consumed by                                                |
| ---------------------------- | ------------------------- | ---------------------------------------------------------- |
| `instructionPaths`           | `Glob`                    | `PlannerHandoff`, `PlanConvergence`, `ImplementationReview` |
| `handoff`                    | handoff `File`            | handoff `UserGate`, `PlanConvergence`                       |
| `handoffGate`                | handoff gate `File`       | `PlanConvergence`                                          |
| `planResult`                 | `PlanConvergence`         | authorization `UserGate`, `ImplementationReview`           |
| `authorizationGate`          | authorization gate `File` | `ImplementationReview`                                     |
| `implementationReviewResult` | `ImplementationReview`    | acceptance `UserGate`                                      |
| `acceptanceGate`             | acceptance gate `File`    | workflow output, automatic `RunHistory` snapshot            |

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
