# Sidekick preferences: save while busy, use on the next turn

A person can save a model or effort choice while Sidekick is working. The work
already running continues with the request it received. The next turn reads the
saved choice, including an automatic follow-up after an admitted entry finishes.
Saving preferences does not inspect or reconfigure the provider and sends no
message.

This restores the accepted
[model/effort timing contract](architecture-review.md#accepted-modeleffort-timing-and-retention)
and [J9](remaining-architecture.md#accepted-journey-9-configure-sidekick-independently-of-entry-agents).
The busy configure refusal and the corresponding R7 assertion conflict with
that contract and must change. Disabling Configure throughout a busy cycle is
not the correction.

## Scope and exact base

Inspected `bb60ca35661c2988ef647cc7a456470482d06e2e`, parent
`2f3af332e09a7aa8e6acda6e51e1f63aab13614e`, branch `agent/issue-883-pr2`, in
`.claude/worktrees/issue-883-pr2`. HEAD, signature G, signer tarasm@gmail.com and
clean tree were independently confirmed. The implementation checkout is
unchanged.

This is the ruling requested by the
[Architect handoff](pr2-section5-configuration-architect-handoff.md).
Configuration P1/P2, the direct-provider design, activation, native identity,
recording, R2 and mounted message/question acceptances remain closed. Only the
CLI owner's preference timing and the serialization required by concurrent
preference saves change. Core's conversation mailbox is unchanged.

Retry's message behavior remains a separate pending Product Owner question.
This ruling does not choose whether Retry resends a failed person's request or
only checks availability. The Planner must obtain that answer before freezing
the combined Configure/Retry assignment.

## What the code currently does

At this base, `SidekickOwner.options()` and `configure()` both refuse while
`busy`. Inspection actually asks the provider; configure only appends a
`preferences` record and refreshes the reading. Its use of `holding()` is not
needed to save a preference for an already active conversation and can reopen
or establish a handle unnecessarily.

`respond()` snapshots `reading` near its beginning, then does orientation,
message/feedback writes and acknowledgement before passing
`desired(current.value, conversation)` to `handle.prompt()`. Removing only the
busy guard would still let a later acknowledged preference miss that turn.

`SidekickWriter.append()` currently calls the host append and then pushes into
its in-memory records, without serializing concurrent callers. Allowing a
preference save alongside Core/response writes therefore requires those physical
appends and their local acknowledgement to have one order.

The existing R7 busy row explicitly expects configure to fail and preferences
to remain absent until Stop. That assertion describes the implementation's
restriction, not the previously accepted product behavior. This decision
authorizes its precise replacement below.

## 1. Saving and inspecting are different operations

For an already active conversation, `configure(desired)` saves the complete
requested preference using the existing record format and its acknowledged
writer. It does not call `holding()`, `handle.options()`, `handle.prompt()` or
any other provider operation. It works during generation, response evaluation,
a pending Sidekick question or a wait for an admitted entry. It neither stops
that cycle nor creates another one.

Capture the active conversation and the scalar model/effort values before the
save can suspend. Bind the append to that conversation, rather than reading
whichever conversation happens to be active after waiting. Refuse unreadable
history or a conflicting replacement/setup operation through the existing
owner/root admission behavior. Do not redirect a stale drawer's Apply to a
replacement conversation.

During a busy initial setup with no active conversation yet, refuse the save
because it has no target. Do not queue it, create a competing conversation or
attach it later to whatever setup wins. An idle first explicit Configure/Apply
can retain the existing explicit establishment behavior. Cold render/reopen
still establishes nothing and contacts no provider.

`options()` continues to refuse during the message cycle. `select()` continues
to require Stop and its join before changing agents. No second inspection
session or provider route runs around Core's one-job boundary.

The mounted drawer can use provider-advertised choices already obtained for
the same conversation and agent. Effort choices must also belong to the exact
model being selected. Keep these readings process-local, with their selection
identity; ignore late results for a previous drawer selection/conversation.
They are choices, not evidence that a setting has been applied.

If the model being considered needs a fresh effort inspection while the
Sidekick is busy, say that its effort choices cannot yet be refreshed. Keep
already advertised model selection usable. A model-only preference can be
saved, because effort is already optional. Do not reuse another model's effort
list, silently choose an effort, or automatically stop the cycle. A choice for
which no matching advertisement is available remains unavailable until an
explicit inspection can run. An inspection that was deferred does not silently
run later or delay an automatic follow-up; the person explicitly refreshes it
when the owner is available.

Each configure call remains a complete desired preference, not a patch. An
omitted effort means no effort request; it neither copies an old requested
effort into a different model nor resets the provider's setting. Show that
distinction in the drawer. Preserve the owner's existing ability to retain a
requested ID that the next turn may reject; the mounted bounded choices do not
replace Core's final validation. Keep the existing rejected-choice regression.

## 2. A turn takes its preference immediately before prompt handoff

After composing and retaining the message or feedback, and after any message
acknowledgement, read the latest acknowledged records from the shared Sidekick
writer. Derive the preference for this turn's fixed conversation from that
reading. Refuse an unreadable reading rather than using an older preference.

Then immediately call `handle.prompt(request, capturedPreference)` with a
fresh scalar copy. There must be no intervening yield for preparation,
refresh, acknowledgement or UI work between selecting that preference and
handing the request to Core. Do not use `respond()`'s earlier `current` snapshot
for this selection. That earlier snapshot can still supply the message ordinal
and orientation facts, which preference writes do not change.

This handoff is the precise turn boundary: Core has received one complete
request, including the requested model/effort. A save acknowledged before this
selection is included. A save acknowledged after it belongs to a subsequent
turn, even if the accepted turn is still preparing its native session or
generating a response. Do not mutate the configuration already handed to Core.

```text
Turn 1 / response / admitted entry is still running
    |
    +-- person saves model=fast, effort=high
    |       |
    |       +-- preference append acknowledged; no provider call
    |
entry finishes; response evaluation completes
    |
automatic feedback is composed and saved
    |
read latest acknowledged preference for this conversation
    |
hand feedback + {model: fast, effort: high} to Core.prompt
    |
Core applies and verifies those exact settings before sending the turn
    |
    +-- a preference saved now belongs to the following turn
```

Keep requested settings distinct from verified settings. A preference append
proves only what the person requested. Core's existing model-first,
effort-refresh, exact application/readback and native-identity behavior supplies
verification. Rejection sends no turn under substituted settings, and saving a
different preference cannot bypass unknown acceptance or integrity refusals.

## 3. Serialize short writes, not the entire Sidekick cycle

Keep the existing one chat writer. Its physical append and in-memory record
publication form one serialized operation for every caller: preference,
message, feedback, control, response and wrapped Core-event writes. A following
append cannot reach the host before the previous one has completed its write
and updated the acknowledged records. No second writer, file or durable queue
is introduced. Internal serialization helpers are delegated.

The next-turn preference read uses this writer's acknowledged records in that
same ordering. It must not read from an older UI projection while a save has
already been acknowledged. A save only becomes successful after its record is
acknowledged and its reading refreshed. Multiple saves use append order; the
last acknowledged complete preference for the target conversation wins.

Do not hold the write serialization across a provider prompt, response
evaluation, Elicit, entry completion, inspection or agent setup. That would make
the permitted save wait for the busy cycle it is meant to coexist with. Sharing
brief history appends does not queue another message or provider operation.

The root retains one owned explicit configuration task at a time and
serializes setup/inspection, Apply, agent replacement and Send admission. This
reservation concerns starting those explicit operations; it must not prevent a
preference Apply while an already-admitted message cycle continues. Busy alone
is not sufficient to protect an idle inspection or replacement from concurrent
Send. Keep conflicts explicit rather than silently queuing a person's action.

For conversation replacement, finish or cancel/join a previously admitted
preference save before starting replacement setup. A later action cannot
retarget the save to the new conversation. Invalidate the old drawer's pending
selections and inspection results when the conversation changes. Keep the
existing rule that failed replacement leaves the old active association.

Stop cancels and joins the message cycle. It does not discard an acknowledged
preference or cancel a separate admitted preference save merely because that
save happened while the cycle was busy. The root owns the save independently
of the cycle. An admitted entry continues on its existing owner.

Command shutdown cancels and joins all root-owned configuration work as well
as the message cycle before releasing the writer/provider. A save cancelled
while waiting to append publishes no preference. If a physical append has
started, join its completion and local publication/failure before releasing
the writer; cancellation must not allow an append to finish behind a closed
owner or let another append overtake it. Preserve existing storage failure
classification and truthful on-disk history; invent no rollback or successful
save after a failed/uncertain write. No worker may outlive the command scope.

## 4. Authorized R7 adaptation and finite evidence

Replace the busy row's claim that all configuration must wait for Stop with:

> While a turn is running, inspection and agent replacement refuse; saving a
> preference for the active conversation succeeds without changing that turn.

Retain its held-generation fixture, busy options refusal, busy select refusal,
single-conversation assertion and Stop/join behavior. Change only the preference
refusal/absence assertions: assert an acknowledged preference on the same
conversation, zero new configuration/provider work from the save, and that the
in-flight turn keeps its original settings. After Stop, the saved preference
still stands. The next explicit turn uses it without requiring a second save.
Update the row's title and comments accordingly. Preserve other R7 assertions,
especially exact provider validation and rejected choices.

The Planner freezes these bounded observations in addition to the mounted
Configure evidence already proposed:

1. **Held-entry pair:** drive the real owner/provider and entry through the
   mounted `runReplProgram` path. Start under advertised old settings, let its
   response admit an entry and wait for that entry, then Apply an advertised
   different model/effort. The save is acknowledged while the entry remains
   held; it sends no provider work and stops neither owner. Release the entry.
   Exactly one automatic feedback turn uses the new settings after exact
   application/readback, on the same native conversation. The paired control
   performs the same work without changing preferences and uses the old
   settings. The chat and entry configuration stay independent.
2. **Turn boundary:** reuse the adapted held-generation R7 row to show a save
   after prompt handoff cannot change that turn, survives Stop and is used by
   the next explicit turn. A new matrix of timing positions is not required.
3. **One writer/ownership observation:** hold a real preference append while a
   response/Core append is also requested. Prove host writes do not overlap or
   overtake, acknowledged memory matches disk order, and replacement/shutdown
   cannot retarget or outlive that admitted save. Use one representative held
   write with the existing storage/lifecycle harness; the Planner may separate
   the shutdown assertion only if the harness needs a separate owner ending.
   Keep existing busy agent replacement and admitted-entry Stop coverage.

Existing matching-model option inspection and the mounted model-dependent
effort case cover advertised choices. Add the busy unavailable-refresh
observation to that same mounted case: no inspection during the cycle, no
cross-model effort choices or silent default. No timing/configuration
permutation matrix or new Core test battery is assigned.

## Planner instructions

Apply this ruling to the
[section 5 preparation](pr2-section5-configuration-planner-handoff.md).
The required source boundaries are:

- `sidekick/owner.ts`: separate active-conversation preference retention from
  handle establishment; select the latest acknowledged preference at prompt
  handoff; correct configure documentation to say omission requests no change
  rather than resets a native setting.
- `sidekick/history.ts`: serialize the existing writer's append/publication
  and supply the ordered acknowledged read without a second history source.
- `program.ts`: own and join explicit configuration tasks, protect Send/setup/
  replacement admission, and keep saves independent of message-cycle Stop.
- `application.ts`: keep detached process-local advertised choices and pending
  selections tied to the conversation/agent/model that produced them; allow
  busy preference Apply where choices are available and report unavailable
  fresh effort inspection truthfully.
- Relevant R7, storage, lifecycle and mounted tests, plus the existing
  architecture/specification statements about next-turn timing and writer
  ownership. Use the current focused selections and known harnesses.

No public Core interface, new provider route, new record format, model/effort
reset policy or configuration settings feature is needed. Apply/close details
and Retry's pending product answer belong to the Planner's remaining mounted
interview; this ruling does not silently settle them. Freeze the final matrix
and self-contained Implementor assignment only after those open product items
are resolved. Do not reopen previously closed identity, configuration or
message/question acceptances.

No test, implementation edit, commit, push, GitHub mutation, CI inspection or
capture was performed for this source-traced ruling. Base remains signed clean
bb60ca35. Next: the Planner incorporates this timing decision and the Product
Owner's separate Retry answer, then issues the bounded section 5 assignment.
