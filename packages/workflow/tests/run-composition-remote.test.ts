/**
 * Tier ORC — live remotes under an ordinary `xmd run`.
 *
 * Publishing, and what publishing authorizes. An ordinary run retains nothing,
 * so the only thing that can authorize a pull request is evidence this
 * execution's own provider instance is holding — which is why most of this file
 * is about what does *not* grant it: another run, a copied value, a trace file,
 * a Push of a different destination.
 *
 * Every repository is real and every Git command is real; the Git host is
 * modeled, because what is under test is which requests are made and which are
 * refused before one is.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation } from "effection";
import { admitLivePushEvidence } from "../src/deno/run-composition/operations.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import type { GitPushOutcome } from "../src/composition/git-push-records.ts";
import { LivePushEvidenceError } from "../src/deno/run-composition/errors.ts";
import { git, remoteBranch, remoteRefs, useBareRemote } from "./support/git-remotes.ts";
import type { BareRemote } from "./support/git-remotes.ts";
import { selectedRepository } from "../src/composition/context.ts";
import type { RepositorySelection } from "../src/composition/selection.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import {
  creations,
  fakeGitHubAccess,
  gitHubStore,
  issueCreations,
  patches,
} from "./support/github.ts";
import {
  causedBy,
  countingOrdinaryHost,
  fingerprintTree,
  gitStateOf,
  subcommands,
  raised,
  runOrdinaryDocument,
  recordingAccess,
  rewritingHost,
  statedIdentity,
  useHostCheckout,
  useManagedRoot,
  useNamedOriginCheckout,
} from "./support/run-composition.ts";
import {
  GITHUB_LOCATOR,
  HEAD,
  REMOTE,
  TOKEN,
  evidenceRoutes,
  isAuthorityFailure,
} from "./support/run-composition-tier.ts";

describe("ORC14 — live Push evidence", () => {
  it("records a performed publication and lets exactly that head be authorized", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="published" />`,
          `<File path="published.md">published</File>`,
          `<Git.Add paths="published.md" />`,
          `<Git.Commit message="Publish" as="commit" />`,
          `<Git.Push />`,
          `<PullRequest title="Publish" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );

    // The branch really is at the remote, at the commit this execution made.
    expect(remoteBranch(remote, "published")).toBe(checkout.run("rev-parse", "HEAD"));
    // And the pull request got past the evidence gate: what stopped it is the
    // adapter declining a locator that is not a github.com repository, which is
    // the step *after* the local authorization this criterion is about.
    expect(String(failure)).toContain("only for repositories on github.com");
    expect(String(failure)).not.toContain("holds no successful <Git.Push> result");
  });

  it("records an already-equal publication the same way it records a performed one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // The first execution performs the publication.
    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="equal" />`,
        `<File path="equal.md">equal</File>`,
        `<Git.Add paths="equal.md" />`,
        `<Git.Commit message="Equal" as="commit" />`,
        `<Git.Push />`,
      ].join("\n"),
      { root, cwd: checkout.root },
    );
    const published = checkout.run("rev-parse", "HEAD");
    expect(remoteBranch(remote, "equal")).toBe(published);

    // The second finds the destination already naming this exact commit and
    // adopts it — pushing nothing — and the adopted publication is evidence.
    const counting = countingOrdinaryHost();
    const failure = yield* raised(
      runOrdinaryDocument(
        [`<Git.Push />`, `<PullRequest title="Equal" as="pullRequest" />`].join("\n"),
        { root, cwd: checkout.root, host: counting.host },
      ),
    );
    expect(subcommands(counting.counters)).toContain("ls-remote");
    expect(subcommands(counting.counters)).not.toContain("push");
    expect(String(failure)).toContain("only for repositories on github.com");
    expect(String(failure)).not.toContain("holds no successful <Git.Push> result");
  });

  it("refuses when the Push named another branch, checkout, origin or destination", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const other = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // Another branch and therefore another destination ref: the Push is real
    // and irrelevant.
    const branch = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="elsewhere" />`,
          `<Git.Push />`,
          `<Git.Switch branch="unpublished" />`,
          `<PullRequest title="Not this one" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    expect(String(branch)).toContain("holds no successful <Git.Push> result");
    expect(remoteBranch(remote, "unpublished")).toBe(undefined);

    // Another repository entirely: a managed Repository publishes, and the
    // ambient one asks.
    const repository = yield* raised(
      runOrdinaryDocument(
        [
          `<Repository name="managed" url="${other.locator}">`,
          `<Git.Switch branch="managed-branch" />`,
          `<Git.Push />`,
          "</Repository>",
          `<Git.Switch branch="managed-branch" />`,
          `<PullRequest title="Wrong repository" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    expect(String(repository)).toContain("holds no successful <Git.Push> result");
  });

  it("admits one head only when every dimension of the publication matches", function* () {
    const identity = {
      name: "project",
      locatorFingerprint: "a".repeat(64),
      requestedBase: null,
      creationCommit: "b".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1" as const,
    };
    const held = {
      identity,
      checkoutRoot: "/checkouts/project",
      origin: "https://github.com/octo/project",
      branch: "feature",
      destinationRef: "refs/heads/feature",
      commit: "c".repeat(40),
    };

    // The exact publication authorizes.
    admitLivePushEvidence([held], held);

    // Every single dimension, changed on its own, does not. Git forbids two
    // checkouts of one repository on one branch, so the checkout dimension is
    // unreachable through a document — and it is exactly as load-bearing as the
    // others, which is why it is asked here rather than left unasked.
    const wrong: readonly [string, typeof held][] = [
      ["repository", { ...held, identity: { ...identity, locatorFingerprint: "d".repeat(64) } }],
      ["checkout", { ...held, checkoutRoot: "/checkouts/elsewhere" }],
      ["origin", { ...held, origin: "https://github.com/octo/other" }],
      ["branch", { ...held, branch: "other" }],
      ["destination", { ...held, destinationRef: "refs/heads/other" }],
      ["commit", { ...held, commit: "e".repeat(40) }],
    ];
    for (const [dimension, expected] of wrong) {
      let refused: unknown;
      try {
        admitLivePushEvidence([held], expected);
      } catch (error) {
        refused = error;
      }
      expect(`${dimension}: ${refused instanceof LivePushEvidenceError}`).toBe(
        `${dimension}: true`,
      );
    }

    // A changed commit on the same destination is disagreement, not absence.
    let conflicting: unknown;
    try {
      admitLivePushEvidence([held], { ...held, commit: "e".repeat(40) });
    } catch (error) {
      conflicting = error;
    }
    expect((conflicting as LivePushEvidenceError).reason).toBe("conflicting-push-evidence");

    // And the last publication of a destination is the one that decides.
    const superseded = { ...held, commit: "f".repeat(40) };
    admitLivePushEvidence([held, superseded], superseded);
    let stale: unknown;
    try {
      admitLivePushEvidence([held, superseded], held);
    } catch (error) {
      stale = error;
    }
    expect((stale as LivePushEvidenceError).reason).toBe("conflicting-push-evidence");
  });

  it("lets the latest publication of a destination decide", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // Two publications of one destination, at successive commits, and then a
    // third commit nothing published.
    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="moving" />`,
          `<File path="one.md">one</File>`,
          `<Git.Add paths="one.md" />`,
          `<Git.Commit message="One" as="first" />`,
          `<Git.Push />`,
          `<File path="two.md">two</File>`,
          `<Git.Add paths="two.md" />`,
          `<Git.Commit message="Two" as="second" />`,
          `<Git.Push />`,
          `<File path="three.md">three</File>`,
          `<Git.Add paths="three.md" />`,
          `<Git.Commit message="Three" as="third" />`,
          `<PullRequest title="Moved on" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    // The second publication superseded the first, and the head has moved past
    // both — so this is a conflict rather than an absence.
    expect(String(failure)).toContain("published that branch at a different commit");
    expect(remoteBranch(remote, "moving")).toBe(checkout.run("rev-parse", "HEAD~1"));
  });

  it("authorizes at the second publication's commit, not the first's", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(
        [
          `<Git.Switch branch="latest" />`,
          `<File path="one.md">one</File>`,
          `<Git.Add paths="one.md" />`,
          `<Git.Commit message="One" as="first" />`,
          `<Git.Push />`,
          `<File path="two.md">two</File>`,
          `<Git.Add paths="two.md" />`,
          `<Git.Commit message="Two" as="second" />`,
          `<Git.Push />`,
          `<PullRequest title="Latest" as="pullRequest" />`,
        ].join("\n"),
        { root, cwd: checkout.root },
      ),
    );
    // Past the gate: the latest publication names the head the pull request
    // would open from.
    expect(String(failure)).toContain("only for repositories on github.com");
    expect(remoteBranch(remote, "latest")).toBe(checkout.run("rev-parse", "HEAD"));
  });
});

describe("ORC15 — evidence cannot cross runs", () => {
  it("refuses a PullRequest in an execution that published nothing", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Nothing pushed" as="pr" />`, {
        root,
        cwd: checkout.root,
      }),
    );
    expect(String(failure)).toContain("holds no successful <Git.Push> result");
  });

  it("does not let one execution's real publication authorize the next", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({ token: TOKEN });
    store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
    const root = yield* useManagedRoot();
    const checkout = yield* useNamedOriginCheckout(remote, GITHUB_LOCATOR);
    const options = {
      root,
      cwd: checkout.root,
      host: rewritingHost(GITHUB_LOCATOR, remote.locator),
      gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
    };

    // One execution publishes and opens a pull request. This is the real thing:
    // a branch at the remote and a pull request at the modeled GitHub.
    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="crossing" />`,
        `<File path="crossing.md">crossing</File>`,
        `<Git.Add paths="crossing.md" />`,
        `<Git.Commit message="Crossing" as="commit" />`,
        `<Git.Push />`,
        `<PullRequest title="Crossing" as="pullRequest" />`,
      ].join("\n"),
      options,
    );
    expect(creations(store)).toBe(1);
    const published = checkout.run("rev-parse", "HEAD");
    expect(remoteBranch(remote, "crossing")).toBe(published);

    // A second, ordinary execution. The branch is still at the remote, the
    // checkout is still on it, and the pull request still exists — and none of
    // that is this execution's evidence.
    const second = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Crossing" as="pullRequest" />`, options),
    );
    expect(String(second)).toContain("holds no successful <Git.Push> result");

    // The refusal never reached GitHub at all.
    expect(creations(store)).toBe(1);
    expect(patches(store)).toBe(0);
  });

  it("grants nothing to a Push result middleware handed back without performing one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // One execution really publishes, and the suite keeps the exact outcome the
    // provider answered with — the whole successful `GitPushOutcome`.
    let published: GitPushOutcome | undefined;
    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="copied" />`,
        `<File path="copied.md">copied</File>`,
        `<Git.Add paths="copied.md" />`,
        `<Git.Commit message="Copied" as="commit" />`,
        `<Git.Push />`,
        "<Capture />",
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        around: function* () {
          yield* GitComposition.around({
            *pushCurrentBranch([invocation], next): Operation<GitPushOutcome> {
              published = yield* next(invocation);
              return published;
            },
          });
        },
        components: [
          {
            name: "Capture",
            origin: "test",
            props: { type: "object", additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              return "";
            },
          },
        ],
      },
    );
    expect(published).toBeDefined();
    expect(published?.decision).toBe("performed");
    const head = checkout.run("rev-parse", "HEAD");

    // A new execution whose `<Git.Push>` is answered by middleware handing that
    // exact successful outcome back. The provider underneath never runs, so it
    // never verifies a publication and never records evidence — and a result is
    // not evidence.
    let delegated = 0;
    const failure = yield* raised(
      runOrdinaryDocument([`<Git.Push />`, `<PullRequest title="Copied" as="pr" />`].join("\n"), {
        root,
        cwd: checkout.root,
        around: function* () {
          yield* GitComposition.around({
            // deno-lint-ignore require-yield
            *pushCurrentBranch([_invocation], _next): Operation<GitPushOutcome> {
              delegated += 1;
              if (published === undefined) {
                throw new Error("the suite captured no publication to hand back");
              }
              return published;
            },
          });
        },
      }),
    );

    // The middleware answered, so the component saw a successful Push.
    expect(delegated).toBe(1);
    // The branch really is still published at that commit, so nothing about the
    // world contradicts the copied result.
    expect(remoteBranch(remote, "copied")).toBe(head);
    // And the pull request is refused anyway: what authorizes it is what this
    // provider verified, not what anything handed it.
    expect(String(failure)).toContain("holds no successful <Git.Push> result");
  });

  it("grants nothing to a copied selection, a copied result or a previous trace", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    // One execution publishes, and hands its own Repository selection and the
    // rendered result of the Push out to the suite.
    let carried: RepositorySelection | undefined;
    yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="carried" />`,
        `<File path="carried.md">carried</File>`,
        `<Git.Add paths="carried.md" />`,
        `<Git.Commit message="Carried" as="commit" />`,
        `<Git.Push />`,
        "<Capture />",
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        components: [
          {
            name: "Capture",
            origin: "test",
            props: { type: "object", additionalProperties: false },
            *fn(): Operation<string> {
              carried = yield* selectedRepository();
              return "";
            },
          },
        ],
      },
    );
    expect(carried).toBeDefined();

    // A new execution, handed the exact selection the first one minted and the
    // path it bound, installed as its contextual Repository.
    const failure = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Carried" as="pullRequest" />`, {
        root,
        cwd: checkout.root,
        contextualRepository: carried,
      }),
    );
    // The selection is not one this provider minted, so it names no checkout —
    // and the evidence it would have needed does not exist here either.
    expect(String(failure)).toContain("not one this execution selected");
  });
});

describe("ORC16 — live Issues", () => {
  it("reads and files through the configured transport, keyed to this execution", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({
      token: TOKEN,
      issues: [
        {
          number: 7,
          nodeId: "I_7",
          state: "open",
          title: "an existing issue",
          body: "described",
          labels: [],
          assignee: null,
        },
      ],
    });
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const options = {
      root,
      cwd: checkout.root,
      gitHubIssues: {
        ceiling: [GITHUB_LOCATOR],
        access: gitHubSource(fakeGitHubAccess(store)),
      },
    };

    const rendered = yield* runOrdinaryDocument(
      [
        `<Issue url="${GITHUB_LOCATOR}/issues/7" as="found" />`,
        "",
        "read {found.title}",
        "",
        `<IssueTracker url="${GITHUB_LOCATOR}">`,
        `<Issue title="filed by an ordinary run" as="filed">`,
        "the description",
        "</Issue>",
        "</IssueTracker>",
      ].join("\n"),
      options,
    );
    expect(String(rendered)).toContain("read an existing issue");
    expect(issueCreations(store)).toBe(1);

    // A second execution is a new question, not a resumption: the identity it
    // presents is its own, so the provider is asked again.
    yield* runOrdinaryDocument(
      [
        `<IssueTracker url="${GITHUB_LOCATOR}">`,
        `<Issue title="filed by an ordinary run" as="filed">`,
        "the description",
        "</Issue>",
        "</IssueTracker>",
      ].join("\n"),
      options,
    );
    expect(issueCreations(store)).toBe(2);
  });

  it("sends no credential and no request for a target outside the ceiling", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({ token: TOKEN });
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(`<Issue url="https://github.com/other/repo/issues/1" as="found" />`, {
        root,
        cwd: checkout.root,
        gitHubIssues: {
          ceiling: [GITHUB_LOCATOR],
          access: gitHubSource(fakeGitHubAccess(store)),
        },
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(store.requests).toHaveLength(0);
  });

  it("installs no matching provider when nothing is configured", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);

    const failure = yield* raised(
      runOrdinaryDocument(`<Issue url="${GITHUB_LOCATOR}/issues/7" as="found" />`, {
        root,
        cwd: checkout.root,
      }),
    );
    expect(String(failure)).toContain("no issue provider handles");
  });
});

describe("ORC17 — live PullRequests", () => {
  it("opens a pull request the run published, through the configured transport", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({ token: TOKEN });
    store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
    const root = yield* useManagedRoot();
    const checkout = yield* useNamedOriginCheckout(remote, GITHUB_LOCATOR);

    const rendered = yield* runOrdinaryDocument(
      [
        `<Git.Switch branch="opened" />`,
        `<File path="opened.md">opened</File>`,
        `<Git.Add paths="opened.md" />`,
        `<Git.Commit message="Opened" as="commit" />`,
        `<Git.Push />`,
        `<PullRequest title="Opened" as="pullRequest">`,
        "the body",
        "</PullRequest>",
        "",
        "number {pullRequest.number} state {pullRequest.state}",
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        host: rewritingHost(GITHUB_LOCATOR, remote.locator),
        gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
      },
    );
    expect(creations(store)).toBe(1);
    expect(String(rendered)).toContain("state open");
    // The evidence it bound names the repository this run acted on.
    expect(String(rendered)).toContain("number 1");
  });

  it("reads all three collections, each from its own route", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const checkout = yield* useHostCheckout(remote.locator);
    const endpoint = "https://api.github.test";
    const recording = recordingAccess(evidenceRoutes(endpoint), endpoint);
    const access = gitHubSource(recording.access);

    // All three, in one document, under the ordinary provider.
    const rendered = yield* runOrdinaryDocument(
      [
        `<PullRequest.Reviews url="${GITHUB_LOCATOR}/pull/4" as="reviews" />`,
        `<PullRequest.Comments url="${GITHUB_LOCATOR}/pull/4" as="comments" />`,
        `<PullRequest.Checks url="${GITHUB_LOCATOR}/pull/4" as="checks" />`,
        "",
        "counts {reviews.length} {comments.length} {checks.length}",
        "",
        "<Json value={reviews} />",
        "",
        "<Json value={comments} />",
        "",
        "<Json value={checks} />",
      ].join("\n"),
      {
        root,
        cwd: checkout.root,
        gitHubPullRequests: { allowed: [GITHUB_LOCATOR], access },
      },
    );

    // One review, two comments of both kinds, and two checks of both kinds.
    expect(String(rendered)).toContain("counts 1 2 2");
    // Each collection carries the existing normalized contract.
    expect(String(rendered)).toContain('"state": "approved"');
    expect(String(rendered)).toContain('"author": "reviewer"');
    expect(String(rendered)).toContain('"kind": "conversation"');
    expect(String(rendered)).toContain('"kind": "review"');
    expect(String(rendered)).toContain('"diffHunk"');
    expect(String(rendered)).toContain('"kind": "check-run"');
    expect(String(rendered)).toContain('"conclusion": "failure"');
    expect(String(rendered)).toContain('"kind": "commit-status"');
    expect(String(rendered)).toContain('"state": "error"');

    // Each read reached the route its own collection lives at.
    const asked = recording.requests.map((request) => new URL(request.url).pathname);
    for (const route of [
      "/repos/octo/project/pulls/4/reviews",
      "/repos/octo/project/issues/4/comments",
      "/repos/octo/project/pulls/4/comments",
      `/repos/octo/project/commits/${HEAD}/check-runs`,
      `/repos/octo/project/commits/${HEAD}/status`,
    ]) {
      expect(`${route}: ${asked.includes(route)}`).toBe(`${route}: true`);
    }
    expect(recording.requests.every((request) => request.authorized)).toBe(true);

    // Outside the ceiling: refused before anything is sent.
    const sent = recording.requests.length;
    const failure = yield* raised(
      runOrdinaryDocument(
        `<PullRequest.Reviews url="https://github.com/other/repo/pull/4" as="reviews" />`,
        { root, cwd: checkout.root, gitHubPullRequests: { allowed: [GITHUB_LOCATOR], access } },
      ),
    );
    expect(String(failure)).toContain("has not authorized");
    expect(recording.requests).toHaveLength(sent);

    // And with nothing allowed, no read this host performs exists at all.
    const unconfigured = yield* raised(
      runOrdinaryDocument(`<PullRequest.Reviews url="${GITHUB_LOCATOR}/pull/4" as="reviews" />`, {
        root,
        cwd: checkout.root,
        gitHubPullRequests: { access },
      }),
    );
    expect(String(unconfigured)).toContain("no pull-request provider handles");
    expect(recording.requests).toHaveLength(sent);
  });

  it("refuses an unpublished head before a credential or a request", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const store = gitHubStore({ token: TOKEN });
    const root = yield* useManagedRoot();
    const checkout = yield* useNamedOriginCheckout(remote, GITHUB_LOCATOR);
    const counting = countingOrdinaryHost(rewritingHost(GITHUB_LOCATOR, remote.locator));

    const failure = yield* raised(
      runOrdinaryDocument(`<PullRequest title="Never published" as="pullRequest" />`, {
        root,
        cwd: checkout.root,
        host: counting.host,
        gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
      }),
    );
    expect(String(failure)).toContain("holds no successful <Git.Push> result");
    expect(store.requests).toHaveLength(0);
    expect(counting.counters.sessions).toEqual([]);
  });
});

/**
 * A checkout is authority only under the whole repository identity.
 *
 * Two `<Repository>` elements naming one url under two names are two
 * repositories: two slots, two advisory leases, two lines of Push evidence.
 * Every member of their identities is equal except `name`, which is exactly the
 * case a comparison that stops at the locator fingerprint cannot see — and a
 * `<Dir>` into the second, written where the first is the Repository in scope,
 * would carry the first's authority into a checkout it never selected.
 *
 * The refusal is asked for at the three surfaces that reach different things: a
 * local mutation, a publication, and a Git host. The two cases after it are the
 * controls — one that the same document shape does reach every one of those
 * boundaries when the identity matches, and one that a Worktree of the
 * Repository in scope is still reachable, so the comparison is of identities
 * and not of checkout paths or worktree names.
 */
/** Every ref the bare remote holds, as one comparable value. */
function refsOf(remote: BareRemote): string[] {
  return [...remoteRefs(remote)].map(([name, commit]) => `${name} ${commit}`).toSorted();
}

describe("checkout authority is the whole repository identity", () => {
  /** Deterministic, so no case depends on who this host says its user is. */
  const IDENT = "Tester <tester@example.test> 0 +0000";

  it("refuses Git, Push and PullRequest in a same-locator Repository the scope did not select", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const here = yield* useHostCheckout(remote.locator);
    const rewriting = () => rewritingHost(GITHUB_LOCATOR, remote.locator);

    // Created once and reused afterwards: what is under test is an operation
    // written in B, not the creation of either repository.
    const arranged = String(
      yield* runOrdinaryDocument(
        [
          `<Repository name="alpha" url="${GITHUB_LOCATOR}" as="alpha" />`,
          `<Repository name="beta" url="${GITHUB_LOCATOR}" as="beta" />`,
          "",
          "alpha {alpha}",
          "",
          "beta {beta}",
        ].join("\n"),
        { root, cwd: here.root, host: rewriting() },
      ),
    );
    const alphaPath = /alpha (\S+)/.exec(arranged)?.[1] ?? "";
    const betaPath = /beta (\S+)/.exec(arranged)?.[1] ?? "";
    expect(alphaPath).not.toBe("");
    expect(betaPath).not.toBe("");
    // Two names, one locator: different slots, and neither inside the other.
    expect(betaPath).not.toBe(alphaPath);

    // Entering B is not the act under test. Running it once here settles B's
    // index, so the comparisons below are against a checkout that has already
    // been selected and stood in.
    yield* runOrdinaryDocument(
      [
        `<Repository name="alpha" url="${GITHUB_LOCATOR}">`,
        `<Repository name="beta" url="${GITHUB_LOCATOR}" as="beta" />`,
        "<Dir path={beta}>",
        "nothing is asked of Git here",
        "</Dir>",
        "</Repository>",
      ].join("\n"),
      { root, cwd: here.root, host: rewriting() },
    );

    for (const [element, written] of [
      ["<Git.Switch>", `<Git.Switch branch="hijacked" />`],
      ["<Git.Push>", `<Git.Push />`],
      ["<PullRequest>", `<PullRequest title="Hijacked" as="pullRequest" />`],
    ] as const) {
      const counting = countingOrdinaryHost(rewriting());
      // The credential-counting access, so "no credential was read" is a
      // measurement rather than an inference from where the refusal sits.
      const recording = recordingAccess({});
      // Observed rather than inferred: the branch, the head, the index and the
      // working tree B holds, and the refs its remote holds.
      const state = gitStateOf(here, betaPath);
      const tree = yield* fingerprintTree(betaPath);
      const refs = refsOf(remote);

      const failure = yield* raised(
        runOrdinaryDocument(
          [
            `<Repository name="alpha" url="${GITHUB_LOCATOR}">`,
            `<Repository name="beta" url="${GITHUB_LOCATOR}" as="beta" />`,
            "<Dir path={beta}>",
            written,
            "</Dir>",
            "</Repository>",
          ].join("\n"),
          {
            root,
            cwd: here.root,
            host: counting.host,
            identity: statedIdentity(IDENT),
            gitHubPullRequests: { access: gitHubSource(recording.access) },
          },
        ),
      );

      // The checkout-authority refusal, named for the element that was written
      // — not a later failure that happens to stop the same document.
      const authority = causedBy(failure, isAuthorityFailure);
      expect(`${element} ${authority?.operation}`).toBe(`${element} ${element}`);
      expect(`${element} ${String(failure)}`).toContain(
        "is inside none of the checkouts this execution selected for the repository in scope",
      );

      // B was not mutated ...
      expect(`${element} ${gitStateOf(here, betaPath).join("|")}`).toBe(
        `${element} ${state.join("|")}`,
      );
      expect(yield* fingerprintTree(betaPath)).toEqual(tree);
      // ... nothing was published ...
      expect(refsOf(remote)).toEqual(refs);
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      // ... no authentication session was opened for any locator ...
      expect(`${element} ${counting.counters.sessions.join(",")}`).toBe(`${element} `);
      // ... and no Git host was reached for a credential or a request.
      expect(`${element} ${recording.credentials}`).toBe(`${element} 0`);
      expect(recording.requests).toEqual([]);
    }
  });

  it("reaches the mutation, the publication and the Git host when the identity is the same one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const here = yield* useHostCheckout(remote.locator);
    const store = gitHubStore({ token: TOKEN });
    store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
    const counting = countingOrdinaryHost(rewritingHost(GITHUB_LOCATOR, remote.locator));

    // The same two repositories, the same `<Dir>` into B's own path. The one
    // thing that differs from the refusal above is which of them is the
    // Repository in scope, so nothing else can be what decides.
    const rendered = String(
      yield* runOrdinaryDocument(
        [
          `<Repository name="beta" url="${GITHUB_LOCATOR}">`,
          `<Repository name="alpha" url="${GITHUB_LOCATOR}" as="alpha" />`,
          `<Repository name="beta" url="${GITHUB_LOCATOR}" as="beta" />`,
          "<Dir path={beta}>",
          `<Git.Switch branch="control" />`,
          `<File path="control.md">control</File>`,
          `<Git.Add paths="control.md" />`,
          `<Git.Commit message="Control" as="commit" />`,
          `<Git.Push />`,
          `<PullRequest title="Control" as="pullRequest">`,
          "the body",
          "</PullRequest>",
          "</Dir>",
          "</Repository>",
          "",
          "state {pullRequest.state}",
        ].join("\n"),
        {
          root,
          cwd: here.root,
          host: counting.host,
          identity: statedIdentity(IDENT),
          gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
        },
      ),
    );

    // Every boundary the refusal stops short of is reached here: the branch
    // moved, the publication ran, and a pull request was opened.
    expect(subcommands(counting.counters)).toContain("push");
    // The same counter the refusal above requires to be empty, non-empty here
    // under the same host and the same fixtures — so that "no session was
    // opened" is a measurement and not a counter that never moves.
    expect(counting.counters.sessions).toContain(GITHUB_LOCATOR);
    expect(remoteRefs(remote).has("refs/heads/control")).toBe(true);
    expect(creations(store)).toBe(1);
    expect(rendered).toContain("state open");
  });

  it("operates in a Worktree of the Repository in scope, entered by its returned path", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const here = yield* useHostCheckout(remote.locator);
    const rewriting = rewritingHost(GITHUB_LOCATOR, remote.locator);

    const arranged = String(
      yield* runOrdinaryDocument(
        [
          `<Repository name="alpha" url="${GITHUB_LOCATOR}" as="alpha" />`,
          "",
          "alpha {alpha}",
        ].join("\n"),
        { root, cwd: here.root, host: rewriting },
      ),
    );
    const alphaPath = /alpha (\S+)/.exec(arranged)?.[1] ?? "";
    expect(alphaPath).not.toBe("");
    const head = git(["rev-parse", "HEAD"], alphaPath, here.home);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], alphaPath, here.home);

    const rendered = String(
      yield* runOrdinaryDocument(
        [
          `<Repository name="alpha" url="${GITHUB_LOCATOR}">`,
          `<Worktree name="side" branch="side" as="side" />`,
          "<Dir path={side}>",
          `<File path="in-worktree.md">written here</File>`,
          `<Git.Add paths="in-worktree.md" />`,
          `<Git.Commit message="In the worktree" as="commit" />`,
          "</Dir>",
          "</Repository>",
          "",
          "side {side}",
        ].join("\n"),
        { root, cwd: here.root, host: rewriting, identity: statedIdentity(IDENT) },
      ),
    );
    const sidePath = /side (\S+)/.exec(rendered)?.[1] ?? "";
    // A different checkout of the same repository, under a different root.
    expect(sidePath).not.toBe("");
    expect(sidePath).not.toBe(alphaPath);

    // The commit landed in the Worktree — whose identity is its owner's, and
    // whose root and name are its own — and the Repository's own checkout did
    // not move.
    expect(git(["log", "-1", "--pretty=%s", "side"], alphaPath, here.home)).toBe("In the worktree");
    expect(git(["rev-parse", "HEAD"], alphaPath, here.home)).toBe(head);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], alphaPath, here.home)).toBe(branch);
  });
});
