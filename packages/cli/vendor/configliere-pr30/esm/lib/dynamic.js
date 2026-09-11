import { brand } from "./pipeline.js";
export function dynamic(extension, ..._valid) {
    return brand((route) => {
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