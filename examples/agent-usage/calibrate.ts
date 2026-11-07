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
import type { Acknowledged, Check, NativeSession } from "./evidence.ts";
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
  /** Cancel once the live Agent output says this, while the work is still active. */
  readonly cancelOn?: string;
}

/** How one child ended, observed by joining it. */
interface Joined {
  readonly started: boolean;
  readonly code?: number;
  readonly signal?: string;
  /** The cancellation marker was seen while the work was still active, and cancellation was sent. */
  readonly cancelledAfterReady?: boolean;
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

function* measure(selection: Selection, cwd: string): Operation<Measured> {
  const version = (yield* firstLine([...hostCommand(selection), "--version"], cwd))?.match(VERSION_TOKEN)?.[0];
  // The executable the bundled adapter would bind, when the host names one.
  const bound =
    selection.agent === "claude" ? process.env.CLAUDE_CODE_EXECUTABLE : process.env.CODEX_PATH;
  const native = (yield* firstLine([bound ?? selection.agent, "--version"], cwd))?.match(VERSION_TOKEN)?.[0];
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
 * actually said it while its work is still active. Nothing is copied.
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
 * Run one child host invocation to its joined end.
 *
 * A deadline or readiness marker sends the child an interrupt, which is the
 * host's own structured cancellation, and then joins it: nothing is detached
 * or killed to make a report timely.
 */
function* invoke(
  selection: Selection,
  invocation: Invocation,
  cwd: string,
  deadlineAt: number,
  stderrPath: string,
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
    let deadline = false;
    const workDeadline = Math.min(deadlineAt, started + invocation.prompts * PROMPT_SECONDS * 1000 + 30_000);
    const status = yield* race([
      child.join(),
      (function* (): Operation<never> {
        while (true) {
          yield* sleep(250);
          if (invocation.cancelOn !== undefined && !cancelledAfterReady) {
            if (yield* readyInAcpx(join(homedir(), ".acpx"), invocation.cancelOn, started)) {
              cancelledAfterReady = true;
              process.kill(child.pid, "SIGINT");
            }
          }
          if (!deadline && Date.now() > workDeadline) {
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
      ...(status.code === undefined ? {} : { code: status.code }),
      ...(status.signal === undefined ? {} : { signal: status.signal }),
      ...(invocation.cancelOn === undefined ? {} : { cancelledAfterReady }),
      ...(deadline ? { deadline } : {}),
    };
  });
}

function* nativeFor(agent: Selection["agent"], record: Acknowledged | undefined): Operation<NativeSession | undefined> {
  const id = record?.record.agentSessionId;
  if (id === undefined) {
    return undefined;
  }
  try {
    return agent === "claude" ? yield* claudeNative(homedir(), id) : yield* codexNative(homedir(), id);
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
      return model !== undefined && /^[A-Za-z0-9._:\-[\]]{1,80}$/u.test(model) ? reading : rest;
    }),
    coverage: usage.coverage,
  };
}

function* runScenario(selection: Selection, output: string): Operation<Report> {
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
  const submissions = plan.reduce((sum, invocation) => sum + invocation.prompts, 0);
  if (submissions > ALLOWANCE[selection.scenario]) {
    throw new Error("the scenario plans more outer Prompts than its allowance");
  }

  const start = Date.now();
  const admissionAt = start + ADMISSION_SECONDS * 1000;
  const measured = yield* measure(selection, fixture);
  const joins: Joined[] = [];
  let admitted = 0;
  let stopped: string | undefined;
  for (const [index, invocation] of plan.entries()) {
    if (Date.now() > admissionAt) {
      stopped = "admission-deadline";
      break;
    }
    admitted += invocation.prompts;
    const joined = yield* invoke(selection, invocation, fixture, admissionAt, join(support, `child-${index}-stderr.txt`));
    joins.push(joined);
    if (joined.code === undefined && joined.signal !== undefined && joined.signal !== "SIGINT") {
      stopped = "cleanup-failed";
      break;
    }
  }

  const acknowledged: Acknowledged[] = [];
  for (const invocation of plan) {
    acknowledged.push(...((yield* readAcknowledged(invocation.journal)) ?? []));
  }
  const firstNative = yield* nativeFor(selection.agent, acknowledged[0]);
  const prompts: PromptReport[] = [];
  const supportRecords: unknown[] = [];
  for (const [index, entry] of acknowledged.entries()) {
    const usage = entry.record.usage;
    const native = selection.scenario === "resume" ? (yield* nativeFor(selection.agent, entry))?.prompts.at(index) : firstNative?.prompts[index];
    const acpx = yield* acpxAgreement(join(homedir(), ".acpx"), usage);
    prompts.push({
      status: entry.record.status,
      usage: shareable(usage),
      checks: {
        usage: usage === undefined ? check("unavailable", "usage-unavailable") : check("verified", "usage-retained"),
        association: acpx.association,
        persistedAgreement: acpx.agreement,
        independentNative: nativeComparison(selection.agent, usage, native),
      },
      native: native === undefined ? undefined : { calls: native.calls, toolCalls: native.toolCalls, subagentCalls: native.subagentCalls },
    });
    supportRecords.push({
      name: entry.name,
      sessionKey: entry.record.sessionKey,
      agentSessionId: entry.record.agentSessionId,
      usage,
      native: native ?? null,
      nativeSource: firstNative?.source ?? null,
    });
  }
  yield* writeTextFile(join(support, "association.json"), `${JSON.stringify({ measured, prompts: supportRecords }, null, 2)}\n`);

  const scenario = scenarioChecks(selection, acknowledged, joins, firstNative, markers, yield* exists(deniedFile));
  const teardown = stopped === "cleanup-failed"
    ? check("failed", "owned-cleanup-failed")
    : joins.length === plan.length
      ? check("verified", "owner-joined")
      : check("not_run", stopped ?? "not-admitted");
  return {
    agent: selection.agent,
    host: selection.host,
    scenario: selection.scenario,
    allowance: ALLOWANCE[selection.scenario],
    submittedPrompts: admitted,
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
      models: [...new Set(acknowledged.flatMap((entry) => entry.record.usage?.readings.flatMap((reading) => reading.model !== undefined && /^[A-Za-z0-9._:\-[\]]{1,80}$/u.test(reading.model) ? [reading.model] : []) ?? []))],
    },
    prompts,
    scenarioChecks: scenario,
    readback: acknowledged.length > 0 ? check("verified", "canonical-journal-read-back") : check("unavailable", "no-acknowledged-history"),
    teardown,
  };
}

function scenarioChecks(
  selection: Selection,
  acknowledged: Acknowledged[],
  joins: Joined[],
  native: NativeSession | undefined,
  markers: { a: string; b: string; r: string },
  deniedWritten: boolean,
): Record<string, Check> {
  const completed = acknowledged.filter((entry) => entry.record.status === "completed");
  switch (selection.scenario) {
    case "success": {
      const sameSession =
        acknowledged.length === 2 &&
        acknowledged[0].record.sessionKey === acknowledged[1].record.sessionKey &&
        acknowledged[0].record.agentSessionId !== undefined &&
        acknowledged[0].record.agentSessionId === acknowledged[1].record.agentSessionId;
      const reads = native?.prompts[0]?.toolCalls;
      return {
        twoPromptsOneSession: completed.length === 2 && sameSession
          ? check("verified", "two-acknowledged-prompts-one-session")
          : check("failed", "two-prompts-not-observed"),
        multicall: reads === undefined
          ? check("unavailable", "native-tool-evidence-unavailable")
          : reads >= 2
            ? check("verified", "two-or-more-native-tool-calls")
            : check("failed", "fewer-than-two-native-tool-calls"),
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
        separateInvocations: joins.length === 2 ? check("verified", "two-joined-invocations") : check("failed", "separate-invocation-not-observed"),
        exactTarget: continued && continuation?.record.status === "completed"
          ? check("verified", "exact-retained-target-continued")
          : continuation !== undefined && continuation.record.status !== "completed"
            ? check("limited", "resume-refused-no-substitute")
            : check("failed", "exact-target-not-observed"),
        recall: continuation?.record.text.includes(markers.r) === true ? check("verified", "marker-recalled") : check("limited", "marker-not-recalled"),
      };
    }
    case "failure": {
      const refused = acknowledged[0]?.record.permissions?.some((permission) =>
        permission.outcome.outcome === "cancelled" ||
        permission.options.some((option) => option.optionId === (permission.outcome.outcome === "selected" ? permission.outcome.optionId : "") && option.kind.startsWith("reject")),
      );
      return {
        attemptedWriteRefused: refused === true
          ? check("verified", "host-refused-attempted-native-write")
          : check("failed", "native-write-not-attempted"),
        nothingWritten: deniedWritten ? check("failed", "denied-file-written") : check("verified", "denied-file-absent"),
        acknowledgement: acknowledged.length === 1
          ? check("verified", `acknowledged-${acknowledged[0].record.status}`)
          : check("limited", "no-acknowledged-record"),
      };
    }
    case "cancel": {
      const joined = joins[0];
      return {
        cancelledWhileActive: joined?.cancelledAfterReady === true
          ? check("verified", "cancelled-after-ready-marker")
          : check("failed", "ready-marker-not-observed-while-active"),
        acknowledgement: acknowledged.length === 1
          ? check("verified", `acknowledged-${acknowledged[0].record.status}-partial`)
          : check("verified", "no-acknowledged-record"),
      };
    }
    case "subagent": {
      const observed = native?.prompts[0]?.subagentCalls;
      return {
        nativeSubagent: observed === undefined
          ? check("unavailable", "native-source-unavailable")
          : observed > 0
            ? check("verified", "native-subagent-work-observed")
            : check("limited", "native-subagent-not-observed"),
        inclusion: observed !== undefined && observed > 0
          ? check("limited", "subagent-inclusion-unverified")
          : check("not_run", "no-subagent-work"),
      };
    }
  }
}

/** Every check a selected scenario requires, and whether any of them is missing. */
function verdict(report: Report): "completed" | "limited" | "incomplete" {
  const required = Object.values(report.scenarioChecks);
  if (report.teardown.outcome !== "verified" || required.some((item) => item.outcome === "failed" || item.outcome === "not_run" && item.reason !== "no-subagent-work")) {
    return "incomplete";
  }
  if (required.some((item) => item.outcome === "unavailable") && report.scenario !== "subagent") {
    return "incomplete";
  }
  if (report.prompts.some((prompt) => prompt.checks.persistedAgreement.outcome === "failed")) {
    return "incomplete";
  }
  const accounting = report.prompts.flatMap((prompt) => Object.values(prompt.checks));
  const limited = [...required, ...accounting].some((item) => item.outcome !== "verified");
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

export function* calibrate(args: readonly string[]): Operation<number> {
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
  const report = yield* runScenario(selection, output);
  const outcome = verdict(report);
  try {
    yield* writeTextFile(join(output, "report.json"), `${JSON.stringify({ ...report, result: outcome }, null, 2)}\n`);
    yield* writeTextFile(join(output, "report.md"), renderMarkdown(report, outcome));
    yield* writeIndex(output);
  } catch (error) {
    console.error(`Calibration report could not be written: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (report.teardown.outcome === "failed") {
    console.error(Refusal.cleanup);
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
