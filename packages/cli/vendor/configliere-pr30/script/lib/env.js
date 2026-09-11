"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Envs = void 0;
exports.env = env;
exports.withEnvs = withEnvs;
const pipeline_js_1 = require("./pipeline.js");
function env(key) {
    return (0, pipeline_js_1.brand)((param) => ({ ...param, env: key }));
}
function withEnvs(envs) {
    return (0, pipeline_js_1.brand)((route) => {
        let phases = [...route.phases];
        let phase = phases.pop();
        phases.push({
            ...phase,
            envs: phase.envs.concat(envs),
        });
        return {
            ...route,
            phases,
        };
    });
}
class Envs {
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
        let id = routeId(path);
        return new Envs(new Map([...this.mounts.entries(), [
                id,
                (this.mounts.get(id) ?? []).concat(sources),
            ]]), this.claims);
    }
    claim({ route, address, key = envKey([...route, ...address]) }) {
        let id = claimId([...route, ...address]);
        let nope = { result: { exists: false }, rest: this };
        if (this.claims.has(id)) {
            return nope;
        }
        for (let end = route.length; end >= 0; end--) {
            let mount = routeId(route.slice(0, end));
            let sources = this.mounts.get(mount) ?? [];
            for (let { name, value } of sources) {
                if (!Object.hasOwn(value, key) || typeof value[key] === "undefined") {
                    continue;
                }
                let rest = new Envs(this.mounts, new Set([...this.claims, id]));
                return {
                    result: {
                        exists: true,
                        value: {
                            source: name,
                            address,
                            key,
                            value: value[key],
                        },
                    },
                    rest,
                };
            }
        }
        return nope;
    }
}
exports.Envs = Envs;
function routeId(path) {
    return `/${path.join("/")}`;
}
function claimId(address) {
    return JSON.stringify(address);
}
function envKey(address) {
    return address.map(normalize).filter(Boolean).join("_");
}
function normalize(value) {
    return value
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z\d])([A-Z])/g, "$1_$2")
        .replace(/[^A-Za-z\d]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toUpperCase();
}
//# sourceMappingURL=env.js.map