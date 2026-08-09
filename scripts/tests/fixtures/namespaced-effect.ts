/**
 * Fixture for `local/prefer-effection-operation` — an effect reached through a
 * namespace import of `effection`.
 */
import type * as effection from "effection";

export type Effects<T> = Generator<effection.Effect<unknown>, T, unknown>;

export type Scoped = (scope: effection.Scope) => Generator<effection.Scope, void, unknown>;
