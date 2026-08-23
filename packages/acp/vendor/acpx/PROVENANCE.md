# ACPX vendor provenance

`generated/` is the ACP runtime `@executablemd/acp` executes. It is a source
snapshot of npm `acpx@0.12.0`, carried in this package rather than resolved as a
dependency, with one behavioral patch.

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

## Why a patch exists

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

## Who owns this snapshot

Issue #561 carries it. Issue #566 owns the exit gate:
<https://github.com/taras/executable.md/issues/566>. A released ACPX version
that supplies the same scoped, non-retaining child-process environment replaces
the snapshot. ACPX 0.13.1 does not — its `SessionAgentOptions.env` is persisted
with the session record and reloaded, which is the retention this contract
forbids. Closed issue #526 is not reopened for it.

## Behavioral patch

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

## Upgrading

This snapshot is pinned to one release. Re-vendoring means fetching that exact
npm version again, re-applying the changes above, refreshing `MANIFEST.json`,
and re-running the verifier. Upgrading ACPX is a separate change from patching
it, and the two are not done together.

The patch is a workaround for a missing upstream capability. If ACPX gains a
transient agent-environment input of its own, the patch should be dropped
rather than maintained.
