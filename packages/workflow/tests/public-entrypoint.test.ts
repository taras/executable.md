/**
 * Tier WA — what a loaded package can reach through the published entrypoint.
 *
 * The adapter holds a credential in memory for one invocation and hands it to
 * its own Git children. That containment is only worth as much as the surface
 * around it: a `RepositoryHost` sees every `GitInvocation`, and an authenticated
 * one carries the attachment the credential travels in. If a package a document
 * loaded could install one — or reach the options that accept one — then
 * everything else in this contract is arithmetic on a value it has already read.
 *
 * So the exploit is attempted rather than described, through the bare specifier
 * a stranger would import, and it is attempted in a process of its own. The
 * factory this looks for asks the *invoking* environment for a credential, and
 * in-process that environment is the developer's. A regression in the exports
 * must not become a test that queries a real credential store — so the probe's
 * whole environment is an isolated home, and the only helper it can reach is one
 * this suite wrote and can read the log of.
 *
 * No outcome is ever anything but a fixed word.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { withWorkflowWorkspace } from "@executablemd/workflow/deno";
import type { WorkflowWorkspaceOptions } from "@executablemd/workflow/deno";
import * as published from "@executablemd/workflow/deno";
import * as root from "@executablemd/workflow";
import { useInvokingHome } from "../../git/tests/support/credential-home.ts";
import { readdir, readTextFile, stat } from "@effectionx/fs";
import type { Operation } from "effection";

/**
 * A compile-time proof, not a runtime one.
 *
 * `Assert<false>` is the only instantiation that type-checks, so this stops
 * compiling the moment `composition` becomes a key of the published options —
 * which is the moment a substituted host has somewhere to go.
 */
type Assert<T extends false> = T;
type CompositionIsNotAKey = Assert<
  "composition" extends keyof WorkflowWorkspaceOptions ? true : false
>;

/** Named so the type above is used rather than merely written. */
const COMPOSITION_IS_NOT_A_KEY: CompositionIsNotAKey = false;

/** The synthetic repository the probe asks about. Nothing serves it. */
const LOCATOR = "https://exploit.invalid/octo/one.git";

const PROBE = fileURLToPath(new URL("./support/public-entrypoint-probe.ts", import.meta.url));
const HELPER_MODULE = fileURLToPath(
  new URL("../../git/tests/support/credential-helper-entry.ts", import.meta.url),
);

describe("workflow published Deno entrypoint", () => {
  it("offers no route from the entrypoint to an authenticated invocation", function* () {
    const home = yield* useInvokingHome([
      {
        host: "exploit.invalid",
        path: "octo/one.git",
        username: "probe-user",
        password: "probe-secret",
      },
    ]);

    const outcome = spawnSync(
      process.execPath,
      ["run", "--allow-all", PROBE, LOCATOR, HELPER_MODULE],
      {
        // Exactly the isolated home, plus what a Deno program needs to start:
        // where its module cache is, which is a host path and not a credential
        // source. Nothing here can reach the developer's Git configuration.
        env: {
          ...home.ambient,
          ...(process.env.DENO_DIR === undefined ? {} : { DENO_DIR: process.env.DENO_DIR }),
          ...(process.env.XDG_CACHE_HOME === undefined
            ? {}
            : { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }),
        },
        encoding: "utf8",
      },
    );

    // One word, and the word is that the factory was not there to call.
    expect(typeof outcome.stdout === "string" ? outcome.stdout.trim() : "").toBe("absent");
    expect(outcome.status).toBe(0);

    // And the isolated chain was never asked anything, which is what makes the
    // absence a fact about behavior rather than about a name.
    expect(yield* home.operations()).toEqual([]);
  });

  it("never reads a legacy composition property a caller invents", function* () {
    const home = yield* useInvokingHome([
      {
        host: "exploit.invalid",
        path: "octo/one.git",
        username: "probe-user",
        password: "probe-secret",
      },
    ]);

    const recorded: string[] = [];
    const read: string[] = [];
    const hostile = {
      get composition() {
        // Reached only if the wrapper spreads what it was handed instead of
        // naming what it accepts.
        read.push("composition");
        return {
          host: {
            git(invocation: { args: readonly string[] }) {
              recorded.push(invocation.args.join(" "));
              return { code: 0, stdout: "", stderr: "" };
            },
            useDirectory: () => "/tmp",
          },
        };
      },
    };

    // Applied rather than called, so the property travels on a real argument
    // object through the real published function.
    try {
      Reflect.apply(withWorkflowWorkspace, undefined, [{}, function* () {}, hostile]);
    } catch {
      // A bogus database fails somewhere past the projection. What matters is
      // what was read on the way there.
    }

    expect(read).toEqual([]);
    expect(recorded).toEqual([]);
    expect(yield* home.operations()).toEqual([]);
  });

  it("publishes the host-owned names and keeps the private seams private", function* () {
    // Read from the module rather than the source, so a re-export added
    // anywhere in the graph is caught here.
    const reachable = Object.keys(published);
    expect(reachable).toContain("withWorkflowWorkspace");
    // The Git vocabulary is not this package's to publish any more. Its effect
    // types, its providers and its leaf substitution seams are all absent —
    // the constants because the feature moved, the seams because a package a
    // document loaded could read a credential through one.
    for (const moved of [
      "WORKSPACE_GIT_ADD",
      "WORKSPACE_GIT_SWITCH",
      "WORKSPACE_REPOSITORY",
      "WORKSPACE_WORKTREE",
      "denoRepositoryHost",
      "useRepositoryComposition",
      "useGitComposition",
      "denoGitAuthentication",
      "denoCredentialBroker",
      "useRunComposition",
      "useGitHubIssues",
      "useGitHubPullRequests",
      "Git",
      "GitQuery",
      "resolveGitRevision",
      "workflowInstallation",
    ]) {
      expect({ name: moved, reachable: reachable.includes(moved) }).toEqual({
        name: moved,
        reachable: false,
      });
    }
    expect(COMPOSITION_IS_NOT_A_KEY).toBe(false);
    expect(yield* until(Promise.resolve(true))).toBe(true);
  });

  it("publishes the three generic extension boundaries and no seam behind them", function* () {
    const shared = Object.keys(root);
    const deno = Object.keys(published);

    // What a trusted host outside this package composes with: how it states
    // what its own run is, how it performs one Workspace-coordinated durable
    // mutation, how it reads the Workspace without performing one, and how it
    // tells a failure it may journal from one that fails the run.
    expect(shared).toContain("createWorkflowRunInstallation");
    expect(deno).toContain("createWorkflowWorkspaceEffect");
    expect(deno).toContain("readWorkflowWorkspace");
    expect(deno).toContain("JournaledEffectFailure");
    expect(deno).toContain("isJournalableWorkspaceFailure");

    // And what it still cannot reach. A mutation receives its storage view from
    // the transaction that owns it; a caller that could build one, open a
    // private transaction, mint a transaction token, restore a root, or install
    // the private provider would be holding the authority this boundary exists
    // to keep.
    for (const seam of [
      "createWorkflowWorkspaceStorage",
      "guardedWorkflowWorkspaceStorage",
      "guardedWorkflowWorkspaceReadStorage",
      "usePrivateWorkspace",
      "withPrivateWorkspaceTransaction",
      "transactWorkspaceRoots",
      "workflowRunTransactionToken",
      "validateWorkflowRunTransactionToken",
      "useWorkspaceEffects",
      "withWorkspaceEffects",
      "createWorkflowRunConnections",
      "restoreWorkspaceRoot",
      "captureWorkspaceRoot",
      "setCurrentWorkspaceRoot",
      "savepoint",
    ]) {
      expect({ seam, reachable: deno.includes(seam) || shared.includes(seam) }).toEqual({
        seam,
        reachable: false,
      });
    }
    expect(yield* until(Promise.resolve(true))).toBe(true);
  });
});

/**
/**
 * Where the Git feature is, and where it is not.
 *
 * #443 held one module — `src/run.ts` — to a single named Git import, because
 * everything else that retained, recognized, resumed or sealed a run already
 * reached no repository. #822 finishes that: the feature is its own package, so
 * the rule is no longer "one exception" but "none at all".
 *
 * These read the source tree rather than the module graph. An import is a fact
 * about a file, and a test that only exercised behaviour would pass right up
 * until something imported Git and never used it.
 */
describe("the boundary between workflow and git", () => {
  function packageFile(pkg: string, relative: string): string {
    return fileURLToPath(new URL(`../../${pkg}/${relative}`, import.meta.url));
  }

  /**
   * Every module specifier a file names, in every form that reaches one.
   *
   * `from "x"` is only one of them. A bare `import "x"` runs a module for its
   * effects, `import("x")` reaches one at runtime, and `require("x")` reaches
   * one from CommonJS — so the specifier is extracted from all four rather than
   * the statement matched in one.
   */
  function specifiers(source: string): string[] {
    const found: string[] = [];
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        found.push(specifier);
      }
    }
    return found;
  }

  /** Every `.ts` file under one directory of one package, recursively. */
  function* moduleFiles(pkg: string, relative: string): Operation<string[]> {
    const found: string[] = [];
    for (const name of yield* readdir(packageFile(pkg, relative))) {
      const child = `${relative}/${name}`;
      const stats = yield* stat(packageFile(pkg, child));
      if (stats.isDirectory()) {
        found.push(...(yield* moduleFiles(pkg, child)));
      } else if (name.endsWith(".ts")) {
        found.push(child);
      }
    }
    return found;
  }

  function* productionModules(pkg: string): Operation<string[]> {
    return [...(yield* moduleFiles(pkg, "src")), "mod.ts", "deno.ts"];
  }

  /** Whether a specifier names the Git package or the local Git capability. */
  function namesGit(specifier: string): boolean {
    return /(?:^|\/)git\.ts$/.test(specifier) || /^@executablemd\/git(?:\/|$)/.test(specifier);
  }

  /** Whether a specifier names the GitHub package. */
  function namesGitHub(specifier: string): boolean {
    return /^@executablemd\/github(?:\/|$)/.test(specifier);
  }

  /** Whether a specifier reaches into another package's source rather than its entrypoint. */
  function reachesWorkflowSource(specifier: string): boolean {
    return /(?:^|\/)workflow\/(src|tests)\//.test(specifier);
  }

  it("names Git in no workflow production module, in any import form", function* () {
    const scanned = yield* productionModules("workflow");

    // The scan has to be looking at something: a glob that matched nothing
    // would pass this case every time.
    expect(scanned.length).toBeGreaterThan(40);
    expect(scanned).toContain("src/run.ts");
    expect(scanned).toContain("src/deno/transitions.ts");
    expect(scanned).toContain("src/storage/source-bundle.ts");
    expect(scanned).toContain("src/lifecycle/forkability.ts");
    expect(scanned).toContain("mod.ts");
    expect(scanned).toContain("deno.ts");

    // And the matcher has to recognize what it is looking for. Each of these is
    // a way a module could reach Git without writing `from`.
    for (const form of [
      'import { resolveGitRevision } from "./git.ts";',
      'import "../git.ts";',
      'const git = await import("./git.ts");',
      'const git = require("@executablemd/git");',
      'export { resolveGitRevision } from "../../git.ts";',
      'export { gitPlugin } from "@executablemd/git";',
    ]) {
      expect({ form, git: specifiers(form).filter(namesGit).length }).toEqual({ form, git: 1 });
    }
    expect(specifiers('import { reading } from "./reading.ts";').filter(namesGit)).toEqual([]);

    const importing: string[] = [];
    for (const relative of scanned) {
      const source = yield* readTextFile(packageFile("workflow", relative));
      if (specifiers(source).some(namesGit) || specifiers(source).some(namesGitHub)) {
        importing.push(relative);
      }
    }
    // No exception. #443's single `run.ts` allowance is gone with the feature.
    expect(importing).toEqual([]);
  });

  it("reaches workflow only through its entrypoints, and github not at all", function* () {
    const scanned = yield* productionModules("git");
    expect(scanned.length).toBeGreaterThan(40);
    expect(scanned).toContain("mod.ts");
    expect(scanned).toContain("deno.ts");
    expect(scanned).toContain("src/plugin.ts");

    const sourceReaching: string[] = [];
    const gitHubReaching: string[] = [];
    for (const relative of scanned) {
      const source = yield* readTextFile(packageFile("git", relative));
      const named = specifiers(source);
      if (named.some(reachesWorkflowSource)) {
        sourceReaching.push(relative);
      }
      if (named.some(namesGitHub)) {
        gitHubReaching.push(relative);
      }
    }
    // Workflow is a dependency with two doors, and this package uses them.
    expect(sourceReaching).toEqual([]);
    expect(gitHubReaching).toEqual([]);

    // The matcher recognizes what it is looking for.
    expect(reachesWorkflowSource("../../workflow/src/deno/workspace/host.ts")).toBe(true);
    expect(reachesWorkflowSource("@executablemd/workflow/deno")).toBe(false);
  });
});
