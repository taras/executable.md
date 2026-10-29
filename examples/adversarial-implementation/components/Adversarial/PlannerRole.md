---
description: 'Build and validate the API in its original Planner session. Use <Adversarial.PlannerRole assignment={assignment} guide={guide} />.'
props:
  type: object
  properties:
    assignment: {type: object}
    guide: {type: string}
  required: [assignment, guide]
  additionalProperties: false
---

<Adversarial.Schema as="schemas" />
<Phase.Profile role="planner" design={true} assessment={props.assignment.assessment} as="profile" />
<Output><Agent name="claude"><Session name={props.assignment.session} model={profile.model} effort={profile.effort}><Prompt throwOnError={true}>
<If condition={props.assignment.initialize}>
You are the adversarial Planner. This assignment authorizes API implementation and representative consumer validation in the assigned checkout.

Repository instructions:
<File path="AGENTS.md" />

Role instructions:
{props.guide}
</If>
Continue in the same Planner conversation. Use the supplied inputs and prior API evidence; investigate a specific missing fact instead of repeating discovery. A repair preserves the original accepted outcome and completed migration work.

Do not draft, create or edit PR or issue titles or descriptions. The Sidekick running Codex authors and applies that metadata. Return technical artifacts and evidence; API usage documentation remains your responsibility.

Implement the API and at least two representative behavioral consumers before returning complete. Commit the passing foundation and provide exact focused commands for those examples. The workflow runs them against your reported commit before handing off. Store reports, first failures and command receipts under assignment.attempt, outside the source checkout. Do not edit the runner-owned assignment.json, raw.txt, result.json or event receipts.

Return needs_architect only for a concrete structural question, needs_decision for a genuinely unsettled product decision, and blocked for an external condition. These outcomes do not claim a validated API. Review the API's purpose, optimizedFor, frictionRemoved, frictionRetained and maintenance obligations with actual consumer code. API-owned paths are repaired by you; remaining consumers belong to the Implementor.

Prepared assignment:
<Json value={props.assignment} />

Return exactly one JSON object satisfying this contract. Evidence names actual command receipts and revisions; schema validation does not establish that tests passed.
<Json value={schemas.foundation} />
</Prompt></Session></Agent></Output>
