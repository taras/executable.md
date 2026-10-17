# Implementor handback: the direct provider correction (P1)

One coherent correction, implemented from `08c95ca2` with the worktree verified
clean at that exact signed revision. All six assigned commands pass. **The
reproducer is closed**: the preserved probe now prints
`{"answered":false,"ensures":0,"turns":[],"configurationRecords":0}` where it
printed `{"answered":true,"ensures":1,"turns":["first"],"configurationRecords":0}`.

**Review `004de839e85e53cff4d960cb515729d350383f30`** — signed G,
tarasm@gmail.com, parent `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`, branch
`agent/issue-883-pr2`, working tree clean and nothing untracked. 17 files,
1224 insertions, 175 deletions, one new source file
(`packages/core/src/agent/conversation-provider.ts`).

## What was built

### Core's fixed interface and Context

`packages/core/src/agent/conversation-provider.ts` (new) declares
`AgentConversationProvider` — one name for the interface and the Context, key
`executablemd.agent.conversation.provider`, default `undefined` — with exactly
the four assigned methods and signatures. It is exported from
`packages/core/api.ts` under that one name and nowhere else; no alias was added.
`export { AgentConversationProvider }` carries both the type and the value
because the two share a name, which I verified with a consumer probe rather than
assuming. `AgentProviderFactory` is unchanged.

### ACP installs one object for one concrete state

`createAcpxProvider` installs the ordinary middleware exactly as before and then
sets the Context to an object bound to the `useAcpxProvider` handle it acquired
and the coordinator delivered to that factory. The coordinator stays in those
closures: it is on no Context value, no public `AcpxProvider` handle and no
`Session`. Every method resolves the concrete state through the module's own
private `resolvePartition` lookup at the moment of use, so a reference kept past
teardown refuses — `prompt` does that resolution inside the subscription, which
keeps the stream cold.

`resolveSession` and `promptStream` gained an optional explicit agent;
`selectedAgent ?? (yield* Agent.operations.agent(...))` keeps every ordinary
entry point's contextual selection byte-for-byte while the conversation's own
path reenters no `Agent.agent`. Two members on the private state —
`conversationSession` and `conversationPrompt` — are the conversation's door to
the same `resolveSession`/`promptStream` implementations. `conversationSession`
refuses anything that is not a request this build issued, using the module's
existing `isResolvedSession`/`isSessionRequestShaped` guards, so a name cannot be
routed as one even from an untyped caller. `createPartitionedAcpxProvider` is
untouched: still selected per ordinary dispatch, still supplying no fixed object.

### The conversation captures it once

`held()` reads the Context on its first line — before `bindConversation` — so a
history opened over a provider that cannot serve it is left exactly as found. A
missing object answers `AgentConversationError` ("does not support saved
conversations") through the existing readiness/suspend path: no provider call, no
configuration record, no Prompt record, no root terminal, no fallback. The
refusal is a small `Operation<never>` whose `while (true) { yield* suspend() }`
states in the type what the comment states in prose — that returning here would
complete the root it refused. No cast was used to narrow the captured value.

From there it is an ordinary local passed to `deliver`/`conversationTurn` and
`inspect`. The turn calls `provider.agent(request.agent)`, opens the same one-use
issuance with `admitting(active)`, seals the job's configuration, calls
`provider.session(issuance.request, agent)`, and closes the issuance in the same
`finally`. The `Agent.around` agent-binding block is gone, with the explanation
that described it. Explicit options go through `provider.options`; the
generated-root job is unchanged and calls nothing.

### Private evidence of the exact completed Session

`session-request.ts`'s private `Issuance` gained `completed?: Session`, written
only through a `finished` function on the acceptance `consumeSessionRequest`
returns and read only through `completed()` on the opener's own issuance handle.
`session-setup.ts`'s `finish` computes its one answer in an extracted
`settlement()` and records *that* value — the authentic configured use included
— after everything that could still refuse, then returns it. Nothing public
carries it: no callback, brand, accessor or coordinator member.

The conversation compares by identity before asking for a prompt stream. A
provider that answers with a session it never settled, or settles genuinely and
then answers with another, is refused there. I kept this explicitly distinct from
`activate()` in both the code comment and the spec: the completion check is not
the before-effects configuration check, and it is not evidence of native
identity.

### One canonical runner, one audit

`journal.ts` now exports `auditedPromptStream(stream)`, which is the body the
`Agent.prompt` middleware used to inline — it creates the ledger, wraps the cold
stream and registers the pair in the private `PromptAudits` map. The middleware
calls it; `runPrompt` calls it for the direct stream. One audit per consumed
stream, neither path twice, with the `requestPermission` observer still outside
every policy and the exact-stream `completedPromptAudit` lookup unchanged.

`runPrompt` gained one optional `DirectPromptTurn` parameter — the captured
provider, the resolved agent and the exact settled Session — so the record
builder, publisher handoff, checkpoint reading, partial text, sequence
allocation, durability precedence and cleanup are literally the same code for
both paths. Ordinary `<Prompt>` still dispatches through `Agent.prompt`.

## Evidence

### The six assigned commands, from the final source state

```text
deno task test packages/core/tests/{agent-session-setup,agent-session-use,agent-session-use-loaded-copy,agent-conversation,agent-components,root-provider}.test.ts
→ ok | 16 passed (84 steps) | 0 failed

deno task test packages/acp/tests/{provider,permission-bridge,host-conversation}.test.ts
→ ok | 13 passed (98 steps) | 0 failed

deno task test packages/cli/tests/{repl-sidekick-recovery,repl-sidekick-configuration,repl-sidekick-journey,repl-sidekick-lifecycle,repl-history}.test.ts
→ ok | 15 passed (86 steps) | 0 failed

deno task test packages/core/tests/agent-function-components.test.ts
→ ok | 11 passed (63 steps) | 0 failed

deno task test packages/acp/tests/loaded-copy.test.ts
→ ok | 1 passed (4 steps) | 0 failed

deno test --config ./deno.json --allow-all --filter 'ACP configuration request routing probe' <probe>
→ ok | 1 passed (2 steps) | 0 failed | 2 filtered out
```

Also green, unassigned: `deno task check` exit 0, `oxfmt --check packages specs
scripts` clean, and `oxlint -c .oxlintrc.json` exit 0 on every file touched (no
`local/prefer-effection-result`; P2's shape is untouched).

I also swept both whole packages, because this patch reaches the shared prompt
runner and the setup owner and the assigned selection is narrower than their
consumers:

```text
deno task test packages/core/tests packages/acp/tests
→ ok | 518 passed (3801 steps) | 0 failed (2m44s)
```

That is how the two pre-existing failures below were found, and it is the
evidence that nothing else in either package is affected. No CLI-wide or
runtime-matrix sweep was run; delivery owns those.

### The probe, before and after

The probe file and its first-output log are unmodified. Its routed arm answered a
turn with one native ensure before; it now refuses with zero, and its control arm
still refuses with zero. Both cases are promoted into the permanent corpus as
DP1.

### DP1–DP5

| Row | Where | What it observes |
| --- | --- | --- |
| DP1 | `packages/acp/tests/host-conversation.test.ts`, Tier DP | Real `createAcpxProvider` with its construction inputs unstated. Both arms — nothing installed, and the supported name-forwarding handler installed at `max` — refuse for the specific reason ("did not state what it is building this conversation's session under" / "no active provider configuration was named"), with zero ensures, zero turns and zero configuration records. It asserts the message is **not** "does not support saved conversations", so an unsupported-service refusal fails this row. The handler's own counter is empty: it was never reached. |
| DP2 | same file | Complete configuration, a two-agent registry, and the conversation opened under the nondefault `editor`. Session-name, agent and prompt-session rewriting handlers are installed together at `max`, the prompt one carrying a different-session canary. The chat answers, all three counters are empty, the ensure lands on this chat's own session key, and the record holds `agent: "editor"`, this conversation's native identity and one configuration record. |
| DP3 | `packages/core/tests/agent-conversation.test.ts`, Tier DP | Three rows through the migrated direct test provider: a raw Session returned without `finish` refuses with zero prompt calls; a genuine `finish` followed by a different Session refuses with zero prompt calls (and its configuration was activated and saved, so the refusal is not a side effect of an earlier failure); and the positive control asserts the object the turn was handed **is** the object `finish` returned, that the authentic use carried the authored model/effort, and that the record's configuration is the verified value. Existing SC3/SC4 keep refused activation, cancellation and closure. |
| DP4 | same file | One saved-conversation turn with two tool-call permission requests raised from inside the provider's own stream consumption and a checkpoint named on that exact terminal event through the factory-delivered coordinator. The host's policy decides both; the canonical record holds both audits once each, in arrival order, with the safe fields exactly as asked and the chosen outcome. The publisher's `begin` ran before the provider was asked (asserted from inside `begin`), `publish` saw that same handle, the association is `{checkpoint, sessionKey}` from the provider's own account, and it appended exactly once. |
| DP5 | same file | A provider installing only ordinary `Agent` middleware. Opening refuses with the unsupported-conversation message, no ordinary dispatch was served, no prompt reached the provider, the history holds none of the three conversation record types, and the root has no terminal. |

SC1–SC7 are intact. SC1 (ACP, detached/frozen construction values), SC2
(real-process compatible/incompatible reopen in the CLI recovery suite), SC3/SC4
(missing configuration, finish ordering, activation cancellation and closure),
SC5 (delivered receiver binding, in `root-provider.test.ts`), SC6 (R2m2's window)
and SC7 (the preserved consumers across all three original selections) all pass
unchanged. **The configuration comparison was not changed**, so SC2's previously
recorded mutation remains the evidence for it and I did not repeat that control.

### Discriminating controls

Five, each applied to a byte copy, confirmed applied before running, and restored
byte-identically afterwards (`diff -q` clean on all three mutated files).

| Control | Result |
| --- | --- |
| The completion check bypassed in `conversation.ts` | Exactly DP3's two refusal rows fail. DP3's positive control, DP4, DP5 and every CV/SC row stay green. |
| The direct stream handed to `runPrompt` unaudited | Only DP4 fails. **Every ordinary A1 audit row in `agent-function-components.test.ts` stays green** — which is the Architect's point made concrete: ordinary Prompt coverage alone cannot detect a missing direct-path wrapper. |
| `conversationSession` forwards `request.name` instead of the request | DP1 and DP2 fail, and so do HC1–HC4 and SC1 — forwarding the name also loses the setup those rows depend on. Coarse, reported as coarse; it confirms DP1 discriminates the request-versus-name distinction rather than merely the presence of middleware. |
| The direct prompt resolves its agent through the chain | Only DP2 fails. The rewriting handler then answers, and the record's agent is no longer the conversation's. |
| The provider read *after* `bindConversation` | Only DP5 fails, on the "no records written" half. |

## Two pre-existing failures this uncovered, and what I did

The fourth assigned command had never been run on this branch. It failed
immediately, and so did `packages/core/tests/agent-session-launch.test.ts` when I
swept the wider core and ACP suites:

- `packages/core/tests/agent-function-components.test.ts` — 5 rows (AF11, AF24,
  AF25, AF26, SR-adjacent) failing with "this session setup has not been
  activated".
- `packages/core/tests/agent-session-launch.test.ts` — 7 rows (SC1, SC2, SC4,
  SC20, SC21, SC22, SR1) failing the same way.

**Neither is caused by this correction.** Both files' provider stubs call
`sessionSetup(...).finish(...)` without `activate(...)`, and both were unmodified
since before increment 3 introduced that requirement at `8fec6316` —
`agent-session-launch.test.ts` had not been touched since `9f15dc51`. The frozen
three-command selection never included either file, so increment 3 and increment
4 were both accepted with them red. First-failure output for both is preserved in
my scratchpad.

I applied the same mechanical fixture adaptation the configuration plan
authorized — the stub activates before it settles, with no retained conversation
to be held to, so it authorizes and saves nothing — and both files are now green
(11/63 and 10/73). No behavioral assertion in either file was weakened or
removed. **This is a hole in the frozen selection rather than a product defect,
and it wants selection reconciliation**: the third command's files exercise the
setup lifecycle, and nothing in the matrix ran the two files that consume it most
directly.

## Fixture adaptations, reported in full

- `agent-conversation.test.ts`: the stub now installs the direct object inside
  the same real provider factory, using the delivered coordinator for genuine
  setup and checkpoints, **alongside** its ordinary `Agent` middleware. The
  session, options and prompt bodies are shared by both paths rather than
  duplicated. `Traffic.sessionAgents` records the agent argument the direct
  `session` was given; `Traffic.namedAgents` is retired with the Agent-middleware
  lookup it described; a new `Traffic.routed` records every ordinary dispatch so
  a row can state the chat reached none. CV1a and CV1b keep their claims — one
  agent in force for both of a turn's operations, including a nondefault one —
  and now assert it of the explicit argument plus an empty `routed`, as the plan
  directed. New `StubOptions`: `withoutConversations` (DP5), `answersWith`
  (DP3), `asks` and `checkpoint` (DP4). New `Traffic`: `settledSessions` and
  `promptSessions`, the exact objects, so DP3 can compare identity.
- `host-conversation.test.ts`: `host()` takes options — `states: false` to leave
  the construction inputs unstated, `agents` for the registry, `around` for a
  case's own middleware — and `withConversation` takes an agent. HC1–HC4 and SC1
  are unchanged in behavior and call `host()` with no arguments.
- `agent-function-components.test.ts` and `agent-session-launch.test.ts`: the
  activation above, nothing else.

No CLI fixture changed. The Sidekick assembly keeps its empty tool and server
lists, `deny-all`/strict/noninteractive-deny permissions, null prompt
customization, dedicated agent and model/effort behavior; the recovery suite
still uses its real subprocess history and on-disk ACPX store.

## Documentation

- `specs/acp-client-spec.md`: the provider-factory seam now says a provider
  installs `Agent` middleware and, if it serves saved conversations, one provider
  object; the `AgentConversationProvider` contract is written out with its
  ownership, lifetime and the per-dispatch-selection exclusion. The
  conversation section gains "**It does its work through one installed provider,
  directly**" — the single read, what reading does not do, why middleware is the
  wrong channel here, the no-fallback refusal, and what Core kept, including the
  completion evidence and its distinction from `activate()`. The agent paragraph
  no longer describes a selection bound for the turn's scope. The permission-audit
  section now states one wrapper implementation and one audit per consumed
  stream, named for both paths.
- `specs/executable-mdx-spec.md`: a module-roster row for
  `conversation-provider.ts`, and the `conversation.ts` row's agent sentence
  replaced with the direct-provider description plus the completion evidence.
- `architecture.md`: the retained-host-conversation row and the permission-audit
  paragraph aligned the same way.
- `specs/repl-spec.md`: **unchanged.** Its one relevant statement — the Sidekick
  installs that same selected provider with constraints of its own — is still
  true, so there was nothing this patch untrued.
- `.agents/architecture-rules.md`: rules 23–25 and their explanatory paragraph,
  exactly as the plan transcribed them. `AGENTS.md` Code Rule 15 replaced with
  the approved amendment. Nothing else was carried from the main checkout.

## Two things to look at

**The rule numbering now reads 21, 23, 24, 25.** The main checkout also holds an
uncommitted rule 22 ("Never mutate `next` or attach metadata to it"), which
belongs to different work; the plan told me to carry exactly 23–25 and no
unrelated rules, so I left the gap rather than importing it. If you would rather
the branch not carry a gap, that is a one-line decision for whoever reconciles
the two.

**`packages/acp/src/provider.ts` now imports `@executablemd/core/api`** — the
first `src` import of a Core subpath from that package. Deno resolves it through
the workspace and `scripts/build-npm.ts` derives npm entry points from
`deno.json`'s `exports`, which already lists `./api`, so both should be fine;
delivery's JSR and dnt gates are where that is actually proven, and I ran neither.

## Continuity

- Commit `004de839e85e53cff4d960cb515729d350383f30`, parent
  `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`, signed G, tarasm@gmail.com
- Title: `✨ Give a saved conversation one provider to call directly (#883)`
- Worktree: `.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`,
  clean
- Base verified clean at `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd` before work
  began; no rebase, reset, amend or discard, and no later delta to reconcile.
- Not pushed. No GitHub mutation, no CI inspection, no owner acquisition, no
  mounted section 5, no terminal packet.
- P2's `Result` shape is untouched. P1, increment 4 and R2 remain unaccepted
  until this exact commit is reviewed.
