# Embedded ACP adapter provenance

This directory carries the maintained Codex tarball and the Claude preparation recipe. Every command that runs
one of those providers — `xmd workflow`, `xmd run` and `xmd plan` — executes
those instead of the adapter `npx` would resolve.

| Provider | Package | Version | Contracts |
| --- | --- | --- | --- |
| `codex` | `@agentclientprotocol/codex-acp` | 1.6.2 | `_meta.codex.turnId`, `executablemd.session-materialization/v1`, `_meta.agentSessionId` |
| `claude` | `@agentclientprotocol/claude-agent-acp` | 0.70.0 | `_meta.claudeCode.assistantMessageUuid`, `executablemd.session-materialization/v1`, `_meta.agentSessionId` |

`MANIFEST.json` records, for each: the exact upstream base and patched commit,
the preparation command, snapshot byte length and SHA-256, and complete file list. Codex remains in `generated/snapshots.ts`; deps generates Claude in `packages/acp/generated/claude-snapshot.ts`.

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
Codex installs its provider dependency as before. Claude carries one patched SDK
runtime and installs only the remaining adapter dependencies. The original SDK
package and its platform executables are absent from fresh materializations.

## Preparing the carried modules

Codex retains its maintained archive and module, regenerated with:

```sh
deno run --allow-all scripts/build-adapter-snapshots.ts
```

Claude is generated by `deno task deps` (also part of `deno task setup`).
`claude/recipe.json` records the exact public source URL, commit/tree/archive
hash, SDK URL/integrity/module/declaration hashes, source lock and compiler pins,
patch preimages/postimages, transform hash, executable map and expected output
hashes. `claude/adapter.patch` and `claude/sdk-transform.mjs` are readable inputs.
Complete producer packages and pristine SDK source are fetched into private
preparation scratch and are never tracked or shipped.

Preparation verifies every input and patch site, compiles with the pinned
compiler, and compares all 29 executable hashes with the reviewed runtime. It
packages only those executables, truthful runtime metadata, README and separate
licenses. The deterministic container uses sorted regular tar members, fixed
metadata and stored gzip blocks. Input or output mismatch refuses before atomic
publication. Cancellation joins owned tools/writes before removing scratch.

The resulting gitignored module is explicitly included in JSR, copied and
emitted by the npm builder, and imported by canonical host/release compilation.
Those consumers refuse missing or stale preparation with `deno task setup`;
they never download producer inputs or repair output. Two private fresh setups
prove reproducibility; distribution tests exercise the actual selected/emitted
module and installed runtime. Build cache purity is checked by `verify:clean`.

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
adapter's upstream `LICENSE`, and each runtime archive contains its own copy. Claude's carried Agent SDK bytes have separate terms, recorded in
[the SDK notice](claude/SDK-NOTICE.md), also carried as `SDK-NOTICE.md` in the runtime archive. The SDK is not Apache-2.0 adapter source.

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

Fresh Claude materialization runs npm with `--omit=optional`. Only the remaining adapter dependencies are installed; the original SDK package and its platform executable packages are physically absent. Existing content-addressed
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

The preparation recipe preserves these reviewed executable bytes. Its readable
SDK transformation checks the complete pristine hash and each unique patch site
in private scratch. Only repaired `dist/sdk/sdk.mjs` ships; every runtime SDK
import reaches it through `dist/claude-sdk.js`. Compiler declarations remain a
verified build input. They, the pristine SDK and the transform are absent from
the runtime archive; repository preparation reproduces the shipped bytes from
pinned public inputs instead.

### Claude resumed model under an explicit use

The readable `claude/adapter.patch` extends producer
`e3a6ceb7a50e1151fb49322ea83d331a4c8b74ca` with one local change for #1177; no
upstream commit carries it. A `session/load` or `session/resume` whose `_meta`
carries `"executablemd.has-explicit-model/v1": true` belongs to a client use
that names its own model. On that branch only, `createSession` skips
`getAvailableModels`' environment/settings reassertion and calls
`observeResumedModel`: the backend's `getContextUsage` model is the current
model selection verbatim, with the offered catalog and allowlist unchanged. A
failed or empty report, or one no offered model names exactly, refuses with an
invalid-request error before any prompt, so a client never reads it as a missing
conversation to replace. The marker is never passed into SDK options. Fresh,
unmarked and effort-only initialization keep the existing priority. The recipe
records the changed patch, `src/acp-agent.ts` postimage, `dist/acp-agent.js`
runtime and output hashes; source, SDK and compiler pins are unchanged.
