/**
 * CLI — run an executable markdown document.
 *
 * Usage:
 *   xmd run <document-reference> [options]
 *   xmd run - [options]                  (the document is read from stdin)
 *   xmd <document-reference> [options]   (run is the default command)
 *   xmd plan "<request>" [options]
 *   xmd upgrade [<tag>] [--status] [--allow-downgrade] [--allow-prerelease] [--journal <path>]
 *   xmd workflow start <document.md> [options]
 *   xmd workflow resume <run-id>
 *   xmd workflow status|history <run-id> [--json]
 *   xmd workflow status|history --artifact=<path.xmd> [--json]
 *   xmd workflow list [--status=<status>] [--json]
 *
 * A document reference is a path, optionally followed by `#` and one target
 * selector naming a section of the document (spec §5.4). `workflow start` takes
 * a plain path: a definition descriptor cannot record a target yet.
 *
 * Examples:
 *   xmd run packages/core/examples/hello-world.md
 *   xmd plan "prepare the release program."
 *   xmd plan "prepare the release program." | xmd run -
 *   xmd packages/core/examples/hello-world.md --verbose
 *   xmd run packages/core/examples/hello-world.md --journal events.jsonl
 *   xmd run README.md#Release/Publish
 *   xmd workflow start --id=release-1.4 flows/prepare-release.md
 *   xmd workflow resume release-1.4
 */

import {
  Err,
  Ok,
  exit,
  spawn,
  each,
  createSignal,
  scoped,
  until,
  useScope,
  type Operation,
  type Result,
} from "effection";
import {
  InMemoryStream,
  type DurableEvent,
  type DurableStream,
  type Json,
} from "@executablemd/durable-streams";

import { forEach } from "@effectionx/stream-helpers";
import { Stdio } from "@effectionx/process";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { inspect } from "node:util";
import process from "node:process";
import { program, object, field, cli, commands } from "configliere";
import { z } from "zod";
import {
  AgentProviders,
  Config,
  asDocumentTargetError,
  execute,
  fileSource,
  formatDocumentReference,
  inlineSource,
  inspectDocument,
  agentIdentityComponents,
  installAgentComponents,
  retainedSource,
  rootSourcePath,
  useNormalizedOutput,
  useTerminalOutput,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { DeclaredMarkdownComponent, ExecutionInstallation } from "@executablemd/core/host";
import type {
  DocumentTargetInfo,
  FileRootDocument,
  PropsSchema,
  RootDocumentSource,
} from "@executablemd/core";
import { command as hostCommand } from "@executablemd/runtime";
import type { MachineSessionAssembly } from "./session-coordinator.ts";
import {
  installTestingComponents,
  testHarnessInstallation,
  useTesting,
} from "@executablemd/testing";
import {
  installTestAgentComponents,
  runTestAgentWorker,
  testAgentChildDeclaration,
} from "@executablemd/test-agent";
import { installWebComponents, installWebElicitation } from "@executablemd/web";
import { timebox } from "@effectionx/timebox";
import { timeout as runTimeout } from "@executablemd/runtime";
import { installRunAgentStack, resolveAgentStack, resolveAuthorshipStack } from "./agent-stack.ts";
import { planComponentDeclaration } from "./plan-component.ts";
import { planAgentContext } from "./authorship-profile.ts";
import { useVerboseComponent } from "./verbose-component.ts";
import type { AgentStack } from "./agent-stack.ts";
import { reportFailure } from "./report.ts";
import { TIMEOUT_FLAGS, resolvePlanTimeout, resolveRunTimeouts } from "./timeouts.ts";
import type { RunTimeouts } from "./timeouts.ts";
import type { AgentFlags } from "./agent-config.ts";
import { FileStream } from "./file-stream.ts";
import {
  AGGREGATE_OPTION,
  buildBindings,
  declaredProperties,
  describeError,
  extractPropsArgs,
  formatProperties,
  resolvePropsFromSources,
} from "./props.ts";
import type { Binding, Extraction } from "./props.ts";
import {
  namesPlan,
  namesRetiredCommand,
  removedPlanOption,
  RETIRED_COMMAND_REFUSAL,
  scanPlanArgs,
} from "./plan-args.ts";
import type { PlanScan } from "./plan-args.ts";
import { runPlan } from "./plan.ts";
import { runUpgrade } from "./upgrade.ts";
import type { UpgradeAssembly } from "./upgrade.ts";
import { componentSearchPath, resolveTestTarget } from "./test-target.ts";
import {
  renderSyntaxDocumentation,
  renderSyntaxJson,
  renderSyntaxMarkdown,
  syntaxSymbols,
} from "./syntax.ts";
import { deliverWhole } from "./stdout-delivery.ts";
import { testingExecutionHost } from "./testing-host.ts";
import type { ChildPlanDeclaration } from "./testing-host.ts";
import { unsupportedRepositories } from "./run-repositories.ts";
import type { RepositoryInstaller } from "./run-repositories.ts";
import { EVAL_ALIAS, EVAL_OPTION, evalGrammarError, readEvalFlags } from "./eval-source.ts";
import type { EvalFlags } from "./eval-source.ts";
import { STANDARD_INPUT_FAILURE, STANDARD_INPUT_PATH } from "./standard-input.ts";
import type { StandardInputReader } from "./standard-input.ts";
import {
  parseWorkflowRequest,
  runWorkflow,
  UNSUPPORTED_WORKFLOW_HOST,
  unsupportedWorkflowHost,
  workflowConfig,
} from "./workflow.ts";
import type { HostWorkflowInstaller, WorkflowHost, WorkflowStart } from "./workflow.ts";
import { runWorkflowManagement } from "./workflow-management.ts";
import { establishDefinition } from "./workflow-definition.ts";
import type { EstablishedDefinition } from "./workflow-definition.ts";
import { useCompositionComponents, useWorkflowServiceDenial } from "@executablemd/workflow";
import denoJson from "../deno.json" with { type: "json" };

const SECRET_DETECTION_OPTION = "--secret-detection";
const NEGATED_SECRET_DETECTION = "--no-secret-detection";

/** Written once per invocation when the host turned detection off. */
const SECRET_DETECTION_WARNING =
  "WARNING: secret detection is disabled; credentials may be persisted.";

/**
 * `--no-secret-detection` — the host's opt-out, on both commands.
 *
 * Declared as an ordinary boolean switch because that is what configliere
 * negates: a `secretDetection` field makes `--no-secret-detection` resolve to
 * `false` with no argv reading of our own. It takes no aliases — adding
 * `--no-secret-detection` as one makes the parser read it as the positive
 * switch, and the opt-out silently stops working.
 *
 * Help lists the positive spelling only, so the description carries the one a
 * caller actually writes.
 */
const SECRET_DETECTION_FIELD = {
  description:
    "scan durable events for credentials before they persist; " +
    `disable with ${NEGATED_SECRET_DETECTION}`,
  ...field(z.boolean(), field.default(true)),
};

/**
 * Everything a document execution configures.
 *
 * `xmd run` alone. `xmd plan` writes a program rather than running one, so it
 * declares the few of these that describe *authorship* — the includes the
 * catalog is built from, who writes, and one deadline — and none of the rest:
 * a journal, a permission mode, an exec deadline or a presentation option would
 * each configure work this command never performs.
 */
const executionFields = {
  include: {
    description: "component search directory",
    ...field(z.array(z.string()), field.default(["components", "."]), field.array()),
  },
  verbose: {
    description: "log journal entries to stderr",
    aliases: ["-V"],
    ...field(z.boolean(), field.default(false)),
  },
  journal: {
    description: "write a diagnostic JSONL trace (path must not exist)",
    aliases: ["-j"],
    ...field(z.string().optional()),
  },
  raw: {
    description: "output raw markdown without normalization or terminal formatting",
    ...field(z.boolean(), field.default(false)),
  },
  agentProvider: {
    description: "agent provider for agent components",
    ...field(z.string(), field.default("acpx")),
  },
  defaultAgent: {
    description: "default agent name (overrides DEFAULT_AGENT_NAME)",
    ...field(z.string().optional()),
  },
  timeout: {
    description: "deadline for the whole run, as a duration (500ms, 30s, 5min)",
    ...field(z.string().optional()),
  },
  timeoutExec: {
    description: "default timeout for each exec block, as a duration (500ms, 30s, 5min)",
    ...field(z.string().optional()),
  },
  timeoutFetch: {
    description: "default timeout for each fetch, as a duration (500ms, 30s, 5min)",
    ...field(z.string().optional()),
  },
  approveAll: {
    description: "approve every agent permission request",
    ...field(z.boolean(), field.default(false)),
  },
  approveReads: {
    description: "approve read and search agent permissions, ask for the rest (default)",
    ...field(z.boolean(), field.default(false)),
  },
  denyAll: {
    description: "deny every agent permission request",
    ...field(z.boolean(), field.default(false)),
  },
  secretDetection: SECRET_DETECTION_FIELD,
};

const runConfig = object({
  path: {
    description:
      "markdown document to execute, optionally `#` and one target selector; " +
      "`xmd run -` reads the document from standard input instead",
    ...field(z.string().optional(), cli.argument()),
  },
  // Declared so `xmd run --help` lists it with every other option. The value is
  // lifted out of argv by readEvalFlags before parsing — see eval-source.ts —
  // so this field is never the source of the document.
  eval: {
    description: "inline markdown document to execute, in place of a path",
    aliases: ["-e"],
    ...field(z.string().optional()),
  },
  ...executionFields,
});

/** What `xmd --help` says the plan command is for. */
const PLAN_DESCRIPTION =
  "Turn a request into an XMD Plan, review it, and write the approved source.";

/**
 * `xmd plan` — the request, where the approved source goes, and who writes it.
 *
 * Every option that configured *running* a Plan is absent, because this command
 * runs nothing: the program it writes is run by a later `xmd run`, and that is
 * where a permission mode, an exec deadline and a root property are configured.
 * The generated `--props-*` options are absent for the same reason, and for one
 * more — they exist only once a document does, and this command's result is the
 * document.
 *
 * `--verbose` and `--journal` describe writing the Plan rather than running it.
 * They observe this invocation's own authorship and nothing after it, which is
 * why they are spelled in full: `-V` and `-j` are `xmd run`'s aliases for
 * options about a program's run.
 */
const planConfig = object({
  request: {
    description: "the request the coding agent should turn into an XMD Plan",
    ...field(z.string().optional(), cli.argument()),
  },
  output: {
    description: "write the approved source here instead of to stdout (path must not exist)",
    ...field(z.string().optional()),
  },
  session: {
    description: "logical name for the assistant session (default: unique to this invocation)",
    ...field(z.string().optional()),
  },
  verbose: {
    description: "show generated drafts and XMD check diagnostics on stderr",
    ...field(z.boolean(), field.default(false)),
  },
  journal: {
    description: "record the planning process as diagnostic JSONL (path must not exist)",
    ...field(z.string().optional()),
  },
  include: {
    description: "component search directory",
    ...field(z.array(z.string()), field.default(["components", "."]), field.array()),
  },
  agentProvider: {
    description: "agent provider for Plan authorship",
    ...field(z.string(), field.default("acpx")),
  },
  defaultAgent: {
    description: "default agent name (overrides DEFAULT_AGENT_NAME)",
    ...field(z.string().optional()),
  },
  timeout: {
    description: "deadline for the whole planning invocation, as a duration (500ms, 30s, 5min)",
    ...field(z.string().optional()),
  },
});

const testConfig = object({
  path: {
    description: "markdown document or directory to test (defaults to the current directory)",
    ...field(z.string().default("."), cli.argument(), field.default(".")),
  },
  pattern: {
    description: "glob for test documents, relative to a directory target (repeatable)",
    ...field(z.array(z.string()), field.default(["**/*.test.md"]), field.array()),
  },
  include: {
    description: "component search directory",
    ...field(z.array(z.string()), field.default(["components", "."]), field.array()),
  },
  verbose: {
    description: "log journal entries to stderr",
    aliases: ["-V"],
    ...field(z.boolean(), field.default(false)),
  },
  journal: {
    description: "write a diagnostic JSONL trace (path must not exist)",
    aliases: ["-j"],
    ...field(z.string().optional()),
  },
  raw: {
    description: "output raw markdown without normalization or terminal formatting",
    ...field(z.boolean(), field.default(false)),
  },
  secretDetection: SECRET_DETECTION_FIELD,
});

/**
 * `xmd syntax` — inspection only, so its grammar is only what selection needs.
 *
 * No document, props, agent, timeout, journal, raw, testing, workflow or
 * secret-detection option: the command runs nothing, so there is nothing for
 * any of them to configure. `--include` is the same ordered, repeatable field
 * `run` and `test` declare, and explicit values replace the defaults.
 */
const syntaxConfig = object({
  component: {
    description:
      "component to describe in full — `xmd syntax Elicit` renders its catalog metadata " +
      "and long-form documentation instead of the compact catalog",
    ...field(z.string().optional(), cli.argument()),
  },
  include: {
    description: "component search directory",
    ...field(z.array(z.string()), field.default(["components", "."]), field.array()),
  },
  json: {
    description: "write the symbols as version-2 JSON instead of markdown",
    ...field(z.boolean(), field.default(false)),
  },
});

const testAgentConfig = object({
  connect: {
    description: "opaque controller route (controller-launched workers only)",
    ...field(z.string()),
  },
});

/** What `xmd --help` says the upgrade command is for. */
const UPGRADE_DESCRIPTION =
  "Upgrade the standalone xmd binary to the latest stable or a specified release.";

/**
 * `xmd upgrade` — one optional tag and three switches, and nothing else.
 *
 * Every option a run configures is deliberately absent. This command executes
 * no caller's document, writes no journal, starts no agent and installs no
 * permission mode, so an option describing any of those would be answered by a
 * command that does none of it. The values are read from argv by
 * {@link scanUpgradeArgs} rather than from this parse; what is declared here is
 * what `xmd upgrade --help` lists.
 */
const upgradeConfig = object({
  tag: {
    description: "exact release tag to install, such as v1.2.3 (default: the latest stable)",
    ...field(z.string().optional(), cli.argument()),
  },
  status: {
    description: "report how the selected release compares, and change nothing",
    ...field(z.boolean(), field.default(false)),
  },
  allowDowngrade: {
    description: "consent to installing a release older than the installed one",
    ...field(z.boolean(), field.default(false)),
  },
  allowPrerelease: {
    description: "consent to installing the exact prerelease tag named",
    ...field(z.boolean(), field.default(false)),
  },
  journal: {
    description: "write a diagnostic JSONL trace (path must not exist)",
    aliases: ["-j"],
    ...field(z.string().optional()),
  },
});

/** The version this build reports, from the manifest it was built with. */
export const XMD_VERSION: string = denoJson.version;

const xmd = program({
  name: "xmd",
  version: XMD_VERSION,
  config: commands(
    {
      run: runConfig,
      plan: { ...planConfig, description: PLAN_DESCRIPTION },
      test: testConfig,
      syntax: syntaxConfig,
      upgrade: { ...upgradeConfig, description: UPGRADE_DESCRIPTION },
      "test-agent": testAgentConfig,
      workflow: workflowConfig,
    },
    { default: "run" },
  ),
});

/** The switches `xmd upgrade` defines, and the whole of what it accepts. */
const UPGRADE_SWITCHES: readonly string[] = ["--status", "--allow-downgrade", "--allow-prerelease"];

/** The one option that takes a value, and its alias. */
const UPGRADE_JOURNAL = "--journal";
const UPGRADE_JOURNAL_ALIAS = "-j";

/** Everything the command accepts, as help and refusals name it. */
const UPGRADE_OPTIONS: readonly string[] = [...UPGRADE_SWITCHES, UPGRADE_JOURNAL];

/** What fixed grammar establishes about one `xmd upgrade` command line. */
interface UpgradeScan {
  /** The exact tag the caller named, or `null` for the latest stable release. */
  tag: string | null;
  status: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  /** Where a diagnostic trace goes, when the caller asked for one. */
  journal?: string;
  /** Why fixed grammar refuses this command line. */
  error?: string;
}

/**
 * Read `xmd upgrade`'s command line, and refuse what the parser would swallow.
 *
 * Three things the parser cannot report are decided here. It stops at the first
 * option it does not define and drops the rest, so an option nobody defines
 * would otherwise be accepted in silence by a command that ignored it. It
 * resolves `--status=false` to the field's default, so an `=` form on a switch
 * would read as the opposite of what was written. And it takes a second
 * positional without comment, where this command installs exactly one release.
 *
 * A pure function over argv: it reads nothing, so a malformed command line is
 * refused before the host is asked for release metadata, a lock or a file.
 */
function scanUpgradeArgs(args: readonly string[]): UpgradeScan {
  const scan: UpgradeScan = {
    tag: null,
    status: false,
    allowDowngrade: false,
    allowPrerelease: false,
  };
  let parsingOptions = true;
  const rest = args.slice(1);

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && token.startsWith("-") && token !== "-") {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token : token.slice(0, equals);

      if (name === UPGRADE_JOURNAL || name === UPGRADE_JOURNAL_ALIAS) {
        const value = equals === -1 ? rest[index + 1] : token.slice(equals + 1);
        // Read here rather than after parsing, because an option the parser
        // reads as absent falls back to the default: a caller who asked for a
        // trace and named none would otherwise get a run that writes nothing.
        if (
          value === undefined ||
          value.length === 0 ||
          (equals === -1 && isUpgradeOption(value))
        ) {
          return {
            ...scan,
            error:
              `${name} needs a path — write \`${UPGRADE_JOURNAL} <path>\`, and the path must ` +
              "not already exist",
          };
        }
        scan.journal = value;
        index += equals === -1 ? 1 : 0;
        continue;
      }

      if (!UPGRADE_SWITCHES.includes(name)) {
        return {
          ...scan,
          error:
            `xmd upgrade does not recognize ${name}. It accepts one optional release tag ` +
            `and these options: ${UPGRADE_OPTIONS.join(", ")}.`,
        };
      }
      if (equals !== -1) {
        return {
          ...scan,
          error: `${name} does not take a value. Use ${name} by itself or omit it.`,
        };
      }
      if (name === "--status") {
        scan.status = true;
      }
      if (name === "--allow-downgrade") {
        scan.allowDowngrade = true;
      }
      if (name === "--allow-prerelease") {
        scan.allowPrerelease = true;
      }
      continue;
    }
    if (scan.tag !== null) {
      return {
        ...scan,
        error: `xmd upgrade accepts at most one release tag. ${token} is an extra argument.`,
      };
    }
    scan.tag = token;
  }

  return scan;
}

/** Whether this token is an option this command defines rather than a value. */
function isUpgradeOption(token: string): boolean {
  if (!token.startsWith("-") || token === "-") {
    return false;
  }
  const equals = token.indexOf("=");
  const name = equals === -1 ? token : token.slice(0, equals);
  return UPGRADE_OPTIONS.includes(name) || name === UPGRADE_JOURNAL_ALIAS;
}

const pretty = (value: unknown): string =>
  inspect(value, {
    colors: true,
    compact: true,
    breakLength: Infinity,
    depth: 2,
    maxStringLength: 200,
  });

function formatYieldResult(event: DurableEvent & { type: "yield" }): string {
  const { result, description } = event;
  if (result.status !== "ok" || result.value === undefined) {
    return "";
  }

  const v = result.value as Record<string, unknown>;
  switch (description.type) {
    case "import_component":
      return " " + pretty({ path: v.path });
    case "eval":
      return " " + pretty(v.value ?? {});
    case "exec":
      return " " + pretty({ exitCode: v.exitCode, stdout: v.stdout, stderr: v.stderr });
    default:
      return " " + pretty(v);
  }
}

function summarizeEvent(event: DurableEvent): string {
  if (event.type === "yield") {
    const desc = event.description;
    const status = event.result.status;
    const detail =
      status === "err" && "error" in event.result
        ? ` (${event.result.error.message})`
        : formatYieldResult(event);
    return `[yield] ${desc.type}:${desc.name} → ${status}${detail}`;
  }
  const status = event.result.status;
  const detail =
    status === "err" && "error" in event.result ? ` (${event.result.error.message})` : "";
  return `[close] ${event.coroutineId} → ${status}${detail}`;
}

function* createJournalFile(filePath: string): Operation<void> {
  let handle: FileHandle;
  try {
    handle = yield* until(open(filePath, "wx"));
  } catch (error) {
    const isExistingFile =
      error instanceof Error &&
      (("code" in error && error.code === "EEXIST") || error.message.startsWith("EEXIST:"));
    if (isExistingFile) {
      throw new Error(
        `Journal trace already exists: ${filePath}. Remove it or choose another path.`,
        { cause: error },
      );
    }
    throw error;
  }

  yield* until(handle.close());
}

/**
 * Refuse `--secret-detection=<value>` and `--no-secret-detection=<value>`.
 *
 * Both spellings are switches, and configliere resolves an `=` form on either
 * of them to the default — so `--secret-detection=false` reads as *enabled*,
 * and `--no-secret-detection=true` does too. Silence is the wrong answer for a
 * safety option: a caller who wrote one of these is telling us what they want
 * detection to do, and would otherwise be told nothing while it did the
 * opposite. There is one spelling that turns detection off, and this names it.
 *
 * Tokens after `--` belong to the document, not to xmd.
 */
function secretDetectionGrammarError(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg === "--") {
      return undefined;
    }
    if (
      arg.startsWith(`${SECRET_DETECTION_OPTION}=`) ||
      arg.startsWith(`${NEGATED_SECRET_DETECTION}=`)
    ) {
      return (
        `${arg.split("=")[0]} does not take a value — secret detection is on by default, ` +
        `and \`${NEGATED_SECRET_DETECTION}\` is what turns it off`
      );
    }
  }
  return undefined;
}

/**
 * Say once that this invocation will not be scanning.
 *
 * Written at the command boundary rather than per document, so testing a
 * directory warns once for the run rather than once for every document in it.
 */
function announceSecretDetection(secretDetection: boolean): void {
  if (!secretDetection) {
    console.error(SECRET_DETECTION_WARNING);
  }
}

const AGENT_ONLY_FLAGS = [
  "--agent-provider",
  "--default-agent",
  "--approve-all",
  "--approve-reads",
  "--deny-all",
];

/**
 * Agent options belong to `xmd run`. The argument parser ignores options
 * it does not define rather than rejecting them, so `xmd test` has to
 * reject these itself instead of silently running without them.
 */
function findAgentOnlyFlag(args: string[]): string | undefined {
  return args.find((arg) =>
    AGENT_ONLY_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

/** The timeout options, like the agent options, belong to a command that runs. */
function findTimeoutFlag(args: string[]): string | undefined {
  return args.find((arg) =>
    TIMEOUT_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

/**
 * The agent and timeout options `xmd plan` still defines.
 *
 * Planning settles who writes and bounds the whole invocation; it configures no
 * execution, so a permission mode, an exec deadline and a fetch deadline reach
 * `xmd run` alone. A command refusing one of these says which commands do take
 * it, so the answer has to tell the two groups apart.
 */
const PLANNING_FLAGS = new Set(["--agent-provider", "--default-agent", "--timeout"]);

/** Which commands the option a caller wrote actually belongs to. */
function belongsTo(flag: string): string {
  const [name] = flag.split("=");
  return PLANNING_FLAGS.has(name) ? "xmd run and xmd plan" : "xmd run";
}

/**
 * Install what the command line asked for, and nothing else: a field nobody
 * wrote stays as the enclosing scope has it, which for a run is no timeout.
 * `min` is what lets a block's own `timeout=` outrank the run's exec default.
 */
function* installRunTimeouts(timeouts: RunTimeouts): Operation<void> {
  yield* Config.around(
    {
      ...(timeouts.timeout === undefined ? {} : { timeout: () => timeouts.timeout }),
      ...(timeouts.timeoutExec === undefined ? {} : { timeoutExec: () => timeouts.timeoutExec }),
      ...(timeouts.timeoutFetch === undefined ? {} : { timeoutFetch: () => timeouts.timeoutFetch }),
    },
    { at: "min" },
  );
}

/**
 * The whole run, under whatever deadline applies to it.
 *
 * The command line's values are installed first, and the deadline is then read
 * back through the validated contextual operation — once, and from the same
 * place every other consumer reads its own field. That is what makes an
 * enclosing `Config.timeout` bound a run that named none, and an invalid one
 * fail here rather than part-way through a document.
 *
 * Expiry is cancellation, not a result: `timebox` halts the run and Effection
 * unwinds it, so structured teardown completes before the timeout is reported.
 * The deadline encloses preparation and execution together, so a longer exec or
 * Fetch timeout inside it cannot outlive it.
 */
function* underRunDeadline(timeouts: RunTimeouts, body: () => Operation<void>): Operation<void> {
  yield* installRunTimeouts(timeouts);

  let deadline: number | undefined;
  try {
    deadline = yield* runTimeout;
  } catch (error) {
    console.error(describeError(error));
    yield* exit(1);
    return;
  }

  if (deadline === undefined) {
    yield* body();
    return;
  }

  const boxed = yield* timebox(deadline, body);
  if (boxed.timeout) {
    console.error(`the run exceeded its --timeout of ${deadline}ms and was cancelled`);
    yield* exit(1);
  }
}

/**
 * Settle the Agent configuration for one invocation, or report why it cannot
 * be settled.
 *
 * Called once per command, before anything a document or an agent could
 * observe: incompatible permission flags and an unknown `--agent-provider` are
 * command-line failures, and a command line is wrong before any of it runs.
 * `undefined` means the caller has already reported and should stop.
 */
function* settleAgentStack(
  flags: AgentFlags,
  sessions: MachineSessionAssembly | undefined,
): Operation<AgentStack | undefined> {
  const stack = yield* resolveAgentStack(flags, sessions);
  if (!stack.ok) {
    console.error(stack.error.message);
    yield* exit(1);
    return undefined;
  }
  return stack.value;
}

/**
 * How this host re-invokes itself as the test-agent worker, when it can.
 *
 * A refusal comes back rather than ending the run, because a document that
 * declares no scripted agent for a nested child has no worker to run and must
 * not need one — the allowance `<TestAgent>` already makes when it asks for the
 * relaunch at its own invocation instead of at install time. The reason is kept
 * so a declaration written under such a host says why it has nothing to run.
 */
function* readWorkerCommand(): Operation<Result<readonly string[]>> {
  try {
    return Ok(yield* hostCommand(["test-agent"]));
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Whether a document run started from the command line keeps its commands'
 * output.
 *
 * `--journal` is a request for a diagnostic record, and on this path it is the
 * only thing that asks for one. It is read here, at the command that owns the
 * flag, so no shared runner has to guess what an absent pathname meant.
 */
function keepsProcessOutput(journal: string | undefined): boolean {
  return journal !== undefined;
}

interface DocumentConfig {
  root: RootDocumentSource;
  include: string[];
  verbose: boolean;
  journal: string | undefined;
  raw: boolean;
  /** Whether this document's durable events are scanned before they persist. */
  secretDetection: boolean;
  /**
   * The journal this execution reads and appends, when the caller owns one.
   *
   * A workflow run does: its journal is the run's retained history, and
   * replacing it with a fresh stream would make every execution a first one.
   * `xmd run` supplies none and gets the empty stream below.
   */
  stream?: DurableStream;
  /**
   * Whether this execution keeps what its commands printed.
   *
   * Stated by the host path that starts the run, never inferred here. A
   * pathname is not a retention policy: a workflow owns its journal without
   * naming one, and reading `journal === undefined` as "keep nothing" would
   * quietly empty the process results a resumed workflow reads back.
   */
  retainProcessOutput: boolean;
  /**
   * Whether what this execution renders is kept from the reader.
   *
   * A fork's compatibility replay re-renders history that already happened in
   * another run, and the fork's own execution renders it again a moment later.
   * The default is that a reader sees what a document produced.
   */
  discardOutput?: boolean;
}

export interface DocumentMode {
  testing: boolean;
  /**
   * The Agent configuration this invocation already settled.
   *
   * Resolved, not the flags that produced it: an invocation reads
   * `DEFAULT_AGENT_NAME` and decides its permission mode once, and a command
   * that generates a document before running one has two consumers for that one
   * answer. Passing the flags instead would let the second consumer reach a
   * different conclusion than the first from the same command line.
   */
  agent?: AgentStack;
  /**
   * What this host states about machine-wide agent sessions: who owns one,
   * how it was constructed, which build it belongs to, and which adapters this
   * host has proven for native launch and for ACP attachment.
   *
   * Carried on the mode because the mode is what a trusted host states about
   * one run — and delivered from here straight into the provider's
   * dependencies. It is deliberately not contextual: ownership and executable
   * validation are security decisions, and ones a document could replace are
   * not ones.
   */
  machineSessions?: MachineSessionAssembly;
  props?: Record<string, Json>;
  /**
   * Where this host keeps the authorship session directories `<Plan>` uses.
   *
   * A host dependency, not a caller's: no flag, environment variable, document
   * prop or replaceable context reaches it. Production leaves it at the default;
   * a harness that owns a temporary tree names that tree, so a test never reads,
   * creates or removes anything under a real one.
   */
  planAuthorshipRoot?: string;
  /**
   * What a trusted host attaches to this one execution.
   *
   * Values passed straight to `executeInstalled()`, so canonical core captures
   * their admissions and preparations before any installation, middleware or
   * document code exists. `xmd run` and `xmd test` attach none, and an empty
   * list is exactly what `execute()` itself does.
   */
  installations?: readonly ExecutionInstallation[];
}

export type HostServiceInstaller = () => Operation<void>;

/**
 * Everything a document execution runs with, after the command line has been
 * read.
 *
 * Extracted from `runDocument` rather than restated: what a nested execution
 * (`<Execution host="run">`) needs is *this*, and a second copy of it would be
 * a test passing against components production does not install. Process
 * presentation — the journal file, the verbose echo, terminal formatting, the
 * value root's stdout — stays with the command that owns those streams.
 */
export function* installDocumentComponents(mode: DocumentMode, verbose: boolean): Operation<void> {
  // What `<Verbose>` reads, seeded from the flag this invocation already
  // resolved. `min` is what lets a component installed further in override
  // verbosity for its own content, the way a block's own `timeout=` outranks
  // the run's exec default. Both modes seed it, because a run child assembled
  // by a testing host is still a run; what the two modes differ on is whether
  // `<Verbose>` is registered at all.
  yield* Config.around({ verbose: () => verbose }, { at: "min" });

  // The repository-composition vocabulary, as ordinary shadowable defaults,
  // with the documentation that describes it. Bootstrapping it installs no
  // provider, discovers no repository, acquires no lock and reaches no network:
  // what a name *does* is decided by whichever provider the command installed,
  // and a runtime that installs none still resolves every one of these.
  yield* useCompositionComponents();

  // Compose testing around the single core execution entrypoint: both
  // commands register the components (assertions work in regular documents,
  // explicit <Testing> boundaries affect the outcome), while `xmd test`
  // additionally activates root testing through a useTesting() session.
  if (mode.testing) {
    yield* useTesting({ verbose });
    // TestAgent installs before the agent components so its <Prompt>
    // interceptor runs first.
    yield* installTestAgentComponents();
    yield* installAgentComponents();
  } else {
    yield* useVerboseComponent();
    yield* installTestingComponents({ verbose });
  }

  // `<WebForm>` for both commands. Registered rather than reserved, so a
  // repository's own WebForm.md or WebForm.ts still wins.
  yield* installWebComponents();

  // No elicitation provider is assembled here, for any command. Who answers
  // `<Elicit>` is not a property of the components a document runs with: it is
  // whichever host attached this run, and a host says so by installing its own
  // provider in the scope it composes around this one. `xmd run` and the nested
  // run profile install the browser form there; `xmd test` and `xmd workflow`
  // install nothing there, and the workflow attachment's suspending provider is
  // the only one a workflow document can reach.
  //
  // Deciding it here instead would put the answer in the one assembly every
  // profile shares, where a provider is only ever a scope away from the wrong
  // run — and where the workflow's provider, installed further out, would lose
  // to it at the same `{ at: "min" }`.

  // Agent flags belong to the two commands that end in a document execution —
  // `xmd test` drives agents through the deterministic TestAgent stack instead.
  if (mode.agent) {
    yield* installRunAgentStack(mode.agent);
  }
}

/**
 * Run one document and report how it finished.
 *
 * The Result is this operation's only verdict: nothing here reports a failure
 * or exits, so a caller running several documents decides once, at the end,
 * what the process status is. Rendered output, the --verbose journal echo, and
 * a value root's JSON line are the document's own output and stay.
 */
function* runDocument(
  config: DocumentConfig,
  mode: DocumentMode,
  installService: HostServiceInstaller,
  installRepositories: RepositoryInstaller,
  childRepositories: RepositoryInstaller,
): Operation<Result<void>> {
  const { root, include, verbose, journal, raw, secretDetection, retainProcessOutput } = config;

  // Every CLI invocation starts from an empty stream unless the caller owns
  // one. --journal writes current-run diagnostics only; existing traces are
  // never loaded.
  let stream: DurableStream;

  if (config.stream) {
    stream = config.stream;
  } else if (journal) {
    yield* createJournalFile(journal);
    stream = new FileStream(journal);
  } else {
    stream = new InMemoryStream();
  }

  // The packaged `<Plan>` Component, declared to this execution before the root is
  // imported. The run profile is where `<Plan>` belongs — a document that writes
  // one is asking for the same workflow `xmd plan` runs — and the surface is
  // fixed here, so the thin command adapter cannot supply or derive it and a
  // Plan a later `xmd run` executes is an ordinary run that receives
  // `component` from its own declaration.
  //
  // Built whether or not this command settled an Agent stack. A host with none —
  // `xmd test` drives agents through the deterministic TestAgent stack — still
  // declares the Component, so a document that writes `<Plan>` there resolves the
  // same protected bytes and is refused for want of an Agent rather than told the
  // component does not exist.
  //
  // A factory rather than a value, because a nested `<Execution host="run">`
  // learns what Agent context it has only after its own configuration has
  // been read — and a declaration built out here would have closed over the
  // absence of one before that child existed. Each caller supplies the context
  // it settled, the authorship root it owns and the scope its host acts run in;
  // everything else about the Component is this entrypoint's and identical for
  // all of them.
  const planDeclaration = (request: ChildPlanDeclaration): Operation<DeclaredMarkdownComponent> =>
    planComponentDeclaration({
      surface: "component",
      includes: include,
      context: request.context,
      ...(mode.machineSessions === undefined ? {} : { sessions: mode.machineSessions }),
      ...(request.authorshipRoot !== undefined
        ? { authorshipRoot: request.authorshipRoot }
        : mode.planAuthorshipRoot === undefined
          ? {}
          : { authorshipRoot: mode.planAuthorshipRoot }),
      // Captured before the document exists, so the two acts that are this
      // host's — putting this build's adapter on disk, and opening the review
      // form — run outside the frame the Component installs around itself.
      host: request.host,
      ...(request.observeAuthorship === undefined
        ? {}
        : { observeAuthorship: request.observeAuthorship }),
      installElicitation: request.installElicitation,
    });

  const plan = yield* planDeclaration({
    context: planAgentContext(mode.agent),
    host: yield* useScope(),
    // This command's own root: the browser form is how a person reviews a Plan
    // written by an ordinary run.
    installElicitation: installWebElicitation,
  });

  // Wire --verbose observability via Signal.
  // FileStream.onAppend fires after each persist; the signal fans out
  // to the stderr writer below. Persistence is handled by FileStream
  // itself — the signal is purely for observability.
  const signal = verbose ? createSignal<DurableEvent, void>() : undefined;

  if (signal && stream instanceof FileStream) {
    stream.onAppend = (event: DurableEvent) => signal.send(event);
  } else if (signal && stream instanceof InMemoryStream) {
    stream.onAppend = (event: DurableEvent) => signal.send(event);
  }

  // Spawn verbose stderr writer
  const writer = signal
    ? yield* spawn(function* () {
        for (const event of yield* each(signal)) {
          console.error(summarizeEvent(event));
          yield* each.next();
        }
      })
    : spawn(function* () {});

  if (!raw) {
    yield* useNormalizedOutput();
  }

  if (process.stdout.isTTY && !raw) {
    yield* useTerminalOutput();
  }

  yield* installDocumentComponents(mode, verbose);

  // `xmd test` reports on stdout, so the JSON result contract is `xmd run`'s
  // alone. Reading the mode costs no document effects.
  const valueRoot = !mode.testing && (yield* readsValue(root));

  if (valueRoot) {
    // This run's stdout carries the JSON result and nothing else, so a
    // command's stdout is shown on the stream that is free. Which of this
    // process's streams a channel lands on is this process's own business, and
    // it is settled here, at the boundary that owns them. This is display
    // policy, downstream of the per-exec boundary: the channel was recorded
    // when it was received there, and showing it elsewhere leaves that alone.
    yield* Stdio.around(
      {
        *stdout([bytes]) {
          process.stderr.write(bytes);
        },
      },
      { at: "min" },
    );
  }

  // Native service authority belongs only to document execution. Help,
  // document inspection, and the agent worker never enter this scope.
  //
  // This wires a provider into scope; it starts nothing. A run refused by the
  // reread inside `execute()` below has passed this line and still never asks
  // the provider for a service.
  yield* installService();

  // Repository authority belongs to document execution too, and it is this
  // execution's own: the provider it installs holds an invocation identity, the
  // leases on the checkouts this document selects, and the evidence of what it
  // published. `xmd run` supplies the live one; `xmd plan` executes no document
  // of a caller's and reaches this line for none.
  // `xmd test` and every runtime without an operational provider supply the one
  // that installs nothing, and every repository operation then reports an
  // absent provider before touching anything.
  yield* installRepositories();

  // What a `<Test>` in this document runs a nested execution under. Captured
  // before document code begins, so a child is offered exactly what this
  // command assembled — and never a second description of it.
  //
  // The worker argv is read here for the same reason: only a runtime-named
  // entrypoint can say how to re-invoke this host, and a child runs in a scope
  // that inherits no `API.Env` handler. What crosses is the argv, not the Api
  // that produced it.
  const testingHost = testingExecutionHost({
    includes: include,
    secretDetection,
    installService,
    // The *entrypoint's* installer, not this command's. A `host="run"` child is
    // an ordinary run whatever command is hosting it, so `xmd test` — which
    // installs no repository provider for its own document — still gives one to
    // a child that asked to be a run. Passed rather than inherited because a
    // child runs in an isolated scope and needs a fresh instance: its own
    // invocation identity, its own leases and its own Push evidence.
    installRepositories: childRepositories,
    testAgentWorker: yield* readWorkerCommand(),
    planDeclaration,
  });

  // One authoritative execution, and only one. What a host attaches travels as
  // values canonical core captures before anything else exists — never as a
  // second call, and never as middleware that could be reordered around this
  // one.
  const execution = yield* executeInstalled(
    {
      ...root,
      stream,
      props: mode.props,
      includes: include,
      secretDetection,
      // Whatever the host path decided. A run that keeps nothing forwards its
      // commands' output to the reader and accumulates none of it.
      retainProcessOutput,
    },
    // The harness installer is this command's, not the document's: canonical
    // `<Test>` hands each invocation's authority to whoever the host attached,
    // and this is where `xmd` says that is the testing package.
    //
    // `<Session>` travels the same way: its implementation names durable work
    // after its own invocation, so the execution is told about it here — before
    // anything else is installed — and builds it from the claimant it mints.
    [
      ...(mode.installations ?? []),
      {
        components: agentIdentityComponents(),
        // The `run` profile's own vocabulary. `xmd test` is a different profile
        // and does not gain `<Plan>` at its root — but the production run child
        // it can launch is the run profile, and gets it below.
        ...(mode.testing ? {} : { declarations: [plan] }),
      },
      // The declarations a nested execution may configure a child with, named
      // by the exact definitions this command installed. Recognizing one is
      // recognizing a definition, and only the host knows which package's copy
      // it registered — a repository component of the same name is an ordinary
      // component and configures nothing.
      testHarnessInstallation(testingHost, [testAgentChildDeclaration()]),
    ],
  );

  // Consume the output stream with forEach.
  // A value root reserves stdout for its result: its rendered body is
  // observability, shown on stderr under --verbose and dropped otherwise.
  // Interactive TTY: write each chunk as it arrives.
  // Piped: collect and write the full output at the end.
  const discarded = config.discardOutput === true;
  const fullOutput = yield* forEach(function* (chunk: string) {
    if (valueRoot || discarded) {
      if (verbose && !discarded) {
        process.stderr.write(chunk);
      }
      return;
    }
    if (process.stdout.isTTY) {
      process.stdout.write(chunk);
    }
  }, execution.output);

  // When piped (not TTY), write the full output at the end.
  if (!valueRoot && !discarded && !process.stdout.isTTY) {
    process.stdout.write(fullOutput);
  }

  // Close the signal so the writer drains remaining events and exits.
  if (signal) {
    signal.close();
    yield* writer;
  }

  // Inspect the completion Result AFTER the report finished streaming:
  // test failures, assertion aborts, and any document abort fail the run.
  const result = yield* execution;
  if (!result.ok) {
    return result;
  }

  // Written straight to stdout, so the result never passes through markdown
  // normalization or terminal formatting.
  if (valueRoot) {
    process.stdout.write(`${JSON.stringify(result.value)}\n`);
  }

  return Ok(undefined);
}

/**
 * Run one document inside its own scope, converting every failure into a
 * Result.
 *
 * The scope tears down after `runDocument` returns, so a teardown failure can
 * only be caught out here. That is what lets a directory run continue past a
 * document whose resources failed to release.
 */
function* runScopedDocument(
  config: DocumentConfig,
  mode: DocumentMode,
  installService: HostServiceInstaller,
  installRepositories: RepositoryInstaller,
  childRepositories: RepositoryInstaller = installRepositories,
): Operation<Result<void>> {
  try {
    return yield* scoped(() =>
      runDocument(config, mode, installService, installRepositories, childRepositories),
    );
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * A document-target failure as the command line reports it, or `undefined`
 * when this failure is not one.
 *
 * The core states the outcome and lists canonical target fragments; a caller
 * holds a command line, so every fragment is rendered as the full document
 * reference that selects it. The core's own first line is kept exactly as it
 * derived it, so the wording lives in one place.
 *
 * `formatDocumentReference` cannot refuse this path: it round-trips what
 * `fileSource` decoded, and a reference that does not decode never reaches a
 * selection at all.
 */
function targetFailureReport(root: RootDocumentSource, error: unknown): string | undefined {
  const failure = asDocumentTargetError(error);
  if (failure === undefined) {
    return undefined;
  }
  const [outcome = failure.message] = failure.message.split("\n");
  const ambiguous = failure.data.kind === "multiple-matches";
  const listed = ambiguous ? failure.data.matches : failure.data.available;
  if (listed.length === 0) {
    return `${outcome}\nThe document has no targets.`;
  }
  const heading = ambiguous ? "Matched targets:" : "Available targets:";
  const references = listed.map((target) => `  ${formatDocumentReference(root.path, target)}`);
  return [outcome, heading, ...references].join("\n");
}

interface TestConfig extends Omit<DocumentConfig, "root"> {
  /**
   * Optional because `field` types a schema by what it accepts, and
   * `z.string().default(".")` accepts nothing as well as a string. The
   * schema still produces "." for an omitted argument.
   */
  path?: string;
  pattern: string[];
}

/**
 * `xmd test` — one document, or every document a directory holds.
 *
 * A directory keeps going after a failure and decides the status once at the
 * end. A single document behaves exactly as it always has: one reported
 * failure, no heading, no summary.
 */
function* test(
  config: TestConfig,
  args: string[],
  installService: HostServiceInstaller,
  /** What a `<Execution host="run">` child installs. This command installs none. */
  installRepositories: RepositoryInstaller,
): Operation<void> {
  const patterns = readPatternFlags(args);
  if (patterns.missingValue) {
    console.error(
      `${PATTERN_OPTION} requires a value — write \`${PATTERN_OPTION} <glob>\`, or ` +
        `\`${PATTERN_OPTION}=<glob>\` for a glob that begins with "-"`,
    );
    yield* exit(1);
    return;
  }
  if (patterns.values.some((value) => value.length === 0)) {
    console.error(`${PATTERN_OPTION} requires a glob — an empty pattern matches nothing`);
    yield* exit(1);
    return;
  }

  const path = config.path ?? ".";
  const target = yield* resolveTestTarget(path, config.pattern);

  if (target.kind === "file") {
    if (patterns.values.length > 0) {
      console.error(
        `unrecognized option for xmd test: ${PATTERN_OPTION} — ${path} is a single document, ` +
          `so there is nothing to search`,
      );
      yield* exit(1);
      return;
    }
    announceSecretDetection(config.secretDetection);
    const result = yield* runScopedDocument(
      { ...config, root: { path } },
      { testing: true },
      installService,
      // The outer `xmd test` command installs no operational repository
      // provider. A test that needs the production behavior exercises an
      // explicit `<Execution host="run">` child, which is an ordinary run and
      // is handed the entrypoint's own installer below.
      unsupportedRepositories,
      installRepositories,
    );
    if (!result.ok) {
      reportFailure(result.error);
      yield* exit(1);
    }
    return;
  }

  // Rejected before the first document, so no trace file is created for a run
  // whose remaining documents would collide with it.
  if (config.journal !== undefined) {
    console.error(
      "--journal is not supported with a directory target — run a single document to write a trace",
    );
    yield* exit(1);
    return;
  }

  if (target.documents.length === 0) {
    console.error(`no documents matched ${config.pattern.join(", ")} in ${path}`);
    yield* exit(1);
    return;
  }

  // Once for the run, not once per document: the option is the invocation's,
  // and a directory of fifty documents would otherwise say so fifty times.
  announceSecretDetection(config.secretDetection);

  const failures: string[] = [];

  for (const document of target.documents) {
    process.stdout.write(`\n# ${document.relativePath}\n\n`);
    const result = yield* runScopedDocument(
      {
        ...config,
        root: { path: document.path },
        include: componentSearchPath(document, target.root, config.include),
      },
      { testing: true },
      installService,
      unsupportedRepositories,
      installRepositories,
    );
    if (!result.ok) {
      reportFailure(result.error, document.relativePath);
      failures.push(document.relativePath);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${target.documents.length} documents failed`);
    yield* exit(1);
  }
}

/** A file document reference read as one, or why it cannot be read. */
function readReference(reference: string): Result<FileRootDocument> {
  try {
    return Ok(fileSource(reference));
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * A document that cannot be inspected — missing, malformed, or unreadable —
 * reports text, so execution produces the printed error rather than inspection.
 *
 * A target failure is the exception, and it is raised rather than deferred. By
 * the time a run reaches here the requested selector has already been replaced
 * by the exact target it resolved to, so a failure means the document no longer
 * offers the section this run decided on.
 *
 * Raising it here refuses the run at the earliest read that can see it, which is
 * before the host's provider installer. A document replaced later still cannot
 * be caught here — `execute()` reads it once more and raises the same failure
 * after the installer has run — so this is the earlier of two refusals, not the
 * only one. Neither starts a service or expands anything.
 */
function* readsValue(root: RootDocumentSource): Operation<boolean> {
  try {
    const description = yield* inspectDocument(root);
    return description.returnMode === "value";
  } catch (error) {
    const failure = asDocumentTargetError(error);
    if (failure !== undefined) {
      throw failure;
    }
    return false;
  }
}

interface HelpRequest {
  requested: boolean;
  args: string[];
}

/**
 * Remove `--help` wherever it appears so document-aware help works in
 * every documented position. `--version` keeps its own handling.
 */
function takeHelpFlag(args: string[]): HelpRequest {
  const kept: string[] = [];
  let requested = false;

  for (const [index, arg] of args.entries()) {
    if (arg === "--") {
      kept.push(...args.slice(index));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      requested = true;
      continue;
    }
    kept.push(arg);
  }

  return { requested, args: kept };
}

function findPropsFlag(args: string[]): string | undefined {
  return args.find((arg) => arg === AGGREGATE_OPTION || arg.startsWith("--props"));
}

const PATTERN_OPTION = "--pattern";

interface PatternFlags {
  /** Values the caller wrote, in the order they wrote them. */
  values: string[];
  /** A `--pattern` that ran out of argv or was followed by another option. */
  missingValue: boolean;
}

/**
 * Read `--pattern` from argv.
 *
 * The resolved configuration answers none of the questions this serves. It
 * cannot say whether the option was given at all — the default is a real
 * value, indistinguishable from a typed one — and it hides unusable input: the
 * parser picks the last *valid* source, so an empty pattern falls back to the
 * default, and it happily reads the next option as the glob.
 *
 * A separated value that begins with `-` is another option, not a glob;
 * `--pattern=<glob>` expresses a glob that really does begin with one.
 */
function readPatternFlags(args: string[]): PatternFlags {
  const values: string[] = [];
  let missingValue = false;

  for (const [index, arg] of args.entries()) {
    if (arg === "--") {
      break;
    }
    if (arg === PATTERN_OPTION) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        missingValue = true;
        continue;
      }
      values.push(value);
      continue;
    }
    if (arg.startsWith(`${PATTERN_OPTION}=`)) {
      values.push(arg.slice(PATTERN_OPTION.length + 1));
    }
  }

  return { values, missingValue };
}

interface PropsPhase {
  /** argv with document-derived tokens removed. */
  args: string[];
  /**
   * The subcommand and target `xmd workflow` resolved, when it is the command.
   *
   * Carried rather than re-parsed downstream: `args` is the head, so a
   * positional written after `--` is not in it, and asking the parser again
   * would lose exactly the token the separator was there to protect.
   */
  workflow?: { action?: string; target?: string; argument?: string; value?: string };
  /**
   * What fixed grammar established about an `xmd plan` command line.
   *
   * Carried rather than re-derived downstream, for the same reason the workflow
   * positionals are: the request may have been written after `--`, where the
   * parser never sees it, and the generated property occurrences are the ones
   * this scan classified.
   */
  plan?: PlanScan;
  root?: RootDocumentSource;
  bindings: Binding[];
  extraction?: Extraction;
  propsSchema?: PropsSchema;
  declared?: string[];
  /**
   * What the inspected document addresses, described.
   *
   * Present only for a file-backed root that addresses something: an inline
   * document is not a selectable reference, so it has no section to offer.
   * Carried from the one inspection this phase already performs — help never
   * reads the document a second time.
   */
  targetInfo?: readonly DocumentTargetInfo[];
  error?: string;
  /**
   * The immutable definition a `workflow start` established, when it did.
   *
   * Established here rather than later because the props a run is created with
   * are the ones the *pinned* document declares: reading the working tree to
   * build the bindings and then executing the commit would let help and parsing
   * describe a document that is not the one running.
   */
  established?: EstablishedDefinition;
}

/** The document argument that names standard input, and nothing else. */
const STANDARD_INPUT_ARGUMENT = "-";

/**
 * Whether these arguments select the `run` command by naming it.
 *
 * Read from argv rather than from a parse, exactly as `workflow` and `plan`
 * are: the shorthand form resolves to the same parsed command, and the two have
 * to stay distinguishable for the standard-input sentinel below.
 */
function namesRun(args: string[]): boolean {
  return args[0] === "run";
}

interface DocumentArgument {
  /** The reference the caller wrote, as they wrote it. */
  reference: string;
  /** argv with that token, and the separator protecting it, removed. */
  rest: string[];
}

/** A reference's path half: everything before its first raw `#`. */
function referencePath(reference: string): string {
  const fragment = reference.indexOf("#");
  return fragment === -1 ? reference : reference.slice(0, fragment);
}

/**
 * The document argument a run named that the parser could not take.
 *
 * Configliere refuses every positional beginning with `-` and defines no
 * end-of-options separator, so `-` is the one filename its option grammar
 * leaves unwritable — and a reference selecting a section of that file is
 * written the same way. Both are read out of the parser's own remainder, the
 * tokens it did not consume, rather than out of raw argv, where a `-` another
 * option took as its value (`--journal -`) looks identical.
 *
 * Nothing else beginning with `-` is one. A mistyped option stays an option the
 * parser does not define, so a run written with one still refuses for want of a
 * root rather than going looking for a file named after the flag.
 *
 * Removing the token is what lets everything written around it — before it or
 * after it — parse as it would around an ordinary path.
 */
function takeDocumentArgument(args: string[], remainder: string[]): DocumentArgument | undefined {
  const separated = remainder[0] === "--";
  const [reference] = separated ? remainder.slice(1, 2) : remainder;
  if (reference === undefined || referencePath(reference) !== STANDARD_INPUT_ARGUMENT) {
    return undefined;
  }
  const at = args.length - remainder.length;
  if (args[at] !== remainder[0]) {
    return undefined;
  }
  return { reference, rest: [...args.slice(0, at), ...remainder.slice(separated ? 2 : 1)] };
}

interface RunGrammar {
  /** Every reference the parser could not take, in the order written. */
  references: string[];
  /** argv with all of them removed. */
  args: string[];
  /** The parse of that argv. */
  parsed: ReturnType<typeof xmd.parse>;
}

/**
 * Read every document argument a run named, not just the first.
 *
 * The parser stops at the first token it does not define, so one pass sees one
 * of them. A run that named two roots — a path and a `-`, two `-`s, a reference
 * and a path — has to refuse whichever order they were written in, and it can
 * only do that once all of them are known. Each pass removes one token, so this
 * terminates; what comes back is what the run actually wrote.
 */
function readDocumentArguments(head: string[], recover: boolean): RunGrammar {
  let args = head;
  let parsed = xmd.parse({ args });
  const references: string[] = [];
  while (recover) {
    const config = parsed.ok && !parsed.value.config.help ? parsed.value.config : undefined;
    if (config?.name !== "run") {
      break;
    }
    const taken = takeDocumentArgument(args, parsed.remainder.args ?? []);
    if (taken === undefined) {
      break;
    }
    references.push(taken.reference);
    args = taken.rest;
    parsed = xmd.parse({ args });
  }
  return { references, args, parsed };
}

/**
 * Every root document this command line named, in the order it was written.
 *
 * The parsed path and each recovered reference stay separate facts until here,
 * because which of them the parser happened to take depends on where the caller
 * wrote them and a conflict does not.
 */
function writtenRoots(
  head: string[],
  references: readonly string[],
  path: string | undefined,
): string[] {
  const pending = path === undefined ? [...references] : [...references, path];
  const roots: string[] = [];
  for (const token of head) {
    const at = pending.indexOf(token);
    if (at !== -1) {
      pending.splice(at, 1);
      roots.push(token);
    }
  }
  return roots;
}

/**
 * Locate the root document, read what it declares, and lift its generated
 * options out of argv. A provisional parse finds the path: it stops at
 * the first token it does not define, which is exactly where
 * document-derived options begin. The inline document was already lifted out
 * of argv, so it needs no parse at all.
 *
 * Standard input is acquired here, before the document is inspected and
 * therefore before every later phase of a run. Fixed grammar decides that it is
 * the source — the command form the caller wrote, plus the sentinel document
 * argument — and every grammar failure that could make the read pointless is
 * answered first, so the host reads once or not at all.
 */
function* preparePropsPhase(
  args: string[],
  evalFlags: EvalFlags,
  readStandardInput: StandardInputReader,
): Operation<PropsPhase> {
  // `xmd plan` declares its own grammar and has no document to inspect: the
  // schema its generated options come from is written by an agent that has not
  // been asked anything yet. Everything below that reads a document, and every
  // refusal that assumes one, is therefore skipped.
  if (namesPlan(args)) {
    // Refused here rather than with the other commands' inline refusal below,
    // because that one is reached through the parse this branch exists to skip.
    // An inline document is what `xmd plan` sets out to write, so a caller who
    // supplied one would otherwise watch it generate a different one instead.
    if (evalFlags.values[0] !== undefined) {
      return {
        args,
        bindings: [],
        error:
          `unrecognized option for xmd plan: ${EVAL_OPTION} — inline documents are ` +
          "exclusive to xmd run",
      };
    }
    const scan = scanPlanArgs(args);
    return { args: scan.fixed, bindings: [], plan: scan };
  }

  // `xmd workflow` reads its options from the head and its remaining positionals
  // from the tail. The parser only ever sees the head, so a dash-leading token
  // after `--` is never offered to it as an option; the grammar check below
  // still sees the argv that had the separator, because where options stopped
  // is what decides whether a later token is a third positional.
  const workflow = namesWorkflow(args);
  const separated = separateArgs(args);
  const head = workflow ? separated.head : args;
  // A run's parse takes at most one path, and a token beginning with `-` it
  // takes none of. Every other command keeps whatever `-` already means to it.
  const recovered = readDocumentArguments(head, !workflow);
  const fixed = recovered.references.length === 0 ? args : recovered.args;
  const parsed = recovered.args;
  const provisional = recovered.parsed;
  // `program` short-circuits on `--version` and leaves no configuration
  // behind, so there is nothing to inspect.
  const selected = provisional.ok ? provisional.value.config : undefined;
  const command = selected && !selected.help ? selected.name : undefined;
  const parsedPath =
    selected && !selected.help && selected.name === "run" ? selected.config.path : undefined;
  const roots = writtenRoots(head, recovered.references, parsedPath);
  // The sentinel is one exact argument on one command form. Only the form the
  // caller wrote separates `xmd run -` from the shorthand `xmd -`, which
  // resolves to the same parsed command and names a file called `-`.
  const standardInput = namesRun(args) && recovered.references.includes(STANDARD_INPUT_ARGUMENT);
  const describeRoot = (root: string): string =>
    standardInput && root === STANDARD_INPUT_ARGUMENT ? "standard input" : root;
  const [supplied] = evalFlags.values;

  if (selected && !selected.help && selected.name === "workflow") {
    return yield* prepareWorkflowProps(
      args,
      parsed,
      { ...selected.config, ...workflowPositionals(selected.config, separated.tail) },
      supplied,
    );
  }

  if (supplied !== undefined && command !== undefined && command !== "run") {
    return {
      args: fixed,
      bindings: [],
      error: `unrecognized option for xmd ${command}: ${EVAL_OPTION} — inline documents are exclusive to xmd run`,
    };
  }

  if (supplied !== undefined && standardInput) {
    return {
      args: fixed,
      bindings: [],
      error:
        `standard input and ${EVAL_OPTION} both supply a root document — a run takes exactly one, ` +
        `either \`xmd run -\` or \`xmd run ${EVAL_ALIAS} '<markdown>'\``,
    };
  }

  const [first, second] = roots;

  if (supplied !== undefined && first !== undefined) {
    return {
      args: fixed,
      bindings: [],
      error:
        `${first} and ${EVAL_OPTION} both supply a root document — a run takes exactly one, ` +
        `either \`xmd run ${first}\` or \`xmd run ${EVAL_ALIAS} '<markdown>'\``,
    };
  }

  // Decided from what was written rather than from what the parser managed to
  // take, so the two orders of the same pair refuse alike — and neither
  // candidate is read, inspected or run.
  if (second !== undefined) {
    const one = describeRoot(first);
    const other = describeRoot(second);
    return {
      args: fixed,
      bindings: [],
      error:
        one === other
          ? `${one} supplies the root document more than once — a run takes exactly one`
          : `${one} and ${other} both supply a root document — a run takes exactly one`,
    };
  }

  // A file path is a document reference: the first raw `#` starts a target
  // selector. Supplied text addresses nothing, so it is read as it is.
  let root: RootDocumentSource | undefined;
  if (supplied !== undefined) {
    root = inlineSource(supplied);
  } else if (standardInput) {
    // The one read, before this phase inspects anything. What came back is the
    // whole document and its origin together, on the existing supplied-source
    // terms: `<stdin>` is what positions and diagnostics report, and the exact
    // text is what the root binding and the durable root import retain.
    const input = yield* readStandardInput();
    if (!input.ok) {
      return { args: fixed, bindings: [], error: STANDARD_INPUT_FAILURE };
    }
    root = retainedSource(STANDARD_INPUT_PATH, input.value);
  } else if (first !== undefined) {
    const reference = readReference(first);
    if (!reference.ok) {
      return { args: fixed, bindings: [], error: describeError(reference.error) };
    }
    root = reference.value;
  }

  if (!root) {
    const stray = findPropsFlag(fixed);
    if (stray && command && command !== "run") {
      return {
        args: fixed,
        bindings: [],
        error:
          `unrecognized option for xmd ${command}: ${stray} — document properties are ` +
          "exclusive to xmd run",
      };
    }
    if (stray) {
      return {
        args: fixed,
        bindings: [],
        error: `unrecognized option: ${stray} — document properties follow the document, as in \`xmd run <document> ${stray} …\``,
      };
    }
    return { args: fixed, bindings: [] };
  }

  try {
    const document = yield* inspectDocument(root);
    const bindings = buildBindings(document.props);
    const extraction = extractPropsArgs(fixed, bindings);
    const addressable = root.source === undefined && document.targetInfo.length > 0;
    return {
      args: extraction.rest,
      root: exactRoot(root, document.target),
      bindings,
      extraction,
      propsSchema: document.props,
      declared: declaredProperties(document.props),
      ...(addressable ? { targetInfo: document.targetInfo } : {}),
    };
  } catch (error) {
    return {
      args: fixed,
      bindings: [],
      root,
      error: targetFailureReport(root, error) ?? describeError(error),
    };
  }
}

/**
 * The root execution runs, with the requested selector replaced by the one
 * exact target it resolved to.
 *
 * Load-bearing, because the CLI inspects a file and executes from a later read
 * of it. A wildcard that resolved to `Alpha` here asks execution for exactly
 * `Alpha`: if the file is replaced so the same wildcard would now name `Beta`,
 * the run fails on the missing `Alpha` rather than quietly running `Beta`.
 */
function exactRoot(root: RootDocumentSource, target: string | undefined): RootDocumentSource {
  if (target === undefined) {
    return root;
  }
  return root.source === undefined ? { path: root.path, target } : { ...root, target };
}

/**
 * The props phase of a `workflow` invocation.
 *
 * `start` reads what the pinned definition declares, so its generated
 * `--props-*` arguments are exactly `xmd run`'s for that document. A `fork`
 * reads the same way, from the definition it names as its third argument: the
 * fork is a run of that document, so its props are that document's — merged
 * over what the source retained, which happens later, once the run store can be
 * read. `resume` declares nothing at all: its props are the ones the run
 * retained, and any spelling that would supply new ones is refused rather than
 * ignored.
 */
function* prepareWorkflowProps(
  rawArgs: string[],
  args: string[],
  config: { action?: string; target?: string; argument?: string; value?: string },
  inlineDocument: string | undefined,
): Operation<PropsPhase> {
  const workflow = {
    action: config.action,
    target: config.target,
    argument: config.argument,
    value: config.value,
  };
  if (inlineDocument !== undefined) {
    return {
      args: rawArgs,
      bindings: [],
      workflow,
      error: `unrecognized option for xmd workflow: ${EVAL_OPTION} — inline documents are exclusive to xmd run`,
    };
  }

  // Read before anything is stripped: `--` ends option parsing, so a token
  // after it is positional however it is spelled, and the count has to be taken
  // while the separator is still there to say where options stopped.
  const extra = extraWorkflowArgument(rawArgs, config.action);
  if (extra !== undefined) {
    return {
      args: rawArgs,
      bindings: [],
      workflow,
      error:
        `unrecognized argument for xmd workflow: ${extra} — start names one definition, ` +
        "resume names one run, and answer names a run, a wait and one JSON value",
    };
  }

  const stray = findPropsFlag(args);
  // Only the two actions that name a definition declare properties. A fork
  // names its own, as its third argument: it is a run of that document, so the
  // generated arguments are that document's rather than the source run's.
  const definitionPath = workflowDefinitionPath(config);
  if (definitionPath === undefined) {
    if (stray) {
      const action = config.action ?? "resume";
      return {
        args,
        bindings: [],
        workflow,
        error:
          `unrecognized option for xmd workflow ${action}: ${stray} — document properties ` +
          "belong to the start that created the run, whose props it retained",
      };
    }
    return { args, bindings: [], workflow };
  }

  if (definitionPath === "") {
    return { args, bindings: [], workflow };
  }

  const established = yield* establishDefinition(definitionPath);
  if (!established.ok) {
    return { args, bindings: [], workflow, error: established.error.message };
  }

  const root = retainedSource(
    established.value.definition.rootDocumentPath,
    established.value.source,
  );
  try {
    const document = yield* inspectDocument(root);
    const bindings = buildBindings(document.props);
    const extraction = extractPropsArgs(args, bindings);
    return {
      args: extraction.rest,
      workflow,
      root,
      bindings,
      extraction,
      propsSchema: document.props,
      declared: declaredProperties(document.props),
      established: established.value,
    };
  } catch (error) {
    return { args, bindings: [], workflow, root, error: describeError(error) };
  }
}

/**
 * The document one `workflow` invocation runs, when it names one.
 *
 * `start` names it as its only argument and `fork` as its second; every other
 * action names a run and no definition at all. The empty string is a definition
 * the caller has not written yet, which the props phase reports later as a
 * missing argument rather than as an establishment failure.
 */
function workflowDefinitionPath(config: {
  action?: string;
  target?: string;
  argument?: string;
}): string | undefined {
  if (config.action === "start") {
    return config.target ?? "";
  }
  if (config.action === "fork") {
    return config.argument ?? "";
  }
  return undefined;
}

/**
 * Whether these arguments select the `workflow` command.
 *
 * Read from argv rather than from a parse, because the answer is needed before
 * the props phase and the props phase is what makes a parse meaningful.
 * Whatever the command turns out to be, only `workflow` names it first.
 */
function namesWorkflow(args: string[]): boolean {
  return args[0] === "workflow";
}

/**
 * A third positional argument to `xmd workflow`, when one was written.
 *
 * The parser stops at the first token it does not define rather than rejecting
 * it, so `xmd workflow resume <id> <document>` would otherwise run the resume
 * and silently ignore the document — exactly the confusion the lifecycle rule
 * exists to prevent, since a document never selects a run.
 *
 * Read from the argv the props phase already stripped, so a generated property
 * value is not mistaken for an argument. `--id` and `--at` are the options that
 * take a separated value, and `--` ends option parsing: every token after it is
 * positional, including one that begins with `-`.
 */
function extraWorkflowArgument(args: string[], action?: string): string | undefined {
  const start = args.indexOf("workflow");
  if (start === -1) {
    return undefined;
  }
  // The action is itself the first positional. Most actions take one more;
  // `fork` takes two, because it names the run it continues and the document it
  // continues with; `answer` takes three, because a delivery names the run, the
  // wait inside it and the value in that order.
  const allowed = action === "answer" ? 4 : action === "fork" ? 3 : 2;
  let positionals = 0;
  let skip = false;
  let parsingOptions = true;
  for (const arg of args.slice(start + 1)) {
    if (parsingOptions && !skip && arg === "--") {
      // The end of *option* parsing, and nothing more. What follows is
      // positional however it is spelled, so a third argument is still a third
      // argument — writing it after `--` used to end the check instead of the
      // options, which let it through to storage.
      parsingOptions = false;
      continue;
    }
    if (skip) {
      skip = false;
      continue;
    }
    if (parsingOptions && arg.startsWith("-")) {
      skip = arg === "--id" || arg === "--at";
      continue;
    }
    positionals += 1;
    if (positionals > allowed) {
      return arg;
    }
  }
  return undefined;
}

/**
 * An argv split at its end-of-options separator.
 *
 * The tail is carried rather than folded back in. Dropping the separator and
 * rejoining would hand a dash-leading positional — `-run-id`, `-definition.md`
 * — back to a parser that reads a leading dash as an option, which is exactly
 * what `--` was written to prevent.
 */
interface SeparatedArgs {
  /** Everything before `--`: the options, and any positionals written early. */
  head: string[];
  /** Everything after it, each token positional however it is spelled. */
  tail: string[];
}

function separateArgs(args: string[]): SeparatedArgs {
  const at = args.indexOf("--");
  return at === -1
    ? { head: args, tail: [] }
    : { head: args.slice(0, at), tail: args.slice(at + 1) };
}

/**
 * The subcommand and target one `xmd workflow` invocation names.
 *
 * The parser classifies what it can — everything before `--` — and the tail
 * supplies the rest in order. A token's spelling decides nothing here: after the
 * separator it is positional because of where it is.
 */
function workflowPositionals(
  config: { action?: string; target?: string; argument?: string; value?: string },
  tail: string[],
): { action?: string; target?: string; argument?: string; value?: string } {
  const named = [config.action, config.target, config.argument, config.value].filter(
    (written) => written !== undefined,
  );
  const [action, target, argument, value] = [...named, ...tail];
  return { action, target, argument, value };
}

/**
 * What `xmd upgrade --help` says beyond its option list.
 *
 * It reads nothing to say any of it. Which release is latest, how this
 * installation compares with it and whether it can replace itself are questions
 * the command answers by asking GitHub and opening the binary, and help asks
 * neither — a caller reading about a command has not run it.
 */
const UPGRADE_HELP = [
  "With no tag, xmd upgrade installs the latest published stable release. Name",
  "an exact tag instead to select one release and only that release:",
  "  xmd upgrade",
  "  xmd upgrade v1.2.3",
  "  xmd upgrade v1.3.0-rc.1 --allow-prerelease",
  "",
  "  --status",
  "      Report the installed version, the selected release, how the two",
  "      compare and the exact release URL. It downloads no binary, locks",
  "      nothing and changes no files, and it accepts any published exact tag",
  "      without consent — so neither consent option may be written with it.",
  "",
  "  --allow-downgrade",
  "      Consent to installing a release older than the installed one. It is",
  "      refused when the selected release is not older.",
  "",
  "  --allow-prerelease",
  "      Consent to installing the exact prerelease tag named. It is refused",
  "      without one, because no implicit selection ever chooses a prerelease.",
  "",
  "  --journal <path>, -j <path>",
  "      Write a diagnostic JSONL trace of this run to a new file. The path",
  "      must not exist. The trace is evidence only: it is never read back, it",
  "      resumes nothing, and it changes no output, release choice or consent.",
  "      With --status it is the one file the command writes.",
  "",
  "Only a compiled xmd on macOS or Linux can replace itself:",
  "",
  "  compiled binary            macOS or Linux: self-upgrade",
  "                             Windows: use the installer or a release asset",
  "  npm or Node                update with npm",
  "  Bun                        update with Bun",
  "  Deno or repository source  update the package version or the checkout",
  "",
  "Every other combination stops with instructions for that installation before",
  "the command reads release metadata or changes any files.",
  "",
  "An install downloads the release binary for this platform, checks it against",
  "the published SHA-256 checksum, runs the verified candidate and requires it",
  "to report the selected version, and only then replaces the binary that ran",
  "this command with one atomic rename. Anything that fails before that rename",
  "leaves the installed xmd exactly as it was.",
].join("\n");

const COMMAND_NAMES = ["run", "plan", "test", "syntax", "upgrade", "test-agent", "workflow"];

/**
 * What a caller has to know to write a filename that contains reference
 * syntax, and where the sections it can select are listed.
 */
const REFERENCE_GRAMMAR_HELP = [
  "A selector must name exactly one section; `xmd run <document.md> --help`",
  "lists them. In a filename, write `#` as `%23` and a literal `%` as `%25`.",
].join("\n");

/**
 * Where the root document comes from, and how to write it. Neither fits an
 * option description, and the help renderer has no epilogue, so it is composed
 * here beside the document-property section.
 */
const RUN_SOURCE_HELP = [
  "Exactly one root document is required: a path, standard input through " +
    `\`xmd run -\`, or one ${EVAL_OPTION} value.`,
  "Quote the document so the shell passes it as a single argument:",
  `  xmd ${EVAL_ALIAS} '# Hello'`,
  "",
  "`xmd run -` reads standard input to end of file and runs what it read, so a",
  "command that writes a complete document composes with a run:",
  '  xmd plan "prepare the release" | xmd run -',
  "",
  "Only that exact spelling reads it. A bare `xmd -` names a file called `-`,",
  `\`xmd run -#Section\` selects a section of that file, and ${EVAL_OPTION} takes`,
  "its document as the value.",
  "",
  "A path is a document reference, and everything after its first `#` selects",
  "one section of the document to run:",
  "  xmd run README.md#Release/Publish",
  "  xmd README.md#Release/*",
  "",
  REFERENCE_GRAMMAR_HELP,
].join("\n");

/**
 * What `xmd plan --help` says beyond its option list.
 *
 * It answers the two questions the option list cannot: what a request is, and
 * what happens to the program once it exists. Both explicit compositions are
 * written out, because "planning never runs the approved program" is only half
 * an answer without the command line that does.
 */
const PLAN_REQUEST_HELP = [
  "Exactly one request is required. It describes the program you want the coding",
  "agent to create, rather than a path. Quote it so the shell passes it as one",
  "argument:",
  '  xmd plan "Prepare the release program."',
  "",
  "A first-party command document turns the request into an XMD Plan. xmd checks",
  "each draft, and you approve, request changes, or stop before source leaves the",
  "command.",
  "",
  "The approved Plan is the only result. Without --output, stdout contains its",
  "exact source bytes and nothing else. With --output, the path is created",
  "exclusively after approval; an existing path is left unchanged.",
  "",
  "Planning never runs the approved program. Compose planning and execution",
  "explicitly through standard input:",
  '  xmd plan "Prepare the release program." | xmd run -',
  "",
  "Or preserve the artifact and run it later:",
  '  xmd plan "Prepare the release program." --output release.md && xmd run release.md',
  "",
  "A named --session continues the planning conversation. Without it, this",
  "invocation uses a unique session.",
  "",
  "Secret detection checks journal entries before they are recorded, but it may not",
  "catch every sensitive detail. The journal can contain prompts, drafts, and review",
  "answers.",
].join("\n");

/**
 * Help for whichever command the arguments name. A command renders its
 * own help when `--help` is its first argument, so the flag removed
 * during the props phase is reinstated there rather than falling back to
 * program help.
 */
function renderHelp(phase: PropsPhase): string {
  const [first] = phase.args;
  const command = COMMAND_NAMES.includes(first) ? first : phase.root ? "run" : undefined;

  if (!command) {
    return xmd.help({ args: phase.args });
  }

  const help = xmd.parse({ args: [command, "--help"] });
  const base = help.ok && help.value.config.help ? help.value.config.text : xmd.help({ args: [] });
  const epilogue =
    command === "run"
      ? RUN_SOURCE_HELP
      : command === "plan"
        ? PLAN_REQUEST_HELP
        : command === "upgrade"
          ? UPGRADE_HELP
          : "";
  const withSource = epilogue === "" ? base : `${base}\n\n${epilogue}`;

  if (!phase.root) {
    return withSource;
  }
  const documentPath = rootSourcePath(phase.root);
  // A document declaring only structured properties generates no
  // individual binding, but it still accepts the aggregate ones.
  const withProperties = phase.declared?.length
    ? `${withSource}\n\n${formatProperties(documentPath, phase.bindings)}`
    : withSource;
  if (phase.targetInfo === undefined) {
    return withProperties;
  }
  return `${withProperties}\n\n${formatTargets(documentPath, phase.targetInfo)}`;
}

/**
 * The sections this document offers, each as the reference that selects it.
 *
 * Source order and duplicates are the catalog's, so two sections that
 * canonicalize to one path appear twice — an ambiguity a caller can see rather
 * than one a selector resolves arbitrarily. A section that states no
 * description is listed all the same: it is still selectable.
 */
function formatTargets(documentPath: string, targets: readonly DocumentTargetInfo[]): string {
  const entries = targets.map((entry) => {
    const reference = `  ${formatDocumentReference(documentPath, entry.target)}`;
    return entry.description === undefined ? reference : `${reference}\n      ${entry.description}`;
  });
  return [`Targets in ${documentPath}`, ...entries].join("\n\n");
}

function* resolveRunProps(
  phase: PropsPhase,
): Operation<{ value?: Record<string, Json>; error?: string }> {
  if (!phase.extraction || phase.propsSchema === undefined) {
    return { value: {} };
  }

  try {
    return {
      value: yield* resolvePropsFromSources({
        propsSchema: phase.propsSchema,
        bindings: phase.bindings,
        extraction: phase.extraction,
      }),
    };
  } catch (error) {
    return { error: describeError(error) };
  }
}

/**
 * Run the CLI.
 *
 * The entrypoint that calls this has already installed the host's `API.Env`
 * providers — how this xmd is re-invoked, and how it compiles an eval block.
 * Neither decision, nor any runtime detection, happens here.
 *
 * This module still reaches the host directly for terminal and journal I/O —
 * `process.stdout` and `node:fs/promises`. Routing those through contextual
 * APIs is #156.
 */
/**
 * Everything an invocation does once its options are recognized: the props
 * phase, the command parse, and the command itself.
 *
 * For `xmd run` this is the run lifecycle, and it runs inside the run's
 * deadline — document inspection, target and props preparation, provider
 * installation, execution and output consumption all included. Nothing here
 * reads an option the caller has not already had validated.
 *
 * `workflowHost` is present only for `xmd workflow`, and only on a host that
 * supports it: every other invocation is handed nothing, which is what keeps a
 * run store from being inherited by omission.
 */
function* dispatch(
  evalFlags: EvalFlags,
  helpRequest: { requested: boolean; args: string[] },
  installService: HostServiceInstaller,
  upgrade: UpgradeAssembly,
  installRepositories: RepositoryInstaller,
  readStandardInput: StandardInputReader,
  workflowHost: WorkflowHost | undefined,
  sessions: MachineSessionAssembly | undefined,
): Operation<void> {
  // Before the props phase, and before the help short-circuit below. `--help`
  // is lifted out of argv early enough that a command's own grammar never sees
  // the invocation it was written on, so a Plan command line naming a removed
  // option would be answered with a page describing a command that would refuse
  // it. It is refused here instead, in either order, having read nothing.
  if (namesPlan(helpRequest.args)) {
    const removed = removedPlanOption(helpRequest.args);
    if (removed !== undefined) {
      console.error(removed);
      yield* exit(1);
      return;
    }
  }

  const propsPhase = yield* preparePropsPhase(helpRequest.args, evalFlags, readStandardInput);

  if (propsPhase.error) {
    console.error(propsPhase.error);
    yield* exit(1);
    return;
  }

  const parsed = xmd.parse({ args: propsPhase.args });

  if (helpRequest.requested) {
    console.log(renderHelp(propsPhase));
    yield* exit(0);
    return;
  }

  if (!parsed.ok) {
    console.error(parsed.error.message);
    yield* exit(1);
    return;
  }

  const { version, config: command } = parsed.value;

  if (version) {
    console.log(version);
    yield* exit(0);
    return;
  }

  if (command.help) {
    console.log(command.text);
    yield* exit(0);
    return;
  }

  // The rest of what `xmd plan` decides on its own — cardinality, an unknown
  // option, an empty session — answered before the shared checks below could
  // report one of them as something else. The removed options were answered
  // above, ahead of help.
  if (propsPhase.plan?.error !== undefined) {
    console.error(propsPhase.plan.error);
    yield* exit(1);
    return;
  }

  const secretDetectionError = secretDetectionGrammarError(evalFlags.rest);
  if (secretDetectionError) {
    console.error(secretDetectionError);
    yield* exit(1);
    return;
  }

  switch (command.name) {
    case "run": {
      const config = command.config;
      // Reported here rather than in the props phase: `xmd run --help` and
      // `xmd --help` describe the command without one, and they are handled
      // above.
      if (!propsPhase.root) {
        console.error(
          "xmd run requires a root document — `xmd run <document.md>`, `xmd run -`, or " +
            `\`xmd run ${EVAL_OPTION} '<markdown>'\``,
        );
        yield* exit(1);
        break;
      }
      const props = yield* resolveRunProps(propsPhase);
      if (props.error) {
        console.error(props.error);
        yield* exit(1);
        break;
      }
      const root = propsPhase.root;
      const runStack = yield* settleAgentStack(
        {
          agentProvider: config.agentProvider,
          defaultAgent: config.defaultAgent,
          approveAll: config.approveAll,
          approveReads: config.approveReads,
          denyAll: config.denyAll,
        },
        sessions,
      );
      if (runStack === undefined) {
        break;
      }
      announceSecretDetection(config.secretDetection);
      const result = yield* scoped(function* (): Operation<Result<void>> {
        // `<Elicit>` reaches a person through the browser form, and `xmd run`
        // is the command a person is sitting in front of. Composed here, in the
        // scope this profile assembles around its own document, because that is
        // what owning the question *is*: a host that answers installs a
        // provider, and one that does not installs none. Nothing downstream
        // reads a profile, so nothing downstream can read one wrong.
        yield* installWebElicitation();
        return yield* runScopedDocument(
          { ...config, root, retainProcessOutput: keepsProcessOutput(config.journal) },
          {
            testing: false,
            props: props.value,
            // Only `xmd run` receives it. Every other command assembles none of
            // it, which is what keeps a machine session from being acted on by
            // a command that never said it could own one.
            ...(sessions === undefined ? {} : { machineSessions: sessions }),
            agent: runStack,
          },
          installService,
          installRepositories,
        );
      });
      if (!result.ok) {
        // The document is reread between preparation and execution, so the
        // exact target this run decided on can be gone by the time it runs.
        const report = targetFailureReport(root, result.error);
        if (report === undefined) {
          reportFailure(result.error);
        } else {
          console.error(report);
        }
        yield* exit(1);
      }
      break;
    }
    case "plan": {
      const config = command.config;
      const scan = propsPhase.plan;
      if (scan?.request === undefined) {
        console.error('xmd plan names the command first — write `xmd plan "<request>" [options]`');
        yield* exit(1);
        break;
      }
      // Who writes, and nothing else. There is no permission mode to settle:
      // this command starts no program, and the ceiling authorship runs under
      // is the host's rather than the command line's.
      const authorship = yield* resolveAuthorshipStack(
        { agentProvider: config.agentProvider, defaultAgent: config.defaultAgent },
        sessions,
      );
      if (!authorship.ok) {
        console.error(authorship.error.message);
        yield* exit(1);
        break;
      }
      const exitCode = yield* runPlan(
        {
          request: scan.request,
          include: config.include,
          ...(config.output === undefined ? {} : { output: config.output }),
          ...(config.session === undefined ? {} : { session: config.session }),
          verbose: config.verbose,
          ...(config.journal === undefined ? {} : { journal: config.journal }),
          stack: authorship.value,
        },
        {
          ...(sessions === undefined ? {} : { sessions }),
          symbols: syntaxSymbols,
          // The two facts about this process's own stderr that nothing further
          // in may go and read: whether it is a terminal, and whether it took
          // what it was handed. The approved Plan's sinks are stdout and
          // `--output`, and progress reaches neither.
          progress: {
            terminal: process.stderr.isTTY === true,
            write: (chunk) => deliverWhole(chunk, process.stderr),
          },
          // `<Elicit>` reaches a person through the browser form, and the
          // review question is asked by the command rather than by a document.
          // A host that answers installs a provider; one that does not installs
          // none, and nothing downstream reads a profile to find out which.
          installElicitation: installWebElicitation,
        },
      );
      if (exitCode !== 0) {
        yield* exit(exitCode);
      }
      break;
    }
    case "upgrade": {
      // Fixed grammar first, and it reads nothing: a command line this command
      // does not define is answered before the packaged policy exists, before
      // the installation is opened and before GitHub is asked anything.
      const scan = scanUpgradeArgs(helpRequest.args);
      if (scan.error !== undefined) {
        console.error(scan.error);
        yield* exit(1);
        break;
      }

      // The caller owns the trace and its exclusive creation, exactly as
      // `xmd run --journal` does. Created before the command begins, so a path
      // that already exists costs nothing but a message.
      let stream: DurableStream;
      if (scan.journal === undefined) {
        stream = new InMemoryStream();
      } else {
        try {
          yield* createJournalFile(scan.journal);
        } catch (error) {
          console.error(describeError(error));
          yield* exit(1);
          break;
        }
        stream = new FileStream(scan.journal);
      }

      // A terminal shows the transcript as it is made; a pipe receives it in
      // one piece. Both drain the same stream — the difference is only when the
      // bytes are handed on, which is this process's business and not the
      // document's.
      const piped: string[] = [];
      const interactive = process.stdout.isTTY === true;
      const upgraded = yield* runUpgrade({
        command: {
          requestedTag: scan.tag,
          status: scan.status,
          allowDowngrade: scan.allowDowngrade,
          allowPrerelease: scan.allowPrerelease,
        },
        assembly: upgrade,
        stream,
        // deno-lint-ignore require-yield
        *consume(chunk) {
          if (interactive) {
            process.stdout.write(chunk);
            return;
          }
          piped.push(chunk);
        },
      });
      if (!interactive) {
        process.stdout.write(piped.join(""));
      }
      if (!upgraded.ok) {
        reportFailure(upgraded.error);
        yield* exit(1);
      }
      break;
    }
    case "test": {
      const strayTimeout = findTimeoutFlag(evalFlags.rest);
      if (strayTimeout) {
        console.error(
          `unrecognized option for xmd test: ${strayTimeout} — timeout options are exclusive to ` +
            belongsTo(strayTimeout),
        );
        yield* exit(1);
        break;
      }
      const agentFlag = findAgentOnlyFlag(evalFlags.rest);
      if (agentFlag) {
        console.error(
          `unrecognized option for xmd test: ${agentFlag} — agent options are exclusive to ` +
            belongsTo(agentFlag),
        );
        yield* exit(1);
        break;
      }
      const propsFlag = findPropsFlag(evalFlags.rest);
      if (propsFlag) {
        console.error(
          `unrecognized option for xmd test: ${propsFlag} — document properties are exclusive to ` +
            "xmd run",
        );
        yield* exit(1);
        break;
      }
      yield* test(
        { ...command.config, retainProcessOutput: keepsProcessOutput(command.config.journal) },
        evalFlags.rest,
        installService,
        installRepositories,
      );
      break;
    }
    case "syntax": {
      // One inspection per invocation, then one complete document. A failure
      // writes nothing to stdout: a healthy subset printed as though it were
      // the whole set of symbols would read as complete.
      let rendered: string;
      try {
        const named = command.config.component;
        if (named === undefined) {
          // The compact list of symbols, unchanged: routine discovery output and
          // every default Plan prompt read it, and long documentation would make
          // both unnecessarily large.
          const catalog = yield* syntaxSymbols(command.config.include);
          rendered = command.config.json
            ? renderSyntaxJson(catalog)
            : renderSyntaxMarkdown(catalog);
        } else {
          // The same selection, index and renderer `<Syntax names={…}>` uses, so
          // the command and the component cannot describe one component two
          // ways. JSON stays the compact projection; it is the symbols' shape,
          // and documentation is prose rather than a symbol member.
          rendered = yield* renderSyntaxDocumentation(command.config.include, [named]);
        }
      } catch (error) {
        console.error(describeError(error));
        yield* exit(1);
        break;
      }
      // Only this command's rendering goes through delivery today, because it
      // is the one output written in a single call and the only one already
      // past a pipe buffer.
      const written = yield* deliverWhole(rendered, process.stdout);
      if (!written.ok) {
        console.error(
          `xmd syntax: stdout did not accept the whole output: ${describeError(written.error)}`,
        );
        yield* exit(1);
      }
      break;
    }
    case "test-agent":
      yield* runTestAgentWorker({ connect: command.config.connect });
      break;
    case "workflow": {
      // The parser saw only the head, so the positionals the separator carried
      // come from the props phase rather than from a second parse of an argv
      // they are not in.
      const config = { ...command.config, ...propsPhase.workflow };
      const agentFlag = findAgentOnlyFlag(evalFlags.rest);
      if (agentFlag) {
        console.error(
          `unrecognized option for xmd workflow: ${agentFlag} — agent options are exclusive to ` +
            belongsTo(agentFlag),
        );
        yield* exit(1);
        break;
      }
      if (workflowHost === undefined) {
        console.error(UNSUPPORTED_WORKFLOW_HOST);
        yield* exit(1);
        break;
      }
      const invocation = parseWorkflowRequest(config, evalFlags.rest);
      if (!invocation.ok) {
        console.error(invocation.error.message);
        yield* exit(1);
        break;
      }
      if (invocation.value.kind === "manage") {
        const managed = yield* runWorkflowManagement(invocation.value.request, workflowHost);
        yield* exit(managed.exitCode);
        break;
      }
      const request = invocation.value.request;
      const props = yield* resolveRunProps(propsPhase);
      if (props.error) {
        console.error(props.error);
        yield* exit(1);
        break;
      }
      const start: WorkflowStart | undefined =
        propsPhase.established === undefined
          ? undefined
          : {
              established: propsPhase.established,
              props: props.value ?? {},
              // What the *candidate* declares. A fork merges the properties its
              // source retained under its own, and the result is held to the
              // document that is about to run.
              propsSchema: propsPhase.propsSchema ?? {},
            };
      announceSecretDetection(config.secretDetection);
      const outcome = yield* runWorkflow(request, start, workflowHost, (execution) =>
        execution.around(
          runScopedDocument(
            {
              root: execution.root,
              // A workflow definition is one immutable object. A component
              // search path would read the mutable checkout beside it, so a
              // repository component fails to resolve rather than resolving
              // to content the definition does not describe.
              include: [],
              verbose: request.verbose,
              journal: undefined,
              raw: request.raw,
              secretDetection: request.secretDetection,
              stream: execution.stream,
              // A workflow owns its journal, so its process results are part of
              // the run's retained history: a resumed procedure reads back what
              // its commands printed rather than re-running them to find out.
              // It names no `--journal`, which is exactly why this is stated
              // here and never derived from that pathname.
              retainProcessOutput: true,
              // A fork's compatibility replay renders history another run
              // already produced; the fork's own execution renders it again.
              ...(execution.discardOutput === true ? { discardOutput: true } : {}),
            },
            // No elicitation provider is composed around this document. The
            // workflow host attached the execution and installed the suspending
            // one already; a browser form here would sit nearer, answer first,
            // and wait for a reader the run has no way to reach.
            { testing: false, props: execution.props, installations: execution.installations },
            // The workflow authority boundary sits exactly where a host
            // service adapter would: installed inside the execution scope,
            // before the root document is imported.
            useWorkflowServiceDenial,
            // A workflow run's repositories are the retained ones its Workspace
            // attachment installs, so this path installs none of its own.
            unsupportedRepositories,
          ),
        ),
      );
      yield* exit(outcome.exitCode);
      break;
    }
  }
}

export function* runXmd(
  args: string[],
  installService: HostServiceInstaller,
  // What this xmd is, stated by the entrypoint that knows. Only an eligible
  // compiled macOS or Linux host carries the four phases an upgrade needs, so a
  // command run under any other one refuses with that installation's own remedy
  // rather than reaching for a release, a lock or a file.
  upgrade: UpgradeAssembly,
  // What an ordinary document execution installs for `<Repository>`,
  // `<Worktree>`, the Git operations, `<Issue>` and `<PullRequest>`. Deno and
  // the compiled binary supply the live provider; Node and Bun supply the one
  // that installs nothing, so those runtimes describe the same vocabulary and
  // operate none of it.
  installRepositories: RepositoryInstaller,
  // How this host reads a whole document from its own standard input, for the
  // one command form that asks for one. The shared CLI reaches no stdin global
  // of its own, and nothing a document can write reaches this: it is a value
  // the entrypoint supplies, called at most once per invocation.
  readStandardInput: StandardInputReader,
  // Defaults to the host that refuses. A caller driving this without naming a
  // workflow host has no run store, and inheriting one by omission is the
  // failure mode the whole boundary exists to prevent — so the default is the
  // one that creates and executes nothing.
  installWorkflowHost: HostWorkflowInstaller = unsupportedWorkflowHost,
  // What this host states about machine-wide agent sessions. Node and Bun
  // advertise the same agents and assemble none of the answers, so every
  // advertised operation refuses there rather than acting without knowing who
  // owns the session or which build it belongs to. A caller that names none
  // gets no machine sessions at all, which is the ordinary ACP behaviour.
  sessions?: MachineSessionAssembly,
): Operation<void> {
  // Before every scanner, before command selection, and before anything reads a
  // path. `prompt` names no command, and a first token that names none is a
  // document reference to the default `run` command — so a file of that name in
  // the working directory would be rendered and executed by a caller who wrote
  // a command, not a path. Refused closed here, where there is nothing yet to
  // undo: no eval scan, no parse, no catalog, no profile, no document.
  if (namesRetiredCommand(args)) {
    console.error(RETIRED_COMMAND_REFUSAL);
    yield* exit(1);
    return;
  }

  // First, so that no later scanner — help, properties, agent flags — can
  // mistake the inline document's own text for an option.
  const evalFlags = readEvalFlags(args);
  const grammarError = evalGrammarError(evalFlags);
  if (grammarError) {
    console.error(grammarError);
    yield* exit(1);
    return;
  }

  const helpRequest = takeHelpFlag(evalFlags.rest);

  // Before the props phase, because that phase establishes a workflow start's
  // definition from Git in order to read what the *pinned* document declares.
  // On a host without workflow support the first thing a caller would otherwise
  // see is whatever Git said about their directory, which is not the reason the
  // command is not going to run. Help is exempt: the grammar is the same
  // everywhere, and describing it costs nothing.
  let workflowHost: WorkflowHost | undefined;
  if (!helpRequest.requested && namesWorkflow(helpRequest.args)) {
    try {
      workflowHost = yield* installWorkflowHost();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      yield* exit(1);
      return;
    }
  }
  // Recognized before anything reads a document: a malformed duration is a
  // grammar failure, and a grammar failure never depends on what is on disk.
  // Help, `--version`, and the commands that execute nothing stay outside a run
  // lifecycle, which is why the timeout options are read only for the two that
  // end in one.
  const provisional = xmd.parse({ args: helpRequest.args });
  const selected = provisional.ok ? provisional.value.config : undefined;
  // The two commands a `--timeout` bounds. `xmd plan`'s deadline encloses
  // something different from a run's — the symbols, the assistant session,
  // every repair, the human review, provider teardown, final validation and the
  // artifact — and covers no later program, because it starts none.
  const planning = selected !== undefined && !selected.help && selected.name === "plan";
  const bounded =
    !helpRequest.requested &&
    selected !== undefined &&
    !selected.help &&
    (selected.name === "run" || planning);

  if (!bounded) {
    return yield* dispatch(
      evalFlags,
      helpRequest,
      installService,
      upgrade,
      installRepositories,
      readStandardInput,
      workflowHost,
      sessions,
    );
  }

  const timeouts = planning
    ? resolvePlanTimeout(evalFlags.rest)
    : resolveRunTimeouts(evalFlags.rest);
  if ("error" in timeouts) {
    console.error(timeouts.error);
    yield* exit(1);
    return;
  }

  yield* underRunDeadline(timeouts, () =>
    dispatch(
      evalFlags,
      helpRequest,
      installService,
      upgrade,
      installRepositories,
      readStandardInput,
      workflowHost,
      sessions,
    ),
  );
}
