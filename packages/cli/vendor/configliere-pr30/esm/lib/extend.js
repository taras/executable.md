import { brand } from "./pipeline.js";
export function extend(...elements) {
    return brand((start) => elements.reduce((value, element) => element(value), start));
}
//# sourceMappingURL=extend.js.map