"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.param = param;
exports.schema = schema;
const decode_js_1 = require("./decode.js");
const pipeline_js_1 = require("./pipeline.js");
function param(start, ...elements) {
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
        decode: decode_js_1.scalar,
    };
    return elements.reduce((value, element) => element(value), zero);
}
function schema(schema) {
    return (0, pipeline_js_1.mark)((param) => ({
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