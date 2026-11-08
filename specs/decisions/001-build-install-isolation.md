# Build/install isolation

Date: 2026-11-08

## Context

The pre-migration `AGENTS.md` (`448fb49e^`, Setup) records that a check or build
that reinstalls prunes the links another command is resolving through.
[Issue #279](https://github.com/taras/executable.md/issues/279) was the Node
typecheck failing after `deno task build`. Automatic dependency management can
write `node_modules/.deno` before the process reaches its own code, so a runtime
check would be too late to prevent that interference.

## Decision

Preparation belongs to `deno task setup`. Builds install nothing, use modes
that cannot create, relink or fetch dependencies, and refuse an unprepared
worktree. Builds and checks consume the prepared layout instead of repairing
it. This keeps one invocation from changing the links another is using.

## Current owners

- [AGENTS.md — Setup](../../AGENTS.md#setup)
- [Release process — Browser assets](../release-process-spec.md#8-browser-assets-executablemdweb)
