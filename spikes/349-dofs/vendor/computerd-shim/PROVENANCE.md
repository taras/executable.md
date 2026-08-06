# Vendored: computerd userspace shim (subset)

- Source: https://github.com/cloudflare/computer, `packages/computerd`
- Tag: `v0.1.1`, commit `63d363632e558f7e077794988d36ed75017c2a62`
- License: MIT (Cloudflare, Inc.) — see [LICENSE](LICENSE), copied from the
  repository root.
- This is a deliberate subset, named `@xmd-spike/computerd-shim` rather than
  `@cloudflare/computerd` because it is not the upstream package: it carries
  only the userspace mount shim.
- Contents:
  - `src/shim/shim.ts` — byte-identical to upstream
    `packages/computerd/src/shim/shim.ts`
    (sha1 `05e6a2acc0bdbd9970d7e1fea2c1e13d482b528d`).
  - `src/fuse/vfs.ts` — a five-line type-only stub replacing upstream's
    runtime module: shim.ts imports only the `NodeVirtualFileSystem` type
    from it, which upstream aliases to `@platformatic/vfs`'s
    `VirtualFileSystem`. The runtime wiring upstream keeps in that module
    (prototype splice + method forwarding) lives in this spike's
    `host/vfs-wiring.ts` instead, ported with its deviations documented
    in-file.
  - `package.json` / `tsconfig.json` — authored here (upstream builds the
    whole computerd package CommonJS; this subset compiles standalone as
    ESM with `tsc`).
- Upgrade procedure: re-copy `shim.ts` from the new upstream tag, verify the
  type-only import of `../fuse/vfs.js` is still the only coupling, rebuild,
  re-run `deno task spike:349:test`.
