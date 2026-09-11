/**
 * Tier CFE — the `xmd` command tree expressed through Configliere's proposed
 * route API (issue #796).
 *
 * This is a production-boundary test for one evaluation: it exercises the real
 * definitions in `packages/cli/src/cli-route.ts`, not a tree written for the
 * occasion. What it proves is what the route API can and cannot express about
 * the released `xmd` grammar. Behaviour a caller observes stays the business of
 * the black-box suites, which are unchanged.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { checkpoint, command, name, option, parse, schema } from "configliere";
import type { Execute, ModelsByRoute, Result, RoutePath, ValueSource } from "configliere";
import { z } from "zod";
import {
  commandToken,
  isExecute,
  isHelp,
  isVersion,
  parseCommands,
  parseFailure,
  parseShorthand,
  renderProgramHelp,
  renderRouteHelp,
  renderVersion,
  routeFor,
  routeValues,
  unexpectedOnly,
  valueFlags,
  XMD_VERSION,
} from "../src/cli-route.ts";
import type { AnyXmdIntent, ParseOutcome, XmdIntent } from "../src/cli-route.ts";

/** One command line, parsed the way the CLI parses it. */
function run(argv: string[], values: readonly ValueSource[] = []): ParseOutcome {
  return commandToken(argv) === undefined
    ? parseShorthand(argv, values)
    : parseCommands(argv, values);
}

/** The intent one command line settles on, or a failure this test can read. */
function intent(argv: string[], values: readonly ValueSource[] = []): AnyXmdIntent {
  const outcome = run(argv, values);
  if (!outcome.ok) {
    throw new Error(`${argv.join(" ")}: ${parseFailure(outcome).message}`);
  }
  return outcome;
}

/** The method and route one command line selects, as one readable string. */
function selection(argv: string[]): string {
  const outcome = run(argv);
  if (!outcome.ok) {
    return `${outcome.code} ${outcome.route}`;
  }
  return `${outcome.method.toUpperCase()} ${outcome.route}`;
}

/** What one command line refuses with, or the empty string when it does not. */
function refusal(argv: string[]): string {
  const outcome = run(argv);
  return outcome.ok ? "" : parseFailure(outcome).message;
}

/**
 * Handlers written against one entry point each.
 *
 * Their parameter types are the only proof CFE3 needs: each one names the
 * exact intent it accepts, reads its own model, and would not compile against
 * another route's. Nothing here casts, re-checks a name, or reconstructs an
 * optional field.
 */
type ExecuteAt<P extends RoutePath> = Extract<XmdIntent, Execute<P, ModelsByRoute>>;

function shorthandHandler(command: ExecuteAt<"/">): string {
  return `${command.model.path ?? "<none>"} raw=${command.model.raw}`;
}

function runHandler(command: ExecuteAt<"/run">): string {
  return `${command.model.path ?? "<none>"} include=${command.model.include.join(",")}`;
}

function planHandler(command: ExecuteAt<"/plan">): string {
  return `${command.model.request ?? "<none>"} output=${command.model.output ?? "<stdout>"}`;
}

function workflowStartHandler(command: ExecuteAt<"/workflow/start">): string {
  return `${command.model.target ?? "<none>"} id=${command.model.id ?? "<generated>"}`;
}

function workflowStatusHandler(command: ExecuteAt<"/workflow/status">): string {
  return `${command.model.target ?? "<none>"} json=${command.model.json}`;
}

describe("Tier CFE — the xmd route definitions", () => {
  it("CFE1: the first token alone selects a top-level command", function* () {
    // A shorthand run, the named run, another named command, and a command
    // name written where a document belongs. The last is the one Configliere
    // would otherwise route on, because its search accepts any word in the
    // segment rather than the first token.
    expect({
      shorthand: selection(["doc.md"]),
      named: selection(["run", "doc.md"]),
      other: selection(["syntax"]),
      later: selection(["--raw", "run"]),
      laterWord: selection(["doc.md", "run"]),
    }).toEqual({
      shorthand: "EXECUTE /",
      named: "EXECUTE /run",
      other: "EXECUTE /syntax",
      later: "EXECUTE /",
      laterWord: "unprocessable-content /",
    });

    // And the document really is the token, not the command.
    const shorthand = intent(["--raw", "run"]);
    expect(isExecute(shorthand) && shorthand.route === "/" ? shorthand.model.path : undefined).toBe(
      "run",
    );
  });

  it("CFE2: each workflow action is its own route", function* () {
    expect({
      status: selection(["workflow", "status", "abc", "--json"]),
      start: selection(["workflow", "start", "flow.md", "--id", "one"]),
      resume: selection(["workflow", "resume", "run-1"]),
      answer: selection(["workflow", "answer", "run-1", "wait-1", "{}"]),
      bare: selection(["workflow"]),
    }).toEqual({
      status: "EXECUTE /workflow/status",
      start: "EXECUTE /workflow/start",
      resume: "EXECUTE /workflow/resume",
      answer: "EXECUTE /workflow/answer",
      // The address exists and executes nothing, which is what `route()` says.
      bare: "method-not-allowed /workflow",
    });

    const status = intent(["workflow", "status", "abc", "--json"]);
    expect(
      isExecute(status) && status.route === "/workflow/status" ? status.model : undefined,
    ).toEqual({ target: "abc", json: true, artifact: undefined });
  });

  it("CFE3: method and route narrow the intent to one model", function* () {
    const shorthand = intent(["doc.md", "--raw"]);
    const named = intent(["run", "doc.md"]);
    const planned = intent(["plan", "prepare the release", "--output", "out.md"]);
    const started = intent(["workflow", "start", "flow.md", "--id", "one"]);
    const inspected = intent(["workflow", "status", "abc", "--json"]);

    const described: string[] = [];
    for (const settled of [shorthand, named, planned, started, inspected]) {
      if (!isExecute(settled)) {
        continue;
      }
      switch (settled.route) {
        case "/":
          described.push(shorthandHandler(settled));
          break;
        case "/run":
          described.push(runHandler(settled));
          break;
        case "/plan":
          described.push(planHandler(settled));
          break;
        case "/workflow/start":
          described.push(workflowStartHandler(settled));
          break;
        case "/workflow/status":
          described.push(workflowStatusHandler(settled));
          break;
        default:
          described.push(`unhandled ${settled.route}`);
      }
    }

    expect(described).toEqual([
      "doc.md raw=true",
      "doc.md include=components,.",
      "prepare the release output=out.md",
      "flow.md id=one",
      "abc json=true",
    ]);

    // Help and version narrow by method, and carry no model to narrow.
    const help = intent(["run", "--help"]);
    const version = intent(["--version"]);
    expect({
      help: isHelp(help) && help.route === "/run",
      version: isVersion(version) && version.route === "/",
      executeIsNeither: isHelp(named) || isVersion(named),
    }).toEqual({ help: true, version: true, executeIsNeither: false });

    // A parent's model is reachable from the child's intent without merging
    // the two definitions.
    const started2 = intent(["workflow", "start", "flow.md"]);
    expect(
      isExecute(started2) && started2.route === "/workflow/start" ? started2.models : {},
    ).toHaveProperty("/workflow");
  });

  it("CFE4: a checkpoint carries values and cannot add a parameter or a route", function* () {
    // The supported dynamic phase, exercised exactly as the guide describes:
    // parse, perform the work, resume with a `Result<ValueSource[]>`.
    const app = command(
      name("probe"),
      option({ ...name("config") }, schema(z.string().optional())),
      checkpoint(),
      option({ ...name("channel") }, schema(z.string().optional())),
    );

    const step = parse(app, { argv: ["--config", "app.json", "--channel", "beta"] });
    if (!("resume" in step)) {
      throw new Error("the checkpoint produced no increment");
    }
    expect(step.model.config).toBe("app.json");

    const loaded: Result<ValueSource[]> = {
      ok: true,
      value: [{ name: "app.json", value: { channel: "stable", generated: "value" } }],
    };
    const settled = step.resume(loaded);
    if (!settled.ok || settled.method !== "execute") {
      throw new Error("the checkpoint did not settle an execute intent");
    }

    // A declared parameter takes the loaded value when the command line wrote
    // none, and the command line still outranks it when it did.
    expect(settled.model.channel).toBe("beta");

    // And the limitation the migration turns on: a value source cannot make a
    // parameter exist. `generated` is in the loaded object and in no model,
    // and no `--generated` option was created for the command line to write.
    expect(Object.hasOwn(settled.model, "generated")).toBe(false);
    const generated = parse(app, { argv: ["--generated", "value"] });
    expect("resume" in generated).toBe(true);

    // Which is why the CLI still lifts every `--props-*` occurrence out of
    // argv before parsing: the document is inspected first, and the options it
    // declares cannot be added to the route it would have been added to.
    const supplied = run(["run", "doc.md", "--props-name", "Ada"]);
    expect(supplied.ok).toBe(false);
    expect(unexpectedOnly(supplied)).toBe(true);
  });

  it("CFE5: help and version render what the released CLI rendered", function* () {
    const program = renderProgramHelp();
    expect(program).toContain("Usage: xmd <COMMAND> [OPTIONS]");
    for (const listed of ["run", "plan", "test", "syntax", "upgrade", "test-agent", "workflow"]) {
      expect(program).toContain(listed);
    }
    // The program page lists commands and nothing a shorthand run configures.
    expect(program).not.toContain("--raw");

    const runPage = renderRouteHelp(routeFor(["run"])!, ["run"]);
    expect(runPage).toContain("Usage: xmd run [OPTIONS] [path]");
    expect(runPage).toContain("-e, --eval");
    expect(runPage).toContain("--include <INCLUDE>...");
    expect(runPage).toContain("[default: components,.]");

    const syntaxPage = renderRouteHelp(routeFor(["syntax"])!, ["syntax"]);
    expect(syntaxPage).toContain("Usage: xmd syntax [OPTIONS] [component]");
    for (const absent of ["--verbose", "--journal", "--raw", "--timeout", "--secret-detection"]) {
      expect(syntaxPage).not.toContain(absent);
    }

    // Only the root offers a version, and it writes the bare version rather
    // than the stock `xmd 0.12.0`.
    const version = intent(["--version"]);
    expect(isVersion(version) ? renderVersion(version) : "").toBe(XMD_VERSION);
    expect(selection(["run", "--version"])).toBe("method-not-allowed /run");
    expect(selection(["upgrade", "--version"])).toBe("method-not-allowed /upgrade");
  });

  it("CFE6: the separator, the sentinel and a selector keep their meanings", function* () {
    // A bare `-` is a word an argument can take.
    const stdin = intent(["run", "-"]);
    expect(isExecute(stdin) && stdin.route === "/run" ? stdin.model.path : undefined).toBe("-");

    // After `--` it is a literal instead, and reaches the intent as one.
    const separated = intent(["run", "--", "-"]);
    expect(
      isExecute(separated) && separated.route === "/run" ? separated.model.path : "unset",
    ).toBe(undefined);
    expect([...separated.literals].map((token) => token.text)).toEqual(["-"]);

    // A selector is a flag to this tokenizer, so no argument can ever take it.
    // The CLI lifts it out of argv before parsing for exactly this reason.
    expect(selection(["run", "-#Section"])).toBe("unprocessable-content /run");

    // A dash-leading plan request survives the separator as a literal.
    const planned = intent(["plan", "--", "-request"]);
    expect([...planned.literals].map((token) => token.text)).toEqual(["-request"]);
  });

  it("CFE7: a repeatable option is a value source, not a reader", function* () {
    // Written twice, the ordinary reader claims one occurrence and reports the
    // rest as unexpected tokens — which is why the CLI lifts them.
    const written = run(["run", "doc.md", "--include", "a", "--include", "b"]);
    expect(written.ok).toBe(false);

    // Lifted and handed back as the route's own value source, the model holds
    // the ordered list and it replaces the default.
    const supplied = intent(["run", "doc.md"], routeValues(["run"], { include: ["a", "b"] }));
    expect(isExecute(supplied) && supplied.route === "/run" ? supplied.model.include : []).toEqual([
      "a",
      "b",
    ]);

    // Absent, the default stands.
    const bare = intent(["run", "doc.md"]);
    expect(isExecute(bare) && bare.route === "/run" ? bare.model.include : []).toEqual([
      "components",
      ".",
    ]);

    // The same channel carries `--pattern` for the one command that has it.
    const patterned = intent(["test", "suite"], routeValues(["test"], { pattern: ["**/*.md"] }));
    expect(
      isExecute(patterned) && patterned.route === "/test" ? patterned.model.pattern : [],
    ).toEqual(["**/*.md"]);
  });

  it("CFE8: malformed input fails with the first thing wrong", function* () {
    expect(refusal(["upgrade", "--nope"])).toContain("--nope");
    expect(refusal(["run", "doc.md", "--journal"])).toContain("--journal requires a value");

    // A required option that was never written is a schema failure, not a
    // routing one.
    const required = run(["test-agent"]);
    expect(required.ok).toBe(false);
    expect(unexpectedOnly(required)).toBe(false);

    // An option belonging to another command is an unexpected token here.
    const misplaced = run(["syntax", "--raw"]);
    expect(misplaced.ok).toBe(false);
    expect(unexpectedOnly(misplaced)).toBe(true);
  });

  it("CFE11: every value-taking flag is read from the definitions", function* () {
    const flags = valueFlags();
    for (const takesValue of ["--journal", "-j", "--eval", "-e", "--include", "--id", "--at"]) {
      expect({ flag: takesValue, listed: flags.has(takesValue) }).toEqual({
        flag: takesValue,
        listed: true,
      });
    }
    for (const switched of ["--raw", "--verbose", "-V", "--json", "--secret-detection"]) {
      expect({ flag: switched, listed: flags.has(switched) }).toEqual({
        flag: switched,
        listed: false,
      });
    }
  });

  it("CFE13: no document-declared positional is defined by any route", function* () {
    // #173 stays out of this spike. Every positional in the tree is one the
    // command itself declares, and a document contributes none.
    const positional = new Set<string>();
    const pending = [{ definition: routeFor([])!, path: [] as string[] }];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) {
        continue;
      }
      for (const phase of current.definition.phases) {
        for (const child of phase.routes) {
          pending.push({ definition: child, path: [...current.path, child.name] });
        }
        for (const param of Object.values(phase.params)) {
          if (param.cli.syntax?.type === "argument") {
            positional.add(`${["", ...current.path].join("/") || "/"}:${param.name}`);
          }
        }
      }
    }

    expect([...positional].sort()).toEqual([
      "/:path",
      "/plan:request",
      "/run:path",
      "/syntax:component",
      "/test:path",
      "/upgrade:tag",
      "/workflow/answer:argument",
      "/workflow/answer:target",
      "/workflow/answer:value",
      "/workflow/cancel:target",
      "/workflow/delete:target",
      "/workflow/export:target",
      "/workflow/fork:argument",
      "/workflow/fork:target",
      "/workflow/history:target",
      "/workflow/resume:target",
      "/workflow/start:target",
      "/workflow/status:target",
    ]);
  });
});
