/**
 * CLI — run an executable markdown document.
 *
 * Usage:
 *   xmd run <document-reference> [options]
 *   xmd <document-reference> [options]   (run is the default command)
 *   xmd workflow start <document.md> [options]
 *   xmd workflow resume <run-id>
 *   xmd workflow status|history <run-id> [--json]
 *   xmd workflow list [--status=<status>] [--json]
 *
 * A document reference is a path, optionally followed by `#` and one target
 * selector naming a section of the document (spec §5.4). `workflow start` takes
 * a plain path: a definition descriptor cannot record a target yet.
 *
 * Examples:
 *   xmd run packages/core/examples/hello-world.md
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
  installAgentComponents,
  installPermissionMode,
  registerAgentProvider,
  retainedSource,
  rootSourcePath,
  useNormalizedOutput,
  useTerminalOutput,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type {
  AgentProviderFactory,
  DocumentTargetInfo,
  FileRootDocument,
  PropsSchema,
  RootDocumentSource,
} from "@executablemd/core";
import { env as readEnv } from "@executablemd/runtime";
import { createAcpxProvider, DEFAULT_AGENT_NAME } from "@executablemd/acp";
import type { AgentSessionCoordinator } from "@executablemd/runtime";
import type { AgentSessionRouteStore } from "@executablemd/acp";
import {
  installTestingComponents,
  TestFailureError,
  testHarnessInstallation,
  useTesting,
} from "@executablemd/testing";
import { installTestAgentComponents, runTestAgentWorker } from "@executablemd/test-agent";
import { installWebComponents, installWebElicitation } from "@executablemd/web";
import { timebox } from "@effectionx/timebox";
import { timeout as runTimeout } from "@executablemd/runtime";
import { installForegroundLauncher } from "@executablemd/runtime";
import { resolveAgentConfig } from "./agent-config.ts";
import { TIMEOUT_FLAGS, resolveRunTimeouts } from "./timeouts.ts";
import type { RunTimeouts } from "./timeouts.ts";
import type { AgentFlags } from "./agent-config.ts";
import { FileStream } from "./file-stream.ts";
import {
  AGGREGATE_ENV,
  AGGREGATE_OPTION,
  buildBindings,
  declaredProperties,
  describeError,
  extractPropsArgs,
  formatProperties,
  resolveProps,
} from "./props.ts";
import type { Binding, Extraction } from "./props.ts";
import { componentSearchPath, resolveTestTarget } from "./test-target.ts";
import { testingExecutionHost } from "./testing-host.ts";
import { EVAL_ALIAS, EVAL_OPTION, evalGrammarError, readEvalFlags } from "./eval-source.ts";
import type { EvalFlags } from "./eval-source.ts";
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
import { useWorkflowServiceDenial } from "@executablemd/workflow";
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

const runConfig = object({
  path: {
    description: "markdown document to execute, optionally `#` and one target selector",
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
  componentDir: {
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
  componentDir: {
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

const testAgentConfig = object({
  connect: {
    description: "opaque controller route (controller-launched workers only)",
    ...field(z.string()),
  },
});

const xmd = program({
  name: "xmd",
  version: denoJson.version,
  config: commands(
    {
      run: runConfig,
      test: testConfig,
      "test-agent": testAgentConfig,
      workflow: workflowConfig,
    },
    { default: "run" },
  ),
});

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

/** The timeout options, like the agent options, belong to `xmd run` alone. */
function findTimeoutFlag(args: string[]): string | undefined {
  return args.find((arg) =>
    TIMEOUT_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
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
 * Install the agent stack for `xmd run`: permission mode, the ACPX
 * registration, and the components with the resolved root provider. Invalid flags and an unknown --agent-provider fail here
 * — before any document executes. Nothing starts an agent: the provider
 * validates availability on first use.
 */
function* installAgentStack(
  flags: AgentFlags,
  coordinator: AgentSessionCoordinator | undefined,
  routeStore?: AgentSessionRouteStore,
): Operation<void> {
  const config = resolveAgentConfig(flags);
  if ("error" in config) {
    console.error(config.error);
    yield* exit(1);
    return;
  }

  // The coordinator this host built, if it built one. It reaches the provider
  // directly rather than through a context: who owns a session is a security
  // decision, and one a document could replace is not one.
  // A host that answers who owns a session also answers how it was
  // constructed, from the same trusted root — an agent that names its own
  // sessions needs both, and refuses unless it has both.
  const acpx = createAcpxProvider(
    coordinator === undefined ? undefined : { coordinator, ...(routeStore ? { routeStore } : {}) },
  );
  yield* registerAgentProvider("acpx", acpx);
  const defaultAgent =
    config.defaultAgent ?? (yield* readEnv("DEFAULT_AGENT_NAME")) ?? DEFAULT_AGENT_NAME;

  // The trusted host selects its own root provider by name. Document-level
  // selection goes through the installation protocol; this is the host saying
  // what it configured, which no document is composing around.
  const providers: Record<string, AgentProviderFactory> = { acpx };
  const factory = Object.hasOwn(providers, flags.agentProvider)
    ? providers[flags.agentProvider]
    : undefined;
  if (!factory) {
    console.error(`Unknown agent provider "${flags.agentProvider}"`);
    yield* exit(1);
    return;
  }

  const permissionMode = config.permissionMode;
  yield* installAgentComponents({
    defaultAgent,
    permissionMode,
    rootProvider: { factory, options: { defaultAgent, permissionMode } },
  });
  yield* installPermissionMode(permissionMode);
  // `xmd run` is the one command that has a terminal to give away. Help,
  // document inspection and `xmd test` install no launcher, so a document that
  // reaches <Session.Launch> under any of them refuses instead of spawning.
  yield* installForegroundLauncher();
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
  componentDir: string[];
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
  agent?: AgentFlags;
  /**
   * Who owns an agent session on this host, when this host can say.
   *
   * Carried on the mode because the mode is what a trusted host states about
   * one run — and delivered from here straight into the provider's
   * dependencies. It is deliberately not contextual: ownership is a security
   * decision, and one a document could replace is not one.
   */
  sessionCoordinator?: AgentSessionCoordinator;
  /** Where this host keeps construction routes, from the same trusted root. */
  sessionRouteStore?: AgentSessionRouteStore;
  props?: Record<string, Json>;
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
    yield* installTestingComponents({ verbose });
  }

  // `<WebForm>` for both commands. Registered rather than reserved, so a
  // repository's own WebForm.md or WebForm.ts still wins.
  yield* installWebComponents();

  // `<Elicit>` reaches a person through the same form — but only for `xmd run`.
  // Under `xmd test` a document that elicits without supplying an answer would
  // open a browser and wait for somebody who is not coming, which is a hang
  // rather than a test result. Leaving the provider out makes that document
  // fail immediately with "no elicitation provider configured", and an
  // `<Answers>` region stays the way a test says what the answer is.
  if (!mode.testing) {
    yield* installWebElicitation();
  }

  // Agent flags are exclusive to `xmd run` — `xmd test` drives agents
  // through the deterministic TestAgent stack instead.
  if (mode.agent) {
    yield* installAgentStack(mode.agent, mode.sessionCoordinator, mode.sessionRouteStore);
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
): Operation<Result<void>> {
  const { root, componentDir, verbose, journal, raw, secretDetection, retainProcessOutput } =
    config;

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

  // What a `<Test>` in this document runs a nested execution under. Captured
  // before document code begins, so a child is offered exactly what this
  // command assembled — and never a second description of it.
  const testingHost = testingExecutionHost({
    componentDirs: componentDir,
    secretDetection,
    installService,
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
      componentDirs: componentDir,
      secretDetection,
      // Whatever the host path decided. A run that keeps nothing forwards its
      // commands' output to the reader and accumulates none of it.
      retainProcessOutput,
    },
    // The harness installer is this command's, not the document's: canonical
    // `<Test>` hands each invocation's authority to whoever the host attached,
    // and this is where `xmd` says that is the testing package.
    [...(mode.installations ?? []), testHarnessInstallation(testingHost)],
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
): Operation<Result<void>> {
  try {
    return yield* scoped(() => runDocument(config, mode, installService));
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

/** Print a completed document's failure the way `xmd` has always printed it. */
function reportFailure(error: Error, prefix?: string): void {
  const label = prefix === undefined ? "" : `${prefix}: `;
  if (error instanceof TestFailureError) {
    console.error(`\n${label}tests failed: ${error.message}`);
    return;
  }
  console.error(`${label}${error.message}`);
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
        componentDir: componentSearchPath(document, target.root, config.componentDir),
      },
      { testing: true },
      installService,
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

/**
 * Locate the root document, read what it declares, and lift its generated
 * options out of argv. A provisional parse finds the path: it stops at
 * the first token it does not define, which is exactly where
 * document-derived options begin. The inline document was already lifted out
 * of argv, so it needs no parse at all.
 */
function* preparePropsPhase(args: string[], evalFlags: EvalFlags): Operation<PropsPhase> {
  // `xmd workflow` reads its options from the head and its remaining positionals
  // from the tail. The parser only ever sees the head, so a dash-leading token
  // after `--` is never offered to it as an option; the grammar check below
  // still sees the argv that had the separator, because where options stopped
  // is what decides whether a later token is a third positional.
  const workflow = namesWorkflow(args);
  const separated = separateArgs(args);
  const parsed = workflow ? separated.head : args;
  const provisional = xmd.parse({ args: parsed });
  // `program` short-circuits on `--version` and leaves no configuration
  // behind, so there is nothing to inspect.
  const selected = provisional.ok ? provisional.value.config : undefined;
  const command = selected && !selected.help ? selected.name : undefined;
  const documentPath =
    selected && !selected.help && selected.name === "run" ? selected.config.path : undefined;
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
      args,
      bindings: [],
      error: `unrecognized option for xmd ${command}: ${EVAL_OPTION} — inline documents are exclusive to xmd run`,
    };
  }

  if (supplied !== undefined && typeof documentPath === "string") {
    return {
      args,
      bindings: [],
      error:
        `${documentPath} and ${EVAL_OPTION} both supply a root document — a run takes exactly one, ` +
        `either \`xmd run ${documentPath}\` or \`xmd run ${EVAL_ALIAS} '<markdown>'\``,
    };
  }

  // A file path is a document reference: the first raw `#` starts a target
  // selector. An inline document addresses nothing, so it is read as it is.
  let root: RootDocumentSource | undefined;
  if (supplied !== undefined) {
    root = inlineSource(supplied);
  } else if (typeof documentPath === "string") {
    const reference = readReference(documentPath);
    if (!reference.ok) {
      return { args, bindings: [], error: describeError(reference.error) };
    }
    root = reference.value;
  }

  if (!root) {
    const stray = findPropsFlag(args);
    if (stray && command && command !== "run") {
      return {
        args,
        bindings: [],
        error: `unrecognized option for xmd ${command}: ${stray} — document properties are exclusive to xmd run`,
      };
    }
    if (stray) {
      return {
        args,
        bindings: [],
        error: `unrecognized option: ${stray} — document properties follow the document, as in \`xmd run <document> ${stray} …\``,
      };
    }
    return { args, bindings: [] };
  }

  try {
    const document = yield* inspectDocument(root);
    const bindings = buildBindings(document.props);
    const extraction = extractPropsArgs(args, bindings);
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
      args,
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

const COMMAND_NAMES = ["run", "test", "test-agent", "workflow"];

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
  `Exactly one root document is required: a path, or one ${EVAL_OPTION} value.`,
  "Quote the document so the shell passes it as a single argument:",
  `  xmd ${EVAL_ALIAS} '# Hello'`,
  "",
  "A path is a document reference, and everything after its first `#` selects",
  "one section of the document to run:",
  "  xmd run README.md#Release/Publish",
  "  xmd README.md#Release/*",
  "",
  REFERENCE_GRAMMAR_HELP,
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
  const epilogue = command === "run" ? RUN_SOURCE_HELP : "";
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
    const individualEnv: { binding: Binding; value: string }[] = [];
    for (const binding of phase.bindings) {
      const value = yield* readEnv(binding.env);
      if (value !== undefined) {
        individualEnv.push({ binding, value });
      }
    }
    const aggregateEnv = yield* readEnv(AGGREGATE_ENV);

    return {
      value: resolveProps({
        propsSchema: phase.propsSchema,
        bindings: phase.bindings,
        individual: phase.extraction.individual,
        aggregateCli: phase.extraction.aggregate,
        aggregateEnv,
        individualEnv,
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
  workflowHost: WorkflowHost | undefined,
  coordinator: AgentSessionCoordinator | undefined,
  session: { routeStore?: AgentSessionRouteStore } = {},
): Operation<void> {
  const propsPhase = yield* preparePropsPhase(helpRequest.args, evalFlags);

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
          `xmd run requires a document path or an inline document — ` +
            `\`xmd run <document.md>\` or \`xmd run ${EVAL_ALIAS} '<markdown>'\``,
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
      announceSecretDetection(config.secretDetection);
      const result = yield* runScopedDocument(
        { ...config, root, retainProcessOutput: keepsProcessOutput(config.journal) },
        {
          testing: false,
          props: props.value,
          ...(coordinator === undefined ? {} : { sessionCoordinator: coordinator }),
          ...(session.routeStore ? { sessionRouteStore: session.routeStore } : {}),
          agent: {
            agentProvider: config.agentProvider,
            defaultAgent: config.defaultAgent,
            approveAll: config.approveAll,
            approveReads: config.approveReads,
            denyAll: config.denyAll,
          },
        },
        installService,
      );
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
    case "test": {
      const strayTimeout = findTimeoutFlag(evalFlags.rest);
      if (strayTimeout) {
        console.error(
          `unrecognized option for xmd test: ${strayTimeout} — timeout options are exclusive to xmd run`,
        );
        yield* exit(1);
        break;
      }
      const agentFlag = findAgentOnlyFlag(evalFlags.rest);
      if (agentFlag) {
        console.error(
          `unrecognized option for xmd test: ${agentFlag} — agent options are exclusive to xmd run`,
        );
        yield* exit(1);
        break;
      }
      const propsFlag = findPropsFlag(evalFlags.rest);
      if (propsFlag) {
        console.error(
          `unrecognized option for xmd test: ${propsFlag} — document properties are exclusive to xmd run`,
        );
        yield* exit(1);
        break;
      }
      yield* test(
        { ...command.config, retainProcessOutput: keepsProcessOutput(command.config.journal) },
        evalFlags.rest,
        installService,
      );
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
          `unrecognized option for xmd workflow: ${agentFlag} — agent options are exclusive to xmd run`,
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
              componentDir: [],
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
            { testing: false, props: execution.props, installations: execution.installations },
            // The workflow authority boundary sits exactly where a host
            // service adapter would: installed inside the execution scope,
            // before the root document is imported.
            useWorkflowServiceDenial,
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
  // Defaults to the host that refuses. A caller driving this without naming a
  // workflow host has no run store, and inheriting one by omission is the
  // failure mode the whole boundary exists to prevent — so the default is the
  // one that creates and executes nothing.
  installWorkflowHost: HostWorkflowInstaller = unsupportedWorkflowHost,
  // Absent on a host that cannot own an agent session. Node and Bun pass none,
  // and every advertised operation refuses there rather than
  // acting without knowing who owns the session.
  coordinator?: AgentSessionCoordinator,
  // Built from the same trusted root as the coordinator. A host that keeps
  // ownership records keeps construction routes beside them.
  session: { routeStore?: AgentSessionRouteStore } = {},
): Operation<void> {
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
  // Help, `--version`, and the other commands stay outside a run lifecycle,
  // which is why the timeout options are read only for a run.
  const provisional = xmd.parse({ args: helpRequest.args });
  const selected = provisional.ok ? provisional.value.config : undefined;
  const isRun =
    !helpRequest.requested && selected !== undefined && !selected.help && selected.name === "run";

  if (!isRun) {
    return yield* dispatch(
      evalFlags,
      helpRequest,
      installService,
      workflowHost,
      coordinator,
      session,
    );
  }

  const timeouts = resolveRunTimeouts(evalFlags.rest);
  if ("error" in timeouts) {
    console.error(timeouts.error);
    yield* exit(1);
    return;
  }

  yield* underRunDeadline(timeouts, () =>
    dispatch(evalFlags, helpRequest, installService, workflowHost, coordinator, session),
  );
}
