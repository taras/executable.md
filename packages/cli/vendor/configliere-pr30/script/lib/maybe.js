"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Just = Just;
exports.Nothing = Nothing;
function Just(value) {
    if (typeof value === "undefined") {
        return { exists: true };
    }
    else {
        return { exists: true, value };
    }
}
function Nothing() {
    return nothing;
}
const nothing = { exists: false };
//# sourceMappingURL=maybe.js.map