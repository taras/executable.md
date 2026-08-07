# Probe: DOFS reuse boundaries (issue #349 slice 2)

Reference clone: `scratchpad/cf-computer` @ tag v0.1.1 (63d3636). Deno 2.9.1.

## Verdict table

| Approach | Works? | Upgrade path | MIT obligations | Cloudflare code XMD owns |
|---|---|---|---|---|
| 1. Direct import of published `@cloudflare/computer@0.1.1` | **No** — every entry/deep path either hits `ERR_UNSUPPORTED_ESM_URL_SCHEME` (`cloudflare:`) or `ERR_PACKAGE_PATH_NOT_EXPORTED`; and 3 of the 4 needed symbols aren't exported at all | `npm i` (moot) | None beyond upstream's own tarball | Zero |
| 2. Tree-shaken esbuild bundle of the published package | **Half** — bundle loads under Deno with exactly 1 trivial stub, but only `SQLiteWorkspaceProvider` is reachable; `Database`/`initializeSchema`/`WorkspaceFilesystem` are unexported, so the schema can never be created | `npm i` + re-bundle + re-prove the stub-is-dead-code fact each release | LICENSE text must ship next to the bundle (embeds CF source) | Stub + build script + a hand-rolled `Database` duck-type + reimplemented schema DDL (DOFS internals) |
| 3. Pinned vendored copy of `packages/dofs` | **Yes** — tsc build clean; all 4 symbols import under Deno; schema v5 initializes over in-memory `node:sqlite`; `npm pack` tarball + bare-specifier consumer also works | Re-vendor from upstream tag + rebuild + re-run tests (manual, diffable — src is unmodified) | Copy root LICENSE into the vendored dir + provenance note (VENDOR.txt) | 48 files / 6,554 LOC of unmodified src + ~40 lines of package/tsconfig scaffolding |
| 4. Upstream `./dofs` subpath export (or publishing `@cloudflare/dofs`) | **Yes (proven mechanically)** — a 3-line rolldown entry + package.json exports entry yields a `dofs.js` whose chunk graph is 100% cloudflare:-free; runs under Deno, schema initializes | `npm i @cloudflare/computer` once accepted; Approach 3 vendored copy in the interim | None beyond upstream's tarball | Zero (after acceptance) |

## License facts

Single `LICENSE` at the monorepo root; **no per-package LICENSE files** anywhere
(`find cf-computer -iname 'LICENSE*'` returns only the root file, and
`packages/dofs/package.json` has no `license` field — it is `"private": true`,
version `0.0.0`). The published `@cloudflare/computer` package.json declares
`"license": "MIT"` but the npm tarball ships **no LICENSE file** (files: dist,
README.md only).

Root LICENSE text: `MIT License Copyright (c) 2026 Cloudflare, Inc.` followed by
the standard MIT grant. Its condition:

> The above copyright notice and this permission notice (including the next
> paragraph) shall be included in all copies or substantial portions of the
> Software.

So any redistribution of DOFS code (vendored source OR a bundle containing it)
must carry, verbatim: the line `MIT License Copyright (c) 2026 Cloudflare, Inc.`,
the permission notice, **and** the warranty-disclaimer paragraph (the "next
paragraph" is explicitly pulled into the retention requirement). Placing a copy
of the root LICENSE file next to the vendored/bundled code plus a provenance
header (upstream repo URL, tag, commit) satisfies this. No copyleft, no
source-disclosure duty; modifications are allowed.

## Approach 1 — direct import of the published package under Deno

Setup:

```sh
# approach1/package.json: { "type": "module" }
npm install --prefix approach1 @cloudflare/computer@0.1.1 @platformatic/vfs zod
# added 86 packages
```

### Dist inspection

`node_modules/@cloudflare/computer/dist` layout: `index.js`, `git.js`,
`artifacts/`, `assets/`, `backends/{container,worker-javascript,worker-shell}/`,
`observe/`, `tools/`, and six `shared-*.js` chunks (rolldown build).

- Chunks containing DOFS symbols (`initializeSchema`, `SQLiteWorkspaceProvider`,
  `vfs_nodes`): **only `dist/index.js` and `dist/git.js`**.
- `dist/git.js` merely *proxies* method calls to a `SQLiteWorkspaceProvider`
  instance; the class/schema definitions live **solely in `dist/index.js`**
  (regions `../dofs/src/errors.ts`, `../dofs/src/path.ts`, … are inlined there).
- `dist/index.js` line 6, top-level and unconditional:
  `import { RpcTarget as RpcTarget$1, WorkerEntrypoint } from "cloudflare:workers";`
- Files with `cloudflare:` scheme imports: `index.js`,
  `backends/container/index.js`, `backends/worker-javascript/index.js`,
  `backends/worker-shell/index.js`.
- No `shared-*` chunk carries the DOFS layer, so **no cloudflare:-free chunk
  containing DOFS exists in the published dist**.
- `dist/index.js` exports include `SQLiteWorkspaceProvider`, `Workspace`,
  `getWorkspace`, `withWorkspace` — but NOT `Database`, `initializeSchema`, or
  `WorkspaceFilesystem` (those are internal to the chunk).

### Runs

`import { Workspace, SQLiteWorkspaceProvider } from "@cloudflare/computer"`:

```
$ deno run --allow-all --node-modules-dir=manual approach1/import-main.ts
error: [ERR_UNSUPPORTED_ESM_URL_SCHEME] Only file and data URLs are supported by the default ESM loader. Received protocol 'cloudflare'
```

Deep import `@cloudflare/computer/dist/index.js`:

```
error: [ERR_PACKAGE_PATH_NOT_EXPORTED] Package subpath './dist/index.js' is not defined by "exports" in .../@cloudflare/computer/package.json
```

Direct file-path import `./node_modules/@cloudflare/computer/dist/index.js`
(bypasses the exports map):

```
error: [ERR_UNSUPPORTED_ESM_URL_SCHEME] Only file and data URLs are supported by the default ESM loader. Received protocol 'cloudflare'
```

**Verdict: does not work.** The only chunk that defines the DOFS layer
statically imports `cloudflare:workers`, and Deno's ESM loader rejects the
`cloudflare:` protocol. No published entrypoint or deep import yields the DOFS
layer under Deno without patching. (Upgrades would have been `npm i`-simple and
MIT notice duty would sit with Cloudflare's tarball, but the approach is moot.)

Additional blocker independent of the scheme problem: the published export
surface contains `SQLiteWorkspaceProvider` but **not** `Database`,
`initializeSchema`, or `WorkspaceFilesystem` — those never left `packages/dofs`
(`dist/index.js`'s export statement ends with `... SQLiteWorkspaceProvider,
TestBackend, Workspace, ... getWorkspace, noopObserver, sh, shellQuote,
withWorkspace`).

## Approach 2 — tree-shaken esbuild bundle of the published package

Setup: `approach2/package.json` with `@cloudflare/computer@0.1.1`,
`@platformatic/vfs`, `zod`, devDep `esbuild@0.28.1`; `npm install --prefix
approach2`. Facade (`facade.ts`):

```ts
export { SQLiteWorkspaceProvider } from "@cloudflare/computer";
```

(Only symbol of the four we need that the package exports — see Approach 1.)

### Round 1 — externals only

```sh
./node_modules/.bin/esbuild facade.ts --bundle --format=esm --platform=neutral \
  --main-fields=module,main --conditions=import \
  '--external:cloudflare:*' '--external:node:*' --outfile=bundle.js
# bundle.js  150.2kb
```

Output still contains (line 2501):
`import { RpcTarget as RpcTarget$1, WorkerEntrypoint } from "cloudflare:workers";`
— but grep shows **neither `RpcTarget$1` nor `WorkerEntrypoint` is referenced
anywhere else in the bundle**: esbuild keeps external imports for potential side
effects; the symbols themselves are fully tree-shaken.

### Round 2 — one stub via alias

Stub `stub-cloudflare-workers.ts` (empty `RpcTarget`, `WorkerEntrypoint`,
`DurableObject` classes) + `'--alias:cloudflare:workers=./stub-cloudflare-workers.ts'`
instead of the external. Result: `grep -c "cloudflare:" bundle.js` → **0**.
Exactly **one stub**, and it does not touch DOFS internals (its symbols are
dead code in the bundle).

### Run under Deno

`run-bundle.ts` constructs `SQLiteWorkspaceProvider` over a hand-rolled
duck-type of the (unexported) `Database` interface backed by
`node:sqlite` `DatabaseSync`:

```
$ deno run --allow-all approach2/run-bundle.ts
provider constructed: SQLiteWorkspaceProvider { supportsSymlinks: true, supportsWatch: true }
statSync without schema fails as expected: no such table: vfs_nodes
```

**Verdict: half-works, not viable as the sole source.** The bundle is
cloudflare:-free with a single trivial stub and loads under Deno — but
tree-shaking follows the *export surface*, and the published surface exposes
only 1 of the 4 needed symbols. `initializeSchema`'s body is not even present
in the bundle (only an error-message string mentioning it), so the schema can
never be created through this path; `Database` and `WorkspaceFilesystem` are
likewise unreachable. XMD would have to reimplement the Database wrapper and
the entire schema DDL from DOFS internals — at which point it owns the very
code it tried to reuse. Also drags in ~2.5k lines of capnweb RPC runtime the
DOFS layer doesn't need. Upgrades: `npm i` + re-bundle + re-verify stub
assumptions each release (the "unused import" fact must be re-proven per
version — brittle). MIT: the bundle embeds Cloudflare source, so the LICENSE
text must ship next to `bundle.js`.

## Approach 3 — pinned vendored copy of `packages/dofs`

### Build steps

```sh
cp -R cf-computer/packages/dofs approach3/dofs
cp cf-computer/LICENSE approach3/dofs/LICENSE          # root LICENSE, verbatim
# + VENDOR.txt (upstream URL, tag v0.1.1, commit 63d3636, list of local changes)
# package.json edits: drop "private", version 0.0.0-vendored.63d3636,
#   license: MIT, files: [dist, LICENSE, VENDOR.txt, README.md],
#   devDeps: typescript ^5.9.2 + @types/node (upstream wants typescript ^6 +
#   workers-types + vitest — none needed for the build)
# tsconfig.vendored.json = upstream tsconfig.build.json merged with base,
#   with types: ["node"] instead of [workers-types, vitest, node, pool-workers]
npm install --prefix approach3/dofs        # 3 packages
approach3/dofs/node_modules/.bin/tsc -p tsconfig.vendored.json   # clean, no edits to src/
```

Source is fully self-contained: zero runtime deps, no `cloudflare:` imports,
storage abstracted behind its own `DurableObjectStorageLike` interface
(src/types.ts); the only Cloudflare types mentioned are in comments.
`src/testing.ts` (part of the `./testing` export) is backed by `node:sqlite` —
usable as-is under Deno.

### Import-and-construct under Deno (direct dist path)

```
$ deno run --allow-all approach3/run-vendored.ts
schema initialized: version 5 (SCHEMA_VERSION = 5)
tables: _vfs_fetch_cursor, _vfs_mounts, _vfs_watermark, sqlite_sequence, vfs_blob_bytes, vfs_blobs, vfs_changes, vfs_chunks, vfs_dirents, vfs_manifests, vfs_meta, vfs_nodes
provider constructed: SQLiteWorkspaceProvider
WorkspaceFilesystem loaded: function
```

All four symbols reachable: `Database`, `initializeSchema`,
`SQLiteWorkspaceProvider` from the root export; `WorkspaceFilesystem` too
(root export, src/index.ts line 5). One API gotcha hit while consuming the
untyped dist: `initializeSchema(db, now)` requires the `now: () => number`
argument (first run: `TypeError: now is not a function` from
dist/schema/index.js line 45); the .d.ts files catch this in typed consumers.

### Packaging variant (npm pack → tarball consumer)

```sh
(cd approach3/dofs && npm pack --pack-destination ..)
# cloudflare-dofs-0.0.0-vendored.63d3636.tgz — 100 files
# consumer/package.json: "@cloudflare/dofs": "file:../cloudflare-dofs-....tgz"
npm install --prefix approach3/consumer    # 1 package
deno run --allow-all --node-modules-dir=manual approach3/consumer/main.ts
# → bare-specifier import OK: SQLiteWorkspaceProvider function 5
```

Friction: only the package.json fixes already listed (name kept as
`@cloudflare/dofs` so import specifiers match upstream; `private` removed;
`files` added). Bare specifiers `@cloudflare/dofs` and
`@cloudflare/dofs/testing` both resolve under Deno with a node_modules dir.

### Upgrade consumption / owned surface

Upgrade = re-copy `packages/dofs/src` from the new upstream tag, re-apply the
two scaffold files (package.json, tsconfig.vendored.json — src itself is
unmodified so `diff -r` against upstream is clean), rebuild, re-run XMD's
adapter tests. Owned surface: **48 source files, 6,554 LOC** (src minus
`*.test.ts`, `bench/`, `with-db.workers.ts`) — owned in the "must re-vendor and
re-verify" sense, not forked. MIT: LICENSE copy + provenance note as above.

## Approach 4 — upstream package/export change

### What the published dist shows (from Approach 1/2)

A pure package.json `exports` addition is **not** sufficient today: the v0.1.1
dist has no cloudflare:-free chunk containing DOFS (the layer is inlined into
`dist/index.js`, which imports `cloudflare:workers` at top level). A build
change is required — one new rolldown entry.

### Mechanical proof (COPY of packages/computer, clone untouched)

Copied `packages/{computer,dofs,rpc}` into `approach4/`. Added
`src/dofs-entry.ts` (`export * from "@cloudflare/dofs";`) and a probe rolldown
config = the original with `dofs: "src/dofs-entry.ts"` added to `input`
(entries trimmed to index+git+dofs; dts plugin dropped — it needs the monorepo
type env, irrelevant to the chunk-graph question; also added two alias lines
for `@cloudflare/computer-rpc/{client,debug}` that the trimmed install needed).

```
$ ./node_modules/.bin/rolldown -c rolldown.probe.config.ts
dofs.js 2.67 kB · shared-DtkNvqpY.js 107.79 kB · index.js 111.29 kB · git.js 102.42 kB ...
```

Rolldown hoists the entire DOFS layer into `shared-DtkNvqpY.js`;
`dofs.js` re-exports the **full** `@cloudflare/dofs` surface (Database,
initializeSchema, SQLiteWorkspaceProvider, WorkspaceFilesystem,
RecordingStorage, sync/*, …). `grep -c "cloudflare:"` per chunk in the dofs
graph: `dofs.js` 0, `shared-DtkNvqpY.js` 0 (its only imports are `node:crypto`,
`node:events`); `cloudflare:workers` remains confined to `index.js`. Run proof:

```
$ deno run --allow-all approach4/run-dofs-entry.ts
dofs entry under Deno OK: SQLiteWorkspaceProvider function function schema v5
```

### Draft upstream diff (what we'd ask Cloudflare for)

```diff
--- a/packages/computer/src/dofs.ts
+++ b/packages/computer/src/dofs.ts   (new file)
@@ -0,0 +1,4 @@
+// Runtime-neutral re-export of the DOFS layer. This entry's module
+// graph must stay free of cloudflare:workers so non-workerd runtimes
+// (Node, Deno, Bun) can consume the SQLite filesystem directly.
+export * from "@cloudflare/dofs";

--- a/packages/computer/rolldown.config.ts
+++ b/packages/computer/rolldown.config.ts
@@ export default defineConfig({
   input: {
     index: "src/index.ts",
+    dofs: "src/dofs.ts",
     git: "src/git/index.ts",

--- a/packages/computer/package.json
+++ b/packages/computer/package.json
@@   "exports": {
     ".": {
       "types": "./dist/index.d.ts",
       "import": "./dist/index.js"
     },
+    "./dofs": {
+      "types": "./dist/dofs.d.ts",
+      "import": "./dist/dofs.js"
+    },
```

(Optionally a CI guard: `grep -L cloudflare: dist/dofs.js` + its chunk
imports.) The simpler alternative ask — publish `@cloudflare/dofs` itself —
is equally proven: Approach 3 showed the package builds standalone with plain
tsc and zero runtime deps; upstream would only delete `"private": true` and add
`license`/`repository`/`files` fields.

### Interim story

Until Cloudflare accepts either change, ship Approach 3's vendored copy; the
vendored import surface (`@cloudflare/dofs`) is specifier-identical to the
published-package future, so the eventual migration is a dependency swap, not a
code change. (If they add `./dofs` instead of publishing the package, migration
is a one-line import-path change to `@cloudflare/computer/dofs`.)

## Files in this probe

- `approach1/` — npm consumer of the published package + 3 failing Deno import scripts
- `approach2/` — facade, stub, esbuild bundle, Deno runner
- `approach3/dofs/` — vendored build; `approach3/consumer/` — tarball consumer; `run-vendored.ts`
- `approach4/computer-copy/` — probe rolldown build (`dist-probe/`); `run-dofs-entry.ts`
