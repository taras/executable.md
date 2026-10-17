# Turn vocabulary interview

Exact implementation base remains signed
87b25a40915a697a580e619072d433c9c676fec0. The worktree is clean. No production
change or implementation PASS is recorded here.

The Product Owner requested individual terminology interviews. The earlier
three choices remain accepted: message ID, feedback/reference text, and records
for this request. The second interview is complete. Turn, the turn recorded for
this request, and turn/saved turn are accepted. These choices preserve the
settled correlation mechanics and frozen evidence.

## 1. Turn — accepted

The Product Owner accepted: one request to an agent, together with the response
or failure from that request. This exact definition is registered in
architecture.md. A person's message can lead to several turns when the host
sends operation feedback and asks for another response. Do not use turn to mean
the entire chain from the person's message to the final answer.

The Implementor carries this approved row into the implementation worktree's
architecture.md alongside the already approved message ID row, preserving
unrelated changes in both worktrees.

## 2. The turn recorded for this request — accepted

The Product Owner accepted the turn recorded for this request in place of
canonical turn as a technical term. This is the same turn, identified by Core's
saved records for the request, independently of its message ID. No separate
kind of exchange or additional terminology entry is introduced.

Use this description in the affected #883 prose and comments. Name the private
lookup for the request it reads; turnForRequest is an ordinary implementation
name using the accepted turn and existing request vocabulary. Replace this PR's
private canonicalTurn name when aligning the correction. Existing Core names,
serialized spellings and unrelated canonical resolution terminology are outside
this wording change.

The lookup still uses only records for this request, refuses multiple outcomes
and returns no turn association when none is recorded. Message IDs, turn fields,
completion checks and evidence are unchanged.

## 3. Turn, or saved turn when needed — accepted

The Product Owner accepted turn for both the exchange and its saved
representation. Add saved only when distinguishing retained data from work
happening now. No separately named turn record concept is added.

The saved representation contains the input and outcome of one request to an
agent. It lets a later execution inspect what happened without asking again.
Use turn or saved turn for that meaning in the affected #883 descriptions,
instead of capitalized Prompt as a synonym for the exchange.

The existing Prompt terminology entry continues to mean the person's original
request. Existing component/API names such as <Prompt>, PromptRecord,
parsePromptRecord and AGENT_PROMPT, and stored agent_prompt bytes remain exactly
as they are. Refer to them explicitly as code names where necessary. No public
Core rename, wire migration or unrelated terminology sweep is assigned.

## R2d fixture adaptation

The proposed adaptation is accepted: insert the feedback record with turn:null
and the exact text before the second turn in R2d. The existing fixture has a
message followed by two turn outcomes with no intervening initiating record;
the production owner appends the null-turn feedback record before its feedback
prompt. The correction makes this fixture match that writer and the accepted
request boundary.

Keep the original completed reply, completed turns, exact-input delivery and
unestablished assertions, with the already assigned person.message adaptation.
Do not weaken the multiple-outcome refusal or change delivery semantics to
preserve an impossible fixture. Report the actual fixture diff in the feedback
handback; it remains unreviewed implementation until then. No new test matrix
is required.

## Implementor action

Both vocabulary interviews are complete. Resume the accepted bounded lookup,
nullable association, unresolved-acceptance refusal and MC1–MC4 from 87b25a40.
Apply the settled wording in the affected prose, comments and private helper
names. Carry only the approved message ID and turn terminology rows into the
implementation worktree. No additional naming approval or test matrix is needed
for this correction. Run the frozen evidence, commit promptly and return the
signed SHA for Planner review.

Creation-policy compatibility remains separately with the Architect, so R2 is
not complete. No production code, tests, commit, push, GitHub write or CI
inspection occurs as part of this interview record.
