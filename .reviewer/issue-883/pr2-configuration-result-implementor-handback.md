# Implementor handback: the Result correction (P2)

**Review `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.** P2 is corrected. P1 — the
request-routing finding — is untouched and still awaits the Architect's
disposition.

## Continuity

- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
- Branch: `agent/issue-883-pr2`
- Commit: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd` — signed G, tarasm@gmail.com,
  parent `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`
- Title: `♻️ Refuse an unstatable configuration with an Error, not a local union (#883)`
- 2 files changed, 28 insertions, 25 deletions. Working tree clean, nothing
  untracked. Not pushed.
- `ef68c71c` was not amended and is still reachable as this commit's parent.

## What changed

Two files, both in Core.

`packages/core/src/agent/provider-configuration.ts`

- `parseProviderConfiguration` returns `Result<JsonObject>`. The local
  `ParsedProviderConfiguration` union is deleted, not renamed — the discriminant
  is Effection's, and `Ok(parsed)` carries the value under `value`.
- The seven refusals go out on a new private `ProviderConfigurationUnstated
  extends Error` through one `unstated(why)` helper, mirroring
  `configuration-record.ts`'s existing `ConfigurationUnreadable` / `unreadable`
  pair rather than inventing a second idiom for the same job.
- The class is deliberately not exported. Nobody refuses with it: it exists to
  carry the detail that the conversation's own refusal quotes.
- **Every refusal string is byte-identical to the one it replaced**, including
  the em dash in the `systemPrompt` sentence. Parse, copy and freeze are
  untouched: the value is still read through Core's `parseJson`, still frozen by
  `freezeJson` before it is handed back, and still frozen *before* the `Ok`.

`packages/core/src/agent/conversation.ts`

- One line: `admitting()` reads `parsed.error.message` where it read
  `parsed.reason`. The surrounding `AgentConversationError`, its full sentence
  and its classification are unchanged, so the refusal a caller sees is the same
  string it was at `ef68c71c`.
- No `Err(parsed.error)` rebuild was introduced. The conversation answers in its
  own terms, which is a distinct failure from the parse's, so Code Rule 13's
  narrowing clause does not apply here.

Nothing else moved: no configuration value, no journal record type or name, no
`sameJson` comparison, no activation lifecycle. `ParsedProviderConfiguration`
was never re-exported from `packages/core/mod.ts` and is named in no
specification, so its removal needed no public or spec edit —
`specs/executable-mdx-spec.md:1959` lists only names that survive.

## Evidence

### The targeted check, both ways

First failure at `ef68c71c`, preserved before any edit:

```text
$ ./node_modules/.bin/oxlint -c .oxlintrc.json packages/core/src/agent/provider-configuration.ts
packages/core/src/agent/provider-configuration.ts:167:36: warning unicorn(no-array-sort): …
packages/core/src/agent/provider-configuration.ts:168:39: warning unicorn(no-array-sort): …
packages/core/src/agent/provider-configuration.ts:62:3: error local(prefer-effection-result):
  Use Effection's Result<T> instead of declaring an ok: true | false union: move the success
  payload under `value` and make the failure an Error.
EXIT=1
```

Same command on the committed source:

```text
packages/core/src/agent/provider-configuration.ts:170:36: warning unicorn(no-array-sort): …
packages/core/src/agent/provider-configuration.ts:171:39: warning unicorn(no-array-sort): …
EXIT=0
```

The `local/prefer-effection-result` error is gone and the two sort warnings — not
acceptance blockers per the correction — are unchanged in both directions. The
rule is read live in both runs, so the gate is confirmed to discriminate rather
than to have been satisfied by silence.

### The three assigned commands

```text
deno task test packages/core/tests/{agent-session-setup,agent-session-use,agent-session-use-loaded-copy,agent-conversation,agent-components,root-provider}.test.ts
→ ok | 15 passed (79 steps) | 0 failed (2s)

deno task test packages/acp/tests/{provider,permission-bridge,host-conversation}.test.ts
→ ok | 12 passed (96 steps) | 0 failed (1s)

deno task test packages/cli/tests/{repl-sidekick-recovery,repl-sidekick-configuration,repl-sidekick-journey,repl-sidekick-lifecycle,repl-history}.test.ts
→ ok | 15 passed (86 steps) | 0 failed (39s)
```

42 tests, 261 steps, zero failures — the same totals the review counted
independently at `ef68c71c`. No first-failure output to preserve: nothing failed
at any point in this correction.

### The refusal path is observed, not merely unchanged text

`agent-conversation.test.ts`'s **SC3** asserts
`toContain("no active provider configuration was named")` on the conversation's
refusal, and that nothing was saved and no prompt was sent. It passes on the
committed source, so the message now travels through
`Err(new ProviderConfigurationUnstated(…))` → `parsed.error.message` → the
`AgentConversationError` and arrives identical. A silent change of shape would
have broken that row.

### Also run, unassigned and green

`deno check` on both touched files (exit 0) and `oxfmt --check` on both ("All
matched files use the correct format"). No full lint, check, JSR or suite was
run, as the correction directed.

## P1 remains open

I implemented nothing for the request-routing finding and made none of the
prohibited moves: no authority channel, no public flag, no broader coordinator
accessor, no global ordinary-session restriction, no post-reattachment check.
The Architect return's probes and their first outputs are unchanged. Increment 4
and R2 cannot be complete until that boundary has a disposition.

No owner acquisition, mounted section 5 work, terminal packet, push, GitHub
mutation or CI inspection was opened.
