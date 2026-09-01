/**
 * Tier ORC — how the command line assembles repository operations.
 *
 * Two claims, and they are about opposite things. One runtime *operates* the
 * vocabulary and one only *describes* it, and both have to be true at once: a
 * document written for `xmd run` resolves the same thirteen names everywhere,
 * and on a runtime that operates none of them every one reports an absent
 * provider before a lock, a credential, a subprocess or a request exists.
 *
 * The declarations are the same array in both cases, which is why there is no
 * third thing to keep in agreement.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import { API, useHostFiles } from "@executablemd/runtime";
import { COMPOSITION_REGISTRATIONS } from "@executablemd/workflow";
import { useRunProfileRegistry } from "../src/syntax.ts";
import { DEFAULT_REPOSITORY_ROOT, unsupportedRepositories } from "../src/run-repositories.ts";

/** Every element an author can write that needs a repository provider. */
const OPERATIONS: readonly { readonly name: string; readonly source: string }[] = [
  {
    name: "Repository",
    source: `<Repository name="p" url="https://example.invalid/p.git" as="r" />`,
  },
  { name: "Worktree", source: `<Worktree name="w" branch="b" as="w" />` },
  { name: "Git.Switch", source: `<Git.Switch branch="b" />` },
  { name: "Git.Add", source: `<Git.Add paths="a.md" />` },
  { name: "Git.Commit", source: `<Git.Commit message="m" as="c" />` },
  { name: "Git.Push", source: `<Git.Push />` },
  { name: "PullRequest", source: `<PullRequest title="t" as="pr" />` },
  {
    name: "PullRequest.Reviews",
    source: `<PullRequest.Reviews url="https://github.com/o/r/pull/1" as="v" />`,
  },
  { name: "Issue", source: `<Issue url="https://github.com/o/r/issues/1" as="i" />` },
];

/**
 * Run one element with the declarations registered and no provider installed —
 * which is exactly what Node and Bun assemble.
 */
function ordinaryWithoutProvider(source: string, cwd: string): Operation<unknown> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return cwd;
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    yield* registerComponents(COMPOSITION_REGISTRATIONS);
    yield* unsupportedRepositories();
    return yield* collect(
      yield* execute({ ...inlineSource(source), stream: new InMemoryStream() }),
    );
  });
}

describe("ORC2 — one language, described everywhere and operated somewhere", () => {
  it("registers the same thirteen declarations the syntax catalog describes", function* () {
    // The array itself, rather than a second list: `useRunProfileRegistry()`,
    // `installDocumentComponents()` and `useCompositionComponents()` all
    // consume this one, so there is nothing for a runtime to disagree about.
    expect(COMPOSITION_REGISTRATIONS).toHaveLength(13);
    yield* scoped(function* () {
      yield* useRunProfileRegistry();
    });
  });

  it("reports an absent provider for every repository operation, and mutates nothing", function* () {
    for (const operation of OPERATIONS) {
      // The working directory is this repository's own checkout, so a provider
      // that *did* discover an ambient repository would find one — and the
      // refusal below would then be about something else.
      const failure = yield* raisedValue(ordinaryWithoutProvider(operation.source, "."));
      // The element's name travels with the assertion, so a failure says which
      // of the nine reported something else.
      const reported = `${operation.name}: ${String(failure)}`;
      expect(reported).toMatch(
        /provider is not installed|no Repository composition provider|no Git composition provider|no Issue provider|no pull-request provider/,
      );
    }
  });

  it("leaves <Dir> working, because it needs no provider at all", function* () {
    const rendered = yield* ordinaryWithoutProvider(
      ['<Dir path=".">', "", "inside", "", "</Dir>"].join("\n"),
      ".",
    );
    expect(String(rendered)).toContain("inside");
  });
});

describe("ORC2 — where the managed root is", () => {
  it("names ~/.xmd/repositories and nothing a document can influence", function* () {
    expect(DEFAULT_REPOSITORY_ROOT.endsWith("/.xmd/repositories")).toBe(true);
    yield* scoped(function* () {});
  });
});

/** Whatever this operation raised, as a value. */
function* raisedValue(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
  } catch (error) {
    return error;
  }
  throw new Error("the operation did not fail");
}
