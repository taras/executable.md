import type { Maybe } from "./maybe.js";
import type { Param } from "./param.js";
import { type IdentityElement } from "./pipeline.js";
import type { AnyRoute, RoutePath } from "./types.js";
export interface EnvSource {
    readonly name: string;
    readonly value: Environment;
}
export type Environment = Readonly<Record<string, string | undefined>>;
export interface EnvClaim {
    readonly result: Maybe<{
        readonly source: string;
        readonly address: readonly string[];
        readonly key: string;
        readonly value: string;
    }>;
    readonly rest: Envs;
}
export interface EnvClaimOptions {
    readonly route: readonly string[];
    readonly address: readonly string[];
    readonly key?: string;
}
export declare function env(key: string): IdentityElement<Param<string, unknown>>;
export declare function withEnvs(envs: readonly EnvSource[]): IdentityElement<AnyRoute>;
export declare class Envs {
    mounts: Map<RoutePath, EnvSource[]>;
    claims: Set<ClaimId>;
    constructor(mounts?: Map<RoutePath, EnvSource[]>, claims?: Set<ClaimId>);
    mount(path: readonly string[], sources: readonly EnvSource[]): Envs;
    claim({ route, address, key }: EnvClaimOptions): EnvClaim;
}
type ClaimId = string;
export {};
//# sourceMappingURL=env.d.ts.map