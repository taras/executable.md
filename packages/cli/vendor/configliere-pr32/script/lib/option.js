"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.option = option;
const param_js_1 = require("./param.js");
const dasherize_js_1 = require("./dasherize.js");
const pipeline_js_1 = require("./pipeline.js");
const read_js_1 = require("./read.js");
function option(named, ...elements) {
    const added = elements.reduce((value, element) => element(value), (0, param_js_1.param)(named, (0, read_js_1.cli)([`--${(0, dasherize_js_1.dasherize)(named.name)}`])));
    return (0, pipeline_js_1.brand)((route) => {
        let phases = [...route.phases];
        let phase = phases.pop();
        phases.push({
            ...phase,
            params: {
                ...phase.params,
                [added.name]: added,
            },
        });
        return {
            ...route,
            phases,
        };
    });
}
//# sourceMappingURL=option.js.map