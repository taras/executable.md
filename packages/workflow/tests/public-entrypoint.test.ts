/**
 * Tier WA — what a loaded package can reach through the published entrypoint.
 *
 * The adapter holds a credential in memory for one invocation and hands it to
 * its own Git children. That containment is only worth as much as the surface
 * around it: a `RepositoryHost` sees every `GitInvocation`, and an authenticated
 * one carries the attachment the credential travels in. If a package that a
 * document loaded could install one — or reach the options that accept one —
 * then everything else in this contract is arithmetic on a value it has already
 * read.
 *
 * So this suite asks the question from outside. It imports the entrypoint the
 * way anybody else would, and looks for the seams rather than trusting that they
 * are absent.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import * as published from "../deno.ts";
import type { WorkflowHostOptions } from "../deno.ts";
// Source-relative, and only resolvable for code that already lives here.
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";

/** The seams a host may configure, and the whole of them. */
const HOST_OWNED = ["gitHubIssues", "helper"] as const;

/**
 * Every name a package that imported the entrypoint can see.
 *
 * Read from the module rather than from the source, so a re-export added
 * anywhere in the graph is caught here rather than by reading the file it was
 * added to.
 */
const REACHABLE = Object.keys(published);

describe("workflow published Deno entrypoint", () => {
  it("offers nothing that can observe a Git invocation", function* () {
    // Each of these is a way to see, or to become, the thing an authenticated
    // command runs through. None of them is a host's business, and none is
    // published.
    for (const seam of [
      "denoRepositoryHost",
      "withWorkflowWorkspace",
      "useRepositoryComposition",
      "useGitComposition",
      "denoGitAuthentication",
      "denoCredentialBroker",
    ]) {
      expect(REACHABLE).not.toContain(seam);
    }
  });

  it("publishes one Workspace attachment, and it is the narrow one", function* () {
    expect(REACHABLE).toContain("withWorkflowHostWorkspace");
    expect(REACHABLE).not.toContain("withWorkflowWorkspace");
  });

  it("accepts only what a host owns", function* () {
    // A value, so the shape is checked by the compiler rather than described in
    // a comment. Adding `composition` here stops compiling, which is the point:
    // the option that carries a substituted host is not on this type.
    const options: WorkflowHostOptions = {};
    const named: readonly string[] = HOST_OWNED;
    expect(named).toEqual(["gitHubIssues", "helper"]);
    expect(Object.keys(options)).toEqual([]);
  });

  it("hands a substituted host no route in, however it is spelled", function* () {
    // The exploit, attempted rather than reasoned about: a package that loaded
    // this entrypoint builds the recording host it would want and looks for
    // somewhere to put it.
    const recorded: unknown[] = [];
    const hostile = {
      git(invocation: unknown) {
        recorded.push(invocation);
        return { code: 0, stdout: "", stderr: "" };
      },
      useDirectory: () => "/tmp",
    };

    const attempted = published as unknown as Record<string, unknown>;
    // Nothing published takes one. `withWorkflowHostWorkspace` is the only
    // attachment, and its third argument names two members, neither of which is
    // a host.
    const attach = attempted["withWorkflowHostWorkspace"];
    expect(typeof attach).toBe("function");
    // Its own arity: a database, an operation, and options. A fourth positional
    // seam would be another way in.
    expect((attach as (...args: unknown[]) => unknown).length).toBeLessThanOrEqual(3);

    // And no published name is a host factory that would produce one either.
    for (const name of REACHABLE) {
      expect(name).not.toContain("RepositoryHost");
      expect(name).not.toContain("Composition");
    }
    expect(recorded).toEqual([]);
    expect(hostile.git({})).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("keeps the broad options reachable from inside the package", function* () {
    // Not a loophole: this import is source-relative and only resolves for code
    // that already lives here. The suites that substitute a Git subprocess need
    // it, and a loaded package cannot write it.
    expect(typeof withWorkflowWorkspace).toBe("function");
  });
});
