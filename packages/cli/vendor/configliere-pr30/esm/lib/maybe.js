export function Just(value) {
    if (typeof value === "undefined") {
        return { exists: true };
    }
    else {
        return { exists: true, value };
    }
}
export function Nothing() {
    return nothing;
}
const nothing = { exists: false };
//# sourceMappingURL=maybe.js.map