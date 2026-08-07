# Spike 357: transactional Worker Shell effects

This proof tests whether one `just-bash` invocation can route every Workspace
filesystem request through one SQLite effect transaction and publish the
already-filtered journal result atomically. It does not add a production shell
component.

## Verdict

**INCLUDE Worker Shell in the first production `xmd workflow` release.** One
invocation satisfies the required effect-transaction contract when the Worker
lifecycle has forceful termination.

The transaction is owned by the host:

```text
BEGIN IMMEDIATE
  SAVEPOINT shell_mutations
  @effectionx/worker request -> identity/token fence -> DOFS savepoint
  success: RELEASE shell_mutations
  failure: ROLLBACK TO shell_mutations; RELEASE shell_mutations
  INSERT already-filtered journal result
COMMIT
```

DOFS continues to call its synchronous `Database.transactionSync()` boundary.
While the effect is open, `FileSQLiteStorage.transactionSync()` maps each of
those calls to a nested SQLite savepoint instead of attempting an illegal
second `BEGIN`. The result metrics prove one outer transaction, one journal
append inside it and one commit for success and known failure.

Every Worker request carries the stable effect ID plus a per-invocation token.
The host rejects missing, foreign, completed, cancelled and stale identities
before dispatching to DOFS.

## Reproduce

From the repository root:

```bash
deno task spike:357
```

That one command builds the pinned DOFS dependency, installs and patches the
pinned Worker dependency, compiles the proof and crash-host processes,
typechecks the spike, and runs all probes.

The exact observations are in [evidence/EVIDENCE.md](evidence/EVIDENCE.md) and
[evidence/raw-proof-output.txt](evidence/raw-proof-output.txt). The
`@effectionx/worker` provenance delta is isolated in
[evidence/UPSTREAM-DELTA.md](evidence/UPSTREAM-DELTA.md).

## Layout

- `host/storage.ts` owns the explicit effect transaction, shell-mutation
  savepoint and representative journal table.
- `host/router.ts` validates every filesystem RPC and dispatches it to the
  exact transaction-bound DOFS facade.
- `host/shell-worker.ts` runs `just-bash` through the unchanged Cloudflare
  `WorkspaceFsAdapter` and `@effectionx/worker` request channel.
- `host/shell.ts` applies success/failure publication and replay behavior.
- `host/crash-host.ts` is the separately compiled process killed by the crash
  probe.
- `tests/` contains the transaction, fencing, failure, crash, replay and
  isolation assertions.

## Production constraints

Production #218 must retain a force-termination Worker contract. Published
`@effectionx/worker` 0.5.4 performs graceful shutdown only; this proof applies a
version-checked install patch because a CPU-bound interpreter cannot answer its
close message. Production must consume an upstream fix or own an equivalent
reviewed adapter, never patch an installed package.

The authoritative local topology must keep one host-owned DOFS connection per
workflow database. An independent long-lived DOFS reader caches a negative
lookup across another connection's commit; the visibility probe restarts that
independent reader after commit. SQLite itself provides the required isolation,
and the authoritative connection's mutation path invalidates its own cache.
