"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.boolean = exports.scalar = exports.number = void 0;
const number = (value) => {
    if (!numeric.test(value)) {
        return [];
    }
    let decoded = Number(value);
    return Number.isFinite(decoded) ? [decoded] : [];
};
exports.number = number;
const scalar = (value) => {
    return [...(0, exports.number)(value), value];
};
exports.scalar = scalar;
const boolean = (value) => {
    if (value === "true") {
        return [true];
    }
    if (value === "false") {
        return [false];
    }
    return [];
};
exports.boolean = boolean;
const numeric = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
//# sourceMappingURL=decode.js.map