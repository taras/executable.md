# PR 3 R2: corrected pause evidence order

**Use the proposed PAUSING → retained advance → PAUSED sequence for R2.** The
Planner accepts this fixture correction. The previous requirement to establish
a complete pause before releasing the Plan provider was my ordering error.
This decision changes the evidence sequence, not the expansion controller or
History's product behavior. It is not acceptance of the uncommitted revision
or the gallery being rebuilt.

## Why this is the correct boundary

The unchanged controller in `packages/cli/src/repl/expansion.ts:217–231` reports
paused only when at least one expansion walk is active and every active walk
is satisfied: it holds a continuation or delegates to active children, and all
those children are satisfied. A walk suspended inside an already-started
provider operation has not necessarily reached such a gate. Requesting Pause
there can correctly remain PAUSING until that operation returns.

This is already covered by `repl-execution.test.ts`'s “P1: the Journal advances
after pause is requested and before it takes effect.” That regression requests
Pause against an in-flight operation, observes pausing, releases the operation,
then checks a longer Journal and a paused controller. It passed in the Planner's
independent focused run at f509197b. The source and that result are retained in
[the correction evidence](pr3-r2-evidence-correction-evidence/sha256sums.txt).

The Implementor's four PTY probes support this behavior for their tested shapes.
I read those reports; I did not independently repeat the timings. They do not
establish the broader claim that paused means “nothing is outstanding,” or
that only a question can produce a paused state. Pause describes expansion
walks, not all Effection work or resource lifetime. Keep the existing head-state
and entry-wide liveness contracts intact. No controller change is requested.

## Frozen R2 evidence sequence

Use the real command and its actual controller at each existing profile:

1. Start Plan work behind the provider gate. Establish from the provider's own
   log that it has received the request and has not returned it.
2. Request Pause and observe HEAD · PAUSING EXPANSION. Select the early marker
   while that request remains outstanding. Record the exact selection, selected
   content, retained record count and complete navigation checkpoint count.
3. Release the already-started provider work through the harness, without
   answering, continuing or submitting from the inspected view. Let its records
   append and the expansion walk reach its actual hold.
4. Require both retained-record growth and **navigation checkpoint growth**,
   unchanged exact selected content and selection, and HEAD · EXPANSION PAUSED.
   Capture the existing `offscreen-advance` state at 160×36, 120×30 and 72×20.
   Its audit requires the paused head and rejects HEAD · LIVE.
5. Open and close History while still inspecting. Require that the paused head,
   selected prefix and selection survive. Historical controls remain read-only;
   do not require or introduce a mounted Continue action there.
6. Return live. Now require the real Continue action, activate it through the
   controller and finish the entry. Closing History alone releases no hold and
   answers no question.

The checkpoint counts need an explicit `after > before` assertion. Recording
both numbers does not prove growth. The rebuilding journey inspected for this
correction recorded those numbers without comparing them, and checked for
Continue before returning live. Correct those two checks as part of R2; neither
changes an acceptance criterion or adds a gallery scene.

This replaces the establish-before-release fixture order in R2 of
[the previous review](pr3-planner-review.md), the H3 evidence recipe and the
Planner's realization of product-journey steps 2–3. It does not claim that
background progress occurred after an already-established full pause. The
accepted visible outcome remains a truthful transition through PAUSING to PAUSED,
complete advancing navigation beside unchanged historical content, and real
controller authority only at the live route.

The finite matrix remains 77 pairs and five controls. H3's separate retained
success/failure/cancellation and unowned unfinished evidence remains required.
R1's snapshot/refusal boundary, R3's real held-invocation control and complete
failure records, and R4's same-category exact-content actions are unchanged.

Continuity: accepted PR 2 base is acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e;
last reviewed product commit remains f509197bd1998b376b09986b79fce2740568e76f.
The current source is uncommitted and the gallery is rebuilding. Produced
artifacts are this correction, its retained evidence, and aligned wording in
the Planner's handoff, stack and gallery records. Next Implementor action:
finish the corrected sequence and existing final verification, then hand back
a stable signed revision and its exact 77-pair packet for independent review.
No new implementation verdict is issued here.
