# Evidence: Deno-local DOFS (#349)

Answers to the spike's eight questions, measured on macOS 15 (Darwin
25.5.0, arm64), Deno 2.9.1, cloudflare/computer `v0.1.1`
(`63d363632e558f7e077794988d36ed75017c2a62`), 2026-08-06. Claims marked
**[test]** are asserted by `tests/spike.test.ts`; **[measured]** were
observed and are reproducible from the commands shown; **[probe]** carry
their full command-by-command ledger in `probes/`.

## 1. Does a file-backed `node:sqlite` adapter satisfy DOFS's contract?

Yes, with zero changes to Cloudflare's schema or filesystem primitives.
The whole contract is `{ sql.exec(query, ...bindings) → { toArray() },
transactionSync }`; `host/file-storage.ts` implements it over
`new DatabaseSync(path)` in ~100 lines, mirroring upstream's own
`SQLiteTestStorage` fixture (which is `:memory:`-only). **[test]**

- `mkdir`, `writeFile`, `readFile`, `readdir`, `stat`, `lstat`, `rename`,
  `symlink`, `readlink`, `rm` all work through Cloudflare's unmodified
  `Database` → `initializeSchema` → `WorkspaceFilesystem` stack; `readFile`
  follows symlinks, `lstat` reports the link. **[test]**
- The filesystem frontier survives full process restarts — every test op is
  a separate compiled-binary invocation — including deletion persistence and
  a create → delete → create sequence. **[test]**
- Separate database paths are separate, initially-empty workspaces. There is
  no Durable Object identity layer in this topology: the database file path
  *is* the workspace identity. **[test]**
- Schema safety: `initializeSchema` is idempotent (IF-NOT-EXISTS DDL) and is
  itself the version gate — a database stamped with a newer
  `vfs_meta.schema_version` is refused loudly
  (`Unsupported workspace filesystem schema version 99`), not recreated;
  the failed open leaves the database untouched. `SCHEMA_VERSION` is 5.
  **[test]**
- WAL mode: `-wal`/`-shm` exist only while open; `close()` checkpoints and
  removes them, leaving a single-file artifact. **[test]**
- `node:sqlite` under Deno needed no workarounds: `DatabaseSync`, prepared
  statements, and transactions all behave; dofs's own row normalization
  handles the null-prototype rows. **[probe]**
- Sizes and timings **[measured]**: compiled proof 110 MB (no workerd, no
  Worker bundle, no materialization step); full op cycle
  (process start → op → close) 0.08 s wall, 14 ms in-process on a cold
  database; upstream build of the vendored package is a clean plain `tsc`.

## 2. Which reuse boundary works?

Tested independently **[probe: probes/slice2-reuse.md]**:

| Approach | Works? | Upgrades | MIT notices | Cloudflare code owned |
| --- | --- | --- | --- | --- |
| 1. Direct import of published `@cloudflare/computer@0.1.1` | **No** — `dist/index.js` unconditionally imports `cloudflare:workers` (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); deep imports blocked by the exports map; no `cloudflare:`-free DOFS chunk exists in dist | — | none | zero |
| 2. Tree-shaken bundle of the published package | **No (structurally)** — one stub silences `cloudflare:workers`, but the published surface never exports `Database`/`initializeSchema`/`WorkspaceFilesystem`, so the schema DDL is not even present in the bundle | re-bundle + re-prove stubs per release | bundle must carry LICENSE | stubs + reimplemented schema DDL |
| 3. Pinned vendored `packages/dofs` | **Yes, fully** — clean `tsc` build, zero runtime deps, source unmodified; consumed as a `file:` npm dependency through its exports map | re-vendor from tag, re-apply 3 manifest edits, rebuild, re-run tests | copy root LICENSE + provenance note (no per-package license upstream) | 48 files / ~6.5k LOC (src minus tests) |
| 4. Upstream export change | **Proven mechanically** — a 3-line upstream diff (re-export module + bundler input + exports entry) yields a DOFS chunk whose module graph imports only `node:crypto`/`node:events`; verified under Deno | `npm i` once accepted | none | zero after acceptance |

The spike ships approach 3 (`vendor/dofs/` + `PROVENANCE.md`), with
approach 4 drafted in the probe ledger as the exit path — the vendored copy
keeps the `@cloudflare/dofs` specifier, so landing the upstream change
reduces to a dependency swap. This slice satisfies "the exact supported
code-reuse mechanism is demonstrated": vendoring is the only mechanism that
works today, and its obligations are notice retention plus a
three-edit-manifest upgrade procedure.

## 7. Userspace shim — verdict: development-only fallback

Separate from the real-FUSE verdict (§3-6), per the spike's terms. Upstream's
`shim.ts` runs under Deno **byte-identical, zero runtime failures** — it is
vendored as a subset package (`vendor/computerd-shim/`, provenance +
sha1), and a compiled `proof-shim` executes a native subprocess that reads
an API-written file through the mount and writes back into SQLite, and
rematerializes an emptied mount directory from the persisted frontier.
**[test]** Full ledger: `probes/slice6-shim.md`.

Measured (medians over 10 rounds, default 100 ms provider watch / 250 ms
shim poll) **[probe]**:

| Direction | Median |
| --- | --- |
| VFS API write → visible on disk | 80.8 ms |
| external disk write → visible via API | 108.3 ms (worst 205.7 ms) |
| external disk write → committed in SQLite | 109.4 ms |
| rematerialize 100 files / 10 MB | 78.9 ms |
| 50 MB file, 1-byte change, reconcile | ~600 ms each way (full re-read) |

Demonstrated losses: conflicts within a poll window resolve **VFS-wins**
(3/3 both orders); symlinks degrade to content copies on both sides
(dangling links dropped); chmod is invisible; after SIGKILL the WAL
recovers and convergence completes in ~1 s, but up to one poll window
(250 ms) of external disk writes is silently clobbered by the VFS copy.
Two integration facts a host must honor: the mount path is embedded in the
workspace namespace (the same database mounted at a different absolute path
materializes nothing), and `@platformatic/vfs`'s `create()` silently falls
back to a MemoryProvider unless the prototype splice is verified
(`host/vfs-wiring.ts` guards this explicitly).

Verdict: viable as a **development-only fallback** — sub-poll-window
durability, symlink/metadata fidelity, and large-file costs disqualify it
as a supported production path. On darwin-arm64 it is currently the *only*
path (see §4/§5 platform record).

## 3.-6. FUSE bridge, packaging, durability

Pending in this revision — recorded when the corresponding slices land.
Blueprint facts already established from source
(cloudflare/computer@v0.1.1):

- The FUSE adapter is `makeFUSEOps(vfs, mountPoint)` — one 1092-line file
  whose only dependency is a `@platformatic/vfs` instance; `fuse-native@2.2.6`
  (libfuse 2.9 API) with prebuilds for linux-x64 and darwin-x64 only — no
  darwin-arm64, no linux-arm64 addon prebuild.
- Wiring `SQLiteWorkspaceProvider` into `@platformatic/vfs` requires two
  upstream hacks replicated verbatim: a prototype splice (vfs's `create()`
  silently falls back to a MemoryProvider on an instanceof failure) and
  explicit forwarding of ten dofs-specific sync methods onto the vfs facade.
- The FUSE write-commit boundary is **release-only**: dofs's write buffer
  commits when the open count reaches zero; `flush` and `fsync` are
  durability no-ops in the production configuration.
- The darwin-arm64 platform record **[probe: probes/slice6-shim.md]**:
  `fuse-native@2.2.6` ships no darwin-arm64 prebuild; a manual source build
  produces an arm64 addon that loads under Deno and Node, but its bundled
  `libosxfuse.dylib` carries no arm64 slice (kext-era osxfuse 3.x) and an
  actual mount SIGSEGVs under both runtimes; macFUSE is not installed on
  this host (`/Library/Filesystems/macfuse.fs` absent). Real FUSE on Apple
  Silicon is a dead end at this pinned version even before the
  macFUSE-install/kernel-approval prerequisite.

## 8. Comparison with #347

Recorded in `COMPARISON.md` when slices 3-7 land. Already firm from slices
1-2: 110 MB vs 191 MB artifacts; 0.08 s vs 0.27 s warm op cycles; no
materialization step vs a 109 MB binary cache; no process supervision at
all for the filesystem-only path vs workerd child management; schema
ownership identical (same DOFS schema, same versions) — which is also the
future migration path claim to examine.
