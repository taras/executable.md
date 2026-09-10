import { param } from "./param.js";
import { brand, } from "./pipeline.js";
export function argument(named, ...elements) {
    const added = elements.reduce((value, element) => element(value), param(named, positional));
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