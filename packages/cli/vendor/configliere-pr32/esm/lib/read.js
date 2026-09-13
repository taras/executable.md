import { brand } from "./pipeline.js";
export function cli(names, options = {}) {
    const readOne = (tokens) => {
        let [match] = matches(tokens);
        return match ? result(tokens, match) : nothing(tokens);
    };
    const readMany = (tokens) => {
        let found = matches(tokens);
        if (found.length === 0) {
            return nothing(tokens);
        }
        let claimed = new Set(found.flatMap((match) => match.indices));
        let issues = found.flatMap((match) => "issue" in match ? [match.issue] : []);
        return {
            claim: tokens.claimAll((token) => claimed.has(token.index)),
            result: issues.length > 0 ? { ok: false, issues } : {
                ok: true,
                value: {
                    exists: true,
                    value: found.map((match) => "value" in match ? match.value : undefined),
                },
                issues: [],
            },
        };
    };
    function matches(tokens) {
        let visible = Array.from(tokens);
        let found = [];
        for (let index = 0; index < visible.length; index++) {
            let token = visible[index];
            if (!options.switch && token.type === "setter" &&
                names.includes(`--${token.nameText}`)) {
                found.push({ indices: [token.index], value: token.valueText });
                continue;
            }
            if (token.type !== "flag" || !names.includes(token.text)) {
                continue;
            }
            if (options.switch) {
                found.push({ indices: [token.index], value: true });
                continue;
            }
            let value = visible[index + 1];
            if (value?.type === "word" && value.index === token.index + 1) {
                found.push({
                    indices: [token.index, value.index],
                    value: value.text,
                });
                index++;
            }
            else {
                found.push({
                    indices: [token.index],
                    issue: { message: `${token.text} requires a value` },
                });
            }
        }
        return found;
    }
    const read = (tokens, multiple = false) => {
        return multiple ? readMany(tokens) : readOne(tokens);
    };
    return brand((param) => ({
        ...param,
        cli: {
            read,
            syntax: {
                type: "option",
                label: options.switch
                    ? names.join(", ")
                    : `${names.join(", ")} <VALUE>`,
            },
        },
    }));
}
function result(tokens, match) {
    let claim = tokens.claimAll((token) => match.indices.includes(token.index));
    if ("issue" in match) {
        return { claim, result: { ok: false, issues: [match.issue] } };
    }
    return {
        claim,
        result: {
            ok: true,
            value: { exists: true, value: match.value },
            issues: [],
        },
    };
}
function nothing(tokenizer) {
    let claim = tokenizer.claimAll(() => false);
    return {
        claim,
        result: {
            ok: true,
            value: { exists: false },
            issues: [],
        },
    };
}
//# sourceMappingURL=read.js.map