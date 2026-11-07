/**
 * Prompt usage carried by the compiled binary (specs/acp-client-spec.md §Prompt usage).
 *
 * The compiled entrypoint states its own host facts, which is a different
 * assembly from the source CLI's. This runs `dist/xmd` against the controlled
 * native Claude fixture — no credentials, no model call — and reads the usage
 * the binary retained in the journal it was asked to keep, and nothing where it
 * was asked to keep none.
 *
 * It runs against `dist/xmd`, so `deno task build` has to have happened.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import { ensureDir, exists, readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import type { ProcessResult } from "@effectionx/process";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parsePromptRecord } from "@executablemd/core/host";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = path.join(ROOT, "dist", "xmd");
const FAKE_CLAUDE = path.join(ROOT, "packages/acp/tests/fixtures/fake-claude-cli.cjs");

function* runBinary(args: readonly string[], cwd: string): Operation<ProcessResult> {
  const attempt = yield* timebox<ProcessResult>(120_000, function* () {
    return yield* exec(BINARY, {
      arguments: [...args],
      cwd,
      env: Object.fromEntries(
        [...Object.entries(process.env), ["CLAUDE_CODE_EXECUTABLE", FAKE_CLAUDE]].flatMap(
          ([name, value]) => (typeof value === "string" ? [[name, value]] : []),
        ),
      ),
    }).join();
  });
  if (attempt.timeout) {
    throw new Error(`the compiled binary timed out running ${args.join(" ")}`);
  }
  return attempt.value;
}

describe("Prompt usage through the compiled binary", () => {
  it("retains compiled-host usage only in the journal a run selected", function* () {
    if (!(yield* exists(BINARY))) {
      throw new Error("dist/xmd is missing; run `deno task build` first");
    }
    const root = path.join(tmpdir(), `xmd-puc-${randomUUID()}`);
    yield* ensureDir(root);
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* writeTextFile(
      path.join(root, "doc.md"),
      '<Agent name="claude"><Prompt>measure me</Prompt></Agent>\n',
    );

    const transient = yield* runBinary(["run", "doc.md"], root);
    expect(transient.code).toBe(0);
    expect((yield* readdir(root)).sort()).toEqual(["doc.md"]);

    const retained = yield* runBinary(["run", "doc.md", "--journal", "run.jsonl"], root);
    expect(retained.code).toBe(0);
    const records = (yield* readTextFile(path.join(root, "run.jsonl")))
      .split("\n")
      .filter((line) => line.includes('"agent_prompt"'))
      .map((line) => parsePromptRecord(JSON.parse(line).result.value));
    expect(records.length).toBe(1);
    const usage = records[0]?.usage;
    expect(usage?.provenance.host).toBe("compiled");
    expect(usage?.provenance.adapter.version).toBe("0.70.0");
    expect(typeof usage?.providerMessageId).toBe("string");
    expect(usage?.readings.find((reading) => reading.source === "response")).toEqual({
      source: "response",
      scope: "main-loop",
      kind: "tokens",
      counter: "turn-total",
      tokens: {
        inputTokens: 1,
        outputTokens: 1,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        totalTokens: 2,
      },
    });
  });
});
