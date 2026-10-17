# U3 Architect implementation review

**PASS** for `ac466780cda608eafe974951c13c09c02b2b1cd4`. The revision satisfies the settled U3 architecture, including the accepted A2 property types and A3 host setup boundary. No architecture blocker remains.

## Reviewed revision and authority

| Item | Verified value |
| --- | --- |
| Commit | `ac466780cda608eafe974951c13c09c02b2b1cd4` |
| Tree | `1d807b062a9d4608ff37dabbc4eab755d9b2f95e` |
| Parent and frozen base | `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`, landed U2 |
| Signature | `G` |
| Branch | `agent/upstream-u3-contextual-syntax` |
| Worktree | `.claude/worktrees/u3-contextual-syntax`, clean before and after the focused tests |
| Change against base | 31 files, +1538 / −394 |

Authority: the [Current contract](upstream-repository-reusable-interface-prerequisite.md#current-contract), [frozen U3 handoff](upstream-repository-prerequisite-u3-implementor-handoff.md), accepted [A2](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md) and [A3](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md) resolutions, and [stack plan](upstream-repository-prerequisite-stack-plan.md). The [Implementor report](upstream-repository-prerequisite-u3-implementor-revision-ac466780.md) and [Planner PASS](upstream-repository-prerequisite-u3-planner-review-ac466780.md) concern this same revision. The superseded draft is not the reviewed commit.

## Structural findings

Initialization keeps the existing invocation owner. `runInvocation()` owns the task and joined teardown (`execute.ts:3156`); `invoke()` copies the trusted contributions, binds callbacks, prepares the generated profile and arms revocation before dispatching init (`execute.ts:3560–3620`). Init precedes installation callbacks, documentation capture and public execution policy. Its public default is no-op. EI4/EI5 hold cleanup open and distinguish joined settlement from merely signalling cancellation. EI6, EI-REPL and EI-child establish independent execution state, ordinary inheritance and explicit isolated-child reassembly. No new owner, request, receipt or repository forwarding appears.

Syntax has the exact accepted three-member `Api<SyntaxApi>`, stable namespaced identity and reusable lazy property Operations (`syntax-api.ts:49–92`). The execution reference supplies the private fallback (`execute.ts:2719`, `syntax-api.ts:109`), so it does not shadow host middleware. `useSyntax(source)` at `/host` captures documentation and installs ordinary providers at `min` without resolving the source (`use-syntax.ts:33`). A2 and A3 are implemented without a dependency change, adapter or Effection Scope instrumentation.

Named lookup retains its private core owner. `referencing()` resolves one authoring basis, scopes its reuse, then reads effective symbols once for availability (`syntax-reference.ts:152`). Only its own selection after successful provider reads converts an unknown name into the private safe refusal. Provider failures, including provider-thrown `UnknownComponentError`, escape that conversion. SA2/SA4 distinguish one basis per occurrence from duplicate or execution-wide cached inspection; SA8 distinguishes retained safe refusal from a terminal operation error.

The authenticated Syntax body still validates its issued invocation and site. It queries contextual text/documentation inside the existing durable live callback (`components/Syntax.ts:173`). Final middleware text is retained; publication and the secret gate precede interpretation. SA5 restores both complete and partial histories with all live providers set to throw if reached. Protected definitions, routing and generated admission remain authoritative independently of these replaceable descriptions.

Generated producer content installs symbols-only narrowing in its actual projection scopes (`expand.ts:508`, `expand.ts:610`, `expand.ts:3765`); generated bodies do the same within their expansion scope (`generated-xmd.ts:2451`). Neither replaces the enclosing named-documentation provider. SA6/SA7 demonstrate host-only metadata remaining readable, descriptive additions admitting nothing and descriptive filtering disabling nothing.

CLI inspection and standalone Plan share the target-run declarative assembly (`cli/src/syntax.ts:95`). It captures target registry/declaration inputs and documentation together, then inspects lazily. The Plan path supplies one required private setup operation and invokes it in its bounded scope before `executeInstalled()` (`cli.ts:2866`, `plan.ts:247`, `plan-writer-profile.ts:441`). This realizes A3's approved placement without another public helper or installation member. Embedded Plan retains its enclosing profile; structural validation, trusted Files/Permissions reads, durable preparation and REPL attachment/journal ownership remain intact. The small `NO_DOCUMENTATION` relocation preserves its root export and cuts the documented renderer/index/registry cycle. U4/U5 and #902 consumer work remain outside this revision.

## Focused evidence

The Architect independently ran:

```sh
deno task test packages/core/tests/execution-init.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/protected-content.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/testing-execution-host.test.ts packages/cli/tests/plan-command-document.test.ts
```

Result outside the sandbox: **16 passed / 105 steps / 0 failed**, exit 0. [Complete passing output](u3-architect-ac466780-focused-unrestricted.log).

The [first output](u3-architect-ac466780-focused.log) is retained: 15 passed / 99 steps, with six existing nested-run steps failing on `listen EACCES: permission denied 127.0.0.1`. The new EI/SA cases and isolated-child init case passed there. The unchanged selection passed after allowing the loopback listener outside the sandbox. This is an identified execution-environment difference, not an unexplained intermittent failure.

The retained Implementor logs support the frozen groups at the feedback tree: 7/112, 59/417, 41/226 and 10/69; Node and Bun each 134 passed; compiled evidence 6/15. The Planner independently passed 9/97. Those records cover the remaining protected-name, publication/fatal-path, host integration and Workflow preservation rows. This review adds no acceptance row or required command and leaves the frozen U3-1–U3-12 evidence unchanged.

## Landed overlap and next action

The [read-only GitHub snapshot](u3-architect-ac466780-remote-snapshot.json) on 2026-10-14 verifies main at `a0320347ff676f76735f42be86ff0bdb07a52980`, tree `11858f5fc1be1594865bf5b43d8bdd0417703d9a`, containing [#908](https://github.com/taras/executable.md/pull/908) directly above the frozen U2 base. Its prose cleanup and new prose lint gates overlap this branch. Open [#910](https://github.com/taras/executable.md/pull/910) is at `1ef21a6f8fe659f25ea214eaecc5fff4af1c4b87`; its inspected overlapping changes correct comments without changing U3 behavior. Open [#890](https://github.com/taras/executable.md/pull/890) remains at `79d404d04d02c3840892473b6f1b2cf540f3edd1`, with the previously recorded host/generated/specification overlap. None is silently incorporated into this exact-revision verdict.

Reconcile landed prose overlap during delivery and preserve the accepted behavior. There is no architecture cleanup requirement or new structural amendment from this review. Architecture review of this revision is closed.

Next: Product Owner implementation review of `ac466780cda608eafe974951c13c09c02b2b1cd4`, then delivery verification, separately authorized publication and explicit merge approval. U3 is not landed. U4 waits for landed U3; #902 stays held through U3–U5 and removal of consumer-owned forwarding.

This review changed continuity artifacts only. Production source, dependency layout, lockfile, branches and commits were preserved. No CI was inspected and no GitHub feedback, push, PR or merge was published.
