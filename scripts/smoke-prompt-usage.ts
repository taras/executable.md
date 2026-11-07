/**
 * Prompt usage carried by the compiled binary (specs/acp-client-spec.md §Prompt usage).
 *
 * The compiled entrypoint states its own host facts, a different assembly from
 * the source CLI's. This runs `dist/xmd` against the controlled native Claude
 * fixture — no credentials, no model call — and reads the usage the binary
 * retained in the journal it was asked to keep, and finds nothing where it was
 * asked to keep none.
 */

import { ensure, main } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { ensureDir, exists, readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import process from "node:process";
import { parsePromptRecord } from "@executablemd/core/host";

const BINARY = path.join(process.cwd(), "dist", "xmd");
const FAKE_CLAUDE = path.join(process.cwd(), "packages/acp/tests/fixtures/fake-claude-cli.cjs");

function fail(claim: string): never {
  console.error(`prompt usage smoke: ${claim}`);
  process.exit(1);
}

function* runBinary(args: readonly string[], cwd: string): Operation<ProcessResult> {
  return yield* exec(BINARY, {
    arguments: [...args],
    cwd,
    env: Object.fromEntries(
      [...Object.entries(process.env), ["CLAUDE_CODE_EXECUTABLE", FAKE_CLAUDE]].flatMap(
        ([name, value]) => (typeof value === "string" ? [[name, value]] : []),
      ),
    ),
  }).join();
}

await main(function* () {
  if (!(yield* exists(BINARY))) {
    fail("dist/xmd is missing; run `deno task build` first");
  }
  const root = path.join(tmpdir(), `xmd-prompt-usage-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  yield* writeTextFile(
    path.join(root, "doc.md"),
    '<Agent name="claude"><Prompt>measure me</Prompt></Agent>\n',
  );

  const transient = yield* runBinary(["run", "doc.md"], root);
  if (transient.code !== 0) {
    fail(`a run without --journal exited ${transient.code}`);
  }
  const left = (yield* readdir(root)).sort();
  if (JSON.stringify(left) !== JSON.stringify(["doc.md"])) {
    fail(`a run without --journal left ${JSON.stringify(left)}`);
  }

  const retained = yield* runBinary(["run", "doc.md", "--journal", "run.jsonl"], root);
  if (retained.code !== 0) {
    fail(`a run with --journal exited ${retained.code}`);
  }
  const records = (yield* readTextFile(path.join(root, "run.jsonl")))
    .split("\n")
    .filter((line) => line.includes('"agent_prompt"'))
    .map((line) => parsePromptRecord(JSON.parse(line).result.value));
  if (records.length !== 1) {
    fail(`the journal holds ${records.length} Prompt records, not 1`);
  }
  const usage = records[0]?.usage;
  const response = usage?.readings.find((reading) => reading.source === "response");
  const expected = {
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
  };
  if (usage?.provenance.host !== "compiled") {
    fail(`the retained host is ${usage?.provenance.host}, not compiled`);
  }
  if (usage.provenance.adapter.version !== "0.70.0") {
    fail(`the retained adapter is ${usage.provenance.adapter.version}, not 0.70.0`);
  }
  if (typeof usage.providerMessageId !== "string") {
    fail("the retained usage names no provider message");
  }
  if (JSON.stringify(response) !== JSON.stringify(expected)) {
    fail(`the retained response reading is ${JSON.stringify(response)}`);
  }
  console.log(
    "prompt usage smoke: the compiled binary retained compiled-host usage only in its journal",
  );
});
