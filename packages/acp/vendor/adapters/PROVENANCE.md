# Embedded ACP adapter provenance

This directory carries one npm tarball per provider, and every command that runs
one of those providers — `xmd workflow`, `xmd run` and `xmd plan` — executes
those instead of the adapter `npx` would resolve.

| Provider | Package | Version | Contracts |
| --- | --- | --- | --- |
| `codex` | `@agentclientprotocol/codex-acp` | 1.6.2 | `_meta.codex.turnId`, `executablemd.session-materialization/v1`, `_meta.agentSessionId` |
| `claude` | `@agentclientprotocol/claude-agent-acp` | 0.70.0 | `_meta.claudeCode.assistantMessageUuid`, `executablemd.session-materialization/v1`, `_meta.agentSessionId` |

`MANIFEST.json` records, for each: the exact upstream base and patched commit,
the build command, the tarball's byte length and SHA-256, and its complete file
list. `generated/snapshots.ts` carries the same bytes as a module.

## Why this exists

Three facts XMD needs, none of which a published adapter reports.

### Which turn a Prompt completed

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
conversation.

### Whether the backend accepted a turn

A new `<Session>` names a session; it does not create one. The conversation
begins when a backend accepts the first turn, and only the adapter is in a
position to say when that happened (`specs/acp-client-spec.md`). Everything else
a turn produces — text, a stop reason, a terminal response, a checkpoint token —
says the adapter is talking, and a client that read one of those as acceptance
would retain a conversation the backend may never have made.

Both adapters now report it the same way, on the same versioned key: a standard
ACP `session_info_update` whose update `_meta` carries
`{"executablemd.session-materialization/v1": {"state": "accepted"}}`, published
once per accepted turn, at the provider-specific boundary where acceptance
becomes true — Codex wherever the App Server answers with a turn, whether the
prompt reached it through `turn/start` or through a turn-starting command
(`/review`, `/goal <objective>`, `/goal resume`); Claude when the SDK reports
that exact queued command dispatched. A command that starts no turn reports
nothing, because nothing was accepted. It carries no session information of its
own, so a client not waiting for it reads nothing.

`materializationContract` in `MANIFEST.json` records it separately from
`contract` above: which turn completed and whether a backend accepted one are
different claims, and an adapter could carry either without the other.

### Which conversation the provider actually opened

Handing a running session to the provider's own CLI needs the identity that CLI
addresses — for Codex, the App Server thread the adapter created or reopened.
Codex allocates it, so a client cannot know it without being told. Claude's
adapter requests a name but confirms the conversation the backend actually opens.
Its snapshot returns `_meta.agentSessionId` on new/load/resume only after its
owned SDK Query supplies a successful SessionStart lifecycle response with that
exact `session_id`. One fixed no-op command hook, using the adapter's own Node
runtime, is composed into settings before startup or resume. Deliberate settings
and hooks survive; disabled, absent, failed, conflicting or mismatched
confirmation refuses. The reader records identity refusal before closing its SDK
iterator, whose cleanup can release pending setup lookups. Session publication
rechecks reader failure and disposal after optional SDK setup, before registering
or answering success. One owned reader buffers early unrelated messages and
retains the explicit acceptance and exact completed-prompt checkpoint handling.
Fresh confirmation stays provisional until acceptance and the asserting save.
Native Claude allocation remains client-allocated, independently of metadata.

The Claude source revision recorded in MANIFEST.json extends the retained patch
at `54df80cbb41f2aa56195fd56b4dc2a88295049af`; its local source patch and build
receipt are supplied with the implementation evidence. The pin records source
identity, not an unperformed independent review.

Codex 1.6.2 returns that thread id only as the top-level ACP `sessionId`, which
is the ACP session's own name. A client cannot tell from it whether the provider
allocated the identity or the client did, and reading it as native identity would
mean asserting a thread the App Server may never have confirmed. The snapshot
therefore reports it explicitly on the response `_meta` of `session/new`,
`session/load` and `session/resume`, as `{"agentSessionId": "<thread id>"}`,
taken from the thread the App Server answered with rather than the one requested.

That change is not part of PR #438, which carries the turn identity. It is
reachable at
<https://github.com/taras/codex-acp/tree/feat/session-native-identity>, recorded
as `patchedBranch` beside the commit it names.

`identityContract` in `MANIFEST.json` records this third contract for both adapters, for
the same reason `materializationContract` is separate: an adapter could report a
turn identity, acceptance or backend session identity without the others.

These snapshots are what stands in until both land upstream.

## What is carried, and what is not

The **adapter** is carried. The **agent** is not: neither snapshot contains the
`claude` or `codex` binary, and neither would be legitimate to redistribute here.
Codex installs its provider dependency as before. Claude retains the SDK library
and uses the host CLI; fresh installs omit the SDK platform executable optionals.

The tarballs contain adapter code and declarations; runtime dependencies are
installed into each private materialization tree.

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
which is earlier than any `<Session>` request and earlier than any turn. A
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

A missing acceptance marker is a different matter, and deliberately so: no
fallback promotes a session in its place, so a first turn that never reports
acceptance leaves the session unestablished rather than silently retained.

A missing checkpoint affects only association retention. An agent that reports
no turn identity — because this build overrides nothing for it, or because the
metadata was absent or unreadable — completes its Prompt exactly as it always
did; the run simply holds no association for it.

## Licences

Both adapter packages are Apache-2.0. Each provider directory carries the
adapter's upstream `LICENSE` beside its tarball, and each tarball contains its
own copy. Claude's carried Agent SDK bytes have separate terms, recorded in
[the SDK notice](claude/SDK-NOTICE.md) and the archive's
`vendor/claude-agent-sdk/UPSTREAM-README.md`. The SDK is not Apache-2.0 adapter source.

## Who owns this

Issue #636 is the exit gate. Each provider returns independently to an exact
qualifying upstream release once that release carries the same contract and the
same protocol evidence passes; the snapshot for the other stays until its own
release exists.

This is separate from #629, which owns the ACPX `checkpointMeta` patch, and from
#566, which owns the ACPX `agentProcessEnv` patch. Those are patches to a
runtime this repository imports. These are whole packages it executes.

### Host Claude and fresh installation

The retained Claude adapter uses the host's selected `CLAUDE_CODE_EXECUTABLE`,
or `claude` resolved through the host execution environment. A missing or
unlaunchable selection refuses before a model prompt. Only the matching child
receives the selected path; durable session records and parent environment do
not. Explicit custom agent commands keep their selection.

Fresh Claude materialization runs npm with `--omit=optional`. The Agent SDK
library and required adapter dependencies remain, while its eight platform
Claude executable packages are physically absent. Existing content-addressed
caches are reused unchanged; the new snapshot has its own digest directory.
Codex installation policy and snapshot bytes remain unchanged.

### Claude native close and startup cleanup

Producer `e3a6ceb7a50e1151fb49322ea83d331a4c8b74ca` extends
`bea799c86d16ed2b1bf1cfe8d7fd6e22e6525b56`. Its opening account exists before cwd
validation and owns settings, input, callbacks and the Query reader until cleanup
finishes or the same Query transfers to a Session. Disposal initiates shutdown
for every opening and Session and joins their cleanup. A refused opening publishes
no Session or acceptance; the initiating identity failure remains primary.

The private SDK remains version 0.3.238. Its default transport retains actual
native child close, separately from exit status and its bounded exit wait.
`Query.return(undefined)` joins that completion through the existing idempotent
cleanup promise. Custom spawners keep their exit/error-only contract and the
default launcher's executable selection, arguments, stderr and escalation remain.

`npm run build && npm pack` runs `node vendor/claude-agent-sdk/build.mjs && tsc`
before packing. The carried `transform.mjs` checks the complete pristine SDK hash
and every unique patch site before generating `dist/sdk/sdk.mjs`. Runtime SDK
imports pass through `dist/claude-sdk.js`; declarations still refer to the pinned
SDK package. The pristine module is source evidence and is never executed by the
adapter. Its declarations, registry integrity, upstream terms and readable
transform travel in the same verified archive. The vendor test reproduces the
runtime module offline from those bytes and checks input/site refusals. Two
identical producer builds produce byte-identical archives.
