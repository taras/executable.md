import type { Envs } from "./env.js";
import type { Symbol } from "./read.js";
import type { Tokenizer } from "./tokenizer.js";
import type { Values } from "./values.js";
export interface Rest {
    readonly tokens: Tokenizer<Symbol>;
    readonly values: Values;
    readonly envs: Envs;
}
//# sourceMappingURL=rest.d.ts.map