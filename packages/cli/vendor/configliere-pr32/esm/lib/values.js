import { brand } from "./pipeline.js";
export function withValues(values) {
    return brand((route) => {
        let phases = [...route.phases];
        let phase = phases.pop();
        phases.push({
            ...phase,
            values: phase.values.concat(values),
        });
        return {
            ...route,
            phases,
        };
    });
}
export class Values {
    constructor(mounts = new Map(), claims = new Set()) {
        Object.defineProperty(this, "mounts", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "claims", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.mounts = mounts;
        this.claims = claims;
    }
    mount(path, sources) {
        if (sources.length === 0) {
            return this;
        }
        const id = routeId(path);
        return new Values(new Map([...this.mounts.entries(), [
                id,
                (this.mounts.get(id) ?? []).concat(sources),
            ]]), this.claims);
    }
    claim({ route, address }) {
        let id = claimId([...route, ...address]);
        const nope = { result: { exists: false }, rest: this };
        if (this.claims.has(id)) {
            return nope;
        }
        for (let end = route.length; end >= 0; end--) {
            let mountId = routeId(route.slice(0, end));
            let sources = this.mounts.get(mountId) ?? [];
            for (let { name, value } of sources) {
                let result = find(value, [...route.slice(end), ...address]);
                if (result.exists) {
                    let rest = new Values(this.mounts, new Set([...this.claims, id]));
                    return {
                        result: {
                            exists: true,
                            value: {
                                source: name,
                                address,
                                value: result.value,
                            },
                        },
                        rest,
                    };
                }
            }
        }
        return nope;
    }
}
function routeId(address) {
    return `/${address.join("/")}`;
}
function claimId(address) {
    return JSON.stringify(address);
}
function find(value, path) {
    let current = value;
    for (let key of path) {
        if (current === null ||
            (typeof current !== "object" && typeof current !== "function") ||
            !Object.hasOwn(current, key)) {
            return { exists: false };
        }
        current = current[key];
    }
    return {
        exists: true,
        value: current,
    };
}
//# sourceMappingURL=values.js.map