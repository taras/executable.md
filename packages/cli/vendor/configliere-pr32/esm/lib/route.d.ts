import { type Check, type Fold, type Materialize, type MethodElement, type ModelTransformElement, type RoutesElement, type Unary } from "./pipeline.js";
import type { AnyRoute, Definition, Done, ModelOf, ModelParams, ModelSchema, Route } from "./types.js";
export type RouteZero<N extends string = string> = Route<N, "help", {}, [
], [
    Done<{}, []>
]>;
export declare function route<const N extends string, const E extends readonly Unary[]>(start: Definition<N>, ...elements: E & Check<RouteZero<N>, E>): Materialize<Fold<RouteZero<N>, E>>;
export declare function version(semver: string): MethodElement<"version">;
export declare function executable(): MethodElement<"execute">;
export declare function routes<const C extends readonly AnyRoute[]>(...children: C): RoutesElement<C>;
export declare function transform<const T extends object, const E extends readonly Unary[]>(transform: ModelSchema<T>, ...elements: E & Check<RouteZero, E>): ModelTransformElement<ModelSchema<T>, E>;
export declare function transform<const E extends readonly Unary[], const F extends ((options: ModelOf<Fold<RouteZero, E>>, model: never, phase: ModelParams) => Record<string, unknown> | void)>(transform: F, ...elements: E & Check<RouteZero, E>): ModelTransformElement<F, E>;
//# sourceMappingURL=route.d.ts.map