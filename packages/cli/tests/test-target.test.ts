/**
 * Tier DT — what `xmd test <path>` runs.
 *
 * Shells out with captured stdio so discovery, ordering, isolation, and exit
 * status are observed the way a caller sees them. Every fixture is agent-free,
 * so a case reports on discovery rather than on a provider.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import { rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { stat } from "@executablemd/runtime";
import { runCli } from "@executablemd/test-support/launch";

const FIXTURES = path.resolve("packages/cli/tests/fixtures/discovery");

function fixture(...segments: string[]): string {
  return path.join(FIXTURES, ...segments);
}

/** The document headings a directory run prints, in the order it printed them. */
function headings(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("# ") && line.endsWith(".md"))
    .map((line) => line.slice(2));
}

describe("Tier DT — xmd test targets", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("DT1: a directory runs every test document beneath it", function* () {
    const { code, stdout } = yield* runCli(["test", fixture("suite")]).join();
    expect(code).toBe(0);
    expect(headings(stdout)).toContain("passing.test.md");
    expect(headings(stdout)).toContain("nested/deep.test.md");
  });

  it("DT2: documents are identified and ordered by relative path", function* () {
    const { stdout } = yield* runCli(["test", fixture("suite")]).join();
    expect(headings(stdout)).toEqual([
      "a-binds.test.md",
      "b-reads.test.md",
      "nested/deep.test.md",
      "passing.test.md",
    ]);
  });

  it("DT3: ordinary markdown does not run under the default pattern", function* () {
    const { code, stdout } = yield* runCli(["test", fixture("suite")]).join();
    expect(code).toBe(0);
    expect(headings(stdout)).not.toContain("notes.md");
    expect(stdout).not.toContain("notes.md should not have executed");
  });

  it("DT4: a directory with no matching document fails and names the pattern", function* () {
    const { code, stderr } = yield* runCli(["test", fixture("bare")]).join();
    expect(code).toBe(1);
    expect(stderr).toContain("no documents matched **/*.test.md in");
  });

  it("DT5: a failing document is attributed, and the run continues and summarizes", function* () {
    const { code, stdout, stderr } = yield* runCli(["test", fixture("mixed")]).join();
    expect(code).toBe(1);
    expect(headings(stdout)).toEqual(["broken.test.md", "ok.test.md"]);
    expect(stderr).toContain("broken.test.md: tests failed:");
    expect(stderr).toContain("1 of 2 documents failed");
  });

  it("DT6: each document gets its own testing session", function* () {
    const { code, stdout, stderr } = yield* runCli(["test", fixture("session")]).join();
    expect(code).toBe(1);
    expect(stderr).toContain("b-empty.test.md: tests failed: no tests were discovered");
    expect(headings(stdout)).toEqual(["a-passes.test.md", "b-empty.test.md", "c-passes.test.md"]);
    expect(stderr).toContain("1 of 3 documents failed");
  });

  // The reading document asserts the reference stayed unresolved, so a leak
  // fails it; the rendered `{leaked}` is the same fact in the report.
  it("DT7: a binding does not leak into the next document", function* () {
    const { code, stdout } = yield* runCli(["test", fixture("suite")]).join();
    expect(code).toBe(0);
    expect(stdout).toContain("{leaked}");
  });

  it("DT8: a single document reports exactly as it always has", function* () {
    const { code, stdout, stderr } = yield* runCli([
      "test",
      fixture("suite", "passing.test.md"),
    ]).join();
    expect(code).toBe(0);
    expect(headings(stdout)).toEqual([]);
    expect(stderr).not.toContain("documents failed");
  });

  it("DT9: a failing single document prints one diagnostic", function* () {
    const { code, stderr } = yield* runCli(["test", fixture("mixed", "broken.test.md")]).join();
    expect(code).toBe(1);
    expect(stderr).not.toContain("broken.test.md:");
    expect(stderr.match(/tests failed:/g)).toEqual(["tests failed:"]);
  });

  it("DT10: --journal is rejected for a directory before anything runs", function* () {
    const trace = path.join(os.tmpdir(), `xmd-dt10-${randomUUID()}.jsonl`);
    yield* ensure(() => rm(trace, { force: true }));

    const { code, stdout, stderr } = yield* runCli([
      "test",
      fixture("suite"),
      "--journal",
      trace,
    ]).join();
    expect(code).toBe(1);
    expect(stderr).toContain("--journal is not supported with a directory target");
    expect(headings(stdout)).toEqual([]);
    expect((yield* stat(trace)).exists).toBe(false);
  });

  it("DT11: run-only options stay exclusive to xmd run", function* () {
    const agent = yield* runCli(["test", fixture("suite"), "--approve-all"]).join();
    expect(agent.code).toBe(1);
    expect(agent.stderr).toContain("agent options are exclusive to xmd run");

    const props = yield* runCli(["test", fixture("suite"), "--props", "{}"]).join();
    expect(props.code).toBe(1);
    expect(props.stderr).toContain("document properties are exclusive to xmd run");
  });

  it("DT12: a bare xmd test is the current directory", function* () {
    const bare = yield* runCli(["test"], { cwd: fixture("suite") }).join();
    const explicit = yield* runCli(["test", "."], { cwd: fixture("suite") }).join();
    expect(bare.code).toBe(0);
    expect(bare.code).toBe(explicit.code);
    expect(headings(bare.stdout)).toEqual(headings(explicit.stdout));
  });

  it("DT13: a bare xmd test with no matches fails", function* () {
    const { code, stderr } = yield* runCli(["test"], { cwd: fixture("bare") }).join();
    expect(code).toBe(1);
    expect(stderr).toContain("no documents matched **/*.test.md in .");
  });

  it("DT14: the default pattern reaches both root-level and nested documents", function* () {
    const { stdout } = yield* runCli(["test", fixture("suite")]).join();
    expect(headings(stdout)).toContain("passing.test.md");
    expect(headings(stdout)).toContain("nested/deep.test.md");
  });

  it("DT15: a custom pattern discovers a differently named document", function* () {
    const { code, stdout } = yield* runCli([
      "test",
      fixture("patterns"),
      "--pattern",
      "**/*.spec.md",
    ]).join();
    expect(code).toBe(0);
    expect(headings(stdout)).toEqual(["one.spec.md"]);
  });

  it("DT16: an explicit pattern replaces the default", function* () {
    const { stdout } = yield* runCli([
      "test",
      fixture("patterns"),
      "--pattern",
      "**/*.spec.md",
    ]).join();
    expect(headings(stdout)).not.toContain("three.test.md");
  });

  it("DT17: repeated patterns run their union", function* () {
    const { code, stdout } = yield* runCli([
      "test",
      fixture("patterns"),
      "--pattern",
      "**/*.spec.md",
      "--pattern",
      "**/*.check.md",
    ]).join();
    expect(code).toBe(0);
    expect(headings(stdout)).toEqual(["one.spec.md", "two.check.md"]);
  });

  it("DT18: a document matched by two patterns runs once", function* () {
    const { stdout } = yield* runCli([
      "test",
      fixture("patterns"),
      "--pattern",
      "**/*.spec.md",
      "--pattern",
      "one.spec.md",
    ]).join();
    expect(headings(stdout)).toEqual(["one.spec.md"]);
  });

  it("DT19: the union is ordered by relative path, not by pattern order", function* () {
    const { stdout } = yield* runCli([
      "test",
      fixture("patterns"),
      "--pattern",
      "**/*.check.md",
      "--pattern",
      "**/*.spec.md",
    ]).join();
    expect(headings(stdout)).toEqual(["one.spec.md", "two.check.md"]);
  });

  it("DT20: --pattern is rejected against a single document", function* () {
    const { code, stdout, stderr } = yield* runCli([
      "test",
      fixture("patterns", "three.test.md"),
      "--pattern",
      "**/*.md",
    ]).join();
    expect(code).toBe(1);
    expect(stderr).toContain("is a single document");
    expect(stdout).not.toContain("default pattern document");
  });

  it("DT21: an empty --pattern is rejected instead of falling back", function* () {
    const { code, stdout, stderr } = yield* runCli([
      "test",
      fixture("patterns"),
      "--pattern",
      "",
    ]).join();
    expect(code).toBe(1);
    expect(stderr).toContain("--pattern requires a glob");
    expect(headings(stdout)).toEqual([]);
  });

  it("DT22: help describes the optional path and the repeatable pattern", function* () {
    const { stdout } = yield* runCli(["test", "--help"]).expect();
    expect(stdout).toContain("Usage: xmd test [OPTIONS] [path]");
    expect(stdout).toContain("[default: .]");
    expect(stdout).toContain("--pattern");
    expect(stdout).toContain("[default: **/*.test.md]");
  });

  it("DT23: a broad pattern deliberately runs ordinary markdown", function* () {
    const { code, stdout, stderr } = yield* runCli([
      "test",
      fixture("suite"),
      "--pattern",
      "notes.md",
    ]).join();
    expect(code).toBe(1);
    expect(headings(stdout)).toEqual(["notes.md"]);
    expect(stderr).toContain("notes.md should not have executed");
  });

  it("DT24: a directory target resolves the components beside its documents", function* () {
    const { code, stdout } = yield* runCli(["test", "colocated"], { cwd: FIXTURES }).join();
    expect(code).toBe(0);
    expect(headings(stdout)).toEqual(["Example.test.md"]);
    expect(stdout).toContain("Example component");
  });
});
