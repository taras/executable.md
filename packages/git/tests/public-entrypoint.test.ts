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

/**
 * Every contextual Api this package owns, with what travels beside it.
 *
 * Named, so that losing one is a failure rather than a silent narrowing: each
 * is a seam a consumer either calls or replaces, and an Api that quietly stops
 * being published is a consumer that can no longer answer.
 */
const API_PUBLISHED: readonly string[] = [
  "GIT_HOST_API",
  "Git",
  "GitComposition",
  "GitHost",
  "ISSUE_API",
  "ISSUE_TRACKER_CONTEXT",
  "IssueApi",
  "IssueTrackerContext",
  "NoIssueProvider",
  "NoPullRequestProvider",
  "PULL_REQUEST_API",
  "PullRequestAPI",
  "RepositoryComposition",
  "RepositoryContext",
  "currentIssueTracker",
  "currentRepository",
  "gitObjectFormat",
  "readGitObject",
  "repositoryRoot",
  "revParse",
];

/**
 * Whether a published value is a contextual Api.
 *
 * A `createApi()` value carries `around` — how a provider replaces it — and
 * `operations` — how a caller reaches it. Together those are what makes a name
 * a seam rather than data, and testing for them recognizes an Api nobody
 * thought to list.
 */
function isApi(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Narrowed by `in` rather than asserted: what arrives here is whatever a
  // module exported, so the members have to be proven present rather than
  // claimed.
  if (!("around" in value) || !("operations" in value)) {
    return false;
  }
  return (
    typeof value.around === "function" &&
    typeof value.operations === "object" &&
    value.operations !== null
  );
}

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

  /**
   * Every contextual Api, reached the way a consumer reaches it.
   *
   * Through the bare `@executablemd/git/api` specifier, so this fails if the
   * subpath is missing from an export map rather than only if the file is
   * missing from the tree — a module that exists and is unreachable publishes
   * nothing.
   */
  it("publishes every contextual Api from /api", function* () {
    const published = yield* until(import("@executablemd/git/api"));
    const names = Object.keys(published);
    expect(names.length > 0).toBe(true);
    expect(API_PUBLISHED.filter((name) => !names.includes(name))).toEqual([]);
  });

  /**
   * The boundary itself: an Api is reachable from `/api` and from nowhere else.
   *
   * Recognized by shape rather than by name, because a list of names is a list
   * of the seams somebody remembered. Anything carrying both `around` and
   * `operations` is a `createApi()` value — something a consumer can replace —
   * and the whole point of the split is that those live in one place. A new Api
   * re-exported from the root fails here without anyone updating a list.
   */
  it("publishes no contextual Api from the root or the Deno entrypoint", function* () {
    // The positive control for the detector: if this recognized nothing, every
    // absence below would be vacuous.
    const api = yield* until(import("@executablemd/git/api"));
    const seams = Object.entries(api)
      .filter(([, value]) => isApi(value))
      .map(([name]) => name);
    expect(seams.length > 0).toBe(true);
    expect(seams).toContain("Git");

    for (const specifier of ["@executablemd/git", "@executablemd/git/deno"]) {
      const published = yield* until(import(specifier));
      const names = Object.keys(published);
      expect(`${specifier}: ${names.length > 0}`).toBe(`${specifier}: true`);
      const leaked = Object.entries(published)
        .filter(([, value]) => isApi(value))
        .map(([name]) => name)
        .sort();
      expect(`${specifier}: ${leaked.join(",")}`).toBe(`${specifier}: `);
    }
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
