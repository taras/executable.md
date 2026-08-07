# probe-fuse-linux — real FUSE under Deno (issue #349 slices 3-5)

Date: 2026-08-06. Host: macOS (Apple Silicon), Docker Desktop.
Container: `fuse-probe:latest` = node:22-slim (amd64 under Rosetta) + `fuse` +
`libfuse2` (2.9.9-6+b1) + procps + curl + unzip + Deno 2.9.1 (linux x64).
Run flags: `--platform linux/amd64 --device /dev/fuse --cap-add SYS_ADMIN
--security-opt apparmor:unconfined -v <this dir>:/probe`.
Second container `qemuprobe2`: debian:stable-slim arm64 (native) + qemu-user +
fuse, same FUSE flags — used to run amd64 binaries under qemu-x86_64 instead of
Rosetta (differential, and because Rosetta cannot run deno-compiled binaries at
all; see Goal 5).

Stack under test: `FileSQLiteStorage(file db, WAL)` → dofs `Database` →
`initializeSchema` → `SQLiteWorkspaceProvider` → prototype-splice onto
`@platformatic/vfs` `VirtualProvider` → `create(provider, { moduleHooks:
false })` + `EXTRA_VFS_METHODS` forwarding (re-implemented from computerd
`src/fuse/vfs.ts` in `vfs-wiring.mjs`) → upstream `driver.ts`/`options.ts`
compiled verbatim with tsc → `mountFuse` → `/mnt/ws`.

## Per-goal verdicts

| # | Goal | Verdict |
|---|------|---------|
| 1 | Deno loads fuse-native N-API addon | **YES — loads perfectly. But `mount()` SIGABRTs the whole Deno process** (`bad result in uv polyfill: 1`), uncatchable, on deno run AND deno compile, v2.9.1 AND v2.9.4, under Rosetta AND qemu. Node 22 control mounts fine. Deno cannot *serve* FUSE via fuse-native today. |
| 2 | Full-stack mount | **PASS under Node 22 sidecar** (the only viable host). fuseMount 57 ms, whole stack up 118-133 ms. SQLite-backed proven (no silent MemoryProvider). `writeFileRangesSync` confirmed NOT forwarded. |
| 3 | Bidirectional + subprocess | **PASS**, with a ≤1 s staleness window for API overwrites of kernel-cached files (auto_cache + attr_timeout=1). cd-prefix exec works from the FUSE host; the spawn-cwd variant deadlocks the entire mount (demonstrated + forensics + recovery runbook). |
| 4 | Durability matrix | **Release-only commit CONFIRMED and sharpened**: fsync is a durability no-op AND the inode doesn't exist in the db until release; write+close is only durable once the *async* RELEASE op lands (kill 0 ms after close() → LOST; +500 ms → committed). |
| 5 | Compiled executable | **Addon loading from `deno compile` binary: YES both ways** (embedded npm graph require, and `--include` → materialize → `process.dlopen`). Mount: same uv-polyfill abort. Binary 142 MB. Rosetta cannot execute deno-compiled binaries at all (even hello-world) — measured under qemu-user. |
| 6 | Sizes/latencies | Table below. |

---

## Goal 1 — Deno + fuse-native N-API addon

```
docker exec fuseprobe sh -c 'cd /probe && deno run --allow-all g1-load.mjs'
```
→ `import("fuse-native")` through node-gyp-build resolves the prebuild and
returns the Fuse class: `ok: true, ms: 297.14, typeofDefault: "function"`,
full errno table + `beforeMount/beforeUnmount/configure/...` statics present.

```
deno run --allow-all g1-dlopen.mjs   # process.dlopen on prebuilds/linux-x64/node.napi.node
```
→ `ok: true`, 70 exports (`fuse_native_mount`, 35 signal fns, 35 op ids).
No LD_LIBRARY_PATH needed in-container: the prebuild's only non-libc DT_NEEDED
is `libfuse.so.2`, satisfied by apt `libfuse2`. (`fuse-shared-library-linux`
also ships its own `libfuse/lib/libfuse.so`, 939,064 B, for hosts without it.)

**But**: any actual `fuse.mount()` under Deno:

```
{"event":"constructing","mountPoint":"/mnt/ws"}
bad result in uv polyfill: 1
Aborted            # exit code 134 (SIGABRT)
```

- Reproduced: `deno run` 2.9.1, `deno run` 2.9.4, `deno compile` binary; under
  Docker Rosetta and under qemu-x86_64 → not an emulation artifact.
- Node 22.23.2 control with the identical script (`g2-min.mjs`): mounts in
  27 ms, `cat` works, clean unmount, exit 0.
- Attribution: the message comes from `assert_ok` in Deno `ext/napi/uv.rs` —
  it `std::process::abort()`s whenever a polyfilled uv init fn returns
  non-zero (`uv_mutex_init`, `uv_async_init`, ...). Deno's `uv_default_loop`
  polyfill **returns a null pointer**; fuse-native's `fuse_native_mount` uses
  `uv_default_loop` + `uv_async_init` + `uv_mutex_init` + `uv_sem_init/wait/post`
  (symbol scrape of the prebuild). A null loop into `uv_async_init` is the
  prime suspect for the non-zero result. Upstream issue material: minimal
  repro is `g2-min.mjs`; abort is pre-kernel (happens with or without a
  usable /dev/fuse once fusermount succeeds; with fusermount missing the
  mount fails earlier with a *catchable* "fuse: failed to exec fusermount").

## Goal 2 — full-stack mount (Node 22 sidecar)

```
node mount-host.mjs /probe/data/ws.db /mnt/ws
{"event":"mounted","runtime":"node v22.23.2", ...
 "sqliteProof":{"tables":["_vfs_fetch_cursor","_vfs_mounts","_vfs_watermark","sqlite_sequence",
   "vfs_blob_bytes","vfs_blobs","vfs_changes","vfs_chunks","vfs_dirents","vfs_manifests",
   "vfs_meta","vfs_nodes"],"proofFileFoundInTable":"vfs_dirents"},
 "forwarding":{"linkSync":"function","createFileSync":"function","writeRangeSync":"function",
   "truncateFileSync":"function","chmodSync":"function","readRangeSync":"function",
   "openWriteBufferSync":"function","openWriteBufferForCreateSync":"function",
   "releaseWriteBufferSync":"function","writeFileRangesSync":"undefined"},
 "timingsMs":{"vfsUp":57.73,"driverRequire":3.52,"fuseMount":56.59,"total":117.85}}
mount | grep fuse
/dev/fuse on /mnt/ws type fuse (rw,nosuid,nodev,user_id=0,group_id=0,max_read=524288)
```

- SQLite proof: vfs-facade write found in `vfs_dirents` via a **fresh**
  `node:sqlite` connection on the db file → prototype splice worked, no silent
  MemoryProvider fallback.
- `max_read=524288` in the mount table → the `_fuseOptions()` monkeypatch
  (options.ts profile) reached the kernel.
- **`writeFileRangesSync`: `undefined` at the driver boundary — confirmed.**
  driver.ts probes it but vfs.ts's EXTRA_VFS_METHODS omits it, so the ranged
  spill path is dead code. Harmless in practice: all direct-write probes
  (`createFileSync`/`writeRangeSync`/`truncateFileSync` + buffered-write trio)
  are forwarded, so `hasDirectWrites`/`hasBufferedWrites`/`hasDeferredCreate`
  are all true and `flushEntry` (the only `writeFileRangesSync` consumer) is
  bypassed for driver-created files.
- Gotcha found live: `makeFUSEOps(vfs, mountPoint)` uses the **mountPoint as
  the VFS namespace prefix** (kernel `/` → vfs `/mnt/ws`). The dir chain for
  the mountPoint must pre-exist in the vfs or every op — including getattr of
  the mount root — is ENOENT (`ls: cannot access '/mnt/ws'` while the mount
  table shows the mount). Fix: mkdir the chain through the vfs before mounting.
- node:sqlite on Node 22.23: works, prints `ExperimentalWarning: SQLite is an
  experimental feature`.

## Goal 3 — bidirectional + subprocess

| Test | Result |
|---|---|
| API write → `cat` via mount, new file | immediate (`from-api` readable right after `/write` returns; negative_timeout=0) |
| shell `echo > /mnt/ws/sub.txt` → API read | immediate (`from-shell` visible via WorkspaceFilesystem right after the redirect closes: close→flush… commit landed before the next process turn) |
| API **overwrite** of a file the kernel already cached | **stale ≤ ~1 s**: immediate `cat` returned old content, `cat` after 1.2 s returned new (auto_cache + attr_timeout=1) |
| exec with cwd inside mount, cd-prefix technique (from FUSE host itself) | works: `/exec?cwd=/mnt/ws&cmd=pwd && echo…` → stdout `/mnt/ws`, file visible via API in 0.21 ms |
| create / overwrite / `dd seek=100` / `truncate -s 10` / `mv` / `ln -s` (+readlink+read-through) / `mkdir -p` / `find` / `rm` | all pass (sparse.bin 104 B, ops.txt truncated to `v2-overwri`) |
| 2 × 200 concurrent `cat` loops | no failures |

### spawn-cwd-inside-mount deadlock (upstream runner.ts rationale) — demonstrated

`/exec-cwd?cwd=/mnt/ws` (execFile with `cwd:` option from the FUSE-serving
process) wedged the entire mount. Forensic snapshot (`ps -eo pid,stat,wchan`):

```
1178 Sl  pipe_read            node mount-host.mjs …   <- parent: event loop blocked in uv_spawn's exec-report pipe read
1313 S   request_wait_answer  node mount-host.mjs …   <- forked child, pre-exec chdir into own mount, waiting on a FUSE answer only the blocked parent can serve
1315 D   request_wait_answer  ls /mnt/ws              <- every other client: uninterruptible sleep, TERM-immune
```

- `timeout(1)`'s SIGTERM cannot kill the D-state readers; the docker execs hung.
- **SIGKILL of the host is NOT full recovery**: the forked child inherited the
  `/dev/fuse` fd, so the connection (and the wedge) outlived the host;
  `fusermount -u` → "Device or resource busy"; `fusermount -u -z` detached the
  mount table entry but left the D-state processes.
- Actual recovery: `mount -t fusectl fusectl /sys/fs/fuse/connections` then
  `echo 1 > /sys/fs/fuse/connections/<id>/abort` → all wedged processes
  released instantly. This is the runbook the spike should ship.

## Goal 4 — durability matrix

All checks by a separate process (`deno run -A probe.mjs <db> read <path>`,
fresh `FileSQLiteStorage` + `Database` on the db file). FUSE host: Node.

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
| a | write+close through mount → fresh-process read | **COMMITTED** | `a-file.txt` → `"a-committed\n"` |
| b | open, write, `fsync(fd)`, **no close**, kill -9 host | **LOST** — and the inode never existed in the db even *before* the kill (separate-process read: `no such file` while held open; same-process API *did* see the bytes via the in-process write buffer — deceptive!). fsync/flush are durability no-ops; `openWriteBufferForCreateSync` defers the INSERT to release. | `b-file.txt` |
| c | write+close, then kill -9 | **COMMITTED — IF the async RELEASE op landed.** close(2) returns after FLUSH; RELEASE is async. kill -9 **0 ms** after close → **LOST** (`race0.txt`, also `term.txt` with SIGTERM); kill **500 ms** after close → committed (`race500.txt`). | race harness |
| d | SIGTERM / SIGKILL mid-mount | Both: `auto_unmount` removes the mount within ~1 s; `ls /mnt/ws` on the (empty) underlying dir returns exit 0 — **no hang, no "transport endpoint is not connected"**. Caveat: not true when a forked child holds the fuse fd (see deadlock above). No unmount-time flush → WAL left. | mount table empty after each |
| e | second Deno process opens same db while mounted | **Works, read AND write** (WAL): `probe.mjs write` from a second process committed in 45 ms, immediately visible through the mount and the host API. No SQLITE_BUSY observed (short transactions). | `second-writer.txt` |
| f | kill -9 leaves `-wal`(1.1 MB)/`-shm`; next open? | **Recovers cleanly**: fresh open reads meta (rev 25, schema 5, journal_mode wal); after clean close the WAL is checkpointed (db 4 KB→106 KB, sidecars gone). | `probe.mjs meta` |

Net durability contract for the spike: **a write is durable only after
open-count→0 release AND its dofs transaction commit; close() returning is
not a durability barrier, and fsync lies.** A sync point must observe the db
(or drain releases), not the POSIX fd lifecycle.

## Goal 5 — `deno compile` binary

```
deno compile --allow-all --no-check \
  --include node_modules/fuse-native/prebuilds/linux-x64/node.napi.node \
  --include node_modules/fuse-shared-library-linux/libfuse/lib/libfuse.so \
  --output g5-bin g5-compiled.mjs        # Files: 32.28MB → binary 142,191,712 B
```

- **Environment landmine**: under Docker Desktop **Rosetta**, deno-compiled
  binaries do not run at all — `Inconsistency detected by ld.so: rtld.c: 1293:
  rtld_setup_main_map: Assertion 'GL(dl_rtld_map).l_libname' failed!` (and a
  hello-world compile segfaults, exit 139). Plain `deno` runs fine. Workaround
  used: run the amd64 binary in a native arm64 container via `qemu-x86_64 -L
  <amd64 sysroot>` (sysroot = container's /lib64 + /lib/x86_64-linux-gnu with
  ld.so symlink dereferenced, else qemu resolves the symlink against the wrong
  root).
- **Step A — embedded npm graph**: static `import Fuse from "fuse-native"` in
  the compiled binary **works**: the addon loads from the embedded graph,
  `typeof Fuse === "function"` at 0.16 ms into main.
- **Step B — `--include` + materialize + dlopen**: reading the two included
  files out of the binary VFS (`Deno.readFile(new URL(...))` → 68,072 B addon,
  939,064 B libfuse), writing to `Deno.makeTempDir()`, `process.dlopen` on the
  real-path copy: **works**, 70 exports, 34.7 ms into main.
- **Mount from the compiled binary**: with fusermount absent → catchable
  `Error: fuse failed` (never reached the uv path). With fusermount + /dev/fuse
  present → same `bad result in uv polyfill: 1` abort as `deno run`.
- Cold start: 1205 ms wall under qemu-user emulation for start → both load
  steps done (includes qemu startup; not representative of native — expect
  well under 200 ms native given `deno run` import was 297 ms un-warmed).

## Goal 6 — sizes & latencies

All timings under emulation (Rosetta for fuseprobe, qemu for qemuprobe2);
treat as relative, not absolute.

| Metric | Value |
|---|---|
| Image fuse-probe (node:22-slim + fuse + deno) | 503 MB |
| fuse-native package (with prebuilds) | 1.6 MB; addon `node.napi.node` 68,072 B |
| fuse-shared-library-linux | 3.1 MB; `libfuse.so` 939,064 B |
| node_modules total (incl. typescript+@types) | 34 MB |
| deno-compiled binary (2 includes) | 142 MB (embedded files 32.28 MB) |
| Deno `import("fuse-native")` | 297 ms |
| Full stack cold → mounted (Node) | 118-133 ms (vfsUp 58-72, require 3-4, fuseMount 57-58) |
| Minimal fuse-native mount (Node) | 27 ms |
| 100 small writes THROUGH mount | 225 ms → **2.25 ms/op** |
| 100 small writes direct dofs API (same process) | 110 ms → **1.10 ms/op** (mount overhead ≈ 2.0×) |
| 100 small reads through mount | 101 ms → 1.01 ms/op |
| Separate-process Deno probe (cold start + db open + 1 op) | 24-45 ms script time |

## Compile & environment fights (verbatim)

1. tsc on the upstream driver: **zero fights.** `driver.ts`, `options.ts`,
   `tracer.ts`, `backend.ts` compiled unmodified, first try, with computerd's
   own settings (`module nodenext`, CJS via package.json, `skipLibCheck`,
   `@types/node`). Sole accommodation: a hand-written `src/vfs.ts` type shim
   (driver.ts's import of it is type-only; the real vfs.ts drags in
   `@cloudflare/computer-rpc`). `fuse-native.d.ts` used as-is beside driver.ts.
2. `WorkspaceFsError: path exists: /workspace` — my wiring double-mkdir'd;
   guard with existsSync. (Proved en route that the facade dispatches to
   SQLiteWorkspaceProvider.)
3. `ls: cannot access '/mnt/ws': No such file or directory` *while mounted* —
   the mountPoint-as-vfs-prefix gotcha (Goal 2 above).
4. `sh: 1: time: not found` (slim image) — use `date +%s%N`.
5. `qemu-x86_64: Could not open '/lib64/ld-linux-x86-64.so.2'` — twice: once
   for missing sysroot (`-L`), once because `cp -a` preserved the ld.so
   symlink whose absolute target qemu resolved against the arm64 root; fix
   `cp -L`.
6. `pgrep -f "node mount-host.mjs"` matches the `sh -c` wrapper and the exec's
   own shell → killed the wrong processes twice (one `docker exec` died exit
   137). Match on the concrete node child instead.
7. After the fusectl mass-abort + ~15 zombies (pid 1 is `sleep infinity`,
   never reaps), `docker exec` on fuseprobe began failing (rc 255, empty) with
   the container still "running" — final size measurements taken from the host
   side of the bind mount instead.

## What the committed spike must replicate

1. **Topology**: FUSE service must live in a **Node sidecar process**;
   Deno cannot host fuse-native until the ext/napi uv polyfill gap is fixed
   (file upstream with the `g2-min.mjs` repro + `assert_ok`/null
   `uv_default_loop` attribution). Everything else — dofs API side, probes,
   supervisors — runs fine under Deno, and matrix (e) proves the shared-WAL
   two-process design: Deno main + Node FUSE sidecar over one db file works
   with immediate cross-visibility.
2. **The vfs wiring invariants**: prototype splice before `create()` (verify
   with a fresh-connection read of `vfs_dirents`, or you may be silently on
   MemoryProvider); forward the nine methods; pre-create the mountPoint dir
   chain in the vfs namespace. Decide whether to also forward
   `writeFileRangesSync` (today it's dead code by omission).
3. **Durability rules**: commit is at release only; `fsync`/`close` are not
   barriers; a durability-sensitive caller must wait for release + commit
   (observe the db) — and any "write then kill" path (worker recycling!) needs
   ≥ the close→release async window or an explicit drain.
4. **Exec rules**: `cd <dir> &&` prefix, never `cwd:` into the own mount; ship
   the recovery runbook (`fusermount -z`, then fusectl `abort` — SIGKILL alone
   leaves an fd-inherited wedge if any child was mid-spawn).
5. **Ops expectations**: ≤1 s staleness for API overwrites under the
   production option profile; auto_unmount reliably clears the mount on
   host death; WAL recovery on next open is clean.
6. **Packaging**: `deno compile` CAN carry and load the addon (both embedded
   npm graph and `--include`+dlopen) — the blocker is only the mount call, not
   distribution. Don't test deno-compiled binaries under Docker Rosetta.
