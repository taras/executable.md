# Sessions correction review: REQUEST CHANGES at 5ce2e2d2

SS-P1, SS-P2 and SS-P3 are closed. Their three unchanged probes pass, including
all paired controls. Most SS-E1 observations are now present. Sessions is not
yet accepted: its Stop-before-append evidence still uses an uncancellable native
gate, the required partial-question/read-only visit is absent, and the requested
permanent cross-chat regression pair has not been promoted. Three new test
casts also conflict with the repository's explicit cast-free instruction.

Execute [the narrow evidence correction](pr2-sessions-implementor-correction-5ce2e2d2.md).
No original production fix is assigned again and no new architecture decision
or product permutation is introduced.

## Exact revision

- SHA: `5ce2e2d2ca7d4236ff9ceec224cc99dcf365f299`.
- Parent: `4ee4f44824ce39f41385e70cce107bd0d110ec6c`, preserved; 10b17a40
  remains below it.
- Branch: agent/issue-883-pr2; signature G, tarasm@gmail.com.
- Implementation worktree: `.claude/worktrees/issue-883-pr2`.
- Independently verified clean, no untracked files.
- Six files, +1095/−58: application.ts, program.ts, two tests and two documents.

The [frozen plan](pr2-section5-sessions-planner-handoff.md),
[Architect decision](pr2-section5-sessions-architect-decision.md) and
[previous correction](pr2-sessions-implementor-correction-4ee4f448.md) govern.
The implementation direction and previous accepted slices stay closed.

## Closed production findings

**SS-P1:** entry:none is now emitted outside the catalog window in both
measurement and committed description. entriesRowCount() counts actual catalog
rows, so the measuring and drawing passes agree about the placeholder's row.
This fixes the sidebar overflow without rounding geometry, relaxing validation
or changing vendored code. The nine-message probe passes, and the new twelve-turn
old-chat journey also keeps the real mounted command usable.

**SS-P2:** the local addressed value now includes its conversation and compares
both conversation and turn before giving an incomplete item the response key.
The old reply and failure stay distinct. No item is dropped or inferred.
The unchanged cross-chat probe passes both arms.

**SS-P3:** reduction keeps an exact process-local {conversation, turn} reveal;
the destination's measured capacity computes the offset. revealedAt() prefers
the reply/incomplete/saved anchor over the person row. Explicit scroll and Back
spend the pending reveal. Both the unchanged measured probe and the new real
off-window activation from Bindings pass. No route scroll field, guessed
rectangle or second focus store is added.

The setup reading is detached from the selected chat's own saved phase/reason.
Its optional form is acceptable: absence claims no setup fact and preserves
the unchanged reveal probe's existing reading literal. It is private CLI data,
not a new Core/provider boundary.

## Remaining SS-E1: the Stop gate can write after Exit

The new SS3 row clicks Stop while the canonical append is held, sees no saved
turn, exits, releases the gate, then opens the cold reader without waiting for
the native append to finish. The existing mounted fixture implements the hold
inside a Promise chain:

```text
held Promise -> appendFile(path, record) -> gate.reached.push(path)
```

Cancelling the Effection wait does not cancel that native Promise chain.
Releasing it after command teardown still schedules appendFile. The row's
immediate cold refusal does not prove the eventual file contains no turn.

The [append-evidence diagnostic](pr2-sessions-append-evidence-probe-5ce2e2d2.test.ts)
uses that exact host gate and waits on its existing physical-completion fact,
gate.reaching(file). [First output](pr2-sessions-append-evidence-probe-5ce2e2d2-first.log)
shows:

```text
stopped: true, commandEnded: true, savedTurnsAfterPhysicalAppend: 1
```

The no-Stop control also saves one turn and passes. This disproves the row's
claim that nothing is saved after the gate is released. It is a diagnostic of
the chosen fixture boundary, not a new claim that every native filesystem write
must be cancellable or a mandate to change the accepted production writer.

The prior correction explicitly required a cancellable hold at the owning
operation boundary before physical append. Use that boundary for this evidence,
retain the exact publication key, cancel/join the held operation, and prove no
late physical write before the cold-refusal check. Do not change an irreversible
write into a cancellable one by a sentence or infer teardown from an empty file
sample. Return a concrete ownership conflict if the accepted boundary cannot
be reached. Do not widen or harden production storage merely to make the native
Promise diagnostic green; it is not a required product regression command.

## Remaining SS-E1: preservation and permanent coverage

The new off-window journey establishes a genuinely selected entry, a partial
message and a long nonactive chat. The populated three-profile journey is now
genuinely read-only. Those observations are accepted.

Neither journey asks a current Sidekick question or types a partial answer.
The SS4/SS7 requirement to visit an old chat with that form pending, hide its
modal/input/targets, type into the visible Draft and return to the same partial
answer is still unwitnessed. The older Configure, resize and entry-question
tests exercise different ownership conditions. Complete this one already
assigned journey, including measured/mounted/target absence; do not add another
question design or a permutation matrix.

The cross-chat alias probe still exists only in the review packet. The new real
gap row uses one chat and composes the final reading without a live current
failure; it cannot exercise the alias condition that was fixed. Promote the
paired cross-chat canonical-composition regression/control into the ordinary
corpus and extend the existing two-chat/current-update mounted path to cover
that failure with old chat selected. Both were required by SS-P2's correction.
Do not replace the old failed item or infer its response name.

## Remove three newly added casts

The correction adds these casts in its evidence:

- repl-sidekick-journey.test.ts's SS1 row casts records() to a local array shape.
- repl-sidekick-presentation.test.ts's SS3 row casts an event after discriminating
  `record.kind === "event"`.
- The same file's SS7 held-evaluation row repeats that event cast.

AGENTS.md rule 6 and the original assignment say to parse/narrow rather than
type cast. The two event casts are unnecessary after the existing discriminant
check. For the unknown-array helper use actual typed records or ordinary checked
narrowing. Change only these new sites; the pre-existing casts and unrelated
lint error are not a cleanup assignment.

## Accepted evidence and adaptations

The new SS1 real-owner row captures one registered key across generation,
canonical save/held evaluation and final reply. The file proves one Prompt and
no response while evaluation is held; live.turn carries the actual saved
ordinal. That meets the bounded progress/recording distinction even though
owner.reading.turns refreshes after the evaluated response. No new owner refresh
or product behavior is required for this finding.

The new cold unknown-ID test has an actually unfinished entry, refuses before
runtime/provider work, compares both files and has a successful-open control.
The failed-setup cold row retains the actual reason and no provider key, opens
read-only and returns to the preserved active association. The shared-key row
uses real entry history with a detached Sidekick row and proves one filter and
two owner rows; the existing canonical key table supplies the parsing evidence.
These are accepted at the finite evidence boundary, not requests for new variants.

The real Stop/exit/reopen gap reaches the Sessions composition. The automatic
feedback cold row opens its real saved/no-response anchor without publishing
machine input. The new populated profile/reveal rows supply the layout
observations missing in the previous revision.

Replacing the old vacuous negative columnShows check with the actual
model.turns absence is justified. The reported first failure after that test
edit and its fix is not an unchanged green rerun or a flake. columnLacks() states
the limited absence it can prove; it is not used to settle unknown identities.
No old behavior assertion is weakened. The original three mutations were not
repeated; their named connections are unchanged and their accepted results stand.

## Independent focused commands

All seven frozen selections, both unchanged Preview probes and the three
unchanged correction probes ran at this exact SHA. First outputs are preserved:

| Selection | First result | Output |
| --- | --- | --- |
| Mounted Sidekick / owner journey / lifecycle | 30 tests / 108 steps, green | [mounted](pr2-sessions-review-5ce2e2d2-mounted-first.log) |
| Route / history / boundaries | 18 / 87, green | [route](pr2-sessions-review-5ce2e2d2-route-first.log) |
| Agent interface / journey | 21 / 59, green | [agents](pr2-sessions-review-5ce2e2d2-agents-first.log) |
| Storage / recovery / configuration | 17 / 96, green | [recovery](pr2-sessions-review-5ce2e2d2-recovery-first.log) |
| Entries / execution / controls / output | 45 / 177, green | [entries](pr2-sessions-review-5ce2e2d2-entries-first.log) |
| Ordinary journey / forms / layout / style / source | 71 / 223, green | [ordinary](pr2-sessions-review-5ce2e2d2-ordinary-first.log) |
| Execution / lifecycle | 5 / 38 passed; L2 failed, 1 test / 1 step | [lifecycle](pr2-sessions-review-5ce2e2d2-lifecycle-first.log) |
| Both unchanged Preview probes | 2 / 4, green | [Preview](pr2-sessions-review-5ce2e2d2-preview-probes-first.log) |
| Three unchanged correction probes | 3 / 6, green | [corrections](pr2-sessions-review-5ce2e2d2-correction-probes-first.log) |

L2 again expected Elicit:active:question but sampled Elicit:enter at the unchanged
line 130. Without any source, fixture, assertion, dependency or environment
change, the [isolated rerun](pr2-sessions-review-5ce2e2d2-lifecycle-isolated-rerun.log)
passes 1 / 8 and the [complete rerun](pr2-sessions-review-5ce2e2d2-lifecycle-rerun.log)
passes 6 / 39. The recurrence is recorded in the existing
[open L2 record](pr2-repl-lifecycle-l2-flake-10b17a40.md); its cause is not fixed.
U2 does not recur. No environment limitation occurs in these commands.

Final seven-selection total is **208 tests / 789 steps**, plus **five unchanged
probes / ten steps**. This is not an all-first-runs-green claim. The Implementor's
check = 0 and pre-existing lint limitation are noted, not independently rerun or
used as prerequisites. No full suite, CI, packaging or capture was inspected.

## Disposition

Keep the three production fixes and accepted evidence closed. Finish only the
remaining SS-E1 observations/permanent coverage and remove the three new casts,
then return a new signed feedback commit. No new mutation battery or architecture
interview is required. Sessions remains unaccepted; latest accepted head stays
10b17a40. Full terminal acceptance, captures and delivery remain deferred.

No Planner production edit, commit, push, GitHub write, CI inspection, capture,
dependency or shared-cache change was made. Exact head/signature/clean status
were checked before and after review.
