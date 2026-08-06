# Probe: issue #349 slice 6 — userspace shim (cf-computer `mountShim`) under Deno

Host: darwin-arm64 (Darwin 25.5.0), Deno 2.9.1, Node v-homebrew, 2026-08-06.
Working dir: `scratchpad/probe-shim`. Reuses `scratchpad/probe-dofs` (built dofs dist +
`file-storage.mjs` FileSQLiteStorage adapter). cf-computer v0.1.1 clone read-only.

## Setup / provenance

- `src/shim/shim.ts` — byte-identical copy of `cf-computer/packages/computerd/src/shim/shim.ts`
  (shasum `05e6a2ac…` matches). Compiled with `npx tsc` (typescript from npm, target ES2022,
  module NodeNext, ESM output) → `dist/shim/shim.js`. **Compilation did not fight: zero errors,
  zero edits to upstream source.**
- `src/fuse/vfs.ts` — type-only stub (`export type { VirtualFileSystem as NodeVirtualFileSystem }
  from "@platformatic/vfs"`), matching upstream vfs.ts's type alias. shim.ts imports only the type.
- `wiring.mjs` — hand-port of upstream `fuse/vfs.ts` runtime wiring. Deviations (full list):
  1. RPC surface dropped (SyncRPC / pullOnce / tick / startSyncLoop — not needed, imports
     unavailable).
  2. `SQLiteTestStorage` (in-memory) → `FileSQLiteStorage(dbPath)` (probe-dofs adapter, WAL).
  3. Provider options pass-through (upstream hardcodes defaults).
  4. ESM instead of CommonJS.
  `ensureVirtualProviderPrototype` (the prototype splice) and the `EXTRA_VFS_METHODS`
  defineProperty loop are ported verbatim.
- Blueprint correction: `EXTRA_VFS_METHODS` in v0.1.1 has **nine** entries, not ten
  (linkSync, createFileSync, writeRangeSync, truncateFileSync, chmodSync, readRangeSync,
  openWriteBufferSync, openWriteBufferForCreateSync, releaseWriteBufferSync).
- Confirmed the silent-fallback trap in `@platformatic/vfs@0.4.0` `index.js` `create()`:
  a provider that fails `instanceof VirtualProvider` and is a plain object is **reassigned as
  the options argument** and provider becomes undefined → `new VirtualFileSystem(undefined, …)`
  → `provider ?? new MemoryProvider()`. No error, no warning.

Deps installed in probe-shim: `npm i @platformatic/vfs@0.4.0 typescript @types/node` (clean).

## Q1 — does the shim run under Deno at all?

Command: `deno run -A exp1.mjs`

Result: **yes, first try, zero runtime failures.** No error output at any point.

- `vfs.provider instanceof MemoryProvider` → false; `vfs.provider === provider` → true;
  constructor name `SQLiteWorkspaceProvider`.
- Cross-process verification: wrote `/verify/marker.txt` via the vfs facade, read it back with
  a **separate Deno process** opening a fresh Database over the same db file
  (`probe-dofs/probe.mjs read`) → `{"op":"read","body":"sqlite-not-memory"}`. Not a
  MemoryProvider.
- `mountShim({ vfs, mountPoint })` (default pollIntervalMs 250) returned; watchAsync loop,
  setInterval poll, and node:crypto sha1 all work under Deno.
- First-shot latencies: VFS→disk 106 ms (provider's default 100 ms rev-poll watcher),
  disk→VFS 149 ms (within the 250 ms reconcile poll).

## Q2 — bidirectional visibility + latency

Command: `deno run -A exp2.mjs` (defaults: provider watchIntervalMs 100, shim pollIntervalMs 250;
2 ms detection poll; ~120–130 ms decorrelation sleep between rounds).

| direction | rounds (ms) | median (ms) | bound |
|---|---|---|---|
| VFS write → visible on disk | 104.7, 82.6, 81.0, 81.1, 78.6, 80.6, 81.6, 78.3, 78.9, 80.2 | **80.8** | provider rev-poll (100 ms) |
| disk write (separate `/bin/sh` process) → readable via vfs API | 205.7, 105.4, 106.4, 109.2, 107.5, 110.4, 104.3, 109.8, 110.3, 105.6 | **108.3** | shim poll (250 ms), phase-dependent |
| disk write → visible via fresh Database over the db file | 207.8, 106.7, 107.0, 110.4, 108.4, 111.7, 105.2, 111.3, 111.3, 106.8 | **109.4** | ≈ vfs visibility + ~1 ms (writes commit synchronously) |

Both directions are phase-dependent polling: worst case ≈ interval + walk cost. db-visibility
tracks vfs-visibility within ~1 ms because the reconcile's `vfs.writeFileSync` commits to SQLite
synchronously (fresh `FileSQLiteStorage` connection per check, WAL).

Native subprocess round-trip (`/bin/sh -c 'echo hi > sub.txt && cat other.txt'`, cwd = mount dir,
after `vfs.writeFileSync(other.txt)` + `shim.flush()`): success — `cat` printed the API-written
content, and `sub.txt` appeared in the VFS 88.5 ms later. The upstream flush()-before-exec
contract works as documented.

## Q3 — restart persistence

Upstream context: computerd's mountPoint is a **stable configured path**
(`MOUNT_POINT` env / `DEFAULT_MOUNT_POINT`, cli/computerd.ts:457,499) — the VFS namespace embeds
it, so restart re-mounts at the same path.

- Phase A (`exp3a.mjs`): fresh db, 100 files × 100 KB = 10,000,000 bytes across 10 dirs written
  via vfs (56 ms), `mountShim` boot materialisation 77 ms, disk tree verified (100 files/10 MB),
  unmount, close, **delete the whole on-disk mount dir**.
- Phase B (`exp3b.mjs`, new process): reopen db — frontier intact (100 files / 10,000,000 bytes
  readable via vfs before any mount). Re-mount at the same now-empty path:
  **materialisation of ~100 files / 10 MB took 78.9 ms**; disk tree reproduced exactly
  (100 files, 10 MB, 5/5 sampled sha1s match db content). `initializeSchema` on reopen does not
  wipe (idempotent).
- Trap demonstrated: mounting the same vfs at a **different** fresh mkdtemp path materialises
  **nothing** (`[]`) — VFS paths embed the mount prefix. A committed spike must keep the mount
  path stable across restarts (or migrate paths in the db).

## Q4 — documented limitations, demonstrated (`deno run -A exp4.mjs`)

| probe | result |
|---|---|
| symlink via vfs API (live target) | stays a symlink **in** the VFS (`lstatSync` → symlink); on disk it materialises as a **regular file containing the target's content** (`safeVfsStat` uses `statSync`, which follows the link) — not "absent" as naively expected, but the link-ness is lost |
| symlink via vfs API (dangling) | **absent on disk** (`statSync` throws → entry skipped) |
| symlink created on disk (live, `ln -s`) | reconciled into the VFS as a **regular file** with duplicated content (`walkDisk` uses `fsStat`, follows) |
| symlink created on disk (dangling) | **ignored** — never enters the VFS (ENOENT) |
| `chmod 755` on a synced disk file | **not reflected**: vfs mode stays 644 while disk shows 755; the shadow diff keys on (size, mtime) only |
| conflict, both sides write same path in one poll window (3 rounds, both orders) | **VFS wins 3/3** — both sides converge to the vfs-side content, including when the vfs write happened *first* and the disk write *last* |
| 50 MB file, new, disk→VFS | 283 ms |
| 50 MB file, 1-byte change, disk→VFS | **594 ms** (full re-read + sha1 + full SQLite rewrite) |
| 50 MB file, 1-byte change, VFS→disk | **654 ms** (full read from SQLite + full disk write) |
| 1 KB file, new / change, disk→VFS | 56 ms / 48 ms |
| steady-state `reconcileNow()` with unchanged 50 MB present | 0.7–2.2 ms (shadow (size, mtime) short-circuit works) |

## Q5 — kill -9 mid-activity (`deno run -A exp5.mjs`)

Worker (`exp5-worker.mjs`) mounted the shim and wrote on BOTH sides every 5 ms
(20 vfs-side + 20 disk-side files, round-robin). Parent SIGKILLed it at iteration 200.

- Post-mortem: WAL file 4,169,472 bytes pending; fresh connection `PRAGMA integrity_check` → ok
  (standard SQLite WAL crash recovery — no corruption).
- Divergence at death: 40 files present on both sides, **29 of 40 content-diverged**
  (writes in flight across the two poll seams).
- Restart + re-mount into the SAME dir: boot `materialiseVfsToDisk` overwrites disk with VFS
  content, first poll ticks pull disk-side extras; after 1.2 s **disk and VFS fully converged,
  0 mismatches**.
- Loss window (by design, demonstrated by the convergence direction): disk-side writes not yet
  polled into the VFS at crash time are **overwritten by the VFS copy on next boot** — up to
  `pollIntervalMs` (250 ms) of external writes can be silently lost across a crash. VFS-side
  writes are never lost (committed to SQLite synchronously before the watcher even fires).

## Q6 — darwin-arm64 real-FUSE record (`fuse-probe/`)

Host: darwin-arm64 (Apple Silicon), Darwin 25.5.0.

- `/Library/Filesystems/macfuse.fs` — **does not exist**.
- `/Library/Filesystems/osxfuse.fs` — exists (stale osxfuse 3.11.2 remnant) but has **no
  `configured` marker**, so fuse-shared-library treats it as unconfigured.
- `npm i fuse-native@2.2.6` → installs in 3 s, **no darwin-arm64 prebuild** (`prebuilds/` ships
  only `darwin-x64` and `linux-x64`). npm's allow-scripts policy on this host additionally
  blocked the `node-gyp-build` install script (`npm warn allow-scripts fuse-native@2.2.6`).
- Running `npx node-gyp-build` manually: **compiles from source successfully** (exit 0) —
  produces an arm64 `build/Release/fuse.node` linking only `/usr/lib/libc++.1.dylib` and
  `libSystem.B.dylib`.
- Loading: `require("fuse-native")` succeeds under **both Node and Deno** (createRequire).
  `Fuse.isConfigured` → **false**.
- The bundled userspace library `fuse-shared-library-darwin/osxfuse/libosxfuse.dylib` is a
  ppc_7400/ppc64/i386/x86_64 universal binary — **no arm64 slice**. Its `configure()` path
  untars an osxfuse 3.x bundle (kext-based; Apple Silicon requires reduced-security mode and
  macFUSE ≥ 4, so this can never work on this platform).
- Actual `fuse.mount()` attempt: **SIGSEGV (exit 139), no error surfaced**, identically under
  Node and Deno.
- Verdict for macOS-arm64: real FUSE via cf-computer's stack is a dead end — even with macFUSE
  installed, fuse-native 2.2.6's darwin support predates Apple Silicon. The shim is the only
  viable path on this platform. (macFUSE was NOT installed, per instructions.)

## Q7 — verdict

**Development-only fallback — suitable as exactly that, and it is the ONLY option on
darwin-arm64.**

For it (measured):
- Runs under Deno unmodified: upstream shim.ts compiled with zero edits, zero runtime failures.
- Latency is fine for interactive/dev use: ~81 ms VFS→disk, ~108 ms disk→VFS medians;
  subprocesses inside the mount see API-written files (after `flush()`) and their writes land
  back in ~90 ms.
- Restart persistence is real: SQLite frontier survives close + dir deletion; 100 files / 10 MB
  re-materialise in ~79 ms at the same mount path.
- Crash-safe at the storage layer: SIGKILL mid-activity → WAL recovery ok, remount converges
  fully in ~1 s.

Against production use (demonstrated, not speculative):
- Up to one poll window (250 ms) of **external disk writes silently lost** on crash, and VFS
  unconditionally clobbers concurrent disk writes (3/3 conflicts, both orders).
- Symlinks are silently degraded to content copies (or dropped when dangling) in BOTH
  directions; chmod invisible; no watch fan-out.
- Large files pay full re-read + full rewrite per change: ~0.6 s per touch of a 50 MB file on
  either side; scales linearly with size, not delta.
- The VFS namespace embeds the absolute mount path: a moved/renamed mount dir orphans the
  entire tree (materialises nothing).
- Everything is polling (provider rev-poll 100 ms + shim walk 250 ms): steady-state cost is
  fine (~1–2 ms/tick at this tree size) but grows with tree breadth, and correctness windows
  are timing-defined, not event-defined.

What a committed spike must replicate: the prototype splice + MemoryProvider-fallback
verification (the failure is SILENT), a stable absolute mount path, `flush()` before any exec
inside the mount, and the FileSQLiteStorage(WAL) adapter; and it must NOT rely on symlinks,
permissions, or sub-poll-window external-write durability.
