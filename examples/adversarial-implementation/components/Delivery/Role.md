---
description: 'Review one exact commit independently in a provider scope of its own. Use <Delivery.Role delivery={delivery} revision={revision} reviewer={reviewer} choices={["fable"]} position={0} attempt={directory} />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
    reviewer: {type: object}
    choices: {type: array, items: {type: string, minLength: 1}, minItems: 1}
    position: {type: integer, minimum: 0, maximum: 1}
    attempt: {type: string, pattern: '^/'}
  required: [delivery, revision, reviewer, choices, position, attempt]
  additionalProperties: false
---

The registered provider is installed for this attempt alone and released when
the role finishes. The option inspection and the provider's turn outcome are
saved to `outcome.json` before that release, including when the turn fails.

<Delivery.Schema as="schemas" />
<Let as="instructions">
Perform one independent correctness review of {props.revision} in {props.delivery.repository}. Read the repository instructions and inspect that exact commit and its affected consumers. Keep source unchanged. Reuse applicable evidence; run only focused evidence that distinguishes a finding. Do not run broad confidence suites or wait for CI. Do not delegate, implement, publish comments, or merge. Report a concrete blocker rather than substituting a provider or repeating an uncertain call.

Review these recorded acceptance clauses against their original selected sources. A derived check cannot strengthen or replace them. Report a material ambiguity as blocked.
<Json value={props.delivery.policy.acceptance} />

Original captured source text:
<Json value={props.delivery.inputs} />

Keep summary within {schemas.review.properties.summary.maxLength} characters, including spaces and newlines. Put detailed observations in findings; do not compress the whole report into summary. Check revision against the assigned full SHA and acceptance against the recorded clause IDs before returning.

Return exactly one JSON object satisfying this schema. acceptance lists every clause ID actually examined. pass requires no blocking finding. The workflow supplies work, reviewer, attempt and completion metadata.
<Json value={schemas.review} />
</Let>
<If condition={instructions.length > 64000}><Fail message="The complete independent-review request exceeds 64000 characters. Prepare concise accepted inputs before dispatch." /></If>
<Delivery.Continuation directory={props.delivery.directory} session={props.reviewer.session} own={props.attempt.slice(props.delivery.directory.length + 1) + "/assignment.json"} as="established" />
<Let as="continuation" value={props.delivery.sessionEstablished === true || established} />
<AgentProvider name="acpx" defaultAgent={props.reviewer.provider}><Dir path={props.delivery.repository}>
<Delivery.Inspect agent={props.reviewer.provider} choices={props.choices} as="catalog" />
<Let as="turn" value={null} />
<Try>
<If condition={catalog.state === "selected"}><Delivery.Turn as="turn"><Agent name={props.reviewer.provider}><Session name={props.reviewer.session} model={catalog.model} effort={props.reviewer.effort ?? undefined}><Phase.Session directory={props.delivery.directory + "/sessions"} name={props.reviewer.session} requireExisting={continuation}><Prompt throwOnError={true}>{instructions}</Prompt></Phase.Session></Session></Agent></Delivery.Turn></If>
<Finally><Dir path={props.attempt}><File path="outcome.json"><Json value={{schema:"delivery-review-outcome.v1",reviewer:props.reviewer,catalog,turn}} /></File></Dir></Finally>
</Try>
</Dir></AgentProvider>
