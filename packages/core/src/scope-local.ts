/**
 * Read-modify-write a context value on the *current* scope.
 *
 * Effection's strict Context API — `createContext` plus
 * `Context.get/expect/set/delete/with` — cannot answer "does this value belong
 * to my scope, or did I inherit it?", because `Context.get()` walks the parent
 * chain. Branching on it would splice a child's entry into the object its
 * parent owns and leak the change to siblings.
 *
 * `Scope.hasOwn` is the only mechanism that distinguishes the two. It is a
 * documented member of the public `Scope` interface, and `@effectionx/context-api`
 * uses it in its own `around()` for this identical copy-on-write problem — but
 * it is deliberately *not* among the strict Context operations, so reaching for
 * it is an exception rather than something the guidance blesses.
 *
 * The exception is confined to this module, which is internal and not exported
 * from `mod.ts`. It uses only public `Scope` methods; it never exposes `Scope`
 * or scope identity to callers; it never creates, destroys, retains, or
 * re-enters a scope; it depends on no `@effectionx/context-api` internals; and
 * it returns ordinary immutable values. Copying on first write is what keeps an
 * inherited value unmutated.
 */

import { useScope } from "effection";
import type { Context, Operation } from "effection";

/**
 * Apply `update` to this scope's own value for `context`, seeding it with
 * `empty()` the first time.
 *
 * The inherited value is never passed to `update` and never mutated: a scope
 * that has not written before starts from `empty()`, so what a parent holds is
 * untouched. An `update` that throws leaves the scope unchanged, because the
 * write happens only after it returns.
 */
export function* updateOwn<T>(
  context: Context<T>,
  empty: () => T,
  update: (own: T) => T,
): Operation<void> {
  const scope = yield* useScope();
  const own = scope.hasOwn(context) ? scope.expect(context) : empty();
  const next = update(own);
  scope.set(context, next);
}

/** This scope's own value for `context`, ignoring anything inherited. */
export function* readOwn<T>(context: Context<T>, empty: () => T): Operation<T> {
  const scope = yield* useScope();
  return scope.hasOwn(context) ? scope.expect(context) : empty();
}
