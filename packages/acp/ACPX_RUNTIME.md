# Use the pinned ACPX runtime

Read this when changing the ACP provider or a host that retains its sessions.
It identifies the released API XMD uses and the local acceptance boundary it
still needs.

## Applies to

The production ACP provider, session-store readers and their runtime adapters.
This is an internal integration guide; documents keep the ordinary Agent,
Session and Prompt syntax.

## Instructions

**Purpose:** run a coding-agent conversation through released ACPX behavior
while retaining exact provider identity and explicit first-turn acceptance.

**Optimized for:** installing the production provider and configuring or
reopening the same conversation without knowing ACPX's private session owner.
Import runtime values and types through `src/acpx-runtime.ts`.

**Friction removed:** child-only environment delivery and opaque response
metadata transport are supplied by the released base, with no local patches
for either. Released cancelled results may carry metadata; XMD's existing
completed-terminal filter keeps checkpoint retention unchanged. Configuration reads and
writes use that base's retained owner and reconnect behavior. No XMD writer
patch repairs the reproduced same-millisecond temporary-file collision.

**Friction retained:** the vendor closure still carries #648's explicit backend
acceptance and waitable asserting-save barrier. A provider still owns queues,
handles, cancellation, exact identity checks and its host mapping. The closure
has nine files instead of the old five; that is additional upstream packaging,
not a reduction in maintenance. `resolveAgentCommand()` adds one small boundary
adaptation for released argv registries, preserving the runtime's persisted
spelling and leaving existing string commands unchanged.

**Maintenance:** keep the runtime and its declarations on the same exact
artifact. An ordinary Prompt change belongs in the provider; provider turn-key
interpretation belongs in `checkpoint.ts`; release refreshes update provenance,
pristine files, declared patches, dependencies and the manifest together.
The existing provider configuration writer observes a released response-bearing
write as completion before restoration may begin.

## Example

`tests/released-runtime.test.ts` installs the actual production factory with
`createAcpxProvider({ sessionStore, agentRegistry, sessions, ... })`, runs a
real document through `executeInstalled(...)`, and checks that
`recordSessionIdentity()` observes the already saved native identity. The
registry returns argv containing a path with spaces. The document renders
`answer:hello`; the ordinary journal retains the reply and identity without raw
metadata. The same file drives `consumeTurn(...)` with real child responses and
checks its exact checkpoint callback, cancellation and failure.

Its reconnect example calls
`applySessionConfiguration(configurationTarget(runtime), { model: "selected", effort: "xhigh" })`
on the real runtime, closes the handle, ensures the retained session through a
new runtime and verifies the same configuration and identity. Both targets use
`runtime.getStatus({ handle })` and
`runtime.setConfigOption({ handle, key, value })`. No model service is called.

Run both examples:

```sh
deno task test packages/acp/tests/released-runtime.test.ts
```

The persistence consumer uses `createAcpxSessionStore(dir)` and
`retainedSession(store, key)` to read the second atomically published update,
and proves that an injected rename failure leaves the prior record readable:

```sh
deno task test packages/acp/tests/acpx-session-save.test.ts
```

## Common mistake

Waiting on `turn.promptStarted` proves only transport delivery. First-turn
creation ensures with `materialization: "first-turn-acceptance"` and waits on
`turn.materialized` before recording the host mapping or exposing events.
Cancellation acknowledgement also does not finish a turn. Releasing its handle
with `runtime.close(...)` joins promotion and turn cleanup before returning;
provider teardown uses that same boundary and retains accepted history.

A returned `_meta` is opaque adapter data, not permission to retain a checkpoint.
Only XMD's successful completed terminal can carry one. A real response recovered
during deadline drain can name its own turn; a missing response cannot.

## Read next

Read `vendor/acpx/PROVENANCE.md` for exact source and patch ownership,
`specs/acp-client-spec.md` for provider behavior and
`tests/acpx-materialization.test.ts` for held-save and failed-save evidence.
Whole-directory deletion remains conditional on a released replacement for the
materialization contract. Distribution and paid continuity gates remain delivery
work; deterministic tests do not establish those gates.
