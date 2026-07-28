---
inputs:
  type: object
  properties:
    paths:
      type: array
      items:
        type: string
  required:
    - paths
  additionalProperties: false
---

# Instruction Files

This component renders the exact path and content of every instruction file
selected by the calling workflow.

<Output>

<Each in={props.paths} let="instructionPath">
## `{instructionPath}`

<File path={instructionPath} />
</Each>

</Output>
