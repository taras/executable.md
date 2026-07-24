/**
 * CLI agent-flag integration tests (specs/acp-client-spec.md §CLI).
 *
 * Shells out to the real CLI. No agent process is ever needed: the flag
 * validation paths fail before document execution, and the agent-free
 * document proves the provider stays lazy.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { timebox } from "@effectionx/timebox";
import { spawn, each, type Operation } from "effection";
import { exec } from "@effectionx/process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";

const TIMEOUT = 20_000;

const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) {
    environment[key] = value;
  }
}

interface CliResult {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function* runCli(command: string, args: string[]): Operation<CliResult> {
  const result = yield* timebox<CliResult>(TIMEOUT, function* () {
    const proc = yield* exec("deno", {
      arguments: ["run", "--allow-all", "packages/cli/src/cli.ts", command, ...args],
      env: environment,
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

    return {
      code: status.code ?? undefined,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  });
  if (result.timeout) {
    throw new Error(`CLI timed out after ${TIMEOUT}ms`);
  }
  return result.value;
}

function writeDoc(content: string): { docPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xmd-cli-agent-"));
  const docPath = path.join(dir, "doc.md");
  fs.writeFileSync(docPath, content);
  return {
    docPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("CLI agent flags", () => {
  it("CA1: an unknown --agent-provider fails before document execution", function* () {
    const doc = writeDoc("must never render\n");
    try {
      const result = yield* runCli("run", [doc.docPath, "--agent-provider", "bogus"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown agent provider "bogus"');
      expect(result.stdout).not.toContain("must never render");
    } finally {
      doc.cleanup();
    }
  });

  it("CA2: the permission flags are mutually exclusive", function* () {
    const doc = writeDoc("must never render\n");
    try {
      const result = yield* runCli("run", [doc.docPath, "--approve-all", "--deny-all"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("mutually exclusive");
      expect(result.stdout).not.toContain("must never render");
    } finally {
      doc.cleanup();
    }
  });

  it("CA3: an agent-free document runs clean with default agent flags", function* () {
    const doc = writeDoc("plain output, no agents\n");
    try {
      const result = yield* runCli("run", [doc.docPath]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("plain output, no agents");
    } finally {
      doc.cleanup();
    }
  });

  it("CA4: --timeout accepts positive decimals and rejects zero", function* () {
    const doc = writeDoc(["```bash exec", "echo quick", "```", ""].join("\n"));
    try {
      const invalid = yield* runCli("run", [doc.docPath, "--timeout", "0"]);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("--timeout must be a positive number of seconds");
      expect(invalid.stdout).not.toContain("quick");

      // A fractional value converts without rounding to zero, so the
      // document still runs. (The contextual bound itself is covered by
      // the Config Api tier.)
      const result = yield* runCli("run", [doc.docPath, "--timeout", "0.5"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("quick");
    } finally {
      doc.cleanup();
    }
  });

  it("CA5: xmd test ignores agent flags and never touches ACPX", function* () {
    const doc = writeDoc('<Testing>\n<Test name="t">\nplain\n</Test>\n</Testing>\n');
    try {
      const result = yield* runCli("test", [
        doc.docPath,
        "--approve-all",
        "--agent-provider",
        "bogus",
      ]);
      // The test command has no agent flags: nothing resolves "bogus",
      // no provider installs, and the document's own testing outcome
      // decides the exit code.
      expect(result.stderr).not.toContain("Unknown agent provider");
    } finally {
      doc.cleanup();
    }
  });
});
