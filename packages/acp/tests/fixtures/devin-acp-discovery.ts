/**
 * Opt-in Devin ACP protocol discovery for `DevinAcpDiscovery.md`.
 *
 * The document owns authorization, assertions, and rendered output. This
 * helper owns the process boundary the document cannot observe: it places a
 * transparent executable named `devin` between ACPX and the installed Devin
 * CLI, then reports only protocol shape. Prompt text, model text, paths,
 * environment values, raw identifiers, stderr, and credentials never enter
 * the report.
 */

import { ensure, exit, main, scoped, sleep, until, useScope, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { z } from "zod";
import { createAcpRuntime, createRuntimeStore } from "../../src/acpx-runtime.ts";
import type { AcpRuntimeEvent } from "../../src/acpx-runtime.ts";

const DISCOVERY_ENV = "XMD_DEVIN_ACP_DISCOVERY";
const TURNS_ENV = "XMD_DEVIN_MODEL_TURNS_AUTHORIZED";
const SCENARIO_ENV = "XMD_DEVIN_SCENARIO";
const CANCEL_TURN_ENV = "XMD_DEVIN_CANCEL_TURN_AUTHORIZED";
const DEVIN_EXECUTABLE_ENV = "XMD_DEVIN_EXECUTABLE";
const REAL_DEVIN_ENV = "XMD_DEVIN_REAL_EXECUTABLE";
const TRACE_ENV = "XMD_DEVIN_TRACE";
const AUTHORIZED_TURNS = "1";
const BASELINE_SCENARIO = "baseline";
const CANCEL_AFTER_PROMPT_SCENARIO = "cancel-after-prompt";
const EXPECTED_REPLY = "DEVIN-ACP-DISCOVERY-OK";
const TIMEOUT_MS = 5 * 60 * 1000;
const TRACE_SETTLE_TIMEOUT_MS = 5_000;
const TRACE_POLL_MS = 25;
const FIXTURE = fileURLToPath(import.meta.url);

type VerdictKind = "PASS" | "REFUSED" | "ENVIRONMENT_BLOCKED" | "PRODUCT_FAILED";
type Direction = "client-to-agent" | "agent-to-client";
type ProbeScenario = typeof BASELINE_SCENARIO | typeof CANCEL_AFTER_PROMPT_SCENARIO;

interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

const TraceEntrySchema = z.object({
  sequence: z.number().int(),
  direction: z.enum(["client-to-agent", "agent-to-client"]),
  kind: z.enum(["request", "response", "notification", "unknown"]),
  rpc: z.string().optional(),
  method: z.string().optional(),
  parameterKeys: z.array(z.string()).optional(),
  resultKeys: z.array(z.string()).optional(),
  errorCode: z.string().optional(),
  stopReason: z.string().optional(),
  sessionUpdate: z.string().optional(),
  updateKeys: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.array(z.string())).optional(),
  identities: z.record(z.string(), z.string()).optional(),
  clientInfo: z.object({ name: z.string(), version: z.string() }).optional(),
});

const WireTraceSchema = z.object({
  schema: z.literal("devin-acp-wire.v2"),
  complete: z.boolean(),
  entries: z.array(TraceEntrySchema),
  nonJsonLines: z.object({ clientToAgent: z.number().int(), agentToClient: z.number().int() }),
  agentStderr: z.object({ bytes: z.number().int(), classification: z.string() }),
  agentExit: z.object({ code: z.number().int(), signal: z.string() }),
  cancelAfterPromptInjected: z.boolean(),
});

type TraceEntry = z.infer<typeof TraceEntrySchema>;
type WireTrace = z.infer<typeof WireTraceSchema>;

interface DiscoveryVerdict {
  schema: "devin-acp-discovery.v2";
  scenario: ProbeScenario;
  verdict: VerdictKind;
  authorized: boolean;
  ran: boolean;
  refusal: string;
  detail: string;
  devinVersion: string;
  platform: string;
  architecture: string;
  modelTurns: number;
  runtimeStatus: string;
  failureStage: string;
  runtimeErrorCode: string;
  runtimeErrorDetailCode: string;
  runtimeErrorClassification: string;
  relayTraceWritten: boolean;
  stopReason: string;
  replyExact: boolean;
  agentSessionIdentityReported: boolean;
  journalSufficient: false;
  trace: WireTrace;
  privateContentReported: false;
}

function emptyTrace(): WireTrace {
  return {
    schema: "devin-acp-wire.v2",
    complete: false,
    entries: [],
    nonJsonLines: { clientToAgent: 0, agentToClient: 0 },
    agentStderr: { bytes: 0, classification: "none" },
    agentExit: { code: -1, signal: "" },
    cancelAfterPromptInjected: false,
  };
}

function baseVerdict(): DiscoveryVerdict {
  return {
    schema: "devin-acp-discovery.v2",
    scenario: BASELINE_SCENARIO,
    verdict: "REFUSED",
    authorized: false,
    ran: false,
    refusal: "",
    detail: "",
    devinVersion: "",
    platform: process.platform,
    architecture: process.arch,
    modelTurns: 0,
    runtimeStatus: "",
    failureStage: "",
    runtimeErrorCode: "",
    runtimeErrorDetailCode: "",
    runtimeErrorClassification: "none",
    relayTraceWritten: false,
    stopReason: "",
    replyExact: false,
    agentSessionIdentityReported: false,
    journalSufficient: false,
    trace: emptyTrace(),
    privateContentReported: false,
  };
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, name);
}

function stringField(value: unknown, name: string): string | undefined {
  const held = field(value, name);
  return typeof held === "string" ? held : undefined;
}

function objectKeys(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.keys(value).toSorted();
}

function metadataKeys(value: unknown): string[] | undefined {
  return objectKeys(field(value, "_meta"));
}

function classifyStderr(value: string): string {
  if (value.length === 0) {
    return "none";
  }
  if (/enoent|not found|spawn/i.test(value)) {
    return "executable-launch-failed";
  }
  if (/eacces|permission denied|notcapable|requires.*permission/i.test(value)) {
    return "permission-denied";
  }
  if (/lockfile.*out of date|frozen/i.test(value)) {
    return "dependency-state-invalid";
  }
  if (/cannot find (module|package)|module not found/i.test(value)) {
    return "dependency-resolution-failed";
  }
  if (/resource.?exhausted|quota|acu/i.test(value)) {
    return "quota-exhausted";
  }
  if (/unauthenticated|authentication|log.?in|sign.?in/i.test(value)) {
    return "authentication-required";
  }
  if (/windsurf.*out.?of.?date|failed_precondition/i.test(value)) {
    return "client-compatibility-refused";
  }
  if (/timed? ?out|timeout/i.test(value)) {
    return "timeout";
  }
  if (/protocol|json.?rpc|initialize|connection closed|transport/i.test(value)) {
    return "protocol-initialization-failed";
  }
  return "unclassified";
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : "";
}

function tokenFor(value: string, tokens: Map<string, string>, prefix: string): string {
  const held = tokens.get(value);
  if (held !== undefined) {
    return held;
  }
  const token = `${prefix}-${tokens.size + 1}`;
  tokens.set(value, token);
  return token;
}

function identityFields(value: unknown, tokens: Map<string, string>): Record<string, string> {
  const identities: Record<string, string> = {};
  const params = field(value, "params");
  const result = field(value, "result");
  const resultMeta = field(result, "_meta");
  const locations: Array<[string, unknown]> = [
    ["params.sessionId", field(params, "sessionId")],
    ["params.resumeSessionId", field(params, "resumeSessionId")],
    ["result.sessionId", field(result, "sessionId")],
    ["result._meta.agentSessionId", field(resultMeta, "agentSessionId")],
  ];
  for (const [name, candidate] of locations) {
    if (typeof candidate === "string") {
      identities[name] = tokenFor(candidate, tokens, "identity");
    }
  }
  return identities;
}

function metadataFields(value: unknown): Record<string, string[]> {
  const params = field(value, "params");
  const update = field(params, "update");
  const result = field(value, "result");
  const capabilities = field(params, "clientCapabilities");
  const metadata: Record<string, string[]> = {};
  const locations: Array<[string, unknown]> = [
    ["params", metadataKeys(params)],
    ["params.clientCapabilities", metadataKeys(capabilities)],
    ["params.update", metadataKeys(update)],
    ["result", metadataKeys(result)],
  ];
  for (const [name, keys] of locations) {
    if (Array.isArray(keys) && keys.length > 0) {
      metadata[name] = keys;
    }
  }
  return metadata;
}

function sanitizeMessage(
  value: unknown,
  direction: Direction,
  sequence: number,
  requestTokens: Map<string, string>,
  identityTokens: Map<string, string>,
): TraceEntry {
  const method = stringField(value, "method");
  const id = field(value, "id");
  const hasId = typeof id === "string" || typeof id === "number";
  const requestDirection =
    method !== undefined
      ? direction
      : direction === "client-to-agent"
        ? "agent-to-client"
        : "client-to-agent";
  const rpc = hasId
    ? tokenFor(`${requestDirection}:${String(id)}`, requestTokens, "request")
    : undefined;
  const params = field(value, "params");
  const result = field(value, "result");
  const error = field(value, "error");
  const update = field(params, "update");
  const metadata = metadataFields(value);
  const identities = identityFields(value, identityTokens);
  const clientInfo = field(params, "clientInfo");
  const clientName = stringField(clientInfo, "name");
  const clientVersion = stringField(clientInfo, "version");
  const errorCode = field(error, "code");
  return {
    sequence,
    direction,
    kind:
      method === undefined ? (hasId ? "response" : "unknown") : hasId ? "request" : "notification",
    ...(rpc === undefined ? {} : { rpc }),
    ...(method === undefined ? {} : { method }),
    ...(objectKeys(params) === undefined ? {} : { parameterKeys: objectKeys(params) }),
    ...(objectKeys(result) === undefined ? {} : { resultKeys: objectKeys(result) }),
    ...(errorCode === undefined ? {} : { errorCode: String(errorCode) }),
    ...(stringField(result, "stopReason") === undefined
      ? {}
      : { stopReason: stringField(result, "stopReason") }),
    ...(stringField(update, "sessionUpdate") === undefined
      ? {}
      : { sessionUpdate: stringField(update, "sessionUpdate") }),
    ...(objectKeys(update) === undefined ? {} : { updateKeys: objectKeys(update) }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    ...(Object.keys(identities).length === 0 ? {} : { identities }),
    ...(clientName === undefined || clientVersion === undefined
      ? {}
      : { clientInfo: { name: clientName, version: clientVersion } }),
  };
}

function observeJsonLines(
  stream: NodeJS.ReadableStream,
  direction: Direction,
  entries: TraceEntry[],
  nonJson: { clientToAgent: number; agentToClient: number },
  requestTokens: Map<string, string>,
  identityTokens: Map<string, string>,
  onEntry: () => void,
): () => void {
  let buffer = "";
  const onData = (chunk: string | Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.length === 0) {
        continue;
      }
      try {
        const message: unknown = JSON.parse(line);
        entries.push(
          sanitizeMessage(message, direction, entries.length + 1, requestTokens, identityTokens),
        );
        onEntry();
      } catch {
        if (direction === "client-to-agent") {
          nonJson.clientToAgent++;
        } else {
          nonJson.agentToClient++;
        }
      }
    }
  };
  stream.on("data", onData);
  return () => {
    stream.off("data", onData);
  };
}

function relayClientJsonLines(
  stream: NodeJS.ReadableStream,
  child: ChildProcessWithoutNullStreams,
  entries: TraceEntry[],
  nonJson: { clientToAgent: number; agentToClient: number },
  requestTokens: Map<string, string>,
  identityTokens: Map<string, string>,
  injectCancelAfterPrompt: boolean,
  onEntry: () => void,
): { stop: () => void; cancelInjected: () => boolean } {
  let buffer = "";
  let injected = false;
  const onData = (chunk: string | Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const rawLine = buffer.slice(0, index);
      const line = rawLine.trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      child.stdin.write(`${rawLine}\n`);
      if (line.length === 0) {
        continue;
      }
      try {
        const message: unknown = JSON.parse(line);
        entries.push(
          sanitizeMessage(
            message,
            "client-to-agent",
            entries.length + 1,
            requestTokens,
            identityTokens,
          ),
        );
        onEntry();
        const params = field(message, "params");
        const sessionId = stringField(params, "sessionId");
        if (
          injectCancelAfterPrompt &&
          !injected &&
          stringField(message, "method") === "session/prompt" &&
          sessionId !== undefined
        ) {
          const cancellation = {
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId },
          };
          entries.push(
            sanitizeMessage(
              cancellation,
              "client-to-agent",
              entries.length + 1,
              requestTokens,
              identityTokens,
            ),
          );
          onEntry();
          child.stdin.write(`${JSON.stringify(cancellation)}\n`);
          injected = true;
        }
      } catch {
        nonJson.clientToAgent++;
      }
    }
  };
  const onEnd = () => {
    child.stdin.end();
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return {
    stop: () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    },
    cancelInjected: () => injected,
  };
}

function* runCommand(command: string, args: string[], cwd: string): Operation<CommandOutcome> {
  const child = spawnChild(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const settled = withResolvers<number>();
  child.once("error", settled.reject);
  child.once("exit", (code) => settled.resolve(code ?? 1));
  yield* ensure(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });
  return { code: yield* settled.operation, stdout, stderr };
}

function* executableOnPath(name: string): Operation<string | undefined> {
  const path = process.env["PATH"];
  if (path === undefined) {
    return undefined;
  }
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory, name);
    if (yield* exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function quoteCommandToken(value: string): string {
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function textFrom(events: AcpRuntimeEvent[]): string {
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.text)
    .join("");
}

function traceSnapshot(
  entries: TraceEntry[],
  nonJson: { clientToAgent: number; agentToClient: number },
  stderr: string,
  outcome: { code: number; signal: string },
  complete: boolean,
  cancelAfterPromptInjected: boolean,
): WireTrace {
  return {
    schema: "devin-acp-wire.v2",
    complete,
    entries,
    nonJsonLines: nonJson,
    agentStderr: { bytes: Buffer.byteLength(stderr), classification: classifyStderr(stderr) },
    agentExit: outcome,
    cancelAfterPromptInjected,
  };
}

function* runRelay(): Operation<void> {
  const executable = process.env[REAL_DEVIN_ENV];
  const traceDirectory = process.env[TRACE_ENV];
  if (executable === undefined || traceDirectory === undefined) {
    throw new Error("the Devin ACP discovery relay is missing its private launch inputs");
  }

  const scope = yield* useScope();
  const entries: TraceEntry[] = [];
  const nonJson = { clientToAgent: 0, agentToClient: 0 };
  const requestTokens = new Map<string, string>();
  const identityTokens = new Map<string, string>();
  let stderr = "";
  let snapshotSequence = 0;
  const cancelInjected = () =>
    entries.some(
      (entry) => entry.direction === "client-to-agent" && entry.method === "session/cancel",
    );
  const terminalTurnResponseObserved = () =>
    entries.some(
      (entry) =>
        entry.direction === "agent-to-client" &&
        entry.kind === "response" &&
        entry.stopReason !== undefined,
    );
  const snapshotContent = (complete: boolean, outcome = { code: -1, signal: "" }) =>
    `${JSON.stringify(
      traceSnapshot([...entries], { ...nonJson }, stderr, outcome, complete, cancelInjected()),
      null,
      2,
    )}\n`;
  const initialTracePath = join(traceDirectory, "snapshot-000000.json");
  yield* writeTextFile(initialTracePath, snapshotContent(false));
  const writeLiveSnapshot = () => {
    snapshotSequence++;
    const name = `snapshot-${String(snapshotSequence).padStart(6, "0")}.json`;
    const path = join(traceDirectory, name);
    const content = snapshotContent(terminalTurnResponseObserved());
    scope.run(function* () {
      yield* writeTextFile(path, content);
    });
  };
  const child: ChildProcessWithoutNullStreams = spawnChild(executable, process.argv.slice(3), {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const clientRelay = relayClientJsonLines(
    process.stdin,
    child,
    entries,
    nonJson,
    requestTokens,
    identityTokens,
    process.env[SCENARIO_ENV] === CANCEL_AFTER_PROMPT_SCENARIO,
    writeLiveSnapshot,
  );
  const stopAgentObservation = observeJsonLines(
    child.stdout,
    "agent-to-client",
    entries,
    nonJson,
    requestTokens,
    identityTokens,
    writeLiveSnapshot,
  );
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.pipe(process.stdout);

  const settled = withResolvers<{ code: number; signal: string }>();
  child.once("error", settled.reject);
  child.once("exit", (code, signal) => {
    settled.resolve({ code: code ?? 1, signal: signal ?? "" });
  });
  yield* ensure(() => {
    clientRelay.stop();
    stopAgentObservation();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });

  let outcome: { code: number; signal: string };
  try {
    outcome = yield* settled.operation;
  } catch (error) {
    const classified = error instanceof Error ? error.message : "unclassified";
    const failed = traceSnapshot(
      entries,
      nonJson,
      `${stderr}\n${classified}`,
      { code: -1, signal: "SPAWN_ERROR" },
      true,
      clientRelay.cancelInjected(),
    );
    yield* writeTextFile(
      join(traceDirectory, "final.json"),
      `${JSON.stringify(failed, null, 2)}\n`,
    );
    throw error;
  }
  const trace = traceSnapshot(
    entries,
    nonJson,
    stderr,
    outcome,
    true,
    clientRelay.cancelInjected(),
  );
  yield* writeTextFile(join(traceDirectory, "final.json"), `${JSON.stringify(trace, null, 2)}\n`);
  if (outcome.code !== 0) {
    yield* exit(outcome.code);
  }
}

function* readCompletedTrace(traceDirectory: string): Operation<WireTrace | undefined> {
  const attempts = Math.ceil(TRACE_SETTLE_TIMEOUT_MS / TRACE_POLL_MS);
  let lastValid: WireTrace | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (yield* exists(traceDirectory)) {
      const names = yield* readdir(traceDirectory);
      const snapshots = names
        .filter((name) => /^snapshot-[0-9]{6}\.json$/.test(name))
        .toSorted()
        .toReversed();
      const candidates = names.includes("final.json") ? ["final.json", ...snapshots] : snapshots;
      for (const name of candidates) {
        try {
          const parsed: unknown = JSON.parse(yield* readTextFile(join(traceDirectory, name)));
          const trace = WireTraceSchema.safeParse(parsed);
          if (trace.success) {
            lastValid = trace.data;
            if (trace.data.complete) {
              return trace.data;
            }
            break;
          }
        } catch {
          // A live snapshot can be visible before its write has completed.
        }
      }
    }
    yield* sleep(TRACE_POLL_MS);
  }
  return lastValid;
}

function* runDiscovery(): Operation<DiscoveryVerdict> {
  const verdict = baseVerdict();
  if (process.env[DISCOVERY_ENV] !== "1") {
    verdict.refusal = `${DISCOVERY_ENV}=1 was not supplied`;
    verdict.detail = "no Devin process was started and no model turn was spent";
    return verdict;
  }
  const requestedScenario = process.env[SCENARIO_ENV] ?? BASELINE_SCENARIO;
  if (
    requestedScenario !== BASELINE_SCENARIO &&
    requestedScenario !== CANCEL_AFTER_PROMPT_SCENARIO
  ) {
    verdict.refusal = `${SCENARIO_ENV} did not name a supported probe`;
    verdict.detail = `use ${BASELINE_SCENARIO} or ${CANCEL_AFTER_PROMPT_SCENARIO}`;
    return verdict;
  }
  verdict.scenario = requestedScenario;
  const authorizationEnv = verdict.scenario === BASELINE_SCENARIO ? TURNS_ENV : CANCEL_TURN_ENV;
  if (process.env[authorizationEnv] !== AUTHORIZED_TURNS) {
    verdict.refusal = `${authorizationEnv}=${AUTHORIZED_TURNS} was not supplied`;
    verdict.detail = "the separate authorization for this probe was absent";
    return verdict;
  }
  verdict.authorized = true;

  const configured = process.env[DEVIN_EXECUTABLE_ENV];
  const executable = configured ?? (yield* executableOnPath("devin"));
  if (executable === undefined) {
    verdict.verdict = "ENVIRONMENT_BLOCKED";
    verdict.refusal = "the Devin executable was not found";
    verdict.detail = `install Devin or set ${DEVIN_EXECUTABLE_ENV} to its executable path`;
    return verdict;
  }

  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-devin-acp-discovery-")));
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = process.cwd();
  const traceDirectory = join(root, "wire");
  yield* ensureDir(traceDirectory);
  const relay = join(root, "devin");
  yield* until(symlink(process.execPath, relay));

  const version = yield* runCommand(executable, ["--version"], projectDirectory);
  if (version.code !== 0) {
    verdict.verdict = "ENVIRONMENT_BLOCKED";
    verdict.refusal = "Devin did not answer --version successfully";
    verdict.detail = classifyStderr(version.stderr);
    return verdict;
  }
  verdict.devinVersion = version.stdout.trim().split("\n")[0] ?? "";

  const relayCommand = [
    relay,
    "run",
    "--frozen",
    "--allow-env",
    `--allow-run=${executable}`,
    `--allow-write=${traceDirectory}`,
    FIXTURE,
    "relay",
    "acp",
  ]
    .map(quoteCommandToken)
    .join(" ");
  const store = createRuntimeStore({ stateDir: join(root, "acpx") });
  const runtime = createAcpRuntime({
    cwd: projectDirectory,
    sessionStore: store,
    agentRegistry: { resolve: () => relayCommand, list: () => ["devin"] },
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    timeoutMs: TIMEOUT_MS,
    agentProcessEnv: {
      [REAL_DEVIN_ENV]: executable,
      [TRACE_ENV]: traceDirectory,
      [SCENARIO_ENV]: verdict.scenario,
    },
  });

  let activeStage = "session-initialization";
  try {
    yield* scoped(function* () {
      const handle = yield* until(
        runtime.ensureSession({
          sessionKey: `devin-discovery-${randomUUID()}`,
          agent: "devin",
          mode: "persistent",
          cwd: projectDirectory,
        }),
      );
      let closed = false;
      yield* ensure(function* () {
        if (!closed) {
          yield* until(runtime.close({ handle, reason: "Devin ACP discovery stopped" }));
        }
      });
      verdict.agentSessionIdentityReported = handle.agentSessionId !== undefined;
      activeStage = "turn-start";
      verdict.modelTurns = 1;
      const turn = runtime.startTurn({
        handle,
        text: `Reply with exactly ${EXPECTED_REPLY}`,
        mode: "prompt",
        requestId: randomUUID(),
        timeoutMs: TIMEOUT_MS,
      });
      activeStage = "turn-stream";
      const events: AcpRuntimeEvent[] = [];
      const iterator = turn.events[Symbol.asyncIterator]();
      let next = yield* until(iterator.next());
      while (!next.done) {
        events.push(next.value);
        next = yield* until(iterator.next());
      }
      const result = yield* until(turn.result);
      verdict.runtimeStatus = result.status;
      if (result.status === "failed") {
        verdict.failureStage = "turn-result";
        verdict.runtimeErrorCode = safeErrorCode(result.error.code);
        verdict.runtimeErrorDetailCode = safeErrorCode(result.error.detailCode);
        verdict.runtimeErrorClassification = classifyStderr(result.error.message);
      } else if (result.status === "cancelled") {
        verdict.failureStage = "turn-result";
        verdict.runtimeErrorClassification = "cancelled";
      }
      verdict.stopReason = result.status === "completed" ? (result.stopReason ?? "") : "";
      verdict.replyExact = textFrom(events).trim() === EXPECTED_REPLY;
      activeStage = "session-close";
      yield* until(runtime.close({ handle, reason: "Devin ACP discovery completed" }));
      closed = true;
      if (result.status === "completed") {
        verdict.failureStage = "";
      }
    });
  } catch (error) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.refusal = "the Devin ACP journey did not complete";
    verdict.failureStage = activeStage;
    verdict.runtimeErrorCode = safeErrorCode(field(error, "code"));
    verdict.runtimeErrorDetailCode = safeErrorCode(field(error, "detailCode"));
    verdict.runtimeErrorClassification =
      error instanceof Error ? classifyStderr(error.message) : "unclassified";
    verdict.detail = "inspect the safe runtime failure fields and relay trace";
  }

  const trace = yield* readCompletedTrace(traceDirectory);
  if (trace !== undefined) {
    verdict.relayTraceWritten = true;
    verdict.trace = trace;
  } else if (yield* exists(traceDirectory)) {
    verdict.relayTraceWritten = true;
    verdict.failureStage = "trace-read";
    verdict.runtimeErrorClassification = "invalid-relay-trace";
  }
  verdict.ran =
    verdict.modelTurns === 1 || verdict.relayTraceWritten || verdict.trace.entries.length > 0;
  if (verdict.verdict !== "PRODUCT_FAILED") {
    const windsurf = verdict.trace.entries.some(
      (entry) => entry.method === "initialize" && entry.clientInfo?.name === "windsurf",
    );
    const scenarioSatisfied =
      verdict.scenario === BASELINE_SCENARIO
        ? verdict.runtimeStatus === "completed"
        : verdict.trace.cancelAfterPromptInjected && verdict.runtimeStatus === "cancelled";
    verdict.verdict = windsurf && scenarioSatisfied ? "PASS" : "PRODUCT_FAILED";
    verdict.refusal = verdict.verdict === "PASS" ? "" : "the ACP journey did not satisfy its probe";
    verdict.detail =
      verdict.verdict === "PASS"
        ? "the filtered ACP exchange is available for architecture review"
        : "inspect the filtered trace classifications and protocol shapes";
  }
  return verdict;
}

function render(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main(function* () {
  if (process.argv[2] === "relay") {
    yield* runRelay();
    return;
  }
  render(yield* runDiscovery());
});
