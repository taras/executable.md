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
import { useInvokingHome } from "./support/credential-home.ts";
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
  new URL("./support/credential-helper-entry.ts", import.meta.url),
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
    for (const constant of [
      "WORKSPACE_GIT_ADD",
      "WORKSPACE_GIT_SWITCH",
      "WORKSPACE_REPOSITORY",
      "WORKSPACE_WORKTREE",
    ]) {
      expect(reachable).toContain(constant);
    }
    for (const seam of [
      "denoRepositoryHost",
      "useRepositoryComposition",
      "useGitComposition",
      "denoGitAuthentication",
      "denoCredentialBroker",
    ]) {
      expect(reachable).not.toContain(seam);
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
 * What the retained path is allowed to depend on.
 *
 * A version-1 definition's Markdown lives in a repository, and #443's whole
 * point is that the modules which retain, recognize, resume, journal and seal a
 * run do not reach one themselves — a trusted host supplies that capability as
 * a direct closure instead. So this reads the source tree rather than the
 * module graph: an import is a fact about a file, and a test that only exercised
 * behaviour would pass right up until something imported Git and never used it.
 *
 * One exception, and it is pinned rather than granted. `src/run.ts` holds the
 * public `workflowInstallation({ base })` convenience, which resolves a base
 * through `Git.revParse()`. What this permits is that one named import and its
 * one use inside the allocation path — not the file. A second Git operation
 * reaching `run.ts`, or `revParse()` moving out of `allocating()` and into the
 * retained path, fails here as surely as an import anywhere else would.
 * #822 moves that adapter into the bundled Git Plugin.
 */
describe("workflow retained modules and the Git capability", () => {
  /** The directories whose modules retain, recognize, resume or seal a run. */
  const RETAINED = ["src/storage", "src/lifecycle", "src/deno/artifact", "src/deno/workspace"];

  /** Single files on that same path, beside the directories above. */
  const RETAINED_FILES = ["src/journal.ts", "src/fork.ts", "src/bundle.ts"];

  /**
   * The one module #822 has not moved yet.
   *
   * Named as a path rather than allowed by pattern: an exception that matched a
   * shape would quietly cover the next file that happened to fit it.
   */
  const EXCEPTION = "src/run.ts";

  /** The exact import that exception is, and the one operation it names. */
  const EXCEPTION_IMPORT = "./git.ts";
  const EXCEPTION_OPERATION = "revParse";

  function packageFile(relative: string): string {
    return fileURLToPath(new URL(`../${relative}`, import.meta.url));
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

  /** Whether a specifier names the local Git capability or its package. */
  function namesGit(specifier: string): boolean {
    return /(?:^|\/)git\.ts$/.test(specifier) || /^@executablemd\/git(?:\/|$)/.test(specifier);
  }

  function gitSpecifiers(source: string): string[] {
    return specifiers(source).filter(namesGit);
  }

  /** Every `.ts` file under one directory of the package, recursively. */
  function* moduleFiles(relative: string): Operation<string[]> {
    const found: string[] = [];
    for (const name of yield* readdir(packageFile(relative))) {
      const child = `${relative}/${name}`;
      const stats = yield* stat(packageFile(child));
      if (stats.isDirectory()) {
        found.push(...(yield* moduleFiles(child)));
      } else if (name.endsWith(".ts")) {
        found.push(child);
      }
    }
    return found;
  }

  function* retainedModules(): Operation<string[]> {
    const scanned: string[] = [...RETAINED_FILES];
    for (const directory of RETAINED) {
      scanned.push(...(yield* moduleFiles(directory)));
    }
    // The deno adapter's own modules, without the repository-composition
    // subsystem: those implement `<Git.*>` and are a capability rather than
    // part of what a run retains.
    for (const name of yield* readdir(packageFile("src/deno"))) {
      if (name.endsWith(".ts")) {
        scanned.push(`src/deno/${name}`);
      }
    }
    return scanned;
  }

  it("names Git in no retained module, in any import form", function* () {
    const scanned = yield* retainedModules();

    // The scan has to be looking at something: a glob that matched nothing
    // would pass this case every time.
    expect(scanned.length).toBeGreaterThan(40);
    expect(scanned).toContain("src/deno/transitions.ts");
    expect(scanned).toContain("src/storage/source-bundle.ts");
    expect(scanned).toContain("src/lifecycle/source.ts");
    expect(scanned).toContain("src/deno/definition-source.ts");
    expect(scanned).not.toContain(EXCEPTION);

    // And the matcher has to recognize what it is looking for. Each of these is
    // a way a module could reach Git without writing `from`.
    for (const form of [
      'import { revParse } from "./git.ts";',
      'import "../git.ts";',
      'const git = await import("./git.ts");',
      'const git = require("@executablemd/git");',
      'export { revParse } from "../../git.ts";',
    ]) {
      expect({ form, git: gitSpecifiers(form).length }).toEqual({ form, git: 1 });
    }
    expect(gitSpecifiers('import { reading } from "./reading.ts";')).toEqual([]);

    const importing: string[] = [];
    for (const relative of scanned) {
      const source = yield* readTextFile(packageFile(relative));
      if (gitSpecifiers(source).length > 0) {
        importing.push(relative);
      }
    }
    expect(importing).toEqual([]);
  });

  it("permits one Git import in run.ts, used once inside the allocation path", function* () {
    const source = yield* readTextFile(packageFile(EXCEPTION));

    // One specifier, and it is the local capability rather than the package.
    expect(gitSpecifiers(source)).toEqual([EXCEPTION_IMPORT]);
    // Named, so the import states which operation it is the exception for.
    expect(source).toContain(`import { ${EXCEPTION_OPERATION} } from "${EXCEPTION_IMPORT}";`);

    // Called once in the whole module. A bare identifier rather than any
    // mention of the name: the module's own prose says `Git.revParse()`, and a
    // sentence about the exception is not a second use of it.
    const calls = [...source.matchAll(/(?<![.\w])revParse\s*\(/g)];
    expect(calls).toHaveLength(1);

    // And that one call is inside `allocating()` itself, which is what
    // `workflowInstallation({ base })` uses. The retained installation beside it
    // resolves nothing: a run it is given arrives whole.
    //
    // Bounded by that function's own closing brace rather than by whatever
    // declaration happens to follow it — a helper slipped in between would
    // otherwise count as the allocation path while being callable from the
    // retained one.
    const from = source.indexOf("function allocating(");
    expect(from).toBeGreaterThan(-1);
    const closes = source.indexOf("\n}\n", from);
    expect(closes).toBeGreaterThan(from);
    const allocation = source.slice(from, closes);
    const call = /(?<![.\w])revParse\s*\(/;
    expect(call.test(allocation)).toBe(true);
    expect(call.test(source.slice(0, from))).toBe(false);
    expect(call.test(source.slice(closes))).toBe(false);
  });
});
