/**
 * Reusable middleware primitive — matches Effection v4.1's Middleware type.
 *
 * A Middleware wraps a function call: it receives the arguments that would
 * go to the next handler and a `next` function to delegate to the rest of
 * the chain.
 *
 * This module provides the type and a `combine` function that composes an
 * array of middlewares into a single middleware (right-to-left, innermost
 * first — same semantics as Effection's `api-internal.ts`).
 */

// ---------------------------------------------------------------------------
// Middleware type
// ---------------------------------------------------------------------------

/**
 * A single link in a middleware chain.
 *
 * - `args`  — the arguments to the function being surrounded
 * - `next`  — delegate to the next link (accepts the same args shape)
 * - returns the same shape as `next()`
 *
 * Matches Effection v4.1's `Middleware<TArgs, TReturn>` exactly.
 */
export type Middleware<TArgs extends unknown[], TReturn> = (
  args: TArgs,
  next: (...args: TArgs) => TReturn,
) => TReturn;

// ---------------------------------------------------------------------------
// Combine
// ---------------------------------------------------------------------------

/**
 * Compose an array of middlewares into a single middleware.
 *
 * When the composed middleware is called, each middleware in the array
 * wraps the next one. The last middleware in the array is closest to
 * the core function (`next`).
 *
 * An empty array returns a pass-through that just calls `next(...args)`.
 */
export function combine<TArgs extends unknown[], TReturn>(
  middlewares: Middleware<TArgs, TReturn>[],
): Middleware<TArgs, TReturn> {
  if (middlewares.length === 0) {
    return (args, next) => next(...args);
  }
  return middlewares.reduceRight(
    (sum, middleware) => (args, next) =>
      middleware(args, (...a) => sum(a, next)),
  );
}
