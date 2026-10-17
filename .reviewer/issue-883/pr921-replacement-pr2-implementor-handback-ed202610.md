# Replacement PR2 — correction of 5a3d32bd

One signed successor, for review.

- SHA: `ed20261025ed66da1fe473785a189e8a458af865`
- Parent: `5a3d32bd6209744f0e7b837567fae87bc17b7d57`, preserved
- Tree: `c34df63b3b7ef0ab8b08bae41729a196e4f961b2`
- Signature: `G`, `tarasm@gmail.com`
- Branch: `agent/issue-883-pr2-main-integration`, clean, **not pushed**
- Base of the increment: `85da74b9` (accepted replacement PR1), untouched
- 9 files, +587 / −39

Refs unmoved: `agent/issue-883-pr1` `79d404d0`, `agent/issue-883-pr2` `d4b0e326`,
`pre-integration/issue-883-pr2-d4b0e326`, `pre-rebase/issue-883-pr1`,
`pre-rebase/issue-883-pr2`. PR1's worktree untouched. The other writer's
`agent/issue-883-pr2-isolated` has moved on its own since the last handback — it
is at `99c27d92` now — and I did not touch it.

## Commands

The three the correction assigns, measured on `ed202610`.

| Frozen command | Result |
| --- | --- |
| 1 — host-generated-root, generated-xmd-root, agent-conversation, agent-function-components, agent-session-launch, agent-session-setup | **50 / 278**, exit 0 |
| 4 — repl-sidekick-presentation, journey, lifecycle | **36 / 130**, exit 0 |
| 5 — repl-sidekick-storage, recovery, configuration, controls, output | **32 / 170**, exit 0 |

Commands 4 and 5 grew by the rows added here (35→36 tests / 128→130 steps, and
31→32 / 166→170). `deno task check` exit 0 and `deno task lint` exit 0.

Commands 2, 3, 6 and 7 were not repeated, as the correction directs: no fix
here reaches their boundary. The only production change is three comments, and
`controls.ts`'s builders, whose behaviour command 5 covers.

## R-P1 — the four casts, with nothing standing in

| Site | Correction |
| --- | --- |
| `controls.ts` `reading()` / `writing()` | They take a whole `FunctionComponentDefinition` rather than `Omit<…, "generated">`, and the metadata comes from a new `offering(key, form, effect)` whose table is annotated as the partial record `GeneratedForms` already is. That annotation is what makes a *computed* form key check against `InvocationForm` instead of widening to a string table nothing verified — which is why the cast was there. |
| `repl-sidekick-controls.test.ts` `canonicalProps` | `props` is a `PropsSchema`, which is a JSON object, so it narrows with core's own `isJsonObject` — twice, once for the schema and once for `properties`. A schema that is not an object answers "no individual props", which is an answer rather than a failure. |
| `repl-sidekick-recovery.test.ts` IN5 | `chatKinds()` reads what a phase reported across a process boundary: it requires an array, narrows each item, uses `in` to reach `kind`, and throws naming the unreadable item rather than taking it on trust. |

No assertion replaced another. Checked: the diff against `5a3d32bd` introduces
no ` as ` type assertion anywhere. The older analogous assertions at
`profile.ts:277` and `recovery.test.ts:1131` were left alone, as assigned.

## R-E1 — IN6's capture, isolation and association evidence

Four new rows in `repl-sidekick-controls.test.ts` and two in
`repl-sidekick-journey.test.ts`, plus an extension of the existing
held-cleanup Stop row. All reuse the existing owner/control/Stop fixtures; no
public inspector, authority Context or callback protocol was added.

| Row | Observation |
| --- | --- |
| R3m | Two owners' controls answer their own request handles. The same source in both executions, so what tells them apart is the handle each control closed over — each owner asked exactly once, by its own reply. |
| R3n | A definition answered after setup reaches no response and runs nothing. The interception is installed inside `Execution.document` at `at: "min"` and is demonstrably in the chain — it is asked for `__root__` and `SidekickHost` — and is **never asked for the control's name at all**, because a generated admission resolves an admitted name from the sealed definition and does not consult the document's chain for it. The substitute's body was never entered; the response ran from the sealed snapshot against this owner's handle. |
| R3o | A selection composed after setup widens nothing. The reply writes the omitted name and is refused with "did not admit", before any control runs. |
| R3p | The control for both: the same source and ceiling with nothing intercepting, answering this owner's handle. |
| R5 *a later response reads a fact that changed* | A real entry publishes a root binding between responses; a third response reads the **new** value through the control sealed when the conversation opened. A control closed over a reading taken at setup would still answer the empty map, which is what the first response legitimately gets. |
| R5 *each response files its own ordered pairs* | One response's read and its failed fill, at orders 0 and 1 under its own response, and the next response's control at order 0 under its own — with nothing of the failing response's filed under the one after it, and the delivery naming the active conversation. |
| R6 *Stop … while a control's cleanup is held* (extended) | The successor now runs an actual control. The successor's read is the one answered pair under `response:2` at order 0; the held fill stays `unfinished` under `response:1`; and nothing of `response:1`'s control is filed under `response:2`. A late outcome moving across is exactly what clearing the response naming before its cleanup had joined would produce. |

Two things I got wrong first and corrected, both found by running rather than by
inspection. `<Each>` was my first "entry-only name" — but the language refuses a
structural construct wherever it is written, whatever any table says, so the row
would have proved nothing about the selection; the omitted name is now `File`,
an ordinary component an entry may be given. And a response that runs a
designated control and then fails still owes its feedback, so the correction
turn the product sends has to be scripted — that is this conversation's own
sequence, not an arrangement around it.

## R-E2 — IN5's identity assertion now reads the new turn

`canonicalTurns()` goes through `parseEntryRecords` and `parsePromptRecord` —
the typed readers the product reads these records with — to name each retained
turn and the native conversation it ran in. IN5c now asserts:

- the fixture holds `turn:1` and `turn:2` before the message, and `turn:3` after;
- **`turn:3`'s own native identity is `native-old`**;
- the active conversation is the one the fixture's first conversation record
  names, and `conversationPhases()` is identical before and after, so no second
  conversation was prepared or activated;
- the old file is still a prefix of the new one, and the first two turns read
  back identically;
- and the existing marker-2/marker-5, `generated_root:3`, single-`owner` and
  non-repeated-fill checks all stand.

**Break-it control.** Pointing the new turn at another conversation now fails
with `Expected: "native-old" / Received: "native-somewhere-else"`. The old
substring assertion passed in that same arrangement, which is exactly the gap
the review identified. The source was restored afterwards.

The fixture bytes and receipt are byte-identical; nothing was regenerated.

## The output-stream observation, restored where allocated

`E1a` in `host-generated-root.test.ts` now spawns a `forEach` over
`execution.output` while the run is live and, after completion:

- the chunks a consumer actually received contain the document's own text;
- they do not contain the root's distinctive text;
- nor does the stream's close value.

The existing returned-rendering and completion assertions are unchanged. The
positive half is what keeps it from going vacuous: a consumer that received
nothing would fail it. No PR1 production code, branch or worktree was touched,
and its old protocol tier was not copied.

## Comments corrected

`profile.ts` and `questions.ts` said the question is admitted by
`pinnedElicit()`; they now say `Elicit` is selected and not answered for.
`respond()` said the ordinal, the response identity, the ceiling and the journal
are all established per turn; the ceiling is not among them any more, and the
comment says what is — and that the response naming travels through `serving`.

## Not touched

No amend, reset, rebase, push, GitHub mutation, CI inspection, dependency or
cache work, user-history repair, or unrelated UI/Parse/teaching/delivery work.
EH1/UI10 remain the release's recorded baseline exception, unrepaired and
unweakened; command 6 was not rerun because nothing here reaches it.
