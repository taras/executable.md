# Planner review: remaining R2 boundaries at 14ee0d8e

REQUEST CHANGES at `14ee0d8ed2cf98468e8968fa766f2fb5bfafecf9`, parent
`2cd171929c081cf21c321054edc57b60c37ea1e8`, branch agent/issue-883-pr2.
The signature verifies G for tarasm@gmail.com and the implementation worktree
is clean. R2 is not complete. Cases 1/3/4 and all previously accepted increments
stay closed; latest accepted head remains 2cd17192.

## P1: case 2 does not interrupt the assertion-to-mapping handoff

R2m runs chat-say without a stop, completes turn:1 and its response, then ends
normally. It proves continuation from a completed canonical turn, not recovery
from the frozen first-provider-assertion/pre-mapping interruption. The accepted
Core design makes the canonical Prompt record the conversation history's
identity acknowledgement, so no second CLI mapping record is required. There
is still a window after the provider's durable assertion and before that
canonical record is acknowledged. Drive that window rather than completing
both sides. HC1 separately covers the provider's optional established callback;
do not add such a callback merely to invent a different CLI commit boundary.
The main handoff explicitly says Core recovery evidence does not complete CLI R2.

There is another state that does not cross the new subprocess boundary:
useConversing supplies makeStore() anew in each child. That is an empty in-memory
provider store each time, in addition to the scripted transport. It cannot
demonstrate reattachment from a provider assertion surviving a process ending.
Scripted identical native-one text in two successful replies is not that proof.
Use the existing canonical file-backed provider store under the case's private
data root and interrupt the actual canonical identity acknowledgement after
the provider assertion is durable. Do not create a replacement storage protocol.

R2n does supply useful production-path evidence for the late native-identity
mismatch and subsequent multiple-identity refusal. Preserve it, and preserve
R2m as the ordinary continuation control. The unused boundaries.turn predicate
is a candidate for the actual canonical Prompt acknowledgement stop. Observe
the provider's durable assertion before ending there, and reconcile from that
surviving account in the next process. Do not call the normal R2m completion
an interruption merely because no additional mapping record exists.

The proposed reinterpretation of incompatible creation policy is not accepted.
Core bindConversation compares only logical id and selected agent. That does
not establish provider, resolved command, native identity kind/value and the
retained creation policy required by remaining-architecture.md and
storage-contract.md. A policy can change while id and agent stay the same.
The narrowly scoped Architect return in
pr2-recovery-creation-policy-architect-return.md asks for the existing canonical
binding or the missing boundary ruling. Do not invent a CLI policy fingerprint
or widen a Core request to cover it independently.

## P2: the production reader does not reconcile a missing delivery marker

The new R2q reaches the correct second-feedback-record boundary. However
projectSidekick breaks immediately for turn:null. Both delivered and
unestablished are empty even though the later canonical turn completed with
the offer's exact input. The test compares the two raw strings itself, which
shows evidence exists, not that production reconciles it. An idle reopen
calling no provider would also pass without any reconciliation code.

The independent probe reuses the committed subprocess phases and requires the
production reading to recognize that accepted delivery. It fails with
delivered:[], while the same completed exchange with its ordinary marker passes.
No production mutation or hand-written canonical record supplies this result.
Recognize acceptance from the existing offer and its owning later canonical
turn; do not infer it from a local intent or ordinal alone. Preserve the
unestablished path when canonical acceptance cannot be proved, including refusal
to guess or resend into an unknown accepted-turn state.

## P3: explicit continuation omits the recovered work

R2o genuinely ends with a completed EntryInput and an unanswered Elicit. Cold
reading reports those operations without asking again, and the explicit message
gets response:2. Those observations are accepted evidence. The continuation
does not tell the agent what happened before interruption, though:
owner.respond uses turnRequest with only orientation when needed, the current
draft and the person's message. It does not consume operations or unfinished.

The probe's second regression observes the actual canonical input of the new
turn: "The shared entry draft is empty. ... The person says: ... never mind
that". It contains neither the completed fill acknowledgement nor the unanswered
question. storage-contract.md requires explicit continuation to report
acknowledged effects and interrupted work using the accepted simple feedback
format. A scripted fresh answer cannot establish that requirement by itself.

Include these retained facts with the next explicit request, in operation order,
without another automatic turn, suffix replay, question, fill or entry admission.
Do not restore an old fill over the person's current draft. Describe the actual
current draft separately from the historical acknowledgement. Retain the exact
input and establish delivery canonically; the case-6 correction supplies that
proof. The question remains an unanswered historical operation, not a new form.

## Evidence and limits

The fourteen previously frozen commands were rerun at the exact SHA. Twelve
pass independently, totaling 110 tests/484 steps. Their results are:

| Selection | Result |
| --- | --- |
| bound configuration probe | 1 test / 2 steps |
| Core agent-conversation, agent-components, agent-session-placement, agent-session-use | 12 / 67 |
| ACP host-conversation | 1 / 4 |
| CLI Sidekick configuration, journey, lifecycle, controls, recovery, storage and repl-history | 27 / 152 |
| Sidekick output, entries, route, lifecycle, agent-journey | 38 / 146 |
| forms and presentation-style | 25 / 96 |
| six unchanged metadata/Stop/feedback/owner reviewer probes | 6 / 17 |
| plan, plan-cli, plan-component, plan-host-acts, agent-adapters, agent-options-cli | exit 1: 6 tests/92 steps passed, 3 tests/16 steps failed with registry DNS and disabled __proto__ errors |
| workflow-agent and workflow-agent-sessions | exit 1: npm-cache mkdtemp EPERM followed by adapter-install/pending-event-loop failures; 17 steps passed, 1 failed |

The full commands are the fourteen frozen lines in
pr2-configuration-agent-implementor-prompt.md, with no additional adaptation.
All first outputs are preserved as
pr2-recovery-review-14ee0d8e-{bound,core,acp,focused,consumers,forms,adapters,workflow,metadata,startup,join,receipt,contract,owner}.log.
The two recurring environment failures are not counted green or attributed to
this diff. The Implementor reports all fourteen passing; that is separate
reported evidence, not this environment's result.

Additional command:

```text
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-recovery-contract-probe-14ee0d8e.test.ts
```

It exits 1: missing-marker recovery and continuation reporting fail; the finished
delivery control passes. First complete output is
pr2-recovery-contract-probe-14ee0d8e-first.log. The probe imports the committed
phase helpers by absolute path and leaves the implementation untouched. The
Implementor's reported mutation controls were not repeated. No full suite, CI
inspection, push or GitHub write informs this verdict.

## Continuity and next action

Preserve 14ee0d8e and the useful new subprocess assembly, question/marker stops,
changed-identity case and finished/cold-open control. Follow
pr2-recovery-implementor-correction.md for the bounded correction work. The
creation-policy interpretation is separately returned to the Architect; it is
an existing contract gap, not permission for the Implementor to choose a new
boundary. R2 closure waits for the actual case-2 interruption, production case-6
reconciliation, case-5 continuation reporting and the policy disposition.

Produced artifacts are this review, the correction prompt, Architect return,
independent probe/first output, fourteen command logs and updated main handoff.
No production file was changed. Section 5, remaining R3/R4/R5 integration,
program binding, full terminal R7 and the capture packet remain incomplete.
