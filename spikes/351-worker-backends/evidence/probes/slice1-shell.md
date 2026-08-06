# Probe: Worker Shell natively in Deno over Deno-local DOFS (#351 slice 1)

**Verdict: ADOPT** — Cloudflare's Worker Shell runs natively under Deno over the
Deno-local DOFS workspace with no workerd, no Wrangler, no Docker and no Node as
runtime. The `WorkspaceFsAdapter` is reused **verbatim**. Three Deno-specific
defects were found, root-caused and fixed/characterised; none is a blocker for the
core shell.

Environment: Deno 2.9.1 (stable, aarch64-apple-darwin), macOS 25.5.0. Node 26.5.1
present only as a comparison oracle for one node-compat probe — never as a runtime
for the shell.

## Provenance / version facts

| Artifact | Fact |
| --- | --- |
| `just-bash` | `3.0.1`, `sha512-YVyzCN08fKarUnwqy7rKOAcX+2MLYLnYInuowmUXn3mqhrtd4ieZNBuzdQG+qYV9DqnIWuv9Whiph0WRIWsBtw==` (npm tarball integrity) |
| just-bash origin | `github.com/vercel-labs/just-bash`, Apache-2.0, author "Malte and Claude" — **a Vercel Labs package, not a Cloudflare one** |
| `dist/bundle/index.js` (ESM entry) | sha256 `565b3d15a9b77e0dc77a7ec041f149a06f7aa304155a9509d61231027abec4e5`, 256 124 bytes |
| `dist/bundle/browser.js` (browser entry) | sha256 `0bf49f45d9cb3299e24fd3e98ba4cc9076469e0b727bf6193a58a86fbebcc12c`, 1 098 224 bytes |
| `adapter.ts` (copied verbatim from cf-computer) | sha1 `c9ec5356d60ee7bc9aa3c5677320bf8c9aa4058c`, 355 lines, unmodified |
| `quickjs-emscripten` | 0.32.0 |
| `sql.js` | 1.14.1 |
| DOFS | vendored `@cloudflare/dofs` 0.0.0 from `spikes/349-dofs/vendor/dofs`, built with `npx tsc -p tsconfig.build.json` |

`just-bash` package export map has `"browser": "./dist/bundle/browser.js"` and
`"./browser"` subpath — a browser build exists (1.07 MB single file, `node:dns`
aliased to a stub).

## Wiring actually used

```
FileSQLiteStorage(dbPath)            # node:sqlite DatabaseSync, WAL — from spikes/349-dofs
  -> Database(storage)
  -> initializeSchema(db, Date.now)
  -> WorkspaceFilesystem(db)
  -> WorkspaceFsShim                 # adds exists/statOrNull/lstatOrNull (see below)
  -> WorkspaceFsAdapter(shim)        # Cloudflare's file, verbatim
  -> new Bash({ fs, cwd, defenseInDepth: { enabled: false }, executionLimits })
```

`WorkspaceFsShim` (`workspace.ts`) is 3 real methods of work: DOFS's
`WorkspaceFilesystem` has no `exists`/`statOrNull`/`lstatOrNull` (Cloudflare's
`WorkspaceFilesystemStub` adds them on the RPC host side). `statOrNull = try stat
catch null`; `exists = statOrNull !== null`. Everything else forwards 1:1.

Nothing from `cloudflare:workers` is needed. `WorkerEntrypoint`, `env.HOST.getWorkspace()`
and the RPC framing are all removed, exactly as the established seam predicted.

---

## Goal 1 — Load + run

`import { Bash } from "just-bash"` resolves under Deno via `nodeModulesDir: "manual"`
+ `npm i --install-links`. No import shims, no remapping.

```
$ deno run -A --node-modules-dir=manual p1-load.ts /tmp/p1.db did-false
{ "result": { "stdout": "hello\n", "stderr": "", "exitCode": 0, ... },
  "timings_ms": { "openWorkspace": 2.54, "bashCtor": 8.21, "firstExec": 14.03, "secondExec": 0.57 } }
```

### DEFECT 1 (blocker if unhandled) — `defenseInDepth` is ON BY DEFAULT and hard-fails under Deno

`defenseInDepth: { enabled: true }` **and the default (option omitted)** both abort
every `exec`:

```
[DefenseInDepthBox] Could not patch process.report: Cannot redefine property: report
[DefenseInDepthBox] Could not protect Module._load: Cannot read properties of null (reading 'constructor')
[DefenseInDepthBox] Could not protect Module._resolveFilename: Cannot read properties of null (reading 'constructor')
[DefenseInDepthBox] Could not patch process.execPath: Cannot redefine property: execPath
error: Uncaught (in promise) Error: DefenseInDepthBox: critical patches failed: Module._load
    at applyPatches (node_modules/just-bash/dist/bundle/chunks/chunk-TN7HHBQW.js:4:8337)
    at activate  (…chunk-TN7HHBQW.js:4:2973)
    at Ft.exec   (node_modules/just-bash/dist/bundle/index.js:700:832)
```

**Fix: pass `defenseInDepth: { enabled: false }`.** This is the *same line*
Cloudflare already passes for workerd, for a different underlying reason (workerd's
`node:module.registerHooks` throws "not implemented"; Deno's `node:module` has no
`Module._load` to patch at all). The committed spike must carry this line and a
comment saying it is load-bearing on **both** targets. Security impact is analysed
in Goal 5 — measured answer: none.

---

## Goal 2 — Bidirectional coherence + restart across processes  ✅ PASS

Process 1 (`p2-coherence.ts … write`):

```
cat a.txt (API wrote it)   exit=0  stdout="written-by-api\n"
echo written-by-shell > b.txt  exit=0
  API readFile(/workspace/b.txt) = "written-by-shell\n"
  API stat size=17 mode=644
```

Process 2 — **a fresh Deno process against the same db file**, host "restart":

```
cat b.txt after restart  exit=0  stdout="written-by-shell\n"
cat a.txt after restart  exit=0  stdout="written-by-api\n"
ls -la                   exit=0  -rw-r--r-- … a.txt / b.txt
```

API→shell, shell→API, and durability across a process boundary all hold.

---

## Goal 3 — Shell semantics

Full matrix from `p3-semantics.ts` (48 cases). Everything below is verbatim.

| Feature | Result |
| --- | --- |
| `pwd`, `cd` within a script | ✅ `/workspace` → `/workspace/sub` |
| cwd resets between `exec` calls | ✅ by design (per-exec `cwd`) |
| env from `exec({env})` | ✅ `echo $FOO` → `bar` |
| `export` inside script | ✅ |
| pipelines, multi-stage | ✅ `echo hi \| tr a-z A-Z` → `HI`; `printf \| sort \| head \| tr` → `A B` |
| `>` `>>` `<` | ✅ |
| `2>` and `2>&1` | ✅ |
| exit status `$?`, `false`/`true` | ✅ `1` / `0` |
| stdout vs stderr separation | ✅ `out="OUT\n" err="ERR\n"` — separate strings on the result |
| `$(...)` and backticks | ✅ |
| arithmetic `$((…))` | ✅ `14` |
| globbing `ls *.txt` | ✅ (no-match → exit 2 + `ls: *.zzz: No such file or directory`) |
| brace expansion | ✅ `a1 a2 b1 b2` |
| multi-line script: `set -e`, `for`, `if`, `case`, function, `while` | ✅ all |
| here-doc (`rawScript: true`), here-string | ✅ |
| nonexistent command | ✅ exit **127**, `bash: definitely_not_a_command: command not found` |
| stdin via `exec({stdin})`, `read` builtin | ✅ |
| subshell `( … )` | ✅ cwd restored |
| `&&` / `\|\|` | ✅ |
| quoting, `${v:1:3}`, `${#v}`, `${v/a/b}`, `${u:-def}` | ✅ |
| arrays `a=(x y z)` | ✅ |
| `cp`/`mv`/`rm`, `chmod`, `ln -s` (absolute) | ✅ |
| `ln` (hard link) | ✅ *fails loudly*: `ln: hard links are not supported by the workspace store` (adapter throws ENOSYS by design) |
| `/dev/null` | ✅ (adapter's virtual `/dev` shim) |
| **`trap`** | ❌ `bash: trap: command not found` — not implemented |
| **`yes`** | ❌ not implemented |
| **`xargs -n1`** | ❌ `xargs: invalid option -- 'n'` (bare `xargs` works) |
| **`ln -s` with a RELATIVE target** | ❌ see Defect 2 |

### Cancellation — the most important finding of this probe

| Script | Abort at | Outcome |
| --- | --- | --- |
| `sleep 10; echo never` | 300 ms | ✅ settles at **304 ms**, `exitCode 124` |
| `timeout 0.2 sleep 5` | n/a | ✅ builtin works, 206 ms |
| 200 top-level `sleep 0.02` statements | 300 ms | ✅ exit 124 at 302 ms |
| `for i in $(seq 1 200); do sleep 0.02; done` | 300 ms | ✅ exit 124 at 302 ms |
| `i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done` | 300 ms | ❌ **ignored** — ran 6 378 ms to completion, `exitCode 0`, `signal.aborted === false` |
| `while true; do i=$((i+1)); done` (budgets raised) | 300 ms | ❌ **never returned**; observed 56 s at 102 % CPU, killed by hand |

The `signal.aborted === false` after 6.4 s is the decisive datum: **the abort
timer itself never fired.** A host `setInterval(…, 50)` running across that same
exec ticked **0 times, expected ~127**. just-bash evaluates a loop body
synchronously with no yield to the event loop, so a CPU-bound shell script starves
the entire isolate — timers, the abort callback, and every other host task.

- Abort is honoured only where the interpreter already `await`s (a `sleep`, an fs
  op). It is *not* a preemption mechanism.
- The only in-isolate guard against a runaway CPU loop is
  `executionLimits.maxCommandCount` (default **10 000**), an interpreter-internal
  synchronous counter. Measured: `while true; do :; done` stops in **20 ms** with
  `exit 126`, `bash: too many commands executed (>10000)`. Raise that limit and
  you lose the only brake.
- Abort exit code is **124**, not 130. Cloudflare's entrypoint maps to 130 itself
  in its own `catch`; a Deno backend must do the same mapping if it wants 130.

This is what makes the Worker boundary (Goal 6) a requirement rather than a nicety.

---

## Goal 4 — Command-support matrix

`just-bash` exports: `Bash, BashTransformPipeline, CommandCollectorPlugin,
DefenseInDepthBox, EMPTY_BYTES, InMemoryFs, MountableFs, NetworkAccessDeniedError,
OverlayFs, ReadWriteFs, RedirectNotAllowedError, Sandbox, SandboxCommand,
SecurityViolationError, SecurityViolationLogger, TeePlugin, TooManyRedirectsError,
bytesOutput, createConsoleViolationCallback, decodeBytesToUtf8, defineCommand,
encodeUtf8ToBytes, getCommandNames, getJavaScriptCommandNames,
getNetworkCommandNames, getPythonCommandNames, latin1FromBytes, parse, serialize,
stdoutAsBytes, stdoutKind, textOutput, unsafeBytesFromLatin1`.

### Class 1 — built-ins, registered by default (83 names, all present)

`echo cat printf ls mkdir rmdir touch rm cp mv ln chmod pwd readlink head tail wc
stat grep fgrep egrep rg sed awk sort uniq comm cut paste tr rev nl fold expand
unexpand strings split column join tee find basename dirname tree du env printenv
alias unalias history xargs true false clear bash sh jq base64 diff date sleep
timeout seq expr md5sum sha1sum sha256sum file html-to-markdown help which tac
hostname od gzip gunzip zcat tar yq xan sqlite3 time whoami`

Functional smoke (all exit 0 unless noted):

| Command | Observed |
| --- | --- |
| `ls` / `cat` / `head`/`tail` / `wc` | `a.txt d` / `alpha beta` / `alpha…beta` / `2` |
| `grep` / `rg` | `beta` |
| `sed -n 2p` | `beta` |
| `awk 'NR==1{print $1}'` | `alpha` |
| `sort` / `uniq -c` | sorted / `2 a`, `1 b` |
| `cut -d: -f2` / `tr a-c A-C` | `b` / `ABC` |
| `find . -type f` | `./a.txt ./d/x.txt` |
| `du -sh` / `tree` | `13 .` / full tree render |
| `diff` | exit 1 + unified diff (correct) |
| `jq '.k[1]'` / `yq '.a'` | `2` / `1` |
| `base64` round trip | `hi` |
| `md5sum` / `sha256sum` | correct digests |
| `date`/`seq`/`expr` | `1 2 3 7` |
| `tar -cf` + `gzip -c` | archive created in DOFS |
| `od -c` / `file` | hexdump / `a.txt: ASCII text` |
| `tee`, `xargs`, `column`, `nl`, `time` | all work |
| `sh -c` / `bash -c` | `via-sh` / `via-bash` — **re-enters just-bash's own interpreter, not a native shell** |
| `html-to-markdown` | `# T` |
| `xan headers` | CSV headers |
| `sqlite3` | works (after Defect 3 fix) — see below |

### Class 2 — gated commands, OFF by default (verified)

With default `BashOptions` all of these are exit 127:

```
python3 -c 'print(1)'    exit=127  bash: python3: command not available in browser environments…
python --version         exit=127  (same)
js-exec -c '…'           exit=127  bash: js-exec: command not found
curl https://example.com exit=127  bash: curl: command not found
node -e '…'              exit=127  bash: node: command not found
```

- `javascript: true` → `js-exec`, `node`. QuickJS-in-WASM inside a
  `node:worker_threads` worker. Works under Deno after the Defect 3 fix.
- `python: true` → `python3`, `python`. CPython-Emscripten inside a worker.
  **Partially broken under Deno** — see Defect 3.
- `network: {...}` or `fetch:` → `curl` (there is no `wget`).

### Class 3 — custom commands (host-registered)

`defineCommand(name, handler)` + `customCommands: [...]`. Cloudflare registers
`git`, `assets`, `artifacts` this way, each backed by host code, not a binary
(`git-command.ts`, `assets-command.ts`, `artifacts-command.ts` in the pinned
tree). Not wired in this probe — noted as available and pure-host.

### Class 4 — native subprocesses: **NONE**

No command shells out. Verified three ways:

1. `which sh; which node; which deno; which python3` → all empty, exit 1.
2. `/bin/sh -c 'id'` → `bash: /bin/sh: No such file or directory`;
   `$(/usr/bin/id)` → same. `id`, `uname`, `ps`, `git`, `make`, `sudo`, `ssh`,
   `openssl`, `nc` and 13 other native tools: all `command not found`.
3. The QuickJS sandbox's `child_process` shim (`execSync`/`spawnSync`) —
   the one plausible native path — **re-enters just-bash**:
   `spawnSync("uname", ["-a"])` → `{"stdout":"","stderr":"bash: uname: command not found\n","status":127}`.
   The single `child_process` string in the main bundle is inside a
   DefenseInDepth *deny* message, not a call site.

---

## Goal 5 — SECURITY (measured, not inferred)

Canaries planted before every run: host file `/tmp/probe-host-secret.txt`
containing `HOST-SECRET-CANARY`, and `Deno.env HOST_CANARY=HOST-ENV-CANARY`.
Every result below was scanned for those strings plus `root:x:`. **Zero leaks
across every probe in this document.**

### A. Host filesystem — fully confined

| Attempt | Outcome |
| --- | --- |
| `cat /etc/passwd` | exit 1 `cat: /etc/passwd: No such file or directory` |
| `cat /tmp/probe-host-secret.txt` | exit 1, no such file |
| `ls /` | `workspace` — the DOFS root only |
| `ls /tmp`, `ls /Users/tarasmankovski` | exit 2, no such file |
| `cat ../../../../../../etc/passwd` | exit 1, no such file (adapter's `normalizePath` clamps `..` at root) |
| `cd / && ls -la` | `.`, `..`, `workspace/` |
| `find / -name 'probe-host-secret*'` | empty |
| `grep -r HOST-SECRET /` | empty |
| `readlink /proc/self/exe`, `cat /proc/self/status` | no such file |
| `echo pwned > /tmp/probe-shell-escape.txt` | `WorkspaceFsError: parent directory missing` — the write went into the **DOFS namespace**, never the host |
| `echo pwned > /etc/probe.txt` | same |
| `tar -cf /tmp/x.tar /etc/passwd` | `tar: /etc/passwd: ENOENT` |
| host-side verification | `/tmp/probe-shell-escape.txt`, `/etc/probe.txt`, `/tmp/host-probe.db`, `/tmp/probe-cp-escape.txt` — **none created** |

The adapter only ever calls `WorkspaceFs` methods; no built-in was found that
bypasses it.

### B. Host environment — fully synthetic

```
env  ->  HOME=/  PATH=/usr/bin:/bin  IFS=…  OSTYPE=linux-gnu
         MACHTYPE=x86_64-pc-linux-gnu  HOSTTYPE=x86_64  HOSTNAME=localhost
         PWD=/workspace  OLDPWD=/workspace  OPTIND=1  SHELLOPTS=…  BASHOPTS=…
printenv HOST_CANARY  -> rc=1 (unset)
echo $USER $SHELL     -> empty
whoami / hostname     -> user / localhost
echo $$ $PPID $UID    -> pid=1 ppid=0 uid=1000   (virtual, per `processInfo`)
```

The host's real env is invisible. `OSTYPE=linux-gnu` on macOS confirms the env is
fabricated, not inherited. Only explicitly-passed `exec({env})` reaches the script.

### C. Network

Default (no `network`/`fetch` option): `curl` and `wget` are **not registered** —
exit 127. `NetworkAccessDeniedError` is exported for the opted-in case.

Opted in with `network: { allowedUrlPrefixes: ["https://example.com"] }`:

| Request | Outcome |
| --- | --- |
| `curl https://example.com` | **200 — reaches the real network** |
| `curl https://api.github.com` | exit 7 (denied, not on the allowlist) |
| `curl http://169.254.169.254/latest/meta-data/` | exit 7 (cloud-metadata SSRF denied) |
| `curl file:///etc/passwd` | exit 7 |
| `curl http://localhost:22` | exit 7 — **denied even when `http://localhost` IS on the allowlist** |

The last row is the interesting one: `dist/network/allow-list.d.ts` has "Check if
a hostname is a private/loopback IP address" and `dns-pin.d.ts` pins DNS to the
preflight-validated IP "defeating DNS rebinding". So the network capability is a
strict prefix allowlist **plus** private/loopback rejection **plus** DNS-rebinding
pinning. Opting in grants exactly the named origins and nothing else.

### D. QuickJS `js-exec` sandbox (`javascript: true`)

Every probe below ran **inside** the sandbox via `js-exec -c`:

| Attempt | Result |
| --- | --- |
| `console.log("js alive", 1+1)` | `js alive 2` — the sandbox works |
| `typeof Deno`, `typeof globalThis.Deno` | `undefined`, `undefined` |
| `Deno.env.get("HOST_CANARY")` | `ReferenceError: 'Deno' is not defined` |
| `Deno.readTextFileSync("/tmp/probe-host-secret.txt")` | `ReferenceError: 'Deno' is not defined` |
| `typeof process / require / module / Buffer` | `object / function / undefined / function` — **shims**, not Node's |
| `process.binding`, `process.dlopen`, `process.getBuiltinModule` | all `undefined` |
| `Object.getOwnPropertyNames(globalThis)` | pure ECMA-262 set (`Error … BigInt64Array`) — no host objects |
| `Function("return this")()` | `TypeError: Function constructor is not allowed` |
| `(function(){}).constructor("…")()` | `TypeError: Function constructor is not allowed` |
| `import("node:fs")` | `ReferenceError: could not load module 'node:fs'` |
| `require("fs")` | returns the **workspace-scoped shim**: `["readFile","readFileBuffer","writeFile","stat","readdir"]` |
| `require("fs").readFileSync("/tmp/probe-host-secret.txt")` | `Error: no such file: <path>` (path even redacted) |
| `require("fs").writeFileSync("/workspace/from-js.txt", …)` | ✅ lands in DOFS — host verified `"js-wrote-this\n"` |
| `require("child_process").execSync("uname -a")` | `status 127`, `bash: uname: command not found` — re-enters just-bash |
| `child_process.execSync("echo escaped > /tmp/probe-cp-escape.txt")` | `parent directory missing` — host file never created |
| `fetch("https://example.com")` (network not configured) | `TypeError: Network access not configured. Enable network in Bash options.` |
| `typeof Atomics`, `typeof WebAssembly` | `undefined`, `undefined` |
| `typeof SharedArrayBuffer` | `function` (QuickJS's own, not the host's) |
| CPU spin 3 s inside QuickJS | runs 3 006 ms — **but in a worker thread, so the host isolate stays free** |

quickjs-emscripten is a separate WASM VM with an explicitly-built capability
surface. Nothing in the guest reaches the Deno isolate. Proven, not assumed.

### E. Python (`python: true`) — CPython-Emscripten

| Attempt | Result |
| --- | --- |
| `print("py alive")` | `py alive` |
| `open("/etc/passwd").read()` | `FileNotFoundError: [Errno 44] … '/host/etc/passwd'` — reroutes into the sandbox namespace |
| `os.environ.get("HOST_CANARY")` | `None` |
| `subprocess.run(["id"])` | `OSError: [Errno 138] emscripten does not support …` |
| `os.system("id")` | `-1` |
| `socket.connect(("example.com", 80))` | `OSError: [Errno 23] Host is unreachable` |
| `open("/workspace/from-py.txt","w")` | ✅ lands in DOFS |

Confined — but see Defect 3: python3 is not production-usable under Deno.

### F. Defense-in-depth verdict

**`DefenseInDepthBox` is not the thing keeping the shell contained, and it cannot
run under Deno at all.** Measured:

- With `defenseInDepth: { enabled: false }` — the configuration Cloudflare ships
  and the only one that runs under Deno — **every one of the ~50 escape attempts
  above failed.** No host file, no host env var, no native process, no network,
  no Deno global.
- Containment comes from architecture, not from monkey-patching: (a) the only
  filesystem the interpreter has is the injected `IFileSystem`; (b) the env is
  fabricated; (c) there is no `child_process`/`spawn` call site anywhere in the
  bundle; (d) network commands are not even registered unless configured; (e)
  guest code execution happens in a separate WASM VM with a hand-built global set.
- What DID actually patches (`process.dlopen`, `process.getBuiltinModule`,
  `Module._load`, `process.exit`, `process.report`, `process.execPath`) is a
  hardening layer against *bugs in the above*, aimed at Node hosts. Under Deno
  most of those handles do not exist to be patched.

**Is a Deno Worker boundary necessary for security?** On the evidence: not for
*capability* containment — the interpreter is inherently sandboxed. It **is**
necessary for *availability*: the Goal 3 measurement shows a CPU-bound script
wedges the isolate with no cooperative escape. That is a denial-of-service escape
from the host's control, and only a terminable isolate answers it.

---

## Goal 6 — Deno Worker boundary  ✅ VIABLE, and recommended

**Can the fs capability cross?** Not as a handle:

```
structuredClone(WorkspaceFilesystem): DataCloneError: (query, ...bindings)=>{ … } could not be cloned.
structuredClone(Database):            DataCloneError: (query, ...bindings)=>{ … } could not be cloned.
```

Option (a) — Bash in the main isolate — was implemented and measured (Goals 1–5).
Option (b) — Bash in a `new Worker(url, {type:"module"})`, DOFS staying in the main
isolate, `WorkspaceFs` crossing as an **async postMessage RPC proxy** — was
prototyped (`worker-shell.ts` + `p6-worker.ts`) and works.

The adapter tolerates the async proxy without modification: every `WorkspaceFs`
method already returns a Promise, so an RPC is indistinguishable from a local
await. `readFile`'s stream overload is the only special case — ship bytes and
rebuild the stream worker-side, which is exactly what the adapter's
`new Response(stream).arrayBuffer()` consumes.

### Functional parity through the RPC proxy — 10/10

```
"echo hello"                                    exit=0 host=6.7ms  worker=6.5ms  out="hello\n"
"echo via-worker > w.txt; cat w.txt"            exit=0 host=6.8ms  out="via-worker\n"
"mkdir -p wd && echo deep > wd/f.txt && find ." exit=0 out="./w.txt\n./wd/f.txt\n"
"printf 'b\na\n' > s.txt; sort s.txt | tr …"    exit=0 out="A\nB\n"
"ls -la"                                        exit=0
"grep -r deep . | head -2"                      exit=0 out="wd/f.txt:deep\n"
"sed -i.bak 's/deep/DEEP/' wd/f.txt; cat …"     exit=0 out="DEEP\n"
"cat missing.txt"                               exit=1 err="cat: missing.txt: No such file or directory\n"
"chmod 700 w.txt; stat w.txt | head -3"         exit=0 out="Access: (0700/-rwx------)"
"ln -s /workspace/w.txt wl.txt; cat wl.txt"     exit=0 out="via-worker\n"
(103 fs RPC round trips, 9.7 ms total host-side fs work)
```

### Cost

| Measurement | In-isolate | Worker + RPC |
| --- | --- | --- |
| Worker boot + Bash construction | — | **39.6 ms** (once) |
| `echo x` (mean of 30) | 0.30 ms | **0.27 ms** (4 fs RPCs/exec) |
| write + read a file (mean of 30) | 0.52 ms | **0.97 ms** (11 fs RPCs/exec) |

≈ **0.04 ms per RPC round trip**. `echo` is a wash; a filesystem-touching command
costs +0.45 ms. Negligible against a 40 ms boot amortised across a session.

### The decisive benefit

| | In-isolate | Worker |
| --- | --- | --- |
| Host 50 ms ticks during a worker-side CPU loop | **0** (starved) | **3 of ~3** — host stayed fully responsive |
| Unbounded `while true` loop | unrecoverable; 56 s at 102 % CPU, abort timer never fired | `worker.terminate()` reclaims it in ~1.3 s while the host ticked 9× in 500 ms |

**Recommendation: the committed spike should run Bash in a Deno Worker** with the
fs proxied by RPC. The security case is a tie (the interpreter is sandboxed either
way); the availability case is decisive, and it costs 40 ms + 0.04 ms/RPC. It also
mirrors Cloudflare's own topology (shell in a separate isolate, fs over RPC to the
host that owns it), so the two backends stay structurally comparable.

---

## Goal 7 — Latency, size, bundling

Cold path, interpreted:

```
openWorkspace + Bash ctor  11.09 ms
cold `echo hello`           5.67 ms
fs command                  9.23 ms
warm `echo`                 0.17 ms
```

`deno compile` — **works**, with `--no-check` (only because this probe's
`workspace.ts` is untyped JS-in-TS; a typed spike will not need it):

```
$ deno compile -A --no-check --node-modules-dir=manual --output /tmp/probe-shell-bin p7-compile.ts
Files: 100.76MB   →   binary 167 MB
$ /tmp/probe-shell-bin /tmp/p7b.db
{"echo":"hello","fs":["body","4"],"warm":"warm",
 "ms":{"openWorkspaceAndBash":12.71,"coldEcho":8.03,"fsCommand":10.47,"warmEcho":0.17}}
sqlite3: {"exit":0,"out":"9","err":""}
```

The compiled binary runs the shell **and** `sqlite3` — meaning even the
worker-thread commands, which resolve their worker file from a disk path, work
because `deno compile` embedded `node_modules/*`. Compiled timings match
interpreted within noise.

Size breakdown (unpacked `node_modules`, 111 MB total):

| Package | Size |
| --- | --- |
| `just-bash` | 21 MB (`dist/bundle` 5.1 MB, `vendor/cpython-emscripten` 9.9 MB) |
| `sql.js` | 18 MB |
| `typescript` (dofs build dep only — droppable) | 24 MB |
| `@cloudflare/dofs` vendored | 12 MB |
| `quickjs-emscripten` (+ `@jitl/*`) | ~9 MB |

Trimmable: `typescript` is a dofs *build* dependency; `vendor/cpython-emscripten`
(9.9 MB) is dead weight unless `python: true`; `sql.js` (18 MB) unless `sqlite3`
is wanted. The core-shell footprint is the 256 KB `dist/bundle/index.js` plus
runtime deps. A `dist/bundle/browser.js` single-file build (1.07 MB) exists and is
the natural target if a leaner graph is wanted.

Two optional deps have **native install scripts that npm did not run**:
`@mongodb-js/zstd` (prebuild-install) and `node-liblzma` (node-gyp). The shell
worked fully without them — the spike should keep them unbuilt and note that
`gzip`/`tar` work regardless.

---

## Defects found (all root-caused)

### Defect 1 — `defenseInDepth` default-on, fatal under Deno
Covered above. **Fix: `defenseInDepth: { enabled: false }`** — one line, already
present in Cloudflare's entrypoint.

### Defect 2 — relative symlinks are broken *in DOFS itself* (affects Cloudflare too)

```
DOFS lstat(rel.link).isSymbolicLink = true
DOFS readlink(rel.link)             = t.txt
DOFS stat(rel.link)      THREW: Invalid path (must be absolute): t.txt
DOFS readFile(rel.link)  THREW: Invalid path (must be absolute): t.txt
DOFS readFile(abs.link)  = "body\n"          ← absolute target works
shell: cat rel.link  ->  "cat: rel.link: No such file or directory"
shell: cat abs.link  ->  "body"
```

The failure is in `@cloudflare/dofs`'s own resolver, not in the adapter or in
just-bash: DOFS does not resolve a symlink target relative to the link's parent.
`ln -s t.txt rel.link` — the ordinary form — produces a dangling link. This is
upstream and applies equally to Cloudflare's Worker Shell. Worth reporting.

### Defect 3 — `process.connected` throws in Deno workers, breaking every worker-backed command

Root cause, isolated to a 20-line reproduction driving just-bash's own worker:

```
$ deno run -A p5c-worker-root-cause.ts
MSG #1: {"success":false,"error":"process.connected is not supported in workers"}
```

`js-exec-worker.js` runs `initializeWithDefense()` → `new WorkerDefenseInDepth(...)`
unconditionally (**not** controlled by the host's `defenseInDepth` option — the
config never crosses into the worker). Under Deno, reading `process.connected`
inside a worker throws; the resulting error message carries no `protocolToken`, so
the host's first-message handler rejects it as `Malformed worker response: invalid
protocol token`. Symptoms per command:

- `js-exec` — code **runs correctly** and stdout arrives over the SharedArrayBuffer
  bridge, but exit code is always **1** with that stderr.
- `python3` — **10 s timeout on every invocation**, exit 124.
- `sqlite3` — exit 1, `sqlite3: process.connected is not supported in workers`.

Runtime differential, confirmed:

```
deno:  read="THREW process.connected is not supported in workers"  write="defineProperty ok -> false"
node:  read="undefined"                                            write="defineProperty ok -> false"
```

**Fix (verified):** prepend one line to the shipped worker files —

```js
import process from "node:process";
try { Object.defineProperty(process, "connected", { value: false, configurable: true, writable: true }); } catch (e) {}
```

Applied to `dist/bundle/chunks/js-exec-worker.js`, `worker.js` (python3) and
`sqlite3-worker.js` (originals kept as `*.orig`). After the patch:

- `js-exec` — **exit 0 everywhere**, all 16 sandbox probes clean.
- `sqlite3` — **exit 0**, `select * from t` → `42`, database written into DOFS,
  host path `/tmp/host-probe.db` refused and never created.
- `python3` — runs (`py alive`, confinement all correct) but still exits 1 with
  `Fatal Python error: gilstate_tss_clear: failed to clear current tstate (TSS)` /
  `Aborted()` / `python3: Security violation: webassembly` on every invocation.
  **python3 remains not production-usable under Deno.** It is off by default, so
  this does not block anything.

Placement note: this is a Deno node-compat gap (Deno's worker `process.connected`
getter throws where Node returns `undefined`). Cleanest resolutions, in order:
(1) upstream Deno fix; (2) upstream just-bash guarding the defense init in a
try/catch; (3) a vendored patch in the spike. Since `js-exec`/`python3`/`sqlite3`
are all opt-in and the core shell never touches a worker, the spike can ship
without any of them and record this as a known limitation.

### Defect 4 (fidelity) — `ls -l` reports a stale mode

```
DOFS stat mode      = 700
adapter.stat mode   = 700
adapter.readdirWithFileTypes keys = ["name","isFile","isDirectory","isSymbolicLink"]
shell `ls -l t.txt` = "-rw-r--r-- 1 user user     5 …"     ← wrong
shell `stat t.txt`  = "Access: (0700/-rwx------)"          ← right
shell `[ -x t.txt ]` = "yes"                               ← right
```

`chmod` works end to end; only `ls -l` is wrong, because the adapter's
`readdirWithFileTypes` carries no `mode` and just-bash's `ls` falls back to a
default. This is in Cloudflare's verbatim adapter, so it affects their shell too.

### Defect 5 (contract) — some fs errors escape `exec()` as exceptions

```
echo x > /nonexistent-dir/f.txt   *** THREW OUT OF exec(): WorkspaceFsError: parent directory missing
mkdir /a/b/c                      exit=1 err="mkdir: cannot create directory …"   ← correct
cp missing.txt d.txt              exit=1 err="cp: cannot stat 'missing.txt' …"    ← correct
```

A redirection to a missing parent directory rejects the `exec` Promise instead of
returning a non-zero exit. **Callers must wrap `bash.exec` in try/catch** —
Cloudflare's entrypoint already does, mapping to `exitCode: 1`. The spike must
replicate that wrapper or the first bad redirect crashes the host.

---

## What the committed spike must replicate

1. `WorkspaceFsAdapter` copied **verbatim** (sha1 `c9ec5356…`) with provenance,
   plus a ~60-line `WorkspaceFsShim` supplying `exists`/`statOrNull`/`lstatOrNull`
   over DOFS's `WorkspaceFilesystem`.
2. `defenseInDepth: { enabled: false }` with a comment stating it is load-bearing
   on Deno *and* workerd, and that containment does not depend on it.
3. `executionLimits` explicitly set — `maxOutputSize` **and** `maxCommandCount`.
   The default 10 000 command budget is the only in-isolate brake on a runaway
   loop; raising it without a Worker boundary removes the last guard.
4. `try/catch` around `bash.exec` mapping a thrown `WorkspaceFsError` to a
   non-zero exit (Defect 5), and the abort exit-code mapping 124 → 130 if that
   code is part of the contract.
5. Bash inside a **Deno Worker**, `WorkspaceFs` crossing as an async RPC proxy;
   `readFile`'s stream overload shipped as bytes and rebuilt worker-side. Cancel
   = `worker.terminate()`, not `AbortSignal` alone.
6. Regression tests pinning the measured behaviour: the restart-coherence pair,
   `exit 127` for a missing command, `exit 124` on abort of an awaiting script,
   the confinement canaries (host file + host env + native exec + network), and
   the `sh -c`/`execSync` re-entry proof.
7. Known limitations recorded: relative symlinks (Defect 2, upstream DOFS),
   `ls -l` mode (Defect 4, upstream adapter), `trap`/`yes`/`xargs -n` absent,
   python3 unusable under Deno (Defect 3), `js-exec`/`sqlite3` needing the
   `process.connected` shim if enabled.

## Files in this probe

| File | Purpose |
| --- | --- |
| `adapter.ts` | Cloudflare's `WorkspaceFsAdapter`, verbatim |
| `file-storage.ts` | `FileSQLiteStorage` from `spikes/349-dofs` |
| `workspace.ts` | `WorkspaceFsShim` + `openWorkspace()` wiring |
| `lib.ts` | `makeBash`/`open` helpers |
| `p1-load.ts` | Goal 1 — load, construct, defenseInDepth modes |
| `p2-coherence.ts` | Goal 2 — bidirectional + restart |
| `p3-semantics.ts` / `p3b` / `p3c` / `p3d` / `p3e` | Goal 3 — semantics, cancellation, the wedge proof |
| `p4-commands.ts` / `p4b-gating.ts` | Goal 4 — command matrix and gating |
| `p5-security.ts` / `p5b` / `p5c` / `p5d` / `p5e` / `p5f` / `p5g` | Goal 5 — escape attempts, worker root cause, child_process, network |
| `p6-worker.ts` + `worker-shell.ts` | Goal 6 — Deno Worker + fs RPC prototype |
| `p7-compile.ts` | Goal 7 — cold latency + `deno compile` |
| `p8-fidelity.ts` | Defects 2, 4, 5 pinned to their layer |
