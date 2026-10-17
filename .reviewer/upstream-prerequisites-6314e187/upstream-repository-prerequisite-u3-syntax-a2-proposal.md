# U3 lazy Syntax property types

**Accepted by the Product Owner; A2 is closed.** The Operation-valued property types and typed solution below are accepted. The [architecture resolution](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md) records the effective contract and Planner handoff. The proposal and proof remain as the decision evidence.

## Applies to

`SyntaxApi.symbols` and `.text`, their descriptor defaults and middleware. Callers keep property reads without parentheses. `documentation(names)` and the accepted behavior of all three members remain unchanged. Execution.init, Permissions, Plan reads, generated admission and U4/U5 remain outside this decision.

Base: landed U2 `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`, tree `f3562253edc8310370d5459416abe8ad23769805`.

## Current contract and concrete problem

The accepted interface declares `symbols: SyntaxSymbols` and `text: string`. Installed context-api maps middleware and `next()` for those members to the same plain values. A generator that inspects files or yields delegated work therefore cannot implement either property soundly. The Planner's [failing probe](u3-syntax-value-middleware-type-probe.ts) and [first output](u3-syntax-value-middleware-type-probe.log) establish that mismatch.

The library already supports Operation-valued properties: it preserves them in `Operations<A>` and gives their middleware an Operation-returning continuation. This uses the existing public library API; no library modification, upgrade, alternate descriptor type or adapter is needed. The [upstream mapping](https://github.com/thefrontside/effectionx/blob/main/context-api/mod.ts) agrees with the inspected installed 0.6.0 source.

## Accepted public interface

```ts
interface SyntaxApi {
  readonly symbols: Operation<SyntaxSymbols>;
  readonly text: Operation<string>;
  documentation(names: readonly string[]): Operation<string>;
}
```

The descriptor is exactly `Api<SyntaxApi>` and is constructed with `createApi<SyntaxApi>`. There is no separate interface for callers and providers. Consumer code is unchanged:

```ts
const symbols = yield* Syntax.operations.symbols;
const text = yield* Syntax.operations.text;
const named = yield* Syntax.operations.documentation(["File"]);
```

Providers and transforms return Operations, including synthetic answers:

```ts
yield* Syntax.around({
  *symbols(_args, next) {
    return filterSymbols(yield* next());
  },
  *text() {
    return "A synthetic description.";
  },
});
```

This is the material change: middleware returning a plain string or symbols value must instead return an Operation. Both defaults remain lazy, and the public property names and read syntax remain intact. Keeping the exact old value types would require a different library contract or adapter; it cannot be achieved merely by supplying different generator bodies to the installed `Api<SyntaxApi>`.

## Concrete defaults and named lookup

Use ordinary reusable Operations for descriptor defaults, such as `symbols: call(readDefaultSymbols)` and `text: call(readDefaultText)`. Here `call` receives a generator factory, not a Promise; it creates fresh delegated work each time the property is yielded. Do not store a single consumed generator as a global property default. Default text yields the effective contextual symbols and uses the existing renderer.

Named documentation retains the enclosing catalog in its existing private owner. For one named occurrence, resolve its lazy authoring basis once, then read the effective contextual symbols once to determine availability. The ordinary root symbols provider reuses that same basis within this request; transforms and generated descriptive narrowing still run. This is reuse of one request's inspected value, not an eager or execution-wide cache.

The proof uses a private ordinary Context inside an owned `scoped()` operation to demonstrate that reuse. It neither patches scope creation nor walks scope/context internals. A narrowed symbols middleware can still answer instead of using that default basis. Leaving the request releases its local basis; a later named occurrence resolves afresh. The implementation may keep this bookkeeping within the existing private reference owner. No public catalog, generic request-cache API, new authorization state or second vocabulary is proposed.

## Typed and executed proof

The [operation-property probe](u3-syntax-operation-property-probe.ts) uses installed `createApi`/`Api`, the complete existing SyntaxSymbols type, core's actual symbols and named renderers, and core's actual named selection function. It uses no casts, `any`, dependency patches or replacement public descriptor. Its lazy provider suspends and reads a real [marker file](u3-syntax-operation-property-marker.txt).

```sh
deno check --frozen --cached-only --node-modules-dir=manual --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-syntax-operation-property-probe.ts
deno run --allow-read --allow-env --frozen --cached-only --node-modules-dir=manual --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/u3-syntax-operation-property-probe.ts
```

Both exit 0. [Typecheck output](u3-syntax-operation-property-probe-check.log) and [runtime output](u3-syntax-operation-property-probe-run-env.log) prove:

1. Descriptor construction performs no inspection; repeated property reads run fresh lazy IO.
2. Typed suspending symbols delegation transforms the default text answer.
3. A synthetic symbols answer skips default IO, and leaving its child scope restores the enclosing provider.
4. Named metadata and availability use one root inspection and one effective contextual symbols answer. A filtered enclosing component remains documentable and is marked unavailable.
5. A synthetic named answer skips catalog IO.

The probe imports the prepared root's existing type/selection/rendering modules; their files are unchanged between local root commit `e61d6ce` and the landed U2 tree. The source archive has no dependency layout and could not resolve `gray-matter` when used directly. An initial runtime attempt without environment permission stopped at a transitive module's OSTYPE read; [that first output](u3-syntax-operation-property-probe-run.log) is preserved. The successful run above permits those existing module imports and performs no network, writes or subprocess work.

This is a focused type/composition feasibility proof, not a U3 product suite or an implementation verdict. U3's retained Syntax journal, publication and replay boundaries still require the already proposed implementation evidence.

## Decision and next action

Accepted: Operation-valued `symbols` and `text` properties with the exact interface above. This preserves lazy descriptive behavior and caller syntax using the installed library's supported contract.

The Product Owner's explicit “accept” amends the previously accepted plain-value types. It approves this feature-local interface change, not a reusable rule or implementation revision.

The narrow Syntax type amendment is recorded and A2 is closed. The Planner incorporates the exact descriptor/default/provider mechanics and proof into the U3 handoff before freezing its finite evidence. No dependency/setup/composability expansion is introduced. No repository implementation, Git state, worktree, CI or GitHub change was made for this record.
