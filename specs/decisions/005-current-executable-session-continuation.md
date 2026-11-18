# Sessions continue on the current executable

Date: 2026-11-18

Approved through issue [#891](https://github.com/taras/executable.md/issues/891).

## Context

A Codex desktop update replaced `codex-cli 0.167.1` with `0.169.1`, and XMD
refused the next prompt of an ordinary workflow role Session: the conversation
had been created by the old version and could not be confirmed under the new
one. Native launch, client-native attachment and incomplete replay imposed the
same exact-build binding, and advertisement rested on the specific releases an
integration proof had run against. Only a held Codex conversation could
continue after an upgrade, through a narrower exception.

A build observation cannot tell whether a conversation is the same one. The
provider's live assertion of the native identity can, and ACPX already carries
a verified reopen that requires it.

## Decision

XMD uses the executable selected by the current environment and opens the
retained provider conversation. It requires the provider to confirm the same
native conversation identity. A version or digest change does not refuse
continuation. Missing required confirmation, a different identity or a real
resume failure stops the operation without creating a replacement
conversation. Historical executable observations remain unchanged.

Ordinary Session and Prompt, held conversations, native launch, client-native
attachment and incomplete replay share this one policy; there is no opt-in flag
and no separate held policy. A native handoff is confirmed over ACP — before a
native resume, and after a fresh client-allocated creation once the child has
joined. Exit status never confirms identity. A selected executable that is
missing or cannot run remains an availability failure.

Before affected live work, XMD warns once per logical session in the current
invocation when the observed version differs from its historical observation.
If the current version cannot be determined, it reports that once and
continues otherwise supported work. Missing historical metadata alone
establishes no observed difference. Diagnostics use stderr and leave
machine-readable stdout unchanged. Completed replay performs no executable
observation and emits no new compatibility warning.

The invocation owns the warning state. `AcpxProviderDependencies` gains one
member, `compatibilityWarnings?: Set<string>`: the CLI shares one transient set
across every provider installation of an invocation, and a host that omits it
gives each installation its own. Delivery uses the contextual `Stdio` stderr of
the task doing the work; no Agent operation or callback was added.

Recorded CLI, adapter and host versions describe the checks that ran. They are
evidence, not an allowlist or a requirement to repeat certification for every
release. The existing live documents remain opt-in integration regressions for
initial use, original-context continuity and native handoff where supported.
Actual protocol capabilities and provider-native identity assertions remain
required.

## Consequences

Updating an agent CLI no longer requires a new XMD release, a downgrade or a
replacement conversation. A user sees one warning naming both versions.

Routes and journals keep the observation recorded when their session was
constructed. Equality between two original records still refuses a
disagreement; nothing compares today's executable with either for admission,
and nothing rewrites history to claim today's executable made it.

Positive identity is not proof of history: a provider asserting the same
identity over empty history passes confirmation. Regression suites detect that
with an original-only marker; no runtime detector is claimed.

The adapter metadata patches that supply turn identity, acceptance and native
identity remain required. This decision does not retire them.

## Current owner

- [ACP client — Sessions: ownership, routes and attachment](../acp-client-spec.md#sessions-ownership-routes-and-attachment)
- [ACP client — Availability](../acp-client-spec.md#availability)
- [ACP client — ACPX provider](../acp-client-spec.md#acpx-provider)
- [Native agent session launch — Executable build binding](../native-agent-session-launch-spec.md#executable-build-binding)
- [Native agent session launch — Structural checklist](../native-agent-session-launch-spec.md#structural-checklist)
