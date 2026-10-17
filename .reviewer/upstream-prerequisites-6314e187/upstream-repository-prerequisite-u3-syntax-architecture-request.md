# U3 A2 — typed lazy Syntax properties

**A2 closed:** the Product Owner accepted [Operation-valued Syntax properties on installed context-api 0.6.0](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md). The request below preserves the original mismatch and evidence; its plain-value property types are superseded. No dependency change or adapter is needed. The Planner has incorporated the resolution into the [finalized handoff](upstream-repository-prerequisite-u3-implementor-handoff.md); its evidence is frozen.

Read this to resolve the one concrete blocker before the Planner freezes U3's implementation handoff. The accepted Syntax behavior remains the target. The installed context-api's value-property types do not express its suspending providers and delegation.

## Applies to

U3's `Syntax.symbols`, `Syntax.text` and their ordinary contextual middleware. This does not reopen Execution.init, Permissions, Plan reads, generated admission or the U4/U5 boundaries.

Verified base: main `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`, tree `f3562253edc8310370d5459416abe8ad23769805`. The source is the exact landed U2 tree. The installed dependency is `@effectionx/context-api@0.6.0`.

## Accepted contract

The [accepted Syntax summary](upstream-repository-reusable-interface-prerequisite.md#accepted-syntax-boundary-summary) declares:

```ts
interface SyntaxApi {
  readonly symbols: SyntaxSymbols;
  readonly text: string;
  documentation(names: readonly string[]): Operation<string>;
}
```

Callers yield the properties without parentheses. The default symbols provider remains lazy and may perform filesystem inspection. Default text reads the effective contextual symbols and renders them. Default named documentation reads effective symbols once for availability and the enclosing catalog for metadata. Middleware may answer, delegate or transform these descriptive views. Completed Syntax reads restore their recorded final text without live lookup. Descriptions grant no execution authority.

## Demonstrated mismatch

The installed context-api's `PropertyMiddleware<A, K>` maps value member `A[K]` to `Middleware<[], A[K]>`. Thus text middleware must return a string and its `next()` is typed as returning a string. Symbols has the analogous restriction. `Operations<A>` lifts a property read to an Operation, but that does not change the middleware signature.

The accepted lazy implementation needs to suspend:

```ts
Syntax.around({
  *text() {
    return renderSyntaxMarkdown(yield* Syntax.operations.symbols);
  },
});
```

Under `Api<SyntaxApi>`, this is rejected as a generator not assignable to `Middleware<[], string>`. A lazy symbols provider is rejected in the same way; `yield* next()` in symbols middleware is rejected because its declared result is not iterable.

The [minimal failing probe](u3-syntax-value-middleware-type-probe.ts) reduces the symbols payload to a small structural object; the mismatch does not depend on the full SyntaxSymbols schema. It uses the installed public Api type, no casts or application implementation. Command:

```sh
deno check --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-syntax-value-middleware-type-probe.ts
```

Result: exit 1, TS2322 on the property providers/transform, TS2488 on suspending `next()`, plus a downstream inference error. [Complete first output](u3-syntax-value-middleware-type-probe.log).

The [synchronous control](u3-syntax-value-middleware-sync-control.ts), using the same interface and configuration, typechecks: synchronous property replacement/delegation and the existing Operation-returning documentation method are accepted.

```sh
deno check --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-syntax-value-middleware-sync-control.ts
```

Result: exit 0. [Output](u3-syntax-value-middleware-sync-control.log).

The earlier [property probe](context-api-property-probe.ts) also used synchronous replacements. Its passing result does not establish the lazy property-provider path U3 requires. At runtime context-api recognizes returned Operations; the demonstrated gap is the sound typed public/provider contract, not lack of runtime iteration support.

## Resolution requested from the Architect

Provide a concrete, typechecked provider and middleware design that preserves the accepted property read syntax, lazy IO, ordinary delegation, synthetic answers, scoped lifetime and final-answer recording. Address how the public descriptor and its defaults are typed; an untyped runtime example is insufficient.

The smallest useful proof covers:

1. A lazy symbols provider can suspend, and a consumer yields a value property without parentheses.
2. Symbols middleware delegates to that provider and transforms its result; default text consumes the transformed value.
3. A middleware-supplied answer avoids the default lookup, and leaving the scope restores the enclosing provider.
4. Named lookup uses the enclosing metadata/catalog and one effective symbols read, preserving SYN49's one root-symbol resolution per occurrence rather than rebuilding two moving snapshots.

Use the accepted interface if a sound typed solution exists. If it needs a change to the public property/provider types, the dependency, or a new adapter boundary, identify that change explicitly and obtain the relevant architecture/product acceptance before it becomes an Implementor instruction. Do not silently substitute Operation-valued members for the accepted value members, export a differently typed descriptor under the old interface, cast generators through `unknown`, or hide the issue with eager inspection/caching. No generic invocation hook or public catalog property is approved.

The Planner recommends resolving this narrow compatibility issue before U3 implementation. The request does not prescribe a library upgrade or a new public abstraction.

## Continuity

Exact base: `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`. Produced artifacts: this request, the [U3 handoff draft](upstream-repository-prerequisite-u3-implementor-handoff.md), the two type probes and their logs. Only type probes ran; no repository implementation, dependency install/change, product suite, commit, CI inspection or GitHub mutation occurred.

A2 is closed by the accepted [typed architecture resolution](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md). Next: the Planner incorporates it and freezes the final handoff/commands before U3 implementation authorization. U2 remains landed and its accepted trusted-read Plan boundary is unchanged. #902 stays held through U3–U5 and forwarding removal.
