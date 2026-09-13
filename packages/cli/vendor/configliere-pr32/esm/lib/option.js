import { param } from "./param.js";
import { dasherize } from "./dasherize.js";
import { brand, } from "./pipeline.js";
import { cli } from "./read.js";
export function option(named, ...elements) {
    const added = elements.reduce((value, element) => element(value), param(named, cli([`--${dasherize(named.name)}`])));
    return brand((route) => {
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