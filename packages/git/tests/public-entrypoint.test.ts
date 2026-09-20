/**
 * What `@executablemd/git` publishes, and what it deliberately does not.
 *
 * The package ships GitHub inside itself, so "GitHub is internal" cannot mean
 * "no GitHub name is exported" — several are, and they are contracts a host
 * genuinely needs: the discriminators a document writes as `provider=`, the
 * recognizers a host asks before configuring a ceiling, and the two installers
 * a trusted entrypoint calls.
 *
 * What must not leak is the *seam* — the internal arrangement by which the
 * implementation is handed a transport. `gitHubPullRequestAccess()` is one of
 * those: it exists so the orchestration half can ask the GitHub half for a
 * session, and publishing it would turn a package-local capability into
 * something a consumer could hold and hand somebody else.
 *
 * Read through the bare specifiers rather than by relative path, because what
 * a consumer can reach is what the export map admits, not what the source tree
 * contains — which is also why this suite is Deno-only: importing
 * `@executablemd/git/deno` reaches Workflow's storage adapter and so
 * `node:sqlite`. The two readings that need no import — the entrypoints as
 * source, and the manifest export maps — live in `module-partition.test.ts`
 * and run on every runtime.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";

/**
 * Seams that are this package's own business.
 *
 * Each one is reachable from inside `packages/git` and from nowhere else. A
 * name arriving here is a decision to widen the package's contract, which is a
 * thing to do on purpose rather than by re-exporting a module wholesale.
 */
const INTERNAL: readonly string[] = [
  "gitHubPullRequestAccess",
  "denoGitHubAccess",
  "denoGitHubLogin",
  "pullRequestProvider",
  "gitHubIssuesConfiguration",
  "gitHubPullRequestsConfiguration",
];

/**
 * What the root entrypoint publishes for a host that bundles this Plugin.
 *
 * `gitPlugin` is the value a distribution carries; `gitPluginDeclaresFor` is
 * how the host asks, before assembling a profile, whether this command's
 * profile carries it at all. Both are host seams rather than document
 * vocabulary, and both are named for the Plugin they belong to.
 */
const ROOT_PUBLISHED: readonly string[] = ["gitPlugin", "gitPluginDeclaresFor"];

/**
 * GitHub names this package publishes on purpose.
 *
 * Listed so that losing one is a failure rather than a silent narrowing: a
 * host configuring a ceiling needs the recognizer, and a document naming a
 * provider needs the discriminator.
 */
const PUBLISHED: readonly string[] = [
  "GITHUB",
  "GITHUB_PULL_REQUEST_PROVIDER",
  "parseGitHubIssueTarget",
  "parseGitHubPullRequestUrl",
  "pullRequestAllowed",
  "recognizesGitHubPullRequestUrl",
  "recognizesGitHubUrl",
  "useGitHubIssues",
  "useGitHubPullRequests",
];

describe("what @executablemd/git publishes", () => {
  it("publishes the GitHub contracts a host needs", function* () {
    const published = yield* until(import("@executablemd/git/deno"));
    const names = Object.keys(published);
    // A positive control first: an empty or failed import would satisfy every
    // absence below while proving nothing at all.
    expect(names.length > 0).toBe(true);
    expect(PUBLISHED.filter((name) => !names.includes(name))).toEqual([]);
  });

  it("publishes the host seams a bundled profile needs", function* () {
    const published = yield* until(import("@executablemd/git"));
    const names = Object.keys(published);
    expect(names.length > 0).toBe(true);
    expect(ROOT_PUBLISHED.filter((name) => !names.includes(name))).toEqual([]);
  });

  it("publishes no package-local seam from either entrypoint", function* () {
    for (const specifier of ["@executablemd/git", "@executablemd/git/deno"]) {
      const published = yield* until(import(specifier));
      const names = Object.keys(published);
      expect(`${specifier}: ${names.length > 0}`).toBe(`${specifier}: true`);
      expect(`${specifier}: ${INTERNAL.filter((name) => names.includes(name)).join(",")}`).toBe(
        `${specifier}: `,
      );
    }
  });
});
