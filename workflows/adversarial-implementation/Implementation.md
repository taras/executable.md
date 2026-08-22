---
required: [plan, authorization, instructions, planner, implementor, tracker]

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
  tracker: { type: string }

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

The implementor does not edit files, and does not read them either. Under
`xmd workflow` an Agent gets no checkout and no directory of any kind — the host
enforces that, not anything this document writes (#302) — so the implementor
works from the material rendered into its prompt and returns an XMD fragment
describing the change it proposes. A constrained evaluator preflights that fragment and expands
the components it admits, and those expansions are what write files — each one an
ordinary durable effect with its own expansion identity, journal result, and
Workspace transaction. Staging, committing, pushing, and opening the pull request
are separate deterministic effects the document performs afterwards.

That is the whole shape of the stage: **agents inspect; XMD mutates.**

## Target shape

<Let as="proposalSchema" select="code[lang=json]">
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
</Let>

<Let as="pullRequestVerdictSchema" select="code[lang=json]">
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
</Let>

<Let as="pullRequest" value={{}} />

<Agent name={props.implementor}>
  <Session name="implementor">
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
        performs it. You have no repository access and cannot modify anything
        directly; the material above is what you may reason from, and the
        `changes` field is the only way your work takes effect.

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
      <PullRequest
        number={pullRequest.number}
        title={proposal.title}
        draft={true}
        as="pullRequest"
      >
        {proposal.report}
      </PullRequest>

      <Agent name={props.planner}>
        <Session name="planner">
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
            {pullRequest.baseSha}, together with the authorized plan and the
            instruction content above. You have neither repository nor network
            access: everything you may judge is rendered here.

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

      <Let as="checkpointMaterial">
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
      </Let>
      <UserCheckpoint
        purpose="resolve the pull-request review"
        agent={props.planner}
        material={checkpointMaterial}
        as="reviewCheckpoint"
      />
      <If condition={reviewCheckpoint.proceed}>
        <Each in={verdict.findings} let="finding">
          <If condition={finding.disposition === "defer"}>
            <IssueTracker url={props.tracker}>
              <Issue title={finding.title} as="deferredIssue">
                {finding.description}

                Evidence:

                <Each in={finding.evidence} let="item">
                - {item}
                </Each>

                Deferred from pull request #{pullRequest.number}
                ({pullRequest.url}), reviewing {pullRequest.headSha} onto
                {pullRequest.baseSha}.

                The reviewing planner classified this finding as `defer` rather
                than as a revision, and the user approved that disposition:

                {reviewCheckpoint.assessment}
                User response: {reviewCheckpoint.response}
                Rationale: {reviewCheckpoint.rationale}
              </Issue>
            </IssueTracker>
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

The implementor's proposal is XMD source, and `<Expand>` is what runs it — a
documented placeholder, not a component. #369 still owes the public name and the
component itself, and the workflow Workspace specification uses this spelling to
say where one would go.

The evaluator underneath it is built (#497), as trusted-host APIs no document
calls. `evaluateGeneratedXmd()` parses the complete fragment and walks all of it
inside the durable admission before the first effect, resolves an allowlist to
pinned component identities the trusted host supplies, and refuses everything
outside that set — eval and exec blocks, expression props, interpolation that
reads a binding, a result binding, an unadmitted component, and a malformed or
out-of-ceiling request. A refusal names the construct class and never echoes the
generated source. Rejected syntax produces no partial effect: a fragment whose
second element is an executable block performs nothing at all, however safe its
first element was.

The allowlist is authority, not prompting guidance, and a name is not an
identity: resolution consults neither `componentDirs`, nor a registration, nor
the workflow component bundle, so a same-named file beside the checkout answers
nothing. One durable event records the decision before the first admitted
observation, carrying the exact admitted source and the normalized policy, and a
continuation is held to the exact ceilings it was admitted under — so a replay
expands the same fragment without asking the implementor again, and the source
is available to the reviewer and to the user as the literal description of what
happened.

**What is admitted today is observation, not mutation.** #497 shipped pinned
observation identities and exact request ceilings — `<Fetch>` is on the
allowlist only when the run states the requests it may perform, and each
observation is retained by its own ordinary durable effect. The allowlist this
stage writes above asks for `<Dir>`, `<File>` and `<DeleteFile>`, and admission
for a fragment that mutates files is not built. So `<Git.Add>` staying out of it
is this document's decision to keep — what gets staged and committed is this
document's word, not the proposal's — but it is not yet a decision any evaluator
enforces here.

Being lexically inside `<Agent>` selects an agent for nested prompts and grants
that agent nothing. `<Expand>`, `<Git.Add>`, `<Git.Commit>`, `<Git.Push>`, and
`<PullRequest>` are XMD's own effects against the authoritative Workspace; the
agent process never sees them and could not perform them.

Neither session is given a directory. A workflow Agent gets no checkout, no
materialization of one, no Workspace or host path as cwd, and nothing registered
with its session (#302), so both agents here reason over what their prompts
render: the instruction text, the authorized plan, the recorded authorization,
the proposal source, and the pull request's identity. Evidence not rendered is
evidence the stage does not have, and the bounded request/result loop that would
let an agent ask for more belongs to #302 and #369.

## Every mutation is one effect, and pushing is separate

Each step is one expansion, one effect, and one transaction:

```text
<Expand>       → the target shape: each admitted <File> would publish its
                 mutation, the resulting logical Workspace root, and its journal
                 result together. #497 admits observation, not mutation, and
                 #369 still owes the component
<Git.Add>      → stages explicit paths; "." is written explicitly because
                 omission never means all paths
<Git.Commit>   → commits only the staged index, fails when nothing is staged,
                 and journals reconciliation evidence: repository and worktree
                 identity, branch, commit and parent SHAs, tree SHA, staged
                 paths, message evidence — not Git object contents
<Git.Push>     → an external effect; the remote ref cannot join the local
                 transaction, so it observes remote state and adopts, performs,
                 or fails, never force-pushes and never changes upstream
                 tracking. No props, no result, nothing rendered
<PullRequest>  → requires this run's own matching successful Push evidence for
                 the exact Repository, head branch, destination ref and commit;
                 it never pushes on its own and never rewrites the head
```

Push is explicit precisely so that neither `<Git.Commit>` nor `<PullRequest>`
hides remote mutation (#370). Replaying a completed commit creates no second
commit and replaying a completed push performs no remote mutation; resuming
after uncertain completion reconciles against retained state rather than
repeating the effect (#294, #297).

**One invocation creates and updates.** #500 and #504 settle what
`<PullRequest>` does: without `number` it asks for *a* pull request from this
head to this base, creating one or adopting the compatible one an interrupted
earlier attempt created; with `number` it asks for *that* pull request, and
brings its title, body, draft state and base to what the invocation says. Which
of the two it is, is the document's own word rather than a search.

A revision iteration commits again, so the head it asks about is not the head
the existing pull request holds — which is why an unnumbered second request
would be a **conflict** rather than an update: it asked for one to exist, not
for whatever is there to become this. The loop therefore says which one it
means. `<Let as="pullRequest" value={{}} />` seeds the binding once, before the
loop — a direct value rather than rendered content (#528, shipped). On the first
iteration `pullRequest.number` is `undefined`, so `number` is omitted and the
unnumbered create-or-adopt contract applies; the successful result replaces the
seed through ordinary `as` binding, and every later iteration passes the
retained positive number and selects the numbered update contract for that exact
pull request. `<Loop>` opens no binding scope, which is what lets one iteration
read what the previous one bound.

The seed is shipped; the omission it relies on is not. `<Let value>` binds the
empty object and nothing more — it does not make an ordinary component prop
whose expression evaluates to `undefined` become omitted. That is the engine
contract **#301's amendment settles and nothing has built yet**: such a prop is
omitted before prop validation and before the durable JSON boundary, so the
component never receives `undefined` and no journal or replay stores it. A
required prop that evaluates to `undefined` still fails validation as missing,
`null` stays an explicit value passed only where a schema accepts it, and an
unbound name still fails. Today the engine refuses such a prop instead of
omitting it, so the seeded `number={pullRequest.number}` is still the one part
of this loop that does not run.

## The reviewer sees what it judges

The planner has no network access, so whatever the prompt does not render is
invisible to the review. What the prompt renders is the proposal source that
performed the change, the implementor's report, and the pull request's identity —
number, URL, state, head SHA, base SHA — and nothing the planner could read for
itself, because it can read nothing.

`<PullRequest>`'s creation result is deliberately minimal (#295): stable provider
identity, number, URL, state, head SHA and base SHA. Reviews, comments and check
results are *not* fields on it, because a creation result that pretended to stay
fresh would be lying about a remote that keeps changing. They are separate reads.

**That read has a component now.** `<Fetch>` reads over HTTP from Markdown and
retains what it read (#456, shipped), which is what a network-denied reviewer
needs: the document fetches a pull request's existing reviews, comments and
check results and renders them into the prompt, while the Agent itself stays
denied the network. The requirement is unchanged and still worth stating
exactly, because it is what makes the review adversarial rather than uninformed:

- the reviewer must receive every existing review with its body, every comment,
  and every check result, iterated rather than stringified; and
- the user's checkpoint must carry the same consequential content, so a person
  approving the change reads the original objections in their own words rather
  than the planner's summary of them.

This stage does not write those fetches yet, so today it reviews the change it
just made against the plan and the material rendered into the prompt, and an
objection raised by anyone other than the planner reaches neither surface. A
generated fragment can carry `<Fetch>` only when the run's own policy states the
exact requests it may perform (#497); the public component a document would
write to expand such a fragment stays #369's.

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
useless — `<PullRequest>` would perform its external effect and only then fail
this component's return validation. If a later caller genuinely needs the
handle, it is declared with #295's settled object schema, never a placeholder.

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
settled); a composed workflow suspends there for it (#367, shipped).

## Approval precedes durable effects

Deferred issue creation sits **inside** the approved branch, after the
checkpoint. `<IssueTracker url={props.tracker}>` names the container the issues
belong in and `<Issue title={finding.title} as="deferredIssue">` renders the
description as its body, binding `{ url }` and nothing else. The authored
tracker URL selects a target; it grants no authority. The workflow host installs
an adapter-private ceiling beside its credentials, and a target outside that
ceiling fails before any provider observes anything — so a document can write
any URL here and reach nothing the host had not already allowed. `IssueApi` is
its own boundary: a tracker is not a Repository, and no Git effect is involved
in filing one. The planner proposes a disposition; the user's approval is what
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
- each finding's **evidence**, because a `defer` disposition renders that
  finding into a durable forge object and the issue body carries it.

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
| `<Expand>` | #369 | unbuilt; public name open. The evaluator under it is shipped (#497), for observation only |
| `<IssueTracker>`, `<Issue>` | #296, delivered by #516 | shipped — registered by the workflow host |
| `<Git.Push>` | delivered by #495 | shipped — registered by the workflow host |
| `<PullRequest>` | #295, delivered by #500 and #504 | shipped — registered by the workflow host |
| omitting an expression prop that evaluates to `undefined` | #301 | unbuilt — the loop's `number={pullRequest.number}` depends on it |
| `<Git.Add>`, staged-only `<Git.Commit>` | #294 | shipped |
| shared Git-host reconciliation behind push, pull request and issue | #297 | shipped — the surface, and now the push and pull-request components over it |
| the forge read that returns reviews, comments and checks | `<Fetch>` (#456) | shipped — this stage does not write it yet |

The agent, parsing, binding, and control-flow syntax runs today, and so do the
forge effects: `<Git.Add>`, `<Git.Commit>`, `<Git.Push>`, `<PullRequest>`,
`<IssueTracker>` and `<Issue>` are all built and registered by the workflow
host.

The loop body above still does not expand, and it is worth separating the two
reasons. **One name resolves to nothing** — `<Expand>` (#369) — and one **engine
capability is unbuilt**: omitting an expression prop that evaluates to
`undefined` (#301), which the seeded `number={pullRequest.number}` needs on its
first pass. Neither is a statement about the forge components. Those are
shipped, and this stage still cannot reach them, because the `<Expand>` that
would produce the change to stage and commit comes first. A shipped component
behind an unbuilt prerequisite is unreachable here, not unbuilt — and the
deferred-issue path is the furthest one back, since it also waits on the review
that only a real change produces. Until the prerequisites land, the effects this
stage stands for remain explicit user-run steps between manual stages.

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
