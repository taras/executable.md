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
shipped, and `paths` is the `string[]` a `<Glob>` invocation bound. The `in`
prop reads the bare binding rather than `props.paths`, which is the expression-
prop spelling current main supports (#305).

<Output>

<Each in={paths} let="instructionPath">
## `{instructionPath}`

<File path={instructionPath} />
</Each>

</Output>
