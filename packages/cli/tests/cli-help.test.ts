/**
 * Tier CH — `xmd` help output.
 *
 * Shells out with captured stdio so exit status and text are asserted
 * TTY-independently. Command-level help is the regression these cover:
 * under configliere 0.2.x the parser stopped at the command name and
 * never reached a trailing `--help`, so `xmd run --help` exited 1 with
 * `path: Invalid input: expected string, received undefined`.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";

describe("Tier CH — xmd help", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("CH1: program help lists the commands", function* () {
    const { stdout } = yield* runCli(["--help"]).expect();
    expect(stdout).toContain("Usage: xmd <COMMAND> [OPTIONS]");
    expect(stdout).toContain("run");
    expect(stdout).toContain("test-agent");
  });

  it("CH2: xmd run --help prints run help instead of a missing-argument error", function* () {
    const { stdout, stderr } = yield* runCli(["run", "--help"]).expect();
    // The path is optional because `--eval` is the other way to supply a root
    // document; which of the two a run needs is stated below the options.
    expect(stdout).toContain("Usage: xmd run [OPTIONS] [path]");
    expect(stdout).toContain("markdown document to execute");
    expect(stdout).toContain("-e, --eval");
    expect(stdout).toContain("Exactly one root document is required");
    expect(stdout).toContain("--component-dir");
    expect(stderr).not.toContain("Invalid input");
  });

  it("CH3: xmd test --help prints test help", function* () {
    const { stdout } = yield* runCli(["test", "--help"]).expect();
    expect(stdout).toContain("Usage: xmd test [OPTIONS] [path]");
    expect(stdout).toContain("markdown document or directory to test");
  });

  it("CH4: --version prints the version", function* () {
    const { stdout } = yield* runCli(["--version"]).expect();
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("CH5: a missing document still fails, so help detection does not mask errors", function* () {
    const { code, stderr } = yield* runCli(["run"]).join();
    expect(code).toBe(1);
    // Once `path` became optional the parser stopped raising, so the diagnostic
    // is the CLI's own and names both ways to supply a root document.
    expect(stderr).toContain("requires a document path or an inline document");
  });
});
