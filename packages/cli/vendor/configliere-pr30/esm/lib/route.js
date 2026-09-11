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
//# sourceMappingURL=route.js.map