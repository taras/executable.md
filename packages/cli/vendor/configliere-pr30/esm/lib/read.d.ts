import type { Maybe } from "./maybe.js";
import type { Param } from "./param.js";
import { type IdentityElement } from "./pipeline.js";
import type { Result } from "./result.js";
import type { Flag, Setter, Word } from "./tokenize.js";
import type { Claim, TokenInput } from "./tokenizer.js";
export type Symbol = Flag | Setter | Word;
export type ReadCLI = (tokens: TokenInput<Symbol>) => CLIRead;
export interface CLIBinding {
    readonly read: ReadCLI;
    readonly syntax?: CLISyntax;
}
export type CLISyntax = {
    readonly type: "argument";
    readonly label: string;
} | {
    readonly type: "option";
    readonly label: string;
};
export interface CLIRead {
    result: Result<Maybe<string | boolean>>;
    claim: Claim<Symbol>;
}
export interface CLIOptions {
    switch?: true;
}
export declare function cli(names: readonly string[], options?: CLIOptions): IdentityElement<Param<string, unknown>>;
//# sourceMappingURL=read.d.ts.map