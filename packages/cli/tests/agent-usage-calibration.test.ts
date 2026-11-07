/**
 * Tier UC — the usage calibration driver (examples/agent-usage/README.md).
 *
 * The grammar and its refusals, and one complete experiment through the
 * production source CLI against the controlled native Claude fixture — no
 * credentials and no model call. A controlled agent leaves no native
 * transcript, so the experiment must end incomplete, keep what it did measure,
 * and keep every private identity, path and marker out of the shareable report.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, readTextFile, rm } from "@effectionx/fs";
import { exec } from "@executablemd/runtime";
import { useQuietProcessOutput } from "@executablemd/runtime";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { HELP, parseSelection, Refusal } from "../../../examples/agent-usage/selection.ts";
import { calibrate } from "../../../examples/agent-usage/calibrate.ts";
import type { CalibrationEnvironment } from "../../../examples/agent-usage/calibrate.ts";
import { chmod } from "node:fs/promises";
import { until } from "effection";
import {
  claudeNative,
  codexNative,
  nativeComparison,
} from "../../../examples/agent-usage/evidence.ts";
import type { PromptUsage } from "@executablemd/core";
import { readdir as readdirOf, writeTextFile } from "@effectionx/fs";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DRIVER = join(CHECKOUT, "examples/agent-usage/calibrate.ts");
const FAKE_CLAUDE = join(CHECKOUT, "packages/acp/tests/fixtures/fake-claude-cli.cjs");

function* useRoot(): Operation<string> {
  const root = join(tmpdir(), `xmd-uc-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The parent's environment, without the members it does not set. */
function inherited(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}

function* driver(
  args: string[],
  env: Record<string, string> = {},
): Operation<{ code: number; stdout: string; stderr: string }> {
  return yield* scoped(function* () {
    yield* useQuietProcessOutput();
    const result = yield* exec({
      command: [process.execPath, "run", "--allow-all", "--frozen", DRIVER, ...args],
      env: { ...inherited(), ...env },
      retain: true,
      timeout: 300_000,
    });
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  });
}

describe("Tier UC — usage calibration driver", () => {
  it("UC1: the grammar selects exactly one experiment and refuses everything else first", function* () {
    const valid = ["--host=source", "--agent=claude", "--scenario=success", "--output=/o"];
    expect(parseSelection(["--help", "--bogus"])).toEqual({ kind: "help" });
    expect(parseSelection([...valid, "--allow-paid"])).toEqual({
      kind: "selected",
      selection: { host: "source", agent: "claude", scenario: "success", output: "/o" },
    });
    expect(parseSelection(valid)).toEqual({ kind: "refused", message: Refusal.paid });
    const unsupported = { kind: "refused", message: Refusal.unsupported };
    for (const args of [
      [...valid, "--allow-paid", "--scenario=resume"],
      [...valid, "--allow-paid", "--allow-paid"],
      [...valid, "--allow-paid", "positional"],
      [...valid, "--allow-paid", "--colour=red"],
      ["--host=source", "--agent=gemini", "--scenario=success", "--output=/o", "--allow-paid"],
      ["--host=source", "--agent=claude", "--scenario=everything", "--output=/o", "--allow-paid"],
      ["--host=source", "--agent=claude", "--scenario=success", "--allow-paid"],
      ["--host=source", "--agent=claude", "--scenario=success", "--output=", "--allow-paid"],
      [...valid, "--xmd=/bin/xmd", "--allow-paid"],
    ]) {
      expect(parseSelection(args)).toEqual(unsupported);
    }
    const compiled = [
      "--host=compiled",
      "--agent=codex",
      "--scenario=cancel",
      "--output=/o",
      "--allow-paid",
    ];
    expect(parseSelection(compiled)).toEqual({ kind: "refused", message: Refusal.compiled });
    expect(parseSelection([...compiled, "--xmd=relative/xmd"])).toEqual({
      kind: "refused",
      message: Refusal.compiled,
    });
    expect(parseSelection([...compiled, "--xmd=/abs/xmd"])).toEqual({
      kind: "selected",
      selection: {
        host: "compiled",
        agent: "codex",
        scenario: "cancel",
        output: "/o",
        xmd: "/abs/xmd",
      },
    });
  });

  it("UC2: help and refusals print their exact text and create nothing", function* () {
    const root = yield* useRoot();
    const help = yield* driver(["--help"]);
    expect([help.code, help.stdout.trim()]).toEqual([0, HELP.trim()]);
    const output = join(root, "never");
    const refused = yield* driver([
      "--host=source",
      "--agent=claude",
      "--scenario=success",
      `--output=${output}`,
    ]);
    expect([refused.code, refused.stderr.trim(), refused.stdout]).toEqual([1, Refusal.paid, ""]);
    expect(yield* exists(output)).toBe(false);
    yield* ensureDir(join(root, "taken"));
    const taken = yield* driver([
      "--host=source",
      "--agent=claude",
      "--scenario=success",
      `--output=${join(root, "taken")}`,
      "--allow-paid",
    ]);
    expect([taken.code, taken.stderr.trim()]).toEqual([1, Refusal.exists(join(root, "taken"))]);
  });

  it("UC3: a controlled experiment keeps what it measured, ends incomplete and shares no private value", function* () {
    const root = yield* useRoot();
    const output = join(root, "claude-source-success");
    const ran = yield* driver(
      [
        "--host=source",
        "--agent=claude",
        "--scenario=success",
        `--output=${output}`,
        "--allow-paid",
      ],
      { CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE },
    );
    expect([ran.code, ran.stdout.trim()]).toEqual([
      1,
      `Calibration incomplete. Read ${output}/report.md before attempting another run.`,
    ]);
    const report = JSON.parse(yield* readTextFile(join(output, "report.json")));
    expect(report.result).toBe("incomplete");
    // Both Prompts were reserved, and both are witnessed as submitted by the
    // user message the runtime generated for each.
    expect([
      report.allowance,
      report.reservedPrompts,
      report.observedSubmissions,
      report.acknowledgedPrompts,
    ]).toEqual([2, 2, 2, 2]);
    expect(report.scenarioChecks.twoPromptsOneSession.outcome).toBe("verified");
    // A controlled agent writes no native transcript: the required multicall
    // witness is missing, which is incomplete calibration, not a pass.
    expect(report.scenarioChecks.multicall).toEqual({
      outcome: "unavailable",
      reason: "native-source-unavailable",
    });
    expect(report.teardown).toEqual({ outcome: "verified", reason: "owner-cleanup-succeeded" });
    for (const prompt of report.prompts) {
      expect(prompt.checks.usage.outcome).toBe("verified");
      expect(prompt.checks.association).toEqual({
        outcome: "verified",
        reason: "generated-message-in-owning-record",
      });
      expect(prompt.checks.persistedAgreement.outcome).toBe("verified");
    }
    expect(report.provenance.adapter.version).toBe("0.70.0");
    const support = JSON.parse(yield* readTextFile(join(output, "support/association.json")));
    const privateValues: string[] = [output, root];
    for (const prompt of support.prompts) {
      privateValues.push(
        prompt.usage.providerMessageId,
        prompt.usage.providerRecordId,
        prompt.sessionKey,
      );
    }
    for (const file of ["report.json", "report.md"]) {
      const shared = yield* readTextFile(join(output, file));
      for (const value of privateValues) {
        expect({ file, leaked: shared.includes(value) }).toEqual({ file, leaked: false });
      }
      expect(shared.includes("USAGE-A-")).toBe(false);
    }
    const index = JSON.parse(yield* readTextFile(join(output, "evidence-index.json")));
    expect(index.files.map((file: { path: string }) => file.path)).toEqual(
      expect.arrayContaining([
        "report.json",
        "report.md",
        "success.jsonl",
        "support/association.json",
      ]),
    );
  });

  it("UC5: an ordinary run retains usage only in the journal it was asked to keep", function* () {
    const root = yield* useRoot();
    const document = join(root, "doc.md");
    yield* writeTextFile(document, '<Agent name="claude"><Prompt>measure me</Prompt></Agent>\n');
    const cli = [
      process.execPath,
      "run",
      "--allow-all",
      "--frozen",
      join(CHECKOUT, "packages/cli/src/deno.ts"),
    ];
    const runOnce = (extra: string[]) =>
      scoped(function* () {
        yield* useQuietProcessOutput();
        return yield* exec({
          command: [...cli, "run", document, ...extra],
          cwd: root,
          env: { ...inherited(), CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE },
          retain: true,
          timeout: 120_000,
        });
      });
    const transient = yield* runOnce([]);
    expect(transient.exitCode).toBe(0);
    expect((yield* readdirOf(root)).sort()).toEqual(["doc.md"]);
    const journal = join(root, "run.jsonl");
    const retained = yield* runOnce(["--journal", journal]);
    expect(retained.exitCode).toBe(0);
    expect((yield* readdirOf(root)).sort()).toEqual(["doc.md", "run.jsonl"]);
    const records = (yield* readTextFile(journal))
      .split("\n")
      .filter((line) => line.includes('"agent_prompt"'))
      .map((line) => JSON.parse(line).result.value);
    expect(records.length).toBe(1);
    expect(records[0].usage.provenance.host).toBe("deno-source");
    expect(records[0].usage.provenance.adapter.version).toBe("0.70.0");
  });

  it("UC11: Plan retains its writer's usage only in the journal it was asked to keep", function* () {
    const root = yield* useRoot();
    const cli = [
      process.execPath,
      "run",
      "--allow-all",
      "--frozen",
      join(CHECKOUT, "packages/cli/src/deno.ts"),
    ];
    const plan = (extra: string[]) =>
      scoped(function* () {
        yield* useQuietProcessOutput();
        return yield* exec({
          command: [
            ...cli,
            "plan",
            "write a hello document",
            "--default-agent",
            "claude",
            ...extra,
          ],
          cwd: root,
          env: { ...inherited(), CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE },
          retain: true,
          timeout: 180_000,
        });
      });
    // The controlled writer cannot produce a valid program, so Plan ends
    // unsuccessfully either way; what is asserted is where its turns went.
    yield* plan([]);
    expect(yield* readdirOf(root)).toEqual([]);
    yield* plan(["--journal", join(root, "plan.jsonl")]);
    expect(yield* readdirOf(root)).toEqual(["plan.jsonl"]);
    const records = (yield* readTextFile(join(root, "plan.jsonl")))
      .split("\n")
      .filter((line) => line.includes('"agent_prompt"'))
      .map((line) => JSON.parse(line).result.value);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.usage.provenance.host).toBe("deno-source");
      expect(record.usage.provenance.adapter.version).toBe("0.70.0");
    }
  });

  it("UC4: native accounts count distinct calls, separate a whole Prompt from its final request, and associate exactly", function* () {
    const home = yield* useRoot();
    const fixture = { files: ["/fixture/a.txt", "/fixture/b.txt"] };
    const codex = join(home, ".codex", "sessions", "2026", "11", "07");
    yield* ensureDir(codex);
    const total = (input: number, output: number) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    });
    const userTurn = (text: string) => ({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    const command = (id: string, path: string) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id,
          cwd: "/fixture",
          parsed_cmd: [{ type: "read", path }],
        },
      },
    });
    const rollout = [
      { type: "event_msg", payload: { type: "task_started" } },
      userTurn("<environment_context/>\nread both fixture files"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1" } },
      command("i1", "a.txt"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c2" } },
      command("i2", "b.txt"),
      {
        type: "response_item",
        payload: { type: "function_call", name: "spawn_agent", call_id: "c3" },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: total(100, 10), last_token_usage: total(100, 10) },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: total(250, 15), last_token_usage: total(150, 5) },
        },
      },
      { type: "event_msg", payload: { type: "task_started" } },
      userTurn("repeat them"),
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: total(400, 20), last_token_usage: total(150, 5) },
        },
      },
    ];
    yield* writeTextFile(
      join(codex, "rollout-2026-11-07T00-00-00-thread-1.jsonl"),
      rollout.map((line) => JSON.stringify(line)).join("\n"),
    );
    const read = yield* codexNative(home, "thread-1", fixture);
    expect(
      read?.prompts.map(
        ({ calls, toolCalls, fixtureReads, fixtureFilesRead, subagentCalls, outer }) => ({
          calls,
          toolCalls,
          fixtureReads,
          fixtureFilesRead,
          subagentCalls,
          total: outer?.total_tokens,
        }),
      ),
    ).toEqual([
      {
        calls: 2,
        toolCalls: 3,
        fixtureReads: 2,
        fixtureFilesRead: 2,
        subagentCalls: 1,
        total: 265,
      },
      {
        calls: 1,
        toolCalls: 0,
        fixtureReads: 0,
        fixtureFilesRead: 0,
        subagentCalls: 0,
        total: 155,
      },
    ]);
    // Association is by the delivered input in exactly one native turn of the
    // confirmed session, never by position.
    expect(read?.associate("read both fixture files")).toBe(read?.prompts[0]);
    expect(read?.associate("repeat them")).toBe(read?.prompts[1]);
    expect(read?.associate("a Prompt this session never saw")).toBe(undefined);
    expect(read?.associate("re")).toBe(undefined);
    const lastOnly = usageWith({
      inputTokens: 150,
      outputTokens: 5,
      cachedReadTokens: 0,
      thoughtTokens: 0,
      totalTokens: 155,
    });
    expect(nativeComparison("codex", lastOnly, read, "read both fixture files")).toEqual({
      outcome: "limited",
      reason: "final-request-only",
    });
    expect(nativeComparison("codex", lastOnly, read, "repeat them")).toEqual({
      outcome: "verified",
      reason: "matches-native-outer-total",
    });
    expect(nativeComparison("codex", lastOnly, read, "unknown input")).toEqual({
      outcome: "unavailable",
      reason: "native-association-unavailable",
    });
    expect(nativeComparison("codex", lastOnly, undefined, "repeat them")).toEqual({
      outcome: "unavailable",
      reason: "native-source-unavailable",
    });

    const claude = join(home, ".claude", "projects", "-fixture");
    yield* ensureDir(claude);
    const usage = {
      input_tokens: 3,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const reads = [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/fixture/a.txt" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/fixture/b.txt" } },
    ];
    const transcript = [
      { type: "user", message: { content: "read the files" } },
      { type: "user", isMeta: true, message: { content: "a reminder" } },
      // One API message, logged once per content block: one model call and
      // two distinct tool calls, however many times the entry repeats.
      { type: "assistant", message: { id: "m1", usage, content: reads } },
      { type: "assistant", message: { id: "m1", usage, content: reads } },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      { type: "assistant", isSidechain: true, message: { id: "s1", usage, content: [] } },
      { type: "assistant", message: { id: "m2", usage, content: [{ type: "text" }] } },
    ];
    yield* writeTextFile(
      join(claude, "session-1.jsonl"),
      transcript.map((line) => JSON.stringify(line)).join("\n"),
    );
    const main = yield* claudeNative(home, "session-1", fixture);
    expect(main?.prompts).toEqual([
      {
        calls: 2,
        toolCalls: 2,
        fixtureReads: 2,
        fixtureFilesRead: 2,
        outer: {
          input_tokens: 6,
          output_tokens: 4,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        subagent: {
          input_tokens: 3,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        subagentCalls: 1,
      },
    ]);
    expect(
      nativeComparison(
        "claude",
        usageWith({
          inputTokens: 6,
          outputTokens: 4,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          totalTokens: 10,
        }),
        main,
        "read the files",
      ),
    ).toEqual({ outcome: "verified", reason: "matches-native-outer-total-multicall" });
  });

  it("UC6: an unsuccessful seed stops its continuation; a successful seed admits it", function* () {
    const failed = yield* controlled({ "resume-seed.md": { exit: 1 } });
    const stopped = yield* runControlled(failed, "resume");
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain(Refusal.cleanup);
    expect(yield* documents(failed)).toEqual(["resume-seed.md:started"]);
    const report = JSON.parse(yield* readTextFile(join(stopped.output, "report.json")));
    expect(report.teardown).toEqual({
      outcome: "failed",
      reason: "unsuccessful-owner-stopped-admission",
    });
    expect(report.scenarioChecks.seed).toEqual({ outcome: "failed", reason: "seed-unsuccessful" });
    expect(report.scenarioChecks.separateInvocations.reason).toBe("continuation-not-admitted");
    expect([report.reservedPrompts, report.observedSubmissions]).toEqual([1, "unknown"]);
    expect(report.result).toBe("incomplete");
    // Earlier evidence survives the stop.
    expect(yield* exists(join(stopped.output, "support/child-0-stderr.txt"))).toBe(true);

    const control = yield* controlled({ "resume-seed.md": { exit: 0 } });
    const admitted = yield* runControlled(control, "resume");
    expect(yield* documents(control)).toEqual([
      "resume-seed.md:started",
      "resume-continuation.md:started",
    ]);
    expect(admitted.stderr).not.toContain(Refusal.cleanup);
    const controlReport = JSON.parse(yield* readTextFile(join(admitted.output, "report.json")));
    expect(controlReport.teardown).toEqual({
      outcome: "verified",
      reason: "owner-cleanup-succeeded",
    });
    expect(controlReport.reservedPrompts).toBe(2);
  });

  it("UC7: cancellation waits for the ready marker while work is active, then joins the owner", function* () {
    const host = yield* controlled({ "cancel.md": { ready: true, hold: true, cleanupMs: 300 } });
    const ran = yield* runControlled(host, "cancel");
    expect(yield* documents(host)).toEqual([
      "cancel.md:started",
      "cancel.md:interrupted",
      "cancel.md:cleaned",
    ]);
    const report = JSON.parse(yield* readTextFile(join(ran.output, "report.json")));
    expect(report.scenarioChecks.cancelledWhileActive).toEqual({
      outcome: "verified",
      reason: "cancelled-after-ready-marker",
    });
    expect(report.scenarioChecks.acknowledgement.reason).toBe("no-acknowledged-record");
    expect(report.teardown).toEqual({ outcome: "limited", reason: "joined-cleanup-unproven" });
    expect([
      report.reservedPrompts,
      report.observedSubmissions,
      report.acknowledgedPrompts,
    ]).toEqual([1, 1, 0]);
    // Submitted work with no acknowledged record is an accounting gap.
    expect([ran.status, report.result]).toEqual([0, "limited"]);
  });

  it("UC8: the admission deadline interrupts owned work, waits for its held cleanup and admits nothing later", function* () {
    const host = yield* controlled({ "resume-seed.md": { hold: true, cleanupMs: 400 } });
    const ran = yield* runControlled(host, "resume", { admissionMs: 300, promptMs: 10_000 });
    expect(ran.status).toBe(1);
    // Joined only after the held cleanup finished; the continuation never started.
    expect(yield* documents(host)).toEqual([
      "resume-seed.md:started",
      "resume-seed.md:interrupted",
      "resume-seed.md:cleaned",
    ]);
    expect(ran.elapsedMs).toBeGreaterThanOrEqual(700);
    const report = JSON.parse(yield* readTextFile(join(ran.output, "report.json")));
    expect(report.teardown).toEqual({ outcome: "not_run", reason: "admission-deadline" });
    expect(report.result).toBe("incomplete");
  });

  it("UC9: a report that cannot be written is said so once, with no completion line and no retry", function* () {
    const host = yield* controlled({ "failure.md": { exit: 1, blockReport: true } });
    const ran = yield* runControlled(host, "failure");
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("Calibration report could not be written");
    expect(ran.stdout).not.toContain("Calibration completed");
    expect(ran.stdout).not.toContain("Calibration incomplete");
    expect(yield* documents(host)).toEqual(["failure.md:started"]);
  });

  it("UC10: a Prompt that failed before the experiment is missing execution, not a limitation", function* () {
    for (const scenario of ["failure", "subagent"]) {
      const host = yield* controlled({
        [`${scenario}.md`]: { exit: 1, failedRecord: "Failed to authenticate: controlled refusal" },
      });
      const ran = yield* runControlled(host, scenario);
      const report = JSON.parse(yield* readTextFile(join(ran.output, "report.json")));
      // The host's own refusal reaches the operator; the report says only
      // which required witness is missing.
      expect(ran.stderr).toContain(
        "Agent prompt failed: Failed to authenticate: controlled refusal",
      );
      expect(JSON.stringify(report).includes("controlled refusal")).toBe(false);
      expect([ran.status, report.result]).toEqual([1, "incomplete"]);
      expect(
        scenario === "failure"
          ? report.scenarioChecks.attemptedWriteRefused
          : report.scenarioChecks.nativeSubagent,
      ).toEqual(
        scenario === "failure"
          ? { outcome: "failed", reason: "prompt-failed-before-write" }
          : { outcome: "failed", reason: "experiment-not-executed" },
      );
    }
  });
});

function usageWith(tokens: Record<string, number>): PromptUsage {
  return {
    provenance: { host: "compiled", xmd: {}, runtime: {}, adapter: {} },
    readings: [
      { source: "response", scope: "last-request", kind: "tokens", counter: "snapshot", tokens },
    ],
    coverage: { finalReport: "received", outerPrompt: "partial", limitations: [] },
  };
}

/** What one controlled host does for each scenario document it is asked to run. */
interface Behaviors {
  readonly [document: string]: {
    readonly exit?: number;
    /** Write ACPX's live record of the Agent saying the ready marker. */
    readonly ready?: boolean;
    /** Keep working until interrupted. */
    readonly hold?: boolean;
    /** How long cleanup takes after an interrupt. */
    readonly cleanupMs?: number;
    /** Make the run's report impossible to write. */
    readonly blockReport?: boolean;
    /** Acknowledge one failed Prompt with this error before doing anything else. */
    readonly failedRecord?: string;
  };
}

interface Controlled {
  readonly root: string;
  readonly host: string;
  readonly log: string;
  readonly home: string;
}

/**
 * A controlled stand-in for a compiled XMD host: it answers its version, logs
 * each document it is asked to run, and behaves as the case says. It starts no
 * agent and sends no Prompt.
 */
function* controlled(behaviors: Behaviors): Operation<Controlled> {
  const root = yield* useRoot();
  const home = join(root, "home");
  const log = join(root, "invocations.jsonl");
  const host = join(root, "controlled-xmd.cjs");
  yield* ensureDir(home);
  const config = JSON.stringify({ behaviors, log, home });
  yield* writeTextFile(
    host,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const config = ${config};
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("controlled-host 0.0.0");
  process.exit(0);
}
const document = path.basename(args[1]);
const journal = args[args.indexOf("--journal") + 1];
const prop = (name) => args[args.indexOf("--props-" + name) + 1];
const note = (event) => fs.appendFileSync(config.log, JSON.stringify({ document, event }) + "\\n");
note("started");
const behavior = config.behaviors[document] ?? { exit: 0 };
if (behavior.failedRecord) {
  const event = {
    type: "yield",
    coroutineId: "root",
    description: { type: "agent_prompt", name: "prompt:controlled#0", input: "controlled" },
    result: {
      status: "ok",
      value: { sequence: 0, agent: "codex", sessionKey: "controlled", status: "failed", text: "", error: { message: behavior.failedRecord } },
    },
  };
  fs.writeFileSync(journal, JSON.stringify(event) + "\\n");
}
if (behavior.blockReport) {
  fs.mkdirSync(path.join(path.dirname(journal), "report.json"), { recursive: true });
}
if (behavior.ready) {
  const sessions = path.join(config.home, ".acpx", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const record = {
    messages: [
      { User: { content: [{ Text: prop("first") }] } },
      { Agent: { content: [{ Text: "USAGE_CALIBRATION_READY" }] } },
    ],
  };
  fs.writeFileSync(path.join(sessions, "controlled.json"), JSON.stringify(record));
}
if (behavior.hold) {
  process.on("SIGINT", () => {
    note("interrupted");
    setTimeout(() => {
      note("cleaned");
      process.exit(130);
    }, behavior.cleanupMs ?? 0);
  });
  setInterval(() => {}, 1000);
} else {
  process.exit(behavior.exit ?? 0);
}
`,
  );
  yield* until(chmod(host, 0o755));
  return { root, host, log, home };
}

function* documents(host: Controlled): Operation<string[]> {
  if (!(yield* exists(host.log))) {
    return [];
  }
  return (yield* readTextFile(host.log))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const { document, event } = JSON.parse(line);
      return `${document}:${event}`;
    });
}

/** Run the driver in this process against a controlled host, with short clocks. */
function* runControlled(
  host: Controlled,
  scenario: string,
  clocks: Partial<CalibrationEnvironment> = {},
): Operation<{
  status: number;
  stdout: string;
  stderr: string;
  output: string;
  elapsedMs: number;
}> {
  const output = join(host.root, `codex-compiled-${scenario}`);
  const environment: CalibrationEnvironment = {
    promptMs: 5_000,
    admissionMs: 30_000,
    slackMs: 0,
    pollMs: 25,
    home: host.home,
    native: host.host,
    ...clocks,
  };
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => {
    out.push(values.join(" "));
  };
  console.error = (...values: unknown[]) => {
    err.push(values.join(" "));
  };
  const started = Date.now();
  try {
    const status = yield* scoped(() =>
      calibrate(
        [
          "--host=compiled",
          `--xmd=${host.host}`,
          "--agent=codex",
          `--scenario=${scenario}`,
          `--output=${output}`,
          "--allow-paid",
        ],
        environment,
      ),
    );
    return {
      status,
      stdout: out.join("\n"),
      stderr: err.join("\n"),
      output,
      elapsedMs: Date.now() - started,
    };
  } finally {
    console.log = log;
    console.error = error;
  }
}
