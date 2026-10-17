# Proposed vocabulary disposition for the R2 correction

Historical, unapproved proposal. The Product Owner requested individual
interviews and accepted message ID, feedback text/reference text, and records
for this request. Current decisions are in
pr2-recovery-message-vocabulary-decisions.md; all three items are settled.
Do not treat the recommendations below as accepted terminology.

Status: awaiting Product Owner approval of the exact terminology entry below.
This records a proposal, not an addition to the approved registry. Exact
implementation base remains signed 87b25a40915a697a580e619072d433c9c676fec0;
the implementation worktree is clean and unchanged.

The correlation architecture and MC1–MC4 remain settled. The interview does not
expose a new identity, persistence or ownership decision. Message and turn keep
their accepted fields, and all wire schemas remain unchanged. The existing
unresolved-acceptance refusal remains assigned.

## Recommended wording

Use **local message number** for the number retained in MessageRecord.turn and
exposed as person.message. This describes the already accepted message identity
without making claim a new technical noun. It stays conversation-scoped, need
not be contiguous and establishes no canonical turn association.

Use **reference record** for the retained orientation context and **feedback
record with turn:null** for the delivery text written before a carrying turn.
These already named record shapes have different jobs. Neither record alone
establishes delivery. Their shared lack of delivery evidence does not require a
new general offer abstraction or a terminology entry covering both.

Register only the newly named span used by the accepted association mechanism:

| Term | Meaning |
| --- | --- |
| request interval | the span of one conversation's ordered history from an initiating person-message record or feedback record with turn:null up to, but excluding, the next such record in that conversation. At most one canonical agent_prompt outcome belongs to it; no outcome leaves the canonical turn association unknown, and multiple outcomes require explicit history refusal. |

The existing Architect decision supplies the detailed association rules,
including a recovered-feedback record immediately before a message yielding
the initiating position to that message. This terminology entry names that
accepted mechanism; it does not change it.

## Scope and permission

architecture.md's Terminology rule says: "If a concept or term is missing, ask
for permission before using it; using it requires adding it here first."
It states no general exemption for CLI-private concepts. Architecture rule 2
delegates local helpers and implementation structure unless they introduce a
new architectural concept; it does not waive this terminology rule.

Occurrence counts alone do not establish that claim or offer was approved as
the technical name of these particular retained facts. Conversely, this return
does not require a repository-wide rewrite of ordinary English. Apply the
proposed wording only where the #883 correction describes these specific facts.
Preserve existing unrelated Core identity names and all serialized spellings.

Approval requested: add the exact request interval row and use the descriptive
message/record wording above instead of registering claim and offer.

After approval, add the row to architecture.md before using the new term in the
implementation; align the affected #883 source comments, specification and
current handoff prose within the correction. Historical review evidence remains
historical. No extra behavior or test matrix follows from this wording change.
Then run the already frozen focused evidence and return the signed feedback
commit. Until approval, the Implementor may continue the authorized mechanics
but should not treat this proposal as an approved registry change or naming
exception.

The governing references are the vocabulary interview, the accepted
pr2-recovery-message-correlation-architect-decision.md, its Planner handoff and
pr2-recovery-unknown-implementor-correction.md. Creation-policy compatibility
remains a separate Architect return. No production, registry or specification
change was made by this disposition, and no GitHub write is authorized.
