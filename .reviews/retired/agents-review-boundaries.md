# Retired: AGENTS.md review boundaries (parked verbatim pending the review-workflow rewrite)

## Review boundaries

An ordinary implementation verdict reviews one exact feedback-commit SHA against
the settled contract, the patch, the implementation and the focused evidence
reported with it. It does not inspect, monitor or wait for CI, and CI status is
neither positive nor negative evidence for it. A passing verdict is `PASS` —
never `PASS pending CI`, `mark ready after CI`, or an equivalent condition. CI
is inspected only when the user explicitly assigns CI troubleshooting.

### Structural consequences

An architecture finding has a **structural consequence** only when it changes
one or more of:

- what is authorized to execute;
- which durable identity or retained history is accepted;
- what durable state is committed, published, or journaled;
- whether replay can resume the intended run;
- ownership of a transaction, resource, invocation, or lifecycle;
- concurrency or cancellation behavior that violates that ownership;
- which authoritative outcome wins after a fatal failure; or
- a public persistence or compatibility boundary.

The Architect returns `REQUEST CHANGES` only when all five of these hold:

1. The finding is reproduced or directly traced against the exact reviewed
   commit.
2. It violates a previously settled structural invariant.
3. It uses an in-scope supported surface.
4. It produces a structural consequence from the list above.
5. Its correction belongs within the current PR's purpose.

The verdict names every one of them: the reviewed SHA, the settled invariant,
the reproducer or direct trace, the supported surface, the structural
consequence, and why the correction belongs in this PR. A hypothetical risk, a
plausible concern, or an adjacent invariant cannot fail architecture review.

The structural checklist is frozen before implementation. A distinct structural
invariant added afterwards takes an explicit architecture amendment naming its
consequence, not an implicit review expansion.

### Finite evidence

The Planner owns the evidence sufficient to prove the settled acceptance
criteria: how much implementation detail each criterion needs, the
representative scenarios, the focused tests, and when one regression proves a
criterion. That acceptance and evidence matrix is frozen before implementation.

The Implementor executes the frozen matrix. When implementation evidence shows
the matrix cannot prove a criterion, the Implementor returns that evidence
rather than expanding acceptance independently. The Architect may restore a
structural invariant the plan omits, but does not expand a sufficient matrix
with permutations that carry no distinct structural consequence.

Once implementation begins, a newly imagined edge case blocks only when it
proves an existing criterion unmet, or carries a distinct structural consequence
requiring an explicit architecture amendment.

### Follow-ups and closure

A non-blocking observation does not automatically become an issue. The Planner
decides whether recurrence likelihood, user impact, or expected remediation
value makes it worth tracking; otherwise the behavior stays for reactive
maintenance.

Architect review closes when the frozen structural checklist passes. Planner
review closes when the frozen acceptance criteria and the selected evidence
pass. Neither role reopens review for CI, diagnostic hardening, speculative
permutations, unrelated correctness polish, or an incidental non-structural
observation. A later correction returns to a role only when it materially
changes that role's reviewed contract.
