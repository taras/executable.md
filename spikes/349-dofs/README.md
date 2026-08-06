# Spike 349: Cloudflare DOFS directly in Deno

Proves that Executable.md can host a persistent SQLite Workspace directly in
the Deno process by reusing Cloudflare Computer's DOFS filesystem layer over
a file-backed `node:sqlite` adapter — no `workerd`, no Node, no Wrangler.
Compares this topology with the bundled-`workerd` evidence in #347 / PR #348
for the decision in #346. Findings live in
[evidence/EVIDENCE.md](evidence/EVIDENCE.md).

## Run it

From the repository root:

```bash
deno task spike:349          # vendor-build + compile + test
```

Stepwise: `deno task --cwd spikes/349-dofs vendor` installs the vendored
package's build toolchain and compiles it with `tsc`;
`deno task spike:349:build` compiles `dist/proof`;
`deno task spike:349:test` runs the scenario suite. One prerequisite the
tasks assume: `npm install --install-links --no-audit --no-fund` in this
directory (dependencies are npm-owned here — see Layout).

The proof executable performs one filesystem op per invocation against a
workspace database file, so consecutive invocations are full restart cycles:

```bash
dist/proof /tmp/ws.db write /notes/a.md "alpha"
dist/proof /tmp/ws.db read /notes/a.md
dist/proof /tmp/ws.db ls /notes
```

## Layout

- `vendor/dofs/` — pinned vendored copy of `packages/dofs` from
  cloudflare/computer `v0.1.1` (`63d3636`), MIT; provenance, the two manifest
  edits, and the upgrade procedure are in
  [vendor/dofs/PROVENANCE.md](vendor/dofs/PROVENANCE.md). Source files are
  unmodified.
- `host/file-storage.ts` — the entire adapter: a file-backed
  `DurableObjectStorageLike` over Deno's `node:sqlite` (~100 lines,
  mirroring upstream's own in-memory test fixture).
- `host/main.ts` — the proof CLI; `host/types/` — typed facade for the
  consumed surface (Deno pairs `.js` with `.d.ts` for registry packages but
  not `file:`-resolved ones).
- `tests/spike.test.ts` — the scenario suite backing the evidence.
- `evidence/probes/` — raw probe ledgers with every command and error.

This spike uses npm-owned dependencies (`nodeModulesDir: "manual"`,
`package.json` + `package-lock.json`) because the vendored package is
consumed as a `file:` dependency through its exports map — itself part of
the reuse-boundary evidence. The directory stays outside the workspace via
the root `deno.json` `exclude`, so the four verification gates keep their
scope.
