---
props:
  type: object
  properties:
    role: {enum: [architect, planner, implementor]}
    assignment: {type: object}
  required: [role, assignment]
  additionalProperties: false
---

<Output>
# Submit a phase result

Read this when preparing a result, including an early blocker, source conflict
or unanswered decision. It supplies the response fields, limits and routing for
the current assignment.

Return assessment on completed implementation, changes_required, missing_evidence and escalate. For changes_required or missing_evidence, assess only the finite correction being requested, not the original feature. Keep already settled responsibilities closed; a missing test witness does not by itself reopen the production architecture. Completed implementation likewise reports the actual correction rather than inheriting the whole feature scope. Assess actual impact: mechanical, architecture and acceptance booleans; one short impact reason and individual evidence references, plus risk:null unless a concrete consequential uncertainty or risk needs additional reasoning. For high effort, risk contains its own short reason and supporting evidence. Merely touching concurrency, cancellation, durable state, replay or a public boundary is not that reason. Test-only changes can affect acceptance. A mechanical assessment has no architecture, acceptance or complexity impact. New non-mechanical feature work includes Planner acceptance; correction work requires only affected responsibilities. Keep evidence references in artifacts or already recorded documents. Do not request a reviewer or reasoning effort in prose to override this assessment.

Return escalate only from medium Discovery or Review when a concrete newly discovered risk or uncertainty prevents completing this assignment. Keep the same revision and impact flags, supply risk with the specific reason and supporting evidence, and leave the checkout clean. The workflow resumes the same original role/session at high. High cannot escalate again. Implementation uses its assigned provider/effort and returns needs_discovery for a scope conflict. Only the Implementor during implementation may include apiConflict, with a saved reproducer in artifacts and failed evidence.

The workflow supplies omitted phase and work, the assigned revision for read-only phases, and the accepted continuation for complete/pass. Explicit conflicting metadata is refused. Implementation must report the actual resulting revision; evidence must name the inputs actually tested.

Return next.phase and next.role explicitly when the outcome changes the prepared route. For complete/pass, copy assignment.continuation exactly; completed implementation routing is derived from the returned assessment and replaces that predicted continuation. For escalate, copy the current phase and role; the workflow derives and checks that same-owner continuation. For changes_required or missing_evidence, select implementation/implementor. For needs_discovery with apiConflict, select discovery/planner; otherwise select discovery/architect. For blocked or needs_decision, select hold/null. The program verifies this gate before another role can run; ready is a phase-loop result, not delivery approval.

Keep summary to 1200 characters. Address handoff to next.role, or ROOT when next.phase is hold/ready. Write only that owner's next bounded action and necessary artifact references in at most 250 words and 1800 characters. Put command receipts in evidence and detailed reports in artifact files. Select only the short documents the next owner needs in handoffInputs. Each selected handoffInputs path must appear in your returned artifacts or the already recorded documents. A file existing on disk alone does not make it a recorded document. Keep full test logs, patches and historical ledgers in artifacts; listing an artifact does not send its contents. The selected-input limit is 64000 UTF-16 units for the recipient's entire owed packet, including undelivered accepted inputs and role guides. Use the recipient's recorded remaining allowance for new handoff material. Keep binding clauses, their conditions, exceptions, commands, identities and unresolved findings exact; reference full supporting artifacts. Ticket.Prepare checks the actual packet before dispatch and retains its receipt. This selected-input allowance is separate from the 256000-character complete-prompt ceiling. Use a new reference for changed contents. The workflow supplies accepted inputs once per retained role; do not request their repetition without a named change. Do not repeat the summary, command list, prior prompts, full plan, contract packet or narrative history in handoff. Omit blocker outside blocked outcomes.

Keep discoveryRequests[].role and discoveryGaps[].request.role equal to {props.role}. These fields name you, the reporting actor. next.role names the requested successor; requesting Architect does not make Architect the request author. Never relabel an explicit contradictory author.

Before returning, check the required fields, assigned work/phase, actual revision, next role and phase, and character limits against the contract below. Omit optional metadata you cannot establish instead of guessing.

Return exactly one JSON object conforming to this contract, without Markdown fences or surrounding prose. The handoff field is the complete ready-to-send request for the next owner; only that field becomes the next request. Artifacts and evidence travel as structured references. For an uncommitted candidate, report evidence.revision=null and candidate=the retained candidate/command metadata path. Report observations as observations; schema validation does not establish test results, approvals or delivery readiness.
<Phase.Schema as="schemas" />
<Let as="phaseOutcome" value={schemas.result.allOf[["discovery","implementation","review"].indexOf(props.assignment.phase)].then.properties.outcome} />
<Let as="authorRequest" value={{...schemas.result.properties.discoveryRequests.items,properties:{...schemas.result.properties.discoveryRequests.items.properties,role:{const:props.role}}}} />
<Let as="authorGap" value={{...schemas.result.properties.discoveryGaps.items,properties:{...schemas.result.properties.discoveryGaps.items.properties,request:authorRequest}}} />
<Let as="promptContract" value={{type:schemas.result.type,required:[...schemas.result.required.filter(name => !["phase","work",...(props.assignment.phase === "implementation" ? [] : ["revision"])].includes(name)),"discoveryRequests","discoveryGaps"],additionalProperties:false,properties:{...schemas.result.properties,discoveryRequests:{...schemas.result.properties.discoveryRequests,items:authorRequest},discoveryGaps:{...schemas.result.properties.discoveryGaps,items:authorGap},phase:{const:props.assignment.phase},work:{const:props.assignment.work},outcome:phaseOutcome,apiConflict:props.role === "implementor" && props.assignment.phase === "implementation" ? schemas.result.properties.apiConflict : undefined,contract:props.role === "architect" && props.assignment.phase === "discovery" ? schemas.result.properties.contract : undefined},$defs:schemas.result.$defs}} />
<Let as="resultContract" value={JSON.stringify(promptContract)} />
{resultContract}
</Output>
