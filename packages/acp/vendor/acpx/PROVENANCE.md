# ACPX vendor provenance

This directory is the local override XMD resolves as `acpx@0.12.0`, for both
Deno and pnpm. Its public package identity is unchanged.

- Package: `acpx@0.12.0` from npm
- Repository: `https://github.com/openclaw/acpx`
- Release commit: `6a24a546d2349cbe71ed032d52d07cab611e320c`
  (`chore(release): prepare acpx 0.12.0`)
- License: MIT; the upstream notice is copied as `LICENSE`.
- Retrieved: 2026-08-21

`dist/` is the published tarball's `dist/`, with the one patch below applied.
`upstream/` preserves the pre-patch bytes of exactly the four files the patch
touches, so the verifier can prove offline that nothing else moved and that the
patch is exactly what is documented here.

## Why a patch exists

Native session launch binds one exact Claude executable to both owners of a
session: XMD spawns that path for the native UI, and the ACP adapter must run
the same build when it later reattaches. Two builds disagreeing is not a
theoretical risk — it is the observed cause of issue #519's first failed gate,
where Claude Code 2.1.235 created a session and the SDK-bundled 2.1.232 was
asked to resume it and silently produced an empty conversation.

The adapter reads `CLAUDE_CODE_EXECUTABLE` from its own process environment.
ACPX 0.12.0 offers no way to set an agent child's environment transiently:

- `SessionAgentOptions.env` is persisted to
  `record.acpx.session_options.env`, which would write an invocation-local
  absolute path into durable state, which the #519 contract forbids; and
- mutating `process.env` would leak the binding to every other child of the
  XMD process, including unrelated agents and commands.

So the runtime gains one transient input instead.

## The patch

One new optional value, `agentProcessEnv`, threaded from runtime options to
every agent child that runtime spawns.

| File | Change |
| --- | --- |
| `dist/runtime.js` | `AcpRuntimeManager.createClient()` merges `this.options.agentProcessEnv` into the options of every client it creates — doctor, ensure, reconnect, control and turn clients all funnel through here. `createProbeClient()` builds its own options and never reaches the manager, so it is threaded explicitly. |
| `dist/live-checkpoint-ClPCSdrW.js` | `buildAgentSpawnOptions()` takes the value and spreads it **last** into the child's `env`, after auth credentials and session options. Its one call site passes `this.options.agentProcessEnv`. |
| `dist/runtime.d.ts` | declares `AcpRuntimeOptions.agentProcessEnv`. |
| `dist/session-options-jkYbBxGE.d.ts` | declares `AcpClientOptions.agentProcessEnv`. |

What the patch deliberately does not do:

- it never writes `agentProcessEnv` into `SessionAgentOptions`, a session
  record, an event, a status, a diagnostic, or a serialized store;
- it never touches `process.env`;
- it never encodes the executable in the agent command string; and
- it changes no other behavior, and upgrades nothing.

Merging last is the point: a caller that binds an executable must win over
whatever the adapter would otherwise resolve for itself.

## Upgrading

This override is pinned to one release. Re-vendoring means fetching that exact
npm version again, re-applying the four hunks above, refreshing
`MANIFEST.json`, and re-running the verifier. Upgrading ACPX is a separate
change from patching it, and the two are not done together.

The patch is a workaround for a missing upstream capability. If ACPX gains a
transient agent-environment input of its own, this directory should be deleted
rather than maintained.
