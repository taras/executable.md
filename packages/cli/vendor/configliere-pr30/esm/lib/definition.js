import { brand } from "./pipeline.js";
export function name(name) {
    return { name };
}
export function description(description) {
    return brand((definition) => ({
        ...definition,
        description,
    }));
}
//# sourceMappingURL=definition.js.map