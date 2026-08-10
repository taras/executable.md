/**
 * CLI — run an executable markdown document.
 *
 * Usage:
 *   xmd run <document-reference> [options]
 *   xmd <document-reference> [options]   (run is the default command)
 *   xmd targets <document.md>
 *
 * A document reference is a path, optionally followed by `#` and one target
 * selector naming a section of the document (spec §5.4).
 *
 * Examples:
 *   xmd run packages/core/examples/hello-world.md
 *   xmd packages/core/examples/hello-world.md --verbose
 *   xmd run packages/core/examples/hello-world.md --journal events.jsonl
 *   xmd targets README.md
 *   xmd run README.md#Release/Publish
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
  rootSourcePath,
  useNormalizedOutput,
  useTerminalOutput,
} from "@executablemd/core";
import type { DocumentInfo, FileRootDocument, RootDocumentSource } from "@executablemd/core";
import { env as readEnv } from "@executablemd/runtime";
import { createAcpxProvider, DEFAULT_AGENT_NAME } from "@executablemd/acp";
import { installTestingComponents, TestFailureError, useTesting } from "@executablemd/testing";
import { installTestAgentComponents, runTestAgentWorker } from "@executablemd/test-agent";
import { installWebComponents, installWebElicitation } from "@executablemd/web";
import { resolveAgentConfig } from "./agent-config.ts";
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
import { EVAL_ALIAS, EVAL_OPTION, evalGrammarError, readEvalFlags } from "./eval-source.ts";
import type { EvalFlags } from "./eval-source.ts";
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
    description: "shared timeout in seconds for process, fetch, and agent operations",
    ...field(z.union([z.string(), z.number()]).optional()),
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

/**
 * `xmd targets` takes one document and nothing else.
 *
 * The argument is optional so `xmd targets --help` renders the command rather
 * than failing the parse; a missing reference is reported by the command with
 * its own diagnostic.
 */
const targetsConfig = object({
  path: {
    description: "markdown document whose targets to list",
    ...field(z.string().optional(), cli.argument()),
  },
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
      targets: targetsConfig,
      "test-agent": testAgentConfig,
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
  "--timeout",
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

/**
 * The text an option carried on the command line. `--timeout` validates
 * this rather than the parsed value: the parser coerces `1e3` and `0x10`
 * into numbers and drops `.5`, `+1` and `Infinity`, so forms the grammar
 * rejects would otherwise reach the stack as valid seconds.
 */
function findFlagText(args: string[], flag: string): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === flag) {
      return args[index + 1] ?? "";
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * Install the agent stack for `xmd run`: permission mode, contextual
 * timeout, the ACPX registration, and the components with the resolved
 * root provider. Invalid flags and an unknown --agent-provider fail here
 * — before any document executes. Nothing starts an agent: the provider
 * validates availability on first use.
 */
function* installAgentStack(flags: AgentFlags): Operation<void> {
  const config = resolveAgentConfig(flags);
  if ("error" in config) {
    console.error(config.error);
    yield* exit(1);
    return;
  }

  if (config.timeoutMs !== undefined) {
    const ms = config.timeoutMs;
    yield* Config.around({ timeout: () => ms }, { at: "min" });
  }

  yield* registerAgentProvider("acpx", createAcpxProvider());
  const defaultAgent =
    config.defaultAgent ?? (yield* readEnv("DEFAULT_AGENT_NAME")) ?? DEFAULT_AGENT_NAME;

  let factory;
  try {
    factory = yield* AgentProviders.operations.resolve(flags.agentProvider);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
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
}

interface DocumentConfig {
  root: RootDocumentSource;
  componentDir: string[];
  verbose: boolean;
  journal: string | undefined;
  raw: boolean;
  /** Whether this document's durable events are scanned before they persist. */
  secretDetection: boolean;
}

interface DocumentMode {
  testing: boolean;
  agent?: AgentFlags;
  props?: Record<string, Json>;
}

export type HostServiceInstaller = () => Operation<void>;

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
  const { root, componentDir, verbose, journal, raw, secretDetection } = config;

  // Every CLI invocation starts from an empty stream. --journal writes
  // current-run diagnostics only; existing traces are never loaded.
  let stream: DurableStream;

  if (journal) {
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
    yield* installAgentStack(mode.agent);
  }

  // `xmd test` reports on stdout, so the JSON result contract is `xmd run`'s
  // alone. Reading the mode costs no document effects.
  const valueRoot = !mode.testing && (yield* readsValue(root));

  // Native service authority belongs only to document execution. Help,
  // document inspection, and the agent worker never enter this scope.
  yield* installService();

  const execution = yield* execute({
    ...root,
    stream,
    props: mode.props,
    componentDirs: componentDir,
    secretDetection,
  });

  // Consume the output stream with forEach.
  // A value root reserves stdout for its result: its rendered body is
  // observability, shown on stderr under --verbose and dropped otherwise.
  // Interactive TTY: write each chunk as it arrives.
  // Piped: collect and write the full output at the end.
  const fullOutput = yield* forEach(function* (chunk: string) {
    if (valueRoot) {
      if (verbose) {
        process.stderr.write(chunk);
      }
      return;
    }
    if (process.stdout.isTTY) {
      process.stdout.write(chunk);
    }
  }, execution.output);

  // When piped (not TTY), write the full output at the end.
  if (!valueRoot && !process.stdout.isTTY) {
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

const TARGETS_MISSING_REFERENCE =
  "xmd targets requires a document reference — `xmd targets <document.md>`";

const TARGETS_FRAGMENT = "xmd targets accepts a document reference without a target selector";

/**
 * Refuse anything `xmd targets` does not take.
 *
 * The argument parser ignores options it does not define rather than rejecting
 * them, so a run, test, journal, or service option written here would otherwise
 * be read as silence. Listing a catalog takes one reference and nothing else,
 * which makes the rule the simple one: no option, and no second argument.
 */
function targetsGrammarError(args: string[]): string | undefined {
  let seen = 0;
  for (const arg of args) {
    if (arg === "targets" && seen === 0) {
      seen = 1;
      continue;
    }
    if (arg === "--" || arg.startsWith("-")) {
      return `unrecognized option for xmd targets: ${arg} — xmd targets takes a document reference and nothing else`;
    }
    seen += 1;
    if (seen > 2) {
      return `xmd targets accepts one document reference — remove ${arg}`;
    }
  }
  return undefined;
}

/**
 * `xmd targets` — print every document reference this document addresses.
 *
 * Inspection only. Nothing here installs a service, creates a journal, imports
 * a component, expands the document, or performs an authored effect, so
 * discovering what a document offers is always free of what it does.
 *
 * Written with `process.stdout.write` so a document that addresses nothing
 * writes no bytes at all rather than a bare newline.
 */
function* listTargets(reference: string | undefined): Operation<void> {
  if (reference === undefined) {
    console.error(TARGETS_MISSING_REFERENCE);
    yield* exit(1);
    return;
  }
  const parsed = readReference(reference);
  if (!parsed.ok) {
    console.error(describeError(parsed.error));
    yield* exit(1);
    return;
  }
  if (parsed.value.target !== undefined) {
    console.error(TARGETS_FRAGMENT);
    yield* exit(1);
    return;
  }

  const inspected = yield* inspectCatalog(parsed.value);
  if (!inspected.ok) {
    console.error(describeError(inspected.error));
    yield* exit(1);
    return;
  }

  for (const target of inspected.value.targets) {
    process.stdout.write(`${formatDocumentReference(inspected.value.path, target)}\n`);
  }
}

/** Inspect a document for its catalog, reporting a failure rather than raising. */
function* inspectCatalog(root: FileRootDocument): Operation<Result<DocumentInfo>> {
  try {
    return Ok(yield* inspectDocument(root));
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
 * offers the section this run decided on. That refusal belongs before the
 * service installer and before `execute()`, not after them.
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
  root?: RootDocumentSource;
  bindings: Binding[];
  extraction?: Extraction;
  propsSchema?: unknown;
  declared?: string[];
  error?: string;
}

/**
 * Locate the root document, read what it declares, and lift its generated
 * options out of argv. A provisional parse finds the path: it stops at
 * the first token it does not define, which is exactly where
 * document-derived options begin. The inline document was already lifted out
 * of argv, so it needs no parse at all.
 */
function* preparePropsPhase(args: string[], evalFlags: EvalFlags): Operation<PropsPhase> {
  const provisional = xmd.parse({ args });
  // `program` short-circuits on `--version` and leaves no configuration
  // behind, so there is nothing to inspect.
  const selected = provisional.ok ? provisional.value.config : undefined;
  const command = selected && !selected.help ? selected.name : undefined;
  const documentPath =
    selected && !selected.help && selected.name === "run" ? selected.config.path : undefined;
  const [supplied] = evalFlags.values;

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
    return {
      args: extraction.rest,
      root: exactRoot(root, document.target),
      bindings,
      extraction,
      propsSchema: document.props,
      declared: declaredProperties(document.props),
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

const COMMAND_NAMES = ["run", "test", "targets", "test-agent"];

/**
 * What a caller has to know to write a filename that contains reference
 * syntax. Both commands teach it, because both read one grammar.
 */
const REFERENCE_GRAMMAR_HELP = [
  "A selector must name exactly one section; `xmd targets <document.md>` lists",
  "them. In a filename, write `#` as `%23` and a literal `%` as `%25`.",
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

const TARGETS_HELP = [
  "Lists every section the document addresses, one full document reference per",
  "line, in document order. The reference takes no target selector of its own.",
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
  const epilogue = command === "run" ? RUN_SOURCE_HELP : command === "targets" ? TARGETS_HELP : "";
  const withSource = epilogue === "" ? base : `${base}\n\n${epilogue}`;

  // A document declaring only structured properties generates no
  // individual binding, but it still accepts the aggregate ones.
  if (!phase.root || !phase.declared?.length) {
    return withSource;
  }
  return `${withSource}\n\n${formatProperties(rootSourcePath(phase.root), phase.bindings)}`;
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
export function* runXmd(args: string[], installService: HostServiceInstaller): Operation<void> {
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
      announceSecretDetection(config.secretDetection);
      const result = yield* runScopedDocument(
        { ...config, root: propsPhase.root },
        {
          testing: false,
          props: props.value,
          agent: {
            agentProvider: config.agentProvider,
            defaultAgent: config.defaultAgent,
            timeout: findFlagText(evalFlags.rest, "--timeout"),
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
        const report = targetFailureReport(propsPhase.root, result.error);
        if (report === undefined) {
          reportFailure(result.error);
        } else {
          console.error(report);
        }
        yield* exit(1);
      }
      break;
    }
    case "targets": {
      const agentFlag = findAgentOnlyFlag(evalFlags.rest);
      if (agentFlag) {
        console.error(
          `unrecognized option for xmd targets: ${agentFlag} — agent options are exclusive to xmd run`,
        );
        yield* exit(1);
        break;
      }
      const syntaxError = targetsGrammarError(propsPhase.args);
      if (syntaxError) {
        console.error(syntaxError);
        yield* exit(1);
        break;
      }
      yield* listTargets(command.config.path);
      break;
    }
    case "test": {
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
      yield* test(command.config, evalFlags.rest, installService);
      break;
    }
    case "test-agent":
      yield* runTestAgentWorker({ connect: command.config.connect });
      break;
  }
}
