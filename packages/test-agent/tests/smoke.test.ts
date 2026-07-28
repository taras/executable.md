/**
 * Tier TG — test-agent smoke (specs/test-agent-spec.md acceptance
 * §3–§4). TG1 runs the fixture through the real `xmd test` CLI, so the
 * command's own component wiring is covered. TG2 runs the same fixture
 * in process to replay a completed journal — the CLI never loads an
 * existing journal, so replay cannot be exercised through it.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { each, scoped, spawn } from "effection";
import type { Operation, Result } from "effection";
import { timebox } from "@effectionx/timebox";
import { exec } from "@effectionx/process";
import * as path from "node:path";
import process from "node:process";
import { execute, installAgentComponents } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { installTestAgentComponents } from "../src/components.ts";
import { useCommand } from "./command.ts";
import { cliBase, cliCommand } from "@executablemd/test-support/launch";
import type { Json } from "@executablemd/core";

const DOC = path.resolve("smoke-test/test-agent/README.md");
const TIMEOUT = 120_000;

interface CliResult {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function* runCli(args: string[]): Operation<CliResult> {
  const result = yield* timebox<CliResult>(TIMEOUT, function* () {
    const cli = cliCommand(args);
    const proc = yield* exec(cli.command, {
      arguments: cli.arguments,
      env: cliEnv(),
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const readStdout = yield* spawn(function* () {
      for (const chunk of yield* each(proc.stdout)) {
        stdoutChunks.push(new TextDecoder().decode(chunk));
        yield* each.next();
      }
    });
    const readStderr = yield* spawn(function* () {
      for (const chunk of yield* each(proc.stderr)) {
        stderrChunks.push(new TextDecoder().decode(chunk));
        yield* each.next();
      }
    });

    const status = yield* proc.join();
    yield* readStdout;
    yield* readStderr;

    return { code: status.code, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  });
  if (result.timeout) {
    throw new Error("CLI subprocess timed out");
  }
  return result.value;
}

function* runSmoke(
  stream: InMemoryStream,
  xmd: string[],
): Operation<{ result: Result<Json>; output: string; results: readonly TestResult[] }> {
  // The scope closes before the assertions run, so the provider and its
  // workers finish teardown and the completion settles.
  return yield* scoped(function* () {
    const testing = yield* useTesting();
    yield* useCommand(xmd);
    yield* installTestAgentComponents();
    yield* installAgentComponents();
    const execution = yield* execute({ path: DOC, stream });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    const results = yield* testing.results;
    return { result, output: next.value, results };
  });
}

describe("Tier TG — test-agent smoke", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("TG1: `xmd test` runs the fixture through the real ACPX runtime and worker", function* () {
    const cli = yield* runCli(["test", DOC]);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain("The review of **packages/core** at `abc123` passed.");
    expect(cli.stdout).toContain("The review of **packages/core** passed.");
    expect(cli.stdout).not.toContain("ERROR");
  });

  it("TG2: replay repeats the completed journal without contacting ACPX", function* () {
    const stream = new InMemoryStream();

    const live = yield* runSmoke(stream, cliBase());
    expect(live.results.map((entry) => entry.status)).toEqual(["pass"]);
    expect(live.result.ok).toBe(true);
    expect(live.output).not.toContain("ERROR");

    const appended = stream.appendCount;
    // An unspawnable worker command proves replay never contacts ACPX
    // or a worker.
    const replay = yield* runSmoke(stream, ["/nonexistent/xmd-test-agent-must-not-spawn"]);
    expect(replay.results.map((entry) => entry.status)).toEqual(["pass"]);
    expect(replay.result.ok).toBe(true);
    expect(replay.output).toBe(live.output);
    expect(stream.appendCount).toBe(appended);
  });
});
