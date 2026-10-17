# Replacement PR1 handback — fdcef428

Built on the verified target, not rebased. All five frozen PR1 commands pass.

## Revision

| Item | Value |
| --- | --- |
| SHA | `fdcef4281ac15b059d3db1a4594ffb8972bcd269` |
| Parent / base | `986948eabd070c0ae7354c2a0db8df7feed63621` — the verified target main |
| Branch | `agent/issue-883-pr1-main-integration`, in `.claude/worktrees/issue-883-pr1` |
| Signature | G, tarasm@gmail.com; tree clean before and after |
| Size | 21 files, +8091 / −226 |
| Not pushed | no publication is authorized |

Preservation, as released: `pre-integration/issue-883-pr2-d4b0e326` created and
verified at C; `pre-rebase/issue-883-pr1` still `79d404d0`;
`pre-rebase/issue-883-pr2` still `d906c636`; `agent/issue-883-pr1` still
`79d404d0`; `agent/issue-883-pr2` still `d4b0e326`. PR2's worktree and files
were not touched. `deno task setup` ran once, exit 0.

## Source revisions ported, and where moved hunks landed

- #890's four commits (`d45bbfc6`…`79d404d0`) — host conversation, preview,
  interpolation, scanner, root language, host exports, ACP tier.
- The Core-only bound-evaluation amendment from PR2, taken at `01abab27`:
  `generated-root-owner.ts`, the bound runner and sequence partition,
  `execute.ts`'s `HostExecution` wrapping, and `conversation.ts`'s evaluation
  mailbox and readiness bridge. **`conversation.ts` was taken at that commit
  precisely because it has the evaluation work and none of PR2's
  direct-provider or configuration work** — verified by inspection: zero
  references to `conversation-provider`, `provider-configuration` or
  `ProviderConfiguration`.
- Left for PR2, untouched here: provider configuration/recording, the direct
  provider, streamed publication/Preview extensions, Workflow adaptations and
  every CLI Sidekick change.

## How main's model changed the implementation

The Architect's marker decision is what made this tractable, and it is worth
recording why: main threads one `RECORD_VERSION = 4` through `policyRecord`,
`readPolicy`, `admitSource` and `readAdmission`. That is now
`FRAGMENT_RECORD = 4` / `ROOT_RECORD = 5` threaded as the marker an evaluation
*expects*, at the result and inside the policy. Cross-kind refuses for free —
the version check fails, the record reads as unreadable, nothing is performed —
and marker 4's closed shape is byte-identical to main's. The conflict I
returned when the rebase was aborted (main's `{allow, allowed}` versus #883's
`{…, context, workspace?, requests, recordVersion}`) does not exist in this
shape at all.

Other decisions worth review:

1. **`selectedTables` moved** from `Evaluate.ts` to `evaluation-profile.ts`,
   exported with the two refusals it raises, so the authored site and the root
   resolve the selection through one machinery (IN7's "same machinery"). This is
   the only main file reorganised; `Evaluate.ts` now imports what it used to
   declare.
2. **The root's binding is a closure over the captured profile**, plus the
   minted `<Syntax />` definition, the guarded route and the captured
   reference. `generated-xmd.ts` cannot import `evaluation-profile.ts`
   (it already imports `pinnedJson` the other way), so the selection arrives
   as `select: (allow) => RootSelection` rather than as the profile itself.
3. **An absent profile refuses on use, not at startup.** My first attempt threw
   at execution start and broke 29 of main's own tests; the decision's "an
   absent host profile remains absent" is what the bound operation now does.
4. **Main's captured reference is kept.** `execute.ts`'s three conflicts
   resolved as: #883's imports, then main's `describe(includes)` /
   `useRootSyntaxReference` for both capture hunks.
5. **`topLevel` is cleared by every enclosing construct**, including `<If>` and
   `<Switch>` branches, which is what makes an `<Output>` inside a branch
   refuse.

## Evidence

| Command | Selection | Result |
| --- | --- | --- |
| 1 | host-generated-root, generated-xmd-root, generated-xmd-preview, agent-conversation | 28 tests / 129 steps |
| 2 | generated-xmd, composition, selection, owner-metadata, evaluation-profile, evaluate-provider-lifetime | 34 / 266 |
| 3 | execution-protocol, document-output-api, syntax-component, syntax-api, syntax-loaded-copy | 14 / 143 |
| 4 | agent-components, agent-function-components, agent-session-launch, acp host-conversation, acp loaded-copy | 24 / 160 |
| 5 | workflow generated-observations, cli evaluate-component, cli evaluate-workflow | 8 / 33 |

**108 tests / 731 steps, zero failures.** `deno task check` exits 0.

Commands 2, 3 and 5 were run on **pristine main before any edit** — 34/266,
14/143, 8/33 — and come back at exactly those counts, so main's fragment,
selection, Syntax and workflow behaviour is demonstrably untouched rather than
merely asserted.

### IN mapping

- **IN1** — GR11 reads the actual records: a root's policy is marker 5 and
  carries no `context`, a fragment's is marker 4 with the same members it always
  had. GR15c offers a retained root admission to a fragment and it refuses with
  nothing performed; GR13 is the same claim about what a fragment consumes.
  Existing source/form/URL/kind/effect/order comparisons are untouched (command
  2 at identical counts).
- **IN2** — E1a–E1d, E5a/E5b, E7a–E7g in `host-generated-root.test.ts`: a live
  handle evaluates with no conversation and no durable context; ordinary execute
  exposes no evaluator and the host module exports none; completed and
  never-activated handles refuse; cancellation joins; a root's ordinary failure
  carries real partial output while fatal and held-cleanup failures survive both
  wrappers.
- **IN3** — E3a–E3c: a named lookup renders an enclosing captured chapter with
  correct availability, late Documentation middleware grants nothing, and two
  live executions each keep their own capture. GR23 reads `<Syntax />`'s list of
  what the root actually admits.
- **IN4** — E4a/E4b, E6a, GR12–GR14: evaluations own their own sequences,
  reopening starts new work past every retained one, an interrupted sequence
  leaves no terminal, and one journal carries a fragment and a root under one
  request id without either consuming the other.
- **IN7** — command 2 at identical counts covers U5 selected implementation and
  live authorization; command 5 covers Workflow's captured bound reading. Root
  capture goes through the moved `selectedTables` rather than any reintroduced
  inventory check.

## Fixture adaptations — every one reported

The four ported Core tiers and the ACP tier were written against #883's public
surface, which this integration removes. Their **setup** was adapted; their
assertions were not, with one stated exception.

1. **Pinned factories import from `../src/generated-xmd.ts`**, not `host.ts` —
   the same import main's own `generated-xmd.test.ts` uses. No public siteless
   evaluator or pinning surface was added.
2. **Host definitions carry per-form `generated` metadata** instead of a
   `hostIdentity(...)` argument, because identity is the declaration's own on
   this contract. `RetainedFragmentIdentity` is gone with it.
3. **`pinnedFetch([ADMITTED_REQUEST])` became `pinnedFetch()`** — main removed
   the request inventory and authorizes at the performer. No assertion rested on
   the inventory: it appeared only as that argument, and no row's title or
   expectation concerned it.
4. **Tables are declared, not passed.** Each tier now installs its entries as
   component-answer providers and offers their names through `useSelection`, so
   the root is admitted from a captured selection. Rows that watch a specific
   invocation array declare that instance. The ACP tier writes its provider
   against the public `ComponentAnswerInstallation`, publishing once through
   `request.answer(...)` and delegating afterwards.
5. **`installIdentities([], [], PROTECTED_COMPONENTS)` became
   `[SYNTAX_PROTECTED]`**, matching main's own declaration shape.
6. **The test selections do not name `Syntax`** — the root evaluator admits the
   implementation its execution minted, and naming it too is one name with two
   definitions.
7. **`GR11` is the one changed assertion.** It asserted
   `retainedPolicy(events).context === "root"`; it now asserts marker 5 for a
   root, marker 4 for a fragment, and that neither record carries a `context`
   member. That is the Architect's replacement for the same claim, not a
   weakening — it also pins marker 4's shape, which the old row did not.

## One stated limit

**IN1's fragment→root direction is asserted at the record level, not through a
replayed history.** GR15c covers root→fragment by handing a root's
admission-only history to the fragment evaluator. The mirror image needs a
*held host* whose document replays a pre-seeded completed history, and the
`held-host` fixture cannot hold one — the attempt left a pending promise the
tier could not settle, so I removed the row rather than leave a flaky one. The
refusal is the single `readAdmission` marker check GR15c already exercises, and
GR11 proves both markers are written at both levels. If the reviewer wants that
exact direction mounted, it needs a fixture that can hold a replaying document,
which I have not built.

## Documentation

`specs/executable-mdx-spec.md` gains the two-kind admission, the marker
separation, the root's own environment and the no-siteless-evaluator rule, plus
module rows for `generated-root-owner.ts`, `generated-xmd-preview.ts`,
`generated-interpolation.ts` and `agent/conversation.ts`. Its two conflicts kept
main's existing rows and paragraph and added the root's beside them, so main's
removed-input contract is preserved. `specs/acp-client-spec.md` gains the
conversation section verbatim from the accepted slice. `architecture.md`
describes the root as the same admission in another context, the marker rule and
the root's environment. No prose claims the removed `context` member — checked.

## Continuity

Base `986948ea`. Produced `fdcef428` on
`agent/issue-883-pr1-main-integration`. Next action: review this SHA. PR2's
integration starts only after a recorded PASS on it; PR2's branch stays at C and
its worktree is untouched. #922, B–D, teaching, captures and delivery remain
separate.
