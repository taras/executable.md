/**
 * What `xmd syntax` and `<Plan>` cost the bundled GitHub adapter.
 *
 * Both surfaces *describe* a profile rather than run one: syntax renders the
 * catalog a command would install, and Plan validation checks a draft against
 * those declarations — including the Git-owned syntax the bundled Plugin
 * contributes. Neither is an invoked GitHub operation, so neither may
 * read a configuration variable, obtain a credential or open a socket.
 *
 * Here rather than in `packages/git` because these are the CLI's own surfaces,
 * and the CLI is what depends on Git. The adapters' own ordering is proven next
 * door, in `packages/git/tests/github-activation.test.ts`.
 *
 * The boundary installed around each case **throws**. A spy that counted would
 * let the read happen and report it afterwards; one that throws refuses it
 * where it occurs, so a failure names the crossing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";
import { installPlugins } from "../src/plugin-host.ts";
import { syntaxSymbols } from "../src/syntax.ts";
import { planComponentDescription, structuralValidation } from "../src/plan-component.ts";
import { gitPlugin } from "@executablemd/git";
import { useGitHubIssues } from "@executablemd/git/deno";

/** A transport factory that refuses to be built at all. */
function forbidden(): never {
  throw new Error("a GitHub transport was built");
}

/**
 * The bundled adapters, installed as a run profile installs them.
 *
 * Present but untouched is the whole claim: describing a profile that *has*
 * the GitHub adapters in it must still read nothing. Without them installed
 * these cases would pass for the trivial reason that there was no adapter to
 * read anything.
 */
function* adapters(): Operation<void> {
  // The issue adapter is the one a host installs by name through the
  // entrypoint; the pull-request reads adapter is installed beneath the run
  // provider, which syntax and Plan never assemble.
  yield* useGitHubIssues({ host: forbidden });
}

/** A configuration boundary that refuses to be read. */
function* refusing(): Operation<void> {
  yield* API.Env.around(
    {
      *env([name], next): Operation<string | undefined> {
        if (name.startsWith("XMD_WORKFLOW_GITHUB")) {
          throw new Error(`configuration was read: ${name}`);
        }
        return yield* next(name);
      },
    },
    { at: "min" },
  );
}

describe("describing the bundled profile costs nothing", () => {
  it("renders the syntax catalog without reading GitHub configuration", function* () {
    const named = yield* scoped(function* () {
      yield* refusing();
      yield* adapters();
      const plugins = yield* installPlugins([gitPlugin], {
        command: "syntax",
        args: ["syntax"],
      });
      const symbols = yield* syntaxSymbols([], plugins);
      return symbols.categories.flatMap((category) => category.entries.map((entry) => entry.name));
    });

    // The catalog really was rendered — an empty one would satisfy the refusal
    // above by describing nothing at all.
    for (const name of ["Repository", "Worktree", "Dir", "PullRequest", "Issue"]) {
      expect(`${name}: ${named.includes(name)}`).toBe(`${name}: true`);
    }
  });

  it("validates a Plan draft without reading GitHub configuration", function* () {
    // Real structural validation, not merely loading the declaration: a draft
    // written in Git-owned syntax, checked through the profile a `plan` command
    // assembles.
    //
    // `<Dir>` is Git's, but omitting the Plugin from this validation does not
    // yet refuse the draft: `useCommandComponents()` still calls
    // `useCompositionComponents()` directly (`packages/cli/src/syntax.ts`), so
    // the vocabulary reaches syntax and Plan whether or not a Plugin supplied
    // it. Slice 4 removes that call and makes the profile the only route, and
    // the Plugin-omission probe becomes discriminating then. What this case
    // proves now is that validating Git-owned syntax reads no GitHub
    // configuration and opens no transport — which the refusing boundaries
    // around it enforce, and which the eager-configuration probe fails.
    const draft = '# Plan\n\n<Dir path="notes">work here</Dir>\n';
    const result = yield* scoped(function* () {
      yield* refusing();
      yield* adapters();
      const plugins = yield* installPlugins([gitPlugin], { command: "plan", args: ["plan"] });
      const validate = structuralValidation([], [yield* planComponentDescription()], plugins);
      return yield* validate(draft);
    });

    expect(`${result.outcome}: ${result.diagnostics.map((d) => d.code).join(",")}`).toBe("valid: ");
    // And it recognized the Git invocation rather than skipping it: an empty
    // invocation list is what a validation that knew no components returns.
    expect(result.invocations.map((invocation) => invocation.name)).toContain("Dir");

    // The validation really discriminates. Without this, "valid" could be what
    // a validator that accepted anything answers, and the row above would be
    // asserting nothing about the vocabulary at all.
    const refused = yield* scoped(function* () {
      yield* refusing();
      yield* adapters();
      const plugins = yield* installPlugins([gitPlugin], { command: "plan", args: ["plan"] });
      const validate = structuralValidation([], [yield* planComponentDescription()], plugins);
      return yield* validate("# Plan\n\n<NotAComponent />\n");
    });
    expect(refused.outcome).toBe("invalid");
  });
});
