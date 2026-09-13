import type { Maybe } from "./maybe.js";
import type { Param } from "./param.js";
import type { Symbol } from "./read.js";
import type { Rest } from "./rest.js";
import type { Result } from "./result.js";
import type { TokenInput, TokenRange } from "./tokenizer.js";
import type { AnyPhase, Issue, Path } from "./types.js";
export interface Binding<T> {
    readonly rest: Rest;
    readonly result: Result<T>;
}
export interface PhaseBinding {
    readonly rest: Rest;
    readonly model: Record<string, unknown>;
    readonly issues: Issue[];
    readonly valid: boolean;
}
export interface PhaseSegment {
    readonly range: TokenRange;
    readonly path: Path;
}
export declare function fromCLI<const K extends string, T>(options: {
    readonly param: Param<K, T>;
    readonly view: TokenInput<Symbol>;
    readonly rest: Rest;
}): Maybe<Binding<T>>;
export declare function fromValues<const K extends string, T>(options: {
    readonly param: Param<K, T>;
    readonly route: Path;
    readonly rest: Rest;
}): Maybe<Binding<T>>;
export declare function fromEnv<const K extends string, T>(options: {
    readonly param: Param<K, T>;
    readonly route: Path;
    readonly rest: Rest;
}): Maybe<Binding<T>>;
export declare function bindPhase(options: {
    readonly phase: AnyPhase;
    readonly segment: PhaseSegment;
    readonly rest: Rest;
}): PhaseBinding;
//# sourceMappingURL=bind.d.ts.map