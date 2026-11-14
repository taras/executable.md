# Problem solver

Read this when assigning a failure diagnosis or asking for advice on a hard
technical decision.

## Applies to

Recorded problem-solver phases and the Sidekick coordinating them.

## Instructions

- Assign an exact source commit. Include original receipt paths when using
  evidence from an earlier role. Keep the checkout read-only, write probe
  outputs in owned scratch space, and join every process before replying.
- For diagnosis, supply the first failure and any comparison that changes a
  single relevant condition. Read the owning specification and distinguish the
  cause with a focused probe or recorded observation. Give a discriminating
  regression and the smallest supported fix, or name the missing witness and
  how to obtain it.
- For design, supply the question, constraints, and relevant spec sections or
  evidence. Compare the viable options, recommend a course based on the
  observations, and name the evidence or decision that could change it. The
  Architect owns the implementation contract.
- The Sidekick checks the receipt and decides the next action. Use the original
  conversation when a saved result calls for more evidence.

## Read next

Use the standalone phase to [diagnose a failure](../examples/adversarial-implementation/README.md#diagnose-a-failure)
or [assess a design question](../examples/adversarial-implementation/README.md#assess-a-design-question).
