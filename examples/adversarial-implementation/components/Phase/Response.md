---
props: {"type": "object", "properties": {"assignment": {"type": "object"}, "text": {"type": "string"}, "role": {"anyOf": [{"enum": ["architect", "planner", "implementor"]}, {"type": "null"}], "default": null}, "profile": {"type": "object", "default": {"kind": "phase", "knownDocuments": []}}}, "required": ["assignment", "text"], "additionalProperties": false}
returns: {type: object}
---

<Phase.Schema as="schemas" />
<Parse schema={schemas.assignment} as="parsedAssignment"><Json value={props.assignment} /></Parse>
<Parse schema={{"type": "object", "properties": {"kind": {"enum": ["phase", "ticket", "delivery-editorial"]}, "knownDocuments": {"type": "array", "items": {"type": "string"}}, "establishedPath": {"type": "string"}, "appliedPath": {"type": "string"}}, "required": ["kind", "knownDocuments"], "additionalProperties": false}} as="profile"><Json value={props.profile} /></Parse>
<Let as="assignment" value={{...parsedAssignment,contract:parsedAssignment.contract ?? null}} />
<Loop max={1}>
<Phase.Extract text={props.text} as="extracted" />
<If condition={!extracted.ok}><Return value={extracted} /><Break /></If>
<Let as="normalizations" value={[]} />
<SafeParse schema={{type:"object"}} as="candidate">{extracted.json}</SafeParse>
<If condition={candidate.ok}>
<Phase.Revisions repository={assignment.repository} value={candidate.value} as="canonical" />
<If condition={!canonical.ok}><Return value={canonical} /><Break /></If>
<Json value={canonical.value} as="canonicalJson" />
<Let as="extracted" value={{...extracted,json:canonicalJson}} />
<Let as="normalizations" value={canonical.changes} />
</If>
<SafeParse schema={schemas.result} as="parsed">{extracted.json}</SafeParse>
<If condition={!parsed.ok}><Return value={{ok:false,rejection:{kind:"response_validation",code:"schema",message:"The final JSON does not satisfy the canonical phase result schema.",issues:parsed.errors}}} /><Break /></If>
<Let as="result" value={{...parsed.value,contract:parsed.value.contract ?? null,blocker:parsed.value.blocker ?? null}} />
<If condition={result.apiConflict !== undefined && (props.role !== "implementor" || assignment.phase !== "implementation" || result.outcome !== "needs_discovery" || !result.artifacts.includes(result.apiConflict.artifact) || !result.evidence.some(entry => entry.outcome === "failed"))}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"api-conflict",message:"An API conflict belongs to the original Implementor's needs_discovery result and includes a saved reproducer and failed evidence.",issues:[]}}} /><Break />
</If>
<If condition={result.phase !== assignment.phase || result.work !== assignment.work}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-1",message:"The reply names a different phase or work item. Preserve it and ask the same owner to resolve the identity mismatch.",issues:[]}}} /><Break />
</If>
<If condition={assignment.phase !== "implementation" && result.revision !== assignment.revision}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-2",message:"The reply names a different source revision. Prepare the correct revision before continuing.",issues:[]}}} /><Break />
</If>
<If condition={assignment.contract !== null && assignment.contract.work !== assignment.work}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-3",message:"The contract packet belongs to another work item. Preserve the assignment and resolve its ticket identity.",issues:[]}}} /><Break />
</If>
<If condition={props.role === "architect" && assignment.phase === "discovery" && result.outcome === "complete" && result.contract === null}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-4",message:"A completed Architect Discovery requires a ticket contract packet naming the relevant document sections. Preserve the raw reply before requesting the missing context.",issues:[]}}} /><Break />
</If>
<If condition={result.contract !== null}>
<If condition={result.contract.work !== assignment.work || result.contract.sourceRevision !== assignment.revision}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-5",message:"The returned contract packet names a different ticket or source revision. Preserve it and resolve the mismatch.",issues:[]}}} /><Break />
</If>
<If condition={props.role !== null && (props.role !== "architect" || assignment.phase !== "discovery")}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-6",message:"Return new contract packets through Architect Discovery. Other phases reuse the prepared packet and report missing facts in their handoff.",issues:[]}}} /><Break />
</If>
</If>
<If condition={result.handoff.trim().split(/\s+/).length > 250}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-7",message:"The handoff exceeds 250 words. Preserve the reply; put evidence and history in their structured fields or referenced artifacts.",issues:[]}}} /><Break />
</If>
<If condition={props.role !== null && [...(result.discoveryRequests ?? []),...(result.discoveryGaps ?? []).map(gap => gap.request)].some(request => request.role !== props.role)}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-8",message:"Discovery requests and gaps identify the role that returned them, not a replacement owner.",issues:[]}}} /><Break />
</If>
<If condition={(result.discoveryGaps ?? []).some(gap => gap.status === "open") && result.outcome !== "needs_discovery"}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-9",message:"An open discovery gap requires needs_discovery before another productive role.",issues:[]}}} /><Break />
</If>
<If condition={(result.discoveryGaps ?? []).some(gap => gap.status === "resolved" && gap.evidence.length === 0)}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"metadata-10",message:"A resolved discovery gap requires the actual evidence that answered it.",issues:[]}}} /><Break />
</If>
<If condition={assignment.assessment !== undefined}>
<Ticket.Capture as="assessed">
<ReviewPolicy assessment={assignment.assessment} kind={assignment.reviewKind ?? "feature"} as="before" />
<If condition={assignment.phase === "implementation" && result.outcome === "complete" || ["changes_required","missing_evidence","escalate"].includes(result.outcome)}>
<If condition={!result.assessment}><Fail message="This outcome requires an assessment of the actual change or remaining work." /></If>
<ReviewPolicy assessment={result.assessment} kind={["changes_required","missing_evidence"].includes(result.outcome) ? "correction" : assignment.reviewKind ?? "feature"} as="after" />
<If condition={result.outcome === "escalate" && (before.effort !== "medium" || after.effort !== "high" || result.assessment.mechanical !== assignment.assessment.mechanical || result.assessment.architecture !== assignment.assessment.architecture || result.assessment.acceptance !== assignment.assessment.acceptance)}>
<Fail message="Escalation records a concrete risk for the same medium assignment; it cannot change impact or escalate high again." />
</If>
<If condition={result.outcome === "escalate" && (props.role === null || assignment.phase === "implementation")}><Fail message="Escalation retains a named read-only role on the same revision." /></If>
<Json value={after} />
<Else><Json value={before} /></Else>
</If>
</Ticket.Capture>
<If condition={assessed.status !== "completed"}><Return value={{ok:false,rejection:{kind:"response_validation",code:"impact-assessment",message:assessed.failure,issues:[]}}} /><Break /></If>
<Parse schema={{type:"object"}} as="policy">{assessed.output}</Parse>
<If condition={assignment.phase === "implementation" && result.outcome === "complete"}>
<Let as="result" value={{...result,next:policy.reviewers.length === 0 ? {phase:"ready",role:null} : {phase:"review",role:policy.reviewers[0]}}} />
</If>
<If condition={result.outcome === "escalate"}><Let as="result" value={{...result,next:{phase:assignment.phase,role:props.role}}} /></If>
</If>
<If condition={result.exactCorrection !== undefined}>
<Ticket.Capture as="exactValidation"><ExactCorrection.Validate assignment={assignment} result={result} role={props.role ?? "implementor"} as="offer" /></Ticket.Capture>
<If condition={exactValidation.status !== "completed"}><Return value={{ok:false,rejection:{kind:"response_validation",code:"exact-correction",message:exactValidation.failure,issues:[]}}} /><Break /></If>
</If>
<Let as="selectedPhase" value={(result.outcome === "escalate" || assignment.phase === "implementation" && result.outcome === "complete") && assignment.assessment !== undefined ? result.next.phase : assignment.continuation?.phase ?? (["discovery","implementation","review","ready"].includes(result.next.phase) ? result.next.phase : "review")} />
<Phase.Route result={result} successor={selectedPhase} role={result.outcome === "escalate" || assignment.phase === "implementation" && result.outcome === "complete" ? result.next.role : assignment.continuation?.role ?? null} as="route" />
<If condition={!route.ok}><Return value={route} /><Break /></If>
<If condition={profile.kind === "ticket" && (result.handoffInputs ?? []).some(path => !result.artifacts.includes(path) && !profile.knownDocuments.includes(path))}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"handoff-selection",message:"Select handoffInputs from the returned artifacts or already recorded documents.",issues:[]}}} /><Break />
</If>
<If condition={profile.kind === "ticket" && props.role === "implementor" && ["complete","pass"].includes(result.outcome) && !result.evidence.some(entry => entry.outcome === "passed")}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"focused-evidence",message:"Implementation needs a saved focused evidence receipt; absent real evidence cannot be invented.",issues:[],terminal:true}}} /><Break />
</If>
<If condition={profile.kind === "delivery-editorial" && result.outcome === "pass" && (result.revision !== assignment.revision || !result.metadata || typeof result.metadata.title !== "string" || typeof result.metadata.body !== "string")}>
<Return value={{ok:false,rejection:{kind:"response_validation",code:"editorial-metadata",message:"Metadata APPLY requires exact-head PASS and title/body strings naming already applied text.",issues:[]}}} /><Break />
</If>
<Return value={{ok:true,value:result,normalizations}} />
</Loop>
