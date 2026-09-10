import { brand } from "./pipeline.js";
export function cli(names, options = {}) {
    const read = (tokens) => {
        if (options.switch) {
            let s = tokens.claimOne((t) => {
                return t.type === "flag" && names.includes(t.text);
            });
            let [flag] = s.tokens;
            return flag
                ? {
                    result: {
                        ok: true,
                        value: { exists: true, value: true },
                        issues: [],
                    },
                    claim: s,
                }
                : nothing(tokens);
        }
        let setter = tokens.claimOne((token) => {
            return (token.type === "setter" && names.includes(`--${token.nameText}`));
        });
        let [token] = setter.tokens;
        if (token) {
            return {
                claim: setter,
                result: {
                    ok: true,
                    value: {
                        exists: true,
                        value: token.valueText,
                    },
                    issues: [],
                },
            };
        }
        let pair = tokens.claimPair((name, value) => {
            return name.type === "flag" && names.includes(name.text) &&
                value.type === "word";
        });
        let [, value] = pair.tokens;
        if (value) {
            return {
                claim: pair,
                result: {
                    ok: true,
                    value: {
                        exists: true,
                        value: value.text,
                    },
                    issues: [],
                },
            };
        }
        let bare = tokens.claimOne((t) => {
            return t.type === "flag" && names.includes(t.text);
        });
        let [incomplete] = bare.tokens;
        if (incomplete) {
            return {
                claim: bare,
                result: {
                    ok: false,
                    issues: [{
                            message: `${incomplete.text} requires a value`,
                        }],
                },
            };
        }
        return nothing(tokens);
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