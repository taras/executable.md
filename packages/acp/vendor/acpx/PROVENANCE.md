# ACPX vendor provenance

`generated/` is the ACP runtime XMD executes: the runtime closure from npm
`acpx@0.21.1`, with the existing first-turn materialization contract ported to
the released session owner and a local strict explicit-resume backport from
upstream PR #925. The environment and metadata behavior are supplied by the released base.

- Repository: https://github.com/openclaw/acpx
- Release commit: `e6c782459a18a5b22d06210fde61d75003883ab0`
- Tag: `v0.21.1`
- npm tarball SHA-256: `d166c323dc77f02c610a79e34c1989e4f6880c0d61e9eda8cdcf5c5d26fccdda`
- npm integrity: `sha512-bLhRh53QgccVWoGZw34RYDDj1l6iT8lBm0cmBi5luQ+LGDjTqe0BwWH5t7/e8v+gYJS7mEWcgy+MwlfZrdssMQ==`
- Retrieved: 2026-10-30
- License: MIT, copied as `LICENSE` and in `THIRD_PARTY_NOTICES.md`.

The npm provenance subject matches the tarball SHA-512. Sigstore verifies its
certificate identity as
`https://github.com/openclaw/acpx/.github/workflows/release.yml@refs/tags/v0.21.1`,
issued by `https://token.actions.githubusercontent.com`, and verifies its
transparency proof. Its SLSA statement names the release commit above.

`upstream/` holds the exact published bytes of the nine-file runtime closure:
five JavaScript modules and four declarations. No CLI, flows, source maps or
nested package are carried. `MANIFEST.json` pins every byte and declares every
behavioral difference. `scripts/tests/acpx-vendor.test.ts` verifies it offline.

## Why the source closure remains

The released `agentProcessEnv` and request-local `_meta` transport are concrete
replacement seams for #566 and #629. They do not replace #648: `promptStarted`
acknowledges a writable transport, not backend acceptance. An unaccepted session
must assert no conversation, and the provider must be able to wait for the
asserting save before committing its host mapping.

The relative runtime import also resolves under the repository's cached-only,
no-node-modules build and release compile. dnt includes it in the npm artifact.
Only `src/acpx-runtime.ts` reaches the closure; its types come from that same
closure. The ordinary published dependency supports independent client probes.

## Materialization patch (#648)

`ensureSession({ materialization: "first-turn-acceptance" })` persists occupancy:
`sessionMaterialization` says pending and `agentSessionId` is absent. The
released session owner privately holds the provisional identity. Pending records
are never reused, so a retry creates fresh backend state.

The exact update metadata
`{"executablemd.session-materialization/v1":{"state":"accepted"}}` on an ACP
`session_info_update` promotes that record. The runtime consumes this control
update before conversation recording and event publication. No text, status,
terminal response, checkpoint, transport acknowledgement or diagnostic promotes.

Promotion shares the session owner's live-checkpoint exclusion. It saves an
asserting copy first, adopts the identity in memory while still holding that
exclusion, then resolves `turn.materialized`. Finalization joins promotion
before its checkpoint. A failed save leaves memory pending. An ending with no
acceptance rejects the barrier, and the runtime observes that rejection for
consumers that only use `runTurn()`. An already asserting session satisfies the
barrier immediately. The local seam applies to `createAcpRuntime()`, which is
the runtime XMD uses; the released shared/queue runtime is not an XMD provider.

Handle close requests cancellation and joins the existing per-record turn queue
before releasing ownership. The join precedes the manager lock because turn
finalization needs that same lock. Close still attempts resource cleanup when a
turn task fails and reports the failure. Provider teardown therefore includes an
accepted promotion's save and finalization; no identity publishes after it ends.

| Module | Materialization change |
| --- | --- |
| `runtime.js` | Deferred ensure, owner-private provisional identity, consumed acceptance, joined promotion and waitable turn barrier. |
| `queue-owner-runtime-B0mPqOu4.js` | `LiveSessionCheckpoint.runMaterializationExclusive()` excludes checkpoint saves during promotion. |
| `ipc-BbYFsKOj.js` | Read and write the existing `session_materialization` disk marker. |
| `runtime.d.ts`, `session-options-BlnP3WAc.d.ts` | Declare the ensure input, barrier and pending record. |

## Strict explicit-resume backport (#925)

This interim local patch ports the reviewed behavior of
[upstream PR #925](https://github.com/openclaw/acpx/pull/925), commit
`12fcca9ffc1417838b20b26e35518f38c8292a0c`, on upstream source base
`6ce38c34f4e5aef16bf28ca8b1fb1e6650695c60`. It is not part of the integrity-verified
0.21.1 release recorded above. The pristine `upstream/` closure stays unchanged;
no unreleased build replaces the published closure.

An explicit `resumeSessionId` constrains the existing record before a handle is
returned. Later cold prompt and control reconnects refuse a failed load before
creating a replacement or dispatching the requested operation, including the
otherwise permitted unprompted-record `-32603` fallback. Compatible attachment
retains history, creation and event-log association, immutable session options
and saved model/effort when the caller omits settings.

The constraint belongs to the in-process manager, keyed by its existing record
ID. Older handles, untargeted aliases and ordinary close cannot relax it. A new
runtime must receive the explicit target again. First adding the constraint
during unfinished untargeted work returns the existing busy refusal; an already
strict compatible ensure remains available during active work. Independent
untargeted records retain fallback. Explicit preparation permits a genuinely
fresh arrangement, which clears the old constraint only after successful fresh
creation. No public parameter, persisted field or identity protocol is added.

`runtime.js` holds the record constraint and passes it to both reconnect paths.
The existing reconnect and connected-session owners are bundled in
`queue-owner-runtime-B0mPqOu4.js`; that module propagates the private
`strictResume` flag and excludes fresh recovery. `runtime.d.ts` declares the
private set and documents the existing ensure field. The generated patch follows
the reviewed source algorithm; a local comment explains the exceptional fallback
and a declaration comment names the seam for Tier AV's locality check. The
materialization, promotion, checkpoint exclusion and joined-close code remains
unchanged.

Remove this backport only when an integrity-verified published artifact supplies
the reviewed strictness and passes the same prompt/control, alias, configuration
and admission regressions. That release qualification is separate from retiring
the materialization patch or the vendor closure.

## Released environment seam (#566)

The released runtime snapshots `agentProcessEnv`, delivers it to every child and
never persists it or mutates the parent. No local environment patch remains.
Released protected authentication values outrank both session and transient
overlays; the executable binding key `CLAUDE_CODE_EXECUTABLE` is not an
authentication key and still outranks a session value. Real-child controls
verify that binding, authentication precedence, construction-time snapshot,
sibling isolation, absence and non-retention.

## Released metadata seam (#629)

The released runtime carries the exact response's own `_meta`, including a
response recovered during timeout drain. It never invents metadata from session
updates. No local metadata transport or cancellation-filter patch remains.
Released cancelled results may carry their response metadata. XMD preserves its
checkpoint boundary explicitly in `src/checkpoint.ts` and `src/events.ts`: a
cancelled or failed terminal never acquires a checkpoint, whatever raw metadata
the runtime returned. A deadline without a response fails rather than
reconstructing a success from session updates.

## Session writer (#933)

The released store publishes from private staged temporary files. The
deterministic same-millisecond overlapping-rename witness fails with ENOENT on
the old writer and passes on this writer, preserving the second publication.
Injected I/O failures still fail. This establishes the demonstrated collision
defect, not the cause of the historical live incident. No writer patch is added.

## Packaging adaptations and maintenance

Sibling declaration imports name their colocated `.d.ts` files; source-map
references are removed; every generated file ends in a newline. Undoing those
adaptations reproduces every otherwise unpatched upstream file exactly.

Refresh only from an exact integrity-verified npm artifact. Copy its transitive
runtime closure into `upstream/`, apply the declared local changes to
`generated/`, refresh the manifest and run Tier AV plus the behavioral tiers.
The environment and metadata adaptations are retired independently.
Keep the materialization patch and packaging exceptions until a released API
preserves explicit backend acceptance, non-asserting occupancy and the joined
asserting-save barrier. Two released seams never authorize deleting that third
contract or the complete vendor directory.
