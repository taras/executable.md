# #881 stack and evidence rules

The PR 2 and PR 3 implementation handoffs freeze the remaining original parity
work. This shared record supplies their stack, fixture and feedback rules.
PR 2 feedback is accepted at the exact revision below; PR 3 remains a frozen
implementation plan. Neither standing grants delivery or publication acceptance.

## Exact stack

| Revision | Standing |
| --- | --- |
| 080b6ec80ca74e614789e8d2252857ac281df7e5 | Accepted PR 1; parent f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa. Clean, unpublished agent/issue-881-pr1 worktree when inspected. |
| e68f128121cd802623ab7797a016b0c66ce91176 | PR 1's recorded main base. |
| 4c0414be1010f69f11bff0d1d634623a5b08f886 | Remote main read on 2026-10-08 for this plan. |
| 2d719f78025059158a35023701fdff52b855a65b | Planning workspace and original baseline capture revision. |
| c7d54769d56661bef38cee8549b148f3bf87a904 | Prepared PR 2 integrated base: accepted PR 1 plus recorded main 4c0414be. |
| acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e | Accepted PR 2 feedback; parent 9163a16b9f5b83e9c042f47e90ac307f4679d239. Exact PR 3 implementation base; see [Planner acceptance](pr2-planner-acceptance.md). |

PR 2 integrated the accepted PR 1 and recorded main revisions at c7d54769.
The accepted PR 1 branch and evidence remain their original slice record.
PR 3 branches from the exact accepted PR 2 feedback SHA above. Prepare the new
worktree with `deno task setup`; builds and checks install nothing. Preserve both
accepted slices when refreshing overlaps. A behavior conflict returns to the
Planner.

Main's two intervening deliveries are #880 (20462295c2ac44305577359583be0a33004cc428)
and #884 (4c0414be1010f69f11bff0d1d634623a5b08f886). Preserve Evaluate's `text`
spelling and removal of `source`; the generated fixtures already use `text`.
Preserve the `entries` route spelling, Interrupt input, owner-level Control-C
exit and suppression of later input in that same batch. Adapt fixture locations
to `entries`; do not revive the earlier `/repl` surface spelling. Keep #884's
terminal bench and its fixes. Overlapping files include application, description,
rows, program, route, journey tests, Evaluate and both affected specifications.

Open PRs were read without CI inspection. #805 at
7cc1752d6ae3a90c234b768842cfb714d874e093 has no private REPL/Core file overlap.
#779 at 11720a1301acc846f7d6c3767f117f407ec1f81e is a VIEW_ONLY POC, overlapping
expand.ts, Core exports, structural rules, architecture and the language spec.
#742 at 60b94f8c5aec08b20382adba6f692596188f9455 overlaps documentation.
None is a required dependency. Do not import the POC or a newer interface.
Refresh these reads before implementation and delivery; a new material contract
conflict returns to the Planner, rather than silently changing this matrix.

PR 3 starts from **acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e**; its PR 2 acceptance
dependency is satisfied. Record that SHA and integrated base c7d54769 in the
PR 3 handback. The frozen algorithms, tests and 77-pair assembled gallery in
pr3-implementation-handoff.md remain unchanged. Feedback acceptance does not
replace delivery verification or authorize publication.

## Real fixtures

Use plan-entry.md, generated-readme.md, json-entry.md, permission-entry.md and
fixture-agent.py in this directory. The Plan fixture returns exact generated
bytes, uses Northstar and `A project for clear executable documents.`, and writes
README.md only in a fresh temporary working directory. Record the one write and
its actual rendered report. The decline companion writes nothing. Tests use the
existing in-memory/disk stream and profile assembly seams. Production captures
use a real PTY, normalized input, production composition and the installed TTY
engine. Do not inject a lifecycle/head enum into the application to establish a
state in an acceptance journey.

Add trusted test fixtures under packages/cli/tests/fixtures/repl/issue-881/:

- `ObservationProbe.ts`: a function component with independent body and cleanup
  resolvers; cleanup is registered before acquisition. It can return, throw,
  emit a printed semantic failure or fail cleanup. A second invocation uses the
  same logical source id and a distinct private occurrence. Existing invocation
  harness definitions cover Markdown, value/capture and child recovery.
- `HistoryGate.ts` and `HistoryAfter.ts`: real siblings under
  `<All><Spawn><HistoryGate /></Spawn><Spawn><HistoryAfter /></Spawn></All>`.
  The first signals that work started and waits on a resolver; the second
  supplies a later expansion crossing. Request Pause after the held work starts,
  inspect early history while PAUSING, then release that work and let the actual
  controller establish PAUSED. Assert retained-record and navigation growth,
  unchanged prefix/selection, and the paused head. Closing History preserves the
  hold; check Continue after returning live. The ordinary Plan provider gate
  also supplies this sequence. See the [R2 fixture correction](pr3-r2-evidence-correction.md);
  it replaces the establish-before-release order and changes no controller policy.
- `history-crowd.md`: 200 consecutive HistoryRecord Markdown component
  invocations, each with `ordinal={N}` and `secret="future-secret-N"`, N=1..200.
  The component declares those props and renders `Record {props.ordinal}.`
  Each invocation admits a real scope checkpoint. Json count does not imply
  binding-checkpoint count: one publication record can hold many results.
  Build this fixture deterministically as test data and verify actual grouping
  at the three engine-measured widths. Other short entries supply adjacent entry
  captions. H1 selects two same-category scope markers in one measured group
  and checks the different component content their exact prefixes admit.
  This corrects the Planner's original fixture premise; it changes no product
  contract or gallery count. See [the PR 3 review](pr3-planner-review.md).
- A held `ExecutionInstallation.install` teardown, following
  `holdingTeardown()` in repl-entries.test.ts. Signal entry into its ensure,
  then await an independent release resolver after the retained root outcome.
  Also assert that the actual Agent attachment and observation consumers release
  before the entry-wide false transition. Its current attachment release is
  synchronous; do not invent a suspendable attachment or production test seam.

The controlled PTY driver uses the existing runReplProgram/profile/terminal-host
assembly with these real installations for pause and cleanup scenes. It imports
production adapters; it does not copy the app or renderer. Record this host
fixture entrypoint separately from the ordinary CLI command. The original
Plan/README, JSON, permission, failure and cold scenes use the ordinary CLI.
Fixture latch transport belongs to the harness, with no production hook, sleep
as readiness proof or persistence field. Close its transport and release every
held destructor on failure so a failed assertion cannot trap teardown.

## Evidence ownership and feedback

The finite [gallery](final-gallery-matrix.md) and each handoff's test tables are
the acceptance threshold. Local helper names and internal types remain
implementation choices. If a criterion cannot be proved, report the criterion
and boundary; do not broaden acceptance or replace it with an easier claim.

Use literal expectations from the verified old archive. Extend the existing
tests/fixtures/repl/reference-style.ts with the archive's L and History literals,
their exact source filenames, excerpts and SHA-256. Keep the accepted PR 3 word
adaptations explicit in that fixture. Expected cells, words and geometry must
not read REPL_PALETTE or production role maps. Test prepared and committed
frames, real targets and controlled operation ownership, rather than an array
that merely repeats implementation output.

Once the frozen focused commands pass, create the feedback commit promptly.
Then capture from that exact unchanged commit and run isolated break controls.
For each control retain its patch, command, first failing output and the named
assertion it broke. Restore all changed production files and SHA-verify them
against the feedback revision between controls. Keep the positive run and
restoration evidence. No dependency or generated-file mutation belongs to a
control. A baseline gallery/audit must fail named new claims; a passing count
alone is insufficient.

Hand back SHA, parent, stack base, changed files, every actual focused command
and result, fixture inputs/actions, cell/target evidence, gallery manifest,
image review, controls and cold before/after hashes. Stop before push or PR
creation unless separately authorized. Feedback does not inspect or await CI.

Delivery retains required CI/green, exhaustive runtime shards, typechecks,
lint, JSR and site gates. Do not run whole suites locally for confidence.
New test files enter normal discovery and weighted shards; do not hand-edit
weights. Runner measurement and any dependency/composability procedures apply
under AGENTS.md when delivery actually touches their boundary. Capture a first
failure before retrying and use the repository flake procedure for an unchanged
revision that passes only on rerun.

Continuity: exact stack inputs are above. Produced artifacts are this record,
pr2-implementation-handoff.md, pr3-implementation-handoff.md,
final-gallery-matrix.md and planning-measurement.md. Architecture decisions are
complete; no new persistence or API choice is open. PR 2 has no planning blocker.
PR 2 feedback is accepted at acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e; PR 3's execution
dependency is satisfied. The next Implementor action is to branch from that SHA,
prepare the worktree and implement the frozen PR 3 handoff.
