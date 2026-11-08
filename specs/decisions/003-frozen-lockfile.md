# Frozen lockfile

Date: 2026-11-08

## Context

The pre-migration `AGENTS.md` (`448fb49e^`, Setup) records that a task's own
resolution could rewrite a stale lockfile before flags on its command line
applied. `deno task deps` used to exit 0 while leaving the tracked lockfile
rewritten, so a successful preparation command did not prove the lock stayed
unchanged.

## Decision

The lockfile is frozen repository-wide through the root `deno.json`. Adding or
changing a dependency is an explicit act: run `deno install --frozen=false`,
commit the lockfile, then run `deno task setup`. Ordinary builds and checks do
not change the lockfile.

## Current owner

- [AGENTS.md — Setup](../../AGENTS.md#setup)
