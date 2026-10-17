# A successful control-only reply is work, not a chat utterance

**Implemented and accepted at 2ac3cb28:**
[Planner review](pr921-control-only-planner-review-2ac3cb28.md), independent
59 tests / 239 steps. The decision is closed for this increment. Configure's
separate keyboard correction follows before delivery; no extra architecture
or naming change is requested here.

**Current base: padding accepted at 6ca23952.**
[Planner review](pr921-padding-planner-review-6ca23952.md) closes its start gate.
The existing owner now implements this as a separate successor under the
focused handoff. The original observed in-progress state below is historical.

Remove the Sidekick's “answered without saying anything” notice for a successful
reply without user-facing Output. Keep the work and its recorded outcome in
Sessions and history. Selecting that turn reveals existing associated context
rather than creating a chat message to serve as an anchor.

This implements the Product Owner's explicit correction for #921. No further
product interview is needed: the required behavior and exclusions were supplied
with the request. This is a presentation correction, not a reopening of the
accepted evaluation, control or history architecture.

## State and owner boundary

Observed owner worktree: `.claude/worktrees/issue-883-pr2`, branch
`agent/issue-883-pr2-main-integration`, HEAD
`27da762b7078ee8e32b1dbaf90941c4a8a90eaa7` when inspected. Padding/color and
36-column-sidebar work is present and uncommitted. That owner has also changed
ordinary journey consumers since the previous return; do not restore those
files or take over the worktree.

The existing designated Implementor remains the sole writer. Finish the
[approved padding continuation](pr921-padding-width-approved-continuation-27da762b.md)
and review its signed successor first. This correction is the next separate
commit, based on that actual reviewed successor. Do not mix it into the padding
commit or start a parallel writer. The Architect's activity here is read-only
source inspection and reviewer records; no implementation or ref was changed.

## Direct trace

At the observed HEAD plus the in-progress presentation work:

- `application.ts`'s `sidekickComposedRows()` emits a row for every final reply.
  Its `hasOutput === false` branch spells the unwanted notice. The same
  composition feeds fitting, drawn rows and window counts.
- `revealedAt()` picks a non-person chat item for the selected turn before
  finding its key in the actual drawn rows. Removing only the notice would
  leave it targeting an item that has no row.
- `sidekick/model.ts` already retains each response's `hasOutput`, Output and
  evaluation failure, while saved canonical turns remain separately available.
  Successful control work therefore needs no history deletion or new record.
- `program.ts`'s `sidekickChatRows()` currently assigns `failure: undefined` in
  its ordinary reply mapping, despite the retained reply carrying a failure.
  Preserve that existing fact through the screen-facing projection; failure
  visibility must not depend on whether the reply selected Output.
- The mounted PV1 journey currently asserts the unwanted notice after a
  control-only reply and automatic follow-up. That assertion is superseded by
  this product correction, not grounds for leaving the notice in place.

This is a direct code/data-flow finding, not a claim of an independently run
runtime reproduction. No focused test or CI was run by the Architect here.

## Presentation contract

1. A successful evaluated reply with no user-facing Output contributes no
   utterance, metadata substitute, empty row or invented navigation anchor to
   the chat's composed/fitted/drawn rows. Its request remains if already visible.
2. Explicit Output retains its established presentation and disclosure path.
   Use the retained Output classification and actual outcome, not a generic
   empty-string test that conflates success, failure and unfinished work.
3. An evaluated reply that failed keeps its recorded reason visible as failure
   status, even without Output. If it also rendered Output, retain that text.
   This does not turn failure status into a successful agent utterance.
4. Failed/cancelled generation, interrupted attempts, pending questions, setup
   failures and actionable status retain their current visibility and controls.
   Do not filter all `hasOutput === false` items or all empty text globally.
5. Keep the distinction between a completed evaluated control-only reply and a
   canonical Prompt whose evaluated response was never recorded. The latter's
   existing “Turn saved; no evaluated reply recorded” status is still truthful
   incomplete knowledge, not the empty-success notice being removed.
6. Live and cold presentation use the same decisions. Reading a saved chat
   starts no provider, writes nothing and evaluates nothing.

## Sessions reveal and identity

Every saved turn remains in Sessions with its existing identity, order, status,
conversation and provider key. A successful silent reply is still a completed
turn; it is simply absent from chat utterances.

Reveal selects **visible associated context** from the same composed and fitted
rows that will be drawn. Prefer a turn's actual visible Output or legitimate
failure/incomplete/saved status. If its successful reply is silent, reveal its
existing containing request. For an automatic follow-up, use established
request/feedback associations within that conversation to reach the existing
person request; do not print machine feedback as if the person wrote it.

The request association must come from acknowledged record boundaries and
recorded response relationships. Reuse `requestsFromHistory()` and existing
identity/resolution machinery where needed. Never infer a response ID from a
turn number, choose by matching text, borrow a request across chats, or treat
the latest message as proof of ownership. The earlier Preview divergence and
cross-chat identity corrections remain authoritative.

A private detached presentation association is permitted if the visible
composition needs it. It is derived from existing history, not a durable map,
new event, new URL member, registry or capability. A local projection/helper
change is delegated; no cross-package API is added. If an older history cannot
establish a containing request, preserve that honest absence and the actual
selected turn's Sessions status; never fabricate a request or chat row to make
navigation appear successful. Report any such bounded limitation in handback.

The destination frame still computes its offset from its own measured chat
capacity. The same visible composition determines text fitting, row counts,
window admission and reveal targets. A hidden successful reply must not reserve
a blank row, survive as a stale Preview, or cause a reveal to target a missing
key. Existing explicit/current/read-only selection and focus semantics remain.

## Invariants and exclusions

Preserve every saved turn, response, control intent/outcome and feedback record.
Preserve literal feedback sent to the agent, its automatic continuation, control
execution counts, entry admission and all evaluation outcomes. No record is
rewritten, migrated, removed or newly appended to implement presentation.

Production scope is final presentation composition and reveal in `application.ts`,
screen-facing projections in `program.ts`, and, only if needed, detached
request-association derivation in `sidekick/model.ts`. No owner scheduling,
storage codec/writer, XMD evaluation, Core, ACP, feedback routing, generated
disclosure policy or entry-admission change.

Update only the affected specification/architecture paragraphs to distinguish
successful silent work from an unrecorded evaluation and to describe reveal's
visible-context fallback. No new reusable rule is promoted from this correction.

#928 conversation filters, #929 numeric entry labels/URLs, #930 clickable
History and #931 mockup alignment are separate. This correction and padding
tests establish neither those features nor mockup alignment.

## Evidence and next action

The Product Owner requires mounted evidence for control-only success, explicit
Output, failure without Output, Sessions navigation and cold reopening. The
[Implementor handoff](pr921-control-only-replies-implementor-handoff.md) freezes
their focused selection and commit boundary. No exhaustive runtime matrix or
new mutation battery is required. Padding evidence alone does not prove this
correction.

Next: the existing owner finishes the padding slice first. Once its signed
successor passes review, the owner executes this separate correction, returning
one signed feedback SHA and its focused results before the delivery restack.
