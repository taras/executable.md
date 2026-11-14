# Problem solver

Read this when diagnosing a specific failure before assigning a fix.

## Applies to

Recorded problem-solver phases and the Sidekick coordinating them.

## Instructions

- Assign an exact source commit, the first failure, and any comparison that
  changes a single relevant condition. Include original receipt paths when using
  evidence from an earlier role.
- Read the owning specification and distinguish the cause with a focused probe
  or a recorded observation. Keep the source checkout unchanged and put probe
  outputs in owned scratch space. Join every process before replying.
- If the cause is confirmed, cite the observations that distinguish it, give a
  regression command with expected and observed behavior, and hand Opus the
  smallest fix justified by the evidence. Otherwise name the missing witness
  and give a way to obtain it.
- The Sidekick checks the receipt and decides the next action. Use the original
  diagnostic conversation when a saved result calls for more evidence.
  Implementation and independent delivery review have their own assignments.

## Read next

Use the [standalone diagnostic entry](../examples/adversarial-implementation/README.md#diagnose-a-failure)
to start or continue an assignment.
