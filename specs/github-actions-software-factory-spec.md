# GitHub Actions-hosted AI Software Factory

This specification defines an issue-driven software factory whose durable
procedure is an XMD workflow and whose invocation host is GitHub Actions. One
GitHub Project item shows who owns the work now; the retained XMD run proves how
the item reached that owner.

The factory has no independent controller. GitHub Actions starts or resumes the
XMD workflow and supplies an authorized GitHub environment. The XMD workflow
invokes roles, validates their structured outcomes, records handoffs, performs
authorized GitHub and Workspace effects, updates the Project status, and
journals those effects.

## 1. One item, one durable run

One issue corresponds to one durable XMD factory run. The run may produce and
review many implementation revisions before it closes; a new implementation
commit never creates a new factory run.

Two SHA identities remain separate throughout that run:

- The **workflow definition SHA** is the immutable Git commit in the XMD
  workflow definition. It fixes the procedure and its component bundle for the
  lifetime of the run. A different definition is not a revision of the same
  run; it requires a new run or an eligible history fork under the workflow
  lifecycle contract.
- The **implementation revision** is the evolving pair
  `{ headSha, baseSha }`. `headSha` is the exact commit at the draft pull
  request's head, and `baseSha` is the exact target-branch commit against which
  that head is evaluated.

The definition SHA authorizes which procedure executes. The implementation
revision identifies what the procedure is currently producing or reviewing.
Neither substitutes for the other, and neither a Project field nor a comment
may rewrite either identity.

## 2. Lifecycle and validation frontier

The Project status has these values:

| Stage | Status | Owner | Question answered |
| ---: | --- | --- | --- |
| 0 | Backlog | User | Is this item admitted to the factory? |
| 1 | Product Owner | User | What product outcome and acceptance boundary are intended? |
| 2 | Architect | Architect | Is the structural contract ready? |
| 3 | Planner | Planner | Is there an implementation-ready plan and evidence matrix? |
| 4 | Implementor | Implementor | Does an implementation revision satisfy the accepted plan? |
| 5 | Planner Review | Planner | Does this exact revision satisfy the frozen acceptance criteria? |
| 6 | Architect Review | Architect | Does this exact revision satisfy the frozen structural checklist? |
| 7 | User Review | User | Is this exact validated result accepted? |
| 8 | Closed | None | Was the item merged or abandoned? |

The left side progressively removes uncertainty: product intent, structural
contract, implementation plan, then code. The right side validates the result:
implementation evidence, structural correctness, user acceptance, then
completion.

Moving an authorized Backlog item to Product Owner admits it and starts its
factory run. Once admitted, an ordinary successful outcome advances exactly one
stage:

```text
1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8
```

No role may pass an item over an intermediate role. The XMD workflow rejects an
outcome that attempts to advance by more than one stage. It commits the current
stage's handoff before invoking the next role, so the next role receives the
accepted chain rather than an uncommitted result.

The **validation frontier** is the latest active chain of accepted handoffs.
Every stage receives that chain and adds one decision. Invalidated conclusions
remain historical records, but they are outside the active frontier and cannot
authorize later progress.

### 2.1 Same-stage iteration

Self-correction is iteration, not progress:

- An Architect amending the structural contract remains at Stage 2 until the
  amended contract passes readiness.
- A Planner amending the issue or plan remains at Stage 3 until the latest plan
  passes.
- An Implementor producing, synchronizing, or correcting an implementation
  remains at Stage 4 until the latest implementation revision passes.
- A reviewer replacing a malformed or incomplete verdict remains at that
  review stage until a valid verdict identifies the exact revision reviewed.

The role's latest accepted same-stage output supersedes its earlier output at
the active frontier without erasing history.

### 2.2 Backward invalidation

A backward transition jumps to the earliest contract the new information
invalidates. Forward progress then traverses every later stage again:

| Returned to | Still valid | Must run again |
| --- | --- | --- |
| Product Owner (1) | Nothing downstream | 2-7 |
| Architect (2) | Product decision | 2-7 |
| Planner (3) | Product decision and architecture | 3-7 |
| Implementor (4) | Product decision, architecture, and plan | 4-7 |
| Planner Review (5) | The implementation revision | 5-7 |
| Architect Review (6) | The Planner verdict for that revision | 6-7 |

The workflow validates a backward outcome against this frontier. The role
supplies the reason and earliest invalidated stage; the XMD procedure decides
which accepted downstream handoffs become inactive and records that decision.
A Project edit alone never proves invalidation or approval.

### 2.3 Revision invalidation

Every Stage 5, Stage 6, and Stage 7 conclusion identifies the exact
`{ headSha, baseSha }` it evaluated.

- Any merge, rebase, manual edit, generated mutation, conflict resolution, or
  other change to `headSha` remains at or returns to Stage 4 and invalidates
  Stages 5-7.
- Movement of `baseSha` without a head change invalidates the review context at
  Stage 5. The item repeats Stages 5-7 against the new pair when no
  synchronization or implementation correction is required.
- When base movement requires synchronization, conflict resolution, or an
  implementation change, the item returns to Stage 4 and repeats Stages 4-7.
- An invalidated Planner verdict returns to Stage 5. An invalidated Architect
  verdict returns to Stage 6.

Stage 6 may accept a Planner verdict only when that verdict names the same
implementation revision. Stage 7 may accept the review chain only when both
review verdicts name the current revision. A later SHA never inherits a verdict
for an earlier pair.

The workflow definition SHA does not participate in this invalidation table.
Definition incompatibility is a workflow lifecycle refusal, not an
implementation correction.

## 3. Durable procedure and GitHub projection

The XMD workflow is the only procedure that may change the factory stage. On a
start or resume it:

1. acquires the durable run's executor lock;
2. restores the retained workflow definition, Workspace, handoff chain, and
   incomplete effects;
3. observes the issue, draft pull request, Project item, and exact Git revision
   identities required by the current stage;
4. reconciles interrupted GitHub effects under their retained identities;
5. renders the active handoff chain and authorized observations to the current
   role;
6. validates the role's structured outcome against the current stage, artifact
   identities, and implementation revision;
7. records a same-stage iteration or invalidates the frontier, or performs the
   immediately adjacent successful transition;
8. performs the authorized issue, pull-request, Git, and Project effects; and
9. journals the accepted decision and every effect before yielding the next
   durable boundary.

GitHub Actions supplies the trusted executable, the definition reference, the
run identity, and credentials or provider configuration within a fixed ceiling.
Its YAML does not parse role conclusions, choose stages, construct handoffs,
change draft state, merge, comment, or update the Project independently of the
XMD workflow.

Actions concurrency may reduce duplicate invocations, but it is not the
executor lock and cannot authorize a transition. A second invocation of the
same item follows or is refused by the durable run lifecycle.

The Project status is a human-facing projection of the journaled current stage.
Issue and pull-request comments are human-readable transition records. The XMD
journal is the durable execution record of which source records were accepted,
which role conclusion won, and which external effects completed. A Project
status ahead of the journal is drift, not proof that omitted roles passed.

GitHub offers no transaction spanning a comment, draft state, Project status,
branch update, or merge and the retained XMD store. Each is therefore a durable
external effect with stable identity and reconciliation: observe, adopt an
already-compatible result, perform from proven absence or compatible pre-state,
or refuse conflict and ambiguity. Interruption may leave GitHub ahead of the
local result; resume reconciles the same intended effect rather than repeating
it blindly.

## 4. Issue and draft pull-request boundary

The issue owns product intent, architecture, planning, and the transition into
implementation.

- Stage 1-3 iterations and accepted handoffs are full issue comments.
- The accepted Stage 3 -> 4 handoff on the issue names the plan and evidence
  matrix the Implementor receives.
- The issue remains the source of those upstream contracts after a draft pull
  request exists.

Stage 4 creates or updates a draft pull request before its first handoff to
Planner Review. The Stage 4 -> 5 handoff identifies the draft pull request and
its exact `{ headSha, baseSha }`. The draft pull request then owns implementation
iterations and Stage 5-7 review handoffs.

When invalidation crosses from the pull request to Stages 1-3, the XMD workflow
writes the full handoff on the issue and a short linking record on the pull
request. When the accepted issue chain crosses back into Stage 4, the draft pull
request links the accepted issue handoff before implementation continues.

The pull request remains draft throughout Stage 4 corrections and Stage 5
review. It also remains draft while Stage 6 requests a backward correction.
Only an accepted Stage 6 verdict for the current revision authorizes XMD to make
the pull request ready and move the item to Stage 7. If interruption separates
those GitHub effects, the run remains at its last journaled frontier and resume
reconciles both; ready state alone does not manufacture an Architect verdict.

Stage 7 -> 8 is the adjacent terminal transition. It records `merged` or
`abandoned`, the reviewed implementation revision, the actor and decision that
authorized closure, and the resulting merge identity when one exists. Closing
the Project item never erases the issue, pull request, handoff history, or XMD
journal.

## 5. Stage 4 base synchronization

The initial factory synchronizes a draft implementation branch by merging the
latest observed target base into it. It does not rebase published work.

A merge preserves published commit identities, produces a descendant that the
normal non-force Push effect can publish, and allows the final pull request to
use a squash merge when the repository's delivery policy wants a compact target
history. A rebase changes published identities and requires a separately
specified, reconciled force-with-lease effect. No factory role, generated XMD,
or GitHub Actions step has that effect in the initial contract. Force pushes are
refused.

A clean base synchronization follows this durable sequence:

1. XMD observes and checkpoints the exact implementation head, target base, and
   merge base.
2. XMD performs the trusted merge against those identities inside the retained
   Workspace.
3. XMD records the resulting merge commit and Workspace root as a new
   implementation revision.
4. The item remains at Stage 4 because its head changed.
5. XMD runs the implementation evidence selected by the accepted plan.
6. When that evidence passes, XMD publishes the exact descendant through the
   ordinary non-force Push effect and offers the latest `{ headSha, baseSha }`
   to Planner Review.

The merge, evidence, push, and Stage 4 pass are separate durable effects. No
transaction is claimed across native Git, test processes, GitHub, and the
Project. Resume restores completed effects and continues from the first
uncommitted one.

A manually changed branch is not adopted as a passed implementation. XMD first
observes its new exact head and base, records a new implementation revision,
and re-enters Stage 4. The Implementor and selected evidence evaluate that
revision before it can return to Stage 5.

## 6. Conflict boundary

Tool-less conflict handling grants no tool or checkout to the Agent. The Agent
observes source evidence rendered by XMD and proposes desired file contents;
XMD owns every inspection and mutation.

### 6.1 Durable conflict identity

Before attempting a merge, XMD checkpoints:

- the retained Repository and checkout identity;
- the exact implementation `headSha`;
- the exact target `baseSha`;
- the exact merge-base SHA; and
- the Workspace root against which the merge runs.

A conflicted merge publishes a durable closed result under that request. Its
**conflict identity** is derived from those identities and the normalized
conflict set. Every conflict entry identifies:

- the exact repository-relative path;
- the conflict classification;
- the base, ours, and theirs object identities and modes when Git supplies
  them; and
- the corresponding stage numbers for entries retained in the unmerged index.

The journal retains structured identity and classification, not only rendered
conflict markers. The conflict profile decides what happens to the native merge
state:

- The suspend-on-conflict profile rolls the conflicted checkout back, publishes
  the structured evidence against the unchanged pre-merge Workspace root, and
  enters a durable human wait. It never offers a file mutation under that
  evidence.
- A structured-resolution profile retains the conflicted Git state and its
  Workspace root with the conflict result, or retains provider-owned state that
  reconstructs that exact state and verifies the same conflict identity before
  mutation. A later resume cannot combine evidence from one merge attempt with
  the index of another.

A changed head, target base, merge base, Repository identity, conflict set, or
Workspace root makes the conflict admission stale. XMD discards no remote
history and grants no mutation under that stale identity; it observes the new
revision and restarts Stage 4.

### 6.2 Agent observation and proposal

XMD renders the required conflict evidence and only the related source
observations to the Implementor. The workflow Agent still receives:

- no Git or GitHub operation;
- no filesystem or shell operation;
- no Workspace, checkout, Repository, or host path;
- no native tool; and
- no MCP server carrying equivalent authority.

The Implementor returns generated XMD containing proposed file writes and
deletions. That source is untrusted data until the workflow admits it.

When the structured-resolution profile is installed, conflict resolution adds
a conflict-scoped generated-XMD admission. It is narrower than the workflow
host's ordinary write table:

- every write or deletion must name an exact path in the authorized conflict
  set;
- the recorded Repository, head, base, merge base, conflict identity, and
  Workspace root must still match;
- no generated component may stage, commit, merge, push, invoke a process, read
  a credential, update GitHub, or mutate a non-conflict path; and
- the admitted source and complete ceiling are retained before the first file
  effect.

The Agent decides desired file contents. XMD applies the admitted file effects,
stages the exact conflict scope, verifies that the index contains no unresolved
entries and no unauthorized mutation, creates the merge commit with the
checkpointed head and base as its parents, runs the selected implementation
evidence, and publishes the resulting descendant through the ordinary
non-force Push effect.

The item remains at Stage 4 throughout. A clean result is a new implementation
revision, not a review pass.

### 6.3 Conflict classes

The protocol classifies every conflict before asking the Implementor for a
proposal. Ordinary text conflicts may be admitted by a bounded text-conflict
capability. Binary files, submodules, ambiguous renames, unsafe symbolic links,
unrecognized index forms, and every other unsupported class suspend for human
resolution. A mixed set containing one unsupported entry is unsupported as a
whole; no partial Agent mutation is admitted.

Human resolution occurs outside the workflow Agent's authority. On resume, XMD
accepts the manually changed branch only by observing its new exact
`{ headSha, baseSha }`, recording the manual intervention and re-entering Stage
4. No human edit inherits the conflicted attempt's review conclusions.

## 7. Structural consequences

This factory adds the following structural contracts.

### 7.1 XMD workflow

- The workflow holds one issue lifecycle in one durable run while Stage 4 emits
  zero or more implementation revisions.
- Every role outcome is validated against the current stage and active handoff
  frontier. Review outcomes additionally carry the exact implementation
  revision.
- Stage transition, revision observation, synchronization, conflict handling,
  review, and closure remain authored XMD control flow. GitHub Actions contains
  no parallel decision procedure.
- The trusted definition comes from the run's immutable definition SHA. Draft
  pull-request content never becomes the workflow definition executed with
  GitHub credentials.

### 7.2 Journal

- The immutable workflow definition continues to identify the run.
- The journal additionally retains implementation-revision observations,
  active and invalidated handoffs, exact review subjects, merge checkpoints,
  conflict classifications, conflict-scoped admission ceilings, evidence
  outcomes, pushes, Project updates, and terminal reason.
- A conflict record must be sufficient to reject stale resolution without
  inspecting Agent output or trusting current Project state.
- Exported `.xmd` artifacts remain immutable evidence. They are not the live run
  store, executor lock, or continuation authority used by later Actions jobs.

### 7.3 Workspace and Git effects

- The suspend-on-conflict profile restores the pre-merge Workspace root and
  retains conflict evidence only. A structured-resolution profile must instead
  retain the conflicted Git index and working tree with the journal result that
  identifies them, or retain equivalent provider-owned state from which that
  exact conflict can be reconstructed and reverified.
- A trusted merge effect observes and fixes head, base, and merge base before
  mutation. Clean and conflicted results are distinct closed outcomes.
- Conflict-scoped file writes and deletions use the existing Workspace-local
  transaction boundary but add exact path and conflict-identity ceilings.
- Merge commit creation verifies both parents and the empty conflict set before
  publication. Push remains the existing reconciled non-force effect.
- Rebase and force-with-lease are absent. Adding either later requires a new
  external-effect contract, reconciliation semantics, and invalidation proof;
  it cannot be represented as another spelling of Push.

### 7.4 Invalidation frontier

- A changed implementation head always places the frontier at Stage 4.
- A base-only change places it at Stage 5 unless Stage 4 work is required.
- A merge attempt, conflict proposal, clean merge, manual resolution, evidence
  correction, or push does not advance the item by itself.
- Review approval is keyed by the complete SHA pair, so neither half can drift
  while Stages 5-7 remain accepted.

## 8. Remaining material decisions

### 8.1 Product decision: first-release conflict scope

The remaining product decision for conflict handling is whether the first
factory release implements conflict-scoped generated-XMD resolution for
ordinary text conflicts, or suspends for human resolution on every conflict.

The recommended first release is the smaller contract:

- perform clean merges automatically;
- suspend on every conflict;
- prohibit rebases and force pushes; and
- retain the structured conflict evidence needed to add ordinary text-conflict
  resolution later as a bounded capability.

This release proves the revision, invalidation, merge, non-force publication,
and human-resumption boundaries without making conflicted Workspace state and
conflict-scoped mutation admission prerequisites for the first useful factory.

### 8.2 Deployment architecture decisions

The lifecycle still requires three deployment choices before it can run across
ephemeral GitHub Actions runners:

1. Select a durable WorkflowRun, Workspace, Agent-session, and executor-lock
   provider reachable by every invocation. An Actions artifact is immutable
   evidence and does not satisfy live continuation or locking.
2. Select the authorized ingress for Project admission, human answers, and
   resume requests, including how the GitHub actor is authenticated. That
   ingress may wake Actions but may not interpret role outcomes or own stage
   transitions.
3. Select the GitHub principal and exact repository, pull-request, issue, and
   Project permission ceilings, including who authorizes the Stage 7 merge or
   abandonment and which target-branch merge method is permitted.

These choices configure the host boundary. They do not create a second state
machine and do not transfer procedure authority out of XMD.
