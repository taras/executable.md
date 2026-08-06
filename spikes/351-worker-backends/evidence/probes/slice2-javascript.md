# Issue #351 slice 2 — Worker JavaScript in a Deno Worker isolate

Deno 2.9.1 (aarch64-apple-darwin), macOS 25.5.0. All artefacts in this directory.

## Verdict: **LIMIT** — portable, with two named gaps

A compiled Deno host **can** run Cloudflare's Worker JavaScript execution model
natively — no workerd, no Wrangler, no Docker, no Node-as-runtime. The full
contract (in-memory 2-module graph, DOFS capability, framed stdout/stderr,
result, error, timeout, cancellation) is proven end-to-end in `deno run` **and**
in a `deno compile`d binary, with identical output.

Two things do not port faithfully, both named precisely below:

1. **`Worker.terminate()` cannot reclaim a CPU-spinning worker.** The timeout
   *result* is correct but the *thread is leaked* and process exit is blocked.
   Missing Deno-side primitive: **a CPU/wall budget on a Worker, or a
   `terminate()` that interrupts running JS** — Cloudflare's `limits: {cpuMs}`
   has no Deno equivalent.
2. **`compatibilityDate` / `compatibilityFlags` have no Deno equivalent**, and
   **retained execution / reattach (`getExec`/`resume`) is not expressible** —
   a Deno Worker's lifetime is bounded by the host call.

Everything else — including isolation, which was the risk — holds, and holds
*better* in the compiled binary than under `deno run`.

---

## 1. Module-supply determination — THE core deliverable

**Answer: blob: URLs with host-side specifier rewriting. No disk
materialization is required.** `deno compile` does not break it.

### 1a. blob: URLs — `exp1a-blob.ts`

```
$ deno run -A exp1a-blob.ts
error: Uncaught (in worker "") invalid URL: relative URL with a cannot-be-a-base base
    at blob:null/cee6b145-74cb-4411-9bf1-49aa9a7a86a9:1:21
[1a-relative] ERROR: invalid URL: relative URL with a cannot-be-a-base base
[1a-absolute-blob] SUCCESS message: { dep: "dep-loaded" }
```

- A relative `import "./dep.js"` from a blob module **fails** — a `blob:` URL is
  a cannot-be-a-base URL, so there is no base to resolve against.
- Rewriting the specifier to the dependency's **absolute `blob:` URL before
  minting the entry blob** loads the 2-module graph and the worker runs. ✅

This is the mechanism used. It requires the loader to resolve and topologically
order the module map itself (`buildGraph` / `topoSort` in `loader.mjs`) — which
is exactly what Cloudflare's Worker Loader does internally for its `modules`
map, so the responsibility is not new, only relocated into our code.

### 1b. data: URLs — `exp1b-data.ts`

```
[1b-relative] ERROR: invalid URL: relative URL with a cannot-be-a-base base
[1b-absolute-data] SUCCESS: { dep: "dep-from-data" }
```

Identical behaviour to blob:. Works, but rejected in favour of blob: —
base64-in-a-URL bloats every module and the specifier is copied into every
importer, whereas a blob URL is a short opaque handle that can be
`URL.revokeObjectURL`'d for deterministic cleanup.

### 1c. Import maps — `exp1c-importmap.ts` + `importmap.json`

```
$ deno run -A --import-map=importmap.json exp1c-importmap.ts
[1c] SUCCESS: { dep: "dep-via-importmap" }
```

A **static** import map does let a blob-loaded worker resolve a *bare*
specifier to a `data:` URL — and it is inherited by the Worker. But there is
**no per-Worker `importMap` option** in Deno's `WorkerOptions`, and the process
import map is fixed at startup. So an import map cannot carry a *per-run*,
runtime-generated module map. Useful only if the set of bare specifiers is known
at build time. Not usable as the general mechanism.

### 1d. Temp-dir materialization — **not needed, not used**

Skipped deliberately: 1a succeeds, so the coherence/cleanup/security costs the
issue wanted measured (user code landing on the host filesystem outside DOFS,
crash-leaked temp files, two sources of truth) are **avoided entirely**. Blob
URLs live in the host isolate's object-URL table and are revoked on run
completion (`loader.mjs`, `finish()`). Nothing user-supplied touches disk.

---

## 2. Isolation — measured

Deno's `deno: { permissions: ... }` on a Worker requires
`--unstable-worker-options`; without it:

```
error: Unstable API 'Worker.deno.permissions'. The `--unstable-worker-options` flag must be provided.
```

### Under `deno run` — the ops layer holds, the module loader does not

`exp2-isolation.ts`, `exp2b-import-escape.ts`, `exp2d-trusted-host.ts`,
`exp2e-cache-bypass.ts`, `exp5-node-builtins.ts`, with `permissions: "none"`:

| Probe | Result |
|---|---|
| `Deno.env.get` | DENIED — `NotCapable: Requires env access` |
| `Deno.readTextFile("/etc/hosts")` | DENIED — `Requires read access` |
| `Deno.writeTextFile` | DENIED — `Requires write access` |
| `fetch()` | DENIED — `Requires net access` |
| `new Deno.Command("id")` | DENIED — `Requires run access` |
| `Deno.dlopen` | DENIED — `Requires ffi access` |
| `import("file:///…host-secret.mjs")` | DENIED — `Requires read access` |
| `import("http://127.0.0.1:…")` | DENIED — `Requires import access` |
| `import("https://esm.sh/…")` | DENIED — `Requires import access` |
| **`import("jsr:@std/uuid@1.0.4")`** | **ALLOWED — network fetch performed** |
| **`import("npm:is-odd@3.0.1")`** | **ALLOWED — network fetch performed** |
| **`import("https://…")` already in DENO_DIR** | **ALLOWED (`exp2e`, cold *and* warm)** |
| `import("node:fs")` then `readFileSync` | module ALLOWED, the *call* DENIED |
| `node:sqlite` open the DOFS db file directly | DENIED — `Requires read access` |
| `node:process.env.HOME` | DENIED — `Requires env access` |
| `node:os.userInfo()` | DENIED — `Requires sys access` |
| `node:net.connect` | DENIED — `getaddrinfo EPERM` |
| `node:vm.runInNewContext` | ALLOWED (no capability — harmless) |
| `node:worker_threads` | ALLOWED (no capability — harmless) |
| spawning a nested `Worker` | ALLOWED |

**Finding: `permissions` in `WorkerOptions` governs Deno *ops*, not the *module
loader*.** `jsr:` and `npm:` specifiers resolve and fetch from inside a
`permissions: "none"` worker — that is arbitrary third-party code execution and
unmetered network egress that `net: false` does not stop.

**`import: false` in the worker permissions object is inert** — `exp2d` ran the
same probe with `{read:false,write:false,net:false,env:false,run:false,ffi:false,import:false}`
and got byte-identical results to `"none"`.

*Measurement note:* an earlier pass reported these imports as DENIED. That was a
false negative — the probe did `String(moduleNamespace)`, which throws
`TypeError: Cannot convert object to primitive value` on a null-prototype module
namespace. `exp2b` re-probes correctly. (Per house guidance: make every sweep
fail once before believing it — this one silently inverted.)

### Under `deno compile` — the hole closes

`exp4-compiled-isolation.ts`, compiled to `isobin`:

```
{
  "jsr":    "DENIED: TypeError: Module not found: jsr:@std/uuid@1.0.4",
  "npm":    "DENIED: TypeError: Could not find a matching package for 'npm:is-odd@3.0.1' in the node_modules directory…",
  "https":  "DENIED: TypeError: Module not found: https://deno.land/std@0.224.0/version.ts",
  "nodeFs": "ALLOWED: function",
  "env":    "DENIED: NotCapable: Requires env access to \"HOME\"…",
  "read":   "DENIED: NotCapable: Requires read access to \"/etc/hosts\"…",
  "net":    "DENIED: NotCapable: Requires net access to \"example.com:443\"…"
}
```

`deno compile` freezes the module graph, so the loader has nowhere to fetch
from. The only reachable surface left is `node:` builtins, and every one of
those that carries a capability is ops-gated (table above).

**Conclusion: isolation is adequate *only in the compiled binary*.** Since the
shipping target is a compiled Deno host, this is acceptable — but it must be
stated as a hard constraint, because a dev-mode `deno run` host is *not* a
sandbox. Compared with Cloudflare, whose isolate has no module loader at all
after `load()`, Deno's guarantee is weaker in kind (it depends on graph freezing
rather than on the isolate having no I/O) even where it is equivalent in effect.

---

## 3. Capability bridge + full-contract proof

`loader.mjs` implements `createLoader({fsHandlers}).load({mainModule, modules})
.getEntrypoint().run({input, timeoutMs, signal})` — the same shape as
`WorkspaceRuntimeLoader`. Inside the worker the generated runner mirrors
`runtimeWorkerModule()`: fake `globalThis.process`, `console.log/info` → stdout
frame, `console.warn/error` → stderr frame, `globalThis.workspace` = the fs
capability, `user.default(input)` → `result` frame → `exit` frame.

The bridge is a postMessage request/response keyed by a sequence number
(`{kind:"fs-call", id, op, args}` → `{kind:"fs-reply", id, value|error}`). It
exists because the host owns the DOFS `DatabaseSync` handle, which is native and
**cannot be structured-cloned** into a worker.

Host wiring is the #349 setup verbatim:
`FileSQLiteStorage(dbPath)` → `new Database(storage)` → `initializeSchema(db, Date.now)`
→ `new WorkspaceFilesystem(db)` (`file-storage.mjs`, `proof.mjs`).

`proof.mjs` output (`proof-output.txt`; the compiled `proofbin` produces the
same, `compiled-output.txt`):

| # | Contract point | Result |
|---|---|---|
| i | entry imports a second in-memory module | `"entry sees dependency: dep-module-executed"` |
| ii | DOFS write + read-back through the bridge | `read back from DOFS: written-through-the-bridge:deno`; `readdir /work: ["note.txt"]` |
| iii | stdout **and** stderr | both captured, separately framed |
| iv | returned value → result frame | `{ok:true, roundTripped:…, dep:…}`, `exitCode: 0` |
| v | thrown error | `outcome:"exit"`, `exitCode: 1`, `stderr: "Error: user blew up"` |
| vi | `while(true)` vs 1500 ms timeout | `outcome:"timeout"` at 1507 ms; pre-loop stdout retained |
| vii | cancel mid-flight | `outcome:"cancelled"`; pre-cancel DOFS write survives — `/cancel: ["before.txt"]`, post-cancel write absent |

**Restart coherence** (`verify-restart.mjs`, separate process, fresh `Database`
over the same file):

```
/work: [ "note.txt" ]
/work/note.txt: written-through-the-bridge:deno
/cancel: [ "before.txt" ]
```

Writes made through the postMessage bridge are genuinely committed, and a
cancelled run leaves the workspace coherent because the host — not the worker —
owns the database.

---

## 4. Latency, streaming, size

- **Cold worker spawn → exit:** 13 ms (`deno run`), 15 ms (compiled).
- **fs-bridge round trip:** **0.065 ms/call** (`deno run`), 0.069 ms (compiled),
  over 200 sequential `readFile`s. Negligible.
- **Streaming is live, not end-of-run.** Frame arrival offsets from run start
  for a module logging every 400 ms: `stdout@6, stdout@410, stdout@812,
  result@1214, exit@1214`. postMessage frames arrive as produced, so
  Cloudflare's framed-stream behaviour is preserved.
- **Binary size:** baseline `deno compile` hello-world **68.4 MB**; the loader +
  vendored DOFS + its node_modules **107.7 MB** — a **+39 MB** delta, essentially
  all of it DOFS's `node_modules` (38.03 MB embedded). Compiling with
  `--include ./dofs/dist` was required; without the graph the binary cannot
  resolve the package.

## 5. The timeout leak — the smallest failing proof

`exp3-terminate-spin.ts`:

```
worker confirmed spinning; calling terminate()
terminate() returned after 0 ms
host event loop still responsive; elapsed 504 ms -- host exiting
EXITCODE=124        <-- `timeout 30` had to kill it
```

`exp3b-spin-leak.ts` confirms the host reaches the end of its main module and
**never exits**; only an explicit `Deno.exit(0)` frees it. `proof.mjs` carries
that `Deno.exit(0)` with a comment for exactly this reason.

So: `terminate()` returns immediately, the host stays responsive and reports the
correct `timeout` outcome, but the worker's OS thread is still executing user JS
— burning a core and pinning the process. Under Cloudflare, `limits.cpuMs`
terminates the isolate and reclaims it.

**Missing primitive (Deno-side): a CPU/wall-time budget on `new Worker(...)`, or
a `Worker.terminate()` that interrupts running JavaScript rather than only
detaching the handle.** There is no workaround inside the process; the only
faithful mitigation is running the worker in a separate OS process that can be
SIGKILLed, which reintroduces process-spawn cost per run and defeats the
13 ms cold-start number above.

---

## 6. Comparison with Cloudflare's `worker-javascript.ts`

| Aspect | Cloudflare Worker Loader | Deno port | Faithful? |
|---|---|---|---|
| Module access | native in-memory `modules` map, loader resolves | in-memory map → host-side specifier rewrite → blob: URLs | ✅ same idea, no disk |
| Relative specifiers | resolved by the loader | must be pre-resolved by us (blob = cannot-be-a-base) | ✅ equivalent, more code |
| Capability transfer | RPC stub on `host` object | postMessage request/response | ✅ 0.065 ms/call |
| Output | framed stream (`stdout`/`stderr`/`result`/`exit`) | same four frames over postMessage | ✅ live-streamed |
| Entry convention | `module.default` fn or value, awaited | identical | ✅ |
| Error | captured, exit 1, message on stderr | identical | ✅ |
| Cancellation | dispose/terminate + reject a race | `worker.terminate()` + reject a race | ✅ for I/O-bound; ❌ for CPU-bound (§5) |
| Timeout | host `setTimeout` race **+ `limits.cpuMs`** | host `setTimeout` race only | ⚠️ correct outcome, leaked thread |
| Isolation | isolate with no ambient I/O and no loader | ops permissions + frozen graph (compiled only) | ⚠️ compiled-only |
| `compatibilityDate` / `Flags` | first-class | **no equivalent** | ❌ not expressible |
| Retained execution / reattach (`getExec`/`resume`) | supported | worker lifetime is bounded by the host call | ❌ not expressible |
| Cold start | isolate spawn (sub-ms class) | 13–15 ms | ⚠️ ~10× slower, still fine |

---

## What a committed spike must replicate

1. `loader.mjs`'s `buildGraph` — topological sort of the module map plus
   specifier rewriting to absolute `blob:` URLs, and `revokeObjectURL` on run
   completion. This is the load-bearing mechanism.
2. The postMessage fs bridge and the host-side DOFS handler table, including the
   cancellation-coherence assertion (pre-cancel write survives, post-cancel
   write absent, verified from a **separate process**).
3. `--unstable-worker-options` must be on both the run and the compile command.
4. A test that the shipped binary denies `jsr:`/`npm:`/`https:` imports from the
   worker — this is the isolation guarantee and it exists **only** after
   compilation. A `deno run` dev host must not be presented as a sandbox.
5. An explicit acknowledgement of the CPU-spin thread leak: either a documented
   limitation, or a `Deno.exit` on host shutdown, or the out-of-process design.

## Commands run

```
deno run -A exp1a-blob.ts
deno run -A exp1b-data.ts
deno run -A --import-map=importmap.json exp1c-importmap.ts
deno run -A --unstable-worker-options exp2-isolation.ts
deno run -A --unstable-worker-options exp2b-import-escape.ts
deno run -A --unstable-worker-options exp2c-exfil.ts
deno run -A --unstable-worker-options exp2d-trusted-host.ts
deno run -A --unstable-worker-options exp2e-cache-bypass.ts
deno run -A --unstable-worker-options exp3-terminate-spin.ts
deno run -A --unstable-worker-options exp3b-spin-leak.ts
deno run -A --unstable-worker-options exp5-node-builtins.ts
deno run -A smoke-dofs.mjs
deno run -A --unstable-worker-options smoke-loader.mjs
deno run -A --unstable-worker-options proof.mjs ./proof.db
deno run -A verify-restart.mjs ./proof.db
deno compile -A --unstable-worker-options --include ./dofs/dist --output ./proofbin proof.mjs && ./proofbin ./compiled.db
deno compile -A --unstable-worker-options --output ./isobin exp4-compiled-isolation.ts && ./isobin
```

DOFS build: `cp -R spikes/349-dofs/vendor/dofs ./dofs && (cd dofs && npm install && npx tsc -p tsconfig.build.json)`.
`deno.json` maps `@cloudflare/dofs` → `./dofs/dist/index.js`.
