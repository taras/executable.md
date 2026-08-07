# Probe: file-backed node:sqlite adapter for Cloudflare DOFS under Deno (issue #349, slice 1)

Runtime under test: Deno 2.9.1 (aarch64-apple-darwin). Reference: cloudflare/computer v0.1.1
(63d363632e558f7e077794988d36ed75017c2a62), `packages/dofs`, read-only clone at `../cf-computer`.
Working vendored copy: `./dofs` (modified only in `package.json` devDeps + `tsconfig.build.json`
types array — see Step 1).

## Verdict (condensed)

PASS on every axis. A ~70-line file-backed `DurableObjectStorageLike` adapter over
`new DatabaseSync(path)` from `node:sqlite` satisfies the whole contract with ZERO changes to
dofs source: the filesystem frontier (writes, deletes, renames, symlinks, delete-then-recreate)
survives full Deno process restarts; a second db file is a fully isolated empty workspace; the
schema-version gate refuses a database stamped by a newer binary with a loud
`WorkspaceFsError: Unsupported workspace filesystem schema version 99` and exit code 1.
Warm per-op process wall time ~35 ms (in-process op time 1.5–4 ms).

## Step 1 — vendor + build

```
cp -R cf-computer/packages/dofs probe-dofs/dofs
cd probe-dofs/dofs && npm i -D typescript @cloudflare/workers-types @types/node
```

First install FAILED (verbatim core):

```
npm error code ERESOLVE
npm error While resolving: wrangler@4.119.0
npm error Found: @cloudflare/workers-types@4.20260702.1
npm error peerOptional @cloudflare/workers-types@"^5.20260801.1" from wrangler@4.119.0
npm error Conflicting peer dependency: @cloudflare/workers-types@5.20260804.1
```

Cause: the package's own devDeps pin `wrangler@^4.107.1`, and the wrangler line has since moved
to a `workers-types@^5` peer — the conflict is between two TEST-ONLY devDeps (wrangler,
@cloudflare/vitest-pool-workers), not anything the build needs.

Fix (in the vendored copy only):
1. `package.json` devDependencies trimmed to `typescript@^6.0.3`,
   `@cloudflare/workers-types@^4.20260616.1`, `@types/node@^24`.
2. `tsconfig.build.json` overrides `compilerOptions.types` to
   `["@cloudflare/workers-types", "node"]` (the base tsconfig demands `vitest/globals` and
   `@cloudflare/vitest-pool-workers/types`, again test-only).

Then:

```
npm i                                   # clean, 0 vulnerabilities
./node_modules/.bin/tsc -p tsconfig.build.json    # exit 0, no diagnostics
```

Build is CLEAN. Emits `dist/` as ESM `.js` + `.d.ts` mirroring `src/` (21 top-level entries incl.
`index.js`, `storage.js`, `schema/`, `fs/` with every op — `fs/rename.js` included). No
`--unstable-sloppy-imports` fallback needed; the tsc-build vendoring story works as-is. (Caveat:
`npx tsc` without a local install grabs the squatter `tsc@2.0.4` npm package — use
`./node_modules/.bin/tsc` or install typescript first.)

## Step 2 — adapter: `file-storage.mjs`

Mirrors `src/testing.ts` `SQLiteTestStorage` exactly (statement cache, `toSQLiteValue`
normalization: undefined/null→null, boolean→1/0, Uint8Array passthrough, string/number/bigint
passthrough, TypeError otherwise; BEGIN/COMMIT/ROLLBACK `transactionSync`) but opens a real path.
Pragmas chosen: `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`. Exposes
`close()` and a `pragma()` helper for the probe.

```js
// FileSQLiteStorage — file-backed DurableObjectStorageLike over
// node:sqlite under Deno. Mirrors dofs's SQLiteTestStorage
// (src/testing.ts) exactly — prepared-statement cache, binding
// normalization, BEGIN/COMMIT/ROLLBACK transactionSync — but opens
// a real database file instead of ":memory:".

import { DatabaseSync } from "node:sqlite";

class Cursor {
  #rows;
  constructor(rows) {
    this.#rows = rows;
  }
  toArray() {
    return this.#rows;
  }
}

export class FileSQLiteStorage {
  #db;
  #cache = new Map();
  sql;

  constructor(path, { journalMode = "WAL" } = {}) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode = ${journalMode}`);
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.sql = {
      exec: (query, ...bindings) => {
        let stmt = this.#cache.get(query);
        if (stmt === undefined) {
          stmt = this.#db.prepare(query);
          this.#cache.set(query, stmt);
        }
        const normalized = bindings.map(toSQLiteValue);
        const rows = stmt.all(...normalized) ?? [];
        return new Cursor(rows);
      },
    };
  }

  transactionSync(closure) {
    this.#db.exec("BEGIN");
    try {
      const result = closure();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  pragma(name) {
    return this.#db.prepare(`PRAGMA ${name}`).all();
  }

  close() {
    this.#cache.clear();
    this.#db.close();
  }
}

// Same normalization as SQLiteTestStorage.toSQLiteValue.
function toSQLiteValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  throw new TypeError(`FileSQLiteStorage cannot bind value of type ${typeof value}`);
}
```

## Step 3 — probe harness: `probe.mjs`

One op per invocation → one Deno process per op. Construction recipe (canonical order taken
from `src/fs/filesystem.test.ts` `withFs`):

```js
import { Database, initializeSchema, SCHEMA_VERSION, WorkspaceFilesystem } from "./dofs/dist/index.js";
import { rename } from "./dofs/dist/fs/rename.js"; // NOT on the class or index.ts — free function only
import { FileSQLiteStorage } from "./file-storage.mjs";

const storage = new FileSQLiteStorage(dbPath);   // 1. adapter
const db = new Database(storage);                 // 2. wrap
initializeSchema(db, Date.now);                   // 3. idempotent DDL + migration gate + root inode
const fs = new WorkspaceFilesystem(db);           // 4. ops surface ({ now } optional)
// ... run op ...
storage.close();                                  // 5. checkpoints WAL, removes -wal/-shm
```

`initializeSchema(db, now)` is safe to call on EVERY process start: all DDL is
`CREATE ... IF NOT EXISTS`, version stamping is insert-or-ignore + update, and it is exactly
where the too-new-schema gate lives.

Surprise: `WorkspaceFilesystem` has no `rename` method and `index.ts` does not export the free
function; `rename(db, oldPath, newPath)` must be imported from `dist/fs/rename.js` directly.

## Step 4 — frontier across fresh processes (every line = a separate `deno run -A probe.mjs ws.db ...`)

```
init                      → {"op":"init","schemaVersion":5,"ms":2.92}   (cold; 0.050s wall)
mkdir /notes              → ok  ms:2.7
write /notes/a.md alpha   → ok  ms:4.18
read /notes/a.md          → "alpha"
write /notes/b.md beta    → ok
rm /notes/a.md            → ok
ls /notes                 → ["b.md"]
write /f.txt v1           → ok
rm /f.txt                 → ok
write /f.txt v2           → ok
read /f.txt               → "v2"                                    (delete-then-recreate survives)
stat /notes/b.md          → {"name":"b.md","inode":4,"mode":420,"mtime":1785988833560,
                             "size":4,"isFile":true,"isDirectory":false,"isSymbolicLink":false}
rename /notes/b.md /notes/c.md → ok
ls /notes                 → ["c.md"];  lsflat / → ["/f.txt","/notes/c.md"]
symlink /notes/c.md /link → ok        (signature: fs.symlink(target, path))
readlink /link            → "/notes/c.md"
read /link                → "beta"    → YES, readFile FOLLOWS symlinks
lstat /link               → {"isSymbolicLink":true,"isFile":false,"mode":511,"size":11}
read /notes/c.md          → "beta"    (final frontier proof after ALL of the above)
```

VERDICT: PASS. Every mutation made in one process is observed by the next; nothing leaked from
deleted files.

## Step 5 — isolation & identity

`deno run -A probe.mjs ws2.db lsflat /` → `{"paths":[]}`; `ls /` → `[]`. A second db path is a
fresh, empty workspace. Identity model: ONE DB FILE = ONE WORKSPACE. There is no Durable Object
identity layer here — in Cloudflare's runtime the DO id names the storage; file-backed, the
filesystem path of the .db file IS the workspace identity, and nothing inside the schema names
or authenticates the workspace. Callers own the path→workspace mapping (and any locking between
concurrent writers — SQLite WAL allows one writer at a time across processes).

## Step 6 — schema guard

`meta` on the live db: binary `SCHEMA_VERSION = 5`; `vfs_meta` = `[{k:"rev",v:10},
{k:"schema_version",v:5}]`; `journal_mode` = `wal`. (Version lives in table `vfs_meta`,
key `schema_version`.)

Guard test: `cp ws.db ws-future.db`, then `bump-version.mjs` sets stored `schema_version = 99`.
Opening it:

```
error: Uncaught (in promise) WorkspaceFsError: Unsupported workspace filesystem schema version 99
    at createWorkspaceError (dofs/dist/errors.js:2:19)
    at dofs/dist/schema/index.js:25:19
    at FileSQLiteStorage.transactionSync (file-storage.mjs:46:22)
    at Database.transactionSync (dofs/dist/storage.js:39:36)
    at initializeSchema (dofs/dist/schema/index.js:7:8)
```

Exit code 1. The throw happens inside `transactionSync`, so the adapter's ROLLBACK ran and the
future-versioned db is untouched. VERDICT: the "binary older than on-disk schema_version"
gate works loudly and exactly as in the DO runtime.

## Step 7 — timings (M-series mac, warm OS cache)

- Cold (fresh db file, full init): 0.050 s process wall; 2.92 ms in-process (open → init done).
- Warm (already-initialized db): 0.035 s process wall; 1.5–4.2 ms in-process per op
  (reads ~1.5–2 ms, writes ~3.5–4.2 ms — writes pay the transaction fsync at
  `synchronous = NORMAL`).
- Per-process overhead is dominated by Deno startup (~30 ms), not dofs or SQLite.

## Step 8 — node:sqlite under Deno 2.9.1

- `DatabaseSync(path)`, `prepare()`, `StatementSync.all()/run()/get()`, `exec()` for
  BEGIN/COMMIT/ROLLBACK, and SAVEPOINT/RELEASE (used by `Database`'s reentrant
  `transactionSync`) all work. `PRAGMA journal_mode/foreign_keys/synchronous` work.
- No Deno-specific failures were hit anywhere in the probe.
- node:sqlite quirks dofs ALREADY handles: rows come back with a null prototype
  (`storage.ts` `normalizeRow` re-keys into plain objects) and BLOBs come back as Uint8Array
  (also normalized there). `bump-version.mjs` output showed the raw
  `[Object: null prototype] { v: 99 }` shape, confirming the normalization is doing real work.
- WAL sidecars: `wal-check.mjs` proves `ws.db-wal` and `ws.db-shm` EXIST while the database is
  open with uncommitted-to-main-file writes, and `close()` checkpoints and REMOVES both
  (`{"during":{"wal":true,"shm":true},"after":{"wal":false,"shm":false}}`). After every probe
  run only the bare `.db` file remains, so a process that closes cleanly leaves a
  single-file artifact; a killed process would leave `-wal`/`-shm` behind and the next open
  replays them (standard SQLite WAL recovery).

## Files

- `file-storage.mjs` — the adapter (final code inline above)
- `probe.mjs` — CLI probe harness
- `bump-version.mjs`, `wal-check.mjs` — step 6 / step 8 helpers
- `dofs/` — vendored package (2 build-config edits, zero source edits), `dofs/dist/` — tsc output
- `ws.db` — the surviving workspace; `ws2.db` — isolation check; `ws-future.db` — guard fixture
