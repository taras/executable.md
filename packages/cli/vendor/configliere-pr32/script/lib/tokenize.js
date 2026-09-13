"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenize = tokenize;
function tokenize(argv) {
    let quote = false;
    let tokens = [];
    for (let i = 0; i < argv.length; i++) {
        let index = i;
        let text = argv[i];
        if (quote) {
            tokens.push({ type: "literal", index, text });
            continue;
        }
        if (text === "--") {
            tokens.push({ type: "separator", index, text });
            quote = true;
            continue;
        }
        let matchSetter = setterMatch.exec(text);
        if (matchSetter?.groups) {
            let { nameText, valueText } = matchSetter.groups;
            tokens.push({ type: "setter", index, text, nameText, valueText });
            continue;
        }
        let matchFlag = flagMatch.exec(text);
        if (matchFlag?.groups) {
            let { prefix, flagText } = matchFlag.groups;
            tokens.push({
                type: "flag",
                index,
                text,
                flagText,
                flagType: prefix === "-" ? "short" : "long",
            });
            continue;
        }
        tokens.push({ type: "word", index, text });
    }
    return tokens;
}
// deno-lint-ignore no-invalid-regexp
const flagMatch = /^(?<prefix>--?)(?<flagText>[^-=\s][^=\s]*)$/;
// deno-lint-ignore no-invalid-regexp
const setterMatch = /^--(?<nameText>[^-=\s][^=\s]*)=(?<valueText>[\s\S]*)$/;
//# sourceMappingURL=tokenize.js.map