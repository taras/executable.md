"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.route = route;
exports.version = version;
exports.executable = executable;
exports.routes = routes;
// deno-lint-ignore-file ban-types
const pipeline_js_1 = require("./pipeline.js");
function route(start, ...elements) {
    let zero = {
        ...start,
        methods: ["help"],
        phases: [{
                params: {},
                routes: [],
                values: [],
                envs: [],
            }],
    };
    return elements.reduce((value, element) => element(value), zero);
}
function version(semver) {
    return (0, pipeline_js_1.brand)((route) => ({
        ...route,
        methods: [...route.methods, "version"],
        version: semver,
    }));
}
function executable() {
    return (0, pipeline_js_1.brand)((route) => ({
        ...route,
        methods: [...route.methods, "execute"],
    }));
}
function routes(...children) {
    return (0, pipeline_js_1.brand)((route) => {
        let phases = [...route.phases];
        let phase = phases.pop();
        phases.push({
            ...phase,
            routes: [...phase.routes, ...children],
        });
        return {
            ...route,
            phases,
        };
    });
}
//# sourceMappingURL=route.js.map