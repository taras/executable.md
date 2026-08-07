# Evidence: transactional Worker Shell effects (#357)

## Result

**INCLUDE.** A single Worker Shell invocation can satisfy:

```text
one expansion -> one effect -> one SQLite transaction
```

The proof uses Deno-local SQLite, the #349 DOFS build, `just-bash@3.0.1`, the
byte-identical Cloudflare `WorkspaceFsAdapter` from #353 and
`@effectionx/worker@0.5.4` with the force-termination delta documented in
[UPSTREAM-DELTA.md](UPSTREAM-DELTA.md). No production Workspace or shell
component is added, and the journal payload is accepted as already filtered.

## Environment

Measured 2026-08-06 on macOS 15 / Darwin 25.5.0 arm64:

```text
deno 2.9.1 (stable, release, aarch64-apple-darwin)
v8 14.9.207.2-rusty
typescript 6.0.3
Node v26.5.1 (dependency preparation only)
```

## Transaction mechanism

`FileSQLiteStorage.beginEffect()` opens `BEGIN IMMEDIATE` and
`SAVEPOINT shell_mutations`. DOFS's existing synchronous transaction calls do
not form an atomic group on their own. During an open effect,
`transactionSync()` nests each DOFS mutation under a generated savepoint;
outside an effect it retains its original `BEGIN`/`COMMIT` behavior.

Success releases the mutation savepoint, appends the successful journal row and
commits. Every known failure rolls back and releases the mutation savepoint,
appends one failed row and commits. Instrumentation observed exactly one effect
transaction, one in-effect journal append, one commit and zero outer rollbacks
for each known failure. The crash probe observed SQLite rolling back the open
outer transaction.

An independent SQLite/DOFS reader observed the old filesystem and no journal
row before commit. A restarted reader observed writes, delete, rename, mode,
symlink and journal together after commit.

## Probe results

| Probe | Shell outcome | Filesystem | Journal | Result |
| --- | --- | --- | --- | --- |
| zero exit | `exit`, code 0 | write/delete/rename/mode/symlink committed | one `ok` row | PASS |
| nonzero exit | `exit`, nonzero | `result.txt` absent | one `failed` row | PASS |
| interpreter error | `interpreter-error`, code 1 | `result.txt` absent | one `failed` row | PASS |
| timeout | `timeout`, code 124 | `result.txt` absent | one `failed` row | PASS |
| explicit cancellation | `cancelled`, code 130 | `result.txt` absent | one `failed` row | PASS |
| `Worker.terminate()` | `terminated`, code 1 | `result.txt` absent | one `failed` row | PASS |
| CPU-bound timeout | preempted in 0.98 s test wall time | partial write absent | one `failed` row | PASS |
| host `SIGKILL` | process killed after write RPC | partial write absent after restart | no row | PASS |

The compiled crash host printed `write-reached` only after the transaction-bound
`writeFile` RPC completed. The parent then sent `SIGKILL`. Restart against the
same file-backed database found neither `result.txt` nor an effect row. Replay
under the same effect identity started one Worker against the pre-effect root;
the resulting commit then replayed with zero Worker starts.

## Routing and fencing

Every `@effectionx/worker` request contains:

- the workflow effect ID;
- a unique invocation token that distinguishes a replay attempt from stale
  messages left by an earlier Worker; and
- a request ID, operation and parsed argument list.

The router rejected missing effect identity, foreign effect identity, a stale
invocation token, a completed transaction and a cancelled transaction. None of
the rejected calls created `fenced.txt`.

## Isolation regression

The new transaction boundary retained #353's constraints:

- `cat /etc/passwd` returned nonzero and exposed no host content;
- `/bin/echo` returned nonzero, proving there is no host PATH/native launcher;
- only the explicitly supplied fabricated environment was visible;
- `curl https://example.com` returned nonzero because no network route was
  installed; and
- a CPU-bound `just-bash` loop with interpreter limits raised was terminated
  through the Worker boundary while the host timer continued ticking.

The Worker is created with Deno permissions set to `none`. The Cloudflare
adapter remains byte-identical; transaction identity and routing wrap its
structural filesystem dependency.

## Artifact and runtime cost

The two compiled proof artifacts are each 139,984,178 bytes. #351 recorded its
combined-backend proof as 139.7 MB, so this focused transaction proof is about
0.3 MB larger (roughly 0.2%) despite adding `@effectionx/worker` and transaction
instrumentation.

The first compiled invocation after rebuilding and extracting the embedded
Worker graph measured 1.60 s; the next compiled successful effect measured
0.12 s. #351 measured an in-process shell execution at 16–22 ms. The warm
additional roughly 0.10 s is Worker startup, request routing and transaction
publication. A committed replay measured 0.04 s and started no Worker.

## Limitations production #218 must preserve

1. `@effectionx/worker` 0.5.4's published graceful shutdown cannot preempt a
   CPU-bound interpreter. The unpatched probe passed its 500 ms timeout but did
   not return control after 3 seconds; the parent had to terminate the proof
   process. The version-checked POC delta calls `Worker.terminate()` during
   resource shutdown. Production requires this as a supported contract.
2. One workflow database has one authoritative host-owned DOFS connection.
   DOFS's per-`Database` resolve cache does not invalidate a negative lookup in
   another long-lived connection after commit. The independent visibility
   reader therefore restarts after the commit; the authoritative connection
   invalidates its own mutation cache correctly.
3. Worker Shell remains `just-bash`, not POSIX/native Bash. No native process,
   host PATH, writable FUSE, Worker JavaScript capability or default network
   route is implied.
4. The journal input at this boundary is already filtered. Production retains
   the existing security-filtering boundary and must not treat arbitrary
   Workspace content as journal or training data.

## Commands

```bash
deno task spike:357
deno task lint
deno task check
deno task test
deno task check:jsr
```

Raw observations are recorded in [raw-proof-output.txt](raw-proof-output.txt).
