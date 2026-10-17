# Implementor handback: complete the Sidekick terminal (#883 PR 2)

**Feedback commit: `d634b28b24afa9a16a0a10ec7906c09d924c9db9`.**

- Parent: `ab681d4acd824665188f2c6ab9997eecbbf178e0` — the accepted base, with
  every ancestor preserved. No amend, no reset, no rebase.
- Branch: `agent/issue-883-pr2`, worktree `.claude/worktrees/issue-883-pr2`.
- Signature: **G**, `tarasm@gmail.com` (SSH, through the repository's configured
  signer).
- Tree: clean at `d634b28b`; nothing unstaged and nothing untracked.
- Main's unrelated edits were neither imported nor discarded; the main checkout
  stays at `e61d6ce0`.
- 12 files changed, +829 / −46.

Signing was blocked for a while by the 1Password SSH agent — `git commit` exited
with `error: 1Password: failed to fill whole buffer` and `ssh-keygen -Y sign`
confirmed the agent was refusing signature requests while still listing all
three keys. The work was left staged and the message in a file rather than
producing an unsigned commit. After the app was attended to, the identical
message committed first try. **All six focused commands below were then re-run
against this exact committed tree**, so no claim here rests on a run that
predates `d634b28b`.

## Scope delivered

Production, exactly the assigned modules:

- `packages/cli/src/repl/presentation-style.ts` — accepted surfaces; the one
  `edge` constant that drew both roles is replaced by `columnDivider` and
  `chromeEdge`; `transcriptHeaderSurface` and `inspectionHeaderSurface` added;
  `bindingsSurface` renamed `rightSurface` (one call site) because the pane is
  accepted as the right pane under either tab. Palette member names were
  delegated by the plan.
- `packages/cli/src/repl/layout.ts` — `bodyProps` takes `chromeEdge`,
  `paneColumnProps` takes `columnDivider`, and `headerRowProps` is the existing
  measured row with a background.
- `packages/cli/src/repl/application.ts` — `rowBox` takes an optional header
  surface; the transcript title, the right title and both tab rows carry their
  accepted fills.
- `packages/cli/src/cli.ts` — `REPL_HELP`, its doc comment, the command's doc
  comment and the second sentence of the more-than-one-location refusal.

Tests and fixtures: `repl-sidekick-journey.test.ts` (TE1, TE2),
`repl-sidekick-configuration.test.ts` (TE3),
`repl-presentation-style.test.ts` (TE4), `cli-help.test.ts` (help),
`fixtures/repl/issue-883/mounted-program.ts` (two selections),
`fixtures/repl/issue-883/reference-style.ts` (new, independent).
Prose: `specs/repl-spec.md`, `architecture.md`.

No Core/ACP, provider-publication, admission, journal, route, owner-lifetime,
permission, dependency, lock or test-discovery change. No new abstraction,
parser, registry, debug surface or renderer change. No rounding or validator
relaxation; no geometry was subtracted in one pass.

## Every command, and its exact result

Run from the implementation worktree against the committed tree `d634b28b`,
which is clean. These are the plan's six exact commands, in its own order.

| # | Command | Result |
| --- | --- | --- |
| 1 | `deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts` | `ok \| 12 passed (63 steps) \| 0 failed (33s)` |
| 2 | `deno task test packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-history.test.ts` | `ok \| 46 passed (194 steps) \| 0 failed (5s)` |
| 3 | `deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-source-reading.test.ts` | `ok \| 36 passed (187 steps) \| 0 failed (55s)` |
| 4 | `deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/cli-help.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-exit-pty.test.ts packages/cli/tests/repl-presentation-style.test.ts` | `ok \| 46 passed (169 steps) \| 0 failed (2m26s)` |
| 5 | `deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-execution.test.ts` | `ok \| 58 passed (142 steps) \| 0 failed (1m46s)` |
| 6 | `deno task test` + the five absolute `.reviewer/issue-883/pr2-*probe*.test.ts` paths (the unchanged Preview/Sessions probes) | `ok \| 5 passed (10 steps) \| 0 failed (8s)` |

Totals: **203 tests, 765 steps, 0 failed.** An identical pass of all six ran on
the same content while it was staged, before the commit object existed.

Neither open flake recurred: no L2 and no U2 failure appeared in any of the six
runs. No assertion was weakened and no unrelated flake or the existing
no-yield-in-finally lint issue was touched. Broad lint/check/JSR/runtime
suites, CI and captures were not run and are not claimed.

## First failures, preserved

**TE4 on the base, before any colour changed** — the required discrimination:

```
TE4: each pane, header, divider and edge is the accepted value in its own cells ... FAILED
  Array [
    "160x36 Sidekick",
-   1515818,        # 0x17212a, the accepted transcript header
+   790033,         # 0x0c0e11, the transcript's own surface
  ]
```

The transcript title had no header surface of its own on the base, exactly as
the plan recorded. After implementation both TE4 rows pass.

**TE4's narrow row passed on the base**, and that is honest rather than
satisfied: it asserts the *absence* of the accepted divider and header fills,
which did not exist anywhere on the base. It becomes discriminating only beside
the wide row — the same two values are now required in the columned profiles and
forbidden at 72x20.

**The one superseded assertion**, `P1-T3: an empty screen's panes, edges and
uncovered area are each their own`:

```
  Array [
    "sidebar",
-   592652,         # 0x090b0c, the #881 archive's sidebar
+   1054752,        # 0x101820, the accepted refinement's
  ]
```

**TE1's two first failures were fixture mechanics, not product facts.** The
message text `"greet the names"` is wider than the Sidekick pane, so
`sendMessage`'s own barrier never saw it whole; and `"Thanks for the table
receipt."` wrapped across two chat rows, so a single-row `shows` could not find
it. Shortened to `"greet"`/`"table"` and `"Table receipt."` — M3's own lengths.
No assertion about the journey changed.

## Fixture and assertion adaptations

- **`fixtures/repl/issue-883/reference-style.ts` is new and independent.** It
  transcribes `repl-sidekick-clear-columns.html`
  (`f987486535d8c3aa48033e1a3c903b042bad1efd4b6e863390c967b508028a51`) with its
  own provenance. `fixtures/repl/reference-style.ts` is untouched: the #881
  archive's `side`, `bind` and `edge` literals stay as history, and the two
  files disagree on purpose. No expected value imports a production constant.
- **`P1-T3` adapted, not weakened.** Its two superseded values now come from the
  #883 fixture and the transcript's own `SURFACE.center` stays. Its top anchor
  moved because a pane with a title now has a header surface on that row, so the
  pane-surface claim is read where its header is not and the header is asserted
  *as* the header. The whole-width, measured-cell and per-pane claims are
  unchanged, and the two edge roles are now asserted as two values.
- **`CH12` re-anchored**, keeping its claim that the command's own help
  describes what an execution does with its entries, and adding
  `not.toContain("exactly one entry")` so the retired sentence cannot return.
  `CH13`'s refusal assertion reads only `xmd repl takes at most one location`
  and was not touched; flags, copied-location help and the no-effects-on-help
  claim are unchanged.
- **`useMountedHost`/`useMountedRepl` gained `defaultAgent` and `sidekitAgent`**,
  both defaulting to `MOUNTED_AGENT`. Every existing caller is unchanged and
  still runs one agent for both families. The selections travel the production
  path: `resolveAgentStack` for the entry default, `assembleReplProfile` for the
  Sidekick's. No new CLI export or selection mechanism.
- No new mutation battery, no new permutation, no renamed existing test.

## TE5 — terminal-evidence reconciliation

Every clause of the original frozen R5–R8 rows, against an exact permanent test
title and the command that runs it. "Layer" says what the row proves.

### R5 — `repl-sidekick-journey.test.ts`, plus R3 in `repl-sidekick-controls.test.ts` (commands 3 and 2)

| Original clause | Exact permanent test title | Layer |
| --- | --- | --- |
| Run the real greeting then table revision in one conversation | `TE1: the names a seed published become the greetings a real entry prints` | mounted command, real entries |
| A second binding fixture changes one name and changes real output | `TE1: changing one published name changes the greetings and the table` | mounted command, real entries |
| Compare observed binding, shared draft, admitted source, output and provider feedback | `TE1: the names a seed published become the greetings a real entry prints` | mounted command |
| Failed entry then new corrected entry | `TE2: the failure goes back to its owner, which submits a corrected entry` | mounted command |
| Earlier effect then ordinary failure | `R5: an ordinary root failure keeps what Core rendered and the fill before it`; `R5: an ordinary failure goes back as a correction, and the next reply answers` | owner over real Core |
| Controls-only response | `R5: a reply that prepares and submits an entry does both, for real`; `PV1: a reply that says nothing to the person leaves no preview behind` | owner |
| Output-only response, and no generic return feedback | `R3b: every control this CLI supplies is designated, and <Syntax /> is not`; `R3l: controls are recorded in the order the reply admitted them` | owner |
| Invalid complete response, refused before effects | `R3c: a name this ceiling does not admit refuses the whole reply`; `R3d: a control written in the wrong form refuses` | owner |
| Preview replacement; no source execution after provider failure | `PV1: the preview and the reply that replaces it are one item`; `PV1: a failed generation leaves one Incomplete in the item it was shown in`; `PV1: control — a successful generation leaves one reply in that same item`; `PV2: what the screen shows a prefix saying is what the pure reader says` | owner + pure reader |
| Initial bootstrap/index/compact surface without full chapter or catalog injection | `R5: the first turn of a conversation carries the orientation it needs`; `R3a: the compact surface describes exactly what is admitted`; `R3: the index is the admitted chapters, with their own stated purpose`; `R3: the bootstrap ships too, and says what a reply may not assume` | owner |
| All six guides, a two-guide response, literal text, ordered owning feedback, no effects | `R3g: all six guide chapters are readable, and return literal Markdown`; `R3: every shipped chapter reads back as exactly the file it is`; `R5: two reads come back with their own headings, in admission order`; `R5: a chapter a reply read comes back to it, and it answers from it` | owner |
| Contextual environment snapshot with an explicit unknown | `R3: the environment states what this host knows and what it does not`; `R3: a host that cannot describe itself refuses the read` | owner over contextual host |
| On-demand entry/name lookup, entry-only vocabulary, literal EntryInput, index refresh; documentation grants no permission | `R3e: a read asks for exactly what the element said, and renders the answer`; `R3f: a lookup carries its names, and a bare read carries none`; `R3: the vocabulary a reply is told about is the entry's, not its own`; `R3h: the draft is filled with literal captured source, exactly once`; `R5: an orientation a newer build would give differently is refreshed once` | owner |
| Bindings as the detached map; a read performs nothing | `R5: Bindings comes back as the detached map itself`; `R3: the latest acknowledged root, read from an earlier selected position`; `R3: a value the running entry has already published is in that reading` | owner |
| New-conversation / cold-reopen, reused from R2/R7 | `R5: reopening restores the chat and asks the provider for nothing` | owner + repository |
| The already mounted baseline this slice builds on | `M3: the message a person sends runs its entry, and is answered about it` | mounted command |

### R6 — `repl-sidekick-lifecycle.test.ts` (command 3)

No TE row was assigned; every clause has an existing witness, preserved
unchanged.

| Original clause | Exact permanent test title |
| --- | --- |
| Hold generation, response admission, entry completion/teardown and a Sidekick Elicit independently | `R6: Stop cancels the generation in flight and leaves the chat readable`; `R6: Stop before durable admission keeps that startup from ever admitting`; `R6: Stop does not return, or free the owner, while a control's cleanup is held`; `M6: Stop reports nothing and enables no successor while its cleanup is held` |
| Stop joins Sidekick promptly and leaves an admitted entry running; later completion starts no turn | `R6: Stop leaves an entry it admitted running, and starts no further turn`; `M6: Stop withdraws the wait and leaves the entry it admitted running` |
| A submission cancelled before admission; Stop with nothing running | `R6: a submission cancelled before its entry starts withdraws its own request`; `R6: control — released without Stop, a held startup admits what was asked`; `R6: Stop with nothing running changes nothing` |
| Invalid/partial/closed/tab-switched answers remain owned; a valid answer reaches only Sidekick while an entry question survives | `R6: an invalid answer answers nobody and leaves the same question pending`; `R6: an entry's question and a reply's are two questions with two answers`; `MQ2: an invalid answer keeps the question, and closing keeps what was typed`; `MQ2: control — the same answer without closing or changing panes`; `MQ3: answering the Sidekick leaves the entry's question pending, and vice versa` |
| Stop withdraws the pending question and invents no answer | `R6: Stop withdraws the pending question and invents no answer`; `MQ3: Stop withdraws the Sidekick's question and invents no answer` |
| Exit and Control-C join all owners, append no invented terminal or answer, restore the terminal without another keystroke | `M8: Exit joins the owner and the entry before the command returns`; `M8: Control-C joins the same work, without another key`; `MQ5: Exit answers neither question and restores the terminal once`; `MQ5: Control-C does the same, without another key` |
| Provider failure waits for explicit same-conversation retry | `PV3: a provider that fails after saying something leaves an unfinished attempt`; `PV3: Stop keeps what was said as an attempt, and claims nothing that was not saved`; `CFG5: Retry sends the saved request again, not whatever is in the box` |
| Fatal policy/teardown failure retains classification | `R6: a schema this surface cannot draw asks nobody, and the reply is told why`; `CFG9: a save still waiting for the writer is cancelled, and appends nothing` — authoritative Core classification already reviewed and unchanged |

### R7 — `repl-sidekick-configuration.test.ts` and `cli-help.test.ts` (commands 4 and 2)

| Original clause | Exact permanent test title | Layer |
| --- | --- | --- |
| Real CLI parsing rejects malformed `--sidekit-agent` before history or terminal effects | `C2: repl states its own Sidekick agent option, and names a value or refuses`; `CH13: xmd repl refuses a bad command line before it opens anything` | real subprocess, argv only |
| Distinct entry/Sidekick flags and environment/package fallbacks use actual different agents | `R7: the Sidekick's agent is this command's own selection, settled with the profile` (assembled profile) **and** `TE3: the entry uses its unstated default and the Sidekick its own selection` (actual provider traffic) | assembled profile + mounted runtime |
| Reopen retains the saved selection | `R7: a reopened Sidekick keeps the agent its conversation was opened with` | owner + repository |
| Configure sends no prompt; retains advertised IDs/grouping/unsupported state; refreshes effort | `CFG1: Configure shows what the agent really offers, and nothing asks before it`; `CFG1: control — an agent that offers no model choice says so`; `R7: a setting an agent does not offer is nothing, which is not an empty list`; `R7: effort choices follow the model being chosen, and choosing one moves nothing`; `CFG2: a chosen model brings its own effort levels, and Apply saves them` | owner + mounted |
| Desired settings apply and read back on the next turn; rejection starts no turn | `R7: a desired model and effort are applied and verified at the next turn`; `R7: a configuration the agent refuses starts no turn and is not quietly dropped`; `CFG3: a preference saved while an entry is held is used by the turn after it`; `CFG3: control — with nothing changed, that turn uses the old settings` | owner + mounted |
| Idle/busy explicit switch retains prior chat and activates only after setup; failed setup keeps the old association | `R7: changing agent starts another conversation and keeps the chat already read`; `CFG4: an idle replacement keeps the old chat and runs the next message under the new agent`; `CFG4: a busy replacement stops the turn and joins it before the new agent`; `CFG4: an unreachable agent keeps the old association and says why`; `SS4: a failed replacement preserves the reading and the association` | owner + mounted |
| Unavailable agent Retry/Configure makes no implicit fallback | `R7: a change to an agent that cannot be reached leaves the conversation a person is in`; `CFG5: a request whose acceptance cannot be established is not offered again`; `CFG5: control — with no failed request, nothing offers a retry` | owner + mounted |
| Truthful help | `CH12: program help lists repl, and its own help describes how entries follow` | real subprocess |

**This is layered evidence and is described as such.** C1/C2 and `CH13` prove
argv spelling, precedence and early refusal in a real subprocess; `TE3` proves
the runtime half in one mounted command. No single row exercises every flag and
the interactive screen at once, and none claims to.

### R8 — `repl-sidekick-presentation.test.ts` and `repl-presentation-style.test.ts` (command 4)

| Original clause | Exact permanent test title | Layer |
| --- | --- | --- |
| Real mounted tree/commit/grid at all three profiles | `M7: all three profiles keep both texts, the footer's seven rows and one body` | mounted command |
| Initial Draft focus, explicit Message Sidekick focus, independent revisions | `M1: a fresh command shows its Sidekick, asks the agent nothing, and still runs entries`; `M4: a delayed acknowledgement clears what was sent and keeps what came after`; `M4: control — with nothing typed after it, the same message clears the box` | mounted |
| Busy Send-disabled / Stop-visible | `M5: while generation is held, Stop is the control and Send cannot start a second cycle`; `M5: the first reply appears while its follow-up is held, with nothing pressed` | mounted |
| Hidden-body target absence | `M7: selecting Bindings removes the Sidekick's body and its input targets` | mounted |
| Pane-local drawers | `MQ4: the form stays inside its own pane at every size, and survives a refusal`; `CFG6: Configure stays inside its pane at every size, and survives a refusal`; `Q-P1: a form hidden by a resize does not consume Draft typing`; `Q-P2: History over an open form closes once and leaves the form waiting` | mounted |
| Sessions identity | `SS1: both sections hold their own work, settled in the order each finishes`; `SS7: a no-Sidekick reading keeps the entry-only surface; an unreadable one refuses`; and the remaining SS2–SS6 rows | mounted |
| Seven-row footer | `M7: all three profiles keep both texts, the footer's seven rows and one body`; `TL1: every supported size keeps its columns and its seven footer rows`; both `TE4` rows | mounted + committed grid |
| Explicit versus default Sidekick shrink, expand | `M7: a default Sidekick shrinks to narrow Entries, and an explicit one stays`; `M7: an older entry stays frozen while the Sidekick works, and Bindings still reads it` | mounted |
| 60x15 refusal and recovery with both drafts and a partial question intact | `M7: a terminal below the minimum refuses, and recovers with both texts`; `CFG6: a half-filled Sidekick question keeps its values across Configure` | mounted |
| **Assert separator/header/footer cells using independent reference values** | `TE4: each pane, header, divider and edge is the accepted value in its own cells`; `TE4: a narrow frame routes one body, keeps seven rows and draws no wide chrome`; `P1-T3: an empty screen's panes, edges and uncovered area are each their own` | committed production grid, SGR cells |
| Review the capture packet | **open** — the 36 frames and the visual review are the next assignment |

No frozen clause was found without a witness, so there is no gap to return.
The teaching work is **not** claimed: the scripted transport in TE1–TE3 proves
data flow and routing, and nothing here establishes that an unfamiliar agent
learned the language. The unfamiliar-agent walkthrough, the V01–V11 / 36-frame
packet and delivery remain the separate following assignments.

## Non-blocking observations — the Planner decides

1. `REPL_DESCRIPTION` still reads "Run and reconstruct one XMD entry in an
   interactive terminal", and `CH12` asserts it. The assignment named
   `REPL_HELP` and exactly two stale assertions, so this third assertion and its
   string were left alone. It reads as the activity rather than a cardinality
   limit, unlike the sentence that was retired, but it is the last place the
   one-entry phrasing survives in user-facing text.
2. `SIDEKICK_QUIET` in `repl-presentation-style.test.ts` is declared and unused,
   and is not a complete `ReplSidekickReading` — it fails to typecheck if
   assigned to `ReplLive.sidekick`. It predates this slice; TE4 uses
   `NOTHING_LIVE` instead, which is enough for chrome. Not repaired here.

## Next action

Planner review of `d634b28b24afa9a16a0a10ec7906c09d924c9db9` against the frozen
TE1–TE5 threshold. No push, PR, GitHub write, CI inspection or capture was
performed — none is authorized for this slice. The unfamiliar-agent teaching
walkthrough, the V01–V11 / 36-frame real-terminal packet and delivery remain the
separate following assignments.
