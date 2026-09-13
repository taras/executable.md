"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dynamic = dynamic;
const pipeline_js_1 = require("./pipeline.js");
function dynamic(extension, ..._valid) {
    return (0, pipeline_js_1.brand)((route) => {
        let phases = [...route.phases];
        let phase = phases.pop();
        phases.push({
            ...phase,
            resolver: extension,
        });
        phases.push({
            params: {},
            routes: [],
            values: [],
            envs: [],
        });
        return { ...route, phases };
    });
}
//# sourceMappingURL=dynamic.js.map