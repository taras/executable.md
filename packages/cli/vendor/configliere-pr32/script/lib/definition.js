"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.name = name;
exports.description = description;
const pipeline_js_1 = require("./pipeline.js");
function name(name) {
    return { name };
}
function description(description) {
    return (0, pipeline_js_1.brand)((definition) => ({
        ...definition,
        description,
    }));
}
//# sourceMappingURL=definition.js.map