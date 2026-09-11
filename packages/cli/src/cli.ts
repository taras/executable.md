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
import type { ValueSource } from "configliere";
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
} from "./cli-route.ts";
import type { AnyXmdIntent, ParseOutcome } from "./cli-route.ts";
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
import { installRunAgentStack, resolveAgentStack, resolvePlanWriterStack } from "./agent-stack.ts";
import { planComponentDeclaration } from "./plan-component.ts";
import { planAgentContext } from "./plan-writer-profile.ts";
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
import { ordinaryEvaluationProfile, statesEvaluation } from "./evaluation-profile.ts";
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
} from "./workflow.ts";
import type { HostWorkflowInstaller, WorkflowHost, WorkflowStart } from "./workflow.ts";
import { runWorkflowManagement } from "./workflow-management.ts";
import { establishDefinition } from "./workflow-definition.ts";
import type { EstablishedDefinition } from "./workflow-definition.ts";
import { useCompositionComponents, useWorkflowServiceDenial } from "@executablemd/workflow";

const SECRET_DETECTION_OPTION = "--secret-detection";
const NEGATED_SECRET_DETECTION = "--no-secret-detection";

/** Written once per invocation when the host turned detection off. */
const SECRET_DETECTION_WARNING =
  "WARNING: secret detection is disabled; credentials may be persisted.";

/** The version this build reports, from the manifest it was built with. */
export { XMD_VERSION } from "./cli-route.ts";

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
  planWriterRoot?: string;
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
  // it settled, the Plan writer root it owns and the scope its host acts run in;
  // everything else about the Component is this entrypoint's and identical for
  // all of them.
  const planDeclaration = (request: ChildPlanDeclaration): Operation<DeclaredMarkdownComponent> =>
    planComponentDeclaration({
      surface: "component",
      includes: include,
      context: request.context,
      ...(mode.machineSessions === undefined ? {} : { sessions: mode.machineSessions }),
      ...(request.planWriterRoot !== undefined
        ? { planWriterRoot: request.planWriterRoot }
        : mode.planWriterRoot === undefined
          ? {}
          : { planWriterRoot: mode.planWriterRoot }),
      // Captured before the document exists, so the two acts that are this
      // host's — putting this build's adapter on disk, and opening the review
      // form — run outside the frame the Component installs around itself.
      host: request.host,
      ...(request.observePlanWriter === undefined
        ? {}
        : { observePlanWriter: request.observePlanWriter }),
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
        // The ceiling a generated fragment runs under, stated only where the
        // host that attached this execution stated none: a workflow attachment
        // states its own Workspace-bound profile, and one execution offers one
        // maximum authority.
        ...(statesEvaluation(mode.installations)
          ? {}
          : { evaluation: ordinaryEvaluationProfile() }),
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
  //
  // Through delivery rather than a bare `write`: a pipe accepts the text
  // asynchronously, so a run that handed over more than the pipe holds and then
  // exited would lose everything past that — silently, and with a successful
  // status. This is the same lifetime defect `xmd syntax` was given delivery
  // for (#715); the output of a run reaches a pipe buffer just as readily.
  let delivered: Result<void> = Ok(undefined);
  if (!valueRoot && !discarded && !process.stdout.isTTY) {
    delivered = yield* deliverWhole(fullOutput, process.stdout);
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

  // A document that failed says more about the run than the sink that would not
  // take its output, so the delivery verdict is read only once the run itself
  // has succeeded — and a sink that refused fails the command rather than
  // letting a partial document pass for a whole one.
  if (!delivered.ok) {
    return delivered;
  }

  // Written straight to stdout, so the result never passes through markdown
  // normalization or terminal formatting.
  if (valueRoot) {
    return yield* deliverWhole(`${JSON.stringify(result.value)}\n`, process.stdout);
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
  /**
   * What the caller wrote, rather than what the model resolved to. The model
   * cannot say whether `--pattern` was written at all — its default is a real
   * value — and the scan that lifted the occurrences out of argv can.
   */
  patterns: PatternFlags,
  installService: HostServiceInstaller,
  /** What a `<Execution host="run">` child installs. This command installs none. */
  installRepositories: RepositoryInstaller,
): Operation<void> {
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
 *
 * Retained under the route API rather than retired to it. Configliere lifts
 * both controls itself and settles a method from them, but a help intent
 * carries no model, and every document-aware page is built from the document
 * the command line named. So the controls are removed here for the parse that
 * produces a model, and reinstated for the parse that produces the intent.
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
 * Read one repeatable option out of argv, and remove every occurrence.
 *
 * The route grammar cannot express a repeatable option at all: a reader
 * settles its parameter on the first occurrence, and the binding loop
 * truncates its view at the first unclaimed word, so an occurrence written
 * after a value is invisible to it and then reported as an unexpected token.
 * The occurrences are therefore lifted here and handed back to the parse as a
 * route value source, which is the one channel that carries a list.
 *
 * The scan also answers what a resolved model cannot. It says whether the
 * option was written at all — a default is a real value, indistinguishable
 * from a typed one — and it refuses unusable input: a separated value that
 * begins with `-` is another option rather than a value, and
 * `--option=<value>` expresses a value that really does begin with one.
 */
function readRepeatedOption(args: readonly string[], option: string): RepeatedOption {
  const values: string[] = [];
  const rest: string[] = [];
  let missingValue = false;
  let separated = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      separated = true;
      rest.push(...args.slice(index));
      break;
    }
    if (!separated && arg === option) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        missingValue = true;
        continue;
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (!separated && arg.startsWith(`${option}=`)) {
      values.push(arg.slice(option.length + 1));
      continue;
    }
    rest.push(arg);
  }

  return { values, rest, missingValue };
}

/** Every occurrence of one repeatable option, and the argv without them. */
interface RepeatedOption extends PatternFlags {
  /** argv with every occurrence of the option removed. */
  rest: string[];
}

const INCLUDE_OPTION = "--include";

/**
 * The refusal a command owns for an option that belongs to another one.
 *
 * Each of these names the command, the option and where the option does
 * belong, which is more than "unexpected token" says. They are read from raw
 * argv, so they answer before a parse does and stay the invocation's first
 * failure whether or not the route grammar also refused the token.
 */
function strayCommandOption(command: string, args: string[]): string | undefined {
  if (command === "test") {
    const strayTimeout = findTimeoutFlag(args);
    if (strayTimeout) {
      return `unrecognized option for xmd test: ${strayTimeout} — timeout options are exclusive ` +
        `to ${belongsTo(strayTimeout)}`;
    }
  }
  const agentFlag = findAgentOnlyFlag(args);
  if (agentFlag) {
    return `unrecognized option for xmd ${command}: ${agentFlag} — agent options are exclusive ` +
      `to ${belongsTo(agentFlag)}`;
  }
  if (command === "test") {
    const propsFlag = findPropsFlag(args);
    if (propsFlag) {
      return `unrecognized option for xmd test: ${propsFlag} — document properties are ` +
        "exclusive to xmd run";
    }
  }
  return undefined;
}

/** What a run says when the command line named no root document. */
const MISSING_ROOT_DOCUMENT =
  "xmd run requires a root document — `xmd run <document.md>`, `xmd run -`, or " +
  `\`xmd run ${EVAL_OPTION} '<markdown>'\``;

/**
 * The command line up to its first document property.
 *
 * A document's generated options exist only once the document does, and the
 * document is what this parse is being asked to find. The released parser
 * stopped at the first token it did not define, which is exactly the first
 * `--props` occurrence; the tokens after it are read later, by
 * `extractPropsArgs`, against the bindings the inspected document declares.
 * A `--props` written after `--` is a literal and stops nothing.
 */
function beforeProperties(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (const arg of args) {
    if (arg === "--") {
      kept.push(...args.slice(kept.length));
      break;
    }
    if (arg === AGGREGATE_OPTION || arg.startsWith(`${AGGREGATE_OPTION}`)) {
      break;
    }
    kept.push(arg);
  }
  return kept;
}

/** Everything one command line carries that the route grammar cannot bind. */
interface LiftedArgs {
  /** argv with every lifted token removed, ready to parse. */
  args: string[];
  /**
   * argv with the root references removed and nothing else.
   *
   * What the document phase reads. Truncating at the first property and
   * lifting the repeatable options serve the parse alone: the properties are
   * classified later against the bindings the document declares, and the
   * repeatable occurrences are read by their own scanner.
   */
  retained: string[];
  /** Every root document reference the option grammar leaves unwritable. */
  references: string[];
  include: RepeatedOption;
  pattern: RepeatedOption;
  /** Whether the caller wrote a version control anywhere in argv. */
  version: boolean;
}

const VERSION_CONTROLS = new Set(["-v", "--version"]);

/**
 * Lift what the route grammar cannot bind, and say what was lifted.
 *
 * `--pattern` belongs to `xmd test` alone, so it is lifted only there; on any
 * other command it stays in argv and is reported as the unrecognized option it
 * is. The version control is lifted everywhere, because the parse this
 * produces is the one that has to yield a model.
 */
function liftArgs(args: string[]): LiftedArgs {
  const command = commandToken(args);
  const version = args.some((arg) => VERSION_CONTROLS.has(arg));
  const controlled = beforeProperties(args).filter((arg) => !VERSION_CONTROLS.has(arg));
  const include = readRepeatedOption(controlled, INCLUDE_OPTION);
  const pattern =
    command === "test"
      ? readRepeatedOption(include.rest, PATTERN_OPTION)
      : { values: [], rest: include.rest, missingValue: false };
  // Only a run names a root document, and only a run's grammar leaves `-`
  // unwritable. Every other command keeps the meaning it already gives the
  // token, which is what `xmd test -` relies on.
  const recover = command === undefined || command === "run";
  const recovered = readDocumentArguments(pattern.rest, recover);
  return {
    args: recovered.args,
    retained: readDocumentArguments(args, recover).args,
    references: recovered.references,
    include,
    pattern,
    version,
  };
}

/**
 * The intent the controls settle, when the caller wrote one.
 *
 * The same command line, parsed with the control reinstated, so Configliere
 * chooses the route the control applies to and refuses the route that does
 * not offer the method.
 */
function controlOutcome(help: boolean, lifted: LiftedArgs): ParseOutcome | undefined {
  const control = help ? "--help" : lifted.version ? "--version" : undefined;
  if (control === undefined) {
    return undefined;
  }
  // Written first, because `--` quotes everything after it: a control written
  // past the separator is a literal and is never lifted.
  return parseLifted({ ...lifted, args: [control, ...lifted.args] });
}

/** The value sources the lifted options supply to the route that owns them. */
function liftedValues(command: string | undefined, lifted: LiftedArgs): ValueSource[] {
  const supplied: Record<string, unknown> = {};
  if (lifted.include.values.length > 0) {
    supplied.include = lifted.include.values;
  }
  if (lifted.pattern.values.length > 0) {
    supplied.pattern = lifted.pattern.values;
  }
  return routeValues(command === undefined ? [] : [command], supplied);
}

/** Parse one lifted command line against the tree its first token selects. */
function parseLifted(lifted: LiftedArgs): ParseOutcome {
  const command = commandToken(lifted.args);
  const values = liftedValues(command, lifted);
  return command === undefined
    ? parseShorthand(lifted.args, values)
    : parseCommands(lifted.args, values);
}

/** The intent one parse settled on, when it settled on one. */
function settledIntent(outcome: ParseOutcome): AnyXmdIntent | undefined {
  return outcome.ok ? outcome : undefined;
}

/** The root document reference one execute intent bound, when it bound one. */
function boundPath(intent: AnyXmdIntent | undefined): string | undefined {
  if (intent === undefined || !isExecute(intent)) {
    return undefined;
  }
  if (intent.route === "/" || intent.route === "/run") {
    return intent.model.path;
  }
  return undefined;
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

/** A reference's path half: everything before its first raw `#`. */
function referencePath(reference: string): string {
  const fragment = reference.indexOf("#");
  return fragment === -1 ? reference : reference.slice(0, fragment);
}

interface RunGrammar {
  /** Every reference the route grammar could not take, in the order written. */
  references: string[];
  /** argv with all of them removed. */
  args: string[];
}

/**
 * Read every document argument a run named that the route grammar cannot take.
 *
 * Tokenization decides this, and it decides it before routing: a bare `-` is a
 * word an `argument()` can claim, `-#Section` is a flag no argument will ever
 * see, and every token after `--` is a literal that reaches the intent instead
 * of a parameter. All three spell the same thing here — the one filename the
 * option grammar leaves unwritable, optionally carrying a target selector — so
 * all three are lifted out of argv before the parse and reported together.
 *
 * A value another option took (`--journal -`) is not one, which is why the
 * scan skips each value-taking flag with its value. Nothing else beginning
 * with `-` is one either: a mistyped option stays an option, and a run written
 * with one refuses for want of a root rather than looking for a file named
 * after the flag.
 */
function readDocumentArguments(head: string[], recover: boolean): RunGrammar {
  const takesValue = valueFlags();
  const references: string[] = [];
  const args: string[] = [];
  let separated = false;

  for (let index = 0; index < head.length; index += 1) {
    const token = head[index];
    if (token === undefined) {
      continue;
    }
    if (!separated && token === "--") {
      const next = head[index + 1];
      if (recover && next !== undefined && referencePath(next) === STANDARD_INPUT_ARGUMENT) {
        references.push(next);
        index += 1;
        continue;
      }
      separated = true;
      args.push(token);
      continue;
    }
    if (!separated && takesValue.has(token)) {
      args.push(token);
      const value = head[index + 1];
      if (value !== undefined) {
        args.push(value);
        index += 1;
      }
      continue;
    }
    if (!separated && referencePath(token) === STANDARD_INPUT_ARGUMENT) {
      // A command that names no root document is not offered the token
      // either. The released parser refused every positional beginning with
      // `-`, so `xmd test -` searched for documents rather than opening a
      // file called `-`, and a bare `-` is a word this tokenizer would hand
      // straight to that command's own argument.
      if (recover) {
        references.push(token);
      }
      continue;
    }
    args.push(token);
  }

  return { references, args };
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

  // A `workflow` positional written after `--` reaches the intent as a
  // literal rather than as an argument, so the whole argv is offered to the
  // parse and the tail is read back from the intent. A run's roots are lifted
  // instead: every other command keeps whatever `-` already means to it.
  const workflow = namesWorkflow(args);
  const lifted = liftArgs(args);
  const fixed = lifted.retained;
  const parsed = lifted.retained;
  const outcome = parseLifted(lifted);
  const intent = settledIntent(outcome);
  const command = commandToken(args);
  const parsedPath = boundPath(intent);
  const roots = writtenRoots(args, lifted.references, parsedPath);
  // The sentinel is one exact argument on one command form. Only the form the
  // caller wrote separates `xmd run -` from the shorthand `xmd -`, which
  // resolves to the same route and names a file called `-`.
  const standardInput = namesRun(args) && lifted.references.includes(STANDARD_INPUT_ARGUMENT);
  const describeRoot = (root: string): string =>
    standardInput && root === STANDARD_INPUT_ARGUMENT ? "standard input" : root;
  const [supplied] = evalFlags.values;

  if (workflow) {
    return yield* prepareWorkflowProps(args, parsed, workflowRequestOf(intent, args), supplied);
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

/** Everything one `xmd workflow` invocation asks for, by the action it names. */
interface WorkflowConfig {
  action?: string;
  target?: string;
  argument?: string;
  value?: string;
  id?: string;
  at?: string;
  verbose: boolean;
  raw: boolean;
  secretDetection: boolean;
  json: boolean;
  forkable: boolean;
  status?: string;
  artifact?: string;
  output?: string;
}

/** What an invocation that named no action at all asks for. */
const NO_WORKFLOW_ACTION: WorkflowConfig = {
  verbose: false,
  raw: false,
  secretDetection: true,
  json: false,
  forkable: false,
};

/**
 * The action, its positionals and its options, read from the intent.
 *
 * Every action is its own route, so each model holds only what that action
 * accepts and the action itself is the route rather than a field. A positional
 * written after `--` reaches the intent as a literal instead of an argument;
 * the literals fill the remaining positional slots in the order they were
 * written, because after the separator a token is positional by position
 * rather than by spelling.
 */
function workflowRequestOf(
  intent: AnyXmdIntent | undefined,
  args: readonly string[],
): WorkflowConfig {
  if (intent === undefined || !isExecute(intent)) {
    return { ...NO_WORKFLOW_ACTION, action: workflowActionOf(args) };
  }
  const literals = [...intent.literals].map((token) => token.text);

  switch (intent.route) {
    case "/workflow/start":
      return positioned(
        {
          ...NO_WORKFLOW_ACTION,
          action: "start",
          target: intent.model.target,
          id: intent.model.id,
          verbose: intent.model.verbose,
          raw: intent.model.raw,
          secretDetection: intent.model.secretDetection,
        },
        literals,
      );
    case "/workflow/resume":
      return positioned(
        {
          ...NO_WORKFLOW_ACTION,
          action: "resume",
          target: intent.model.target,
          verbose: intent.model.verbose,
          raw: intent.model.raw,
          secretDetection: intent.model.secretDetection,
        },
        literals,
      );
    case "/workflow/fork":
      return positioned(
        {
          ...NO_WORKFLOW_ACTION,
          action: "fork",
          target: intent.model.target,
          argument: intent.model.argument,
          id: intent.model.id,
          at: intent.model.at,
          verbose: intent.model.verbose,
          raw: intent.model.raw,
          secretDetection: intent.model.secretDetection,
        },
        literals,
      );
    case "/workflow/answer":
      return positioned(
        {
          ...NO_WORKFLOW_ACTION,
          action: "answer",
          target: intent.model.target,
          argument: intent.model.argument,
          value: intent.model.value,
          secretDetection: intent.model.secretDetection,
        },
        literals,
      );
    case "/workflow/status":
      return positioned(
        {
          ...NO_WORKFLOW_ACTION,
          action: "status",
          target: intent.model.target,
          json: intent.model.json,
          artifact: intent.model.artifact,
        },
        literals,
      );
    case "/workflow/list":
      return positioned(
        {
          ...NO_WORKFLOW_ACTION,
          action: "list",
          json: intent.model.json,
          status: intent.model.status,
        },
        literals,
      );
    case "/workflow/history":
      return positioned(
        {
          ...NO_WORKFLOW_ACTION,
          action: "history",
          target: intent.model.target,
          json: intent.model.json,
          forkable: intent.model.forkable,
          artifact: intent.model.artifact,
        },
        literals,
      );
    case "/workflow/cancel":
      return positioned(
        { ...NO_WORKFLOW_ACTION, action: "cancel", target: intent.model.target },
        literals,
      );
    case "/workflow/delete":
      return positioned(
        { ...NO_WORKFLOW_ACTION, action: "delete", target: intent.model.target },
        literals,
      );
    case "/workflow/export":
      return positioned(
        {
          ...NO_WORKFLOW_ACTION,
          action: "export",
          target: intent.model.target,
          output: intent.model.output,
        },
        literals,
      );
    default:
      return { ...NO_WORKFLOW_ACTION, action: workflowActionOf(args) };
  }
}

/**
 * The subcommand token one `xmd workflow` invocation wrote.
 *
 * Read from argv rather than from the intent, because the intent may not
 * exist: a fourth positional or an unknown action is a parse failure, and
 * both of those are refusals this command words itself. An action that names
 * no route still has to be named back to the caller.
 */
function workflowActionOf(args: readonly string[]): string | undefined {
  const takesValue = valueFlags();
  const start = args.indexOf("workflow");
  if (start === -1) {
    return undefined;
  }
  for (let index = start + 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || token === "--") {
      continue;
    }
    if (takesValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      continue;
    }
    return token;
  }
  return undefined;
}

/** The positional slots an action leaves open, filled from the literals. */
function positioned(config: WorkflowConfig, literals: readonly string[]): WorkflowConfig {
  const written = [config.target, config.argument, config.value].filter(
    (slot) => slot !== undefined,
  );
  const [target, argument, value] = [...written, ...literals];
  return { ...config, target, argument, value };
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
function renderHelp(phase: PropsPhase, intent: AnyXmdIntent | undefined): string {
  // The help intent names the deepest route the caller selected, which is the
  // definition to describe. A shorthand run selects the root, and the root is
  // the program page unless a document was named — in which case the page is
  // the named `run` command's, exactly as it has always been.
  const selected = intent !== undefined && isHelp(intent) ? [...intent.path] : [];
  const path = selected.length > 0 ? selected : phase.root ? ["run"] : [];

  if (path.length === 0) {
    return renderProgramHelp();
  }

  const definition = routeFor(path);
  const base = definition === undefined ? renderProgramHelp() : renderRouteHelp(definition, path);
  const [command] = path;
  const epilogue =
    path.length > 1
      ? ""
      : command === "run"
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
  helpRequest: HelpRequest,
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

  // The second parse of this invocation, and the checkpoint gap is why there
  // is one. The first ran in the props phase to find the document; this one
  // runs against the argv that phase stripped of the options that document
  // declares. `checkpoint()` can only add values to parameters that already
  // exist, so a document's generated options cannot be introduced by a
  // dynamic phase and the argv has to be prepared before parsing. This is not
  // a checkpoint migration.
  //
  // Two parses of the same command line, and they answer different questions.
  // The control parse keeps `-h` and `--version` in argv, so Configliere
  // settles the method and the route it applies to. The model parse has them
  // removed, because a help or version intent carries no model and every
  // document-aware page needs the document the command line named.
  const lifted = liftArgs(propsPhase.args);
  const settled = parseLifted(lifted);
  const controls = controlOutcome(helpRequest.requested, lifted);
  const intent = settledIntent(controls ?? settled);

  if (helpRequest.requested) {
    console.log(renderHelp(propsPhase, intent));
    yield* exit(0);
    return;
  }

  // A root version request writes the bare version. Every other route answers
  // it the way it always has: `--version` is an option that route does not
  // define, and its own grammar reports it.
  if (lifted.version && intent !== undefined && isVersion(intent) && intent.route === "/") {
    console.log(renderVersion(intent));
    yield* exit(0);
    return;
  }

  // Before the parse is answered, because the `=` spelling reaches the toggle
  // as a setter it does not read and is then reported as an unexpected token.
  // The safety message is the one a caller who wrote it needs.
  const secretDetectionError = secretDetectionGrammarError(evalFlags.rest);
  if (secretDetectionError) {
    console.error(secretDetectionError);
    yield* exit(1);
    return;
  }

  if (!settled.ok) {
    // The released parser stopped at the first token it did not define and
    // refused none of them, so a run written with a mistyped option refused
    // for want of a root. That refusal is the accepted message, and the stock
    // diagnostic does not replace it.
    const runForm =
      commandToken(propsPhase.args) === undefined || commandToken(propsPhase.args) === "run";
    if (runForm && propsPhase.root === undefined && unexpectedOnly(settled)) {
      console.error(MISSING_ROOT_DOCUMENT);
      yield* exit(1);
      return;
    }
    // An option that belongs to another command is refused by name, because
    // the command knows where it does belong and the route layer only knows
    // that it did not expect it.
    const command = commandToken(propsPhase.args);
    const stray = command === undefined ? undefined : strayCommandOption(command, evalFlags.rest);
    if (stray !== undefined) {
      console.error(stray);
      yield* exit(1);
      return;
    }
    // `xmd upgrade` reads its own fixed grammar, and it enumerates what the
    // command accepts. That sentence is the one a caller needs, and it is
    // written before the packaged policy exists.
    if (command === "upgrade") {
      const scan = scanUpgradeArgs(helpRequest.args);
      if (scan.error !== undefined) {
        console.error(scan.error);
        yield* exit(1);
        return;
      }
    }
    // `xmd workflow` names its own refusals — a missing subcommand, one it
    // does not define, an option belonging to another action. The route layer
    // reports that the address supports no execution, which is true and is
    // not what a caller who wrote `xmd workflow` needs to read.
    if (namesWorkflow(propsPhase.args)) {
      const refused = parseWorkflowRequest(
        { ...workflowRequestOf(undefined, propsPhase.args), ...propsPhase.workflow },
        evalFlags.rest,
      );
      if (!refused.ok) {
        console.error(refused.error.message);
        yield* exit(1);
        return;
      }
    }
    console.error(parseFailure(settled).message);
    yield* exit(1);
    return;
  }

  const command = settled;
  if (!isExecute(command)) {
    console.error(`xmd does not support ${command.method}`);
    yield* exit(1);
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

  switch (command.route) {
    case "/":
    case "/run": {
      const config = command.model;
      // Reported here rather than in the props phase: `xmd run --help` and
      // `xmd --help` describe the command without one, and they are handled
      // above.
      if (!propsPhase.root) {
        console.error(MISSING_ROOT_DOCUMENT);
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
    case "/plan": {
      const config = command.model;
      const scan = propsPhase.plan;
      if (scan?.request === undefined) {
        console.error('xmd plan names the command first — write `xmd plan "<request>" [options]`');
        yield* exit(1);
        break;
      }
      // Who writes, and nothing else. There is no permission mode to settle:
      // this command starts no program, and the ceiling authorship runs under
      // is the host's rather than the command line's.
      const planWriter = yield* resolvePlanWriterStack(
        { agentProvider: config.agentProvider, defaultAgent: config.defaultAgent },
        sessions,
      );
      if (!planWriter.ok) {
        console.error(planWriter.error.message);
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
          stack: planWriter.value,
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
          // And the other one: the approved program's own destination, stated
          // here so nothing downstream has to find a stream for it.
          deliver: (approved) => deliverWhole(approved, process.stdout),
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
    case "/upgrade": {
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
        // One call, one pipe, the same lifetime defect as every other whole
        // result this CLI hands over (#715): the report is collected precisely
        // because nothing is watching it arrive.
        const written = yield* deliverWhole(piped.join(""), process.stdout);
        if (!written.ok) {
          console.error(
            `xmd upgrade: stdout did not accept the whole report: ${describeError(written.error)}`,
          );
          yield* exit(1);
          break;
        }
      }
      if (!upgraded.ok) {
        reportFailure(upgraded.error);
        yield* exit(1);
      }
      break;
    }
    case "/test": {
      const stray = strayCommandOption("test", evalFlags.rest);
      if (stray !== undefined) {
        console.error(stray);
        yield* exit(1);
        break;
      }
      yield* test(
        { ...command.model, retainProcessOutput: keepsProcessOutput(command.model.journal) },
        lifted.pattern,
        installService,
        installRepositories,
      );
      break;
    }
    case "/syntax": {
      // One inspection per invocation, then one complete document. A failure
      // writes nothing to stdout: a healthy subset printed as though it were
      // the whole set of symbols would read as complete.
      let rendered: string;
      try {
        const named = command.model.component;
        if (named === undefined) {
          // The compact list of symbols, unchanged: routine discovery output and
          // every default Plan prompt read it, and long documentation would make
          // both unnecessarily large.
          const catalog = yield* syntaxSymbols(command.model.include);
          rendered = command.model.json ? renderSyntaxJson(catalog) : renderSyntaxMarkdown(catalog);
        } else {
          // The same selection, index and renderer `<Syntax names={…}>` uses, so
          // the command and the component cannot describe one component two
          // ways. JSON stays the compact projection; it is the symbols' shape,
          // and documentation is prose rather than a symbol member.
          rendered = yield* renderSyntaxDocumentation(command.model.include, [named]);
        }
      } catch (error) {
        console.error(describeError(error));
        yield* exit(1);
        break;
      }
      // Delivery, like every other whole result this CLI writes in one call:
      // the catalog was simply the first one observed past a pipe buffer.
      const written = yield* deliverWhole(rendered, process.stdout);
      if (!written.ok) {
        console.error(
          `xmd syntax: stdout did not accept the whole output: ${describeError(written.error)}`,
        );
        yield* exit(1);
      }
      break;
    }
    case "/test-agent":
      yield* runTestAgentWorker({ connect: command.model.connect });
      break;
    case "/workflow/start":
    case "/workflow/resume":
    case "/workflow/fork":
    case "/workflow/answer":
    case "/workflow/status":
    case "/workflow/list":
    case "/workflow/history":
    case "/workflow/cancel":
    case "/workflow/delete":
    case "/workflow/export": {
      // Every action is its own route, so the model is that action's alone and
      // the action itself is the route. The positionals the props phase
      // established stay authoritative: they were read from the argv that
      // still had its separator.
      const config = { ...workflowRequestOf(command, propsPhase.args), ...propsPhase.workflow };
      const stray = strayCommandOption("workflow", evalFlags.rest);
      if (stray !== undefined) {
        console.error(stray);
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
  const provisional = settledIntent(parseLifted(liftArgs(helpRequest.args)));
  const selected =
    provisional !== undefined && isExecute(provisional) ? provisional.route : undefined;
  // The two commands a `--timeout` bounds. `xmd plan`'s deadline encloses
  // something different from a run's — the symbols, the assistant session,
  // every repair, the human review, provider teardown, final validation and the
  // artifact — and covers no later program, because it starts none.
  const planning = selected === "/plan";
  const bounded = !helpRequest.requested && (selected === "/" || selected === "/run" || planning);

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
