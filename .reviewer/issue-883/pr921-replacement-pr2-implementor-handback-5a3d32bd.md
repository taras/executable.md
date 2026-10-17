# Replacement PR2 — implementor handback

One signed commit, for review.

- SHA: `5a3d32bd6209744f0e7b837567fae87bc17b7d57`
- Parent / base: `85da74b938434773d7faf3caa5e2ca007328fdca` (accepted replacement PR1)
- Tree: `65aa5898735c3feee8b689655862c41d8c4b05c5`
- Signature: `G`, `tarasm@gmail.com`
- Branch: `agent/issue-883-pr2-main-integration`, clean, **not pushed**
- Source C: `d4b0e326d76fa63c6ee7a97e189986bbd371243d`
- 193 files, +46,374 / −2,853

Refs preserved and unmoved: `agent/issue-883-pr1` `79d404d0`,
`agent/issue-883-pr2` `d4b0e326`, `pre-integration/issue-883-pr2-d4b0e326`
`d4b0e326`, `pre-rebase/issue-883-pr1` `79d404d0`, `pre-rebase/issue-883-pr2`
`d906c636`. Replacement PR1's branch and worktree were not touched.

**Another writer's branch exists.** `agent/issue-883-pr2-isolated` points at
`85da74b9` and is checked out in `/private/tmp/xmd-issue-883-pr2-isolated`,
created from the same base by somebody else. I left it exactly as it was.

## The seven frozen commands

All measured on `5a3d32bd` itself, after the commit.

| | Selection | Result |
| --- | --- | --- |
| 1 | host-generated-root, generated-xmd-root, agent-conversation, agent-function-components, agent-session-launch, agent-session-setup | **50 / 278**, exit 0 |
| 2 | acp provider, native-launch, host-conversation, loaded-copy | **29 / 224**, exit 0 |
| 3 | generated-xmd-preview, secret-detection, workflow-agent-checkpoints, cli workflow-agent, workflow-agent-sessions | **11 / 114**, exit 0 |
| 4 | repl-sidekick-presentation, journey, lifecycle | **35 / 128**, exit 0 |
| 5 | repl-sidekick-storage, recovery, configuration, controls, output | **31 / 166**, exit 0 |
| 6 | repl-entries, repl-history, repl-agent-execution, repl-journey, repl-forms | **RED — 88 passed / 263 steps, 2 failed** |
| 7 | repl-route, repl-layout-admission, repl-presentation-style, repl-source-reading, repl-execution, repl-lifecycle | **42 / 184**, exit 0 |

Six commands green; **command 6 is red and is reported red.** Its two failures
are EH1 and UI10 in `repl-entries.test.ts`, and they fail byte-identically to the
recorded baseline:

```
EH1   Expected value: "No entry output recorded at this checkpoint."
      Received array: ["No entry output recorded at this"]
UI10  - "Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab move"
      + "Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab "
```

Both strings match three independently recorded prior logs in this packet —
`pr921-repl-entries-preexisting-at-940249af.log`, `pr921-command-3-first.log`
and `pr921-historical-identity-review-f83e3554-command-3-first.log` — so these
are the same recorded truncation observations the release's exception covers,
not new integration regressions. Nothing was skipped or weakened to reach that.

`deno task check` exit 0, `deno task lint` exit 0, `deno task validate:docs`
reports component documentation complete.

## How the port was done

C's delta over old PR1 is 198 files, +49,787/−3,118. Applied three-way onto
`85da74b9`: **172 files clean, 26 conflicted.**

Twelve files are owned by both increments. For those I reset to `85da74b9` and
re-applied only PR2's own commits, **in chronological order** (`git log
--reverse`) — applying them newest-first manufactures conflicts that are not
real. Five of them needed nothing at all because every commit that touched them
was PR1's: `host-generated-root.test.ts`, `support/held-host.ts`,
`generated-root-owner.ts`, `document-output-api.test.ts`,
`execution-protocol.test.ts`. All five are byte-identical to `85da74b9` in this
commit, which is the moved-hunk allocation check.

Where main had moved first, main's wins and PR2's references follow it: the
`<Dir>` grant identity in `workflow-suspension.test.ts`, `validateBodyStructure`
(main deleted `validateOutputPlacement`; nothing used PR2's renamed
`validateOutputStructure`), `ordinaryGeneratedSelection`, `PlanWriterPlacement`,
and the audit/session-identity prose in `acp-client-spec.md`.

## The two design decisions

### `<Elicit>` is selected, not pinned

The Architect decision forbids restoring "pinned* factories as a Sidekick
installation API", and on main's model nothing is lost by obeying it:
`components/Elicit.ts` already declares
`generated: { paired: { identity: ".../elicit/ask", effect: "write" } }`. So the
conversation **selects the protected name** and canonical resolution answers it
from core's own tier — which is what makes a reply's question the question an
authored document asks, and what keeps a repository, registered or middleware
`Elicit` from receiving a reply's permission.

`pinnedElicit()` is therefore removed from `generated-xmd.ts` and from
`core/host`. Its paired-only, write-class invariants are now the declaration's
rather than the entry's, and `GR30`–`GR32` pass unchanged on that basis.

One consequence worth naming: the compact surface has no schema of its own to
read for a name it does not define, so the `Elicit` control states the authored
contract it was selected under. To keep that from drifting, the controls tier
now compares that surface entry against **the registry's own schema** rather
than a literal — so a core component that gained a prop fails the row instead of
leaving a reply under-told.

### The conversation's controls are captured at setup

C passed `observations`/`mutations` with every `evaluateGeneratedXmdRoot` call.
On main a root is admitted from the selection its *execution* captured, so:

- `controls.ts` yields `SidekickControl { name, form, effect, definition?, props? }`
  and puts each control's identity and effect **on the definition**, under
  `https://executable.md/components/repl/sidekick/<key>`;
- `profile.ts` derives one `ComponentAnswerInstallation` that answers each owned
  name and the `Component.generated` selection naming them, offered from the
  same `install()`;
- `owner.ts` builds the ceiling **once**, at owner scope, and the request now
  carries only `{ id, source, allow }`.

Each response's journal association survives through a `ServingResponse` holder:
`servingThrough()` names the response for the evaluation and gives the name back
in an `ensure` registered *before* the work, so it outlives the evaluation's own
cleanup and a control settling late still files under the response that ran it.
A control invoked with no response running refuses rather than filing under
whichever came next.

**Two bugs this surfaced, both found by the suites rather than by inspection.**
The provider first answered every time, so it was still answering while a
response resolved its admitted name — which canonical execution refuses as
substitution. It now answers each name once and settles. Then the settled set
was per *owner*, so a reopened or replaced conversation found every name already
settled and its controls unresolvable (`Cannot resolve component:
Guide.Bindings`); it is now per `install()`, and therefore per execution. That
second fix is what turned eight red CFG4/CFG8/SS4 rows green.

## IN5 — run-produced old-format evidence

The fixture is at `packages/cli/tests/fixtures/repl/issue-883/old-chat/` with
its receipt, and a copy with the same receipt is in this packet at
`in5-old-chat-d4b0e326/`.

- Writer: **`d4b0e326`**, the accepted source C, run **before** the worktree
  left that commit, through three real subprocess phases of `recovery-phase.ts`
  over a real repository root. Nothing was appended by hand.
- `sidekick.jsonl`: 20 records, 25,327 bytes, sha256
  `333c901fd223788b366d4ebd363c67da090e9254e060b29c96de5db77c07f400`.
- Turn 1 completed (`response:1`, "The first reply."). Turn 2 was interrupted
  with `<Elicit>` "Which one?" pending, holding a `control`/`control-outcome`
  pair for the `REPL.EntryInput` fill that did happen beside a second `control`
  with no outcome.
- **Marker receipt:** `generated_root:1` and `generated_root:2`, both
  **version 2**, at the result and inside the policy.
- Test-authored throughout: agent `stub`, command `stub-cmd`, root
  `agent/conversation.md`. No saved conversation of the user's, no native
  credential. The chat journal holds zero occurrences of `/Users/` or
  `/var/folders`.
- The provider's own `acpx/sessions` entry is deliberately excluded: its `cwd`
  and key digest this machine, and the established native conversation is read
  from the retained canonical turn rather than from a mapping record.

Three rows in `repl-sidekick-recovery.test.ts`, Tier IN5, all passing:

| Row | Observation |
| --- | --- |
| IN5a | Opening cold changes no byte, sends no prompt, establishes no session, appends nothing; the settled control is retained as `ok` and the question is reported waiting, not re-asked |
| IN5b | The chat still reads `person / reply / person / saved`, with "The first reply." intact and `native-old` named by the turns themselves |
| IN5c | The two old sequences still say marker 2; a new message continues `native-old`, allocates `generated_root:3` and writes **marker 5**; one `owner` record, no replacement or migration record, and the old `REPL.EntryInput` is not repeated |

## Fixture adaptations

Mechanical ones: `ordinaryEvaluationProfile` → main's `ordinaryGeneratedSelection`
in three files; `withConversation`/`withChat` gained a `declare` parameter for
the captured selection, which moved `agent` one position and needed `AGENT`
stated at eight call sites; `repl-sidekick-controls.test.ts` installs the ceiling
and drops the tables.

**One substantive adaptation.** Tier HI's `runs()` waited for the entry's text to
appear on screen — but the source is *typed into the draft*, so that text is on
screen from the keystroke. The wait returned while the entry was still being
admitted, and the next read saw the entry before it; I measured it, and after
the first `runs()` the model held **0** entries. It now also waits for the
recorded model to hold the entry, which is the fact every row there asserts
about. No assertion was changed.

## Also corrected, because main's gates are newer than C

- Eighty-one `no-banned-jsdoc-words` errors in PR2's prose, reworded in context
  (`claim`→`assertion`/`statement`, `claimed`→`taken`/`stated`,
  `claimant`→`identity holder`, `focus claim`→`focus request`), plus twelve in
  `architecture.md`.
- One `no-yield-in-finally` (`repl-sidekick-configuration.test.ts`, converted to
  `ensure()` before the work) and two `no-redundant-test-scope`.
- Four dead exports the new knip gate flags: `settled()`, `executionShape()`,
  `openPairedEntries()` and the `ExecutionShape` type.

## Documentation

`architecture.md` gains the setup-time capture, the two-captures-per-owner
boundary, the response-naming lifetime, and `Elicit` as a selected protected
name. `specs/repl-spec.md` follows for the response ceiling and the question.
`specs/executable-mdx-spec.md` gains PR2's three new module rows
(`agent/publication.ts`, `agent/conversation-provider.ts`,
`agent/provider-configuration.ts`) and the updated `conversation.ts` row.
`specs/acp-client-spec.md` gains the direct-provider section and the
per-conversation agent.

## One observation currently in neither increment

C had rows in `document-output-api.test.ts` and `execution-protocol.test.ts`,
added by `ddf3f6f9` — a **PR1-owned** commit — asserting that a root's rendering
reaches neither the output stream's chunks nor the completion value. Replacement
PR1's `E1a` asserts only the completion value. I reverted both files rather than
apply PR1's hunks twice, so the output-stream-chunks half of that observation is
in neither increment. It belongs to PR1; say the word if you want it added
there.

## Not touched

No push, no GitHub mutation, no CI inspection, no merge, no dependency or lock
change, no user-history repair. EH1/UI10 are reported, not repaired. #922, the
remaining UI decisions, teaching, the capture packet and publication stay
outside this commit.
