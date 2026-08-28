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

<Let as="turnSchema" select="code[lang=json]">
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": { "const": "observation" },
        "source": { "type": "string", "minLength": 1 }
      },
      "required": ["kind", "source"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "kind": { "const": "proposal" },
        "source": { "type": "string", "minLength": 1 }
      },
      "required": ["kind", "source"],
      "additionalProperties": false
    }
  ]
}
```
</Let>

<Let as="proposalEnvelopeSchema" select="code[lang=json]">
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "kind": { "const": "proposal" },
    "source": { "type": "string", "minLength": 1 }
  },
  "required": ["kind", "source"],
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
      <Let as="observation" value={null} />

      <Loop name="observations" max={4}>
        <Prompt as="turnCandidate" throwOnError>
          Repository instructions:

          {props.instructions}

          Authorized plan:

          {props.plan}

          Authorization record:

          {props.authorization.assessment}
          User response: {props.authorization.response}
          Rationale: {props.authorization.rationale}

          Result of your previous request, if any:

          <Json value={observation} />

          You cannot open this repository. You may ask to see part of it, one
          request at a time, by returning an observation; what comes back is
          the result above on your next turn.

          Reply with one JSON object and nothing else, in one of two shapes.

          To read something, return an observation whose `source` is
          Executable.md that reads exactly what you want to see:

          ```json
          {"kind": "observation", "source": "<File path=\"README.md\" />"}
          ```

          An observation may use only self-closing `<File path=... />`
          reads. It may not write, delete, run a command, reach the network, or
          name any other component; a request containing one is refused whole
          and the exchange stops.

          When you have seen enough, return the proposal instead. Its `source`
          is the JSON of your implementation, matching this contract:

          {proposalSchema}

          ```json
          {"kind": "proposal", "source": "<the implementation JSON>"}
          ```

          Inside that JSON, `changes` is Executable.md that performs the work,
          and it is the only way your work takes effect. It may use exactly
          these three forms and nothing else:

          ```md
          <File path="path/to/file.md">the replacement contents</File>

          <Dir path="path/to/directory">
            <File path="inside.md">contents</File>
          </Dir>

          <File.Delete path="obsolete.md" />
          ```

          It may not contain eval or exec blocks, imports, a Git or pull-request
          or issue effect, a command, a network read, or any other component.
          One unadmitted element refuses the whole fragment, and none of its
          writes happen. Report validation and newly discovered scope in
          `report`.
        </Prompt>

        <Parse schema={turnSchema} as="turn">
          {turnCandidate}
        </Parse>

        <If condition={turn.kind === "proposal"}>
          <Break />
          <Else>
            <Evaluate source={turn.source} as="observation" />
          </Else>
        </If>
      </Loop>

      <Parse schema={proposalEnvelopeSchema} as="proposalTurn">
        {turnCandidate}
      </Parse>

      <Let as="proposalCandidate" value={proposalTurn.source} />

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

      <Evaluate source={proposal.changes} allow={["write"]} />
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

      <PullRequest.Reviews url={pullRequest.url} as="reviews" />
      <PullRequest.Comments url={pullRequest.url} as="comments" />
      <PullRequest.Checks url={pullRequest.url} as="checks" />

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

            Reviews already on it:

            <Json value={reviews} />

            Comments already on it:

            <Json value={comments} />

            Checks at the observed head:

            <Json value={checks} />

            Result contract:

            {pullRequestVerdictSchema}

            Review the change at {pullRequest.headSha} against
            {pullRequest.baseSha}, together with the authorized plan, the
            instruction content, and the objections and check results above.
            You have neither repository nor network access: everything you may
            judge is rendered here, and an objection nobody rendered is one this
            review does not have.

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

        ## What the pull request already holds

        These are the exact retained reads the planner reviewed, not a summary
        of them. Reviews:

        <Json value={reviews} />

        Comments:

        <Json value={comments} />

        Checks at the observed head:

        <Json value={checks} />

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

The implementor's proposal is XMD source, and `<Evaluate>` is what runs it. It
is a workflow component the run's host **declares to the execution** rather than
registering with the rest of the composition: canonical execution calls the
host's factory with the claimant it minted and registers what comes back, so a
run whose host declares none has no `<Evaluate>` at all. Being available is not
being authorized — every ceiling comes from values the host captured before any
document existed.

Its schema is closed: a required `source` string, an optional non-empty
duplicate-free `allow` naming the classes `read`, `write`, or both, an ordinary
`as`, and nothing else. It is self-closing and takes no content. **Omitting
`allow` means exactly read-only**, which is the observation form above;
`allow={["write"]}` is written once, on the approved proposal, and selects from
the host's own write table rather than granting anything.

The evaluator underneath it parses the complete fragment and walks all of it
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

**Both classes are admitted, from tables this document cannot reach.** The
standard Deno workflow profile installs a read table of core's self-closing
`<File>` read, and a write table of exactly, in that retained order: core's
paired `<File>` write, this package's lexical `<Dir>`, and core's self-closing
`<File.Delete>`. `allow` selects a class from what the host already installed
and can add nothing to it, and it grants no identity, root, destination,
credential, provider or request. `<Fetch>` is on the read table only when a
trusted host captured a non-empty exact request ceiling; this root's ordinary
attachment supplies none, so a generated fragment here cannot reach the network
at all.

`<Git.Add>` staying outside that table is no longer only this document's
preference — generated local Git, Git-host, issue, process, execution,
credential and external-write effects are outside the admitted class entirely. A
proposal naming one refuses whole, and none of its writes happen. What gets
staged, committed, pushed and opened as a pull request stays this document's
word, written as authored effects after `<Evaluate>`.

A write-only fragment produces no observation entry, receipt or changed-path
list — the evaluator adds none, and its ordinary Workspace effect records are
what is authoritative. That is why the mutation invocation above binds nothing:
its unchanged `{ observations: [], output: "" }` result would say nothing this
run does not already retain.

Being lexically inside `<Agent>` selects an agent for nested prompts and grants
that agent nothing. `<Evaluate>`, `<Git.Add>`, `<Git.Commit>`, `<Git.Push>`, and
`<PullRequest>` are XMD's own effects against the authoritative Workspace; the
agent process never sees them and could not perform them. What the implementor
returns is source, and source is data — it performs nothing until this document
reaches the element that admits it.

Neither session is given a directory. A workflow Agent gets no checkout, no
materialization of one, no Workspace or host path as cwd, and nothing registered
with its session (#302), so both agents here reason over what their prompts
render: the instruction text, the authorized plan, the recorded authorization,
the proposal source, the pull request's identity — and now the results of the
reads it asked for. That last one is the bounded request/result loop #302 and
#369 owed, and it is shipped (#549, #550): the implementor asks in the source it
returns, XMD performs the read, and the detached value comes back into the next
prompt. It still receives no checkout, no materialization, no Workspace or host
path as cwd, no `additionalDirectories`, no MCP server and no native tool. What
it sees is what a read it named returned.

## Every mutation is one effect, and pushing is separate

Each step is one expansion, one effect, and one transaction:

```text
<Evaluate>     → each admitted <File>, <Dir> or <File.Delete> runs as the
                 ordinary component it is, through the run's own effect
                 transactions: a generated deletion publishes the same
                 workspace_file effect an authored one does. The evaluator adds
                 no receipt of its own
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

The seed and the omission it relies on are both shipped. `<Let value>` binds the
empty object and nothing more; what makes an ordinary component prop whose
expression evaluates to `undefined` become omitted is the engine contract
**#537 settles, delivered by #541**: such a prop is omitted before prop
validation and before the durable JSON boundary, so the component never receives
`undefined` and no journal or replay stores it. A
required prop that evaluates to `undefined` still fails validation as missing,
`null` stays an explicit value passed only where a schema accepts it, and an
unbound name still fails. So the seeded `number={pullRequest.number}` runs: the
first pass omits `number` and
takes the unnumbered create-or-adopt path, and every later pass carries the
retained positive number into the numbered update of that exact pull request.

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

**Those reads have their own components, and this stage writes them.**
`<PullRequest.Reviews>`, `<PullRequest.Comments>` and `<PullRequest.Checks>`
each take the bound pull request's own `url` and bind its normalized retained
collection (#576, delivered by #580). They are three independent durable
effects: completing one manufactures neither of the others, each replays alone,
and a completed replay performs no HTTP at all. Nothing about them is
authored twice — no repository, no number, no credential — because the URL the
upsert already returned is what names the subject.

The requirement they satisfy is what makes the review adversarial rather than
uninformed, and both halves of it are now met:

- the reviewer receives every existing review with its body, every comment, and
  every check result at the observed head, rendered as the exact retained values
  through `<Json>` rather than stringified or summarized; and
- the user's checkpoint carries the same collections, so a person approving the
  change reads the original objections in their own words rather than the
  planner's account of them.

The Agent stays denied the network throughout: the document performs the reads
and renders their results. A generated fragment reaches none of them — they are
outside the admitted effect classes entirely.

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
settled).

**It is not a suspension.** Every `reviewCheckpoint` above is an ordinary
`<Elicit>`, and under `xmd workflow` the host's own registration suspends the
run there durably (#577, shipped) — one retained request, the run settled
`suspended`, the executor lock released, and continuation only through
`xmd workflow answer` and an ordinary resume a person or a trusted host asks
for. Exhaustion happens
after the fifth of those checkpoints has already been answered, so nothing is
pending and nothing waits: the stage returns the pair, the caller's gate refuses
it, and the root reports awaiting direction as the end of that run. No second
wait is created to ask about it, and nothing continues it on its own: there is
no watcher, and the explicit scheduler #300 built decides only *when* an
ordinary resume runs, never whether an unanswered run should continue.

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

## Every name here is built

| Written above | Supplied by | Status |
| --- | --- | --- |
| `<Evaluate source allow>` and the authored observation loop | #302 and #369, delivered by #549, #550 and #572 | shipped — declared to the execution by the workflow host |
| generated Workspace mutation admission, by class and authored form | #369, delivered by #572 | shipped — paired `<File>`, lexical `<Dir>` |
| generated `<File.Delete>` admission | delivered by #574 | shipped — under the `write` class |
| ordinary `<File.Delete>` | delivered by #570 | shipped — core registered component |
| omitting an expression prop that evaluates to `undefined` | #537, delivered by #541 | shipped |
| `<IssueTracker>`, `<Issue>` | #296, delivered by #516 | shipped — registered by the workflow host |
| `<Git.Push>` | delivered by #495 | shipped — registered by the workflow host |
| `<PullRequest>` | #295, delivered by #500 and #504 | shipped — registered by the workflow host |
| `<Git.Add>`, staged-only `<Git.Commit>` | #294 | shipped |
| shared Git-host reconciliation behind push and pull request | #297 | shipped — the surface, and the two components over it; `<Issue>` reconciles through its own provider-neutral `IssueApi` instead |
| `<PullRequest.Reviews>`, `<PullRequest.Comments>`, `<PullRequest.Checks>` | #576, delivered by #580 | shipped — URL-addressed reads of the bound pull request, written by this stage |
| a durable checkpoint that suspends the run and releases the executor | #577 | shipped — the workflow host's own `<Elicit>` registration |

There is no longer an unbuilt name in this stage. The agent, parsing, binding
and control-flow syntax runs; the observation loop runs; the admitted mutation
runs; and the Git, pull-request and issue effects after it are all registered by
the workflow host.

What remains bounded is the **class** a generated fragment may name, which is
not the same thing as something being missing. Its writes are Workspace file
writes, directory composition and single-file deletion. Generated local Git,
Git-host, issue, process, execution, credential and external-write effects are
outside that class and refuse the fragment whole, which is why this document
performs them itself, as authored effects after `<Evaluate>`.

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
