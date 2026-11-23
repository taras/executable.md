import type { AnyRoute } from "@bomb.sh/router";

const helpRow = ["-h, --help", "show help"];
const versionRow = ["-v, --version", "show version"];

function section(title: string, rows: readonly (readonly string[])[]): string {
  return [title, ...rows.map(([label, text]) => `   ${label.padEnd(25)} ${text}`)].join("\n");
}

export function renderCommandHelp(routes: readonly AnyRoute[], name?: string): string {
  const command = routes.find((route) => route.name === name);
  if (command === undefined) {
    return [
      "Usage: xmd <COMMAND> [OPTIONS]",
      section(
        "Commands:",
        routes.map((route) => [route.name, route.description ?? ""]),
      ),
      section("Options:", [helpRow, versionRow]),
    ].join("\n\n");
  }

  const args: string[][] = [];
  const opts: string[][] = [];
  for (const phase of command.phases) {
    for (const param of Object.values(phase.model.params)) {
      const syntax = param.cli.syntax;
      if (syntax === undefined) {
        continue;
      }
      const fallback = param.schema["~standard"].validate(undefined);
      const value = "value" in fallback ? fallback.value : undefined;
      const text = [
        param.description,
        value === undefined ? undefined : `[default: ${String(value)}]`,
      ]
        .filter(Boolean)
        .join(" ");
      const required = "issues" in fallback || param.name === "agentProvider";
      const argument =
        param.cardinality === "many"
          ? `<${param.name}>...`
          : required
            ? `<${param.name}>`
            : `[${param.name}]`;
      if (syntax.type === "argument") {
        args.push([argument, text]);
        continue;
      }
      const label = syntax.label.endsWith(" <VALUE>")
        ? syntax.label.replace(/ <VALUE>$/, ` ${argument.toUpperCase()}`)
        : syntax.label.split(", --no-")[0];
      const aliases =
        param.name === "verbose" && ["run", "test", "workflow"].includes(command.name)
          ? `-V, ${label}`
          : label;
      opts.push([aliases, text]);
    }
  }
  const positionals = args.map(([label]) => label);
  const grammar =
    command.name === "repl" ? [...positionals, "[OPTIONS]"] : ["[OPTIONS]", ...positionals];
  const usage = [`Usage: xmd ${command.name}`, ...grammar].join(" ");
  return [
    usage,
    ...(args.length > 0 ? [section("Arguments:", args)] : []),
    section("Options:", [...opts, helpRow]),
  ].join("\n\n");
}
