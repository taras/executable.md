# Vendored: @cloudflare/dofs

- Source: https://github.com/cloudflare/computer, `packages/dofs`
- Tag: `v0.1.1`, commit `63d363632e558f7e077794988d36ed75017c2a62`
- License: MIT (Cloudflare, Inc.) — see [LICENSE](LICENSE), copied from the
  repository root; the package directory carries no separate license file.
- Local modifications, in full:
  - `package.json`: devDependencies trimmed to `typescript`,
    `@cloudflare/workers-types`, `@types/node` (the upstream set fails
    `npm install` on an ERESOLVE conflict between `wrangler@4.119` and
    `@cloudflare/workers-types@^4`; the removed packages are test-only), and
    the vitest/wrangler scripts dropped with them.
  - `tsconfig.build.json`: `types` pinned to
    `["@cloudflare/workers-types", "node"]` so the build resolves without
    the removed dev dependencies.
  - `package.json`: a `./fs/rename` exports entry added — upstream's
    `index.ts` does not re-export `rename`, and the spike consumes the
    package through its exports map.
  - No source file under `src/` is modified.
- Upgrade procedure: re-copy `packages/dofs` from the new upstream tag,
  re-apply the two manifest edits above, rebuild, re-run
  `deno task spike:349:test`.
