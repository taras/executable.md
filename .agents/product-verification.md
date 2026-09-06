# Product verification

Product verification describes the behavior a feature must show working. The
Product Owner leads this design for the foreseeable future. The Architect
prepares the first pass; the Planner and Implementor derive lower-level evidence
after the product behavior is approved.

## Approved rules

1. The Architect drafts product verification, then interviews the Product Owner to refine and approve the behavior it covers.
2. Product verification covers user journeys, observable behavior, important failures, recovery and incomplete implementations.
3. Interface and product verification approval precede finalized architecture or implementation handoffs.
4. The Architect and Planner derive lower-level tests from approved product verification without further approval.

## Feature review

Review one behavior at a time:

1. Describe the behavior the feature must provide.
2. Show what a person does and observes.
3. Identify an incomplete implementation that could appear to work.
4. Propose verification that distinguishes the complete behavior.
5. Ask the Product Owner what should change.

Product verification stays at the product level. Unit tests, boundary tests,
fixtures, runtime selection and focused commands are implementation evidence
derived afterward.

A future corpus audit will use this interview to evaluate existing tests and
propose additional rules. Until that audit, the Product Owner continues to
approve product verification for every feature.
