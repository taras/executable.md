# Cloudflare Computer DOFS provenance

This directory contains the production source closure used by Executable Markdown's local retained Workspace provider.

- Repository: `https://github.com/cloudflare/computer`
- Commit: `63d363632e558f7e077794988d36ed75017c2a62`
- Upstream path: `packages/dofs/src`
- License: MIT; the complete repository notice is copied as `LICENSE`.
- Retrieved: 2026-08-07

`upstream/src` preserves the selected upstream TypeScript files byte-for-byte. The selection is the transitive closure required by the DOFS database and schema, `WorkspaceFilesystem`, the mutation operations used by the adapter, and manifest/blob validation. It excludes garbage collection, backends, workers, workerd, Containers, Worker Shell, FUSE, benchmarks, and upstream tests.

The `.js` and `.d.ts` files in `generated` are deterministic artifacts emitted from those inputs by the repository-pinned TypeScript compiler. They exist because the upstream sources use emitted `.js` import specifiers. XMD's SQLite and transaction adapters remain outside this snapshot.

There are no source patches. `deno task vendor:verify` performs an offline digest, inventory, and generated-output comparison. It rejects missing, extra, changed, or unreproducible files.
