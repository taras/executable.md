/**
 * Tier CL — `<Session.Launch>` from the command line
 * (specs/native-agent-session-launch-spec.md §CLI and discovery).
 *
 * The entry UX is the ordinary document-target grammar: `xmd AGENTS.md --help`
 * lists the roles a repository offers, and `xmd AGENTS.md#Implementor` runs
 * exactly one of them. Nothing here is keyed to the filename.
 *
 * These shell out with piped stdio, which is also what makes them the
 * non-terminal case: a piped invocation has no terminal to hand a native UI,
 * so the launch refuses. That refusal is asserted to arrive without an agent
 * ever being resolved, and the fixtures are built so the two are
 * distinguishable: the agents they name do not exist, so any run that probed
 * for one says so in its output.
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

function* useFixture<T>(
  files: Record<string, string>,
  body: (fixture: Fixture) => Operation<T>,
): Operation<T> {
  const root = path.join(os.tmpdir(), `xmd-cl-${randomUUID()}`);
  const fixture: Fixture = { dir: path.join(root, "work"), home: path.join(root, "home") };
  yield* ensureDir(fixture.dir);
  yield* ensureDir(fixture.home);
  return yield* scoped(function* () {
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(fixture.dir, name);
      yield* ensureDir(path.dirname(target));
      yield* writeTextFile(target, content);
    }
    return yield* body(fixture);
  });
}

function env(fixture: Fixture): { cwd: string; env: Record<string, string> } {
  return { cwd: fixture.dir, env: { HOME: fixture.home } };
}

/**
 * A repository's roles, written the way the spec's own example is.
 *
 * The agent names are deliberately nonexistent commands, so anything that
 * resolved an agent would fail saying so. Only help reads this one: an
 * enclosing `<Agent>` is an availability boundary by its own contract, and it
 * resolves before anything inside it runs.
 */
const AGENTS = [
  "# Repository Agents",
  "",
  "PREAMBLE_MARKER",
  "",
  "## Implementor",
  "",
  "The implementor makes changes according to the approved plan.",
  "",
  '<Agent name="xmd-absent-implementor-agent">',
  '  <Session name="implementor">',
  "    <Session.Launch>",
  "IMPLEMENTOR_INSTRUCTIONS",
  "    </Session.Launch>",
  "  </Session>",
  "</Agent>",
  "",
  "## Architect",
  "",
  "The architect reviews settled structural invariants.",
  "",
  '<Agent name="xmd-absent-architect-agent">',
  '  <Session name="architect">',
  "    <Session.Launch>",
  "ARCHITECT_INSTRUCTIONS",
  "    </Session.Launch>",
  "  </Session>",
  "</Agent>",
  "",
].join("\n");

/**
 * The same roles with no enclosing `<Agent>` or `<Session>`.
 *
 * `<Session.Launch>` takes the lexical configuration when it is wrapped and
 * its own props when it is not, so this is the same feature reached without
 * an earlier availability boundary in front of it — which is what makes the
 * terminal the first thing these runs can fail on.
 */
const ROLES = [
  "# Repository Agents",
  "",
  "PREAMBLE_MARKER",
  "",
  "## Implementor",
  "",
  "The implementor makes changes according to the approved plan.",
  "",
  '<Session.Launch session="implementor">',
  "IMPLEMENTOR_INSTRUCTIONS",
  "</Session.Launch>",
  "",
  "## Architect",
  "",
  "The architect reviews settled structural invariants.",
  "",
  '<Session.Launch session="architect">',
  "ARCHITECT_INSTRUCTIONS",
  "</Session.Launch>",
  "",
].join("\n");

const NO_LAUNCH = "PLAIN_MARKER\n\nThis document launches nothing.\n";

describe(
  "Tier CL — Session.Launch from the command line",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("CL1: help lists the roles and installs no agent or launcher", function* () {
      const result = yield* useFixture({ "AGENTS.md": AGENTS }, function* (fixture) {
        return yield* runCli(["run", "AGENTS.md", "--help"], env(fixture)).join();
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("AGENTS.md#Implementor");
      expect(result.stdout).toContain("AGENTS.md#Architect");
      // Discovery executes nothing: no instructions were prepared, and no agent
      // was looked for — an availability probe for these names would have said
      // so on stderr.
      expect(result.stdout).not.toContain("IMPLEMENTOR_INSTRUCTIONS");
      expect(result.stderr).not.toContain("unavailable");
    });

    it("CL2: a piped invocation refuses before any agent is resolved", function* () {
      const result = yield* useFixture({ "AGENTS.md": ROLES }, function* (fixture) {
        return yield* runCli(["run", "AGENTS.md#Implementor", "--raw"], env(fixture)).join();
      });

      expect(result.code).toBe(1);
      const reported = `${result.stdout}${result.stderr}`;
      expect(reported).toContain("<Session.Launch> needs a terminal");
      // The refusal is the terminal's, not an agent's. Nothing was spawned to
      // find out whether an agent was installed, which an unavailability report
      // on this run would have proven otherwise.
      expect(reported).not.toContain("unavailable");
      expect(reported).not.toContain("ACP_BACKEND");
    });

    it("CL3: selecting one role excludes its sibling's preparation", function* () {
      const result = yield* useFixture({ "AGENTS.md": ROLES }, function* (fixture) {
        return yield* runCli(["run", "AGENTS.md#Implementor", "--raw"], env(fixture)).join();
      });

      const reported = `${result.stdout}${result.stderr}`;
      expect(reported).toContain("The implementor makes changes");
      // The other role's section never ran, so neither its prose nor its
      // instructions appear, and only one launch was attempted.
      expect(reported).not.toContain("The architect reviews");
      expect(reported).not.toContain("ARCHITECT_INSTRUCTIONS");
      expect(reported.split("<Session.Launch> needs a terminal").length - 1).toBe(1);
    });

    it("CL4: nothing changes for a document that launches nothing", function* () {
      const result = yield* useFixture({ "doc.md": NO_LAUNCH }, function* (fixture) {
        return yield* runCli(["run", "doc.md", "--raw"], env(fixture)).join();
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("PLAIN_MARKER");
    });

    it("CL5: no behavior is keyed to the filename", function* () {
      const result = yield* useFixture({ "roles/team.md": ROLES }, function* (fixture) {
        return yield* runCli(["run", "roles/team.md#Architect", "--raw"], env(fixture)).join();
      });

      expect(result.code).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("<Session.Launch> needs a terminal");
    });
  },
);
