/**
 * Tier ORC — how the command line assembles repository operations.
 *
 * Three claims, and they are about opposite things. Describing the vocabulary
 * must reach nothing; one runtime *operates* it; and one only *describes* it.
 * All three have to be true at once, so a document written for `xmd run`
 * resolves the same thirteen names everywhere, and on a runtime that operates
 * none of them every one reports an absent provider before a lock, a
 * credential, a subprocess or a request exists.
 *
 * The declarations are the same array in every case, which is why there is no
 * fourth thing to keep in agreement.
 *
 * Everything here runs under Deno, Node and Bun. The parity claim is not one to
 * defer to CI: what it asserts is that a runtime with no operational provider
 * still describes and resolves the whole language.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, suspend, type Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import { API, Service, useHostFiles } from "@executablemd/runtime";
import type { RuntimeFetchResponse } from "@executablemd/runtime";
import { exists, readdir } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { COMPOSITION_REGISTRATIONS } from "@executablemd/workflow";
import { syntaxCatalog, useRunProfileRegistry } from "../src/syntax.ts";
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
  {
    name: "PullRequest.Comments",
    source: `<PullRequest.Comments url="https://github.com/o/r/pull/1" as="v" />`,
  },
  {
    name: "PullRequest.Checks",
    source: `<PullRequest.Checks url="https://github.com/o/r/pull/1" as="v" />`,
  },
  { name: "Issue", source: `<Issue url="https://github.com/o/r/issues/1" as="i" />` },
];

/** The thirteen names #643 settled, exactly as a document writes them. */
const COMPOSITION_NAMES = [
  "Repository",
  "Worktree",
  "Dir",
  "Git.Switch",
  "Git.Add",
  "Git.Commit",
  "Git.Push",
  "PullRequest",
  "PullRequest.Reviews",
  "PullRequest.Comments",
  "PullRequest.Checks",
  "IssueTracker",
  "Issue",
] as const;

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

describe("ORC1 — describing the vocabulary reaches nothing", () => {
  it("builds the catalog without a subprocess, a service, a request or a lock", function* () {
    const managed = yield* useTempDirectory("xmd-orc1-managed-");
    const reached: string[] = [];

    const catalog = yield* scoped(function* () {
      // Tripwires at every host boundary the provider would use, installed
      // beneath everything so nothing can answer ahead of them. Each records
      // rather than throwing, so a failure says which boundary was reached.
      yield* API.Env.around(
        {
          // deno-lint-ignore require-yield
          *command(): Operation<string[]> {
            reached.push("command");
            return [];
          },
          // deno-lint-ignore require-yield
          *cwd(): Operation<string> {
            return managed;
          },
        },
        { at: "min" },
      );
      yield* API.Fetch.around(
        {
          // deno-lint-ignore require-yield
          *fetch(): Operation<RuntimeFetchResponse> {
            reached.push("fetch");
            throw new Error("the catalog reached the network");
          },
        },
        { at: "min" },
      );
      yield* Service.around(
        {
          *start(): Operation<never> {
            reached.push("service");
            throw new Error("the catalog started a service");
            // deno-lint-ignore no-unreachable
            yield* suspend();
          },
        },
        { at: "min" },
      );
      return yield* syntaxCatalog([]);
    });

    // The whole vocabulary is described.
    const builtIn = catalog.categories[1].entries.map((entry) => entry.name);
    for (const name of COMPOSITION_NAMES) {
      expect(builtIn).toContain(name);
    }

    // And nothing was reached to describe it: no command was built for a
    // subprocess, no request was sent, no service was started.
    expect(reached).toEqual([]);
    // No managed root, no slot, no lock sidecar — nothing was created at all.
    expect(yield* readdir(managed)).toEqual([]);
  });

  it("leaves every repository operation unprovided after inspection", function* () {
    // Registering the declarations installs no provider: the Apis still answer
    // with their own defaults, which is what a catalog is allowed to leave
    // behind.
    yield* useRunProfileRegistry();
    const failure = yield* raisedValue(
      collect(yield* execute({ ...inlineSource(`<Git.Push />`), stream: new InMemoryStream() })),
    );
    // `<Git.Push />` has no lexical Repository, so the first thing it asks for
    // is the ambient one — and that is the Api reporting absence.
    expect(String(failure)).toContain("no Repository composition provider is installed");
  });
});

describe("ORC2 — one language, described everywhere and operated somewhere", () => {
  it("registers the same thirteen declarations the syntax catalog describes", function* () {
    // The array itself, rather than a second list: `useRunProfileRegistry()`,
    // `installDocumentComponents()` and `useCompositionComponents()` all
    // consume this one, so there is nothing for a runtime to disagree about.
    expect(COMPOSITION_REGISTRATIONS).toHaveLength(13);
    expect([...COMPOSITION_REGISTRATIONS].map((registration) => registration.name).sort()).toEqual(
      [...COMPOSITION_NAMES].sort(),
    );

    // And the catalog every runtime builds describes each of them completely.
    const catalog = yield* scoped(() => syntaxCatalog([]));
    const builtIn = catalog.categories[1].entries;
    for (const name of COMPOSITION_NAMES) {
      const entry = builtIn.find((candidate) => candidate.name === name);
      expect(`${name}: ${entry?.description !== undefined}`).toBe(`${name}: true`);
      expect(`${name}: ${(entry?.forms?.length ?? 0) > 0}`).toBe(`${name}: true`);
    }
  });

  it("reports an absent provider for every repository operation, and mutates nothing", function* () {
    for (const operation of OPERATIONS) {
      // The working directory is this repository's own checkout, so a provider
      // that *did* discover an ambient repository would find one — and the
      // refusal below would then be about something else.
      const failure = yield* raisedValue(ordinaryWithoutProvider(operation.source, "."));
      // The element's name travels with the assertion, so a failure says which
      // of the twelve reported something else.
      const reported = `${operation.name}: ${String(failure)}`;
      expect(reported).toMatch(
        /provider is not installed|no Repository composition provider|no Git composition provider|no issue provider|no Issue provider|no pull-request provider/,
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
    // Describing the vocabulary and refusing an operation both leave it exactly
    // as they found it — including not existing.
    const before = yield* exists(DEFAULT_REPOSITORY_ROOT);
    yield* raisedValue(ordinaryWithoutProvider(`<Git.Push />`, "."));
    expect(yield* exists(DEFAULT_REPOSITORY_ROOT)).toBe(before);
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
