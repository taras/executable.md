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
import { useInvokingHome } from "./support/credential-home.ts";

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
});
