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
import {
  claudeNative,
  codexNative,
  nativeComparison,
} from "../../../examples/agent-usage/evidence.ts";
import type { PromptUsage } from "@executablemd/core";
import { writeTextFile } from "@effectionx/fs";

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
    expect([report.allowance, report.submittedPrompts, report.acknowledgedPrompts]).toEqual([
      2, 2, 2,
    ]);
    expect(report.scenarioChecks.twoPromptsOneSession.outcome).toBe("verified");
    // A controlled agent writes no native transcript: the required multicall
    // witness is missing, which is incomplete calibration, not a pass.
    expect(report.scenarioChecks.multicall).toEqual({
      outcome: "unavailable",
      reason: "native-tool-evidence-unavailable",
    });
    expect(report.teardown.outcome).toBe("verified");
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

  it("UC4: native accounts separate a whole Prompt from its final request, and find subagents", function* () {
    const home = yield* useRoot();
    const codex = join(home, ".codex", "sessions", "2026", "11", "07");
    yield* ensureDir(codex);
    const total = (input: number, output: number) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    });
    const rollout = [
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "function_call", name: "spawn_agent" } },
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
    const read = yield* codexNative(home, "thread-1");
    expect(
      read?.prompts.map(({ calls, toolCalls, subagentCalls, outer }) => ({
        calls,
        toolCalls,
        subagentCalls,
        total: outer?.total_tokens,
      })),
    ).toEqual([
      { calls: 2, toolCalls: 1, subagentCalls: 1, total: 265 },
      { calls: 1, toolCalls: 0, subagentCalls: 0, total: 155 },
    ]);
    const lastOnly = usageWith({
      inputTokens: 150,
      outputTokens: 5,
      cachedReadTokens: 0,
      thoughtTokens: 0,
      totalTokens: 155,
    });
    expect(nativeComparison("codex", lastOnly, read?.prompts[0])).toEqual({
      outcome: "limited",
      reason: "final-request-only",
    });
    expect(nativeComparison("codex", lastOnly, read?.prompts[1])).toEqual({
      outcome: "verified",
      reason: "matches-native-outer-total",
    });
    expect(nativeComparison("codex", undefined, read?.prompts[0]).outcome).toBe("unavailable");

    const claude = join(home, ".claude", "projects", "-fixture");
    yield* ensureDir(claude);
    const usage = {
      input_tokens: 3,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const transcript = [
      { type: "user", message: { content: "read the files" } },
      { type: "user", isMeta: true, message: { content: "a reminder" } },
      { type: "assistant", message: { id: "m1", usage, content: [{ type: "tool_use" }] } },
      { type: "assistant", message: { id: "m1", usage, content: [{ type: "tool_use" }] } },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      { type: "assistant", isSidechain: true, message: { id: "s1", usage, content: [] } },
      { type: "assistant", message: { id: "m2", usage, content: [{ type: "text" }] } },
    ];
    yield* writeTextFile(
      join(claude, "session-1.jsonl"),
      transcript.map((line) => JSON.stringify(line)).join("\n"),
    );
    const main = yield* claudeNative(home, "session-1");
    expect(main?.prompts).toEqual([
      {
        calls: 2,
        toolCalls: 2,
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
        main?.prompts[0],
      ),
    ).toEqual({ outcome: "verified", reason: "matches-native-outer-total-multicall" });
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
