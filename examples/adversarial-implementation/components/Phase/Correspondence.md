---
props:
  type: object
  properties:
    established: {type: object}
    value: {type: object}
    role: {enum: [architect, planner, implementor]}
    phase: {type: string}
  required: [established, value, role, phase]
  additionalProperties: false
returns: {type: object}
---

<Phase.Schema as="schemas" />
<Let as="summaryRepair" value={props.established.summary.length > schemas.result.properties.summary.maxLength} />
<Let as="expected" value={{apiConflict:props.established.apiConflict ?? null,exactCorrection:props.established.exactCorrection ?? null,assessment:props.established.assessment ?? null,outcome:props.established.outcome,revision:props.established.revision,summary:summaryRepair ? null : props.established.summary,artifacts:props.established.artifacts,evidence:props.established.evidence,findings:props.established.findings,blocker:props.established.blocker ?? null,contract:props.role === "architect" && props.phase === "discovery" ? props.established.contract ?? null : null,discoveryRequests:(props.established.discoveryRequests ?? []).filter(request => request.role === props.role),discoveryGaps:(props.established.discoveryGaps ?? []).filter(gap => gap.request.role === props.role)}} />
<Let as="actual" value={{apiConflict:props.value.apiConflict ?? null,exactCorrection:props.value.exactCorrection ?? null,assessment:props.established.assessment === null || props.established.assessment === undefined ? null : props.value.assessment ?? null,outcome:props.value.outcome,revision:props.value.revision,summary:summaryRepair ? null : props.value.summary,artifacts:props.value.artifacts,evidence:props.value.evidence,findings:props.value.findings,blocker:props.value.blocker ?? null,contract:props.role === "architect" && props.phase === "discovery" ? props.value.contract ?? null : null,discoveryRequests:props.value.discoveryRequests ?? [],discoveryGaps:props.value.discoveryGaps ?? []}} />
<Return value={{ok:JSON.stringify(expected) === JSON.stringify(actual),summaryRepair}} />
