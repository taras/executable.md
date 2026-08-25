/**
 * Tier WFH — which hosts run a workflow.
 *
 * `xmd workflow` has the same grammar everywhere and the capability in one
 * place. Deno and the compiled binary own the local run store; Node and Bun
 * expose the command and refuse it before anything is created or executed, so
 * a caller learns the boundary from one sentence rather than from a run that
 * half-happened.
 *
 * Which entrypoint is under test is asked of `@executablemd/test-support`,
 * which is the one place runtime detection belongs.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliRuntime, runCli } from "@executablemd/test-support/launch";
import { API } from "@executablemd/runtime";
import {
  GITHUB_ISSUES_ENV,
  GitHubIssuesConfigError,
  gitHubIssuesConfiguration,
} from "../src/github-issues-config.ts";
import {
  GITHUB_PULL_REQUESTS_ENV,
  GitHubPullRequestsConfigError,
  gitHubPullRequestsConfiguration,
} from "../src/github-pull-requests-config.ts";
import {
  HELPER_MODE,
  helperCommand,
  isCredentialHelperMode,
  launcherName,
  launcherProgram,
} from "@executablemd/workflow/credential-helper";
import type {
  HelperAssembly,
  HelperPlatform,
  HelperRuntime,
} from "@executablemd/workflow/credential-helper";
import { HELPER_VARIABLES } from "@executablemd/workflow/credential-helper";

/** The one sentence a host without workflow support says. */
const UNSUPPORTED =
  "xmd workflow is available only through the Deno entrypoint or compiled xmd binary";

const DOCUMENT = ["# Nothing", "", "no effects at all", ""].join("\n");

interface Fixture {
  readonly dir: string;
  readonly runs: string;
  readonly home: string;
}

function useFixture<T>(body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wfh-${randomUUID()}`);
    const fixture: Fixture = {
      dir: join(root, "work"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.dir);
    yield* ensureDir(fixture.home);
    yield* writeTextFile(join(fixture.dir, "flow.md"), DOCUMENT);
    return yield* body(fixture);
  });
}

describe("Tier WFH — workflow host boundary", () => {
  it("WFH1: an unsupported host refuses before creating or executing anything", function* () {
    yield* useFixture(function* (fixture) {
      const result = yield* runCli(["workflow", "start", "flow.md"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();

      if (cliRuntime() === "deno") {
        // The Deno entrypoint has the capability. What it refuses here is the
        // definition — the fixture is not in a repository — which is a
        // different sentence and a different reason.
        expect(result.stderr).not.toContain(UNSUPPORTED);
        return;
      }

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(UNSUPPORTED);
      // Nothing was created: no run store, and no `workflow run:` line, so no
      // run id was ever allocated.
      expect(result.stderr).not.toContain("workflow run:");
      expect(result.stderr).not.toContain("workflow status:");
      expect(yield* exists(fixture.runs)).toBe(false);
    });
  });

  it("WFH2: every host reads the same grammar", function* () {
    yield* useFixture(function* (fixture) {
      const help = yield* runCli(["workflow", "--help"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();

      expect(help.code).toBe(0);
      expect(help.stdout).toContain("xmd workflow");
      expect(help.stdout).toContain("--id");
    });
  });

  it("WFH4: an unsupported host refuses a delivery, and retains nothing", function* () {
    yield* useFixture(function* (fixture) {
      const result = yield* runCli(
        ["workflow", "answer", "any-run", "any-wait", '{"approved":true}'],
        {
          cwd: fixture.dir,
          env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
        },
      ).join();

      expect(result.code).toBe(1);
      if (cliRuntime() === "deno") {
        // The Deno entrypoint has the capability, so what refuses here is the
        // run this delivery named rather than the host.
        expect(result.stderr).toContain("any-run");
        expect(result.stderr).not.toContain(UNSUPPORTED);
        return;
      }
      expect(result.stderr).toContain(UNSUPPORTED);
      // Refused before the store is created, so nothing was retained and no
      // delivery line was written.
      expect(result.stdout).not.toContain("workflow answer:");
      expect(yield* exists(fixture.runs)).toBe(false);
    });
  });

  it("WFH3: an unsupported host refuses a resume too, and reads no store", function* () {
    yield* useFixture(function* (fixture) {
      const result = yield* runCli(["workflow", "resume", "any-run"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();

      expect(result.code).toBe(1);
      if (cliRuntime() === "deno") {
        expect(result.stderr).toContain("any-run");
        return;
      }
      expect(result.stderr).toContain(UNSUPPORTED);
      expect(yield* exists(fixture.runs)).toBe(false);
    });
  });
});

describe("Tier WFH — GitHub issue handling is host configuration", () => {
  /**
   * H1. Which trackers a run may reach is the operator's to state, so it is
   * read from the environment and from nowhere a document can influence.
   *
   * Absence installs no provider, and that is fail-closed by construction
   * rather than by a check: with nothing installed, `<Issue>` meets
   * `IssueApi`'s own base error. Malformed configuration fails here, where an
   * operator can fix it, rather than at the first request in the middle of a
   * run.
   */
  function configured(value: string | undefined): Operation<unknown> {
    return scoped(function* () {
      yield* API.Env.around({
        // deno-lint-ignore require-yield
        *env([name]) {
          return name === GITHUB_ISSUES_ENV ? value : undefined;
        },
      });
      return yield* gitHubIssuesConfiguration();
    });
  }

  it("installs nothing when nothing is configured", function* () {
    expect(yield* configured(undefined)).toBeUndefined();
    expect(yield* configured("")).toBeUndefined();
  });

  it("reads a ceiling, and canonicalizes every entry", function* () {
    const options = yield* configured(
      JSON.stringify({ ceiling: ["https://github.com/octo/project/"] }),
    );
    expect(options).toEqual({ ceiling: ["https://github.com/octo/project"] });

    const withEndpoint = yield* configured(
      JSON.stringify({
        ceiling: ["https://github.com/octo/project"],
        endpoint: "https://ghe.example.invalid/api/v3",
      }),
    );
    expect(withEndpoint).toEqual({
      ceiling: ["https://github.com/octo/project"],
      endpoint: "https://ghe.example.invalid/api/v3",
    });
  });

  it("refuses configuration it cannot use rather than narrowing it", function* () {
    const refused = [
      "not json",
      "[]",
      '"a string"',
      JSON.stringify({}),
      JSON.stringify({ ceiling: [] }),
      JSON.stringify({ ceiling: "https://github.com/octo/project" }),
      JSON.stringify({ ceiling: ["not a url"] }),
      JSON.stringify({ ceiling: ["https://github.com/octo/project?tab=issues"] }),
      JSON.stringify({ ceiling: ["https://github.com/octo/project"], endpoint: 7 }),
      // An operator who wrote a member this host does not know has not
      // configured what they think they have.
      JSON.stringify({ ceiling: ["https://github.com/octo/project"], token: "…" }),
    ];
    for (const value of refused) {
      let raised: unknown;
      try {
        yield* configured(value);
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(GitHubIssuesConfigError);
      expect(String(raised)).toContain(GITHUB_ISSUES_ENV);
    }
  });
});

describe("Tier WFH — GitHub pull-request reading is host configuration", () => {
  /**
   * H2. Which pull requests a run may *read* is the operator's to state, and it
   * is stated as `allowed` — the list of places this host permits — rather than
   * as the architecture's word for the bound it imposes.
   *
   * Absence authorizes no URL read, and disables nothing else: `<PullRequest>`
   * upserts on the authority of this run's own Push evidence, which no
   * environment variable grants or withdraws.
   */
  function configured(value: string | undefined): Operation<unknown> {
    return scoped(function* () {
      yield* API.Env.around({
        // deno-lint-ignore require-yield
        *env([name]) {
          return name === GITHUB_PULL_REQUESTS_ENV ? value : undefined;
        },
      });
      return yield* gitHubPullRequestsConfiguration();
    });
  }

  it("authorizes no read when nothing is configured", function* () {
    expect(yield* configured(undefined)).toBeUndefined();
    expect(yield* configured("")).toBeUndefined();
  });

  it("reads what is allowed, and canonicalizes every entry", function* () {
    const options = yield* configured(
      JSON.stringify({ allowed: ["https://github.com/octo/project/"] }),
    );
    expect(options).toEqual({ allowed: ["https://github.com/octo/project"] });

    // A loopback endpoint with a port: how a deployment points this at
    // something that is not GitHub's own API.
    const withEndpoint = yield* configured(
      JSON.stringify({
        allowed: ["https://github.com/octo/project"],
        endpoint: "http://127.0.0.1:8787/",
      }),
    );
    expect(withEndpoint).toEqual({
      allowed: ["https://github.com/octo/project"],
      endpoint: "http://127.0.0.1:8787",
    });
  });

  it("refuses configuration it cannot use rather than narrowing it", function* () {
    const refused = [
      "not json",
      "[]",
      '"a string"',
      JSON.stringify({}),
      JSON.stringify({ allowed: [] }),
      JSON.stringify({ allowed: "https://github.com/octo/project" }),
      JSON.stringify({ allowed: ["not a url"] }),
      JSON.stringify({ allowed: ["https://github.com/octo/project?tab=pulls"] }),
      JSON.stringify({ allowed: ["https://user:pw@github.com/octo/project"] }),
      JSON.stringify({ allowed: ["https://github.com/octo/project"], endpoint: 7 }),
      JSON.stringify({ allowed: ["https://github.com/octo/project"], endpoint: "not a url" }),
      JSON.stringify({
        allowed: ["https://github.com/octo/project"],
        endpoint: "https://api.github.com?x=1",
      }),
      // The shipped issues contract's word is not this one's.
      JSON.stringify({ ceiling: ["https://github.com/octo/project"] }),
      JSON.stringify({ allowed: ["https://github.com/octo/project"], token: "…" }),
    ];
    for (const value of refused) {
      let raised: unknown;
      try {
        yield* configured(value);
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(GitHubPullRequestsConfigError);
      expect(String(raised)).toContain(GITHUB_PULL_REQUESTS_ENV);
    }
  });
});

/**
 * Tier WFH — the credential helper each host assembles.
 *
 * A host knows what it is; a library guessing from an executable's name does
 * not. So the runtime entrypoints state whether they are Deno source or a
 * compiled binary and which platform they are standing on, and this is where
 * those four combinations are held to one contract.
 *
 * The values are injected rather than read from this machine, which is what lets
 * the Windows shapes be proved on a host that is not Windows. Actually executing
 * them there is delivery's business; what is frozen here is the assembly.
 */
describe("Tier WFH — the credential helper is host assembly", () => {
  const MODULE = "/opt/xmd source/packages/workflow/helper.ts";
  const SPACED = "C:\\Program Files\\xmd\\xmd.exe";

  function assembly(
    runtime: HelperRuntime,
    platform: HelperPlatform,
    execPath: string,
    modulePath?: string,
  ): HelperAssembly {
    return { runtime, platform, execPath, ...(modulePath === undefined ? {} : { modulePath }) };
  }

  it("names the module to Deno from source, and the binary itself when compiled", function* () {
    // From source the executable is Deno, so the helper's module has to be
    // named to it. Compiled, the executable is the host and carries its own
    // mode: there is no module to name and none is invented.
    expect(helperCommand(assembly("source", "unix", "/usr/local/bin/deno", MODULE))).toEqual([
      "/usr/local/bin/deno",
      "run",
      "--allow-all",
      MODULE,
      HELPER_MODE,
    ]);
    expect(helperCommand(assembly("compiled", "unix", "/usr/local/bin/xmd"))).toEqual([
      "/usr/local/bin/xmd",
      HELPER_MODE,
    ]);
  });

  it("writes a shell launcher on Unix and a batch launcher on Windows", function* () {
    const unix = launcherProgram(assembly("source", "unix", "/usr/local/bin/deno", MODULE));
    expect(unix.startsWith("#!/bin/sh\n")).toBe(true);
    expect(launcherName(assembly("source", "unix", "/usr/local/bin/deno", MODULE))).toBe(
      "credential-helper",
    );

    // A `#!` line means nothing on Windows, and a shell that is not present
    // cannot be what starts a credential helper.
    for (const windows of [
      assembly("source", "windows", "C:\\deno\\deno.exe", MODULE),
      assembly("compiled", "windows", SPACED),
    ]) {
      const written = launcherProgram(windows);
      expect(written).not.toContain("#!");
      expect(written.startsWith("@echo off")).toBe(true);
      expect(launcherName(windows)).toBe("credential-helper.cmd");
    }
  });

  it("quotes a path with spaces on either platform", function* () {
    // Neither `Program Files` nor a source tree somebody checked out into a
    // directory with a space in it may split into two words.
    const windows = launcherProgram(assembly("compiled", "windows", SPACED));
    expect(windows).toContain(`"${SPACED}"`);

    const unix = launcherProgram(assembly("source", "unix", "/opt/my deno/deno", MODULE));
    expect(unix).toContain("'/opt/my deno/deno'");
    expect(unix).toContain(`'${MODULE}'`);
  });

  it("passes Git's operation through, whatever the platform", function* () {
    // Git appends `get`, `store` or `erase` to whatever it runs, and the
    // launcher is the thing that has to hand it on.
    expect(launcherProgram(assembly("source", "unix", "/usr/local/bin/deno", MODULE))).toContain(
      '"$@"',
    );
    expect(launcherProgram(assembly("compiled", "windows", SPACED))).toContain("%*");
  });

  it("puts no credential, locator or marker in any launcher", function* () {
    // A launcher outlives nothing: everything it would need to answer with
    // reaches the helper through the private environment of the one command
    // that installed it.
    for (const shape of [
      assembly("source", "unix", "/usr/local/bin/deno", MODULE),
      assembly("compiled", "unix", "/usr/local/bin/xmd"),
      assembly("source", "windows", "C:\\deno\\deno.exe", MODULE),
      assembly("compiled", "windows", SPACED),
    ]) {
      const written = launcherProgram(shape);
      for (const variable of Object.values(HELPER_VARIABLES)) {
        expect(written).not.toContain(variable);
      }
      expect(written).not.toContain("password");
      expect(written).not.toContain("username");
      expect(written).not.toContain("rejected");
    }
  });

  /**
   * The entrypoint itself, asked to be a helper.
   *
   * Calling the predicate proves what it returns; it does not prove that
   * anything consults it. This starts the real Deno-source entrypoint — the one
   * with a public parser in it — hands it a credential request the way Git does,
   * and reads back what a helper answers rather than what a command line parser
   * says about an argument it did not recognize.
   */
  it("answers as a helper when the real source entrypoint is asked to be one", function* () {
    // The Deno source entrypoint is a Deno program, and this file belongs to
    // the Node and Bun corpus as well. Which entrypoint is under test is asked
    // of the harness rather than assumed, exactly as every other case here does.
    if (cliRuntime() !== "deno") {
      return;
    }
    const entrypoint = fileURLToPath(new URL("../src/deno.ts", import.meta.url));
    const credential = { username: "assembly-user", password: "assembly-secret" };
    const outcome = spawnSync(
      // Under Deno this is the Deno binary, which is what runs a source module.
      process.execPath,
      ["run", "--allow-all", entrypoint, HELPER_MODE, "get"],
      {
        input: "protocol=https\nhost=assembly.invalid\npath=octo/one.git\n\n",
        env: {
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
          ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
          [HELPER_VARIABLES.usernameVariable]: credential.username,
          [HELPER_VARIABLES.passwordVariable]: credential.password,
          [HELPER_VARIABLES.protocol]: "https",
          [HELPER_VARIABLES.host]: "assembly.invalid",
          [HELPER_VARIABLES.path]: "octo/one.git",
        },
        encoding: "utf8",
      },
    );

    // Reduced to a label before anything is asserted, so a failure prints a
    // verdict rather than a credential.
    const answered = typeof outcome.stdout === "string" ? outcome.stdout : "";
    expect(answered.includes(credential.password) ? "answered" : "silent").toBe("answered");
    expect(outcome.status).toBe(0);

    // And nothing about a command line. A parser that had seen this first would
    // be refusing an argument it does not know rather than answering Git.
    const said = typeof outcome.stderr === "string" ? outcome.stderr : "";
    expect(said).not.toContain("usage:");
    expect(said).not.toContain("unknown");
    expect(answered).not.toContain("usage:");
  });

  it("is an internal mode, dispatched before public parsing and absent from help", function* () {
    // Selected by an argument no public grammar mentions, and a caller who did
    // not select it gets the ordinary command line unchanged.
    expect(isCredentialHelperMode([HELPER_MODE, "get"])).toBe(true);
    expect(isCredentialHelperMode(["run", "flow.md"])).toBe(false);
    expect(isCredentialHelperMode([])).toBe(false);

    yield* useFixture(function* (fixture) {
      const help = yield* runCli(["--help"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();
      expect(help.code).toBe(0);
      expect(help.stdout).not.toContain(HELPER_MODE);
      // The mode itself, not the word: `--secret-detection` legitimately says
      // what it scans for, and this is about a grammar nobody is offered.
      expect(help.stdout).not.toContain("credential-helper");

      const workflow = yield* runCli(["workflow", "--help"], {
        cwd: fixture.dir,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
      }).join();
      expect(workflow.stdout).not.toContain(HELPER_MODE);
      expect(workflow.stdout).not.toContain("credential-helper");
    });
  });
});
