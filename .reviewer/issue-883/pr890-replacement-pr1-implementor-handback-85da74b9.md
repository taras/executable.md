# Replacement PR1 — correction of fdcef428

One signed successor, for review.

- SHA: `85da74b938434773d7faf3caa5e2ca007328fdca`
- Parent: `fdcef4281ac15b059d3db1a4594ffb8972bcd269`, preserved
- Tree: `059bb2670ae09a94637ef7c04d521ac076c86545`
- Signature: `G`, `tarasm@gmail.com`
- Branch: `agent/issue-883-pr1-main-integration`, clean, **not pushed**
- Target: `986948eabd070c0ae7354c2a0db8df7feed63621`
- 16 files, +1066 / −323
- Safety refs untouched: `agent/issue-883-pr1` `79d404d0`,
  `agent/issue-883-pr2` `d4b0e326`, `pre-integration/issue-883-pr2-d4b0e326`,
  `pre-rebase/issue-883-pr1`, `pre-rebase/issue-883-pr2`
- PR2's worktree and branch were not touched

The commit was held for a while by the 1Password SSH agent refusing signature
requests — `ssh-keygen -Y sign` reported `communication with agent failed` while
key listing still worked. Nothing was committed unsigned; the work waited
staged until the agent recovered, and every result below was then re-measured
on this exact SHA.

## IP1 — a captured canonical Syntax is retained once

**Reproduced.** The review's probe is the regression: a host selecting
`{ Syntax: ["self-closing"] }` reached two definitions under that name and every
valid root refused.

`evaluateRoot()` appended `pinnedComponent(SYNTAX_COMPONENT, binding.definition)`
to the admitting table and `execute.ts` appended a matching entry to the
describing entries, both unconditionally. Main's capture holds the *same*
protected implementation behind this execution's routed guard, so the two copies
collided.

The whole row is now decided in the one place that knows what the capture holds
— the `GeneratedRootBinding.select` closure canonical execution builds:

- a captured entry named `Syntax` whose `protectedOrigin` is core's is retained
  as it stands, in both the admitting table and the describing entries;
- otherwise core's own copy is added to both, as before;
- a definition this execution's route did not build has no `protectedOrigin`, so
  it is a different implementation under a protected name and still collides.

`protectedOrigin` is produced by `ComponentRouting.project`, which answers only
for an implementation this execution's own route built, and core mints one
protected implementation per name — so the recognition is route-authenticated
rather than a name or URL match. No profile is created where none was captured.

`GeneratedRootBinding.definition` is gone: the selection is now the single
source for both the table a root writes and the vocabulary it reads about, and
`evaluateRoot()` admits `selected.observations` as they arrive.

**Evidence.** `host-generated-root.test.ts`, new Tier E8, through the real held
host:

| Row | Observation |
| --- | --- |
| E8a | A host that selected `Syntax` evaluates; `<Syntax />` renders, the admitted control runs, the recorded policy holds `["Json", "Probe", "Syntax"]` with exactly one `Syntax`, and the descriptive listing renders `### \`<Syntax>\`` once |
| E8b | Control — a host that selected none of it reaches core's own copy, with the same one row and one section |

`generated-xmd-root.test.ts` GRM6 keeps the collision: a selection holding two
different definitions under one name refuses with "one name with two
definitions" and performs nothing.

**Break-it control.** With the recognition removed, E8a fails with exactly
`a generated-XMD allowlist admitted one name with two definitions.` while E8b
passes.

## IP2 — an availability refusal is the call's answer

**Reproduced.** Both arms of the review's probe failed the owning document.

- `execute.ts`'s absent-profile bound operation threw `HostExecutionError`.
- `evaluateRoot()` called `binding.select(...)` before `try`, so a class the
  host installed no table for threw `ComponentInvocationError` outside the
  ordinary refusal handling.

`attempt()` in `generated-root-owner.ts` reads a raised error as an
authoritative failure of the run, so a host could catch the method's refusal,
release its ordinary held document, and still receive a failed canonical
completion.

Both now answer through the existing boundary. The absent arm returns
`Err(new HostExecutionError(...))` — the same classification a closed and a busy
execution already refuse with, with the existing diagnostics preserved as the
module constants `NO_ROOT_SELECTION` and `NO_ROOT_VOCABULARY`. The selection is
resolved inside `try`, so an unavailable class comes back as
`Err(GeneratedXmdRootError)` carrying `NO_WRITE_TABLE`/`NO_READ_TABLE` with no
partial rendering, because nothing rendered.

Nothing moved for the run's own failures: `ordinaryGeneratedFailure` still
re-raises teardown, durability, Files-fatal and secret-policy failures, and
E7a–E7g are unchanged. Absence is still refused on *use* rather than at
execution startup.

**Evidence.** `host-generated-root.test.ts`, new Tier E9:

| Row | Observation |
| --- | --- |
| E9a | No selection: `Err` is a `HostExecutionError` naming it, the document completes, no admission is recorded |
| E9b | A class with no table: `Err` names it, the document completes, nothing invoked, no admission |
| E9c | Control — an available class answers `Ok`, the document completes, the control ran once, one admission |
| E9d | The accepted public request typed through `@executablemd/core/host`, all four members, evaluating ordinarily |

**Break-it control.** With the absent arm throwing and the selection resolved
outside `try`, E9a and E9b fail while E9c and E9d pass.

## IP3 — the settled public request exports

`GeneratedXmdRequest` is now the decided four-member public root request
(`id`, `source`, `allow?`, `position?`), exported with `GeneratedEffectClass`
from `packages/core/host.ts`. The internal table-taking fragment request that
held that name is `GeneratedFragmentRequest` — Core-private, delegated, no
compatibility alias. `GeneratedXmdRootRequest` is removed rather than kept as a
second public name.

`host-generated-root.test.ts` takes both the request type and the class from
`../host.ts` for the whole tier, so every row there is an ordinary typed
consumer of the published boundary; E9d states all four members explicitly.

## IP4 — the two new form-list casts

Both `formsOf()` helpers (`generated-xmd-root.test.ts`,
`agent-conversation.test.ts`) now filter a typed
`const FORMS: readonly InvocationForm[]` and return
`readonly InvocationForm[]`. No cast, no replacement assertion, no parser. No
older deliberate malformed fixture was touched.

## IE1 — IN1 in both directions, and IN4's old-root journal

### Why the reported gap was real

The public owner gives each evaluation a sequence of its own and partitions it
from the document's continuation — which is also what makes one kind's record
*unreachable* from the other through it. The old GR15c offered
`<Output>…</Output>` to a fragment, which is illegal fragment language, so it
passed on a fresh language refusal and the cross-kind read never happened. The
review is right on every count; the row is removed, not weakened.

### Tier GRM — the seam that can establish it

New sub-tier in `generated-xmd-root.test.ts`, driving
`bindGeneratedRootEvaluator()` — the Core-private handoff canonical execution
makes — under a `durableRun` whose `coroutineId` the case chooses, so a record
one kind wrote is in the coroutine the other reads. The admission, the record
and the comparison are the production ones; the fixture supplies only the
selection and the route, from the existing `installIdentities` /
`SYNTAX_PROTECTED` minted-identity fixture.

Because the Syntax row now travels with the selection (IP1), the fixture can
state the *same* selection for both kinds — which the real owner cannot.

| Row | Observation |
| --- | --- |
| GRM1 | A real marker-4 fragment admission, offered to a root with the same id and bytes: `Err` whose message **is** `the retained generated-XMD admission record cannot be read as one.`, zero invoked effects, and the record still marker 4 |
| GRM2 | The mirror — a real marker-5 root admission offered to a fragment: the same named refusal, zero invoked effects, record still marker 5 |
| GRM3 | The two records' retained `allowed` rows are byte-identical and the markers are 4 and 5, so GRM1/GRM2 refuse for the marker and for nothing else |
| GRM4 | Control, measured on both sides: a matched marker resumes and performs the admitted work, root over root and fragment over fragment |
| GRM5 | An older build's marker-2 root record authorizes neither kind — same named refusal, zero effects, both directions |
| GRM6 | One name under two definitions is still a collision, before anything is admitted |

Source is `<Probe />\n`, legal in both kinds: a root without `<Output>` renders
its whole body, and a fragment may write it. No held host replays a completed
document; no public test hook or alternate table-taking host method was added.

### IN4 — E6b

`host-generated-root.test.ts` Tier E6 gains E6b over a journal in the accepted
pre-integration writer's shape (`01abab27`): `version: 2` at the result and
inside the policy, the `context: "root"` member that build used to say which
kind a record was, `requests` for its per-identity Fetch ceilings, and
identities as four-member structural records. One `generated_root:1` sequence
completed with an acknowledged `fetch` and a terminal; one `generated_root:2`
left an interrupted suffix with no terminal.

Observed: the document completes; opening repeats neither the completed effect
nor the suffix; the old bytes are identical afterwards and nothing is appended
to either old sequence; the main `root` continuation takes no admission of
theirs; and the new explicit root allocates `generated_root:3` and writes marker
5 while the old two stay marker 2. The completed-document replay bypass is
untouched, and no user history is rewritten.

**Stated limit.** The old-shape journals in E6b and GRM5 are hand-built to
`01abab27`'s `admitSource`/`policyRecord` — quoted in each fixture's comment
with that SHA — rather than produced by running that writer, which would need a
separate prepared worktree at `01abab27`. They are the older shape offered to
this build, not a relabelled marker-5 fixture; if a run-produced fixture is
wanted, say so and I will build one.

## Beyond the findings, because fdcef428 introduced them

`deno task lint` exited **1** at `fdcef428` and exits **0** on main. Two causes,
both in files this PR adds or changes:

- fourteen error-level `no-banned-jsdoc-words` findings ("claim" and its forms)
  across `host.ts`, `generated-xmd.ts`, `generated-root-owner.ts`,
  `agent/conversation.ts`, `generated-xmd-root.test.ts`,
  `generated-xmd-preview.test.ts` and `tests/support/held-host.ts`, reworded;
- seven files failing `oxfmt --check`, formatted.

No dependency, cache or lockfile change. The reformatting is why several diffs
are larger than their logic; assertion counts are unchanged in every file that
was only reformatted.

## Prose aligned

Only what these corrections untrued:

- `architecture.md` — the Syntax row is retained once whether or not the host
  selected it, and a route-foreign definition stays a collision; an availability
  refusal is neither an ordinary failure nor a failure of the run.
- `specs/executable-mdx-spec.md` — §9's handle paragraph states that an
  availability refusal is a value the call carries and leaves the main document
  to complete.
- `host.ts` — what `GeneratedXmdRequest` is and why `GeneratedEffectClass` is
  beside it.

## Commands

All on the complete staged tree.

| Frozen command | Result |
| --- | --- |
| 1 — host-generated-root, generated-xmd-root, generated-xmd-preview, agent-conversation | exit 0; **31 tests / 141 steps** |
| 2 — generated-xmd, composition, selection, owner-metadata, evaluation-profile, provider-lifetime | exit 0; **34 / 266** |
| 3 — execution-protocol, document-output-api, syntax-component/api/loaded-copy | exit 0; **14 / 143** |
| 4 — agent-components, function-components, session-launch, acp host-conversation, acp loaded-copy | exit 0; **24 / 160** |
| 5 — workflow generated-observations, cli evaluate-component, evaluate-workflow | exit 0; **8 / 33** |

**111 tests / 743 steps, zero failures**, re-run on `85da74b9` itself after the
commit was written. Command 5 had loopback access and needed no retry this
round.

Both review probes, unchanged source:

```
deno task test .reviewer/issue-883/pr890-captured-syntax-probe-fdcef428.test.ts \
               .reviewer/issue-883/pr890-root-refusal-probe-fdcef428.test.ts
→ exit 0; 2 passed (5 steps)
```

`deno task check` exit 0. `deno task lint` exit 0. `deno task validate:docs`
reports component documentation complete.

Commands 2, 3 and 5 return the counts the review independently measured
(34/266, 14/143, 8/33), so main's fragment, selection, Syntax and workflow
behaviour is unchanged by this correction. Commands 1 and 4 moved only by the
rows added here (28→31 tests, 129→141 steps in command 1; command 4 unchanged at
24/160).

## Fixture adaptations in this correction

- `host-generated-root.test.ts` takes `GeneratedXmdRequest` and
  `GeneratedEffectClass` from `../host.ts` instead of `../src/generated-xmd.ts`
  (same declaration, published path).
- `selectingWithSyntax()` added: it names `Syntax` in the selection with no
  answer provider, because canonical resolution answers for a protected name
  from core's own tier. `retainedRows()`, `markerOf()` and `occurrences()` are
  new readers over the recorded policy and the rendered listing.
- `generated-xmd-root.test.ts`: `Candidate.fragment` is typed
  `GeneratedFragmentRequest`; `formsOf()` returns `readonly InvocationForm[]`;
  GR15c removed, Tier GRM added.
- No existing assertion was changed or weakened in this correction. The one
  assertion changed in `fdcef428` itself (GR11, the removed `context` member →
  markers 4/5) stands as reviewed.

## What this correction did not touch

No CLI or UI change, no EH1/UI10 repair, no history migration, no publication,
CI, merge, cleanup or dependency work. PR2 stays at accepted base C.
