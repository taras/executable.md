# ACPX vendor provenance

`generated/` is the ACP runtime `@executablemd/acp` executes. It is a source
snapshot of npm `acpx@0.12.0`, carried in this package rather than resolved as a
dependency, with two behavioral patches.

- Package: `acpx@0.12.0` from npm
- Repository: `https://github.com/openclaw/acpx`
- Release commit: `6a24a546d2349cbe71ed032d52d07cab611e320c`
  (`chore(release): prepare acpx 0.12.0`)
- License: MIT; the upstream notice is copied as `LICENSE` and reproduced in
  `packages/acp/THIRD_PARTY_NOTICES.md`, which travels with the npm artifact.
- Retrieved: 2026-08-21

`upstream/` preserves the pristine bytes of the same five files, so the verifier
can prove offline that nothing else moved and that each difference is one of the
changes recorded here.

## Why it is carried in-package

The repository's builds and its release compile run with
`--node-modules-dir=none --cached-only`. A package-level override cannot resolve
there — Deno's `links` mechanism links npm packages and needs a node_modules
directory, which those commands deliberately do not have. Importing the runtime
by relative path resolves in every mode, and dnt inlines a local import into the
npm artifact instead of externalizing it.

`@executablemd/workflow` carries its Cloudflare DOFS snapshot the same way.

Only `packages/acp/src/acpx-runtime.ts` imports this closure. The ordinary
`acpx@0.12.0` dependency remains for historical probes and public types;
nothing in production executes it.

## Why the first patch exists

Native session launch binds one exact Claude build to both owners of a session:
XMD spawns that path for the native UI, and the ACP adapter must run the same
build when it later reattaches. Two builds disagreeing is not a theoretical
risk — it is the observed cause of issue #519's first failed gate, where Claude
Code 2.1.235 created a session and the SDK-bundled 2.1.232 was asked to resume
it and silently produced an empty conversation.

The adapter reads `CLAUDE_CODE_EXECUTABLE` from its own process environment, and
ACPX 0.12.0 has no way to put it there transiently: `SessionAgentOptions.env` is
persisted into the session record, and mutating `process.env` would bind every
other child of this process. Both are forbidden by #561's contract.

## Behavioral patch: `agentProcessEnv`

One new optional value, `agentProcessEnv`, threaded from runtime options to
every agent child that runtime spawns.

| File | Change |
| --- | --- |
| `generated/runtime.js` | `AcpRuntimeManager.createClient()` merges `this.options.agentProcessEnv` into every client it creates — doctor, ensure, reconnect, control and turn clients funnel through here. `createProbeClient()` builds its own options and never reaches the manager, so it is threaded explicitly. |
| `generated/live-checkpoint-ClPCSdrW.js` | `buildAgentSpawnOptions()` takes the value and spreads it **last** into the child's `env`, after auth credentials and session options. Its one call site passes `this.options.agentProcessEnv`. |
| `generated/runtime.d.ts` | declares `AcpRuntimeOptions.agentProcessEnv`. |
| `generated/session-options-jkYbBxGE.d.ts` | declares `AcpClientOptions.agentProcessEnv`. |

Merging last is the point: a caller that binds an executable must win over
whatever the adapter would otherwise resolve for itself.

The patch never writes `agentProcessEnv` into `SessionAgentOptions`, a session
record, an event, a status, a diagnostic or a serialized store; never touches
`process.env`; never encodes the executable in the agent command; and changes no
other behavior.

## Why the second patch exists

A portable checkpoint is the identity a provider gives the turn it just
completed, and it arrives on the ACP `PromptResponse._meta` of that exact turn.
ACPX 0.12.0 reads the response, takes its stop reason and its usage, and drops
the rest: `AcpRuntimeTurnResult` carries a status and a stop reason and has
nowhere for the response's own metadata to go. A consumer therefore cannot tell
which turn a completion was, however carefully the adapter names it.

Recovering it from anywhere else is the failure this exists to avoid. The
transcript repeats, another turn's token is a different turn, a later provider
head is a different point in the conversation, and prompt or journal order is
position rather than identity. Only the response that completed this turn says
what this turn was, so only that response is read.

## Behavioral patch: `checkpointMeta`

The ACP `PromptResponse._meta` of a normally completed turn, carried out
unchanged.

| File | Change |
| --- | --- |
| `generated/live-checkpoint-ClPCSdrW.js` | `runPromptTurn()` carries `response._meta` out as `checkpointMeta` on its RPC completion path. Its timeout/session-update fallback returns without one: that path never read a `PromptResponse`, and a turn reconstructed from session updates has no response metadata to report. |
| `generated/runtime.js` | `runRuntimeTurnTask()` puts that value on the settled result as `_meta`, and only when the turn is not cancelled. A cancelled turn, a failed turn and the fallback each settle exactly as before. |
| `generated/runtime.d.ts` | declares `_meta` on the `completed` variant of `AcpRuntimeTurnResult`. |

The value is copied, never parsed: whatever the adapter put on `_meta` is what
a consumer receives, and ACPX recognizes no key in it. Which keys mean
something is `@executablemd/acp`'s decision, not this runtime's.

The patch writes nothing to a session record, an event, a status, a diagnostic
or a serialized store; adds no key of its own; and changes no other behavior.

## Packaging adaptations

These change no runtime behavior and exist because the snapshot is five files
rather than a published package:

1. Sibling type imports in the declarations are retargeted from `./name.js` to
   the colocated `./name.d.ts`, since the closure carries no `.js` for
   declaration-only modules.
2. `//# sourceMappingURL=` comments are removed, because the closure carries no
   `.map` files and a dangling reference is worse than none.
3. Every file ends with a newline, which some upstream artifacts do not.

The regression proves these are the *only* differences in a file that is not
also behaviorally patched: undoing all three must reproduce upstream byte for
byte.

## Who owns this snapshot

Issue #561 carries `agentProcessEnv`, and issue #566 owns its exit gate:
<https://github.com/taras/executable.md/issues/566>. A released ACPX version
that supplies the same scoped, non-retaining child-process environment replaces
it. ACPX 0.13.1 does not — its `SessionAgentOptions.env` is persisted with the
session record and reloaded, which is the retention that contract forbids.
Closed issue #526 is not reopened for it.

Issue #622 carries `checkpointMeta`: <https://github.com/taras/executable.md/issues/622>.
A released ACPX version that carries the completing turn's own
`PromptResponse._meta` out to its consumer replaces it.

## Both patches, one snapshot

They are independent and share no code. Each introduces one identifier that
occurs nowhere upstream — `agentProcessEnv` and `checkpointMeta` — which is what
lets the vendor regression hold every introduced line to the neighbourhood of a
patch instead of to a keyword upstream already uses.

## Upgrading

This snapshot is pinned to one release. Re-vendoring means fetching that exact
npm version again, re-applying the changes above, refreshing `MANIFEST.json`,
and re-running the verifier. Upgrading ACPX is a separate change from patching
it, and the two are not done together.

Each patch is a workaround for a capability upstream does not have, and each is
dropped rather than maintained once upstream has it: `agentProcessEnv` when
ACPX gains a transient agent-environment input of its own, `checkpointMeta` when
it carries the completing turn's response metadata out on its own.
