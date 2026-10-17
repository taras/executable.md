# Architect return: message identity after an unacknowledged turn

Resolved by pr2-recovery-message-correlation-architect-decision.md. The Planner
implementation assignment and finite evidence are recorded in
pr2-recovery-message-correlation-planner-handoff.md. This return is historical;
creation-policy compatibility remains a separate question.

**Resolved architecture, 2026-10-12:** the Product Owner accepts separate
message identity and canonical turn association. Follow the
[decision and Planner handoff](pr2-recovery-message-correlation-architect-decision.md).
Implementation is not accepted by this disposition. The incoming return below
is preserved as evidence.

Review the reported correlation ambiguity at exact head
`87b25a40915a697a580e619072d433c9c676fec0`, parent 14ee0d8e. Do not implement
or modify the pending work. This is separate from the existing creation-policy
return and the Planner's concrete unresolved-acceptance correction.

R2m2 now demonstrates a real provider assertion before canonical Prompt
acknowledgement. Its first message record remains as person@1, but no Prompt
record lands. In the next process, nextTurn counts that local intent and writes
the new message as person@2. Core has no retained turn to count and creates
canonical turn:1 for this new request; the admitted reply is consequently
reply@1. The observed chronology is:

```text
person@1: first
person@2: second
reply@1: Two.
canonical turn:1 input ends with: The person says:\n\nsecond
```

This is independently visible in
pr2-recovery-review-87b25a40-focused.log, and follows the code directly:
owner.nextTurn counts person intents and canonical attempts; model projects the
message's retained turn unchanged; responses use canonicalTurn. No corrupt
record, changed identity or unusual transport behavior is needed.

storage-contract.md calls for conversation/message/turn correlation. It does
not specify whether MessageRecord.turn is a provisional local message identity
or a canonical turn association after this interruption. They demonstrably are
different here. Current chat projection preserves acknowledged record order
and does not pair by turn; no current presentation ordering failure is claimed.
A future terminal reader must not join these values as though they were one
canonical key and attach "Two." to "first".

Please define the accepted meaning and the smallest required correlation
boundary. Identify any existing canonical association sufficient for the
reader, or state the required separation between a retained message intent and
an acknowledged canonical turn. Specify what an unacknowledged message projects
as, how the actual completed request is associated without guessed ordinals,
and one finite observation using this existing R2m2 scenario. Do not ask the
Implementor to infer a public schema/interface change, rewrite old records or
invent a second turn counter. Follow the Architect's normal interview if the
ruling changes an accepted interface or product behavior.

This return does not reopen accepted provider identity, configuration or Stop
behavior, and asks for no new crash/permutation matrix. The Planner's independent
unknown-acceptance refusal correction can proceed while this interpretation and
creation-policy compatibility are resolved. No production change, GitHub write
or CI inspection is authorized here.
