/**
 * Tier CA — `xmd run` agent stack (specs/acp-client-spec.md
 * §Command-line configuration).
 *
 * Shells out to the CLI with piped stdio, so exit status and diagnostics
 * are asserted TTY-independently. Agent names are deliberately
 * nonexistent commands — never ACPX built-ins, which resolve to real
 * commands — so availability fails fast and the failure text identifies
 * which value was selected.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "@executablemd/test-support/launch";

interface Fixture {
  dir: string;
  home: string;
}

/**
 * A document and an isolated HOME in fresh temporary directories, both
 * removed once the body settles. Runs execute from `dir`, so a project's
 * own ACPX configuration cannot reach them either.
 */
function* useFixture<T>(
  files: Record<string, string>,
  body: (fixture: Fixture) => Operation<T>,
): Operation<T> {
  const root = path.join(os.tmpdir(), `xmd-ca-${randomUUID()}`);
  const fixture: Fixture = { dir: path.join(root, "work"), home: path.join(root, "home") };
  yield* ensureDir(fixture.dir);
  yield* ensureDir(fixture.home);
  return yield* scoped(function* () {
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    for (const [name, content] of Object.entries(files)) {
      yield* writeTextFile(path.join(fixture.dir, name), content);
    }
    return yield* body(fixture);
  });
}

function env(fixture: Fixture): { cwd: string; env: Record<string, string> } {
  return { cwd: fixture.dir, env: { HOME: fixture.home } };
}

const AGENT_DOC = [
  "BEFORE_MARKER",
  "",
  "<Agent>",
  '  <Prompt text="hello" />',
  "</Agent>",
  "",
  "AFTER_MARKER",
  "",
].join("\n");

const BARE_PROMPT_DOC = [
  "BEFORE_MARKER",
  "",
  '<Prompt text="hello" />',
  "",
  "AFTER_MARKER",
  "",
].join("\n");

const PLAIN_DOC = "PLAIN_MARKER\n\nNo agent here.\n";

describe("Tier CA — xmd run agent stack", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("CA1: an unknown --agent-provider fails before the document executes", function* () {
    const result = yield* useFixture({ "doc.md": AGENT_DOC }, function* (fixture) {
      return yield* runCli(
        ["run", "doc.md", "--agent-provider", "bogus", "--raw"],
        env(fixture),
      ).join();
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown agent provider "bogus"');
    expect(result.stdout).not.toContain("BEFORE_MARKER");
    expect(result.stdout).not.toContain("AFTER_MARKER");
  });

  it("CA2: mutually exclusive permission flags fail before the document executes", function* () {
    const result = yield* useFixture({ "doc.md": AGENT_DOC }, function* (fixture) {
      return yield* runCli(
        ["run", "doc.md", "--approve-all", "--deny-all", "--raw"],
        env(fixture),
      ).join();
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
    expect(result.stdout).not.toContain("BEFORE_MARKER");
  });

  it("CA3: a document that never uses an agent runs with default flags", function* () {
    const result = yield* useFixture({ "doc.md": PLAIN_DOC }, function* (fixture) {
      return yield* runCli(["run", "doc.md", "--raw"], env(fixture)).join();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PLAIN_MARKER");
    expect(result.stderr).not.toContain("unavailable");
  });

  it("CA4: --timeout accepts only a complete decimal number of seconds", function* () {
    // The parser coerces and drops lexical forms, so these are asserted
    // through the CLI rather than against the parsing function alone.
    const rejected = ["1e3", "0x10", ".5", "+1", "Infinity", "NaN", "12seconds", "0", "-1"];
    for (const value of rejected) {
      const result = yield* useFixture({ "doc.md": PLAIN_DOC }, function* (fixture) {
        return yield* runCli(["run", "doc.md", "--timeout", value, "--raw"], env(fixture)).join();
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--timeout");
      expect(result.stdout).not.toContain("PLAIN_MARKER");
    }

    for (const value of ["30", "0.5"]) {
      const result = yield* useFixture({ "doc.md": PLAIN_DOC }, function* (fixture) {
        return yield* runCli(["run", "doc.md", "--timeout", value, "--raw"], env(fixture)).join();
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("PLAIN_MARKER");
    }

    const equalsForm = yield* useFixture({ "doc.md": PLAIN_DOC }, function* (fixture) {
      return yield* runCli(["run", "doc.md", "--timeout=1e3", "--raw"], env(fixture)).join();
    });
    expect(equalsForm.code).toBe(1);
    expect(equalsForm.stderr).toContain("--timeout");
  });

  it("CA5: the default agent resolves environment, then flag, with the flag winning", function* () {
    const fromEnv = yield* useFixture({ "doc.md": AGENT_DOC }, function* (fixture) {
      return yield* runCli(["run", "doc.md", "--raw"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, DEFAULT_AGENT_NAME: "xmd-env-only-agent" },
      }).join();
    });
    expect(fromEnv.code).toBe(1);
    expect(fromEnv.stderr).toContain('agent "xmd-env-only-agent" is unavailable');

    const fromFlag = yield* useFixture({ "doc.md": AGENT_DOC }, function* (fixture) {
      return yield* runCli(
        ["run", "doc.md", "--default-agent", "xmd-flag-only-agent", "--raw"],
        env(fixture),
      ).join();
    });
    expect(fromFlag.code).toBe(1);
    expect(fromFlag.stderr).toContain('agent "xmd-flag-only-agent" is unavailable');

    const both = yield* useFixture({ "doc.md": AGENT_DOC }, function* (fixture) {
      return yield* runCli(["run", "doc.md", "--default-agent", "xmd-flag-wins-agent", "--raw"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, DEFAULT_AGENT_NAME: "xmd-env-loses-agent" },
      }).join();
    });
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('agent "xmd-flag-wins-agent" is unavailable');
    expect(both.stderr).not.toContain("xmd-env-loses-agent");
  });

  it("CA6: an unavailable agent aborts expansion, for <Agent> and for a bare <Prompt>", function* () {
    const shapes = [AGENT_DOC, BARE_PROMPT_DOC];
    for (const doc of shapes) {
      const result = yield* useFixture({ "doc.md": doc }, function* (fixture) {
        return yield* runCli(
          ["run", "doc.md", "--default-agent", "xmd-nonexistent-agent", "--raw"],
          env(fixture),
        ).join();
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('agent "xmd-nonexistent-agent" is unavailable');
      expect(result.stdout).toContain("BEFORE_MARKER");
      expect(result.stdout).not.toContain("AFTER_MARKER");
    }
  });

  it("CA7: xmd test rejects every agent-only option at argument parsing", function* () {
    const options = [
      { name: "--agent-provider", args: ["--agent-provider", "acpx"] },
      { name: "--default-agent", args: ["--default-agent", "xmd-nonexistent-agent"] },
      { name: "--timeout", args: ["--timeout", "30"] },
      { name: "--approve-all", args: ["--approve-all"] },
      { name: "--approve-reads", args: ["--approve-reads"] },
      { name: "--deny-all", args: ["--deny-all"] },
      { name: "--agent-provider", args: ["--agent-provider=acpx"] },
    ];
    for (const option of options) {
      const result = yield* useFixture({ "doc.md": PLAIN_DOC }, function* (fixture) {
        return yield* runCli(["test", "doc.md", ...option.args, "--raw"], env(fixture)).join();
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unrecognized option for xmd test");
      expect(result.stderr).toContain(option.name);
      expect(result.stderr).not.toContain("unavailable");
      expect(result.stdout).not.toContain("PLAIN_MARKER");
    }
  });
});
