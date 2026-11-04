---
description: 'Review one exact commit independently. Use <Delivery.Role delivery={delivery} revision={revision} as="reply" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [delivery, revision]
  additionalProperties: false
returns: {type: string}
---

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
<Let as="reviewer" value={props.delivery.policy.reviewer} />
<Dir path={props.delivery.directory}><Glob include={["review-*/assignment.json"]} as="priorReviews" /></Dir>
<Let as="continuation" value={props.delivery.sessionEstablished === true || priorReviews.some(path => path !== "review-" + props.revision + "/assignment.json")} />
<Let as="reply"><Dir path={props.delivery.repository}><Agent name={reviewer.provider}><Session name={reviewer.session} model={reviewer.model} effort={reviewer.effort ?? undefined}><Phase.Session directory={props.delivery.directory + "/sessions"} name={reviewer.session} requireExisting={continuation}><Prompt throwOnError={true}>{instructions}</Prompt></Phase.Session></Session></Agent></Dir></Let>
<Return value={reply} />
