---
description: 'Review one exact commit independently in a provider scope of its own. Use <Delivery.Role delivery={delivery} revision={revision} reviewer={reviewer} choices={["fable"]} position={0} attempt={directory} as="outcome" />.'
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
returns: {type: object}
---

The registered provider is installed for this attempt alone, so its resources
are released before the outcome returns. Its option inspection, configuration
and turn outcome are retained in the attempt directory before that release.

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
<Dir path={props.delivery.directory}><Glob include={[props.position === 0 ? "review-*/assignment.json" : "review-*/replacement/assignment.json"]} as="priorReviews" /></Dir>
<Let as="own" value={props.attempt.slice(props.delivery.directory.length + 1) + "/assignment.json"} />
<Let as="continuation" value={props.delivery.sessionEstablished === true || priorReviews.some(path => path !== own)} />
<Let as="owned"><AgentProvider name="acpx" defaultAgent={props.reviewer.provider}><Delivery.Classify reviewer={props.reviewer} as="inner"><Dir path={props.delivery.repository}><Agent name={props.reviewer.provider}><Delivery.Inspect agent={props.reviewer.provider} choices={props.choices} as="catalog" /><Dir path={props.attempt}><File path="catalog.json"><Json value={catalog} /></File></Dir><If condition={catalog.state === "selected"}><Session name={props.reviewer.session} model={catalog.model} effort={props.reviewer.effort ?? undefined}><Phase.Session directory={props.delivery.directory + "/sessions"} name={props.reviewer.session} requireExisting={continuation}><Delivery.Turn as="turn"><Prompt throwOnError={true}>{instructions}</Prompt></Delivery.Turn><Json value={{catalog,turn}} /></Phase.Session></Session><Else><Json value={{catalog,turn:null}} /></Else></If></Agent></Dir></Delivery.Classify><Dir path={props.attempt}><File path="outcome.json"><Json value={inner} /></File></Dir><Json value={inner} /></AgentProvider></Let>
<Parse schema={{type:"object"}} as="outcome">{owned}</Parse>
<Return value={outcome} />
