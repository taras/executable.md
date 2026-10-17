# U3 Plan named lookup architecture resolution

**A3 is closed.** On 2026-10-14 the Product Owner explicitly approved the [host Syntax setup proposal](upstream-repository-prerequisite-u3-plan-named-lookup-proposal.md). Plan can bind its target-run descriptions through `useSyntax(source)` while core retains canonical named selection and safe refusal handling. U3 implementation can resume under its existing authorization after the Planner incorporates this bounded amendment.

## Accepted host setup operation

Export one setup operation from `@executablemd/core/host`:

```ts
function useSyntax(
  source: () => Operation<SyntaxSymbols>,
): Operation<void>;
```

The input supplies the host's complete descriptive profile lazily. Setup captures and snapshots the calling scope's existing documentation contributions and binds them to the source through core's private reference owner. It installs ordinary scoped symbols and named-documentation providers without reading the source. Default text renders effective contextual symbols. `Syntax` and its accepted three-member `SyntaxApi` remain exported through `/api`; the helper adds no API member or returned handle.

This is the sole public setup-boundary amendment to U3. The old `ExecutionInstallation.symbols` member and provider count rule are removed. There is no public catalog property, additional installation collection, generic cache, dependency change, authorization flag, scope instrumentation or repository-function forwarding. The `SyntaxSymbolsProvider` alias is not required by this signature. Descriptions confer no generated execution authority.

## Reference ownership and provider ordering

Core owns named selection, rendering and refusal classification. Only core's own unknown-name selection after successful source resolution becomes the existing private `SyntaxSelectionRefusal`. Source or middleware failures remain terminal, including a provider-thrown `UnknownComponentError`. The refusal class remains private. Syntax keeps its existing durable `{ symbols }` / `{ refused }` protocol and records the final middleware answer.

The execution-derived reference supplies the API's private fallback. It must not be installed as inner middleware that shadows an enclosing host profile. `useSyntax` installs its providers at `min`; ordinary nearer middleware can answer, delegate or transform them. Generated scopes narrow symbols only and preserve the enclosing named-documentation owner. A target-run component can therefore remain documentable while its availability annotation says it is unavailable in the generated scope.

Each named occurrence resolves its authoring basis once and effective contextual symbols once. Later occurrences resolve independently. Synthetic answers skip default inspection. Leaving the owning scope restores enclosing providers. Completed Syntax replay returns recorded final text without querying a live source. These retain A2's accepted private per-occurrence ownership and ordinary contextual dispatch.

## CLI and Plan placement

CLI's private command-profile setup enters the target run's declarative bootstraps, captures the registry/declaration inputs, and calls `useSyntax` while that assembly's documentation contributions are still in scope. Its lazy source inspects those captured target inputs. Bootstrapping only inside a temporary symbols callback would lose documentation before setup captures it and is insufficient.

`xmd syntax` uses this assembly for JSON, Markdown and named inspection without starting an execution or operational providers merely to print syntax. Standalone Plan installs the same descriptive setup in its existing bounded command scope before `executeInstalled()`. An ordinary private host source callback with an immediate consumer may remain; it is not an execution installation member. Direct command fixtures install their own lazy source. Embedded Plan retains its enclosing descriptive profile. No setup callback is forwarded through `runXmd` or `ReplExecutionProfile`.

Plan's structural validation and trusted Files/Permissions reads remain unchanged. Its retired read grants and Effection Scope observer stay removed. Execution.init, protected Syntax invocation, publication/secret handling and U4/U5 boundaries remain settled.

## Evidence and implementation boundary

The accepted proposal records the exact prototype commands and retained intermediate failures. The final [typecheck](u3-a3-host-binding-probe-check-projection.log) and [runtime proof](u3-a3-host-binding-probe-run-projection.log) both exit 0. The probe drives protected Syntax, generated Evaluate and actual durable records. It demonstrates host-only metadata, generated availability, safe canonical unknown-name refusal at Plan's `tryContent()` recovery boundary, terminal provider failure, synthetic answers, independent moving occurrences and passive completed replay.

These temporary modules demonstrate feasibility. They do not establish that the unfinished production tree typechecks or that the complete Plan PI10 journey passes. Frozen rows U3-1–U3-12 and focused commands are unchanged; U3-6, U3-7 and U3-10 already cover the affected consequences. The Implementor supplies that production evidence before the signed feedback commit.

## Continuity and next action

Implementation branch: `agent/upstream-u3-contextual-syntax`, worktree `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/u3-contextual-syntax`. Observed HEAD and base remain landed U2 `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`, tree `f3562253edc8310370d5459416abe8ad23769805`, with nine partial core files modified/new and no feedback commit. This is an accepted architecture decision, not an implementation-review verdict.

The Current contract, Syntax summary, handoff and planning status now reference A3's resolution. The Planner owns final incorporation of the affected host binding, provider ordering and migration instructions while preserving the frozen evidence. The Implementor then resumes the same prepared worktree under the existing authorization, completes its partial implementation and returns the signed feedback revision with every focused command/result. No repeated implementation authorization is required.

This acceptance changed architecture/planning artifacts only. No production source, dependencies, Git state, CI or GitHub publication was changed. Architect and Product Owner implementation reviews, delivery verification, publication and explicit merge approval remain separate. U4 waits for landed U3; #902 stays held through U3–U5 and removal of consumer-owned forwarding.
