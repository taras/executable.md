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

/**
 * Tier CO — `xmd agent options` at the command line (issue #828).
 *
 * The command asks an agent what it advertises, so the cases that need no agent
 * are the ones a test can state exactly: a command line this command does not
 * define, and the help that says what asking costs. Both are answered before an
 * agent is resolved, which is the point — inspecting creates a conversation in
 * someone's history, and a wrong command line must not.
 */
describe("Tier CO — xmd agent options", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("CO1: a command line this command does not define is refused before an agent is asked", function* () {
    const refusals: [string[], string][] = [
      [["agent"], "xmd agent names an action"],
      [["agent", "list"], 'does not have a "list" action'],
      [["agent", "options", "codex", "claude"], "at most one agent name"],
      [["agent", "options", "--effort", "high"], "does not recognize --effort"],
      [["agent", "options", "--model"], "needs a model id"],
      [["agent", "options", "--json=true"], "does not take a value"],
    ];
    for (const [args, message] of refusals) {
      const result = yield* useFixture({}, function* (fixture) {
        return yield* runCli(args, env(fixture)).join();
      });
      expect([args.join(" "), result.code]).toEqual([args.join(" "), 1]);
      expect([args.join(" "), result.stderr.includes(message)]).toEqual([args.join(" "), true]);
      // Nothing is written on the way out, so no reader ever sees half an
      // answer — and half of this command's JSON is not JSON.
      expect([args.join(" "), result.stdout]).toEqual([args.join(" "), ""]);
    }
  });

  it("CO2: an agent that is not there fails without printing a partial answer", function* () {
    const result = yield* useFixture({}, function* (fixture) {
      return yield* runCli(
        ["agent", "options", "definitely-not-an-agent-command", "--json"],
        env(fixture),
      ).join();
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("definitely-not-an-agent-command");
    expect(result.stdout).toBe("");
  });

  it("CO3: the help says what inspecting costs, and what it does not", function* () {
    const result = yield* useFixture({}, function* (fixture) {
      return yield* runCli(["agent", "--help"], env(fixture)).join();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("xmd agent options codex --model gpt-5.4 --json");
    // The consequence a reader has to know before running it.
    expect(result.stdout).toContain("may keep that empty conversation in its own history");
    expect(result.stdout).toContain("spends no model turn");
    expect(result.stdout).toContain("creates no durable xmd session");
  });
});
