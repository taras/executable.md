---
props:
  type: object
  properties:
    assignment: {type: object}
    resultSchema: {type: object}
  required: [assignment, resultSchema]
  additionalProperties: false
---

<Let as="submission">
# Submit a design assessment

Read this when preparing your final assessment.

Compare two to four options and explain each option's tradeoffs under the
assigned constraints. In `observations`, give the concrete facts that inform
your comparison. Name each source with the exact captured path, pinned spec
reference, or repository-relative path you inspected.

Connect your recommendation to those observations. In `whatWouldChange`, name
the evidence that would change your recommendation. Use `openQuestions` for
missing evidence or a decision the Architect must make. If a missing fact
prevents a choice, recommend the next step and explain what it would resolve.
The Architect owns the implementation contract.

Return one JSON object. Keep any progress updates in plain prose.

<Json value={props.resultSchema} />
</Let>
<Let as="instructions">
Assess the design question using the assigned checkout at {props.assignment.revision}.
Read the repository instructions. Use the supplied context and inspect the
relevant source. Run focused probes in owned scratch space and join them before
replying. Keep source, workflow records, and external systems read-only.

## Design question

{props.assignment.question}

## Constraints

<Json value={props.assignment.constraints} />

<Diagnosis.SpecSections repository={props.assignment.repository} revision={props.assignment.revision} references={props.assignment.specs ?? []} />

Advise the Architect on the options and tradeoffs.
</Let>
<Json value={{submission,instructions}} />
