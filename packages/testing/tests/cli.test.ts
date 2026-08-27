/**
 * CLI integration tests for `xmd test` and `xmd run` (specs/testing-spec.md).
 *
 * Shells out to the CLI under the host runtime with piped stdio, so
 * exit codes and report output are asserted TTY-independently.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";

// These runs read fixtures from the repository, so they keep this process's
// working directory and its whole environment.
const RUN = { inheritEnv: true, timeout: 30_000 };

describe("xmd CLI", () => {
  it("test exits 0 and prints the report when every test passes", function* () {
    const result = yield* runCli(
      ["test", "packages/testing/tests/fixtures/passing.md"],
      RUN,
    ).join();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("**AssertEquals** passed");
    expect(result.stdout).toContain("Regular content stays.");
  });

  // The colocated story for a core-owned component. No --include: a
  // built-in resolves from the module graph, not from a search path.
  it("test runs a core component's colocated document with no search path", function* () {
    const result = yield* runCli(
      ["test", "packages/core/src/components/TempDir.test.md"],
      RUN,
    ).join();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("**AssertStringIncludes** passed");
    expect(result.stdout).toContain("xmd-tempdir-");
  });

  it("test exits 1 and prints the failure diagnostic when a test fails", function* () {
    const result = yield* runCli(
      ["test", "packages/testing/tests/fixtures/failing.md"],
      RUN,
    ).join();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("**Assert** failed");
    expect(result.stdout).toContain("Test **bad** failed");
    expect(result.stderr).toContain("tests failed");
  });

  // A fixture that owns its inertness. The repository README used to stand in
  // here, and it is executable now (#414): `xmd test` runs a document while it
  // looks for `<Test>` regions, so pointing this case at production
  // documentation made it run whatever that documentation does.
  it("test exits 1 when no tests are discovered", function* () {
    const result = yield* runCli(
      ["test", "packages/testing/tests/fixtures/no-tests.md"],
      RUN,
    ).join();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no tests were discovered");
  });

  it("run skips tests entirely and exits 0", function* () {
    const result = yield* runCli(["run", "packages/testing/tests/fixtures/failing.md"], RUN).join();
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Assert");
    expect(result.stdout).toContain("# Fixture");
  });
});
