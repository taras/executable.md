# Spike 351: Worker Shell and Worker JavaScript natively in Deno

Tests whether Cloudflare Computer's two imperative execution backends can run
over the Deno-local DOFS Workspace from #349 — with no `workerd`, Wrangler,
Docker, or other JavaScript runtime. Both are **optional imperative extensions**
layered on the declarative durable core, not prerequisites for it; the spike
supplies evidence for #346, not a product decision. Verdicts and measurements
are in [evidence/EVIDENCE.md](evidence/EVIDENCE.md).

## Run it

From the repository root:

```bash
deno task spike:351          # vendor-build + compile + test
```

The compiled proof takes a workspace database path and one operation, so each
invocation is a full host restart against the same durable state:

```bash
dist/proof /tmp/ws.db fs-mkdir /workspace
dist/proof /tmp/ws.db fs-write /workspace/a.txt alpha    # host capability
dist/proof /tmp/ws.db shell "cat a.txt"                  # Worker Shell
dist/proof /tmp/ws.db js 'export default () => 42'       # Worker JavaScript
```

## Layout

- `vendor/worker-shell/adapter.ts` — Cloudflare's `WorkspaceFsAdapter`,
  byte-identical (MIT; see
  [PROVENANCE.md](vendor/worker-shell/PROVENANCE.md)). It is the whole reason
  the shell ports: zero `cloudflare:*` imports, and its filesystem contract is
  a structural interface rather than an RPC stub.
- `host/shell.ts` — the shell backend with Cloudflare's transport removed:
  no `WorkerEntrypoint`, no Workers RPC, no Dynamic Worker loader, because the
  workspace is in-process.
- `host/loader.ts` — a Deno port of `WorkspaceRuntimeLoader`: an in-memory
  module graph supplied as blob URLs with rewritten specifiers, run in a Deno
  Worker, with the filesystem capability crossing as async postMessage RPC.
- `host/workspace.ts`, `host/workspace-fs.ts` — the DOFS workspace and the
  small shim supplying the three stub-only methods the adapter expects.
- `tests/` — the scenario suite; `evidence/probes/` — the full probe ledgers
  with every command, escape attempt, and measurement.

The `@cloudflare/dofs` build is shared with the #349 spike rather than vendored
twice: `deno task --cwd spikes/351-worker-backends vendor` builds it there and
links it here. This directory stays outside the workspace via the root
`deno.json` `exclude`, so the four verification gates keep their scope.
