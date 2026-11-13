# Host-installed Codex CLI

Date: 2026-11-08

Approved through issue [#1202](https://github.com/taras/executable.md/issues/1202)
and pull request [#1204](https://github.com/taras/executable.md/pull/1204).

## Context

The carried `@agentclientprotocol/codex-acp` 1.6.2 snapshot depended on
`@openai/codex` 0.148.0 and launched that bundled CLI unless `CODEX_PATH` was
set. The bundled CLI's model catalog omitted models the host's installed CLI
advertised. For a configured model missing from its catalog, the adapter
offered a model choice with no effort selector, so XMD correctly refused an
explicit effort that the host CLI supports. Claude had the same gap and already
uses the host-installed CLI.

The maintainer directed: "we had a similar problem with claude and we changed
it to use whatever version is installed on teh server. We shouldn't bundle
anything." That direction replaces the alternative of pinning a newer bundled
CLI.

## Decision

The retained Codex adapter launches the Codex CLI installed on the execution
host: nonempty `CODEX_PATH`, otherwise `codex` on the host PATH, selected and
checked for launchability at the runtime host boundary. The adapter carries no
Codex CLI dependency and no executable fallback. The adapter protocol code stays
carried because it supplies the turn identity, acceptance and native identity
metadata no published adapter reports.

Codex keeps its maintained archive and generated snapshot route. A readable
source patch against the recorded producer commit, with pinned lock and compiler
inputs, reproduces the shipped executable bytes.

## Consequences

The host must provide a launchable Codex CLI. A host without one refuses before
inference, and no bundled CLI supplies availability or a catalog.

Reproducibility covers the adapter bytes, not the host CLI they launch.
Updating the host CLI can change ordinary availability and the advertised model
and effort catalog while the adapter digest stays the same. A session offers
whatever the selected host CLI reports.

Native launch and attachment keep strict build equality. For a held Codex
conversation over ACP, the [ACP client contract](../acp-client-spec.md#acpx-provider)
requires live confirmation of the original native identity after a host upgrade.

The repacked snapshot has a new digest. It neither migrates saved records nor
equates the old and new snapshot identities.

## Current owner

- [ACP client — Availability](../acp-client-spec.md#availability)
- [ACP client — Adapter snapshots](../acp-client-spec.md#adapter-snapshots)
- [ACP client — ACPX provider](../acp-client-spec.md#acpx-provider)
- [Release process — Maintained Codex adapter](../release-process-spec.md#maintained-codex-adapter)
