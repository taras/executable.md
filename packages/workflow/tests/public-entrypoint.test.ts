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
 * So this asks from outside, through the entrypoint anybody else imports, and
 * attempts the exploit rather than describing it. It runs in an isolated home
 * whose helper records every question it is asked, so "nothing was reached" is
 * something the fixture observed rather than something this file asserts about
 * itself. No outcome is ever printed as anything but a fixed label.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import * as published from "../deno.ts";
import type { WorkflowWorkspaceOptions } from "../deno.ts";
import { useInvokingHome } from "./support/credential-home.ts";

/**
 * A compile-time proof, not a runtime one.
 *
 * `Assert<false>` is the only instantiation that type-checks, so this line stops
 * compiling the moment `composition` becomes a key of the published options —
 * which is the moment a substituted host has somewhere to go.
 */
type Assert<T extends false> = T;
type CompositionIsNotAKey = Assert<
  "composition" extends keyof WorkflowWorkspaceOptions ? true : false
>;

/** Named so the type above is used rather than merely written. */
const COMPOSITION_IS_NOT_A_KEY: CompositionIsNotAKey = false;

/** Every name a package that imported the entrypoint can see. */
const REACHABLE: readonly string[] = Object.keys(published);

/** What the attempt below found, reduced before anything is asserted. */
type Outcome = "absent" | "reached" | "refused";

describe("workflow published Deno entrypoint", () => {
  it("offers no route from the entrypoint to an authenticated invocation", function* () {
    const home = yield* useInvokingHome([
      { host: "exploit.invalid", path: "octo/one.git", username: "u", password: "p" },
    ]);

    // The attempt. If the old factory is still published, this walks the route
    // it opened — build a host, open a session for a locator, take the
    // attachment — and says only which of three things happened.
    const outcome: Outcome = yield* scoped(function* (): Operation<Outcome> {
      const factory = (published as Record<string, unknown>)["denoRepositoryHost"];
      if (typeof factory !== "function") {
        return "absent";
      }
      try {
        const host = (factory as (options: unknown) => Record<string, unknown>)({});
        const open = host["useAuthentication"];
        if (typeof open !== "function") {
          return "refused";
        }
        const session = yield* (open as (locator: string) => Operation<Record<string, unknown>>)(
          "https://exploit.invalid/octo/one.git",
        );
        // Reached at all is the finding. What it holds is never read, printed
        // or compared.
        return session["attachment"] === undefined ? "refused" : "reached";
      } catch {
        return "refused";
      }
    });

    expect(outcome).toBe("absent");
    // And the invoking chain was never asked anything, which is what makes the
    // absence a fact about behavior rather than about a name.
    expect(yield* home.operations()).toEqual([]);
  });

  it("never reads a legacy composition property a caller invents", function* () {
    const home = yield* useInvokingHome([
      { host: "exploit.invalid", path: "octo/one.git", username: "u", password: "p" },
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
    const attach = published.withWorkflowWorkspace as unknown as (
      ...args: readonly unknown[]
    ) => unknown;
    try {
      Reflect.apply(attach, undefined, [{}, function* () {}, hostile]);
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
    expect(REACHABLE).toContain("withWorkflowWorkspace");
    for (const constant of [
      "WORKSPACE_GIT_ADD",
      "WORKSPACE_GIT_SWITCH",
      "WORKSPACE_REPOSITORY",
      "WORKSPACE_WORKTREE",
    ]) {
      expect(REACHABLE).toContain(constant);
    }
    for (const seam of [
      "denoRepositoryHost",
      "useRepositoryComposition",
      "useGitComposition",
      "denoGitAuthentication",
      "denoCredentialBroker",
    ]) {
      expect(REACHABLE).not.toContain(seam);
    }
    expect(COMPOSITION_IS_NOT_A_KEY).toBe(false);
  });
});
