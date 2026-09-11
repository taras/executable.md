import { boolean as decode } from "./decode.js";
import { dasherize } from "./dasherize.js";
import { param, schema } from "./param.js";
import { brand, } from "./pipeline.js";
export function toggle(named, ...elements) {
    const added = elements.reduce((value, element) => element(value), {
        ...param(named, binding(named.name), schema(bool)),
        decode,
    });
    return brand((route) => {
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
    const stem = dasherize(name);
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
    const stem = dasherize(name);
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