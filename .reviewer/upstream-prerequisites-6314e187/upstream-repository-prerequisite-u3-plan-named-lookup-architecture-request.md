# U3 A3 — Plan's target-run named lookup

**A3 closed on 2026-10-14.** The Product Owner approved `useSyntax(source)` at `@executablemd/core/host`. The [accepted architecture resolution](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md) supersedes this request's hold and resolution-needed language. The request and original probe remain the evidence for the gap.

Read this to resolve a demonstrated gap in the frozen U3 handoff before implementation continues. Plan must describe its target run catalog through the new contextual Syntax API, and an unknown documentation request must retain its safe, retryable refusal. The handoff does not identify an accessible binding route that satisfies both without changing an excluded public boundary.

## Applies to

U3-6, U3-7 and U3-10, specifically the migration of Plan's existing `ExecutionInstallation.symbols` contribution to symbols and named-documentation middleware. A2 remains closed. Execution.init, its ownership, Permissions, trusted Plan reads, generated admission and U4/U5 remain settled.

Implementation was authorized by the Product Owner's “yes” after the finalized handoff. Publication and merge are not authorized.

## Exact state

- Base and verified remote main: `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`, tree `f3562253edc8310370d5459416abe8ad23769805`.
- Branch: `agent/upstream-u3-contextual-syntax`.
- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/u3-contextual-syntax`.
- Worktree HEAD remains the base. Nine core files are modified/new, uncommitted; no feedback commit, remote branch or PR was created.
- Setup completed. The first sandboxed attempt could not reach npm and was stopped; the network-enabled setup completed. Logs: `u3-setup.log`, `u3-setup-network.log`. No dependency version, lockfile, setup script or generated tracked file changed.
- Root workspace edits and other branches/worktrees remain untouched.

## The required behavior

The frozen handoff removes `ExecutionInstallation.symbols` and its count rule. It requires `runPlanCommandDocument()` to install target-run symbols and named documentation through ordinary scoped Syntax middleware before execution. Named metadata must continue to come from the target run catalog, rather than the restricted authorship execution's catalog. Effective symbols determine availability.

It also preserves core's distinction between canonical selection refusal and provider failure, and explicitly excludes a new public catalog input or installation member.

Existing `packages/cli/tests/plan-command-document.test.ts`, PI10, requires an unknown requested component to produce one retry and then reach review. Existing Syntax/Plan evidence separately requires provider failures to remain terminal. Treating all `UnknownComponentError` instances as safe would violate that distinction.

## What the source provides

At the exact base:

- `core/src/syntax-reference.ts` privately owns the lazy authoring catalog, captured documentation and canonical named selection. Only its named method restates a successful-provider/failed-selection result as `SyntaxSelectionRefusal`.
- `core/src/components/Syntax.ts` recognizes that class inside the durable callback and records `{ refused }`. Other thrown failures remain operation errors.
- `core/src/syntax-refusal.ts` is not exported by core's root, `/api` or `/host`.
- Core's existing public `selectDocumented` is the pure `select()` export. Unknown names throw ordinary `UnknownComponentError`; it does not supply the canonical safe classification.
- CLI's existing `renderSyntaxDocumentation()` calls that public selector directly. It works for CLI diagnostics, where no Plan retry classification is required.
- Core's public exports do not expose the private reference constructor or a way to bind a host's target-run catalog to its canonical named default.

Replacing only the symbols provider cannot preserve named metadata: the new default's enclosing authoring catalog remains the restricted execution's catalog, and the accepted symbols override changes availability rather than replacing that catalog.

## Executed probe

[Probe source](u3-plan-named-provider-boundary-probe.ts) and [successful output](u3-plan-named-provider-boundary-probe-result.log). It uses the partially implemented production Syntax dispatch and actual protected Syntax/durable paths, with the current public selector and renderer. It does not add a product hook or change classification.

```sh
deno run --allow-all --frozen --cached-only --node-modules-dir=manual --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-plan-named-provider-boundary-probe.ts
```

Exit 0, with these distinct retained results:

| Provider | Requested name | Retained `syntax_symbols` result |
| --- | --- | --- |
| Core canonical default | Missing | `status: ok`, value `{ refused: ... }` |
| Ordinary named middleware using public `selectDocumented` | Missing | `status: err`, error `UnknownComponentError` |
| Same named middleware, positive control | Syntax | `status: ok`, value `{ symbols: ... }` |

`PrintErrors` lets the probe inspect all three records; it does not turn the second record into the safe classification Plan's information recovery consumes. The known-name control shows that dispatch and selection are running, rather than the custom provider simply being absent.

First probe outputs are retained too: `u3-plan-named-provider-boundary-probe.log` found an import cycle in my first partial implementation, and `u3-plan-named-provider-boundary-probe-after-cycle.log` found a mistaken event-field read in the probe. The cycle is corrected by keeping reference installation in the Syntax API module with a type-only reference import; the probe reads `event.description.type` now. Neither earlier output is evidence for A3. No product test group or feedback typecheck has passed yet.

## Resolution needed

The Architect must identify the supported route for binding Plan's target-run catalog to canonical named lookup, or explicitly amend the excluded public boundary. The implementation must retain lazy per-occurrence construction, one authoring basis and one effective symbols read, safe canonical unknown-name refusal, terminal provider failures, and the existing journal protocol.

Recommendation: permit a narrowly scoped setup helper owned by the existing reference/catalog implementation, exposed at the appropriate existing host boundary, that installs the ordinary Syntax defaults for a host's lazy descriptive profile. This is an explicit public-helper amendment to the frozen exclusion, so it is not implemented on inference. It must not add a catalog property, general cache, authorization flag, generated authority, forwarding API or dependency.

Do not export the refusal class as a provider escape hatch, classify failures by error name/message, or preserve the old aggregate input as an unapproved temporary bridge.

## Continuity and next action

The authorized U3 implementation returned A3 under `.agents/implementor.md`'s requirement to return a required public-contract change or plan contradiction. The accepted helper now supplies the missing Plan binding route. A2's Operation-valued property resolution is unaffected. Frozen rows U3-1–U3-12 remain unchanged; no new acceptance row is added.

Next: Planner incorporates the accepted resolution; Implementor resumes the same authorized U3 worktree and completes the frozen evidence before a signed feedback commit. No repeated implementation authorization is required. Publication and merge remain separate, and no U4 work begins.
