# Implementor handback: Sidekick session configuration

**Review `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`.** Increment 4 is complete,
committed and signed; all three focused commands pass.

## Continuity

- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
- Branch: `agent/issue-883-pr2`
- Commit: `ef68c71ca26d24856e6a4a1e9d24943bd37876d1` — signed G,
  tarasm@gmail.com, parent `a66c5d8a5391d43cf8328435bba622a79cc7076b` (the
  assigned base)
- Title: `✨ Continue a saved conversation only under the configuration it has (#883)`
- 28 files changed, 1814 insertions, 56 deletions, including two new source
  files. Working tree clean, nothing untracked.
- Not pushed. Nothing on GitHub was touched and no CI was inspected.

### The signing interruption, for the record

The commit could not be written on the first two attempts: `git commit` failed
with `error: 1Password: failed to fill whole buffer` / `fatal: failed to write
commit object`, and a direct probe answered `Couldn't sign message (signer):
communication with agent failed` while `ssh-add -l` listed all three keys — the
same "lists keys, refuses signatures" state as before increment 1. No unsigned
commit was ever produced. After the agent recovered, the identical
`git commit -F` ran with nothing restaged, so the committed tree is the one the
evidence below was gathered against.

## What was implemented

### 1. Activation on the genuine issuance

`packages/core/src/agent/provider-configuration.ts` (new) declares
`ProviderSessionConfiguration` exactly as accepted, plus
`AdmitProviderConfiguration`, `parseProviderConfiguration()`, `sameJson()` and
`freezeJson()`. It imports no ACP type. All four members are required and
absence is never a default: a missing tool list would be saved as a
configuration that said nothing about tools, and the reopening that compared
against it would accept any tool set at all.

`session-setup.ts` re-exports the type beside the setup contract and adds
`activate(provider, agentCommand, configuration?): Operation<Result<void>>` with
the accepted signature. The type is declared in the leaf module rather than in
`session-setup.ts` itself because `session-request.ts` needs it for the
requirement and already sits below `session-setup.ts`; a declaration there would
have been a cycle.

`session-request.ts` carries the requirement on the private `Issuance` beside
the engine identity, and `SessionRequestData` now also hands the setup a `live`
reader rather than a snapshot — a setup outlives the acceptance that produced
it, and a boolean copied at acceptance would still say the element was live.
The public `AgentSessionRequest` is unchanged: name and `with()` only. A
renamed derivative shares the issuance and its requirement; a structural copy
carries neither.

`createSessionSetupOwner` implements activation: it checks installation and
issuance liveness, permits one attempt, and refuses `finish` until an attempt
has answered Ok. `attempted` is set **before** the acknowledgement suspends, so
a cancellation cannot reopen it, and `activated` is separate — a setup that
tried and failed is not a setup that has not tried.

`provider-api.ts`'s `sessionSetupOf()` forwards `activate` bound to the handle
that answered, like `finish`. A delivered setup without it throws
`AgentProviderInstallError`; there is no fallback that reads it as activated.

### 2. Saving and comparing in Core's conversation history

`conversation.ts` binds the requirement to the issuance each turn opens. The
first activation commits one `agent_conversation_configuration` record holding
the provider, the resolved command and the parsed configuration; every later
one compares against it in memory and writes nothing. `openable()` reads the
record out of the history, and `held()` re-offers it through
`replayConfiguration()` before the retained turns — which is where the first
activation wrote it, so a run that replayed its turns without it would be
offering the journal a prompt where the journal holds a configuration.

Comparison is `sameJson`: JSON values, key order ignored, array order kept.
Values are parsed into Core's own copy and frozen. A configuration record with
no recorded outcome refuses the whole opening rather than being guessed at.

### 3. The inputs ACP actually uses

`resolveSession()` activates after the command is resolved and the construction
inputs are settled, and before `constructRoute()`, `ensureFromPrepared()` or the
new path's `finish`. Only Ok proceeds.

`statedConfiguration()` builds the value from `newSessionOptions.allowedTools`,
the validated MCP JSON, `{ permissionMode, routing, nonInteractivePermissions }`
and `sessionOptions.systemPrompt ?? null`. An omitted `allowedTools` or absent
`mcpServers` makes the whole configuration unstatable rather than empty: an
omitted tool list leaves the agent whatever tools it has, and reporting `[]`
would let a continuation compare equal to a session built with every tool
enabled.

`mcpServers` and `newSessionOptions` are now `structuredClone`d once where the
dependencies are read, so the declaration and the actual construction read the
same detached values. Before this the provider shallow-copied `mcpServers` per
runtime creation, so a host editing a nested member between declaration and
construction would have declared one configuration and built another.

### 4. The Sidekick's constrained assembly

`packages/cli/src/repl/sidekick/assembly.ts` (new) builds the production
assembly: one `ExecutionInstallation` installing the selected ACP factory
through `installAgentComponents`' `rootProvider`, reusing the command's resolved
dependencies and replacing only what the Sidekick decides — `allowedTools: []`,
`mcpServers: []`, `permissions: "strict"`, `permissionMode: "deny-all"`, and no
system-prompt customization. `repl-profile.ts` exposes it as
`profile.sidekickAssembly`, built from the same resolved dependencies
`installAgentProviderStack` was given. Ordinary entry, Plan and raw
programmatic provider defaults are untouched.

## One new Core export, worth your attention

`parseJson` and `JsonParseError` are now exported from `packages/core/mod.ts`
beside the already-exported `isJsonObject`. The provider has to hand Core
`readonly JsonObject[]`, and producing that from ACPX's own `McpServer` union
without a type cast needs Core's parser — which is also the right boundary: the
provider validates its own inputs through the same reader Core would. If you
would rather the surface not widen, the alternative is a second JSON parser
inside the ACP package, and I did not want two.

## Frozen evidence

| Row | Where, and what it observes |
| --- | --- |
| SC1 | `agent-conversation.test.ts` "SC1: the configuration is committed before the provider resolves anything" — one record, holding the values, in the sequence `agent_conversation → agent_conversation_configuration → agent_prompt`; a second turn compares rather than writing again. `host-conversation.test.ts` "SC1: the configuration is the values construction used, and a later edit changes neither" — over the real provider and a real custom host: the actual `createdOptions.mcpServers` and `ensureCalls.sessionOptions.allowedTools` equal the admitted values, the saved record states all four members, and after the host edits a nested `env` value, pushes an arg and pushes a tool, both the construction inputs and the journal record are still the admitted values. |
| SC2 | `repl-sidekick-recovery.test.ts` "SC2: a reopening continues under its own configuration, and refuses a changed one" — separate processes over the disk-backed ACPX store. Creation records the configuration; two cold reads restore the same chat with 0 sessions, 0 prompts, 0 appends; the compatible arm answers on `native-one` as turn 2; the incompatible arm changes only `systemPrompt` from null to a literal through the same trusted installation path and refuses with `created under a different provider configuration`, with no non-inspect session key and 0 prompts; the chat, both turns, the native identity and the single configuration record all stand, and a later ordinary process still continues it. |
| SC3 | `agent-session-setup.test.ts` "SC3: a setup authorizes nothing without the configuration its conversation requires" — omitted where required refuses and the handle then refuses `finish`; `finish` without any activation refuses; supplied where required authorizes and settles; an ordinary request activates with none, saves none, and keeps the exact raw Session and the existing configured use. `agent-conversation.test.ts` "SC3: a provider that cannot state its configuration continues nothing" — nothing saved, nothing prompted. |
| SC4 | `agent-session-setup.test.ts` "SC4: one setup authorizes one attempt, and closure ends both halves" — activation cancelled while its acknowledgement is held: the admit body was entered once, a retry refuses with `already been activated once`, `finish` refuses with `has not been activated`, a fresh setup on a new issuance activates and settles, and a handle kept past issuance closure or owner closure refuses with its own message. |
| SC5 | `root-provider.test.ts`, two rows, driving the real `registerAgentProvider`/`installAgentProvider` delivery through `deliveryOf`/`sessionSetupOf`. The delivered handle is a class with a private field, so an unbound forward would throw: `activate` reaches that receiver once with exactly `("acpx", "scribe-cmd", CONFIGURATION)`. The second row delivers a handle whose `activate` was removed with `Reflect.deleteProperty` and the adapter refuses with `authorizes nothing`. |
| SC6 | `repl-sidekick-recovery.test.ts` R2m2, extended. The exact record list gains one `"event"`, and a new `durables` assertion names it: `import_component, import_component, agent_conversation, agent_conversation_configuration`. So while the first-turn acknowledgement is held — the provider accepted `native-one` and its own store retains it — the canonical history already holds the configuration. Every existing MC1–MC4, acceptance, native-identity, zero-work and no-resend observation is unchanged, and the third process still continues on `native-one`. |
| SC7 | The three focused commands. Model/effort inspection and apply/readback (SC1–SC24 in `provider.test.ts`), agent switch and reopen (`repl-sidekick-configuration.test.ts`), Stop, Elicit, message association and ordinary provider behavior all green. |

## Commands

```text
deno task test packages/core/tests/agent-session-setup.test.ts \
  packages/core/tests/agent-session-use.test.ts \
  packages/core/tests/agent-session-use-loaded-copy.test.ts \
  packages/core/tests/agent-conversation.test.ts \
  packages/core/tests/agent-components.test.ts \
  packages/core/tests/root-provider.test.ts
→ ok | 15 passed (79 steps) | 0 failed (2s)

deno task test packages/acp/tests/provider.test.ts \
  packages/acp/tests/permission-bridge.test.ts \
  packages/acp/tests/host-conversation.test.ts
→ ok | 12 passed (96 steps) | 0 failed (1s)

deno task test packages/cli/tests/repl-sidekick-recovery.test.ts \
  packages/cli/tests/repl-sidekick-configuration.test.ts \
  packages/cli/tests/repl-sidekick-journey.test.ts \
  packages/cli/tests/repl-sidekick-lifecycle.test.ts \
  packages/cli/tests/repl-history.test.ts
→ ok | 15 passed (86 steps) | 0 failed (35s)
```

No first failure output to preserve in the final state: all three pass. Every
failure met along the way was in work in progress and was fixed before these
runs, not worked around.

Supporting, beyond the assignment: `deno task check` exits 0 (run because a new
required interface member reaches every provider in the repository, and the
compiler is how that set is found rather than guessed), and `oxfmt --check
packages scripts` reports all files correctly formatted.

### The discriminating control

Exactly as assigned — only the configuration comparison was bypassed, by
making `sameJson(known, stated) || true` in `conversation.ts`:

| Arm | Result |
| --- | --- |
| SC2's compatible arm, both cold reads, creation | still green |
| SC2's incompatible arm | **FAILED** — `refused.failure` was `null` rather than the refusal |
| R2m2 | still green |

The mutation was confirmed applied by grepping the edited line before running,
the first output is above, and the file was restored from a byte copy taken
before the edit with the assigned commands re-run against the restored source.

## Fixture adaptations

Mechanical, and all of them keep their original behavioral assertions.

| Fixture | Adaptation |
| --- | --- |
| `core/tests/agent-session-setup.test.ts` | one `activated()` helper; every row that settles a setup now authorizes it first, and SP6 authorizes while the installation is live so its refusal is still the teardown |
| `core/tests/agent-conversation.test.ts` | the stub provider activates with a constrained configuration, with `StubOptions.declares` for a case that states a different one or none; `Traffic.activated` records what was declared |
| `acp/tests/provider.test.ts` | the coordinator's `sessionSetup` forwards `activate` to the genuine owner and logs it; `CoordinatorLog.configure` authorizes before settling |
| `acp/tests/native-launch.test.ts` | the trace's setup offers `activate`, recording what the provider declared |
| `acp/tests/loaded-copy.test.ts` | the foreign-core bridge reads and forwards `activate` across the same seam as `finish`, and the foreign coordinator's observed handle offers it |
| `cli/tests/fixtures/repl/issue-883/sidekick-harness.ts` | `assembly: profile.sidekickAssembly`, and `sidekitAgent: AGENT` so the production assembly selects the scripted agent rather than the environment's |
| `cli/tests/fixtures/repl/issue-883/recovery-phase.ts` | the same, plus `Script.systemPrompt` and a fixture-local `differingAssembly()` that is the production path with that one input replaced, plus a read-only `durablesOf()` reporter |
| `cli/tests/repl-sidekick-journey.test.ts`, `repl-sidekick-configuration.test.ts` | reopenings use the shared production assembly; the configuration row varies only the agent |
| `repl-agent-interface.test.ts`, `repl-journey.test.ts`, `fixtures/repl/issue-881/controlled-host.ts` | each profile stub declares a `sidekickAssembly` it never installs, since no row there opens a Sidekick conversation |

No fabricated configuration is appended anywhere. The recovery fixture reads the
record the production journal wrote and reports its durable type.

## Documentation

- `specs/acp-client-spec.md` — the provider-factory example carries
  `ProviderSessionConfiguration` and `activate`; the setup contract states when
  it is asked, that `finish` refuses until it answers Ok, requiredness of all
  four members, one attempt per setup, and the adapter's refusal. A new
  retained-conversation section states the commit-before-native-work order, the
  JSON comparison, the refusal that replaces nothing, and that configuration is
  not identity.
- `specs/executable-mdx-spec.md` — the `src/agent/conversation.ts` roster row
  gains the configuration record and comparison; a new row describes
  `src/agent/provider-configuration.ts`.
- `architecture.md` — the Sidekick section states that it installs a provider of
  its own with its constraints explicit, and that a conversation is continued
  only under the configuration it was created with.
- `specs/repl-spec.md` — the one statement the change untrued ("no second
  provider") now says the Sidekick installs the selected provider with its own
  constraints and there is no second provider *to select*; the behavior section
  states the configuration check in product terms.

The deferred update API is described nowhere as implemented.

## Limits honoured

No mounted section 5 work, no owner acquisition in `program.ts`, no terminal
R7/R8, no 36-frame packet, no push, no GitHub mutation, no CI inspection. No
`AgentConversationRequest` member, authored identity, public accessor, context
reader, module registry, CLI flag or settings control was added. The vendored
runtime and its generated artifacts are untouched. No dependency, build or
generated-artifact change.

Stop for Planner review once this is committed. R2 remains incomplete until this
amendment's implementation is accepted.
