import type { Maybe } from "./maybe.js";
import { type IdentityElement } from "./pipeline.js";
import type { AnyRoute, RoutePath } from "./types.js";
export type ValueSource = {
    name: string;
    value: unknown;
};
export declare function withValues(values: readonly ValueSource[]): IdentityElement<AnyRoute>;
export type ValueClaim = {
    result: Maybe<{
        source: string;
        address: readonly string[];
        value: unknown;
    }>;
    rest: Values;
};
export declare class Values {
    mounts: Map<RoutePath, ValueSource[]>;
    claims: Set<ClaimId>;
    constructor(mounts?: Map<RoutePath, ValueSource[]>, claims?: Set<ClaimId>);
    mount(path: readonly string[], sources: readonly ValueSource[]): Values;
    claim({ route, address }: ClaimOptions): ValueClaim;
}
export interface ClaimOptions {
    route: readonly string[];
    address: readonly string[];
}
type ClaimId = string;
export {};
//# sourceMappingURL=values.d.ts.map