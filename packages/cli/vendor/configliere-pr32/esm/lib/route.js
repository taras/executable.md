// deno-lint-ignore-file ban-types
import { brand, } from "./pipeline.js";
export function route(start, ...elements) {
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
export function version(semver) {
    return brand((route) => ({
        ...route,
        methods: [...route.methods, "version"],
        version: semver,
    }));
}
export function executable() {
    return brand((route) => ({
        ...route,
        methods: [...route.methods, "execute"],
    }));
}
export function routes(...children) {
    return brand((route) => {
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
export function transform(transform, ...elements) {
    return brand((route) => {
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