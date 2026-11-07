/**
 * Measure one bundled Agent through one production XMD host.
 *
 * Markdown owns what is asked: each scenario document under `scenarios/`
 * sequences its own Prompts in one `<Session>`. This program owns only what a
 * document cannot: starting the selected host as a child, cancelling it at the
 * moment a scenario names, joining it, and comparing the canonical history it
 * left with the runtime's saved copy and the native agent's own account.
 */

import { ensure, exit, main, race, scoped, sleep, spawn, until } from "effection";
import type { Operation, Stream, Task } from "effection";
import { exec, Stdio } from "@effectionx/process";
import { ensureDir, exists, readdir, readTextFile, stat, writeTextFile } from "@effectionx/fs";
import { mkdir, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import type { PromptUsage } from "@executablemd/core";
import { ALLOWANCE, HELP, parseSelection, Refusal } from "./selection.ts";
import type { Selection } from "./selection.ts";
import {
  acpxAgreement,
  check,
  claudeNative,
  codexNative,
  nativeComparison,
  readAcknowledged,
} from "./evidence.ts";
import type { Acknowledged, Check, Fixture, NativeSession } from "./evidence.ts";
import { renderMarkdown } from "./report.ts";
import type { PromptReport, Report } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = resolve(HERE, "..", "..");
const SCENARIOS = join(HERE, "scenarios");
/** The per-Prompt work deadline each scenario document's provider applies. */
const PROMPT_SECONDS = 60;
/** No invocation is admitted after this many seconds from the start. */
const ADMISSION_SECONDS = 300;
const READY = "USAGE_CALIBRATION_READY";

/** One child invocation a scenario plans. */
interface Invocation {
  readonly document: string;
  readonly props: Readonly<Record<string, string>>;
  readonly journal: string;
  readonly prompts: number;
  readonly denyAll?: boolean;
  /** Interrupt once the saved Agent output says this. */
  readonly cancelOn?: string;
}

/** How one child ended, observed by joining it. */
interface Joined {
  readonly started: boolean;
  readonly code?: number;
  readonly signal?: string;
  /** The cancellation marker was seen and an interrupt was sent. */
  readonly cancelledAfterReady?: boolean;
  readonly unacknowledgedAtInterrupt?: boolean;
  readonly deadline?: boolean;
}

function hex(): string {
  return randomBytes(6).toString("hex");
}

function* digestOf(path: string): Operation<string> {
  return `sha256:${createHash("sha256")
    .update(yield* until(readFile(path)))
    .digest("hex")}`;
}

/** The argv of the selected host, ready for an XMD command. */
function hostCommand(selection: Selection): string[] {
  if (selection.host === "compiled" && selection.xmd !== undefined) {
    return [selection.xmd];
  }
  return [process.execPath, "run", "--allow-all", "--frozen", join(CHECKOUT, "packages/cli/src/deno.ts")];
}

/** Run one short non-prompt command and keep its first line, or nothing. */
function* firstLine(argv: string[], cwd: string): Operation<string | undefined> {
  try {
    const result = yield* scoped(function* () {
      const child = yield* exec(argv[0], { arguments: argv.slice(1), cwd });
      let out = "";
      const reading = yield* spawn(function* () {
        for (const chunk of yield* eachChunk(child.stdout)) {
          out += chunk;
        }
      });
      const status = yield* child.join();
      yield* reading;
      return status.code === 0 ? out : undefined;
    });
    return result?.split("\n").find((line) => line.trim().length > 0)?.trim();
  } catch {
    return undefined;
  }
}

/** Every chunk of an output stream, decoded, until it closes. */
function* eachChunk(stream: Stream<Uint8Array, unknown>): Operation<string[]> {
  const chunks: string[] = [];
  const subscription = yield* stream;
  const decoder = new TextDecoder();
  let next = yield* subscription.next();
  while (!next.done) {
    chunks.push(decoder.decode(next.value, { stream: true }));
    next = yield* subscription.next();
  }
  return chunks;
}

const VERSION_TOKEN = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u;

/** What the run measured about the builds before any Prompt was sent. */
interface Measured {
  readonly xmdVersion?: string;
  readonly xmdDigest?: string;
  readonly sourceRevision?: string;
  readonly sourceClean?: boolean;
  readonly nativeVersion?: string;
}

function* measure(
  selection: Selection,
  cwd: string,
  environment: CalibrationEnvironment,
): Operation<Measured> {
  const version = (yield* firstLine([...hostCommand(selection), "--version"], cwd))?.match(VERSION_TOKEN)?.[0];
  // The executable the bundled adapter would bind, when the host names one.
  const bound =
    selection.agent === "claude" ? process.env.CLAUDE_CODE_EXECUTABLE : process.env.CODEX_PATH;
  const native = (yield* firstLine([environment.native ?? bound ?? selection.agent, "--version"], cwd))?.match(VERSION_TOKEN)?.[0];
  if (selection.host === "compiled" && selection.xmd !== undefined) {
    return {
      ...(version === undefined ? {} : { xmdVersion: version }),
      xmdDigest: yield* digestOf(selection.xmd),
      ...(native === undefined ? {} : { nativeVersion: native }),
    };
  }
  const revision = yield* firstLine(["git", "-C", CHECKOUT, "rev-parse", "HEAD"], cwd);
  const status = yield* scoped(function* () {
    const child = yield* exec("git", { arguments: ["-C", CHECKOUT, "status", "--porcelain"], cwd });
    let out = "";
    const reading = yield* spawn(function* () {
      out = (yield* eachChunk(child.stdout)).join("");
    });
    const joined = yield* child.join();
    yield* reading;
    return joined.code === 0 ? out : undefined;
  });
  return {
    ...(version === undefined ? {} : { xmdVersion: version }),
    ...(revision === undefined || !/^[0-9a-f]{40}$/u.test(revision) ? {} : { sourceRevision: revision }),
    ...(status === undefined ? {} : { sourceClean: status.trim().length === 0 }),
    ...(native === undefined ? {} : { nativeVersion: native }),
  };
}

/**
 * Whether ACPX's own live checkpoint of a session shows the readiness marker.
 *
 * The provider checkpoints a turn's session updates while it runs, so the
 * marker in the saved Agent text, in the record whose user message names this
 * run's private fixture, is the earliest evidence a host has that the Agent
 * actually said it. It does not establish whether the turn is still active.
 * Nothing is copied.
 */
function* readyInAcpx(acpxRoot: string, fixture: string, since: number): Operation<boolean> {
  const sessions = join(acpxRoot, "sessions");
  if (!(yield* exists(sessions))) {
    return false;
  }
  for (const name of yield* readdir(sessions)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const path = join(sessions, name);
    try {
      if ((yield* stat(path)).mtimeMs < since) {
        continue;
      }
      const text = yield* readTextFile(path);
      if (!text.includes(fixture) || !text.includes(READY)) {
        continue;
      }
      const record: unknown = JSON.parse(text);
      const messages = Reflect.get(Object(record), "messages");
      if (!Array.isArray(messages)) {
        continue;
      }
      const named = messages.some((message) => JSON.stringify(Reflect.get(Object(message), "User") ?? null).includes(fixture));
      const said = messages.some((message) => JSON.stringify(Reflect.get(Object(message), "Agent") ?? null).includes(READY));
      if (named && said) {
        return true;
      }
    } catch {
      // A record being replaced while it is read is read again next time.
    }
  }
  return false;
}

/**
 * The clocks and native home one calibration runs under.
 *
 * The approved values are the defaults; a deterministic test supplies shorter
 * clocks and a private home through this same value, so no command-line knob
 * exists to change what an operator's run is held to.
 */
export interface CalibrationEnvironment {
  /** Work allowed per outer Prompt. */
  readonly promptMs: number;
  /** No invocation is admitted after this long from the start of the command. */
  readonly admissionMs: number;
  /** Extra work time one invocation gets beyond its Prompts' own. */
  readonly slackMs: number;
  /** How often readiness and deadlines are checked while a child runs. */
  readonly pollMs: number;
  /** Where ACPX and the native agents keep their own state. */
  readonly home: string;
  /** The native executable whose version is measured, when not the host's bound one. */
  readonly native?: string;
}

function approvedEnvironment(): CalibrationEnvironment {
  return {
    promptMs: PROMPT_SECONDS * 1000,
    admissionMs: ADMISSION_SECONDS * 1000,
    slackMs: 30_000,
    pollMs: 250,
    home: homedir(),
  };
}

/**
 * Run one child host invocation to its joined end.
 *
 * A deadline or readiness marker sends the child an interrupt, which is the
 * host's own structured cancellation, and then joins it: nothing is detached
 * or killed to make a report timely, and joining waits as long as the child's
 * own cleanup takes.
 */
function* invoke(
  selection: Selection,
  invocation: Invocation,
  cwd: string,
  deadlineAt: number,
  stderrPath: string,
  environment: CalibrationEnvironment,
): Operation<Joined> {
  const argv = [
    ...hostCommand(selection),
    "run",
    invocation.document,
    "--journal",
    invocation.journal,
    ...(invocation.denyAll === true ? ["--deny-all"] : []),
    ...Object.entries(invocation.props).flatMap(([name, value]) => [`--props-${name}`, value]),
  ];
  return yield* scoped(function* () {
    const started = Date.now();
    const child = yield* exec(argv[0], { arguments: argv.slice(1), cwd });
    let stderr = "";
    const drains: Task<void>[] = [
      yield* spawn(function* () {
        yield* eachChunk(child.stdout);
      }),
      yield* spawn(function* () {
        stderr = (yield* eachChunk(child.stderr)).join("");
      }),
    ];
    yield* ensure(function* () {
      yield* writeTextFile(stderrPath, stderr.slice(0, 8000));
    });
    let cancelledAfterReady = false;
    let unacknowledgedAtInterrupt = false;
    let deadline = false;
    const workDeadline = Math.min(
      deadlineAt,
      started + invocation.prompts * environment.promptMs + environment.slackMs,
    );
    const status = yield* race([
      child.join(),
      (function* (): Operation<never> {
        while (true) {
          yield* sleep(environment.pollMs);
          if (invocation.cancelOn !== undefined && !cancelledAfterReady && !deadline) {
            if (yield* readyInAcpx(join(environment.home, ".acpx"), invocation.cancelOn, started)) {
              try {
                unacknowledgedAtInterrupt = ((yield* readAcknowledged(invocation.journal)) ?? []).length === 0;
              } catch {
                // A partial journal line cannot prove the Prompt is unsettled.
              }
              cancelledAfterReady = true;
              process.kill(child.pid, "SIGINT");
            }
          }
          if (!deadline && !cancelledAfterReady && Date.now() > workDeadline) {
            deadline = true;
            process.kill(child.pid, "SIGINT");
          }
        }
      })(),
    ]);
    for (const drain of drains) {
      yield* drain;
    }
    return {
      started: true,
      // The join reports an absent code or signal as null.
      ...(typeof status.code === "number" ? { code: status.code } : {}),
      ...(typeof status.signal === "string" ? { signal: status.signal } : {}),
      ...(invocation.cancelOn === undefined ? {} : { cancelledAfterReady, unacknowledgedAtInterrupt }),
      ...(deadline ? { deadline } : {}),
    };
  });
}

/**
 * Whether a joined child's XMD owner is known to have finished cleanly.
 *
 * Only a zero exit says so: a teardown failure reaches the command line as a
 * nonzero exit, exactly as an ordinary Prompt failure does, so a process that
 * merely closed proves it joined and nothing about its cleanup.
 */
function succeeded(joined: Joined): boolean {
  return joined.code === 0 && joined.signal === undefined;
}

function* nativeFor(
  agent: Selection["agent"],
  record: Acknowledged | undefined,
  environment: CalibrationEnvironment,
  fixture: Fixture,
): Operation<NativeSession | undefined> {
  const id = record?.record.agentSessionId;
  if (id === undefined) {
    return undefined;
  }
  try {
    return agent === "claude"
      ? yield* claudeNative(environment.home, id, fixture)
      : yield* codexNative(environment.home, id, fixture);
  } catch {
    return undefined;
  }
}

/** The shareable view of one usage value: counts, fixed semantics and categorical coverage. */
function shareable(usage: PromptUsage | undefined): PromptReport["usage"] {
  if (usage === undefined) {
    return undefined;
  }
  return {
    readings: usage.readings.map((reading) => {
      const { model, ...rest } = reading;
      return model !== undefined && MODEL.test(model) ? reading : rest;
    }),
    coverage: usage.coverage,
  };
}

const MODEL = /^[A-Za-z0-9._:\-[\]]{1,80}$/u;

/** What one scenario actually did, beside the record the report is built from. */
interface Observed {
  readonly acknowledged: Acknowledged[];
  readonly joins: Joined[];
  readonly planned: number;
  readonly stopped?: "admission-deadline" | "unsuccessful-owner";
  /** The native session each acknowledged record names, by record index. */
  readonly natives: (NativeSession | undefined)[];
}

function* runScenario(
  selection: Selection,
  output: string,
  start: number,
  environment: CalibrationEnvironment,
): Operation<Report> {
  const fixture = join(output, "fixture");
  const support = join(output, "support");
  yield* ensureDir(fixture);
  yield* ensureDir(support);
  const markers = { a: `USAGE-A-${hex()}`, b: `USAGE-B-${hex()}`, r: `USAGE-R-${hex()}` };
  const fileA = join(fixture, "a.txt");
  const fileB = join(fixture, "b.txt");
  const deniedFile = join(fixture, "denied.txt");
  yield* writeTextFile(fileA, `${markers.a}\n`);
  yield* writeTextFile(fileB, `${markers.b}\n`);
  const session = `usage-calibration-${hex()}`;
  const base = { agent: selection.agent, session };
  const journal = (name: string) => join(output, `${name}.jsonl`);

  const plan: Invocation[] = (() => {
    switch (selection.scenario) {
      case "success":
        return [{ document: join(SCENARIOS, "success.md"), props: { ...base, first: fileA, second: fileB }, journal: journal("success"), prompts: 2 }];
      case "resume":
        return [
          { document: join(SCENARIOS, "resume-seed.md"), props: { ...base, marker: markers.r }, journal: journal("resume-seed"), prompts: 1 },
          { document: join(SCENARIOS, "resume-continuation.md"), props: base, journal: journal("resume-continuation"), prompts: 1 },
        ];
      case "failure":
        return [{ document: join(SCENARIOS, "failure.md"), props: { ...base, denied: deniedFile }, journal: journal("failure"), prompts: 1, denyAll: true }];
      case "cancel":
        return [{ document: join(SCENARIOS, "cancel.md"), props: { ...base, first: fileA, second: fileB }, journal: journal("cancel"), prompts: 1, cancelOn: fileA }];
      case "subagent":
        return [{ document: join(SCENARIOS, "subagent.md"), props: { ...base, first: fileA }, journal: journal("subagent"), prompts: 1 }];
    }
  })();
  const planned = plan.reduce((sum, invocation) => sum + invocation.prompts, 0);
  if (planned > ALLOWANCE[selection.scenario]) {
    throw new Error("the scenario plans more outer Prompts than its allowance");
  }

  const admissionAt = start + environment.admissionMs;
  const measured = yield* measure(selection, fixture, environment);
  const joins: Joined[] = [];
  let reserved = 0;
  let stopped: Observed["stopped"];
  for (const [index, invocation] of plan.entries()) {
    if (Date.now() > admissionAt) {
      stopped = "admission-deadline";
      break;
    }
    // A later invocation depends on the one before it having finished
    // cleanly. A child that did not exit zero either failed its work or its
    // owner's cleanup, and nothing here can tell which, so nothing more starts.
    const previous = joins.at(-1);
    if (previous !== undefined && !succeeded(previous)) {
      stopped = "unsuccessful-owner";
      break;
    }
    reserved += invocation.prompts;
    joins.push(
      yield* invoke(selection, invocation, fixture, admissionAt, join(support, `child-${index}-stderr.txt`), environment),
    );
  }
  if (stopped === "unsuccessful-owner") {
    console.error(Refusal.cleanup);
  }

  const acknowledged: Acknowledged[] = [];
  for (const invocation of plan) {
    acknowledged.push(...((yield* readAcknowledged(invocation.journal)) ?? []));
  }
  for (const entry of acknowledged) {
    if (entry.record.status !== "completed" && entry.record.error?.message !== undefined) {
      // The host's own refusal, as the operator would have seen it.
      console.error(`Agent prompt ${entry.record.status}: ${entry.record.error.message}`);
    }
  }
  const files: Fixture = { files: [fileA, fileB, deniedFile] };
  const natives: (NativeSession | undefined)[] = [];
  for (const entry of acknowledged) {
    natives.push(yield* nativeFor(selection.agent, entry, environment, files));
  }
  const prompts: PromptReport[] = [];
  const supportRecords: unknown[] = [];
  for (const [index, entry] of acknowledged.entries()) {
    const usage = entry.record.usage;
    const native = natives[index];
    const associated = native?.associate(entry.input);
    const acpx = yield* acpxAgreement(join(environment.home, ".acpx"), usage);
    prompts.push({
      status: entry.record.status,
      usage: shareable(usage),
      checks: {
        usage: usage === undefined ? check("unavailable", "usage-unavailable") : check("verified", "usage-retained"),
        association: acpx.association,
        persistedAgreement: acpx.agreement,
        independentNative: nativeComparison(selection.agent, usage, native, entry.input),
      },
      native:
        associated === undefined
          ? undefined
          : {
              calls: associated.calls,
              toolCalls: associated.toolCalls,
              fixtureReads: associated.fixtureReads,
              subagentCalls: associated.subagentCalls,
            },
    });
    supportRecords.push({
      name: entry.name,
      sessionKey: entry.record.sessionKey,
      agentSessionId: entry.record.agentSessionId,
      usage,
      native: associated ?? null,
      nativeAssociation: native === undefined ? "native-source-unavailable" : associated === undefined ? "native-association-unavailable" : "delivered-input-in-one-native-turn",
      nativeSource: native?.source ?? null,
    });
  }
  yield* writeTextFile(join(support, "association.json"), `${JSON.stringify({ measured, prompts: supportRecords }, null, 2)}\n`);

  const observed: Observed = { acknowledged, joins, planned, natives, ...(stopped === undefined ? {} : { stopped }) };
  const scenario = scenarioChecks(selection, observed, markers, yield* exists(deniedFile), deniedFile);
  const witnessed =
    acknowledged.filter((entry) => entry.record.usage?.providerMessageId !== undefined).length +
    (selection.scenario === "cancel" && joins[0]?.cancelledAfterReady === true && acknowledged.length === 0 ? 1 : 0);
  return {
    agent: selection.agent,
    host: selection.host,
    scenario: selection.scenario,
    allowance: ALLOWANCE[selection.scenario],
    reservedPrompts: reserved,
    observedSubmissions: witnessed === reserved ? witnessed : "unknown",
    observedAtLeast: witnessed,
    acknowledgedPrompts: acknowledged.length,
    provenance: {
      xmd: {
        ...(measured.xmdVersion === undefined ? {} : { version: measured.xmdVersion }),
        ...(measured.xmdDigest === undefined ? {} : { digest: measured.xmdDigest }),
        ...(measured.sourceRevision === undefined ? {} : { sourceRevision: measured.sourceRevision }),
        ...(measured.sourceClean === undefined ? {} : { sourceClean: measured.sourceClean }),
      },
      runtime: acknowledged[0]?.record.usage?.provenance.runtime ?? {},
      adapter: acknowledged[0]?.record.usage?.provenance.adapter ?? {},
      native: {
        ...(acknowledged[0]?.record.usage?.provenance.native ?? {}),
        ...(measured.nativeVersion === undefined ? {} : { observedVersion: measured.nativeVersion }),
      },
      models: [...new Set(acknowledged.flatMap((entry) => entry.record.usage?.readings.flatMap((reading) => reading.model !== undefined && MODEL.test(reading.model) ? [reading.model] : []) ?? []))],
    },
    prompts,
    scenarioChecks: scenario,
    readback: acknowledged.length > 0 ? check("verified", "canonical-journal-read-back") : check("unavailable", "no-acknowledged-history"),
    teardown: teardownCheck(observed, plan.length),
  };
}

function teardownCheck(observed: Observed, planned: number): Check {
  if (observed.stopped === "unsuccessful-owner") {
    return check("failed", "unsuccessful-owner-stopped-admission");
  }
  if (observed.stopped === "admission-deadline") {
    return check("not_run", "admission-deadline");
  }
  if (observed.joins.length !== planned) {
    return check("not_run", "not-admitted");
  }
  if (observed.joins.every(succeeded)) {
    return check("verified", "owner-cleanup-succeeded");
  }
  // An expected Agent failure or cancellation exits nonzero like a cleanup
  // failure would: the owner joined, and its cleanup stays unproven.
  return check("unavailable", "joined-cleanup-unproven");
}

function failedBeforeWork(entry: Acknowledged | undefined): boolean {
  return entry !== undefined && entry.record.status !== "completed" && (entry.record.permissions ?? []).length === 0;
}

function scenarioChecks(
  selection: Selection,
  observed: Observed,
  markers: { a: string; b: string; r: string },
  deniedWritten: boolean,
  deniedFile: string,
): Record<string, Check> {
  const { acknowledged, joins, natives } = observed;
  const completed = acknowledged.filter((entry) => entry.record.status === "completed");
  const associated = (index: number) => {
    const entry = acknowledged[index];
    return entry === undefined ? undefined : natives[index]?.associate(entry.input);
  };
  const nativeGap = (index: number) =>
    natives[index] === undefined
      ? check("unavailable", "native-source-unavailable")
      : check("unavailable", "native-association-unavailable");
  switch (selection.scenario) {
    case "success": {
      const sameSession =
        acknowledged.length === 2 &&
        acknowledged[0].record.sessionKey === acknowledged[1].record.sessionKey &&
        acknowledged[0].record.agentSessionId !== undefined &&
        acknowledged[0].record.agentSessionId === acknowledged[1].record.agentSessionId;
      const first = associated(0);
      return {
        twoPromptsOneSession: completed.length === 2 && sameSession
          ? check("verified", "two-acknowledged-prompts-one-session")
          : acknowledged.some((entry) => entry.record.status !== "completed")
            ? check("failed", "prompts-failed")
            : check("failed", "two-prompts-not-observed"),
        multicall: first === undefined
          ? nativeGap(0)
          : first.fixtureReads >= 2 && first.fixtureFilesRead === 2
            ? check("verified", "two-separate-fixture-reads")
            : check("failed", "two-separate-fixture-reads-not-observed"),
        recall: acknowledged[1]?.record.text.includes(markers.a) && acknowledged[1]?.record.text.includes(markers.b)
          ? check("verified", "markers-recalled")
          : check("limited", "markers-not-recalled"),
      };
    }
    case "resume": {
      const [seed, continuation] = acknowledged;
      const continued =
        seed !== undefined &&
        continuation !== undefined &&
        seed.record.agentSessionId !== undefined &&
        continuation.record.agentSessionId === seed.record.agentSessionId;
      return {
        seed: seed?.record.status === "completed" && joins[0] !== undefined && succeeded(joins[0])
          ? check("verified", "seed-completed")
          : check("failed", "seed-unsuccessful"),
        separateInvocations: joins.length === 2 ? check("verified", "two-joined-invocations") : check("failed", "continuation-not-admitted"),
        exactTarget: continued && continuation?.record.status === "completed"
          ? check("verified", "exact-retained-target-continued")
          : continuation !== undefined && continuation.record.status !== "completed"
            ? check("limited", "resume-refused-no-substitute")
            : check("failed", "exact-target-not-observed"),
        recall: continuation?.record.text.includes(markers.r) === true ? check("verified", "marker-recalled") : check("limited", "marker-not-recalled"),
      };
    }
    case "failure": {
      const entry = acknowledged[0];
      const permissions = entry?.record.permissions ?? [];
      // The requested write, by what the host was asked to permit: an edit,
      // or a request that names this run's private denied file. Another tool
      // refused on the way is not the experiment.
      const requested = permissions.filter(
        (permission) => permission.kind === "edit" || (permission.title ?? "").includes(deniedFile),
      );
      const refused = requested.some((permission) => {
        const outcome = permission.outcome;
        if (outcome.outcome === "cancelled") {
          return true;
        }
        return permission.options.some((option) => option.optionId === outcome.optionId && option.kind.startsWith("reject"));
      });
      return {
        attemptedWriteRefused: refused
          ? check("verified", "host-refused-requested-native-write")
          : entry === undefined
            ? check("failed", "no-acknowledged-record")
            : failedBeforeWork(entry)
              ? check("failed", "prompt-failed-before-write")
              : check("failed", "requested-write-not-attempted"),
        nothingWritten: deniedWritten ? check("failed", "denied-file-written") : check("verified", "denied-file-absent"),
        acknowledgement: entry === undefined
          ? check("limited", "no-acknowledged-record")
          : check("verified", refused && entry.record.status === "completed" ? "acknowledged-completed-after-refusal" : `acknowledged-${entry.record.status}`),
      };
    }
    case "cancel": {
      const joined = joins[0];
      return {
        cancelledWhileActive: acknowledged.some((entry) => entry.record.status === "completed")
          ? check("failed", "prompt-completed-before-cancellation")
          : joined?.cancelledAfterReady !== true
            ? check("failed", "ready-marker-not-observed-while-active")
            : joined.unacknowledgedAtInterrupt === true && acknowledged.length === 1 && acknowledged[0].record.status === "cancelled"
              ? check("verified", "acknowledged-cancellation-after-ready-marker")
              : check("unavailable", "active-cancellation-unproven"),
        acknowledgement: acknowledged.length === 1
          ? check("verified", `acknowledged-${acknowledged[0].record.status}-partial`)
          : check("verified", "no-acknowledged-record"),
      };
    }
    case "subagent": {
      const entry = acknowledged[0];
      if (entry === undefined || entry.record.status !== "completed") {
        // Unavailability is a finding only about an experiment that ran.
        return {
          nativeSubagent: check("failed", "experiment-not-executed"),
          inclusion: check("not_run", "experiment-not-executed"),
        };
      }
      const native = associated(0);
      if (native === undefined) {
        return { nativeSubagent: nativeGap(0), inclusion: check("not_run", "no-subagent-work") };
      }
      if (native.subagentCalls > 0) {
        return {
          nativeSubagent: check("verified", "native-subagent-requested"),
          inclusion: check("limited", "subagent-inclusion-unverified"),
        };
      }
      return {
        nativeSubagent: /\bunavailable\b/iu.test(entry.record.text)
          ? check("limited", "subagents-reported-unavailable")
          : check("limited", "native-subagent-not-observed"),
        inclusion: check("not_run", "no-subagent-work"),
      };
    }
  }
}

/** Every check a selected scenario requires, and whether any of them is missing. */
function verdict(report: Report): "completed" | "limited" | "incomplete" {
  const required = Object.values(report.scenarioChecks);
  const teardown = report.teardown;
  const joined = teardown.outcome === "verified";
  if (!joined || required.some((item) => item.outcome === "failed" || (item.outcome === "not_run" && item.reason !== "no-subagent-work"))) {
    return "incomplete";
  }
  // Only a subagent experiment that actually ran may end with its native
  // evidence unavailable; every other required witness must have occurred.
  if (required.some((item) => item.outcome === "unavailable") && report.scenario !== "subagent") {
    return "incomplete";
  }
  if (report.prompts.some((prompt) => prompt.checks.persistedAgreement.outcome === "failed")) {
    return "incomplete";
  }
  const accounting = report.prompts.flatMap((prompt) => Object.values(prompt.checks));
  // Work that ran and left no acknowledged record is consumption nothing accounts for.
  const unaccounted = report.reservedPrompts > report.acknowledgedPrompts;
  const limited = unaccounted || teardown.outcome !== "verified" || [...required, ...accounting].some((item) => item.outcome !== "verified");
  return limited || report.prompts.some((prompt) => prompt.usage?.coverage.outerPrompt !== "verified") ? "limited" : "completed";
}

const COMPLETION = {
  completed: (output: string) => `Calibration completed. Read ${output}/report.md.`,
  limited: (output: string) => `Calibration completed with accounting limitations. Read ${output}/report.md.`,
  incomplete: (output: string) => `Calibration incomplete. Read ${output}/report.md before attempting another run.`,
};

function* writeIndex(output: string): Operation<void> {
  const files: { path: string; sha256: string }[] = [];
  function* visit(directory: string, prefix: string): Operation<void> {
    for (const name of (yield* readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if ((yield* stat(path)).isDirectory()) {
        if (name !== "fixture") {
          yield* visit(path, relative);
        }
      } else if (name !== "evidence-index.json") {
        files.push({ path: relative, sha256: yield* digestOf(path) });
      }
    }
  }
  yield* visit(output, "");
  yield* writeTextFile(join(output, "evidence-index.json"), `${JSON.stringify({ files }, null, 2)}\n`);
}

/**
 * Keep children's output to this program: a child's own chatter is not the
 * report, and what the run measured is read from its journal and evidence.
 */
function* quietChildren(): Operation<void> {
  yield* Stdio.around(
    {
      *stdout() {
        return;
      },
      *stderr() {
        return;
      },
    },
    { at: "min" },
  );
}

export function* calibrate(
  args: readonly string[],
  environment: CalibrationEnvironment = approvedEnvironment(),
): Operation<number> {
  // The admission clock covers the whole command, preparation included.
  const start = Date.now();
  const parsed = parseSelection(args);
  if (parsed.kind === "help") {
    console.log(HELP);
    return 0;
  }
  if (parsed.kind === "refused") {
    console.error(parsed.message);
    return 1;
  }
  const selection = parsed.selection;
  yield* quietChildren();
  const output = resolve(selection.output);
  yield* ensureDir(dirname(output));
  try {
    yield* until(mkdir(output));
  } catch {
    console.error(Refusal.exists(output));
    return 1;
  }
  const report = yield* runScenario(selection, output, start, environment);
  const outcome = verdict(report);
  try {
    yield* writeTextFile(join(output, "report.json"), `${JSON.stringify({ ...report, result: outcome }, null, 2)}\n`);
    yield* writeTextFile(join(output, "report.md"), renderMarkdown(report, outcome));
    yield* writeIndex(output);
  } catch (error) {
    // The paid work already happened and is not repeated; no report is
    // claimed where none could be written.
    console.error(`Calibration report could not be written: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log(COMPLETION[outcome](output));
  return outcome === "incomplete" ? 1 : 0;
}

if (import.meta.main) {
  await main(function* (args) {
    const status = yield* calibrate(args);
    if (status !== 0) {
      yield* exit(status);
    }
  });
}
