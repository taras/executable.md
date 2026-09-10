"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toggle = toggle;
const decode_js_1 = require("./decode.js");
const dasherize_js_1 = require("./dasherize.js");
const param_js_1 = require("./param.js");
const pipeline_js_1 = require("./pipeline.js");
function toggle(named, ...elements) {
    const added = elements.reduce((value, element) => element(value), {
        ...(0, param_js_1.param)(named, binding(named.name), (0, param_js_1.schema)(bool)),
        decode: decode_js_1.boolean,
    });
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
function binding(name) {
    const stem = (0, dasherize_js_1.dasherize)(name);
    const yes = `--${stem}`;
    const no = `--no-${stem}`;
    return (param) => ({
        ...param,
        cli: {
            read: reader(name),
            syntax: {
                type: "option",
                label: `${yes}, ${no}`,
            },
        },
    });
}
function reader(name) {
    const stem = (0, dasherize_js_1.dasherize)(name);
    const yes = `--${stem}`;
    const no = `--no-${stem}`;
    return (tokens) => {
        let claim = tokens.claimOne((token) => {
            return token.type === "flag" &&
                (token.text === yes || token.text === no);
        });
        let [flag] = claim.tokens;
        return flag
            ? {
                claim,
                result: {
                    ok: true,
                    value: { exists: true, value: flag.text === yes },
                    issues: [],
                },
            }
            : {
                claim,
                result: {
                    ok: true,
                    value: { exists: false },
                    issues: [],
                },
            };
    };
}
const bool = {
    "~standard": {
        version: 1,
        vendor: "configliere",
        validate(value) {
            return typeof value === "undefined"
                ? { value: false }
                : typeof value === "boolean"
                    ? { value }
                    : { issues: [{ message: "expected boolean" }] };
        },
    },
};
//# sourceMappingURL=toggle.js.map