# Vendored: Worker Shell filesystem adapter

- Source: https://github.com/cloudflare/computer,
  `packages/computer/src/backends/worker-shell/adapter.ts`
- Tag: `v0.1.1`, commit `63d363632e558f7e077794988d36ed75017c2a62`
- License: MIT (Cloudflare, Inc.) — see [LICENSE](LICENSE), copied from the
  repository root.
- `adapter.ts` is byte-identical to upstream
  (sha1 `c9ec5356d60ee7bc9aa3c5677320bf8c9aa4058c`). It has zero
  `cloudflare:*` imports — its only import is `import type` from
  `@cloudflare/dofs`, erased at build. It implements just-bash's
  `IFileSystem` over the structural `WorkspaceFs` interface (a subset of
  Cloudflare's `WorkspaceFilesystemStub`), which is exactly what makes it
  reusable outside a Worker.
- The spike supplies the `@cloudflare/dofs` types via the vendored dofs from
  the #349 spike and a small `WorkspaceFs` shim (`host/workspace-fs.ts`)
  that adapts the in-process DOFS `WorkspaceFilesystem` — adding the
  `exists`/`statOrNull`/`lstatOrNull` methods the adapter expects, which on
  Cloudflare come from the RPC stub rather than the base filesystem.
- Upgrade procedure: re-copy `adapter.ts` from the new upstream tag, confirm
  the `WorkspaceFs` interface at its top still matches the shim, re-run
  `deno task spike:351:test`.
