# Spike 347: bundle workerd into a compiled host

Proves that a single `deno compile` executable can carry a Cloudflare Worker,
its `workerd` configuration, and the host platform's `workerd` binary; launch
that Worker locally under supervision; and keep Durable Object and
`@cloudflare/computer` Workspace state across full process restarts.
Evidence for the bundled-local-host option in
[#346](https://github.com/taras/executable.md/issues/346); findings live in
[evidence/EVIDENCE.md](evidence/EVIDENCE.md).

## Run it

From the repository root:

```bash
deno task spike:347          # fetch + build + test
```

Or stepwise: `deno task spike:347:fetch` downloads the pinned `workerd`
binary for the host platform into `vendor/` and verifies its sha256 against
`manifest.ts`; `deno task spike:347:build` bundles the Worker with esbuild and
compiles `dist/proof`; `deno task spike:347:test` runs the scenario suite.

The proof executable itself:

```bash
dist/proof do "/increment" --state-dir /tmp/state          # one op, full start/stop cycle
dist/proof do "/fs/write?path=/a.txt&body=hi" --state-dir /tmp/state
dist/proof serve --state-dir /tmp/state                    # stays up until SIGTERM
dist/proof do "/exec?backend=worker-shell&source=echo+hi" --backends --state-dir /tmp/state
```

Every `do` invocation materializes the bundled files into
`~/.cache/xmd-spike-347/<workerd-version>/` (digest-checked), launches
`workerd` on an ephemeral loopback port, performs one HTTP op against the
bundled Worker, and tears the child down — so two consecutive `do` calls
already prove restart persistence.

## Layout

- `manifest.ts` — pinned `workerd` and `@cloudflare/computer` versions plus
  per-platform binary digests.
- `worker/worker.mjs` — the bundled Worker: one Durable Object
  (`withWorkspace` around `ctx.storage`) plus counter, `/fs/*`, and `/exec`
  routes. Worker-side code follows the Workers platform contract (async
  handlers), not repository Code Rule 1; the host and tests use Effection.
- `host/` — the compiled entrypoint: `materialize.ts` (embedded-file →
  digest-validated cache), `supervise.ts` (daemon + readiness via
  `--control-fd=1`), `main.ts` (CLI), `config.capnp` /
  `config-backends.capnp` (base and Worker-Loader configurations).
- `tests/spike.test.ts` — the scenario suite backing the evidence.

This directory is deliberately outside the workspace: the root `deno.json`
excludes `spikes`, so the four verification tasks keep their scope, and the
spike pins its own dependency set in its own `deno.lock`. The
"config file is not a member of the workspace" warning on spike tasks is that
separation, not a defect.
