import { scalar } from "./decode.js";
import { mark, } from "./pipeline.js";
export function param(start, ...elements) {
    let zero = {
        ...start,
        schema: unknown,
        cli: {
            read(tokens) {
                let claim = tokens.claimAll(() => false);
                return {
                    result: {
                        ok: true,
                        value: { exists: false },
                        issues: [],
                    },
                    claim,
                };
            },
        },
        decode: scalar,
    };
    return elements.reduce((value, element) => element(value), zero);
}
export function schema(schema) {
    return mark((param) => ({
        ...param,
        schema,
    }));
}
const unknown = {
    "~standard": {
        version: 1,
        vendor: "configliere",
        validate: (value) => ({ value }),
    },
};
//# sourceMappingURL=param.js.map