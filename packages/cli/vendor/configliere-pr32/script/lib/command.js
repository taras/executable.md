"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.command = command;
function command(start, ...elements) {
    let zero = {
        ...start,
        methods: ["help", "execute"],
        phases: [{
                params: {},
                routes: [],
                values: [],
                envs: [],
            }],
    };
    return elements.reduce((value, element) => element(value), zero);
}
//# sourceMappingURL=command.js.map