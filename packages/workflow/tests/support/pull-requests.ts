/**
 * What the `<PullRequest>` suites agree on: one repository, two substitutions.
 *
 * A document names a repository on `github.com`, because that is what selects
 * the adapter under test and what a real workflow would write. Git is given a
 * bare repository beside the test instead, and GitHub is the small model in
 * `github.ts`. Everything between those two host boundaries — locator
 * admission, checkout authority, the journal scan, classification and the
 * record — is the shipped code.
 */

import type { Operation } from "effection";
import { denoRepositoryHost } from "../../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../../src/deno/composition/host.ts";
import type { RepositoryRecord } from "../../src/composition/records.ts";
import type { WorkflowWorkspaceOptions } from "../../src/deno/workspace/host.ts";
import { countingHost, type CountingHost } from "./composition.ts";
import { remoteRefs, type BareRemote } from "./git-remotes.ts";
import {
  fakeGitHubAccess,
  gitHubStore,
  type GitHubStore,
  type StoredPullRequest,
} from "./github.ts";
import { gitHubSource } from "../../src/deno/composition/github.ts";

import type { RepositorySelection } from "../../src/composition/selection.ts";
/** The repository the document names, and the one the fake GitHub holds. */
export const LOCATOR = "https://github.com/octo/project";

export const BRANCH = "publish/1.4";

export const TITLE = "Prepare 1.4";

export const BODY = "Release notes for 1.4.";

/** A credential no journal, result or routing observation may ever hold. */
export const TOKEN = "github-credential-for-this-test";

/** Text a suite looks for to say whether work after a failure still ran. */
export const LATER = "later sibling ran";

export const REMOTE = {
  commits: [{ message: "first", entries: [{ path: "which.txt", content: "main\n" }] }],
} as const;

/** A well-formed Repository selection no provider ever minted. */
export const FORGED: RepositorySelection = Object.freeze({
  selection: "forged",
  name: "ghost",
  identity: Object.freeze({
    name: "ghost",
    locatorFingerprint: "0".repeat(64),
    requestedBase: null,
    creationCommit: "0".repeat(40),
    primaryBranch: "main",
    objectFormat: "sha1" as const,
  }),
  checkoutPath: "/repositories/ghost",
});

/**
 * The production host, with one locator standing in for another.
 *
 * The substitution goes both ways, because Git remembers where a checkout came
 * from and this run's own attachment check reads it back. What is replaced is
 * exactly one string in both directions: nothing else in these suites is a
 * temporary path, and every other byte Git says travels untouched.
 */
export function rewriting(
  to: string,
  inner: RepositoryHost = denoRepositoryHost(),
): RepositoryHost {
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      const outcome = yield* inner.git({
        ...invocation,
        args: invocation.args.map((argument) => (argument === LOCATOR ? to : argument)),
      });
      return { ...outcome, stdout: outcome.stdout.split(to).join(LOCATOR) };
    },
    useDirectory: inner.useDirectory,
  };
}

export interface Fixture {
  readonly counting: CountingHost;
  readonly store: GitHubStore;
  readonly options: WorkflowWorkspaceOptions;
}

/**
 * One run's substitutions: which Git, which GitHub, and what each one counted.
 *
 * The store resolves a branch to whatever the bare remote holds, which is how
 * the modeled GitHub knows the commit a pull request is opened from — the same
 * way the real one does, because `<Git.Push />` put it there.
 */
export function fixture(remote: BareRemote, pullRequests: StoredPullRequest[] = []): Fixture {
  const counting = countingHost(rewriting(remote.locator));
  const store = gitHubStore({ pullRequests, token: TOKEN });
  store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
  return {
    counting,
    store,
    options: {
      gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
      composition: {
        host: counting.host,
        observe: {
          effect: (kind, name) => counting.counters.effects.push(`${kind}:${name}`),
          attachment: (kind, name) => counting.counters.attachments.push(`${kind}:${name}`),
        },
      },
    },
  };
}

export function document(...lines: string[]): string {
  return [`<Repository name="project" url="${LOCATOR}">`, ...lines, "</Repository>"].join("\n");
}

/** Switch to a fresh branch, record a commit on it, and publish it. */
export function published(...extra: string[]): string {
  return document(
    `<Git.Switch branch="${BRANCH}" />`,
    `<File path="notes.md">`,
    "prepared",
    "</File>",
    `<Git.Add paths="notes.md" />`,
    `<Git.Commit message="prepare the release" as="commit" />`,
    `<Git.Push />`,
    ...extra,
  );
}

/** One `<PullRequest>`, and a line that reads what it bound. */
export function pullRequest(...attributes: string[]): string[] {
  return [
    `<PullRequest title="${TITLE}"${attributes.join("")} as="pullRequest">`,
    BODY,
    "</PullRequest>",
    "",
    "opened {pullRequest.number} at {pullRequest.url} as {pullRequest.state}",
  ];
}

/** The same element, naming the pull request it brings up to date. */
export function numbered(number: number, ...attributes: string[]): string[] {
  return pullRequest(` number={${number}}`, ...attributes);
}

/** One pull request this GitHub already holds, as the fixture stores it. */
export function stored(overrides: Partial<StoredPullRequest> = {}): StoredPullRequest {
  return {
    nodeId: "PR_node_1",
    number: 1,
    state: "open",
    title: TITLE,
    body: `\n${BODY}\n`,
    draft: false,
    headRef: BRANCH,
    // Empty: the fixture reads the branch when the payload is built, because a
    // pull request seeded before the run cannot name a commit it has not made.
    headSha: "",
    baseRef: "main",
    baseSha: "",
    ...overrides,
  };
}
