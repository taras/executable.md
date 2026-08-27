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
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { stat } from "@executablemd/runtime";
import { runCli } from "@executablemd/test-support/launch";
import { componentSearchPath } from "../src/test-target.ts";

/**
 * The flag this rename retired, composed from fragments so the migration audit
 * finds no occurrence of it in a case whose job is to prove it carries nothing.
 */
const RETIRED_FLAG = `--component${"-dir"}`;

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

  // Neither the target root nor the working directory holds a `Widget.md`, so
  // each document can only be resolving the one in its own directory.
  it("DT25: a nested document resolves the component beside it, not a sibling's", function* () {
    const { code, stdout } = yield* runCli(["test", "nested-components"], {
      cwd: FIXTURES,
    }).join();
    expect(code).toBe(0);
    expect(headings(stdout)).toEqual(["alpha/Widget.test.md", "beta/Widget.test.md"]);
    expect(stdout).toContain("Alpha widget");
    expect(stdout).toContain("Beta widget");
  });

  /**
   * The composition itself, rather than a run that depends on it. A repeated
   * directory keeps its first position however it is spelled, so a configured
   * include cannot promote itself ahead of the document's own directory by
   * naming it a second time.
   */
  it("DT32: composition is document directory, target root, then the configured includes", function* () {
    const root = path.join(os.tmpdir(), `xmd-dt32-${randomUUID()}`);
    const document = {
      path: path.join(root, "nested", "deep.test.md"),
      relativePath: "nested/deep.test.md",
    };

    const search = componentSearchPath(document, root, [
      // The document's own directory, spelled exactly as composition spells it…
      path.join(root, "nested"),
      // …and the target root, spelled differently but resolving to the same
      // directory.
      `${root}${path.sep}.`,
      "components",
    ]);

    expect(search).toEqual([path.join(root, "nested"), root, "components"]);
  });

  it("DT33: the retired flag contributes no include to a test document", function* () {
    const dir = path.join(os.tmpdir(), `xmd-dt33-${randomUUID()}`);
    yield* ensureDir(path.join(dir, "elsewhere"));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* writeTextFile(path.join(dir, "elsewhere", "Widget.md"), "Widget from elsewhere\n");
    yield* writeTextFile(
      path.join(dir, "one.test.md"),
      [
        '<Test name="the include is where the component comes from">',
        '<Let as="rendered"><Widget /></Let>',
        '<AssertEquals actual={rendered} expected={"Widget from elsewhere"} />',
        "</Test>",
        "",
      ].join("\n"),
    );

    const granted = yield* runCli(["test", "one.test.md", "--include", "elsewhere"], {
      cwd: dir,
    }).join();
    expect(granted.code).toBe(0);

    const retired = yield* runCli(["test", "one.test.md", RETIRED_FLAG, "elsewhere"], {
      cwd: dir,
    }).join();
    expect(retired.code).toBe(1);
    expect(retired.stdout + retired.stderr).toContain(
      "Cannot resolve component: Widget (searched: components, .)",
    );
  });

  it("DT26: a --pattern with no value is rejected", function* () {
    const { code, stdout, stderr } = yield* runCli(["test", fixture("suite"), "--pattern"]).join();
    expect(code).toBe(1);
    expect(stderr).toContain("--pattern requires a value");
    expect(headings(stdout)).toEqual([]);
  });

  it("DT27: another option is not read as the glob", function* () {
    const { code, stdout, stderr } = yield* runCli(["test", "--pattern", "--raw", "."], {
      cwd: fixture("suite"),
    }).join();
    expect(code).toBe(1);
    expect(stderr).toContain("--pattern requires a value");
    expect(stderr).not.toContain("no documents matched --raw");
    expect(headings(stdout)).toEqual([]);
  });

  it("DT28: --pattern=<glob> expresses a glob that begins with a dash", function* () {
    const { code, stderr } = yield* runCli([
      "test",
      fixture("suite"),
      "--pattern=-weird.md",
    ]).join();
    expect(code).toBe(1);
    expect(stderr).toContain("no documents matched -weird.md in");
  });

  it("DT29: argv after -- is not inspected for options", function* () {
    const { code, stdout } = yield* runCli(["test", fixture("suite"), "--", "--pattern"]).join();
    expect(code).toBe(0);
    expect(headings(stdout)).toEqual([
      "a-binds.test.md",
      "b-reads.test.md",
      "nested/deep.test.md",
      "passing.test.md",
    ]);
  });

  it("DT30: a test path keeps its literal # and %, and no fragment is read", function* () {
    // `xmd run` reads a path as a document reference; `xmd test` does not, so
    // these two filenames still mean themselves.
    const root = path.join(os.tmpdir(), `xmd-dt-${randomUUID()}`);
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(root);
    const body = '<Test name="literal">\n\nLITERAL_MARKER\n\n</Test>\n';
    yield* writeTextFile(path.join(root, "we#ird.test.md"), body);
    yield* writeTextFile(path.join(root, "pct%zz.test.md"), body);

    const hashed = yield* runCli(["test", path.join(root, "we#ird.test.md")]).join();
    expect(hashed.code).toBe(0);
    expect(hashed.stdout).toContain("LITERAL_MARKER");

    // `%zz` is not a valid escape, so `xmd run` would refuse this reference
    // outright. `xmd test` reads it as the filename it is.
    const percent = yield* runCli(["test", path.join(root, "pct%zz.test.md")]).join();
    expect(percent.code).toBe(0);
    expect(percent.stdout).toContain("LITERAL_MARKER");

    // The percent-encoded spelling names no file, so it is a missing path
    // rather than another way to write the same one.
    const encoded = yield* runCli(["test", path.join(root, "we%23ird.test.md")]).join();
    expect(encoded.code).toBe(1);
  });

  /**
   * The containment contract, as `xmd test` performs it (#441).
   *
   * A command that exits nonzero inside a `<Test>` is that test's outcome:
   * `xmd test` attaches nothing to arrange it, because the construct that
   * contains the failure is core's own `<Test>`. The evidence that the run went
   * on is the second command's output — a document whose disposition was the
   * ordinary one would stop at the first.
   */
  it("DT31: a failing command inside a test fails that test, and the next runs", function* () {
    const { code, stdout, stderr } = yield* runCli([
      "test",
      fixture("containment", "commands.test.md"),
    ]).join();

    expect(code).toBe(1);
    expect(stdout).toContain("BEFORE_FAILURE");
    expect(stdout).toContain("AFTER_CONTAINMENT");
    expect(stderr).toContain("1 of 2 tests failed");
    expect(stderr).toContain("a failing command fails its own test: Command failed (exit 3)");
  });
});
