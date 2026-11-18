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

Sessions continue quietly. XMD does not retain or compare old versions to
produce compatibility messages and emits no undetermined-version replacement
notice. Current executable selection, real availability errors and required
positive native identity confirmation remain.


Recorded CLI, adapter and host versions describe the checks that ran. They are
evidence, not an allowlist or a requirement to repeat certification for every
release. The existing live documents remain opt-in integration regressions for
initial use, original-context continuity and native handoff where supported.
Actual protocol capabilities and provider-native identity assertions remain
required.

## Consequences

Updating an agent CLI no longer requires a new XMD release, a downgrade or a
replacement conversation, and continuing says nothing about the change.

Existing routes and journals retain original facts. Fresh construction writes
only the required unbound construction and lifecycle records. Equality between
two original records that both carry a binding still refuses a disagreement;
nothing compares today's executable with either for admission, and nothing
rewrites history to claim today's executable made it. Tested versions remain
evidence rather than release certification. Independently reported usage and
supplied provenance retain their existing contract; an unmeasured build is
absent.

Positive identity is not proof of history: a provider asserting the same
identity over empty history passes confirmation. Regression suites detect that
with an original-only marker; no runtime detector is claimed.

The adapter metadata patches that supply turn identity, acceptance and native
identity remain required. This decision does not retire them.

## Amendment: quiet continuation

Date: 2026-11-18

An earlier form of this decision also required a once-per-session warning when
a session's recorded version differed from today's, a notice when the version
could not be determined, fresh executable history in new routes to compare
against, and an invocation-owned `compatibilityWarnings` set to deliver it.
Review then found that newly established ACP-only workflow sessions had no
place to keep that history.

The user withdrew the requirement: “We don’t need to save the old version,l or
show the message but if we did, we could store it in the journal”. The journal
suggestion is conditional future guidance, not a request to add storage. The
amendment supersedes the earlier warning requirement and the workflow warning
gap; it does not repair that gap or approve the storage proposal made for it.
The earlier warning-state approval remains historical evidence, not a reason to
keep the member, which was removed with its consumers.

## Current owner

- [ACP client — Sessions: ownership, routes and attachment](../acp-client-spec.md#sessions-ownership-routes-and-attachment)
- [ACP client — Availability](../acp-client-spec.md#availability)
- [ACP client — ACPX provider](../acp-client-spec.md#acpx-provider)
- [Native agent session launch — Executable build binding](../native-agent-session-launch-spec.md#executable-build-binding)
- [Native agent session launch — Structural checklist](../native-agent-session-launch-spec.md#structural-checklist)
