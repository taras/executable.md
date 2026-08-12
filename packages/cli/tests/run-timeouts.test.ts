/**
 * Tier TF — the run's three timeout options (specs/acp-client-spec.md §Config).
 *
 * `resolveRunTimeouts` is a pure function over argv, so what each option means
 * is asserted directly. The subprocess cases then hold the observable half:
 * which operation each option bounds, and that the run deadline cancels a run
 * that outlives it.
 *
 * A blocked command is a gate, not a race — every deadline under test is an
 * order of magnitude shorter than the command it interrupts, and every case
 * asserts an exit status and a diagnostic rather than an elapsed time.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "@executablemd/test-support/launch";
import { resolveRunTimeouts } from "../src/timeouts.ts";

function* useDocument<T>(body: string, run: (dir: string) => Operation<T>): Operation<T> {
  const dir = path.join(os.tmpdir(), `xmd-tf-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* writeTextFile(path.join(dir, "doc.md"), body);
    return yield* run(dir);
  });
}

/** A command that will not finish on its own, and a marker if it ever does. */
const blocked = (info: string, marker: string) =>
  ["```" + info, `sleep 30 && echo ${marker}`, "```", ""].join("\n");

describe("Tier TF — run timeout options", () => {
  it("TF1: every option is absent until it is written", function* () {
    expect(resolveRunTimeouts(["run", "doc.md"])).toEqual({
      timeout: undefined,
      timeoutExec: undefined,
      timeoutFetch: undefined,
    });
  });

  it("TF2: each option fills its own field and no other", function* () {
    expect(resolveRunTimeouts(["--timeout", "5min"])).toEqual({
      timeout: 300_000,
      timeoutExec: undefined,
      timeoutFetch: undefined,
    });
    expect(resolveRunTimeouts(["--timeout-exec=30s"])).toEqual({
      timeout: undefined,
      timeoutExec: 30_000,
      timeoutFetch: undefined,
    });
    expect(resolveRunTimeouts(["--timeout-fetch", "500ms"])).toEqual({
      timeout: undefined,
      timeoutExec: undefined,
      timeoutFetch: 500,
    });
  });

  it("TF3: the three compose without touching one another", function* () {
    expect(
      resolveRunTimeouts(["--timeout=20min", "--timeout-exec", "5min", "--timeout-fetch=30s"]),
    ).toEqual({ timeout: 1_200_000, timeoutExec: 300_000, timeoutFetch: 30_000 });
  });

  it("TF4: a value that is not a duration fails the invocation and names the option", function* () {
    for (const flag of ["--timeout", "--timeout-exec", "--timeout-fetch"]) {
      for (const value of ["", "0", "-1", "1e3", "abc", "30 s"]) {
        const resolved = resolveRunTimeouts([`${flag}=${value}`]);
        expect({ flag, value, error: "error" in resolved }).toEqual({
          flag,
          value,
          error: true,
        });
        expect("error" in resolved ? resolved.error : "").toContain(flag);
      }
    }
  });

  it("TF5: --timeout cancels the whole run", function* () {
    yield* useDocument(blocked("bash exec", "NEVER"), function* (dir) {
      const { code, stdout, stderr } = yield* runCli(
        ["run", "doc.md", "--timeout", "500ms", "--raw"],
        { cwd: dir },
      ).join();
      expect(code).toBe(1);
      expect(stderr).toContain("exceeded its --timeout");
      expect(stdout).not.toContain("NEVER");
    });
  });

  it("TF6: --timeout-exec bounds the block, and the run deadline is not what fired", function* () {
    yield* useDocument(blocked("bash exec", "NEVER"), function* (dir) {
      const { code, stdout, stderr } = yield* runCli(
        ["run", "doc.md", "--timeout-exec", "500ms", "--raw"],
        { cwd: dir },
      ).join();
      // The block was cut off, and nothing recovers that, so the run reports it
      // and ends. Which option fired is the claim: the exec default, at the
      // block, rather than the run deadline around the whole invocation.
      expect(code).toBe(1);
      expect(stderr).toContain("timed out after 500ms");
      expect(stderr).not.toContain("exceeded its --timeout");
      expect(stdout).not.toContain("NEVER");
    });
  });

  it("TF7: --timeout-fetch is not an exec timeout", function* () {
    const document = ["```bash exec", "sleep 1 && echo SLEPT", "```", ""].join("\n");
    yield* useDocument(document, function* (dir) {
      const { code, stdout } = yield* runCli(
        ["run", "doc.md", "--timeout-fetch", "50ms", "--raw"],
        { cwd: dir },
      ).join();
      expect(code).toBe(0);
      expect(stdout).toContain("SLEPT");
      expect(stdout).not.toContain("timed out");
    });
  });

  it("TF8: a block's own duration overrides --timeout-exec for that block alone", function* () {
    const document = [
      "```bash timeout=30s exec",
      "sleep 1 && echo DECLARED_FINISHED",
      "```",
      "",
      "```bash exec",
      "sleep 30 && echo NEVER",
      "```",
      "",
    ].join("\n");
    yield* useDocument(document, function* (dir) {
      const { code, stdout, stderr } = yield* runCli(
        ["run", "doc.md", "--timeout-exec", "500ms", "--raw"],
        { cwd: dir },
      ).join();
      // The declared block outlived the default and finished; the undeclared
      // one did not, and ends the run where it stands.
      expect(code).toBe(1);
      expect(stdout).toContain("DECLARED_FINISHED");
      expect(stderr).toContain("timed out after 500ms");
      expect(stdout).not.toContain("NEVER");
    });
  });

  it("TF9: a longer exec timeout cannot outlive the run deadline", function* () {
    yield* useDocument(blocked("bash timeout=30s exec", "NEVER"), function* (dir) {
      const { code, stderr, stdout } = yield* runCli(
        ["run", "doc.md", "--timeout", "500ms", "--timeout-exec", "20min", "--raw"],
        { cwd: dir },
      ).join();
      expect(code).toBe(1);
      expect(stderr).toContain("exceeded its --timeout");
      expect(stdout).not.toContain("NEVER");
    });
  });

  it("TF10: a bare timeout with no --timeout-exec refuses", function* () {
    yield* useDocument(["```bash timeout exec", "echo RAN", "```", ""].join("\n"), function* (dir) {
      const { code, stdout, stderr } = yield* runCli(["run", "doc.md", "--raw"], {
        cwd: dir,
      }).join();
      expect(code).toBe(1);
      expect(stderr).toContain("names no duration");
      expect(stdout).not.toContain("RAN");
    });
  });

  /**
   * The document is one preparation refuses: its props schema is invalid, so
   * inspecting it reports that instead. Seeing the duration error — and never
   * the schema's — is what proves the option was recognized first. An empty
   * stdout would have proven only that nothing rendered.
   */
  it("TF11: a malformed option value is refused before the document is inspected", function* () {
    const unpreparable = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    who:",
      "      type: not-a-json-schema-type",
      "---",
      "",
      "# Doc",
      "",
    ].join("\n");
    yield* useDocument(unpreparable, function* (dir) {
      const refused = yield* runCli(["run", "doc.md", "--timeout-exec", "30 seconds", "--raw"], {
        cwd: dir,
      }).join();
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("--timeout-exec must be a duration");
      expect(refused.stderr).not.toContain("props schema");
      expect(refused.stdout).toBe("");

      // The same document, with the option written correctly: now preparation
      // runs and reports what it found, which is what the case above skipped.
      const prepared = yield* runCli(["run", "doc.md", "--timeout-exec", "30s", "--raw"], {
        cwd: dir,
      }).join();
      expect(prepared.code).toBe(1);
      expect(prepared.stderr).toContain("props schema");
    });
  });

  it("TF12: the timeout options are exclusive to xmd run", function* () {
    yield* useDocument("# Doc\n\n## Section\n", function* (dir) {
      const { code, stderr } = yield* runCli(["targets", "doc.md", "--timeout=30s"], {
        cwd: dir,
      }).join();
      expect(code).toBe(1);
      expect(stderr).toContain("timeout options are exclusive to xmd run");
    });
  });
});
