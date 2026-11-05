/**
 * Tier WFA — retained workflows are an experimental opt-in.
 *
 * `xmd workflow` is available only to an invocation whose operator environment
 * sets `XMD_EXPERIMENTAL_WORKFLOW` to exactly `1`. Every other invocation
 * refuses the whole command family before a workflow host, a run store, a
 * definition, an artifact or a Plugin is reached, while ordinary run and REPL
 * stay exactly as they are.
 *
 * The subprocess cases observe what an operator sees. The in-process cases
 * drive `runXmd` with counting installers, so "reached nothing" is a count
 * rather than an inference from output.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, each, ensure, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, exists, readdir, rm, walk, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliRuntime, runCli } from "@executablemd/test-support/launch";
import { API, useHostFiles } from "@executablemd/runtime";
import { runXmd } from "../src/cli.ts";
import type { UpgradeAssembly } from "../src/upgrade.ts";
import type { WorkflowHost } from "../src/workflow.ts";

const VARIABLE = "XMD_EXPERIMENTAL_WORKFLOW";

const ACTIVATION = "xmd workflow is experimental. Set XMD_EXPERIMENTAL_WORKFLOW=1 to enable it.";

const UNSUPPORTED =
  "xmd workflow is available only through the Deno entrypoint or compiled xmd binary";

const DOCUMENT = ["# Flow", "", "flow-output", ""].join("\n");

const RELEASE = [
  "# Release",
  "",
  '<File path="notes.md">released</File>',
  "",
  "Released.",
  "",
].join("\n");

/** A Plugin module whose only effect is proving it was loaded. */
const MARKER_PLUGIN = [
  'import { writeFileSync } from "node:fs";',
  'writeFileSync(new URL("./plugin-loaded.marker", import.meta.url), "loaded");',
  "export default { name: 'marker' };",
  "",
].join("\n");

/**
 * What xmd wrote to a stream, without the runtime's own warning lines.
 *
 * A newer Node prints a loader deprecation notice on every child's stderr
 * before xmd runs; it is the host's sentence, not the command's.
 */
function said(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\(node:\d+\) /.test(line) && !line.startsWith("(Use `node --trace-"))
    .join("\n")
    .trim();
}

interface Fixture {
  readonly dir: string;
  readonly runs: string;
  readonly home: string;
}

function useFixture<T>(body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wfa-${randomUUID()}`);
    const fixture: Fixture = {
      dir: join(root, "work"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.dir);
    yield* ensureDir(fixture.home);
    yield* writeTextFile(join(fixture.dir, "flow.md"), DOCUMENT);
    yield* writeTextFile(join(fixture.dir, "broken.md"), "---\nprops: [unclosed\n---\n");
    yield* writeTextFile(join(fixture.dir, "damaged.xmd"), "not an artifact at all");
    yield* writeTextFile(join(fixture.dir, "must-not-load.mjs"), MARKER_PLUGIN);
    return yield* body(fixture);
  });
}

function xmd(fixture: Fixture, args: string[], value?: string) {
  return runCli(args, {
    cwd: fixture.dir,
    env: {
      HOME: fixture.home,
      XMD_WORKFLOW_RUNS: fixture.runs,
      ...(value === undefined ? {} : { [VARIABLE]: value }),
    },
  });
}

/** Every file beneath a directory, with its exact bytes. */
function* snapshot(directory: string): Operation<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of yield* each(walk(directory))) {
    if (entry.isFile) {
      files[entry.path] = (yield* until(readFile(entry.path))).toString("base64");
    }
    yield* each.next();
  }
  return files;
}

/** Every refused form an operator could write, through each supported action. */
const DISABLED_INVOCATIONS: readonly (readonly string[])[] = [
  ["workflow", "start", "flow.md"],
  ["workflow", "start", "missing.md"],
  ["workflow", "start", "broken.md"],
  ["workflow", "start", "-"],
  ["workflow", "resume", "release-1"],
  ["workflow", "fork", "release-1", "--at=event-1", "--id=fork-1", "broken.md"],
  ["workflow", "answer", "release-1", "wait-1", '{"approved":true}'],
  ["workflow", "status", "release-1"],
  ["workflow", "status", "--artifact=damaged.xmd"],
  ["workflow", "list"],
  ["workflow", "history", "release-1"],
  ["workflow", "history", "--artifact=damaged.xmd", "--json"],
  ["workflow", "cancel", "release-1"],
  ["workflow", "delete", "release-1"],
  ["workflow", "export", "release-1", "--output=exported.xmd"],
  ["workflow"],
  ["workflow", "import", "damaged.xmd"],
  // `--help` after `--` is a positional, not a help request.
  ["workflow", "start", "--", "--help"],
  ["--plugin", "./must-not-load.mjs", "workflow", "start", "flow.md"],
  ["workflow", "start", "flow.md", "--plugin", "./must-not-load.mjs"],
];

describe("Tier WFA — retained workflow activation", () => {
  it("WFA1: only the exact value 1 enables xmd workflow", function* () {
    yield* useFixture(function* (fixture) {
      for (const value of [undefined, "", "0", "true", "01", "1 ", " 1", "yes"]) {
        const refused = yield* xmd(fixture, ["workflow", "start", "flow.md"], value).join();
        expect({ value, code: refused.code, stderr: said(refused.stderr) }).toEqual({
          value,
          code: 1,
          stderr: ACTIVATION,
        });
        expect(refused.stdout).toBe("");
      }
      expect(yield* exists(fixture.runs)).toBe(false);

      const enabled = yield* xmd(fixture, ["workflow", "start", "flow.md"], "1").join();
      expect(enabled.stderr).not.toContain(ACTIVATION);
      if (cliRuntime() === "deno") {
        // Past activation, the Deno entrypoint refuses the definition: the
        // fixture is not a repository.
        expect(enabled.stderr).not.toContain(UNSUPPORTED);
        return;
      }
      expect(enabled.code).toBe(1);
      expect(enabled.stderr).toContain(UNSUPPORTED);
    });
  });

  it("WFA2: every action refuses through one boundary, and reads or writes nothing", function* () {
    yield* useFixture(function* (fixture) {
      const before = yield* snapshot(fixture.dir);
      for (const args of DISABLED_INVOCATIONS) {
        const refused = yield* xmd(fixture, [...args]).join();
        expect({ args, code: refused.code, stderr: said(refused.stderr) }).toEqual({
          args,
          code: 1,
          stderr: ACTIVATION,
        });
        expect(refused.stdout).toBe("");
      }
      // No run store, no export, no Plugin, no sidecar beside a definition or
      // an artifact, and every input byte-identical.
      expect(yield* exists(fixture.runs)).toBe(false);
      expect(yield* snapshot(fixture.dir)).toEqual(before);
    });
  });

  it("WFA3: disabled workflow help explains activation and nothing else", function* () {
    yield* useFixture(function* (fixture) {
      const forms = [
        ["workflow", "--help"],
        ["--help", "workflow"],
        ["workflow", "-h"],
        ["workflow", "start", "missing.md", "-h"],
        ["workflow", "fork", "release-1", "--at=event-1", "broken.md", "--help"],
        ["--plugin", "./must-not-load.mjs", "workflow", "--help"],
      ];
      for (const value of [undefined, "true"]) {
        for (const args of forms) {
          const help = yield* xmd(fixture, args, value).join();
          expect({ args, code: help.code, stdout: help.stdout.trim() }).toEqual({
            args,
            code: 0,
            stdout: ACTIVATION,
          });
          expect(said(help.stderr)).toBe("");
        }
      }
      expect(yield* exists(join(fixture.dir, "plugin-loaded.marker"))).toBe(false);
      expect(yield* exists(fixture.runs)).toBe(false);

      const enabled = yield* xmd(fixture, ["workflow", "--help"], "1").join();
      expect(enabled.code).toBe(0);
      expect(enabled.stdout).toContain("Usage: xmd workflow");
      expect(enabled.stdout).toContain("--id");
      expect(enabled.stdout).toContain(ACTIVATION);
    });
  });

  it("WFA4: a leading Plugin selection loads under exact opt-in, so its absence is meaningful", function* () {
    // The control for WFA2's Plugin rows: the same command line, enabled, does
    // reach Plugin loading on the host that runs workflows.
    if (cliRuntime() !== "deno") {
      return;
    }
    yield* useFixture(function* (fixture) {
      yield* xmd(
        fixture,
        ["--plugin", "./must-not-load.mjs", "workflow", "start", "flow.md"],
        "1",
      ).join();
      expect(yield* exists(join(fixture.dir, "plugin-loaded.marker"))).toBe(true);
    });
  });

  it("WFA5: ordinary run and REPL help need no opt-in", function* () {
    yield* useFixture(function* (fixture) {
      // A file named `workflow` selected explicitly is an ordinary document.
      yield* writeTextFile(join(fixture.dir, "workflow"), "# Ordinary\n\nordinary-output\n");
      const named = yield* xmd(fixture, ["run", "workflow"]).join();
      expect(named.code).toBe(0);
      expect(named.stdout).toContain("ordinary-output");

      const plain = yield* xmd(fixture, ["flow.md"]).join();
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain("flow-output");

      // Inline source is document text, not argv, whatever it says.
      const inline = yield* xmd(fixture, [
        "run",
        "--eval",
        "# Inline\n\nworkflow -h XMD_EXPERIMENTAL_WORKFLOW=1\n",
      ]).join();
      expect(inline.code).toBe(0);
      expect(inline.stdout).toContain("workflow -h XMD_EXPERIMENTAL_WORKFLOW=1");

      const repl = yield* xmd(fixture, ["repl", "--help"]).join();
      expect(repl.code).toBe(0);
      expect(repl.stdout).toContain("Usage: xmd repl");
      expect(repl.stdout).toContain("ENTRIES");
    });
  });
});

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/** The status the `workflow status:` line reported. */
function reportedStatus(stderr: string): string | undefined {
  const line = stderr.split("\n").find((entry) => entry.startsWith("workflow status: "));
  return line?.slice("workflow status: ".length).trim();
}

describe("Tier WFA — saved state grants no opt-in", () => {
  it("WFA6: a completed run and its artifact work enabled and refuse disabled", function* () {
    // The run store and artifact adapters open node:sqlite through the Deno
    // entrypoint only; under Node and Bun nothing can be retained to begin with.
    if (cliRuntime() !== "deno") {
      return;
    }
    yield* useFixture(function* (fixture) {
      yield* writeTextFile(join(fixture.dir, "flows-release.md"), RELEASE);
      yield* git(fixture.dir, ["init", "-q", "--initial-branch=main", "."]);
      yield* git(fixture.dir, ["config", "user.email", "tier-wfa@example.test"]);
      yield* git(fixture.dir, ["config", "user.name", "Tier WFA"]);
      yield* git(fixture.dir, ["add", "flows-release.md"]);
      yield* git(fixture.dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "definition"]);

      const started = yield* xmd(
        fixture,
        ["workflow", "start", "--id=release-1", "flows-release.md"],
        "1",
      ).join();
      expect(started.code).toBe(0);
      expect(reportedStatus(started.stderr)).toBe("completed");
      expect(started.stdout).toContain("Released.");

      const resumed = yield* xmd(fixture, ["workflow", "resume", "release-1"], "1").join();
      expect(resumed.code).toBe(0);
      expect(reportedStatus(resumed.stderr)).toBe("completed");

      const status = yield* xmd(fixture, ["workflow", "status", "release-1"], "1").join();
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("status: completed");
      const history = yield* xmd(fixture, ["workflow", "history", "release-1"], "1").join();
      expect(history.code).toBe(0);

      const artifact = join(fixture.dir, "evidence.xmd");
      const exported = yield* xmd(
        fixture,
        ["workflow", "export", "release-1", `--output=${artifact}`],
        "1",
      ).join();
      expect(exported.code).toBe(0);
      const inspected = yield* xmd(
        fixture,
        ["workflow", "status", `--artifact=${artifact}`],
        "1",
      ).join();
      expect(inspected.code).toBe(0);
      expect(inspected.stdout).toContain("status: completed");

      const runs = yield* snapshot(fixture.runs);
      const work = yield* snapshot(fixture.dir);
      const listing = (yield* readdir(fixture.dir)).sort();

      for (const args of [
        ["workflow", "resume", "release-1"],
        ["workflow", "status", "release-1"],
        ["workflow", "status", `--artifact=${artifact}`],
        ["workflow", "history", `--artifact=${artifact}`],
        ["workflow", "export", "release-1", `--output=${join(fixture.dir, "again.xmd")}`],
      ]) {
        const refused = yield* xmd(fixture, args).join();
        expect({ args, code: refused.code, stderr: said(refused.stderr) }).toEqual({
          args,
          code: 1,
          stderr: ACTIVATION,
        });
        expect(refused.stdout).toBe("");
      }
      expect(yield* snapshot(fixture.runs)).toEqual(runs);
      expect(yield* snapshot(fixture.dir)).toEqual(work);
      expect((yield* readdir(fixture.dir)).sort()).toEqual(listing);
    });
  });
});

/**
 * The exit continuation `exit()` reaches for.
 *
 * `main()` installs one under this name; driving `runXmd` directly installs its
 * own, so a status is a value and several invocations share one process.
 */
const ExitContext = createContext<(result: { status: number }) => Operation<void>>("exit");

interface Counts {
  workflowHost: number;
  service: number;
  standardInput: number;
  plugins: number;
  repl: number;
}

interface Invocation {
  readonly status: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

const UPGRADE: UpgradeAssembly = {
  provenance: "deno-source",
  currentVersion: "0.0.0-test",
  executablePath: "/nonexistent/xmd",
  platform: "linux",
  architecture: "x64",
};

const HOST_REACHED = "the workflow host installer was called";

/**
 * One in-process invocation under a contextual answer for the activation
 * variable, with every host capability replaced by a counter.
 */
function* invoke(
  args: string[],
  answer: string | undefined,
  counts: Counts,
): Operation<Invocation> {
  let status: number | undefined;
  let stdout = "";
  let stderr = "";
  const wrote = console.log;
  const warned = console.error;
  yield* scoped(function* () {
    yield* ensure(() => {
      console.log = wrote;
      console.error = warned;
    });
    console.log = (...parts: unknown[]) => {
      stdout += `${parts.map(String).join(" ")}\n`;
    };
    console.error = (...parts: unknown[]) => {
      stderr += `${parts.map(String).join(" ")}\n`;
    };
    yield* ExitContext.set(function* (result) {
      status = result.status;
    });
    yield* API.Env.around({
      *env([name], next) {
        return name === VARIABLE ? answer : yield* next(name);
      },
    });
    yield* useHostFiles();
    try {
      yield* runXmd(
        args,
        function* () {
          counts.service += 1;
        },
        UPGRADE,
        function* (): Operation<Result<string>> {
          counts.standardInput += 1;
          throw new Error("standard input was read");
        },
        function* (): Operation<unknown> {
          counts.plugins += 1;
          throw new Error("a Plugin module was loaded");
        },
        function* (): Operation<WorkflowHost> {
          counts.workflowHost += 1;
          throw new Error(HOST_REACHED);
        },
        undefined,
        {
          install: function* (): Operation<void> {
            counts.repl += 1;
            throw new Error("the REPL host was installed");
          },
        },
      );
    } catch (error) {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`;
      status ??= 1;
    }
  });
  return { status, stdout, stderr };
}

function zero(): Counts {
  return { workflowHost: 0, service: 0, standardInput: 0, plugins: 0, repl: 0 };
}

/** Set the host environment to the opposite of what the contextual Env answers. */
function* nativeVariable(value: string | undefined): Operation<void> {
  const previous = process.env[VARIABLE];
  yield* ensure(() => {
    if (previous === undefined) {
      delete process.env[VARIABLE];
    } else {
      process.env[VARIABLE] = previous;
    }
  });
  if (value === undefined) {
    delete process.env[VARIABLE];
  } else {
    process.env[VARIABLE] = value;
  }
}

describe("Tier WFA — activation is read from the invocation's contextual environment", () => {
  it("WFA7: disabled refusal and help reach no host capability, whatever the host says", function* () {
    yield* nativeVariable("1");
    for (const args of [
      ["workflow", "start", "flow.md"],
      ["workflow", "start", "-"],
      ["--plugin", "./must-not-load.mjs", "workflow", "start", "flow.md"],
      ["workflow", "status", "--artifact=damaged.xmd"],
      ["workflow", "answer", "release-1", "wait-1", "{}"],
    ]) {
      const counts = zero();
      const refused = yield* invoke(args, undefined, counts);
      expect({ args, status: refused.status, stderr: said(refused.stderr) }).toEqual({
        args,
        status: 1,
        stderr: ACTIVATION,
      });
      expect(counts).toEqual(zero());
    }

    for (const args of [
      ["workflow", "--help"],
      ["workflow", "start", "missing.md", "-h"],
    ]) {
      const counts = zero();
      const help = yield* invoke(args, "0", counts);
      expect({ args, status: help.status, stdout: help.stdout.trim() }).toEqual({
        args,
        status: 0,
        stdout: ACTIVATION,
      });
      expect(counts).toEqual(zero());
    }
  });

  it("WFA8: a contextual 1 enables help and reaches the workflow host", function* () {
    yield* nativeVariable(undefined);
    const helpCounts = zero();
    const help = yield* invoke(["workflow", "--help"], "1", helpCounts);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--id");
    expect(help.stdout).toContain(ACTIVATION);
    expect(helpCounts).toEqual(zero());

    const counts = zero();
    const started = yield* invoke(["workflow", "start", "flow.md"], "1", counts);
    expect(started.status).toBe(1);
    expect(started.stderr).toContain(HOST_REACHED);
    expect(counts).toEqual({ ...zero(), workflowHost: 1 });
  });

  it("WFA9: each invocation in one process reads its own answer", function* () {
    const counts = zero();
    const enabled = yield* invoke(["workflow", "start", "flow.md"], "1", counts);
    expect(enabled.stderr).toContain(HOST_REACHED);
    const disabled = yield* invoke(["workflow", "start", "flow.md"], undefined, counts);
    expect(disabled.stderr.trim()).toBe(ACTIVATION);
    const again = yield* invoke(["workflow", "start", "flow.md"], "1", counts);
    expect(again.stderr).toContain(HOST_REACHED);
    expect(counts).toEqual({ ...zero(), workflowHost: 2 });
  });

  it("WFA10: the REPL is reached without the opt-in", function* () {
    const counts = zero();
    const repl = yield* invoke(["repl"], undefined, counts);
    expect(repl.stderr).toContain("the REPL host was installed");
    expect(counts).toEqual({ ...zero(), repl: 1 });
  });
});
