/**
 * Which of this package's three halves each production module belongs to.
 *
 * `@executablemd/git` ships one Plugin and three kinds of module, and the
 * difference between them is a boundary rather than a directory:
 *
 * - **provider-neutral** — the contracts, records and effects every adapter is
 *   written against. They name no Git host at all, because a shared contract
 *   that names one has chosen it.
 * - **GitHub implementation** — protocol, parsing, matching, lazy
 *   configuration, normalization and provider behaviour. It knows GitHub and
 *   not the platform: the transport and the credential behind it arrive as an
 *   inert factory the host supplies.
 * - **Deno adapter** — environment, credential-helper invocation, subprocess,
 *   temporary paths, concrete `fetch`, and the orchestration that holds a run
 *   database. The only set permitted to name a concrete host operation.
 *
 * The sets are **declared here, not inferred**. Reading ownership off the
 * imports a module happens to have would make this scan agree with whatever
 * the code does, which is the one thing a boundary test must not do. So every
 * module is named below, and a module named nowhere fails: that is what stops
 * a new file from quietly joining whichever set its imports resemble.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { code, moduleSpecifiers, parse } from "@executablemd/test-support/host-boundary";
import { readTextFile } from "@effectionx/fs";
import { glob } from "@executablemd/runtime";
import type { Operation } from "effection";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const PACKAGE = "packages/git";

/**
 * The provider-neutral half, named one module at a time.
 *
 * The contracts, records and effects every adapter is written against. Named
 * rather than described as "everything outside `src/deno/`", because a set
 * computed from where a file sits can never have an unclassified member: a new
 * module would join it by existing, which is the one thing this scan is for.
 */
const PROVIDER_NEUTRAL: readonly string[] = [
  "mod.ts",
  "src/composition/api.ts",
  "src/composition/components/Dir.ts",
  "src/composition/components/GitAdd.ts",
  "src/composition/components/GitCommit.ts",
  "src/composition/components/GitPush.ts",
  "src/composition/components/GitSwitch.ts",
  "src/composition/components/Issue.ts",
  "src/composition/components/IssueTracker.ts",
  "src/composition/components/PullRequest.ts",
  "src/composition/components/PullRequestReads.ts",
  "src/composition/components/Repository.ts",
  "src/composition/components/Worktree.ts",
  "src/composition/context.ts",
  "src/composition/definitions.ts",
  "src/composition/errors.ts",
  "src/composition/git-api.ts",
  "src/composition/git-push-records.ts",
  "src/composition/git-records.ts",
  "src/composition/installation.ts",
  "src/composition/parse.ts",
  "src/composition/pull-request-api.ts",
  "src/composition/pull-request-operations.ts",
  "src/composition/pull-request-read-execution.ts",
  "src/composition/pull-request-read-records.ts",
  "src/composition/pull-request-records.ts",
  "src/composition/pull-request-target.ts",
  "src/composition/push-evidence.ts",
  "src/composition/records.ts",
  "src/composition/selection.ts",
  "src/git-host/api.ts",
  "src/git-host/effect-type.ts",
  "src/git-host/effect.ts",
  "src/git-host/errors.ts",
  "src/git-host/identities.ts",
  "src/git-host/records.ts",
  "src/git.ts",
  "src/identities.ts",
  "src/installation.ts",
  "src/issue/api.ts",
  "src/issue/context.ts",
  "src/issue/effect-type.ts",
  "src/issue/effect.ts",
  "src/issue/errors.ts",
  "src/issue/identities.ts",
  "src/issue/operations.ts",
  "src/issue/records.ts",
  "src/issue/tracker.ts",
  "src/plugin.ts",
];

/**
 * The GitHub implementation, named one module at a time.
 *
 * Every one of these is GitHub and nothing else. None of them may reach the
 * platform: what they are handed is a `GitHubAccess` or a factory for one, and
 * what they answer with is a normalized value the provider-neutral contracts
 * above them already describe.
 */
const INTERNAL: readonly string[] = [
  "gitHubPullRequestAccess",
  "denoGitHubAccess",
  "denoGitHubLogin",
  "pullRequestProvider",
  "gitHubIssuesConfiguration",
  "gitHubPullRequestsConfiguration",
];

const GITHUB_IMPLEMENTATION: readonly string[] = [
  "src/deno/composition/github.ts",
  "src/deno/composition/github-pull-request.ts",
  "src/deno/composition/pull-request-configuration.ts",
  "src/deno/composition/pull-request-evidence.ts",
  "src/deno/composition/pull-request-reads.ts",
  "src/deno/issue/configuration.ts",
  "src/deno/issue/github.ts",
];

/**
 * The Deno adapter, named one module at a time.
 *
 * Concrete host operations, and the orchestration that terminates the Workflow
 * dependency before a GitHub module is handed anything. This is the only set a
 * `node:` import, a host global or a subprocess may appear in.
 */
const DENO_ADAPTER: readonly string[] = [
  "deno.ts",
  "credential-helper.ts",
  "src/deno/attachment.ts",
  "src/deno/repositories.ts",
  "src/deno/selections.ts",
  "src/deno/composition/add.ts",
  "src/deno/composition/authentication.ts",
  "src/deno/composition/commit.ts",
  "src/deno/composition/credential-helper.ts",
  "src/deno/composition/effects.ts",
  "src/deno/composition/git.ts",
  "src/deno/composition/github-host.ts",
  "src/deno/composition/host.ts",
  "src/deno/composition/identity.ts",
  "src/deno/composition/locator.ts",
  "src/deno/composition/materialize.ts",
  "src/deno/composition/object-source.ts",
  "src/deno/composition/operations.ts",
  "src/deno/composition/placement.ts",
  "src/deno/composition/provider.ts",
  "src/deno/composition/pull-request-operations.ts",
  "src/deno/composition/pull-request.ts",
  "src/deno/composition/push.ts",
  "src/deno/composition/refusals.ts",
  "src/deno/composition/repository.ts",
  "src/deno/composition/subprocess.ts",
  "src/deno/composition/switch.ts",
  "src/deno/composition/worktree.ts",
  "src/deno/run-composition/ambient.ts",
  "src/deno/run-composition/checkouts.ts",
  "src/deno/run-composition/errors.ts",
  "src/deno/run-composition/identity.ts",
  "src/deno/run-composition/leases.ts",
  "src/deno/run-composition/metadata.ts",
  "src/deno/run-composition/operations.ts",
  "src/deno/run-composition/placement.ts",
  "src/deno/run-composition/provider.ts",
  "src/deno/run-composition/pull-request.ts",
];

/**
 * How many of the declared lists name each module.
 *
 * Counted across all three at once. Comparing them pairwise would miss a
 * module named twice inside one list, and a count is what lets "exactly one"
 * mean it: zero is unclassified, two is ambiguous, and neither is a partition.
 */
function memberships(lists: readonly (readonly string[])[]): Map<string, number> {
  const counted = new Map<string, number>();
  for (const list of lists) {
    for (const entry of list) {
      counted.set(entry, (counted.get(entry) ?? 0) + 1);
    }
  }
  return counted;
}

/** The modules a set of lists does not classify exactly once. */
function misclassified(counted: Map<string, number>): [string, number][] {
  return [...counted].filter(([, count]) => count !== 1);
}

/**
 * The subpaths a manifest's `exports` declares, or nothing when it declares no
 * readable map.
 *
 * Narrowed by asking the value what it is rather than telling the compiler.
 * The distinction matters here: this case's claim is about what the export map
 * admits, and a manifest this could not read would otherwise answer "no
 * subpaths" and satisfy the claim by accident.
 */
function subpaths(declared: unknown): string[] | undefined {
  if (typeof declared !== "object" || declared === null) {
    return undefined;
  }
  const exports: unknown = Reflect.get(declared, "exports");
  if (typeof exports !== "object" || exports === null) {
    return undefined;
  }
  return Object.keys(exports);
}

/** Where a module the scan finds is resolved from. */
function path(relative: string): string {
  return `${PACKAGE}/${relative}`;
}

/** Every production module this package ships, as the filesystem holds them. */
function* production(): Operation<string[]> {
  const found = yield* glob({
    root: REPOSITORY,
    patterns: [
      `${PACKAGE}/mod.ts`,
      `${PACKAGE}/deno.ts`,
      `${PACKAGE}/credential-helper.ts`,
      `${PACKAGE}/src/**/*.ts`,
    ],
  });
  return found.map((entry) => entry.path).sort();
}

/** The specifiers a module loads, resolved to repository paths where local. */
function* loaded(relative: string): Operation<string[]> {
  const source = yield* readTextFile(join(REPOSITORY, path(relative)));
  const parsed = parse(source);
  // A parse that failed would report every module as importing nothing, and a
  // boundary that admits what it cannot read is not a boundary.
  if (/^import\s/m.test(source)) {
    expect(`${relative}: ${moduleSpecifiers(parsed.file).length > 0}`).toBe(`${relative}: true`);
  }
  return moduleSpecifiers(parsed.file);
}

describe("the three halves of @executablemd/git", () => {
  it("assign every production module to exactly one declared set", function* () {
    const modules = yield* production();
    const neutral = PROVIDER_NEUTRAL.map(path);
    const github = GITHUB_IMPLEMENTATION.map(path);
    const adapter = DENO_ADAPTER.map(path);

    // Non-empty, each of them. A set that matched nothing would satisfy every
    // rule below without constraining a single module.
    expect(neutral.length > 0).toBe(true);
    expect(github.length > 0).toBe(true);
    expect(adapter.length > 0).toBe(true);

    // The counting has to be able to fail, or an empty report means nothing.
    // A module named by two lists, and one named twice by a single list, are
    // both ambiguous ownership and both are caught.
    expect(misclassified(memberships([["a.ts"], ["a.ts"]]))).toEqual([["a.ts", 2]]);
    expect(misclassified(memberships([["a.ts", "a.ts"], []]))).toEqual([["a.ts", 2]]);
    expect(misclassified(memberships([["a.ts"], ["b.ts"]]))).toEqual([]);

    // Exactly one membership each, across all three lists at once.
    const counted = memberships([neutral, github, adapter]);
    expect(misclassified(counted)).toEqual([]);

    // Complete. A module named in no set is the failure this exists for: it is
    // how a new file joins whichever half its imports resemble.
    expect(modules.filter((entry) => !counted.has(entry))).toEqual([]);
    // And every declared name is a module that exists, so a rename cannot
    // silently empty a set.
    const present = new Set(modules);
    expect([...neutral, ...github, ...adapter].filter((entry) => !present.has(entry))).toEqual([]);
  });

  it("keep the GitHub implementation free of the platform and of Workflow", function* () {
    const crossings: Record<string, string[]> = {};
    for (const relative of GITHUB_IMPLEMENTATION) {
      const source = yield* readTextFile(join(REPOSITORY, path(relative)));
      const scanned = code(source);
      const specifiers = yield* loaded(relative);
      const named: string[] = [];

      for (const specifier of specifiers) {
        // Workflow and the CLI are above this set, not beside it. The host half
        // is beside it and must arrive as a capability rather than an import.
        if (/^@executablemd\/(workflow|cli)(\/|$)/.test(specifier)) {
          named.push(specifier);
        }
        if (/^node:/.test(specifier)) {
          named.push(specifier);
        }
        if (specifier === "@effectionx/process") {
          named.push(specifier);
        }
        if (/(^|\/)github-host\.ts$/.test(specifier)) {
          named.push(specifier);
        }
        if (/(^|\/)subprocess\.ts$/.test(specifier)) {
          named.push(specifier);
        }
        if (/\/workflow\/src\//.test(specifier)) {
          named.push(specifier);
        }
      }
      // Host globals and the platform's own transport, read from code with its
      // prose removed — these modules explain in comments that they reach none
      // of them.
      for (const global of ["Deno.", "process.", "Bun.", "__dirname"]) {
        if (scanned.includes(global)) {
          named.push(global);
        }
      }
      if (/(^|[^.\w])fetch\s*\(/.test(scanned)) {
        named.push("fetch(");
      }
      if (named.length > 0) {
        crossings[relative] = named;
      }
    }
    expect(crossings).toEqual({});
  });

  it("keep GitHub out of the provider-neutral half", function* () {
    const implementation = new Set(GITHUB_IMPLEMENTATION.map((entry) => entry.split("/").pop()));
    const reaching: Record<string, string[]> = {};
    for (const relative of PROVIDER_NEUTRAL) {
      const specifiers = yield* loaded(relative);
      const named = specifiers.filter((specifier) => {
        const last = specifier.split("/").pop();
        return (
          /(^|\/)deno(\/|$)/.test(specifier) || (last !== undefined && implementation.has(last))
        );
      });
      if (named.length > 0) {
        reaching[relative] = named;
      }
    }
    expect(reaching).toEqual({});
  });

  it("leave concrete host operations to the Deno adapter alone", function* () {
    // The set is not merely non-empty: it is where the host actually is. If no
    // adapter named a concrete host operation, the rule above would be holding
    // the GitHub half to a standard nothing else in the package meets.
    const naming: string[] = [];
    for (const relative of DENO_ADAPTER) {
      const scanned = code(yield* readTextFile(join(REPOSITORY, path(relative))));
      if (
        scanned.includes("process.") ||
        scanned.includes("Deno.") ||
        /(^|[^.\w])fetch\s*\(/.test(scanned) ||
        scanned.includes("node:")
      ) {
        naming.push(relative);
      }
    }
    expect(naming.length > 0).toBe(true);
    expect(naming).toContain("src/deno/composition/github-host.ts");
  });

  it("names no seam in either entrypoint's own source", function* () {
    // The export map is one route and a re-export is another: a name absent
    // from the runtime namespace but written into `deno.ts` is a line waiting
    // to be uncommented, so the source is read too.
    for (const entry of ["mod.ts", "deno.ts"]) {
      const source = yield* readTextFile(join(REPOSITORY, PACKAGE, entry));
      const exported = source
        .split("\n")
        .filter((line) => line.startsWith("export"))
        .join("\n");
      expect(`${entry}: ${exported.length > 0}`).toBe(`${entry}: true`);
      for (const name of INTERNAL) {
        expect(`${entry} exports ${name}: ${exported.includes(name)}`).toBe(
          `${entry} exports ${name}: false`,
        );
      }
    }
  });

  it("admits exactly the two entrypoints the manifests declare", function* () {
    // A third subpath would be a third contract. `./credential-helper` is the
    // one beside them, and it is Git's own rather than GitHub's.
    for (const manifest of ["deno.json", "package.json"]) {
      const declared: unknown = JSON.parse(
        yield* readTextFile(join(REPOSITORY, PACKAGE, manifest)),
      );
      // Narrowed rather than asserted: a manifest whose `exports` was missing,
      // or was not an object, would otherwise satisfy both checks below by
      // having no keys at all. `subpaths()` answers `undefined` for anything it
      // cannot read, and `undefined` is what the next line refuses.
      const declaredSubpaths = subpaths(declared);
      expect(`${manifest}: ${declaredSubpaths !== undefined}`).toBe(`${manifest}: true`);
      const names = declaredSubpaths ?? [];
      expect(`${manifest}: ${names.toSorted().join(" ")}`).toBe(
        `${manifest}: . ./credential-helper ./deno`,
      );
      // And no subpath names GitHub: the implementation ships inside this
      // package rather than beside it.
      expect(`${manifest}: ${names.filter((key) => /github/i.test(key)).length}`).toBe(
        `${manifest}: 0`,
      );
    }
  });
});
