# Accepted product journeys and candidate implementation evidence for #883

The Product Owner accepts all twelve journeys and the terminal adaptation in
[remaining-architecture.md](remaining-architecture.md). That record is the
authoritative product-verification contract. It distinguishes a working Sidekick
from a chat simulation that only looks connected.

Journey 10 incorporates the accepted
[syntax discovery amendment](syntax-discovery-amendment.md): short initial
orientation/index and on-demand guides/references replace full initial manuals.

The matrix below is the earlier preparation-time implementation-evidence
proposal, not the final accepted journey inventory. The Planner reconciles it
with the twelve approved journeys and fixes finite evidence and exact commands
after the outstanding storage/Core interfaces are complete. Implementation
acceptance and the final architecture handoff remain unfrozen.

## Preparation-time candidate evidence

The [implementation handoff](planner-handoff.md#frozen-evidence-matrix) now
supersedes this candidate matrix. Its C1-C3/R1-R8 groups, focused commands and
36-frame capture matrix are the finite implementation threshold.

| ID | Person's journey and observable result | Incomplete implementation rejected | Candidate lower-level evidence |
| --- | --- | --- | --- |
| S1 | Publish names containing Ada, Grace and Linus in an actual entry. Ask Sidekick for greetings; see its draft, run the admitted program, then request a table revision from the same conversation. | Scripted chat that shows canned output, never reads the published value or never submits a real entry. | Drive runReplProgram with real Journal/profile/tree/renderer and controlled ACP transport. Compare read value, shared draft bytes, retained admitted source, execution output, exact entry identity and feedback observed by the provider. |
| S2 | Ask Sidekick to inspect bindings with either right tab selected and while reading another entry/History. The accepted binding snapshot reaches it and reading/focus stays put. | Inspection implemented by opening the pane or reading whichever selected scope happened to be visible. | Use two entries with a redefined name, one nested same-name value and one earlier prefix; assert the accepted selection rule and unchanged tab/route/entry/history/focus. |
| S3 | Sidekick fills the input. No entry starts. Edit it by hand and submit; the admitted immutable source is the accepted draft. Exercise the agreed conflict policy. | Filling executes; a hidden copy submits; a late acknowledgement clears newer text. | Hold the response/admission boundary while sending real human draft actions. Compare Journal before fill/refusal and source/revision after admission. Include one delayed admission and its newer human edit. |
| S4 | Output-selected text appears in chat while binding/operation results reach the same Sidekick through feedback. Exercise the approved no-Output behavior. | A binding dump treated as conversational text, generic Evaluate return interception, or partial provider source executed while streaming. | Separate selected output and control-result fixtures. Observe complete-response boundaries and actual provider follow-up payloads; a failed provider turn executes zero controls. |
| S5 | Sidekick asks an Elicit question; invalid input stays open, valid input reaches the owning conversation, and closing answers nothing. Switch tabs while it waits. | A text-only simulated question, schema bypass, tab-owned cancellation or an answer delivered to an entry's question. | Real contextual provider and validator; correlate Sidekick and one simultaneously pending entry question; compare answer publication/feedback and unchanged pending state on close/tab switch. |
| S6 | Submit while an entry runs, while its Close exists but teardown is held, and while History is read-only. Receive the actual refusal and retain the draft. Release teardown and submit successfully. | A direct session.submit shortcut that bypasses History, a queued entry, or outcome treated as completed cleanup. | Real entry task and held resource finalizer; compare entry count, Journal bytes, owner overlap, refusals and draft at each boundary. |
| S7 | An admitted entry fails; Sidekick receives that entry's failure and can revise. Stop Sidekick before admission and after admission according to the accepted policy; leave the command while work waits. | Failure replaced with success text; a stopped agent cancels unrelated entry work; UI exit needs another key; fabricated answers/cancellation records. | Correlated failed entry plus held provider/response/result waits. Check owner joins, revoked requests, draft, entry outcome, no invented records and terminal restoration. |
| S8 | Two explicit agent selections affect Sidekick and entry Agents independently. Switch tabs during a turn; chat text, draft, interaction and conversation persist. | Both flags feed the same default or a tab component owns the provider. | Real command grammar/profile seam and fake ACP started events; tab changes around a held turn with stable provider session identity and unchanged state. |
| S9 | Reopen a settled retained location and inspect earlier positions without provider traffic or execution. Show chat according to the accepted retention policy. | A cold Sidekick reconstruction starts provider work or appends chat events to malformed entry ranges. | Tripwire provider and byte-identical entry Journal; exact reconstruction assertions for the chosen chat policy. If persistence is approved, add its expressly accepted recognition/interruption boundary. |
| S10 | Read, type, switch tabs, open a question and resize at 160×36, 120×30 and 72×20. Distinguish three wide/medium columns, selected tab, chat composer, program draft and full-width History. | Two simultaneous tab contents, indistinguishable input destinations, hidden keyboard targets or browser-only evidence. | Committed real-frame geometry/grid assertions plus production terminal captures pinned to the feedback SHA. Assert mounted/drawn/focusable/pointer agreement and preservation through the undersized refusal/recovery. |
| S11 | Send the first message in a new Sidekick conversation. It receives the short bootstrap, guide index and compact canonical response surface, then reads chapters, environment facts and entry syntax as needed. An explicit agent change receives its own initial context; reopening alone starts no turn. | Full manuals loaded by default, undiscoverable help requests, chapter results never reach the agent, executed examples, a drifting catalog or entry documentation treated as response permission. | Observe first provider input and ordered retained guide/environment/reference feedback. Compare canonical profile-derived metadata and literal chapter content; use an entry-only plugin and contextual facts with an explicit unknown. Keep cold-reopen provider traffic at zero. See amended J10/R5 for final evidence. |

S6 uses explicit black-box admission evidence because affected-import selection
alone cannot prove that a new caller passes the root's History guard. S1/S4 use
provider-observed input rather than a UI assertion that feedback was sent.
S3 correlates the source that was admitted, not a text sample in a screenshot.

## Candidate focused regression files

Reuse `packages/cli/tests/support/fake-acp.ts`, the real command/profile journey
in `repl-agent-journey.test.ts`, and frame/grid helpers in
`tests/fixtures/repl/presentation.ts`. Production remains the real program,
Journal, admission, evaluation, Elicitation and mounted tree. A deterministic
Agent is appropriate at the transport seam; a test-only Sidekick controller or
scripted browser journey is not evidence of production control.

| Changed boundary | Existing explicit regressions to retain |
| --- | --- |
| Entry history/admission/completion | `repl-entries.test.ts`, `repl-execution.test.ts`, `repl-journey.test.ts` |
| Agent turns/permissions/ownership | `repl-agent-execution.test.ts`, `repl-agent-interface.test.ts`, `repl-agent-journey.test.ts` |
| Questions/validation/drawers | `repl-forms.test.ts` |
| Routes/prefix isolation | `repl-route.test.ts`, `repl-boundaries.test.ts` |
| Presentation/targets/tab composition | `repl-layout-admission.test.ts`, `repl-presentation-style.test.ts`, `repl-composition.test.ts` |
| CLI/help/terminal exit | `cli-help.test.ts`, `repl-terminal.test.ts`, `repl-exit-pty.test.ts` |

The final command list selects the files that prove the accepted slice. It does
not run every file above merely because it appears in this inventory. New
portable Sidekick tests live beneath the workspace's existing tests directory;
test discovery and runtime exclusions remain unchanged unless a demonstrated
runtime boundary requires otherwise.

Proposed discriminating controls: suppress feedback delivery (S1/S4 fails),
route Sidekick submit straight to the session (S6 History refusal fails), and
attach the conversation owner to selected-tab content (S5/S8 fails). Final
approval may use ordinary targeted regressions instead; this packet freezes no
mutation-test obligation. If controls are selected, preserve their first failing
output and restore bytes exactly between them, with no permanent production
switch and no dependency mutation.

## Candidate visual comparison packet

Capture these representative production scenes at the three supported profiles:
empty Sidekick/chat destination; greeting draft before admission; greeting result
and completed feedback; table question with a populated field; invalid answer;
Bindings selected while Sidekick works; entry failure/refusal; stopped Sidekick
with retained draft; and historical inspection. Select each narrow outlet using
the accepted navigation. Add one populated-question resize refusal/recovery.
The terminal adaptation and product scene coverage are accepted in journey 12
and reference/README.md. This candidate list helps the Planner derive the finite
capture matrix; it does not override that approved behavior.

Preserve reference source hash, exact production SHA/parent, dimensions, scene
IDs, actions, fixture provider traffic, raw ANSI, actual screenshots and a
checksum manifest. Show reference and production together. Expected colours
and relationships come from the accepted reference/refinement, independently
of production constants. Inspect the images; passing self-consistency checks
do not establish visual parity. Do not synthesize terminal appearance by
editing captures or label browser renders as production evidence.

## Feedback and continuity

Once the accepted matrix's smallest focused tests pass, create the feedback
commit promptly. Return exact SHA/parent, every focused command/result, unmet
criteria and the agreed terminal evidence. Do not delay the stable commit for
the full battery or inspect CI for a Planner feedback verdict. Required CI is
the separate delivery gate.

Exact research base: `20462295c2ac44305577359583be0a33004cc428`.
Artifact: `.reviewer/issue-883/acceptance-proposal.md`.
All twelve product journeys and terminal adaptation are accepted in
remaining-architecture.md. Completed interfaces and storage/recovery are in
core-interfaces-proposal.md, storage-contract.md and planner-handoff.md. This
earlier candidate matrix is not frozen implementation acceptance; the Planner
derives that finite evidence now. Complete #881 and the eventual exact
implementation base remain distinct implementation dependencies.
Next Implementor action: await the frozen handoff; run no acceptance command
from this candidate inventory as though it were an approved threshold.
