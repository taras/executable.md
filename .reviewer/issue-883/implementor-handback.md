# Implementation handback: Core PR 1, #883

Core PR 1 is **complete**. All three accepted host capabilities are implemented
and the whole frozen C1–C3 evidence passes.

**Feedback commit: `79d404d04d02c3840892473b6f1b2cf540f3edd1`**, parent
`05d03afb0ff1356707f66f2f1b741a5d8ec6ba95`. It answers the Architect finding
confirmed in [the Planner correction](pr890-planner-correction.md): generated-root
admission refused the accepted passive-source draft-fill program. **That finding
was caused by one of my own wrong premises**, recorded below and now withdrawn.

Previous feedback commit: `05d03afb0ff1356707f66f2f1b741a5d8ec6ba95`, parent
`2765a76be0916e1d7ae0201345eb7fe7b861ad2e`, parented in turn on
`d45bbfc6b4857684e4d51dc710837bb2f8bfa0a5` and on the resolved base
`e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`. Every commit in the chain is
SSH-signed and verified
(`Good "git" signature … RSA key SHA256:GrwHL07…`). Working tree clean.

`05d03afb` answers the one remaining finding in the Planner's `REQUEST CHANGES`
on `2765a76b` ([pr1-planner-review-2765a76b.md](pr1-planner-review-2765a76b.md)):
CV22 did not interrupt mapping acknowledgement, so it was not evidence of
pre-mapping reconciliation. Tier HC supplies that evidence through the canonical
ACP provider, and CV22 is renamed to what it actually proves. Production code is
unchanged by this revision — the discriminating scenario found no defect.

`2765a76b` was the revision answering the Planner's `REQUEST CHANGES` on
`d45bbfc6` ([pr1-planner-review.md](pr1-planner-review.md)). Both of its
findings are fixed, each with its own regression and its own negative control.
C1 and C2 are untouched by either revision.

## Resolved base and worktree

| Fact | Value |
| --- | --- |
| Worktree | `.claude/worktrees/issue-883-pr1` |
| Branch | `agent/issue-883-pr1` |
| Resolved base | `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59` |
| `origin/main` at creation | `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59` (re-fetched; unchanged) |
| Foundation `b88da5ea…` is an ancestor | yes |
| Setup | `deno task setup`, run once, exit 0 |
| Feedback commit SHA | `79d404d04d02c3840892473b6f1b2cf540f3edd1` (signed, verified) |
| Previous feedback SHAs | `05d03afb0ff135…`, `2765a76be0916e…`, `d45bbfc6b48576…` |
| PR | [#890](https://github.com/taras/executable.md/pull/890), pushed |

`base-state.json` records the resolved base.

## What is delivered

### C1 — `evaluateGeneratedXmdRoot()`

`packages/core/src/generated-xmd.ts`, exported from `packages/core/host.ts`.

- The fragment's own walk, record and pinned resolution, with one construct
  different: a top-level `<Output>` in root context and nowhere else.
  `<Content>` and `<Return>` stay unavailable in both.
- The walk's invariant inputs (`table`, `ceilings`, `context`, `named`) are
  bundled into one `Admission` value rather than threaded, so the one
  difference is read from where the rest of the decision is. The policy walk is
  not copied per context.
- `Lexical` gained `topLevel`, which is what separates a region declaration
  from a misplaced element — the same lexical question
  `validateOutputPlacement()` answers for an authored body. The props rule is
  `outputPropsViolation()`'s, read rather than restated.
- Context travels **in the policy**, so `policyHolds()` compares it with every
  other ceiling. It is written to the record only for a root, which leaves
  every fragment record this build and the released one write byte-identical;
  an older build reading a root record finds a member it does not know and
  refuses the continuation.
- Rendering reuses `expandBody()` and the text root's own `output` error mode,
  so region selection, documentation execution and partial rendering are the
  document root's rule. The owner array is allocated by the caller, so a
  failure partway leaves it holding what the root produced.
- Ordinary failures answer `Err(GeneratedXmdRootError)` with `partial`.
  Durability, Files-infrastructure, secret-policy and teardown failures are
  rethrown. `firstCause` is now exported from `errors.ts` so the secret-policy
  question uses the engine's own traversal rather than a second one.

### C2 — `previewGeneratedXmdRoot()`

`packages/core/src/generated-xmd-preview.ts`, exported from `host.ts`.

- A pure projection. No `Operation`: no file, no name resolution, no component,
  no expression, no admission.
- Incomplete and invalid are distinct. Telling them apart needs the scanner's
  own walk, so `scanSegments()` now reports the constructs it gave up on —
  beside the `elements` it already reported, through the same single grammar.
  `parseAttributes` says whether `-1` meant exhaustion or a refusal, and
  `findFenceClose` says whether it actually closed.
- The safe reading ends at the earliest unfinished construct, with the one
  exception the feature exists for: a top-level `<Output>` whose opening tag
  completed projects the literal text already inside it, up to a trailing
  delimiter still arriving.
- Only settled meaning projects. The interpolation rule moved to
  `generated-interpolation.ts` so admission and preview read one definition.

### C3 — `useAgentConversation()`

`packages/core/src/agent/conversation.ts`, exported from `host.ts`.

The design is forced by three facts found in the code, and each is written into
the module's own documentation:

1. **It is an element, not a preparation.** A provider and its placement
   coordinator are installed inside `Execution.document`; a `DurablePreparation`
   runs before both, so a conversation opened there can reach neither. The
   conversation is a host-declared identity component in a synthetic root of
   core's own, so canonical resolution selects it and hands it this execution's
   claimant — and the session is placed under the engine's own identity rather
   than under anything the host supplied. Verified empirically: the placement
   the provider receives carries a real claimant-issued identity.
2. **The root is never completed.** `durableRun` appends a close only on its own
   success or failure, never on a halt, so the element serves turns and never
   returns and the halt that releases the resource leaves a partial
   continuation — which is what reopening resumes. A recorded terminal would
   replay instead, which is the whole hazard
   ([[one-durable-run-per-journal]]).
3. **A turn is a canonical durable Prompt in a task of its own.**
   `durableSpawn` does not run inside a document expansion — measured, not
   assumed — so each turn is one journaled Prompt under its own durable name
   (`turn:N`) offered in the conversation's sequence exactly as `<Prompt>`
   offers one in a document's. It runs in a spawned task so cancelling the call
   halts the turn, which leaves its append unmade and the position free.

Also delivered:

- `runPrompt` and `Carried` are now exported from `function-components.ts`
  rather than copied, so the component and the host operation reach one
  definition of what a canonical turn is.
- The history is bound to its conversation by a durable `agent_conversation`
  record, written on first opening and replayed afterwards, so a history
  established for another id or another agent refuses rather than reconnecting
  the wrong chat.
- A history whose retained turn recorded no outcome refuses **before anything
  opens**, so a refusal never appends a terminal to the history it refused.
- One turn at a time; an overlapping call refuses without queuing. A handle
  kept past its resource refuses.
- A turn that fails before its journaled prompt — unavailable agent, refused
  identity, a provider that put the conversation under settings nobody asked
  for — answers that call with `Err` and leaves the conversation usable. Only a
  durability failure ends it.

### Files changed

| File | Change |
| --- | --- |
| `packages/core/host.ts` | exports for all three capabilities |
| `packages/core/src/generated-xmd.ts` | root context, bundled admission, Result boundary |
| `packages/core/src/generated-xmd-preview.ts` | new — the prefix projection |
| `packages/core/src/generated-interpolation.ts` | new — the one interpolation rule |
| `packages/core/src/agent/conversation.ts` | new — the retained conversation |
| `packages/core/src/agent/function-components.ts` | `runPrompt`/`Carried` shared rather than copied |
| `packages/core/src/scanner.ts` | reports unfinished constructs from its own walk |
| `packages/core/src/errors.ts` | `firstCause` exported for the secret-policy question |
| `packages/core/tests/generated-xmd-root.test.ts` | new — C1 |
| `packages/core/tests/generated-xmd-preview.test.ts` | new — C2 |
| `packages/core/tests/agent-conversation.test.ts` | new — C3 |
| `packages/acp/tests/host-conversation.test.ts` | new — C3 over the canonical provider |

3512 insertions, 135 deletions across 12 files.

## Focused commands and exact results

Run from the worktree at `05d03afb`.

    deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts
    → ok | 19 passed (88 steps) | 0 failed

    deno task test packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts
    → ok | 28 passed (289 steps) | 0 failed

    deno task test packages/core/tests/agent-components.test.ts packages/core/tests/agent-session-placement.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts
    → ok | 4 passed (34 steps) | 0 failed

    deno task test packages/core/tests/expand.test.ts packages/core/tests/scanner.test.ts packages/core/tests/parse-components.test.ts scripts/tests/test-file-discovery.test.ts scripts/tests/runtime-exclusions.test.ts
    → ok | 18 passed (175 steps) | 0 failed

    deno task test packages/acp/tests/host-conversation.test.ts
    → ok | 1 passed (3 steps) | 0 failed

    deno task test packages/acp/tests/
    → ok | 43 passed (376 steps) | 0 failed

    deno task test packages/core/tests/agent-components.test.ts packages/core/tests/agent-api.test.ts packages/core/tests/root-provider.test.ts packages/core/tests/agent-session-use.test.ts
    → ok | 5 passed (34 steps) | 0 failed

    deno task test scripts/tests/documentation-validation.test.ts
    → ok | 1 passed (5 steps) | 0 failed

    deno test --allow-all --frozen --config deno.json .reviewer/issue-883/pr1-cancellation-probe.test.ts
    → ok | 1 passed (1 step) | 0 failed

The fourth row is added to the plan's three: the scanner, the root-selection
path and the test corpus are boundaries these slices touched that the listed
rows do not reach, and three test files joined the corpus. The rows after it
belong to this revision: the new Tier HC file, the whole ACP package it joins,
the Core agent boundaries the provider stack is installed through, the
documentation gate for the two prose changes, and the reviewer's own archived
cancellation probe, still passing.

A new test file joins the Deno, Node and Bun corpora with no edit, so Tier HC
was run on all three before committing and needs no exclusion:

    timeout 200 pnpm exec tsx --tsconfig tsconfig.node.json --test --test-concurrency=1 packages/acp/tests/host-conversation.test.ts
    → 3 pass, 0 fail (exit 0)

    timeout 200 bun test --timeout=300000 packages/acp/tests/host-conversation.test.ts
    → 3 pass, 0 fail (exit 0)

    deno task check
    → exit 0

    deno task lint
    → exit 0, 0 errors, "All matched files use the correct format"

    deno task validate:docs
    → component documentation: complete across 1 profile

Also run, not as evidence but to keep the commit clean:
`oxlint` (0 errors on the changed files; the remaining items are pre-existing
unused-import warnings in `function-components.ts`) and `oxfmt --check`
(all matched files correctly formatted).

## Criterion mapping

| Criterion | Status | Where |
| --- | --- | --- |
| C1 explicit / empty Output, no Output | met | GR1–GR5 |
| C1 runtime failure after a real earlier effect, truthful partial | met | GR6, GR7 |
| C1 admission refusal carries no partial | met | GR8 |
| C1 reject unavailable names, wrong forms, executable fences, computed expressions, `Content`/`Return`, invalid unselected branch — before effects | met | GR9, eleven rows |
| C1 changed root/fragment context refuses retained admission | met | GR13, GR14 |
| C1 **a root reads a binding it bound itself** | met | GR17 |
| C1 **literal draft fill reaches the pinned paired receiver once** | met | GR18 |
| C1 **captured passive source fills the draft literally** | met | GR19 |
| C1 **entry-only references and nested passive fences survive; no entry component runs** | met | GR20, GR21 |
| C1 **a root does not read the evaluating document's bindings** | met | GR22 |
| C1 released fragment records and Evaluate behavior intact | met | GR10, GR11, GR15 + row 2 |
| C2 prefixes split inside tags, an expression, a passive fence | met | GP6–GP13, GP28 |
| C2 identical prefixes give identical results | met | GP28, GP32 |
| C2 literal previews, computed waits, passive creates no region | met | GP14–GP22 |
| C2 invalid differs from incomplete | met | GP23–GP27 |
| C2 no filesystem/provider/component work | met | GP31, GP32 |
| C3 real canonical conversation over DurableStream | met | CV1, CV9 |
| C3 two turns preserve identity, distinct sequences | met | CV1, CV10 |
| C3 cancel a turn, start fresh work without replaying it | met | CV11 |
| C3 reject overlap | met | CV3 |
| C3 reject wrong history id / wrong agent | met | CV12, CV13 |
| C3 reject a closed handle | met | CV4 |
| C3 canonical publication / partial failure | met | CV5, CV17 |
| C3 exact configuration readback | met | CV7, CV15, CV16 |
| C3 options inspection with no model turn | met | CV6 |
| C3 cancelling a turn joins its provider work (P1) | met | CV18, CV19 |
| C3 established **native** identity mismatch (P2) | met | CV21, CV23, HC3 |
| C3 pre-mapping reconciliation to that same identity (P2) | met | **HC1**, HC2 |
| C3 two native identities in one history refuse (P2) | met | CV24, HC3 |
| C3 logical history ownership — id and agent | met | CV12, CV13 |
| C3 an interrupted turn refuses before anything opens | met | CV14 |

The previous handback cited CV12–CV14 and CV16 for the native-identity row.
That was wrong, and the Planner was right to reject it: those cases compare the
logical host id, the agent, a hand-built failed record and configuration
readback, none of which is a native provider assertion. CV20–CV24 are the actual
evidence, through the provider's own assertion on the Session it reports the
turn ran in.

The revision before this one then cited CV20 and CV22 for pre-mapping
reconciliation, and the Planner was right about that too. CV22 awaited a
*successful* `prompt`, closed its owner and reopened: the turn was already
completed and journaled, and a stub provider has no mapping acknowledgement to
interrupt, so its success established nothing about recovery from the provider's
earlier assertion. It is renamed to what it does prove — reopening joins the
identity its retained turns name, without resending them — and points at HC1 for
the window before a turn has retained one.

**HC1 is the pre-mapping row.** It installs the canonical provider the way
`installAgentProviderStack` does (`installAgentComponents` with
`createAcpxProvider` as the root provider), with ACPX's runtime replaced by this
package's scriptable fake and the host's own `established` hook refused once —
the exact ordering `packages/acp/tests/provider.test.ts` SM9 demonstrates with
`refuseFirstRetention`. The adapter accepts the session and the provider's record
is promoted to assert `agent-session:…`; the acknowledgement then fails, leaving
that assertion standing with no `sessionMaterialization` and the host holding
nothing. The interrupted turn never started, so it retained no identity of its
own. HC1 then releases the owner and does explicit new work over the same
history: it reconciles to that same assertion, commits it, keeps one store
record, and does not resend the interrupted prompt
(`harness.turns` → `["first", "again"]`).

HC2 is the same interruption after a completed turn has retained an identity,
where the journal is the account that survives; HC3 is a provider answering with
another conversation, refused with the established identity standing and the
history then unopenable.

Cases added beyond the matrix, each a fact about the accepted ceiling rather
than new acceptance: GR17 (a root still may not read a binding through text
interpolation), GP21 (a passive fence that reads a binding waits), CV8 (a
history holding its own terminal is a finished run), CV14 (a retained turn with
no outcome refuses before anything opens). No permutation was added that has no
distinct contract consequence.

## A wrong premise that became a defect, and what it cost

The first delivery reported three handoff premises as wrong about the code. Two
were. **The third was my own error, and it is the Architect finding.**

I recorded that "a root may not read a binding through text interpolation, so
the handoff's documentation-binds-then-region-reads prose is not admissible
source", wrote GR17 to assert that refusal, and left the handoff's own worked
example — `<Let as="code" select="code">` capturing entry source, then
`<REPL.EntryInput>{code}</REPL.EntryInput>` — untested. That example is the only
way a reply can write an entry draft, so the Core seam this PR exists to supply
could not be used by the consumer it was built for. The Architect was right to
reject it, and the Planner was right that its earlier PASS had accepted GR17
without checking it against the worked example.

What I should have done is what I did this time: probe the premise instead of
declaring it. Both probes mattered, and the first one I ran disproved my own
first fix — relaxing the refusal alone leaked the admitting document's bindings
into a root (`{secret}` rendered `LEAKED`). Had I shipped that, the finding
would have been replaced by a disclosure defect.

## Plan premises that turned out to be wrong about the code

Corrected in the tests rather than worked around in production, and recorded
here because the Planner's prose rests on two of them:

1. A request whose selection reaches an empty read table is refused by the
   evaluator before it says anything about the source, so every case states a
   read table.
2. An uncaptured `<Fetch>` renders nothing, so its effect is read from the
   journal rather than from the rendering.
3. A root may not read a binding through text interpolation, so the
   documentation-binds-then-region-reads shape in the handoff's prose is not
   admissible source. The handoff's own worked example avoids it by capturing a
   passive fence with `<Let select="code">`.

## An earlier escalation, withdrawn

A first pass returned the C3 seam to the Planner as an unresolved conflict
between the storage contract's assignment of segmentation to the CLI adapter
and the Core interface's single `history: DurableStream`. That was premature.
The storage contract says the adapter presents "only the **selected
conversation's** canonical stream to Core", so the stream Core receives is
per-conversation, and one durable root over it with one named turn per prompt
satisfies every Core-side statement without changing any accepted contract. No
decision is required from the Planner or Architect.

## Remaining work and next action

1. **Nothing blocking.** The specification and architecture updates the handoff
   requires are done and staged:
   - `architecture.md` gains three sections — a generated root and the context
     that is a ceiling, previewing source that is still arriving, and a
     conversation the host holds open — plus three capability-inventory rows.
   - `specs/acp-client-spec.md` gains "A conversation a trusted host holds
     open", before §Components, covering the element/preparation boundary, the
     uncompleted root, isolated turn sequences, retained identity and the
     per-turn configuration readback. `05d03afb` adds the two contract terms the
     revisions introduced and the prose did not yet state: the native
     conversation an established history names, and the cancellation join.
     `architecture.md`'s conversation section states the same two.
   - `specs/executable-mdx-spec.md` records `evaluateGeneratedXmdRoot()` on the
     `src/generated-xmd.ts` row and adds rows for
     `src/generated-xmd-preview.ts`, `src/generated-interpolation.ts` and
     `src/agent/conversation.ts`.

   `deno task validate:docs` → `component documentation: complete across 1
   profile`.

### Negative controls for the revision

Each new regression was checked against its own break-it control, restored from
a saved copy rather than with `git checkout --`. One control, one failing case:

| Control | Fails |
| --- | --- |
| caller does not wait for the turn to join | CV18 alone |
| pre-turn native identity check removed | CV21 alone |
| late-assertion check removed | CV23 alone |
| two-identity refusal removed | CV24 alone |
| acknowledgement left un-refused in HC1 | HC1 alone |
| acknowledgement left un-refused in HC2 | HC2 alone |
| provider answers with the same conversation | HC3 alone |
| blanket root interpolation refusal restored | GR17, GR19–GR22 |
| root environment isolation removed | GR17, GR19–GR22 |

The last two are the halves of the draft-fill correction. Neither is a
single-row control, and the reason is worth stating: restoring the refusal fails
those rows because admission rejects the capture, while removing the environment
fails the same rows because `<Let>` then has nowhere to bind. Both halves are
necessary, and the second is also what prevents the disclosure the first would
otherwise open.

The reviewer's archived probe
([pr1-cancellation-probe.test.ts](pr1-cancellation-probe.test.ts)) was
reproduced unchanged against `d45bbfc6` (`halt returned`, failing) and passes at
`2765a76b` and `05d03afb`. CV18 is that probe as a focused regression.

**What the HC rows do and do not discriminate.** Run against `d45bbfc6`'s
conversation source — swapped in from a saved copy and restored by checksum —
HC3 fails (`Expected substring: "established identity stands" / Received:
"hello world"`) and HC1 and HC2 pass. That is the expected shape and is stated
rather than glossed: the reconciliation HC1 and HC2 observe is the canonical
provider's own work, which the Core revision did not change, so they are
contract evidence for the frozen C3 row rather than a regression for the diff.
HC3 is the row the Core change owns. This answers the Planner's corroborating
observation about CV22 directly — HC1 is not discriminating for the Core diff
either, and it is not meant to be; it is discriminating for the *window*, which
is what was missing.

Next action: review of `79d404d0` against the restored C1 matrix.
PR 2 — the complete CLI Sidekick — begins only once this revision is accepted.

Not claimed by this handback: any CI verdict, typecheck, JSR or runtime-matrix
result; any push or GitHub write; any PR creation.
