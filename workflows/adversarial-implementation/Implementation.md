---
required: [plan, authorization, instructions, planner, implementor, worktree]

props:
  plan: { type: string }
  authorization:
    type: object
    properties:
      proceed: { type: boolean }
      assessment: { type: string }
      response: { type: string }
      rationale: { type: string }
    required: [proceed, assessment, response, rationale]
  instructions: { type: string }
  planner: { type: string }
  implementor: { type: string }
  worktree: { type: string }

returns:
  report: { type: string }
  verdictPassed: { type: boolean }
  review: { type: string }
  revisionPrompt: { type: string }
  findings:
    type: array
    items:
      type: object
      properties:
        disposition: { type: string }
        title: { type: string }
        description: { type: string }
        evidence:
          type: array
          items:
            type: string
      required: [disposition, title, description, evidence]
      additionalProperties: false
  decision:
    type: object
    properties:
      requiresUser: { type: boolean }
      proceed: { type: boolean }
      assessment: { type: string }
      recommendation: { type: string }
      question: { type: string }
      options:
        type: array
        items:
          type: string
      response: { type: string }
      rationale: { type: string }
    required:
      [requiresUser, proceed, assessment, recommendation, question, options, response, rationale]
    additionalProperties: false
---

# Implementation

Implementation begins only after the user authorizes the converged plan.

The implementor does not edit files. Under `xmd workflow` an Agent is read-only,
enforced by the host rather than by anything this document writes, so the
implementor inspects the checkout and returns an XMD fragment describing the
change it proposes. A constrained evaluator preflights that fragment and expands
the components it admits, and those expansions are what write files — each one an
ordinary durable effect with its own expansion identity, journal result, and
Workspace transaction. Staging, committing, pushing, and opening the pull request
are separate deterministic effects the document performs afterwards.

That is the whole shape of the stage: **agents inspect; XMD mutates.**

## Target shape

<Capture as="proposalSchema" select="code[lang=json]">
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "changes": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "minLength": 1 },
    "commitMessage": { "type": "string", "minLength": 1 },
    "report": { "type": "string" }
  },
  "required": ["changes", "title", "commitMessage", "report"],
  "additionalProperties": false
}
```
</Capture>

<Capture as="pullRequestVerdictSchema" select="code[lang=json]">
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "passed": { "type": "boolean" },
    "review": { "type": "string" },
    "revisionPrompt": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "disposition": {
            "type": "string",
            "enum": ["fix", "insert-repair", "defer", "reject"]
          },
          "title": { "type": "string" },
          "description": { "type": "string" },
          "evidence": {
            "type": "array",
            "items": { "type": "string" }
          }
        },
        "required": [
          "disposition",
          "title",
          "description",
          "evidence"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": ["passed", "review", "revisionPrompt", "findings"],
  "additionalProperties": false
}
```
</Capture>

<Agent name={props.implementor}>
  <Session name="implementor">
    <Agent.AddDir path={props.worktree} />

    <Loop name="implementation" max={5}>
      <Prompt as="proposalCandidate" throwOnError>
        Repository instructions:

        {props.instructions}

        Authorized plan:

        {props.plan}

        Authorization record:

        {props.authorization.assessment}
        User response: {props.authorization.response}
        Rationale: {props.authorization.rationale}

        Result contract:

        {proposalSchema}

        Implement the authorized plan by returning Executable.md source that
        performs it. You have read-only access to the registered checkout and
        cannot modify anything directly; the `changes` field is the only way
        your work takes effect.

        `changes` may use only `<Dir>`, `<File>`, and `<DeleteFile>`. It may not
        contain eval or exec blocks, imports, or any other component. Report
        validation and newly discovered scope in `report`. Return only JSON
        matching the supplied result contract.
      </Prompt>

      <Loop max={2}>
        <SafeParse schema={proposalSchema} as="parsedProposal">
          {proposalCandidate}
        </SafeParse>

        <If condition={parsedProposal.ok}>
          <Break />
          <Else>
            <Prompt as="proposalCandidate" throwOnError>
              Correct your previous response without changing its meaning.
              Do not use tools or perform additional analysis.

              Previous response:

              {proposalCandidate}

              Validation errors:

              <Each in={parsedProposal.errors} let="error">
              - {error.instancePath}: {error.message}
              </Each>

              Result contract:

              {proposalSchema}

              Return only corrected JSON.
            </Prompt>
          </Else>
        </If>
      </Loop>

      <Parse schema={proposalSchema} as="proposal">
        {proposalCandidate}
      </Parse>

      <Expand
        source={proposal.changes}
        allow={["Dir", "File", "DeleteFile"]}
      />
      <Git.Add paths="." />
      <Git.Commit message={proposal.commitMessage} as="commit" />
      <Git.Push />
      <PullRequest title={proposal.title} draft={true} as="pullRequest">
        {proposal.report}
      </PullRequest>

      <Agent name={props.planner}>
        <Session name="planner">
          <Agent.AddDir path={props.worktree} />

          <Prompt as="verdictCandidate" throwOnError>
            Repository instructions:

            {props.instructions}

            Authorized plan:

            {props.plan}

            Authorization record:

            {props.authorization.assessment}
            User response: {props.authorization.response}
            Rationale: {props.authorization.rationale}

            Proposed change, as the source that performed it:

            {proposal.changes}

            Implementor report:

            {proposal.report}

            Pull request:

            #{pullRequest.number} ({pullRequest.state}) {pullRequest.url}
            head {pullRequest.headSha} onto base {pullRequest.baseSha}
            commit {commit}

            Result contract:

            {pullRequestVerdictSchema}

            Review the change at {pullRequest.headSha} against
            {pullRequest.baseSha}, together with the authorized plan, the
            instruction content above, and the registered checkout. You have no
            network access: everything you may judge is either rendered here or
            readable in the checkout.

            A verdict is about one head. If the head moves, this verdict no
            longer describes the pull request and a fresh review is required.

            Classify every finding and include a focused revision prompt when
            the review fails. Return only JSON matching the supplied result
            contract.
          </Prompt>

          <Loop max={2}>
            <SafeParse schema={pullRequestVerdictSchema} as="parsedVerdict">
              {verdictCandidate}
            </SafeParse>

            <If condition={parsedVerdict.ok}>
              <Break />
              <Else>
                <Prompt as="verdictCandidate" throwOnError>
                  Correct your previous response without changing its meaning.
                  Do not use tools or perform additional analysis.

                  Previous response:

                  {verdictCandidate}

                  Validation errors:

                  <Each in={parsedVerdict.errors} let="error">
                  - {error.instancePath}: {error.message}
                  </Each>

                  Result contract:

                  {pullRequestVerdictSchema}

                  Return only corrected JSON.
                </Prompt>
              </Else>
            </If>
          </Loop>

          <Parse schema={pullRequestVerdictSchema} as="verdict">
            {verdictCandidate}
          </Parse>
        </Session>
      </Agent>

      <Capture as="checkpointMaterial">
        ## Authorized plan

        {props.plan}

        ## Change performed

        Commit {commit} on the workflow branch, pushed before the pull request
        was opened.

        {proposal.changes}

        ## Pull request

        #{pullRequest.number} ({pullRequest.state}) {pullRequest.url}
        head {pullRequest.headSha} onto base {pullRequest.baseSha}

        ## Planner review

        Passed: {verdict.passed}

        {verdict.review}

        ## What approval performs

        Revision prompt sent to the implementor when the verdict has not passed:

        {verdict.revisionPrompt}

        A finding whose disposition is `defer` becomes an issue, with the
        evidence shown beneath it.

        <Each in={verdict.findings} let="finding">
        ### {finding.title}

        Disposition: {finding.disposition}

        {finding.description}

        Evidence:

        <Each in={finding.evidence} let="item">
        - {item}
        </Each>
        </Each>
      </Capture>
      <UserCheckpoint
        purpose="resolve the pull-request review"
        agent={props.planner}
        material={checkpointMaterial}
        as="reviewCheckpoint"
      />
      <If condition={reviewCheckpoint.proceed}>
        <Each in={verdict.findings} let="finding">
          <If condition={finding.disposition === "defer"}>
            <Issue
              pullRequest={pullRequest}
              finding={finding}
            />
          </If>
        </Each>
        <If condition={verdict.passed}>
          <Break />
          <Else>
            <Prompt>
              Revise the implementation using this review:

              {verdict.review}

              Focused revision prompt:

              {verdict.revisionPrompt}

              User involvement record:

              {reviewCheckpoint.assessment}
              User response: {reviewCheckpoint.response}
              Rationale: {reviewCheckpoint.rationale}
            </Prompt>
          </Else>
        </If>
        <Else>
          <Break />
        </Else>
      </If>
    </Loop>
  </Session>
</Agent>

<Return value={{
  report: checkpointMaterial,
  verdictPassed: verdict.passed,
  review: verdict.review,
  revisionPrompt: verdict.revisionPrompt,
  findings: verdict.findings,
  decision: reviewCheckpoint
}} />

## Agents inspect; XMD mutates

The implementor's proposal is XMD source, and `<Expand>` is what runs it (#369;
the public component name is still open, and the workflow Workspace
specification uses this spelling as a placeholder). The evaluator parses the
complete fragment before its first effect, resolves the allowlist to pinned
component identities supplied by this document, refuses everything outside that
set — eval and exec blocks, imports, native execution, arbitrary JavaScript
expressions — and only then expands what it admitted. Rejected syntax produces
no partial effect.

The allowlist is authority, not prompting guidance. It admits `<Dir>`, `<File>`,
and `<DeleteFile>` and nothing else, so a fragment cannot stage, commit, push,
open a pull request, or reach a secret by naming a component. `<Git.Add>` in
particular stays out: what gets staged and committed is this document's decision,
not the proposal's.

The exact filtered generated source is retained, so a replay expands the same
fragment without asking the implementor again — and so the source is available to
the reviewer and to the user as the literal description of what happened.

Being lexically inside `<Agent>` selects an agent for nested prompts and grants
that agent nothing. `<Expand>`, `<Git.Add>`, `<Git.Commit>`, `<Git.Push>`, and
`<PullRequest>` are XMD's own effects against the authoritative Workspace; the
agent process never sees them and could not perform them.

`<Agent.AddDir>` registers the checkout with each session that has to read it.
The implementor's registration sits outside the loop so it happens once;
the planner's sits inside, so it repeats per iteration. Re-registering a path a
session already holds has to be idempotent for that to be safe — the ordered
directory set must stay the same set — which is a requirement on #302 rather
than something this document can guarantee.

## Every mutation is one effect, and pushing is separate

Each step is one expansion, one effect, and one transaction:

```text
<Expand>       → each admitted <File> publishes its mutation, the resulting
                 logical Workspace root, and its journal result together
<Git.Add>      → stages explicit paths; "." is written explicitly because
                 omission never means all paths
<Git.Commit>   → commits only the staged index, fails when nothing is staged,
                 and journals reconciliation evidence: repository and worktree
                 identity, branch, commit and parent SHAs, tree SHA, staged
                 paths, message evidence — not Git object contents
<Git.Push>     → an external effect; the remote ref cannot join the local
                 transaction, so it observes remote state and adopts, performs,
                 or fails, and never force-pushes
<PullRequest>  → requires that pushed head; it never pushes on its own
```

Push is explicit precisely so that neither `<Git.Commit>` nor `<PullRequest>`
hides remote mutation (#370). Replaying a completed commit creates no second
commit and replaying a completed push performs no remote mutation; resuming
after uncertain completion reconciles against retained state rather than
repeating the effect (#294, #297).

**Open question for #295 and #297.** A revision iteration commits again, pushes
the same branch again, and reaches `<PullRequest>` again under a new expansion
identity. The reconciliation that keeps that from opening a second pull request
is the effect-specific natural key — repository, head branch, base — rather than
expansion identity alone. A head that advanced on the same branch is the normal
shape of a revision, not a conflict, and #295's "conflicting head is diagnosed"
needs to distinguish the two.

## The reviewer sees what it judges

The planner has no network access, so whatever the prompt does not render is
invisible to the review. What the prompt renders is the proposal source that
performed the change, the implementor's report, and the pull request's identity —
number, URL, state, head SHA, base SHA — together with the checkout the planner
can read directly.

`<PullRequest>`'s creation result is deliberately minimal (#295): stable provider
identity, number, URL, state, head SHA and base SHA. Reviews, comments and check
results are *not* fields on it, because a creation result that pretended to stay
fresh would be lying about a remote that keeps changing. They are separate reads.

**Missing: that read.** No component or issue defines the forge observation that
returns existing reviews, comments and check results for a pull request. The
requirement is unchanged and worth stating exactly, because it is what makes the
review adversarial rather than uninformed:

- the reviewer must receive every existing review with its body, every comment,
  and every check result, iterated rather than stringified; and
- the user's checkpoint must carry the same consequential content, so a person
  approving the change reads the original objections in their own words rather
  than the planner's summary of them.

Until that read exists, this stage reviews the change it just made against the
plan and the checkout, and an objection raised by anyone other than the planner
does not reach either surface.

The verdict names one head. The prompt reviews the change at `headSha` against
`baseSha`, and a moved head requires a fresh review — the same rule #295 states
for a stored verdict.

## The stage returns its control state

Like `Planning`, this is a **value component**: it resolves a user decision
internally, so it returns that decision rather than a rendering of it. It hands
back the complete `reviewCheckpoint` decision and the parsed verdict's fields,
and nothing derived from them. The caller reads
`decision.proceed && verdictPassed` directly, so there is no second copy of that
answer to disagree with the first.

The pull-request handle stays internal. `start.md` gates on the verdict and the
decision rather than on forge state, and the filtered journal records the
external effect independently. A return field typed `string` would be worse than
useless — a conforming `<PullRequest>` would perform its external effect and only
then fail this component's return validation. If a later caller genuinely needs
the handle, it is declared with #295's object schema, never a placeholder.

There is no `changedFiles` field in the proposal either, and for the same reason
the stage returns no `authorized` flag: the fragment already says what it writes,
and a second list is one no schema could hold in agreement with the first. What
was actually staged and committed is `<Git.Commit>`'s journaled evidence.

This component declares `returns`, so it contains no `<Output>` and its whole
body runs fail-fast: the final `<Parse>` in each repair loop ends the stage
rather than passing malformed data to a durable effect, and a failure binds
nothing at all.

The user's decision outranks the verdict here too. `reviewCheckpoint.proceed` is
read before `verdict.passed`, so a declined pull-request review leaves the loop
without revising the implementation and without reporting it as reviewed. The
stage is reached at all only because `start.md` gated it on
`planning.decision.proceed && planning.verdictPassed` and then on
`authorization.proceed`.

After the loop, `decision.proceed` true with `verdictPassed` false is what
exhaustion looks like: the user kept approving and the verdict never passed. The
caller's gate rejects that pair, so an exhausted review cannot reach acceptance
and starts no later durable effect. As in `Planning`, exhaustion is a request
for user direction rather than a terminal answer of the stage's own (#290,
settled); a composed workflow suspends there for it (#367, unbuilt).

## Approval precedes durable effects

Deferred `<Issue>` creation sits **inside** the approved branch, after the
checkpoint. The planner proposes a disposition; the user's approval is what
turns that proposal into a durable forge object. Creating the issues first
would make the planner's classification take effect before anyone approved it,
and an issue is not undone by a later decline.

`proceed: true` authorizes the exact transition and the exact effects proposed
in the material the checkpoint assessed. That rule only means something if the
material actually shows them, so `checkpointMaterial` carries every value an
approval sets in motion, unchanged and unsummarized:

- the **change itself**, as the source that performed it, rather than a
  description of it;
- the **revision prompt** that goes to the implementor when the verdict has not
  passed — the literal `verdict.revisionPrompt`; and
- each finding's **evidence**, because `<Issue>` receives the complete finding
  and a `defer` disposition turns it into a durable forge object.

Approving instructions or evidence the user never read would be the same
authority leak as not asking at all. It is not an invitation to amend them
either: the free-text `response` and `rationale` record the user's reasoning, and
nothing reads them to change which effects run — an effect that already executed
cannot be silently amended by prose. A user who wants different effects declines,
and `proceed: false` performs none of them — no issue, no revision turn, no
acceptance.

The commit, push, and pull request are the one asymmetry, and it is deliberate:
they happen *before* the review checkpoint because the review is a review of a
pull request. What the user authorized earlier, at the authorization checkpoint,
was implementing the plan — which is what those effects carry out. The review
checkpoint then authorizes what comes after the review: the deferred issues, the
revision turn, or acceptance.

## What does not exist yet

| Written above | Supplied by | Status |
| --- | --- | --- |
| `<Agent.AddDir>` and the read-only ceiling | #302 | unbuilt |
| `<Expand>` | #369 | unbuilt; public name open |
| `<Git.Add>`, `<Git.Commit>` | #294 | unbuilt |
| `<Git.Push>` | #370 | unbuilt |
| `<PullRequest>` | #295 | unbuilt |
| `<Issue>` | #296 | unbuilt |
| shared forge reconciliation behind push, pull request and issue | #297 | unbuilt |
| the forge read that returns reviews, comments and checks | — | unowned |

The agent, parsing, capture, and control-flow syntax runs today; the loop body
above does not expand, because those names resolve to nothing. Until they land,
the effects they stand for remain explicit user-run steps between manual stages.

Props are namespaced throughout (#305). `proposal`, `commit`, `pullRequest`,
`verdict`, `checkpointMaterial`, and `reviewCheckpoint` are authored bindings and
stay bare.

## Finding dispositions

1. Fix in the current pull request.
2. Insert a focused repair needed by the remaining pull-request chain.
3. Create a provenance-linked issue when immediate work would derail the chain.
4. Reject an unsupported, unrelated, or intentionally excluded finding.

The planner proposes a disposition and asks the user when scope, urgency, or
impact remains uncertain. The user makes the final decision.
