# Comparison: Deno-local DOFS (#349) vs bundled workerd (#347 / PR #348)

Both spikes ran on the same host (macOS 15 arm64, Deno 2.9.1) against the
same pinned `cloudflare/computer` v0.1.1. #347 numbers come from
`spikes/347-workerd/evidence/EVIDENCE.md` on PR #348; #349 numbers from
[EVIDENCE.md](EVIDENCE.md).

| Axis | #349 Deno-local DOFS | #347 bundled workerd |
| --- | --- | --- |
| Runtime processes | one (Deno; plus a Node sidecar only if real FUSE is required) | two: xmd host + supervised workerd child |
| Artifact size | 110 MB proof (no extra runtime) | 191 MB proof (109 MB embedded workerd) |
| Startup / attach | 0.08 s full op cycle; no materialization step | 0.25 s serve-to-ready warm + 1.46 s first-run materialization of the 109 MB binary |
| Filesystem semantics | the DOFS filesystem API in-process; native subprocess access via shim (dev-only) or FUSE (Node sidecar; release-only durability, kernel-cache staleness ≤1 s) | the same DOFS filesystem behind the Worker boundary; native subprocess access only via the Container backend (Docker) |
| Execution backends | none of Computer's backends — exec is XMD's own process capability against the mount | all three Computer backends work (worker-shell, worker-javascript; container with Docker) |
| Platforms | linux-x64 proven; darwin-arm64: filesystem+shim only (FUSE dead end at this pin); linux-arm64 no addon prebuild; Windows: no FUSE at all | all five release targets have pinned workerd binaries; Linux glibc 2.35+, no musl; Windows lacks SIGTERM drain |
| Host prerequisites | none for filesystem+shim; `/dev/fuse` + libfuse2 (+ Node sidecar) for real FUSE | none for core; Docker for the container backend |
| Sandbox / security | none — DOFS code and subprocesses run with the host process's privileges | workerd isolates Worker JS but explicitly disclaims hardened sandboxing; native exec only inside Docker containers |
| Schema ownership / upgrades | identical schema, consumed at source (vendored 6.5k LOC, MIT provenance; 3-line upstream diff drafted as the exit) | identical schema, consumed through the published package (exact pin; refuse-on-downgrade) |
| Supervision | no child processes for the core path; FUSE adds mount lifecycle (auto_unmount proven; deadlock runbook recorded) | workerd child supervision (clean stop proven; SIGKILL orphans; container leak on SIGTERM) |
| Streaming / cancellation / retained exec handles | XMD's existing process capability (its own semantics) | Computer's `runtime.exec` handles (status/stdout/value round-trip proven) |
| Hosted-Cloudflare compatibility | filesystem layer byte-compatible; **no Durable Object identity, no Workers surface, no backends** — a local SQLite file is not a Durable Object | runs the actual published Computer package inside the actual Workers runtime — behaviorally closest to hosted |
| Migration / replication path | dofs ships its sync protocol helpers (`applyChanges`, manifests, watermarks) — the same protocol computerd speaks over capnweb; unexercised in this spike | same protocol, exercised end-to-end by the container backend's sync in #347 |

## What each topology is best at

**#349 wins on weight and directness**: a persistent SQLite Workspace with
Cloudflare's exact schema, in-process, 40% smaller artifact, ~3× faster
per operation, no child processes, no materialization cache, and identity
as simple as a database file path. The costs: no Computer execution
backends, no Workers isolation of any kind, a dev-only shim as the only
portable subprocess bridge today, and real FUSE gated on a Deno uv-polyfill
gap (upstream-ready repro committed) plus a Node sidecar in the interim.

**#347 wins on fidelity**: it runs the real published package in the real
runtime with all three backends, so anything proven there transfers to
hosted Cloudflare almost by construction. The costs: 81 MB of extra
artifact, a supervised child process with the recorded teardown gaps, and
Docker for anything native.

## Recommendation for #346

**Limit, not select-or-reject.** The evidence supports a split by concern:

1. For the *filesystem-only Workspace* — the substrate `<Workspace>` needs
   first — select the #349 topology: same schema, dramatically cheaper,
   no supervision surface, and the vendoring path is proven with a small
   upstream diff as its exit.
2. For *Computer execution backends* (worker-shell, worker-javascript,
   containers) — if and when #346 wants them locally — the #347 topology
   is the only one that provides them; keep it as the documented option
   for that subset rather than the default local host.
3. Treat native-subprocess workspace access under #349 as explicitly
   limited today: shim = development-only, FUSE = Linux with a Node
   sidecar until the Deno N-API uv gap closes (file it upstream) —
   and note that XMD's own exec against a mount is *not* behaviorally
   equivalent to Computer's backends.

Both spikes leave the door open to hosted Cloudflare through the same
sync protocol and identical schema; neither forecloses the other. The
final selection is recorded on #346.
