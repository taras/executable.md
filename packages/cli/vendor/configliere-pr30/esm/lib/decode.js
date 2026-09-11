export const number = (value) => {
    if (!numeric.test(value)) {
        return [];
    }
    let decoded = Number(value);
    return Number.isFinite(decoded) ? [decoded] : [];
};
export const scalar = (value) => {
    return [...number(value), value];
};
export const boolean = (value) => {
    if (value === "true") {
        return [true];
    }
    if (value === "false") {
        return [false];
    }
    return [];
};
const numeric = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
//# sourceMappingURL=decode.js.map