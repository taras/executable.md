# U3 typed lazy Syntax resolution

**A2 is closed.** The Product Owner explicitly accepted Operation-valued `SyntaxApi.symbols` and `.text` properties after reviewing the [typed proposal and proof](upstream-repository-prerequisite-u3-syntax-a2-proposal.md). Use the installed context-api 0.6.0 contract without a dependency change, adapter or runtime hook.

This is a narrow amendment to the accepted Syntax member types. Caller property syntax and the accepted lazy descriptive behavior remain unchanged. It authorizes no U3 implementation, publication or merge.

## Accepted interface

```ts
interface SyntaxApi {
  readonly symbols: Operation<SyntaxSymbols>;
  readonly text: Operation<string>;
  documentation(names: readonly string[]): Operation<string>;
}
```

Export this interface and exactly `Api<SyntaxApi>` for the Syntax descriptor. Construct it with `createApi<SyntaxApi>` and one stable namespaced identity. Do not export the old value-member interface while using a differently typed provider internally.

Consumers yield `Syntax.operations.symbols` and `.text` without parentheses. Documentation remains a method. Property middleware and its `next()` return Operations; synthetic answers use generator bodies too. No cast is needed to make a suspending provider fit.

## Default and reference ownership

Descriptor defaults are reusable Operations. `call(generatorFactory)` is supported for that purpose and starts fresh generator work on each read; it is not a Promise conversion. A single stored generator instance must not become a consumed default after its first read.

Default symbols remains lazy. Default text reads effective contextual symbols and uses the existing renderer. Synthetic middleware answers skip the default operation, and scoped middleware disappears when its scope ends.

The existing private reference/catalog owner supplies named metadata. One named occurrence resolves its authoring basis once and reads effective contextual symbols once for availability. Its ordinary root symbols provider reuses that occurrence's basis rather than inspecting a moving root again. The proof demonstrates private request-local reuse with ordinary Context/scoped APIs. Keep this bookkeeping within the owning reference; add no public catalog, generic request-cache API, authorization flag or scope instrumentation. Generated descriptive narrowing still answers through ordinary Syntax middleware, and the enclosing catalog remains available for entries omitted from the narrowed view. Later occurrences resolve independently.

Keep Syntax's authenticated component invocation, durable live callback, final-answer recording, safe named refusal classification, publication and secret gate. Completed replay restores its final recorded text without querying live providers. Descriptions remain independent of generated execution authority.

## Evidence

The [operation-property probe](u3-syntax-operation-property-probe.ts) typechecks against installed context-api 0.6.0 and uses the existing full SyntaxSymbols type, named selector and renderers without casts or alternate descriptor types. Its lazy provider suspends and reads a real file.

```sh
deno check --frozen --cached-only --node-modules-dir=manual --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-syntax-operation-property-probe.ts
deno run --allow-read --allow-env --frozen --cached-only --node-modules-dir=manual --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-syntax-operation-property-probe.ts
```

Both exit 0. The [typecheck output](u3-syntax-operation-property-probe-check.log) and [runtime output](u3-syntax-operation-property-probe-run-env.log) establish reusable lazy defaults, suspending delegation, transformed default text, synthetic-answer short-circuiting, scope restoration and named metadata/availability with one root inspection and one effective symbols read. A synthetic named answer performs no catalog inspection.

These are feasibility checks. The Planner retains the proposed U3 product tests for initialization, descriptive behavior, protected invocation, replay, teardown, host integration and distribution. No extra dependency/setup/composability requirement follows from this solution.

## Continuity and next action

Base: landed U2 `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`, tree `f3562253edc8310370d5459416abe8ad23769805`. The acceptance is the Product Owner's explicit “accept” in this conversation. It changes two Syntax property types only and introduces no reusable rule.

The Current contract and accepted Syntax summary now carry the amended types. The original A2 request and failing value-member probe remain historical evidence. The U3 draft/status point here; the Planner still owns final handoff mechanics and the frozen evidence/commands. Reconcile the superseded value-type language and incorporate this proof before closing planning and requesting implementation authorization. Do not ask again for acceptance of these same types.

Execution.init, Permissions, Plan trusted reads, generated admission, existing installation-feature ownership and U4/U5 exclusions remain settled. No repository implementation, dependency install/change, branch/worktree operation, product suite, CI inspection or GitHub mutation occurred for this resolution. U3 is ready for Planner finalization. #902 remains held through U3–U5 and removal of consumer-owned forwarding.
