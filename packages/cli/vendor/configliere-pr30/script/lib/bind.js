"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromCLI = fromCLI;
exports.fromValues = fromValues;
exports.fromEnv = fromEnv;
exports.bindPhase = bindPhase;
function fromCLI(options) {
    let { param, view, rest } = options;
    return fromRead(param, param.cli.read(view), rest);
}
function fromValues(options) {
    let { param, route, rest } = options;
    let claim = rest.values.claim({
        route,
        address: [param.name],
    });
    if (!claim.result.exists) {
        return { exists: false };
    }
    return {
        exists: true,
        value: {
            rest: {
                ...rest,
                values: claim.rest,
            },
            result: validate(param, claim.result.value.value, [param.name]),
        },
    };
}
function fromEnv(options) {
    let { param, route, rest } = options;
    let claim = rest.envs.claim({
        route,
        address: [param.name],
        key: param.env,
    });
    if (!claim.result.exists) {
        return { exists: false };
    }
    let value = claim.result.value.value;
    return {
        exists: true,
        value: {
            rest: {
                ...rest,
                envs: claim.rest,
            },
            result: decode(param, value, param.decode(value), [param.name]),
        },
    };
}
function bindPhase(options) {
    let { phase, segment } = options;
    let rest = options.rest;
    let params = Object.values(phase.params);
    let pending = new Map(params.map((param) => [param.name, param]));
    let results = new Map();
    function settle(param, binding) {
        rest = binding.rest;
        results.set(param.name, binding.result);
        pending.delete(param.name);
    }
    function accept(param, attempt) {
        if (!attempt.exists) {
            return;
        }
        settle(param, attempt.value);
    }
    // Every pending reader proposes a claim against the same immutable view.
    // Commit the proposal beginning earliest in argv, then recompute the view.
    // This lets `--port 9000` outrank a positional claim on `9000` without
    // attaching binding-policy metadata to either reader.
    while (true) {
        let horizon = first(rest.tokens, segment.range);
        let offer;
        for (let param of pending.values()) {
            let view = rest.tokens.view({
                range: segment.range,
                through: horizon?.index,
            });
            let read = param.cli.read(view);
            if (read.result.ok && !read.result.value.exists) {
                continue;
            }
            let index = earliest(read.claim.tokens);
            if (!offer || index < offer.index) {
                offer = { param, read, index };
            }
        }
        if (!offer) {
            break;
        }
        accept(offer.param, fromRead(offer.param, offer.read, rest));
    }
    // Address sources have stable visibility once the route is known. They are
    // tried only after CLI has reached its fixed point so a provisional CLI miss
    // cannot let a lower-priority source settle the parameter too early.
    for (let source of [fromEnv, fromValues]) {
        for (let param of pending.values()) {
            accept(param, source({
                param,
                route: segment.path,
                rest,
            }));
        }
    }
    // Only total absence reaches the schema as undefined. This is where required,
    // optional, and defaulting parameters diverge.
    for (let param of pending.values()) {
        results.set(param.name, validate(param, undefined, [param.name]));
    }
    let model = {};
    let issues = [];
    let valid = true;
    // Collect in declaration order, independent of the source or sweep that
    // settled each parameter.
    for (let param of params) {
        let result = results.get(param.name);
        issues.push(...result.issues ?? []);
        if (result.ok) {
            model[param.name] = result.value;
        }
        else {
            valid = false;
        }
    }
    return { rest, model, issues, valid };
}
function fromRead(param, read, rest) {
    let path = [param.name];
    if (!read.result.ok) {
        return {
            exists: true,
            value: {
                rest: {
                    ...rest,
                    tokens: read.claim.rest,
                },
                result: read.result,
            },
        };
    }
    if (!read.result.value.exists) {
        return { exists: false };
    }
    let value = read.result.value.value;
    let candidates = typeof value === "string" ? param.decode(value) : [value];
    let result = merge(decode(param, value, candidates, path), read.result.issues);
    return {
        exists: true,
        value: {
            rest: {
                ...rest,
                tokens: read.claim.rest,
            },
            result,
        },
    };
}
function decode(param, value, candidates, path) {
    if (candidates.length === 0) {
        return {
            ok: false,
            issues: [{
                    message: `unable to decode ${JSON.stringify(value)}`,
                    path,
                }],
        };
    }
    let issues;
    for (let candidate of candidates) {
        let result = validate(param, candidate, path);
        if (result.ok) {
            return result;
        }
        issues = issues ?? result.issues;
    }
    return {
        ok: false,
        issues: issues ?? [],
    };
}
function validate(param, value, path) {
    let validated = param.schema["~standard"].validate(value);
    if (validated instanceof Promise) {
        return {
            ok: false,
            issues: [{
                    message: `async schemas are not allowed`,
                    path,
                }],
        };
    }
    if (validated.issues) {
        return {
            ok: false,
            issues: validated.issues.map((issue) => ({
                ...issue,
                message: issue.message,
                path,
            })),
        };
    }
    return {
        ok: true,
        issues: [],
        value: validated.value,
    };
}
function merge(result, issues) {
    if (!issues || issues.length === 0) {
        return result;
    }
    return {
        ...result,
        issues: [...issues, ...(result.issues ?? [])],
    };
}
function first(tokens, range) {
    for (let token of tokens.view({ range })) {
        if (token.type === "word") {
            return token;
        }
    }
}
function earliest(tokens) {
    let first = Infinity;
    for (let token of tokens) {
        first = Math.min(first, token.index);
    }
    return first;
}
//# sourceMappingURL=bind.js.map