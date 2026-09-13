"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.argument = argument;
const param_js_1 = require("./param.js");
const pipeline_js_1 = require("./pipeline.js");
function argument(named, ...elements) {
    const added = elements.reduce((value, element) => element(value), (0, param_js_1.param)(named, positional));
    return (0, pipeline_js_1.brand)((route) => {
        let phases = [...route.phases];
        let phase = phases.pop();
        phases.push({
            ...phase,
            params: {
                ...phase.params,
                [added.name]: added,
            },
        });
        return {
            ...route,
            phases,
        };
    });
}
function positional(param) {
    return {
        ...param,
        cli: {
            read,
            syntax: {
                type: "argument",
                label: `<${param.name.toUpperCase()}>`,
            },
        },
    };
}
const read = (tokens) => {
    let claim = tokens.claimOne((token) => token.type === "word");
    let [word] = claim.tokens;
    return word
        ? {
            claim,
            result: {
                ok: true,
                value: { exists: true, value: word.text },
                issues: [],
            },
        }
        : nothing(tokens);
};
function nothing(tokens) {
    let claim = tokens.claimAll(() => false);
    return {
        claim,
        result: {
            ok: true,
            value: { exists: false },
            issues: [],
        },
    };
}
//# sourceMappingURL=argument.js.map