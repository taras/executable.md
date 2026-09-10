"use strict";
/**
 * 😵‍💫 This file has been vibe coded 😵‍💫
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.printHelp = printHelp;
exports.printVersion = printVersion;
exports.printErrors = printErrors;
function printHelp(intent) {
    let route = intent.definition;
    let subject = title(intent);
    let heading = route.version ? `${subject} ${route.version}` : subject;
    let children = route.phases.flatMap((phase) => phase.routes);
    let args = [];
    let options = [];
    for (let param of params(route)) {
        let syntax = param.cli.syntax;
        if (!syntax) {
            continue;
        }
        let row = [syntax.label, param.description];
        if (syntax.type === "argument") {
            args.push(row);
        }
        else {
            options.push(row);
        }
    }
    let usage = [subject, "[OPTIONS]", ...args.map(([label]) => label)].join(" ");
    if (children.length > 0) {
        usage += route.methods.includes("execute") ? " [COMMAND]" : " <COMMAND>";
    }
    let lines = [heading];
    if (route.description) {
        lines.push(...wrap(route.description, width));
    }
    lines.push("", "Usage:", `  ${usage}`);
    if (args.length > 0) {
        lines.push("", "Arguments:", ...list(args));
    }
    if (children.length > 0) {
        lines.push("", "Commands:", ...list(children.map((child) => [child.name, child.description])));
    }
    options.push(["-h, --help", "Print help"]);
    if (route.methods.includes("version")) {
        options.push(["-v, --version", "Print version"]);
    }
    lines.push("", "Options:", ...list(options));
    return lines.join("\n");
}
function printVersion(intent) {
    let version = intent.definition.version;
    if (!version) {
        throw new TypeError(`route ${JSON.stringify(intent.route)} has no version`);
    }
    return `${title(intent)} ${version}`;
}
function printErrors(result) {
    let subject = title(result);
    switch (result.code) {
        case "method-not-allowed":
            return [
                `${subject} does not support ${result.method.toUpperCase()}`,
                "",
                "Available methods:",
                ...result.allowed.map((method) => `  ${method.toUpperCase()}`),
            ].join("\n");
        case "unprocessable-content": {
            return result.issues.map(problem).join("\n");
        }
    }
}
function params(route) {
    return route.phases.flatMap((phase) => Object.values(phase.params));
}
function title(intent) {
    return intent.path.length > 0
        ? intent.path.join(" ")
        : intent.definition.name;
}
function list(rows) {
    let size = Math.max(...rows.map(([label]) => label.length));
    let available = Math.max(24, width - size - 4);
    let lines = [];
    for (let [label, description] of rows) {
        let prefix = `  ${label.padEnd(size)}`;
        if (!description) {
            lines.push(prefix.trimEnd());
            continue;
        }
        let [first, ...rest] = wrap(description, available);
        lines.push(`${prefix}  ${first}`);
        lines.push(...rest.map((line) => `${" ".repeat(size + 4)}${line}`));
    }
    return lines;
}
function wrap(text, size) {
    let words = text.trim().split(/\s+/);
    let lines = [];
    let line = "";
    for (let word of words) {
        if (line.length === 0) {
            line = word;
        }
        else if (line.length + word.length + 1 <= size) {
            line += ` ${word}`;
        }
        else {
            lines.push(line);
            line = word;
        }
    }
    if (line) {
        lines.push(line);
    }
    return lines;
}
function problem(issue) {
    let location = address(issue.path);
    return location ? `${location}: ${issue.message}` : message(issue.message);
}
function message(value) {
    if (value.startsWith("unexpected ")) {
        let encoded = value.slice("unexpected ".length);
        try {
            let token = JSON.parse(encoded);
            if (typeof token === "string") {
                return `unexpected: \`${token.replaceAll("`", "\\`")}\``;
            }
        }
        catch {
            // Keep non-JSON diagnostics intact.
        }
    }
    return value;
}
function address(path) {
    if (!path || path.length === 0) {
        return;
    }
    let result = "";
    for (let segment of path) {
        let key = typeof segment === "object" && segment !== null
            ? segment.key
            : segment;
        if (typeof key === "number") {
            result += `[${key}]`;
        }
        else if (typeof key === "symbol") {
            result += `[${String(key)}]`;
        }
        else if (/^[A-Za-z_$][\w$]*$/.test(key)) {
            result += result ? `.${key}` : key;
        }
        else {
            result += `[${JSON.stringify(key)}]`;
        }
    }
    return result;
}
const width = 80;
//# sourceMappingURL=print.js.map