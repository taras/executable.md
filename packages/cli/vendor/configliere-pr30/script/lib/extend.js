"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extend = extend;
const pipeline_js_1 = require("./pipeline.js");
function extend(...elements) {
    return (0, pipeline_js_1.brand)((start) => elements.reduce((value, element) => element(value), start));
}
//# sourceMappingURL=extend.js.map