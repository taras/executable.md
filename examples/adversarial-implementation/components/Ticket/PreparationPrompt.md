---
description: 'Ask the established Planner to prepare documents. Use <Ticket.PreparationPrompt owner={owner} stage="reduce" assignment={assignment} material={material} as="raw" />.'
props:
  type: object
  properties:
    owner: {type: object}
    stage: {enum: [reduce, compare]}
    assignment: {type: object}
    material: {type: object}
    schema: {type: object}
    allowance: {type: integer}
  required: [owner, stage, assignment, material, schema, allowance]
  additionalProperties: false
---
<Let as="request">
You remain the original Planner. Perform only handoff document preparation, not productive planning, source work, signing or publication. Use only the supplied captured windows; do not acquire extra material with native tools. Report insufficient material as uncertainty. This is one bounded preparation prompt, with no correction allowance.

The recipient's selected-input allowance for new handoff material is {props.allowance} UTF-16 units, including the receipt reference added by the workflow. Preserve exact wording, scope, conditions, exceptions and unresolved decisions for every binding architecture, acceptance and test obligation. Preserve commands, syntax, authorization, identities and evidence status. Supporting history and rationale may become explicit original-file references. Accepted inputs, role instructions, structured assignment, completed results and allowances are immutable.

<If condition={props.stage === "reduce"}>
Return one consolidated candidate as content. Diagnose the excess per source. Map every source character exactly once with contiguous dispositions: extract for exact binding clauses; consolidate for repeated identical clauses pointing to the same exact target text; reference only for supporting material, with its original path present in content. targetStart counts UTF-16 units in content. Never replace an undelivered binding requirement with a reference. If exact obligations cannot fit, report uncertainty instead of paraphrasing them.
<Else>
Compare the complete original windows against the candidate windows and mapping. Identify every preserved, changed, missing and uncertain obligation, including scope, conditions and exceptions. sufficient is true only when all consequential requirements are selected with exact wording and nothing binding is missing or uncertain. Hash and span checks prove text identity only; your comparison is a semantic judgment, not a mechanical equivalence proof. Do not rewrite or repair the candidate.
</Else>
</If>

Recipient assignment (unchanged):
<Json value={props.assignment} />
Window provenance and actual acquisitions:
<Json value={props.material.observations} />
<Each in={props.material.inputs} let="input">
{input.path}
{input.content}
</Each>
Return exactly one JSON object satisfying:
<Json value={props.schema} />
</Let>
<If condition={request.length > 256000}><Fail message="The complete preparation prompt exceeds 256000 characters; nothing was sent." /></If>
<Output><Agent name={props.owner.profile.provider}><Session name={props.owner.session} model={props.owner.profile.model} effort={props.owner.profile.effort}><Prompt throwOnError={true}>{request}</Prompt></Session></Agent></Output>
