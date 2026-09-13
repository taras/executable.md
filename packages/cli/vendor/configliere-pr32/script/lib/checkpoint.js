"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkpoint = checkpoint;
const dynamic_js_1 = require("./dynamic.js");
const values_js_1 = require("./values.js");
function checkpoint() {
    return (0, dynamic_js_1.dynamic)((values) => (0, values_js_1.withValues)(values));
}
//# sourceMappingURL=checkpoint.js.map