import { type Decoder } from "./decode.js";
import { type Check, type Fold, type Transform, type TransformElement, type Unary } from "./pipeline.js";
import type { CLIBinding } from "./read.js";
import type { Definition, Schema } from "./types.js";
export interface Param<K extends string, T> extends Definition<K> {
    schema: Schema<T>;
    cli: CLIBinding;
    decode: Decoder;
    env?: string;
    multiple?: boolean;
}
export interface MultipleParam<K extends string, T> extends Param<K, T[]> {
    multiple: true;
}
export declare function param<const K extends string, const E extends readonly Unary[]>(start: Definition<K>, ...elements: E & Check<Param<K, unknown>, E>): Fold<Param<K, unknown>, E>;
export declare function schema<T>(schema: Schema<T>): TransformElement<SchemaTransform<T>>;
export interface SchemaTransform<T> extends Transform {
    readonly input: Param<string, unknown>;
    readonly output: this["input"] extends MultipleParam<infer N, unknown> ? T extends (infer E)[] ? MultipleParam<N, E> : never : this["input"] extends Param<infer N, unknown> ? Param<N, T> : never;
}
interface MultipleTransform extends Transform {
    readonly input: Param<string, unknown>;
    readonly output: this["input"] extends Param<infer N, infer T> ? unknown extends T ? MultipleParam<N, unknown> : T extends (infer E)[] ? MultipleParam<N, E> : never : never;
}
export declare function multiple(): TransformElement<MultipleTransform>;
export {};
//# sourceMappingURL=param.d.ts.map