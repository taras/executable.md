# Embedded ACP adapter provenance

This directory carries one npm tarball per provider, and a workflow run executes
those instead of the adapter `npx` would resolve.

| Provider | Package | Version | Contract |
| --- | --- | --- | --- |
| `codex` | `@agentclientprotocol/codex-acp` | 1.6.2 | `_meta.codex.turnId` |
| `claude` | `@agentclientprotocol/claude-agent-acp` | 0.70.0 | `_meta.claudeCode.assistantMessageUuid` |

`MANIFEST.json` records, for each: the exact upstream base and patched commit,
the build command, the tarball's byte length and SHA-256, and its complete file
list. `generated/snapshots.ts` carries the same bytes as a module.

## Why this exists

A workflow Prompt retains which provider turn it completed
(`specs/workflow-workspace-spec.md` §8.6). The identity can only come from the
adapter, on the ACP `PromptResponse._meta` of the exact response that completed
the turn — nothing else names it. Transcript text repeats, another turn's token
is a different turn, a provider's current head is a later point, and prompt or
journal order is position rather than identity.

No published Codex or Claude adapter reports it yet. Both changes are submitted
upstream and unmerged:

- <https://github.com/agentclientprotocol/codex-acp/pull/438>
- <https://github.com/agentclientprotocol/claude-agent-acp/pull/1047>

Until those release, a run using a published adapter completes every Prompt and
retains nothing — silently, after being told it was continuing an exact
conversation. These snapshots are what stands in until then.

## What is carried, and what is not

The **adapter** is carried. The **agent** is not: neither snapshot contains the
`claude` or `codex` binary, and neither would be legitimate to redistribute here.
Those arrive as ordinary dependencies when the adapter is installed, exactly as
they would for anybody installing it from the registry.

That is why the tarballs are small — 208 KB and 194 KB — while a materialized
adapter's dependency tree is hundreds of megabytes. The size lives where it
always did.

Each tarball is the upstream project's own `npm run build && npm pack`. Nothing
is re-bundled, re-packaged, or built differently from how that project ships it,
so what runs here is what would run from the registry once the pull requests
land.

## Why the bytes also travel in the module graph

A tarball on disk is unreachable from a compiled binary and from the dnt npm
artifact. `generated/snapshots.ts` carries the same bytes so that one mechanism
serves every distribution: the source tree, the npm package and `dist/xmd` all
inline exactly these bytes and materialize the same identity.

It is committed rather than built, because a generated file the source
distribution needs cannot be one the source distribution has to build first.
`scripts/tests/adapter-vendor.test.ts` regenerates it in memory and compares, so
the file reviewed and the bytes executed cannot drift apart.

Regenerate with:

```bash
deno run --allow-all scripts/build-adapter-snapshots.ts
```

`npm pack` is byte-reproducible for these packages: two runs of the same build
produce the same tarball and therefore the same digest.

## How one reaches the disk

`packages/acp/src/adapter-snapshots.ts` materializes a snapshot under its own
SHA-256 beneath a host-owned root. Content-addressed, so identity is the
location and nothing has to decide whether an existing directory is current.

The command is derived from the digest, so it answers before anything is
installed — which is what lets a session key be built from it early and never
change underneath. Materialization itself is lazy: it happens only for a
selection this build carries a snapshot for, and only just before the first
operation that could spawn that adapter — the provider's availability probe,
which is earlier than any `<Session>` placement and earlier than any turn. A
document that opens no `<Session>` installs nothing.

Publication is one rename out of a private staging directory, and a marker
naming the digest is written last and read first. A concurrent run either wins
that rename or finds the directory already there; both verify before use. An
unpublished tree at the target is abandoned work and is replaced, because a
rename cannot overwrite a non-empty directory and leaving it would wedge that
adapter permanently.

Every failure refuses: a digest that does not match, an install that fails, a
missing entry point, a marker naming another snapshot. Nothing falls back to the
published adapter — doing so would produce exactly the silent, token-free run
this exists to prevent.

The registry the workflow profile installs overlays these two providers onto
ACPX's own, rather than replacing it. Codex and Claude resolve to their exact
embedded snapshots and never fall through — a snapshot that cannot be verified,
materialized or launched refuses that agent instead. Every other agent name
delegates unchanged to the baseline registry, resolving to the same command and
retaining the same compatibility identity as it did before any adapter was
carried here.

A missing checkpoint affects only association retention. An agent that reports
no turn identity — because this build overrides nothing for it, or because the
metadata was absent or unreadable — completes its Prompt exactly as it always
did; the run simply holds no association for it.

## Licences

Both packages are Apache-2.0. Each provider directory carries the upstream
`LICENSE` beside its tarball, and each tarball contains its own copy.

## Who owns this

Issue #636 is the exit gate. Each provider returns independently to an exact
qualifying upstream release once that release carries the same contract and the
same protocol evidence passes; the snapshot for the other stays until its own
release exists.

This is separate from #629, which owns the ACPX `checkpointMeta` patch, and from
#566, which owns the ACPX `agentProcessEnv` patch. Those are patches to a
runtime this repository imports. These are whole packages it executes.
