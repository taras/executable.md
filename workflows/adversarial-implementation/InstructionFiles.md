---
required: [paths]

props:
  paths:
    type: array
    items:
      type: string
---

# Instruction Files

This component renders the exact path and content of every instruction file
selected by the calling workflow.

It runs today. `<Each>`, `<Output>`, and a self-closing `<File>` are all
shipped, and `paths` is the `string[]` a `<Glob>` invocation bound. Props are
namespaced, so the `in` prop reads `props.paths` (#305).

Under a workflow run the `<File>` reads resolve inside the run-owned Workspace,
in whatever checkout the enclosing `<Repository>` or `<Worktree>` established as
cwd. The component does not change to say so — that is the point of the
contextual `API.Files` boundary.

<Output>

<Each in={props.paths} let="instructionPath">
## `{instructionPath}`

<File path={instructionPath} />
</Each>

</Output>
