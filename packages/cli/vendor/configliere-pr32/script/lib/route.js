"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.route = route;
exports.version = version;
exports.executable = executable;
exports.routes = routes;
exports.transform = transform;
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
function transform(transform, ...elements) {
    return (0, pipeline_js_1.brand)((route) => {
        let before = params(route);
        let next = apply(route, elements);
        let nextParams = params(next);
        let added = keys(next).filter((key) => before[key] !== nextParams[key]);
        let phases = [...next.phases];
        let phase = phases.pop();
        phases.push({
            ...phase,
            transforms: [
                ...(phase.transforms ?? []),
                { transform, keys: added },
            ],
        });
        return {
            ...next,
            phases,
        };
    });
}
function apply(route, elements) {
    return elements.reduce((value, element) => element(value), route);
}
function params(route) {
    return route.phases[route.phases.length - 1].params;
}
function keys(route) {
    return Object.keys(params(route));
}
//# sourceMappingURL=route.js.map