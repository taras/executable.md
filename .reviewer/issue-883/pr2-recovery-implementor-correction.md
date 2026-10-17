# Implementor correction: finish R2 through the production recovery paths

Review update at 87b25a40915a697a580e619072d433c9c676fec0: the actual
persistent-store interruption, missing-marker recognition and recovered-work
report pass. The unresolved-acceptance refusal in section 2 is still missing.
Continue under pr2-recovery-unknown-implementor-correction.md; the earlier
instructions and first outputs remain as the historical assignment/evidence.
Creation-policy compatibility stays with the Architect.

Continue from `14ee0d8ed2cf98468e8968fa766f2fb5bfafecf9` on
agent/issue-883-pr2. The Planner verdict is REQUEST CHANGES in
pr2-recovery-planner-review-14ee0d8e.md. Preserve the commit and all earlier
accepted work. Section 5 is not the next assignment yet.

## 1. Recover the provider assertion before mapping acknowledgement

Keep R2m as the completed-turn continuation control. Add the actual frozen
case-2 interruption through the existing real Sidekick owner and canonical
ACPX provider. The accepted Core design uses the canonical Prompt record as
the conversation history's identity acknowledgement. Suspend its append after
the provider's assertion is durable and end the writer process, rather than
completing the turn and response or throwing an ordinary handled error. The
existing boundaries.turn predicate is a candidate stop; prove the record it
holds is the intended one and that the provider assertion already exists.

Use createAcpxSessionStore from @executablemd/acp, rooted under this test's
private data root, so the provider's account actually survives the child ending.
The scriptable runtime must write/load that canonical store at its ordinary
runtime boundary; a newly allocated makeStore in each process cannot supply
surviving assertions. Do not add a second journal, owner, mapping algorithm or
store encoding. Do not add an optional host established callback just to create
a commit boundary absent from this CLI assembly. No public production interface
extension is authorized by this test.

Before ending, observe acceptance and the provider's durable native assertion
while the canonical acknowledgement is still held. On cold reopen require no
provider work or appends. On explicit new work require reconciliation to that
same assertion, no replacement, no resend of the interrupted person's prompt,
and the same canonical conversation. Keep R2n's real late-identity mismatch and
multiple-identity refusal. Do not confuse the canonical acknowledgement with
the provider's separate optional established callback covered by HC1.

Creation-policy compatibility is not synonymous with id/agent equality. It is
returned to the Architect in pr2-recovery-creation-policy-architect-return.md.
Do not choose a new policy representation or weaken that frozen requirement.
Complete the independent corrections below while that boundary is resolved;
report the policy item as open rather than calling R2 complete.

## 2. Reconcile delivery in production

The retained turn:null record is an offer, not proof of acceptance. Preserve
that rule, but stop dropping the offer from recovery. Match it to the owning
later completed canonical turn using the same conversation, chronological
position/response ownership and the exact canonical input. A prior unrelated
turn with identical text is not evidence for this offer. Do not guess an
ordinal, trust a local marker or select arbitrarily among ambiguous matches.

When those facts establish acceptance, production's detached reading must
recognize the delivery even if its ordinary marker never landed. Cold projection
still writes nothing and sends nothing. A later explicit action must not resend
that accepted feedback. When acceptance cannot be established, retain an
unresolved fact and refuse continuation that would require guessing the status
of an accepted provider turn. Do not turn unknown into delivered or silently
drop it because the old cycle no longer exists.

Use the existing records and canonical Prompt reader. No new transport envelope
or exactly-once promise is needed. Keep non-null-marker exact-input checks and
all prior projection controls.

## 3. Report interrupted response facts on explicit continuation

Keep the real held-question scenario and its cold-open assertions. Before the
next explicit message is sent, compose the completed operations and unanswered
question from retained records into the existing simple feedback/context for
that request. In this scenario the agent must receive the EntryInput
acknowledgement and the Elicit question that nobody answered, in operation
order, alongside the person's new message and actual current draft.

This is one explicit continuation turn, not an automatic recovery turn. Start a
fresh response; do not evaluate the old suffix, fill again, ask again, invent an
answer/outcome or overwrite current human draft text with an old fill. Use the
existing per-control result renderer rather than serializing internal ids,
ordinals or Result wrappers. Retain exactly what the turn was sent and use the
production delivery reconciliation above to distinguish delivered from unknown
facts. Already established delivery does not justify sending the same feedback
again.

## Finite evidence and feedback

Run the independent pr2-recovery-contract-probe-14ee0d8e.test.ts unchanged.
Both regressions and the completed-delivery control must pass. Integrate those
observations into R2q and R2o respectively; remove assertions that empty delivery
state itself proves reconciliation. Assert the actual canonical next input,
not only a scripted fresh reply. Keep the completed exchange's zero-provider,
byte-identical cold-open control.

Add one unknown-acceptance arm for the existing case-6 boundary. Its observation
is a production unresolved/refusal result with no blind resend; it is not a new
crash matrix. Add the actual case-2 held acknowledgement described above and
keep R2m as its normal control. Restore each correction once to show its own
regression fails while the paired control stays green; print/verify the mutation
before interpreting it.

Rerun the fourteen focused commands frozen in
pr2-configuration-agent-implementor-prompt.md, plus:

```text
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-recovery-contract-probe-14ee0d8e.test.ts
```

No full suite, check, lint or CI result is required for the feedback commit.
Preserve first outputs and report recurring local DNS/__proto__/npm-cache
restrictions separately; do not rewrite unrelated tests or count them green.
Commit promptly when the discriminating correction evidence passes, even if
the Architect's policy item is separately pending. Return the exact signed SHA,
parent, branch, tree status, every command/result, the actual held mapping
boundary, production delivery classification and actual continuation input.
State the remaining policy item explicitly until its ruling is implemented and
verified. Stop for review. No push, GitHub write or CI inspection is authorized.

Exact base is 14ee0d8e; latest accepted head is 2cd17192. Produced artifacts
are the companion review, this correction prompt, Architect return, independent
probe/first output and updated main handoff. R2 cases 1/3/4 and previously
accepted configuration, questions, Stop, feedback, metadata and admission remain
closed. R2 as a whole and section 5 remain incomplete.
