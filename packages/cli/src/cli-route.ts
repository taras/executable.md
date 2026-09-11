/**
 * The `xmd` command tree, expressed through Configliere's proposed route API.
 *
 * This module owns the immutable route definitions, the synchronous parse
 * driver, and the presentation that keeps help and version output identical to
 * the released CLI's. Execution, I/O and process lifetime stay where they
 * already are.
 *
 * Two definitions are exported rather than one. Configliere selects a child
 * route from any unclaimed word in the current segment, while `xmd` selects a
 * top-level command only from the first token — a word in any other position
 * is a document reference. {@link definitionFor} picks between them, which is
 * what keeps `xmd --raw run -e '# Probe'` naming a document called `run`
 * rather than the named `run` command.
 */

import {
  argument,
  cli,
  command,
  description,
  extend,
  name,
  option,
  parse,
  route,
  routes,
  schema,
  toggle,
  version,
} from "configliere";
import type {
  AnyRoute,
  Execute,
  Help,
  Intent,
  IntentsOf,
  Issue,
  ModelsByRoute,
  Outcome,
  Param,
  RoutePath,
  Schema,
  ValueSource,
  Version,
} from "configliere";
import { z } from "zod";
import { EVAL_ALIAS, EVAL_OPTION } from "./eval-source.ts";
import denoJson from "../deno.json" with { type: "json" };

/** The version this build reports, from the manifest it was built with. */
export const XMD_VERSION: string = denoJson.version;

/**
 * A Standard Schema that answers `undefined` with a default.
 *
 * `schema()` accepts `StandardSchemaV1<T, T>`, so a Zod schema carrying
 * `.default()` is rejected: the default widens the input type to `T |
 * undefined` while the output stays `T`. Defaults are therefore expressed
 * here, over the same Standard Schema interface the parser validates through.
 */
interface MarkedSchema<T> extends Schema<T> {
  readonly xmd: { readonly required: boolean };
}

function withDefault<T>(inner: Schema<T>, value: T, required = false): Schema<T> {
  const marked: MarkedSchema<T> = {
    "~standard": {
      version: 1,
      vendor: "xmd",
      validate(input) {
        if (input === undefined) {
          return { value };
        }
        return inner["~standard"].validate(input);
      },
    },
    // Help distinguishes a value the schema itself supplies from one supplied
    // beside it: `xmd test [path]` has always been optional and
    // `--agent-provider <AGENTPROVIDER>` has always been required, though both
    // resolve to a value when nobody writes one. The proposed API expresses
    // only the first, so the second is recorded here.
    xmd: { required },
  };
  return marked;
}

/** Whether help describes this parameter as one a caller must supply. */
function describedAsRequired(param: Param<string, unknown>): boolean {
  const schema: unknown = param.schema;
  if (typeof schema !== "object" || schema === null || !("xmd" in schema)) {
    return false;
  }
  const marker = schema.xmd;
  return typeof marker === "object" && marker !== null && "required" in marker &&
    marker.required === true;
}

/**
 * `--include`, as `run`, `test`, `plan` and `syntax` each declare it.
 *
 * A repeatable option cannot be read from argv through this API. `bindPhase`
 * truncates every reader's view at the first unclaimed word, so a reader never
 * sees an occurrence written after a value, and it settles its parameter on
 * the first success either way. The occurrences are lifted out of argv by the
 * CLI's own scanner and handed back as a route value source, which is the one
 * channel that carries a list.
 */
const includeOption = option(
  { ...name("include"), description: "component search directory" },
  schema(withDefault(z.array(z.string()), ["components", "."])),
);

const secretDetectionToggle = toggle(
  {
    ...name("secretDetection"),
    description:
      "scan durable events for credentials before they persist; " +
      "disable with --no-secret-detection",
  },
  schema(withDefault(z.boolean(), true)),
);

const verboseSwitch = option(
  { ...name("verbose"), description: "log journal entries to stderr" },
  cli(["-V", "--verbose"], { switch: true }),
  schema(withDefault(z.boolean(), false)),
);

const journalOption = option(
  { ...name("journal"), description: "write a diagnostic JSONL trace (path must not exist)" },
  cli(["-j", "--journal"]),
  schema(z.string().optional()),
);

const rawSwitch = option(
  {
    ...name("raw"),
    description: "output raw markdown without normalization or terminal formatting",
  },
  cli(["--raw"], { switch: true }),
  schema(withDefault(z.boolean(), false)),
);

/**
 * Everything a document execution configures.
 *
 * One group, folded into both the shorthand root and the named `run` command,
 * so the two forms cannot drift. Each route holds its own copy: parameters
 * belong to the route that owns them, and no model is merged with another
 * after parsing.
 */
const executionGrammar = extend(
  includeOption,
  verboseSwitch,
  journalOption,
  rawSwitch,
  option(
    { ...name("agentProvider"), description: "agent provider for agent components" },
    schema(withDefault(z.string(), "acpx", true)),
  ),
  option(
    {
      ...name("defaultAgent"),
      description: "default agent name (overrides DEFAULT_AGENT_NAME)",
    },
    schema(z.string().optional()),
  ),
  option(
    {
      ...name("timeout"),
      description: "deadline for the whole run, as a duration (500ms, 30s, 5min)",
    },
    schema(z.string().optional()),
  ),
  option(
    {
      ...name("timeoutExec"),
      description: "default timeout for each exec block, as a duration (500ms, 30s, 5min)",
    },
    schema(z.string().optional()),
  ),
  option(
    {
      ...name("timeoutFetch"),
      description: "default timeout for each fetch, as a duration (500ms, 30s, 5min)",
    },
    schema(z.string().optional()),
  ),
  option(
    { ...name("approveAll"), description: "approve every agent permission request" },
    cli(["--approve-all"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
  option(
    {
      ...name("approveReads"),
      description: "approve read and search agent permissions, ask for the rest (default)",
    },
    cli(["--approve-reads"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
  option(
    { ...name("denyAll"), description: "deny every agent permission request" },
    cli(["--deny-all"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
  secretDetectionToggle,
);

/** The root document argument, and the inline document that replaces it. */
const runSourceGrammar = extend(
  argument(
    {
      ...name("path"),
      description:
        "markdown document to execute, optionally `#` and one target selector; " +
        "`xmd run -` reads the document from standard input instead",
    },
    schema(z.string().optional()),
  ),
  // Declared so `xmd run --help` lists it with every other option. The value
  // is lifted out of argv by readEvalFlags before parsing — see
  // eval-source.ts — so this parameter is never the source of the document.
  option(
    { ...name("eval"), description: "inline markdown document to execute, in place of a path" },
    cli([EVAL_ALIAS, EVAL_OPTION]),
    schema(z.string().optional()),
  ),
);

/** What `xmd --help` says the plan command is for. */
export const PLAN_DESCRIPTION =
  "Turn a request into an XMD Plan, review it, and write the approved source.";

/** What `xmd --help` says the upgrade command is for. */
export const UPGRADE_DESCRIPTION =
  "Upgrade the standalone xmd binary to the latest stable or a specified release.";

const runCommand = command(name("run"), runSourceGrammar, executionGrammar);

const planCommand = command(
  name("plan"),
  description(PLAN_DESCRIPTION),
  argument(
    {
      ...name("request"),
      description: "the request the coding agent should turn into an XMD Plan",
    },
    schema(z.string().optional()),
  ),
  option(
    {
      ...name("output"),
      description: "write the approved source here instead of to stdout (path must not exist)",
    },
    schema(z.string().optional()),
  ),
  option(
    {
      ...name("session"),
      description: "logical name for the assistant session (default: unique to this invocation)",
    },
    schema(z.string().optional()),
  ),
  option(
    {
      ...name("verbose"),
      description: "show generated drafts and XMD check diagnostics on stderr",
    },
    cli(["--verbose"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
  option(
    {
      ...name("journal"),
      description: "record the planning process as diagnostic JSONL (path must not exist)",
    },
    cli(["--journal"]),
    schema(z.string().optional()),
  ),
  includeOption,
  option(
    { ...name("agentProvider"), description: "agent provider for Plan authorship" },
    schema(withDefault(z.string(), "acpx", true)),
  ),
  option(
    {
      ...name("defaultAgent"),
      description: "default agent name (overrides DEFAULT_AGENT_NAME)",
    },
    schema(z.string().optional()),
  ),
  option(
    {
      ...name("timeout"),
      description: "deadline for the whole planning invocation, as a duration (500ms, 30s, 5min)",
    },
    schema(z.string().optional()),
  ),
);

const testCommand = command(
  name("test"),
  argument(
    {
      ...name("path"),
      description: "markdown document or directory to test (defaults to the current directory)",
    },
    schema(withDefault(z.string(), ".")),
  ),
  option(
    {
      ...name("pattern"),
      description: "glob for test documents, relative to a directory target (repeatable)",
    },
    schema(withDefault(z.array(z.string()), ["**/*.test.md"])),
  ),
  includeOption,
  verboseSwitch,
  journalOption,
  rawSwitch,
  secretDetectionToggle,
);

const syntaxCommand = command(
  name("syntax"),
  argument(
    {
      ...name("component"),
      description:
        "component to describe in full — `xmd syntax Elicit` renders its catalog " +
        "metadata and long-form documentation instead of the compact catalog",
    },
    schema(z.string().optional()),
  ),
  includeOption,
  option(
    { ...name("json"), description: "write the symbols as version-2 JSON instead of markdown" },
    cli(["--json"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
);

const upgradeCommand = command(
  name("upgrade"),
  description(UPGRADE_DESCRIPTION),
  argument(
    {
      ...name("tag"),
      description: "exact release tag to install, such as v1.2.3 (default: the latest stable)",
    },
    schema(z.string().optional()),
  ),
  option(
    {
      ...name("status"),
      description: "report how the selected release compares, and change nothing",
    },
    cli(["--status"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
  option(
    {
      ...name("allowDowngrade"),
      description: "consent to installing a release older than the installed one",
    },
    cli(["--allow-downgrade"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
  option(
    {
      ...name("allowPrerelease"),
      description: "consent to installing the exact prerelease tag named",
    },
    cli(["--allow-prerelease"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
  journalOption,
);

const testAgentCommand = command(
  name("test-agent"),
  option(
    {
      ...name("connect"),
      description: "opaque controller route (controller-launched workers only)",
    },
    schema(z.string()),
  ),
);

/** The options every workflow action that executes a run accepts. */
const workflowExecutionGrammar = extend(verboseSwitch, rawSwitch, secretDetectionToggle);

const runIdOption = option(
  {
    ...name("id"),
    description: "run id to create or address (start and fork only; generated when absent)",
  },
  schema(z.string().optional()),
);

const jsonSwitch = option(
  {
    ...name("json"),
    description: "write the inspection result as JSON (status, list and history only)",
  },
  cli(["--json"], { switch: true }),
  schema(withDefault(z.boolean(), false)),
);

const artifactOption = option(
  {
    ...name("artifact"),
    description:
      "inspect this sealed .xmd artifact instead of a retained run (status and history only)",
  },
  schema(z.string().optional()),
);

const workflowStart = command(
  name("start"),
  argument(
    { ...name("target"), description: "markdown definition to start" },
    schema(z.string().optional()),
  ),
  runIdOption,
  workflowExecutionGrammar,
);

const workflowResume = command(
  name("resume"),
  argument(
    { ...name("target"), description: "the run to continue" },
    schema(z.string().optional()),
  ),
  workflowExecutionGrammar,
);

const workflowFork = command(
  name("fork"),
  argument(
    { ...name("target"), description: "the run a fork continues" },
    schema(z.string().optional()),
  ),
  argument(
    { ...name("argument"), description: "the definition a fork runs" },
    schema(z.string().optional()),
  ),
  runIdOption,
  option(
    { ...name("at"), description: "the retained event a fork continues from (fork only)" },
    schema(z.string().optional()),
  ),
  workflowExecutionGrammar,
);

const workflowAnswer = command(
  name("answer"),
  argument(
    { ...name("target"), description: "the run an answer is delivered to" },
    schema(z.string().optional()),
  ),
  argument(
    { ...name("argument"), description: "the wait an answer is delivered to" },
    schema(z.string().optional()),
  ),
  argument(
    { ...name("value"), description: "the answer itself, as one JSON value" },
    schema(z.string().optional()),
  ),
  secretDetectionToggle,
);

const workflowStatus = command(
  name("status"),
  argument({ ...name("target"), description: "the run to inspect" }, schema(z.string().optional())),
  jsonSwitch,
  artifactOption,
);

const workflowList = command(
  name("list"),
  jsonSwitch,
  option(
    { ...name("status"), description: "list only runs retaining this status" },
    schema(z.string().optional()),
  ),
);

const workflowHistory = command(
  name("history"),
  argument(
    { ...name("target"), description: "the run to read history from" },
    schema(z.string().optional()),
  ),
  jsonSwitch,
  option(
    {
      ...name("forkable"),
      description: "add each event's forkability to the history (history only)",
    },
    cli(["--forkable"], { switch: true }),
    schema(withDefault(z.boolean(), false)),
  ),
  artifactOption,
);

const workflowCancel = command(
  name("cancel"),
  argument({ ...name("target"), description: "the run to cancel" }, schema(z.string().optional())),
);

const workflowDelete = command(
  name("delete"),
  argument({ ...name("target"), description: "the run to delete" }, schema(z.string().optional())),
);

const workflowExport = command(
  name("export"),
  argument({ ...name("target"), description: "the run to export" }, schema(z.string().optional())),
  option(
    {
      ...name("output"),
      description:
        "the .xmd file to write the artifact to (export only); the artifact contains " +
        "this run's complete retained Workspace, which may include source, generated files and " +
        "secrets — treat it as confidential",
    },
    schema(z.string().optional()),
  ),
);

/**
 * `xmd workflow` addresses a run rather than executing one, so the route
 * supports help and nothing else. Every action beneath it executes.
 */
const workflowRoute = route(
  name("workflow"),
  description("start, resume, fork, answer, status, list, history, cancel, delete or export"),
  routes(
    workflowStart,
    workflowResume,
    workflowFork,
    workflowAnswer,
    workflowStatus,
    workflowList,
    workflowHistory,
    workflowCancel,
    workflowDelete,
    workflowExport,
  ),
);

/** The whole tree, parsed against when the first token names a command. */
export const xmdCommands = command(
  name("xmd"),
  version(XMD_VERSION),
  runSourceGrammar,
  executionGrammar,
  routes(
    runCommand,
    planCommand,
    testCommand,
    syntaxCommand,
    upgradeCommand,
    testAgentCommand,
    workflowRoute,
  ),
);

/**
 * The shorthand run form, parsed against when the first token names no
 * command.
 *
 * The same grammar as the root of {@link xmdCommands} with no children at all,
 * because Configliere would otherwise select `/run` from a later `run` token —
 * a document reference in this form, not a command.
 */
export const xmdShorthand = command(
  name("xmd"),
  version(XMD_VERSION),
  runSourceGrammar,
  executionGrammar,
);

/** Every intent the full tree can produce. */
export type XmdIntent = IntentsOf<typeof xmdCommands>;

/** Every intent the shorthand form can produce. */
export type ShorthandIntent = IntentsOf<typeof xmdShorthand>;

/** Every command name the first token may carry. */
export const COMMAND_NAMES: readonly string[] = [
  "run",
  "plan",
  "test",
  "syntax",
  "upgrade",
  "test-agent",
  "workflow",
];

/** The control flags Configliere lifts out of argv before it routes anything. */
const CONTROLS = new Set(["-h", "--help", "-v", "--version"]);

/**
 * The command this invocation names, read from the first token.
 *
 * Configliere's route search accepts any unclaimed word in the segment, and
 * `xmd` accepts a command only in first position. The controls are skipped
 * because the parser lifts them wherever they appear, so `xmd --help run` and
 * `xmd run --help` have always named the same command.
 */
export function commandToken(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg === "--") {
      return undefined;
    }
    if (CONTROLS.has(arg)) {
      continue;
    }
    return COMMAND_NAMES.includes(arg) ? arg : undefined;
  }
  return undefined;
}

/** What one invocation is parsed against. */
export function namesCommand(args: readonly string[]): boolean {
  return commandToken(args) !== undefined;
}

/**
 * Every flag in the tree that takes a separated value.
 *
 * Read from the definitions rather than listed, so a scanner that has to skip
 * `--journal -` cannot fall behind the grammar it is skipping.
 */
export function valueFlags(): Set<string> {
  const flags = new Set<string>();
  const pending: AnyRoute[] = [xmdCommands];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    for (const phase of current.phases) {
      pending.push(...phase.routes);
      for (const param of Object.values(phase.params) as Param<string, unknown>[]) {
        const syntax = param.cli.syntax;
        if (syntax?.type !== "option" || !syntax.label.endsWith(VALUE)) {
          continue;
        }
        for (const flag of syntax.label.slice(0, -VALUE.length).split(", ")) {
          flags.add(flag);
        }
      }
    }
  }
  return flags;
}

/** One source of already-decoded values, addressed by route. */
export function routeValues(
  path: readonly string[],
  values: Record<string, unknown>,
): ValueSource[] {
  if (Object.keys(values).length === 0) {
    return [];
  }
  let value: Record<string, unknown> = values;
  for (const segment of [...path].reverse()) {
    value = { [segment]: value };
  }
  return [{ name: "command line", value }];
}

/**
 * Parse one command line against the tree its first token selects.
 *
 * Synchronous and free of I/O, exactly as the API requires. The caller has
 * already lifted every token this grammar cannot express — the inline
 * document, the repeatable options and the generated document properties —
 * and supplies the lifted lists back as `values`.
 */
export function parseCommands(
  argv: readonly string[],
  values: readonly ValueSource[] = [],
): Outcome<XmdIntent> {
  return parse(xmdCommands, { argv: [...argv], values });
}

/** The same, for a command line whose first token names no command. */
export function parseShorthand(
  argv: readonly string[],
  values: readonly ValueSource[] = [],
): Outcome<ShorthandIntent> {
  return parse(xmdShorthand, { argv: [...argv], values });
}

/** Every parse outcome either driver can produce. */
export type ParseOutcome = Outcome<XmdIntent> | Outcome<ShorthandIntent>;

/** An intent, whatever tree produced it. */
export type AnyXmdIntent = XmdIntent | ShorthandIntent;

/**
 * Configliere reports a parse failure as its own structural result. It is
 * adapted here, once, to the `Error` the rest of the CLI already reports.
 */
export function parseFailure(outcome: Exclude<ParseOutcome, { ok: true }>): Error {
  if (outcome.code === "method-not-allowed") {
    return new Error(
      `xmd${outcome.path.length > 0 ? ` ${outcome.path.join(" ")}` : ""} does not support ` +
        outcome.method,
    );
  }
  return new Error(describeIssues(outcome.issues));
}

/**
 * Whether a failure reports nothing but tokens the grammar did not expect.
 *
 * The released parser stopped at the first token it did not define and
 * refused none of them, so a run written with a mistyped option refused for
 * want of a root rather than naming the option. The proposed API refuses the
 * token instead, which is a better answer to a different question — and not
 * the answer `xmd` has been giving.
 */
export function unexpectedOnly(outcome: ParseOutcome): boolean {
  return (
    !outcome.ok &&
    outcome.code === "unprocessable-content" &&
    outcome.issues.length > 0 &&
    outcome.issues.every((issue) => readUnexpected(issue.message) !== undefined)
  );
}

/** Every issue one failure carries, in the order the parser found them. */
export function describeIssues(issues: readonly Issue[]): string {
  return issues.map(describeIssue).join("\n");
}

function describeIssue(issue: Issue): string {
  const at = issue.path
    ?.map((segment) => (typeof segment === "object" && segment !== null ? segment.key : segment))
    .join(".");
  const unexpected = readUnexpected(issue.message);
  if (unexpected !== undefined) {
    return `unrecognized argument: ${unexpected}`;
  }
  return at ? `${at}: ${issue.message}` : issue.message;
}

/** The token an `unexpected "…"` diagnostic names, when it names one. */
function readUnexpected(message: string): string | undefined {
  if (!message.startsWith('unexpected "')) {
    return undefined;
  }
  const encoded = message.slice("unexpected ".length);
  try {
    const token: unknown = JSON.parse(encoded);
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The definition one route path addresses, when the tree holds one. */
export function routeFor(path: readonly string[]): AnyRoute | undefined {
  let current: AnyRoute = xmdCommands;
  for (const segment of path) {
    const child: AnyRoute | undefined = current.phases
      .flatMap((phase) => phase.routes)
      .find((candidate) => candidate.name === segment);
    if (child === undefined) {
      return undefined;
    }
    current = child;
  }
  return current;
}

/**
 * `xmd --help`: the commands, and nothing the shorthand run form configures.
 *
 * The root is executable, so every option a run takes is declared on it. The
 * program page has never listed them — a caller reading it is choosing a
 * command — so this renders the commands alone, exactly as before.
 */
export function renderProgramHelp(): string {
  const children = xmdCommands.phases.flatMap((phase) => phase.routes);
  return [
    "Usage: xmd <COMMAND> [OPTIONS]",
    "",
    ["Commands:", ...children.map((child) => row(child.name, child.description))].join("\n"),
    "",
    ["Options:", row(HELP_LABEL, "show help"), row("-v, --version", "show version")].join("\n"),
  ].join("\n");
}

/**
 * Help for one route, in the shape the released CLI printed.
 *
 * The proposed API's own `printHelp` renders a different one — a wrapped
 * description block, `Usage:` on its own line, `<PATH>` for an optional
 * argument — so presentation stays here. Every fact it needs comes from the
 * definition: whether a parameter is optional is answered by validating
 * `undefined` against its schema, and the default is whatever that validation
 * returns.
 */
export function renderRouteHelp(definition: AnyRoute, path: readonly string[]): string {
  const label = ["xmd", ...path].join(" ");
  const children = definition.phases.flatMap((phase) => phase.routes);
  const params = paramsOf(definition);
  // An address that executes nothing declares nothing either, and its page has
  // always listed the grammar its actions accept. The union is presentation:
  // parsing binds each parameter on the action that owns it, and no model is
  // merged with another.
  if (!definition.methods.includes("execute")) {
    const seen = new Set(params.map((param) => param.name));
    for (const child of children) {
      for (const param of paramsOf(child)) {
        if (seen.has(param.name)) {
          continue;
        }
        seen.add(param.name);
        params.push(param);
      }
    }
  }
  const args = params.filter((param) => param.cli.syntax?.type === "argument");
  const opts = params.filter((param) => param.cli.syntax?.type === "option");

  const usage = [`Usage: ${label}`];
  if (children.length > 0) {
    usage.push("<COMMAND>");
  }
  // Every page offers help, so every page has an option section.
  usage.push("[OPTIONS]");
  for (const arg of args) {
    usage.push(argumentLabel(arg));
  }

  const sections = [usage.join(" ")];

  if (children.length > 0) {
    sections.push(
      ["Commands:", ...children.map((child) => row(child.name, child.description))].join("\n"),
    );
  }

  if (args.length > 0) {
    sections.push(
      ["Arguments:", ...args.map((arg) => row(argumentLabel(arg), describeParam(arg)))].join("\n"),
    );
  }

  sections.push(
    [
      "Options:",
      ...opts.map((opt) => row(optionLabel(opt), describeParam(opt))),
      row(HELP_LABEL, "show help"),
    ].join("\n"),
  );

  return sections.join("\n\n");
}

/** The control every route answers, listed last as it always has been. */
const HELP_LABEL = "-h, --help";

/** Every parameter one route declares, in declaration order. */
function paramsOf(definition: AnyRoute): Param<string, unknown>[] {
  return definition.phases.flatMap(
    (phase) => Object.values(phase.params) as Param<string, unknown>[],
  );
}

function row(label: string, right?: string): string {
  return `   ${label.padEnd(25)} ${right ?? ""}`;
}

function describeParam(param: Param<string, unknown>): string {
  const fallback = defaultOf(param);
  const stated = fallback === undefined ? "" : `[default: ${fallback}]`;
  return [param.description ?? "", stated].filter(Boolean).join(" ");
}

/** What the parameter resolves to when nothing supplies it, if anything. */
function defaultOf(param: Param<string, unknown>): string | undefined {
  const validated = param.schema["~standard"].validate(undefined);
  if (validated instanceof Promise || validated.issues || validated.value === undefined) {
    return undefined;
  }
  return `${validated.value}`;
}

function accepts(param: Param<string, unknown>, value: unknown): boolean {
  const validated = param.schema["~standard"].validate(value);
  return !(validated instanceof Promise) && !validated.issues;
}

function argumentLabel(param: Param<string, unknown>): string {
  if (Array.isArray(defaultValue(param))) {
    return `<${param.name}>...`;
  }
  if (describedAsRequired(param)) {
    return `<${param.name}>`;
  }
  return accepts(param, undefined) ? `[${param.name}]` : `<${param.name}>`;
}

function defaultValue(param: Param<string, unknown>): unknown {
  const validated = param.schema["~standard"].validate(undefined);
  if (validated instanceof Promise || validated.issues) {
    return undefined;
  }
  return validated.value;
}

/**
 * The flags a parameter answers to, followed by the value form.
 *
 * `cli()` and `toggle()` write the flags into `syntax.label` and append
 * ` <VALUE>` when the option takes one, which is the one part of the stock
 * label this rendering replaces.
 */
function optionLabel(param: Param<string, unknown>): string {
  const label = param.cli.syntax?.label ?? `--${param.name}`;
  const takesValue = label.endsWith(VALUE);
  const flags = takesValue ? label.slice(0, -VALUE.length) : label;
  return takesValue ? `${flags} ${argumentLabel(param).toUpperCase()}` : flags;
}

const VALUE = " <VALUE>";

/** The bare version, which is what `xmd --version` has always written. */
export function renderVersion(intent: Version<RoutePath>): string {
  return intent.definition.version ?? XMD_VERSION;
}

/** Whether one intent asks for help. */
export function isHelp(intent: AnyXmdIntent): intent is Extract<AnyXmdIntent, Help<RoutePath>> {
  return intent.method === "help";
}

/** Whether one intent asks for the version. */
export function isVersion(
  intent: AnyXmdIntent,
): intent is Extract<AnyXmdIntent, Version<RoutePath>> {
  return intent.method === "version";
}

/** Whether one intent executes a command. */
export function isExecute(
  intent: AnyXmdIntent,
): intent is Extract<AnyXmdIntent, Execute<RoutePath, ModelsByRoute>> {
  return intent.method === "execute";
}

/** The route one intent selected, as the path the caller wrote. */
export function intentPath(intent: Intent<"help" | "version" | "execute", RoutePath>): string[] {
  return [...intent.path];
}
