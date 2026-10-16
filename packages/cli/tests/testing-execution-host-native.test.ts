/**
 * Why this proof is its own file.
 *
 * It imports the configured native Plugin, which comes from
 * `@executablemd/git/deno` — a graph that reaches `node:sqlite`. A runtime
 * without that module cannot load this module at all, and one that could load
 * it still has no Deno adapter to initialize. The runtime exclusions keep this
 * file out of the Node and Bun suites, which is why it is not one more row in
 * `testing-execution-host.test.ts`: every row there is host-neutral and runs
 * everywhere.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, until } from "effection";
import type { Operation } from "effection";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Execution } from "@executablemd/core/api";
import type { Plugin, PluginInstallation } from "@executablemd/core/api";
import { cwd } from "@executablemd/runtime";
import { cliBase } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import type { HelperAssembly } from "@executablemd/git/credential-helper";
import { planComponentDeclaration } from "../src/plan-component.ts";
import { testingExecutionHost } from "../src/testing-host.ts";
import type { TestingHostSettings } from "../src/testing-host.ts";
import { BundledRunPlugin } from "../src/run-profile.ts";
import { denoRunRepositories } from "../src/deno-repositories.ts";

/**
 * C1 — the native host an isolated run child actually initializes.
 *
 * A test root is not a run profile: it activates no bundled Plugin and has no
 * operational repository provider of its own. Its `<Execution host="run">`
 * child *is* an ordinary run, so it has to receive what this host selected —
 * and what it receives is the inert Plugin value the command captured before
 * any document code ran, never a live provider and never whatever a document
 * put in the Context afterwards.
 *
 * This is asked of a configured native variant rather than the provider-neutral
 * default, because the defect worth catching is a child initialized with the
 * wrong host's Plugin: one hard-coded to the statically bundled value would
 * satisfy every assertion about names while reaching a managed root nobody
 * configured.
 */
describe("C1 — the native host a run child initializes", () => {
  /** A bare remote a child may clone without reaching a network. */
  function* useBareRemote(home: string): Operation<string> {
    const parent = yield* until(realpath(yield* useTempDirectory("xmd-c1-remote-")));
    const seed = join(parent, "seed");
    git(["init", "--initial-branch=main", seed], parent, home);
    git(["commit", "--allow-empty", "-m", "first"], seed, home);
    const bare = join(parent, "remote.git");
    git(["clone", "--bare", "--", seed, bare], parent, home);
    return bare;
  }

  /** The configured native Plugin, with each execution it initializes recorded. */
  function observedNative(initialized: string[], root: string): Plugin {
    const native = denoRunRepositories(HELPER, root);
    return {
      name: native.name,
      *install(request): Operation<PluginInstallation | undefined> {
        const install = native.install;
        const declared = install === undefined ? undefined : yield* install(request);
        if (declared === undefined) {
          return undefined;
        }
        yield* Execution.around({
          *init(_args, next): Operation<void> {
            initialized.push(`${request.command}@${yield* cwd()}`);
            yield* next();
          },
        });
        return declared;
      },
    };
  }

  it("E9: gives a test root's run child the captured configured Plugin, once", function* () {
    const home = yield* useTempDirectory("xmd-c1-home-");
    const remote = yield* useBareRemote(home);
    // This fixture's own managed root, so where a clone lands is observable and
    // nothing reaches the tree a production run owns.
    const managed = yield* until(realpath(yield* useTempDirectory("xmd-c1-managed-")));
    const root = join(managed, "repositories");
    // Where the child stands: a directory the parent chose, which is what a
    // `<Dir>` around the `<Execution>` selects.
    const workspace = yield* until(realpath(yield* useTempDirectory("xmd-c1-work-")));

    const initialized: string[] = [];
    const settings = hostSettings({ bundledPlugin: observedNative(initialized, root) });
    const host = testingExecutionHost(settings);

    // A document could replace the selection after the command captured it.
    // What it replaces it with here would be visible if the child read it: this
    // one declares for every document command and records a different word.
    const replaced: string[] = [];
    yield* BundledRunPlugin.set({
      name: "@executablemd/git",
      *install(): Operation<PluginInstallation | undefined> {
        yield* Execution.around({
          *init(_args, next): Operation<void> {
            replaced.push("replaced");
            yield* next();
          },
        });
        return {};
      },
    });

    let rendered = "";
    const settlement = yield* host.runChild({
      request: {
        host: "run",
        source:
          `<Repository name="project" url="${remote}" as="repository" />\n` +
          "selected {repository}\n",
        props: {},
        journal: "transient",
        collectJournal: false,
        configuration: [],
      },
      run: undefined,
      cwd: workspace,
      *chunk(text: string): Operation<void> {
        rendered += text;
      },
    });
    rendered += settlement.output;

    // The child ran, and the repository work an ordinary run can do worked.
    expect(settlement.outcome.kind).toBe("settled");
    expect(settlement.outcome.kind === "settled" ? settlement.outcome.result.ok : false).toBe(true);
    // Exactly one initialization, for command `run`, standing where the parent
    // put the child rather than where this process is.
    expect(initialized).toEqual([`run@${workspace}`]);
    // And it was the captured value that did it: the Context the document
    // replaced afterwards never reached the child.
    expect(replaced).toEqual([]);
    // The clone landed under the root this fixture configured, which is what
    // proves the *configured* Plugin arrived rather than a default one.
    expect(rendered).toContain(root);
    expect(rendered).toContain("selected ");
  });
});

/**
 * What this suite's host is, stated the way the Deno entrypoint states it.
 *
 * The same shape `deno.ts` builds, because what the configured Plugin holds is
 * host configuration: a fixture that invented a different one would be
 * measuring its own invention.
 */
const HELPER: HelperAssembly = {
  runtime: "source",
  platform: process.platform === "win32" ? "windows" : "unix",
  execPath: process.execPath,
  modulePath: fileURLToPath(new URL("../src/credential-helper-entry.ts", import.meta.url)),
  launcherEnvironment: {},
};

/** Git, run with configuration nobody's machine contributes to. */
function git(args: readonly string[], directory: string, home: string): string {
  const outcome = spawnSync("git", [...args], {
    cwd: directory,
    env: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
    encoding: "utf8",
  });
  if (outcome.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${outcome.stderr}`);
  }
  return outcome.stdout;
}

/** The host settings a command assembles, with one member under test. */
function hostSettings(chosen: { readonly bundledPlugin: Plugin }): TestingHostSettings {
  return {
    includes: [],
    plugins: [],
    pluginArgs: [],
    secretDetection: false,
    // deno-lint-ignore require-yield
    installService: function* (): Operation<void> {},
    bundledPlugin: chosen.bundledPlugin,
    testAgentWorker: Ok([...cliBase(), "test-agent"]),
    planDeclaration: (request) =>
      planComponentDeclaration({
        surface: "component",
        includes: [],
        context: request.context,
        ...(request.planWriterRoot === undefined ? {} : { planWriterRoot: request.planWriterRoot }),
        host: request.host,
        ...(request.observePlanWriter === undefined
          ? {}
          : { observePlanWriter: request.observePlanWriter }),
        installElicitation: request.installElicitation,
      }),
  };
}
