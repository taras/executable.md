# Evidence: bundled workerd host (#347)

Answers to the spike's six questions, measured on macOS 15 (Darwin 25.5.0,
arm64), Deno 2.9.1, workerd 1.20260804.1, `@cloudflare/computer` 0.1.1, on
2026-08-05. Each claim marked **[test]** is asserted by
`tests/spike.test.ts`; claims marked **[measured]** were observed manually
and are reproducible from the commands shown.

## 1. Can `deno compile` include the Worker bundle, config, and workerd?

Yes. `--include vendor/workerd --include dist/worker.js --include
host/config.capnp` embeds all three; the compiled host reads them back
through `new URL(..., import.meta.url)` + `Deno.readFileSync` from the
embedded filesystem. **[test]** (every test drives the compiled binary).

- `workerd` ships on npm as five platform packages
  (`@cloudflare/workerd-{darwin-arm64,darwin-64,linux-64,linux-arm64,windows-64}`),
  one self-contained executable each, pinned by sha256 in `manifest.ts`.
  The five platforms match the five release targets in
  `scripts/lib/release-targets.ts` exactly.
- Linux binaries require glibc 2.35+; there is no musl build. macOS requires
  13.5+. Windows has no SIGTERM drain path in workerd (`#if !_WIN32`).
- Sizes **[measured]**: workerd binary 109 MB (macOS arm64; 114,566,712
  bytes); Worker bundle 283 KB; proof executable 191 MB total (116 MB
  embedded files + Deno runtime). The workerd tarball is ~32 MB gzipped, so
  a release that bundles per-platform workerd grows each artifact by
  ~30-40 MB compressed.

## 2. Can the compiled host materialize and supervise workerd alone?

Yes. The host materializes workerd into
`~/.cache/xmd-spike-347/<workerd-version>/` (content validated by sha256
before reuse and after every write), launches it with an ephemeral loopback
port, and supervises it as an Effection daemon. **[test]**

- Readiness and port discovery use one mechanism: `--control-fd=1` makes
  workerd print `{"event":"listen","socket":"http","port":N}` when ready;
  the config binds `127.0.0.1:0`. No polling, no fixed ports; concurrent
  invocations get distinct ports and never race. **[test]**
- A bare environment (`PATH=/usr/bin:/bin`, fresh `HOME`, so no Deno, Node,
  or Wrangler reachable) runs the whole cycle, including first-time
  materialization. **[test]**
- Timings **[measured]**: serve-to-ready 0.25 s warm cache; full
  do-cycle (spawn host → materialize → workerd up → HTTP op → teardown)
  0.27 s; 1.46 s when the 109 MB binary must first be written to cache.

## 3. Does Durable Object SQLite state survive restarts?

Yes. `durableObjectStorage = (localDisk = <DiskDirectory service>)` +
`enableSql = true` persists each object as
`<state-dir>/<uniqueKey>/<id>.sqlite` (+WAL/SHM) plus a per-namespace
`metadata.sqlite`. Counter state accumulates across full stop/start cycles
of both processes; a different state directory starts empty; a different
`idFromName` identity in the same directory is a different object; the
original identity still reads its own state afterward. **[test]**

- The state directory is supplied at launch with
  `--directory-path state=<abs>`; identity is deterministic
  (`idFromName`, uniqueKey `xmd-spike-347`).
- `localDisk` is marked **EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE
  CHANGE** in workerd's schema. It works without the `--experimental` flag
  today (we pass the flag anyway, as miniflare does), but the on-disk format
  is explicitly not a compatibility promise — a workerd upgrade may require
  a migration story. This is the proven mechanism miniflare/wrangler use for
  `.wrangler/state`, so breakage would hit the entire local-dev ecosystem,
  not just this host.

## 4. Does `@cloudflare/computer` build its filesystem Workspace here?

Yes. The pinned 0.1.1 constructs a filesystem-only Workspace from
`ctx.storage` via the `withWorkspace` mixin; `getWorkspace(stub)` reaches it
from the Worker. `mkdir`, `writeFile`, `readFile`, `readdir`, `rm` all work
through the Worker boundary, and the filesystem frontier — including a
create → delete → create sequence and a deletion — survives full restarts of
both processes. Every test op is a separate host process, so persistence is
exercised on every step. **[test]**

- Runtime requirements found: `nodejs_compat` compatibility flag; the only
  peer dependency actually loaded is `@platformatic/vfs` (`zod` and `ai`
  belong to the unused `./tools` subpath).
- The Workspace schema is versioned inside the DO SQLite (`vfs_meta.
  schema_version`); a newer package migrates forward, an older package
  refuses to open. Exact-version pinning is mandatory.

## 5. Which `workspace.runtime` backends work in standalone workerd?

| Backend | Verdict | Evidence |
| --- | --- | --- |
| worker shell | **works** | `echo hello` → `status: "completed"`, exit 0, stdout captured **[test]** |
| isolated JavaScript Worker | **works** | module executes, returns a value, and its `/workspace` writes land in the durable Workspace **[test]** |
| Cloudflare Container | **works** (local Docker daemon required) | `echo` in the container → completed, exit 0, stdout captured; bidirectional `/workspace` sync; frontier restored into a brand-new container after restart **[measured]** |

Both worker backends require, beyond the base slice: a `workerLoader`
binding in the workerd config (`config-backends.capnp`), the
`WorkspaceServiceProxy` class re-exported from the Worker module (the
backends reach the Workspace through the `ctx.exports` loopback binding),
and `waitUntil: ctx.waitUntil.bind(ctx)` in the `withWorkspace` options.
Each of those absences produced a precise, actionable error (recorded in
the git history of this spike); with no loader binding at all, Computer
reports `Workspace has no execution backend configured`.

The isolated JavaScript backend enforces Workers global-scope rules (no
I/O at module top level — the module must export a default function) and
confines paths to `/workspace`, which must exist in the Workspace
filesystem first.

The container backend works through workerd's
`containerEngine = (localDocker = ...)` ("local development and testing
purposes" per the schema) with a running Docker daemon. workerd itself
creates two containers per Durable Object: the workload (computerd as
PID 1) and an egress-interceptor sidecar. The exact artifacts that ran are
committed under [container/](container/) (Dockerfile, workerd config,
Worker wiring); they are not part of the default test suite because they
require Docker. Requirements discovered:

- `socketPath` must be a kj address string
  (`unix:/abs/path/docker.sock`); a bare path is DNS-resolved and fails.
- `containerEgressInterceptorImage` is mandatory and must already exist
  locally; Docker Hub's `cloudflare/proxy-everything` has no `latest` tag —
  pull `:main`.
- The `computerd` binary's release artifact is the GHCR scratch image
  `ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.0-alpha.1`
  (x64 only — runs under Rosetta on Apple Silicon); the guessed npm
  packages do not exist.
- The Worker must export `WorkspaceProxy` (the egress interceptor calls
  `ctx.exports.WorkspaceProxy`), hold a `CloudflareContainerBackend` on a
  `withWorkspaceContainer` base, and forward its DO `fetch` to
  `backend.handleFetch` — computerd dials back into the DO over a
  WebSocket the library never routes on its own.
- Exec selects this backend by **id** (default `container-shell`), not by
  its type string.
- computerd fell back to userspace-shim mode (no `/dev/fuse` in the
  container as configured); all operations worked regardless.
- Timings **[measured]**: image build 35 s (74.8 MB); cold container exec
  2.07 s; sub-second warm; restart-into-fresh-container 1.58 s with the
  full frontier restored from DO SQLite (`pushed: 3`).
- **Leak**: workerd leaked both containers on SIGTERM in every observed
  run — a host must reap `docker rm -f` its containers itself.

## 6. What is absent or different vs. deployed Cloudflare?

Local-only or absent in standalone workerd:

- **No hardened sandbox.** workerd's README states it does not contain
  defense-in-depth against implementation bugs; running possibly-malicious
  code requires an external sandbox (VM). Anything the local host executes
  has the user's OS privileges at one V8 bug's distance.
- KV, R2, Queues, Cache, D1, Analytics Engine bindings are protocol shells:
  the config maps them to services you must implement (miniflare implements
  them as simulator workers). None are configured in this spike.
- Containers exist only via a local Docker daemon; deployed Cloudflare
  Containers are a managed service.
- One process owns each Durable Object; there is no distribution, no
  eviction pressure comparable to production, and `localDisk` storage is
  experimental (see §3).
- Representative of deployed Cloudflare: the Workers JS surface, DO
  identity semantics (`idFromName`), DO SQLite storage API, and
  `@cloudflare/computer`'s Workspace schema and backend contracts.
  Local-only: persistence layout, supervision, port selection, teardown
  behavior, and every timing number in this document.

## Operational notes

- **Clean stop**: SIGTERM to the host tears down workerd (asserted with a
  liveness probe on the child pid). The supervisor must deliver the signal
  to the child pid explicitly: `@effectionx/process`'s own teardown
  (group-kill then await pipe EOF) never terminated workerd when the host
  exited normally, hanging both processes — the spike registers an
  `ensure` that SIGTERMs the child first. **[test]**
- **Forced termination**: SIGKILL of the host orphans workerd indefinitely;
  workerd does not exit when its control fd closes. A production host needs
  a kernel-backed tie (pidfd/kqueue watchdog, or workerd's `--socket-fd`
  with the parent owning the listener) or a startup reaper for stale pids.
  **[test]** (recorded as a contract, with manual cleanup asserted).
- **Startup failure**: an unusable state directory (a regular file) fails
  the launch; the host exits nonzero and surfaces workerd's stderr.
  **[test]**
- **Corrupt state**: not exercised; `localDisk` uses SQLite WAL, and most
  writes sit in the WAL at SIGTERM (replayed cleanly on restart in every
  observed run).
- **Config selection**: workerd 1.20260804.1 rejects the documented
  `serve <config-file> <const-name>` selection when two `Config` constants
  share a file ("you must specify which one" even when specified), hence
  two config files.
- **Upgrade behavior**: the cache directory is keyed by workerd version and
  the binary digest-checked, so a version bump materializes fresh files and
  never reuses a stale binary. State compatibility across workerd upgrades
  is governed by the experimental `localDisk` format (§3) and across
  Computer upgrades by `vfs_meta.schema_version` (§4).
- **Locking/concurrency**: not implemented — two hosts pointed at the same
  state directory would both open the same SQLite files. A real host needs
  a state-directory lock. Concurrent hosts on separate state directories
  work (ephemeral ports). **[measured]**
