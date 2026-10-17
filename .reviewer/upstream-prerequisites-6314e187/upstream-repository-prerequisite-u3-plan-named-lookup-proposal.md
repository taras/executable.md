# U3 accepted host Syntax setup

**Accepted on 2026-10-14. A3 is closed.** The Product Owner explicitly approved this host setup helper. The [architecture resolution](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md) records the decision and continuation of the already authorized U3 implementation. This document retains the proposal's rationale and feasibility evidence.

Plan needs to explain the program it is preparing for `xmd run`, including components its smaller authorship execution cannot run. A symbols override changes reported availability; it does not replace the enclosing catalog used for named metadata. Calling the public pure selector from CLI also loses core's safe unknown-name classification. The [A3 request and original probe](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-request.md) demonstrate both problems.

## The boundary decision

This triggers the Architect's system-boundary interview because it adds a cross-package setup operation and permits a host to bind its lazy descriptive profile to core's canonical named lookup. The inventory is one operation with one input: the lazy source of the host's complete SyntaxSymbols. The existing scoped documentation contributions remain with their package bootstraps; no second public catalog input is added.

Accepted export from `@executablemd/core/host`:

```ts
function useSyntax(
  source: () => Operation<SyntaxSymbols>,
): Operation<void>;
```

`Syntax` and `SyntaxApi` remain the accepted descriptor and three-member interface exported through `/api`. The helper supplies ordinary defaults for that API; it does not add a member or return a handle. The old `SyntaxSymbolsProvider` alias is not required by this signature.

Calling `useSyntax` captures the calling scope's existing documentation contributions and binds a private core reference to the supplied lazy source. It installs ordinary symbols/documentation provider middleware in that scope. It does not call the source until a live lookup asks. Text continues to render effective contextual symbols through the shared default.

Core owns selection, rendering and the narrow refusal boundary. A successful source followed by core's own unknown-name selection becomes the existing private SyntaxSelectionRefusal. A source or middleware throw propagates unchanged, including one named UnknownComponentError. The refusal class stays private and the durable protocol stays `{ symbols }` / `{ refused }`.

This explicitly permits one public descriptive setup function in U3. It permits no public catalog property, installation member, generic cache, dependency change, authorization flag, scope hook or repository forwarding. The helper and its private reference decide no execution authority.

## Provider ordering and scope ownership

The execution-derived reference is the API's private fallback, not descendant provider middleware that shadows an already installed host profile. The helper installs its providers at `min`, so ordinary nearer providers and generated symbols narrowing keep their intended ordering.

A generated subtree narrows only the effective symbols provider. It must not replace the enclosing named-documentation owner with the restricted execution's catalog. Thus a generated request can document a target-run component while marking it unavailable. Ordinary middleware can still answer, delegate or transform both operations, and synthetic answers skip the source.

The existing private reference retains A2's per-occurrence basis reuse: one lazy source resolution for metadata, one contextual symbols read for availability, and independent resolutions for later occurrences. Leaving the owning scope restores the enclosing providers. Completed Syntax replay restores final text without calling this live source. No low-level Effection instrumentation is involved.

## CLI and Plan placement

CLI keeps a private command-profile setup function that enters the target run's declarative bootstraps, captures its registry/declaration selection inputs and installs `useSyntax` in a bounded scope. The source inspects those captured target inputs lazily; it does not inspect the restricted authoring execution's later registry. Capture documentation from that same target assembly before leaving it. Do not hide all bootstrapping inside a temporary symbols callback whose documentation contributions vanish before the helper can capture them.

`xmd syntax` uses that assembly before reading JSON, text or named documentation through the Syntax API. It starts no execution or operational setup merely to inspect syntax.

Standalone Plan installs the same target-run descriptive setup in its existing bounded command scope before `executeInstalled`. Its source callback can remain an ordinary private host dependency with an immediate consumer; it is no longer an `ExecutionInstallation` member and has no count rule. Direct command fixtures install the helper with their own lazy source. Embedded Plan retains its enclosing execution's descriptive profile. No setup function is forwarded through runXmd or ReplExecutionProfile, and no second provider registry is added.

## Feasibility evidence

The [typed prototype](u3-a3-use-syntax-prototype.ts) exposes exactly the proposed signature. The [probe](u3-a3-host-binding-probe.ts) drives protected Syntax, generated Evaluate, the existing private refusal class and actual durable records. A [temporary import map](u3-a3-prototype.imports.json) supplies prototype modules outside the repository.

```sh
deno check --frozen --cached-only --node-modules-dir=manual --import-map=/private/tmp/xmd-pr181-bench-rXAXyb/u3-a3-prototype.imports.json --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-a3-host-binding-probe.ts
deno run --allow-all --frozen --cached-only --node-modules-dir=manual --import-map=/private/tmp/xmd-pr181-bench-rXAXyb/u3-a3-prototype.imports.json --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-a3-host-binding-probe.ts
```

Both exit 0. [Typecheck output](u3-a3-host-binding-probe-check-projection.log) and [runtime output](u3-a3-host-binding-probe-run-projection.log) show:

| Check | Result |
| --- | --- |
| Host-only metadata | The actual Syntax record contains the host's component; source and effective symbols each resolve once. |
| Generated narrowing | The same enclosing metadata remains documentable and is marked unavailable. Each input resolves once. |
| Canonical unknown name | The generated Syntax record retains `status: ok` with `{ refused }`; the projection failure also carries the exact retry reason Plan reads through `tryContent()`. |
| Source throws UnknownComponentError | The record retains `status: err`; the throw is not converted into a safe refusal. |
| Synthetic named answer | No source or effective-symbol lookup. |
| Two moving occurrences | Two distinct successful records, with exactly two source and two effective-symbol reads. |
| Completed replay | No source or effective-symbol read, even with a source that would throw. |

The prototype copies the partial `execute.ts` and `syntax-reference.ts` into temporary files, changes root fallback/narrowing installation, adds only the private profile-reference construction and proposed setup function, and leaves refusal classification in the existing owner. For typechecking, its temporary execute copy also restores the three baseline installation fields absent from the unfinished partial interface and guards its optional environment reference. Those unfinished-source errors are visible in [the retained intermediate output](u3-a3-host-binding-probe-check-imports.log); no production typecheck PASS is claimed. The [first import-map failure](u3-a3-host-binding-probe-check.log) is retained too. An [intermediate assertion](u3-a3-host-binding-probe-run-retry.log) incorrectly looked for the retry mark on the public execution diagnostic; the final probe observes the projection failure through `tryContent()`, which is the boundary Plan actually uses. No worktree source was edited for this proof.

This is architecture feasibility evidence, not a feedback commit or the full Plan PI10 journey. The unchanged frozen U3-6, U3-7 and U3-10 rows still require their production evidence, including the existing unknown-name retry followed by review. No new acceptance row is added.

## Decision and next action

Accepted: `useSyntax(source)` at core's existing `/host` boundary, with the ownership and behavior above. It lets Plan reuse core's real named lookup while keeping catalog ownership and refusal classification private.

The explicit approval amends the frozen handoff's public-boundary exclusion for this one setup function. It introduces no reusable architecture rule.

The Architect has recorded the bounded A3 amendment. The Planner incorporates only the affected host binding, ordering and migration instructions, preserving U3-1–U3-12 and the frozen commands. The Implementor resumes the same already authorized worktree and fixes/completes its partial source before running that evidence. No repeated implementation authorization is required.

Base remains `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`. The worktree remains at that base with the same nine partial core files modified/new and no feedback commit. A2 remains closed. No repository implementation, dependency state, Git state, CI or GitHub mutation occurred for this proposal. Publication/merge and U4 remain separate; #902 stays held through U3–U5 and forwarding removal.
