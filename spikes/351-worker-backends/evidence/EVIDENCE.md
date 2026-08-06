# Evidence: Worker Shell and Worker JavaScript in Deno (#351)

Measured on macOS 15 (Darwin 25.5.0, arm64), Deno 2.9.1, against
cloudflare/computer `v0.1.1` (`63d363632e558f7e077794988d36ed75017c2a62`) and
`just-bash@3.0.1`, on 2026-08-06. Claims marked **[test]** are asserted by
`tests/`; **[measured]** were observed directly; **[probe]** carry their
command-by-command ledger in `probes/`.

Both backends are **optional imperative extensions** over the declarative
durable core. Neither is a prerequisite for the Deno-local DOFS topology, and
neither backend's limits reject it.

## Verdicts

| Backend | Verdict | Basis |
| --- | --- | --- |
| **Worker Shell** | **include initially, scoped** | Runs natively; containment is architectural and was measured, not inferred; one availability hazard needs a boundary decision |
| **Worker JavaScript** | **defer** | The full contract works, but isolation depends on shipping compiled, and CPU-bound user code cannot be preempted |

## Worker Shell

Cloudflare's shell is the `just-bash` interpreter plus a filesystem adapter.
The adapter is vendored **byte-identical** (sha1
`c9ec5356d60ee7bc9aa3c5677320bf8c9aa4058c`) — it has zero `cloudflare:*`
imports, and its filesystem contract is a structural interface rather than an
RPC stub, which is the entire reason the backend ports. Everything Cloudflare
wraps around it — `WorkerEntrypoint`, `env.HOST.getWorkspace()`, the Dynamic
Worker loader — exists to reach a filesystem across an isolate boundary, and
is unnecessary when the workspace is in-process. The only new code is a
~60-line shim supplying `exists`/`statOrNull`/`lstatOrNull`, which on
Cloudflare come from the RPC stub.

**Works** **[test]**: a host `API.Fs` write is visible to shell execution and a
shell write is visible to the host, each across a full process restart;
pipelines, redirection (`>`, `>>`), exit status (`$?`, explicit `exit N`),
environment variables, cwd, stdout/stderr separation, and unknown-command
errors all behave; separate database paths are separate workspaces.

**Command set** **[probe]**: 83 registered built-ins (`cat`, `grep`, `sed`,
`awk`, `find`, `sort`, `tr`, `cut`, `head`, `tail`, `wc`, `cp`, `mv`, `rm`,
`mkdir`, `chmod`, `test`, …). This is an interpreter, **not** a process
launcher: there is no PATH resolution and no native executable can run
(`/bin/sh`, `id`, `uname` are all `command not found`) **[test]**. Absent:
`trap`, `yes`, `xargs -n`. Worker-backed commands (`js-exec`, `sqlite3`) need a
one-line `process.connected` prelude under Deno; `python3` remains unusable.

**Security — measured, not inferred** **[probe]**. With canaries planted on the
host filesystem and in the environment, ~50 escape attempts produced **zero
leaks**:

- Filesystem: `/etc/passwd`, `../../..` traversal, `find /`, `grep -r /` all
  resolve inside DOFS only; writes to `/tmp` and `/etc` land in the DOFS
  namespace and no host file was created **[test]**.
- Environment: fabricated (`OSTYPE=linux-gnu` on macOS, `uid=1000`, `pid=1`);
  the host environment is invisible.
- Native execution: none exists. The QuickJS `child_process.execSync` shim —
  the one plausible path — re-enters just-bash itself.
- QuickJS guest: no `Deno`, `Function` constructor blocked, `import("node:fs")`
  blocked, `require("fs")` is a workspace-scoped shim, `Atomics`/`WebAssembly`
  undefined.
- Network: off by default; when opted in, a strict prefix allowlist plus
  private/loopback rejection plus DNS-rebinding pinning — cloud-metadata IPs
  and `localhost` are denied even when allowlisted.

**Defense-in-depth**: just-bash ships its own `DefenseInDepthBox`, and
Cloudflare disables it because workerd cannot register ESM loader hooks. Under
Deno it must *also* be disabled: it is on by default and hard-fails
(`critical patches failed: Module._load`), aborting every exec. So the same
one-line opt-out Cloudflare already ships is required here — **and the
containment above holds without it**, because it is architectural: an injected
filesystem, a fabricated environment, and an interpreter with no process
launcher.

**The one real hazard is availability, not capability** **[probe]**. just-bash
executes synchronously: a 6.4 s CPU-bound loop starved the host event loop to
0 ticks of an expected 127 — the abort timer never fired, so `AbortSignal`
cancellation only works where the interpreter already awaits, and `while true`
spun 56 s at 102 % CPU unrecoverably. The in-isolate brake is
`maxCommandCount` (default 10 000).

**Boundary recommendation**: run the shell in a Deno Worker with the filesystem
as an async RPC proxy. The DOFS handle cannot cross (`structuredClone` →
`DataCloneError`), but the adapter's Promise-returning methods tolerate RPC
**unmodified** — 10/10 functional parity including symlinks, `chmod`, `sed -i`,
`grep -r`. Cost: 39.6 ms boot, ~0.04 ms per call (`echo` 0.27 ms vs 0.30 ms
in-isolate). Benefit: the host stays responsive and `worker.terminate()`
reclaims a wedged loop that is otherwise unrecoverable. The committed proof
runs in-isolate, which is why the hazard is stated rather than hidden.

## Worker JavaScript

Upstream's `WorkspaceRuntimeLoader` is Cloudflare's Worker Loader binding:
`load({ mainModule, modules })` over an in-memory specifier→source map. The
port replaces it with a Deno Worker.

**Module supply, without materialization** **[probe]**. A relative
`import "./dep.js"` does not resolve from a `blob:` or `data:` base — Deno
reports `invalid URL: relative URL with a cannot-be-a-base base`. Rewriting
each specifier to the dependency's absolute blob URL, in topological order,
loads the graph and survives `deno compile`. Static import maps are inherited
by workers but there is no per-Worker `importMap` option, so they cannot carry
a runtime-generated map. **Temp-dir materialization was never needed**, so its
coherence and cleanup costs are avoided rather than measured.

**Works** **[test]**: an entry module with a dependency runs in the isolate,
reaches DOFS through the capability bridge, separates stdout and stderr,
returns a result, and its write is committed — readable by a later process.
A thrown error becomes stderr plus exit 1 without failing the host. Output is
live-streamed, not batched (frames at 6/410/812 ms) **[probe]**. Cold
spawn→exit 13 ms; capability round-trip 0.065 ms **[measured]**.

**Isolation is adequate only in the compiled artifact** — the decisive caveat.
`permissions: "none"` governs Deno *ops*, not the *module loader*: under
`deno run`, a locked worker still executes `import("jsr:…")`/`import("npm:…")`,
pulling arbitrary third-party code and network egress that `net: false` does
not stop; the `import: false` permission is inert. `deno compile`'s frozen
graph closes this — `jsr:`/`npm:`/`https:` all become `Module not found`.
Host files and the environment are denied in both **[test]**. **A `deno run`
host must never be presented as a sandbox.**

**Two gaps** **[probe]**:

1. `Worker.terminate()` cannot preempt CPU-spinning user JavaScript. The
   timeout *outcome* is correct (1507 ms for a 1500 ms budget) but
   `terminate()` returns in 0 ms while the thread runs on, permanently
   blocking process exit. The missing primitive is Deno-side: **a CPU or wall
   budget on `new Worker(...)`, or a `terminate()` that interrupts running
   JavaScript**. Cloudflare's `limits.cpuMs` has no equivalent. The only
   faithful fix is an out-of-process worker that can be SIGKILLed, which
   forfeits the 13 ms cold start.
2. `compatibilityDate`/`compatibilityFlags` and retained execution
   (`getExec`/`resume`) are not expressible; a Deno Worker's lifetime is bounded
   by the host call. Upstream's shell backend has no retention either, so this
   only distances the JavaScript backend from hosted Cloudflare.

## Explicit refusal, never fallback

An operation the host does not install fails where it is called, at both
refusal points **[test]**: an operation the runner exposes but the host did not
install reports `unsupported filesystem op: <name>`, and one outside the
capability surface fails as `not a function`. The isolate has no path to host
execution, so there is nothing to fall back to — the property workflow mode
requires holds by construction.

## Compatibility matrix

| Dimension | Worker Shell (Deno) | Worker JavaScript (Deno) | Cloudflare (both, #347) |
| --- | --- | --- | --- |
| Execution | 83 interpreter built-ins; no native processes | arbitrary user ES modules | same, in a Dynamic Worker |
| Isolation | architectural (injected fs, fabricated env, no launcher) | Deno Worker; **compiled artifact only** | workerd isolate |
| Filesystem coherence | in-process, immediate, bidirectional **[test]** | async capability RPC, committed **[test]** | RPC to host DO |
| Streaming | buffered — upstream synthesizes frames after the run | live-streamed frames | same as each |
| Cancellation | only at interpreter await points; CPU loops unrecoverable in-isolate | terminate() works except on CPU spin | isolate disposal |
| Retention / reattach | none (upstream has none either) | none | JS backend only |
| Platforms | any Deno target | any Deno target | five workerd targets |
| Artifact size | 139.7 MB compiled proof (both backends + DOFS) | — | 191 MB (#347) |
| Startup / operation | shell exec 16-22 ms; fs op 2-5 ms **[measured]** | 13 ms cold spawn; 0.065 ms per capability call | 0.27 s warm op cycle (#347) |

## Source reuse and licensing

- `WorkspaceFsAdapter` — vendored byte-identical, **MIT** (Cloudflare), with
  provenance and upgrade procedure in `vendor/worker-shell/PROVENANCE.md`.
  This is the narrow seam the issue asked for: one file, no broad vendoring.
- `just-bash@3.0.1` — an ordinary npm dependency, **Apache-2.0**, from
  `github.com/vercel-labs/just-bash` (Vercel Labs, not Cloudflare). ESM entry
  256 KB.
- `@cloudflare/dofs` — the #349 vendored copy, built once and shared.
- Maintenance delta versus Cloudflare: the shell tracks one vendored file plus
  a public npm package; the JavaScript loader is our own ~300 lines against a
  12-line upstream interface, so upstream loader changes do not propagate.

**Upstream defects found** (affect Cloudflare equally): relative symlinks are
broken in `@cloudflare/dofs` itself (`ln -s t.txt link` →
`Invalid path (must be absolute)`; absolute targets work); a redirect to a
missing parent throws out of `bash.exec()` rather than returning nonzero — the
spike wraps exec as upstream's entrypoint does; `ls -l` reports a stale mode
because the adapter's `readdirWithFileTypes` carries none.

## Which `API.Process` semantics a Deno-local provider could claim

Claimable today: run a command string in a workspace-scoped shell; supply cwd
and environment; receive stdout, stderr, and an exit status; run a JavaScript
module graph with a workspace capability and a returned value; refuse anything
unsupported explicitly.

**Not** claimable: arbitrary native command execution (no launcher exists);
preemptive cancellation of CPU-bound work; live incremental streaming from the
shell; retained or reattachable executions; POSIX process semantics such as
signals, pipes to native processes, or a process table. A provider must not
describe the shell backend as native command execution.

See [COMPARISON.md](COMPARISON.md) for the topology comparison with #347 and
#349 and the recommendation for #346.
