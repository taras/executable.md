# U3 planning closure

**Landed:** U3 merged as PR #912 at `6314e187`, published head `bc2c59c8`; [exact merge/tree receipt](upstream-repository-prerequisite-u3-landed.md). [U4 planning is complete](upstream-repository-prerequisite-u4-planner-status.md). Earlier planning/review states below are historical.

**Current status:** U3 implementation has Planner and Architect **PASS** at signed revision `ac466780cda608eafe974951c13c09c02b2b1cd4`, tree `1d807b062a9d4608ff37dabbc4eab755d9b2f95e`, based on landed U2 `9c4f4f9a`. [Planner review, frozen commands and evidence](upstream-repository-prerequisite-u3-planner-review-ac466780.md); [Architect review and independent focused evidence](upstream-repository-prerequisite-u3-architect-review-ac466780.md). The isolated worktree is clean. U3 is unpushed and not landed; next is Product Owner review of the same revision, then delivery, separately authorized publication and explicit merge approval. U4 and #902 remain held as stated in the stack.

The planning closure below is historical. Its partial implementation and next-action statements have been superseded by the linked review; the frozen criteria and accepted A2/A3 decisions are unchanged.

**A3 closed on 2026-10-14.** The Product Owner approved the [host Syntax setup resolution](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md). The Planner has incorporated the affected helper, fallback ordering, symbols-only narrowing and CLI/Plan migration instructions. Implementation resumes in the same prepared worktree under the existing authorization. A2 remains closed; the frozen evidence is unchanged. No feedback commit or publication occurred.

**Planning completed on 2026-10-14 with A2 closed; the subsequent A3 amendment is now accepted.** The [Implementor handoff](upstream-repository-prerequisite-u3-implementor-handoff.md) retains twelve frozen acceptance/evidence rows and exact focused feedback commands. U3 implementation was separately authorized by the Product Owner; publication and merge remain separate.

## Verified predecessor

Read-only GitHub main lookup on 2026-10-14, repeated during finalization, returns `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`, tree `f3562253edc8310370d5459416abe8ad23769805`. This landed U2 tree matches reviewed PR #906 head `cdcfe328f1c8ec0cd7a62329a99d17b7edd60d1e`. The exact source archive at `/private/tmp/xmd-pr181-bench-rXAXyb/u3-planner-source/` contains no dependency layout or Git worktree.

Open #890's inspected head is `79d404d04d02c3840892473b6f1b2cf540f3edd1`. Its host/generated/specification overlap is recorded in the handoff. Recheck main before creating the implementation worktree and account for later landed changes. The preserved #902 consumer and root workspace edits remain separate.

## Accepted A2 amendment

The original plain-value interface could not type suspending property middleware on installed context-api 0.6.0. The historical [failing type probe](u3-syntax-value-middleware-type-probe.ts) and [synchronous control](u3-syntax-value-middleware-sync-control.ts) establish that narrow mismatch.

The Product Owner accepted the [Architect's resolution](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md): `symbols: Operation<SyntaxSymbols>` and `text: Operation<string>`, exported on exactly `Api<SyntaxApi>`. Callers still yield properties without parentheses. Defaults use reusable Operations, property middleware delegates Operations, and no dependency change or adapter is required.

The [successful typecheck](u3-syntax-operation-property-probe-check.log) and [runtime proof](u3-syntax-operation-property-probe-run-env.log) establish lazy repeated reads, suspending delegation, synthetic answers without default inspection, restoration, and named metadata/availability with one authoring inspection and one effective symbols read. That per-occurrence reuse stays private to the existing reference/catalog owner. It adds no public catalog, generic cache, authorization flag or scope instrumentation.

These are feasibility results. Product acceptance remains the handoff's frozen U3-1–U3-12 matrix, including the real execution owner, host integration, protected invocation, retained Syntax answers, cancellation and joined cleanup. The superseded A2 request and failing probe remain historical evidence.

## Accepted A3 amendment

Export `useSyntax(source: () => Operation<SyntaxSymbols>): Operation<void>` from `@executablemd/core/host`. It captures existing scoped documentation contributions and installs ordinary providers backed by a lazy source. Core keeps canonical named selection and its private safe-refusal classification. The execution-derived reference is the API fallback, host providers install at `min`, and generated scopes narrow symbols while preserving the enclosing named catalog.

CLI and standalone Plan share bounded target-run declarative assembly and this setup helper. Capture target inputs and documentation together before restricted authoring execution; keep the source lazy. Remove `ExecutionInstallation.symbols` and its count rule. Add no public catalog property, dependency, admission authority, forwarding API or scope hook.

The resolution links the successful temporary type/runtime proof and its limitations. U3-6, U3-7 and U3-10 already discriminate the affected consequences; no row or focused command is added. Production feedback evidence is still required.

## Final scope and evidence

Execution.init runs once in the existing execution-owned scope, after trusted input copies and revocation guards and before host installation callbacks/documentation capture and public execution policy. Default init is no-op. No second owner, request, receipt or forwarding API is introduced.

Syntax is lazy and contextual. Default text renders effective symbols; default named documentation combines the enclosing catalog with effective availability. Generated narrowing supplies ordinary descriptive middleware. The final returned text crosses the existing durable/publication/secret boundary; completed replay queries no live provider. Descriptions do not alter generated authority.

The handoff names the removal of the old symbols installation member and count rule, the Plan target-run provider/catalog migration, bounded CLI inspection, isolated-child reassembly, and the unchanged REPL attachment ownership. Plan trusted reads continue through ordinary Files/Permissions; its retired scope/grant machinery stays removed. Existing Workflow/Git/Plugin installation responsibilities and U4/U5 exclusions remain intact.

The focused commands cover the two new portable core suites and selected existing core/CLI/Workflow integrations, portable Node/Bun checks, dead-code inventory, build and compiled journeys. All existing selected paths resolve in the exact source archive; only the two planned new test files are absent. Full lint/typecheck/runtime suites and CI remain delivery evidence under repository rules. No dependency-layout change adds a composability requirement.

## Artifacts and next action

- [Final U3 Implementor handoff](upstream-repository-prerequisite-u3-implementor-handoff.md).
- [Current stack plan](upstream-repository-prerequisite-stack-plan.md).
- [Accepted A2 resolution](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md) and its linked proof.
- [Accepted A3 resolution](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md) and its linked proof.
- [Architect PASS at ac466780](upstream-repository-prerequisite-u3-architect-review-ac466780.md).
- [Historical A2 request](upstream-repository-prerequisite-u3-syntax-architecture-request.md) and original probes/logs.

Settled: init ownership/default/delegation, trusted capture order, typed reusable lazy Syntax properties, private named-reference reuse, accepted host descriptive setup, recorded final answers/replay, explicit host isolation, Plan target-run descriptions and trusted reads, preserved installation responsibilities and U4/U5 boundaries. Unresolved architecture blockers: none.

Next: Product Owner implementation review of `ac466780cda608eafe974951c13c09c02b2b1cd4`, then delivery verification, separately authorized publication and explicit merge approval. Planner incorporation, implementation feedback and Architect review are complete. U4 waits for landed U3; #902 stays held through U3–U5 and removal of consumer-owned forwarding.

The original planning finalization and these Architect amendments changed artifacts only. The original Planner preparation ran two external type probes; the later Architect proofs are feasibility evidence, not product tests. The Implementor's separately authorized partial source remains in its prepared worktree at `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec` with nine core files modified/new. No feedback commit, CI inspection or publication occurred for this amendment.
