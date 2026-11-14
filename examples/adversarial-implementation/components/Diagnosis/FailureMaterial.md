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
# Submit a diagnosis result

Read this when preparing the final diagnosis, including a missing-witness result.

Return `cause` only when the captured evidence distinguishes the cause from
other plausible explanations. In `cause`, state the diagnosis and explain how
the observations support it. In `evidence[]`, put only exact `path` values from
the captured inputs. Copy each path verbatim. Give a regression command, its
expected and observed behavior, and a bounded implementation handoff.

If the evidence is inconclusive, return `missing_witness`. Use `witness` to name
the specific missing observation and `howToObtain` to explain how to capture it.

Return one JSON object. Keep any progress updates in plain prose.

<Json value={props.resultSchema} />
</Let>
<Let as="instructions">
Diagnose the failure using the assigned checkout at {props.assignment.revision}. Read the repository instructions. Use the captured evidence and reuse the listed probes where they address the missing witness. Run focused commands in owned scratch space and join them before replying. Keep source, workflow records, and external systems read-only.

<Diagnosis.SpecSections repository={props.assignment.repository} revision={props.assignment.revision} references={props.assignment.spec === undefined ? [] : [props.assignment.spec]} />

<If condition={props.assignment.failingRevision !== undefined}>Failing CI revision: {props.assignment.failingRevision}. Compare the relevant paths with the assigned checkout before attributing the failure.</If>
<If condition={props.assignment.probes?.length > 0}>
Reusable probes:
<Json value={props.assignment.probes} />
</If>

{props.assignment.request}

Report a confirmed cause with supporting evidence or the specific missing witness.
</Let>
<Json value={{submission,instructions}} />
