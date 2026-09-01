/**
 * Tier U — the GitHub adapter, on its own.
 *
 * Which locators it will act for, where its credential comes from, what it
 * makes of an answer, and — the claim the whole reconciliation rests on — that
 * nothing it cannot read ever becomes "there is no pull request here". Every
 * test drives the real adapter; what is substituted is the transport and the
 * environment, which is the whole of what it asks its host for.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import process from "node:process";
import type { Operation } from "effection";
import type { RepositoryIdentity } from "../src/composition/selection.ts";
import {
  denoGitHubAccess,
  gitHubPullRequests,
  openSnapshot,
  readPullRequest,
  sameRepository,
  parseGitHubRepository,
  type GitHubAccess,
  type GitHubLogin,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
} from "../src/deno/composition/github.ts";
import type {
  PullRequestInputs,
  PullRequestSnapshot,
} from "../src/composition/pull-request-records.ts";

import {
  creations,
  fakeGitHubAccess,
  gitHubStore,
  mutations,
  respond,
  type GitHubStore,
  type StoredPullRequest,
} from "./support/github.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ENDPOINT = "https://api.github.test";

const IDENTITY: RepositoryIdentity = Object.freeze({
  name: "project",
  locatorFingerprint: "0".repeat(64),
  requestedBase: null,
  creationCommit: "d".repeat(40),
  primaryBranch: "main",
  objectFormat: "sha1",
});

const INPUTS: PullRequestInputs = Object.freeze({
  repository: IDENTITY,
  number: null,
  title: "Prepare 1.4",
  body: "Release notes.\n",
  draft: false,
  headBranch: "publish/1.4",
  headSha: HEAD,
  baseBranch: "main",
});

const PAYLOAD = {
  node_id: "PR_node_1",
  number: 7,
  html_url: "https://github.com/octo/project/pull/7",
  state: "open",
  title: INPUTS.title,
  body: INPUTS.body,
  draft: false,
  head: { ref: INPUTS.headBranch, sha: HEAD, repo: { full_name: "octo/project" } },
  base: { ref: "main", sha: BASE, repo: { full_name: "octo/project" } },
};

/** The snapshot this payload describes, when it describes an open one. */
function normalized(payload: unknown): PullRequestSnapshot | undefined {
  const reading = readPullRequest(payload, "sha1");
  return reading === undefined ? undefined : openSnapshot(reading);
}

function open(overrides: Partial<StoredPullRequest> = {}): StoredPullRequest {
  return {
    nodeId: "PR_node_1",
    number: 7,
    state: "open",
    title: INPUTS.title,
    body: INPUTS.body,
    draft: false,
    headRef: INPUTS.headBranch,
    headSha: HEAD,
    baseRef: "main",
    baseSha: BASE,
    ...overrides,
  };
}

function store(options: { pullRequests?: StoredPullRequest[] } = {}): GitHubStore {
  return gitHubStore({
    pullRequests: options.pullRequests,
    heads: { [INPUTS.headBranch]: HEAD, main: BASE },
  });
}

function pulls(state: GitHubStore) {
  return gitHubPullRequests(
    fakeGitHubAccess(state, ENDPOINT),
    { owner: state.owner, repository: state.repository },
    "sha1",
  );
}

/** An access that answers exactly what a test hands it, and counts the asking. */
function scripted(
  answers: (request: GitHubHttpRequest) => GitHubHttpResponse,
  token: string | null = "test-token",
): { access: GitHubAccess; requests: GitHubHttpRequest[] } {
  const requests: GitHubHttpRequest[] = [];
  return {
    requests,
    access: {
      endpoint: ENDPOINT,
      // deno-lint-ignore require-yield
      *token(): Operation<string | undefined> {
        return token === null ? undefined : token;
      },
      // deno-lint-ignore require-yield
      *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
        requests.push(request);
        return answers(request);
      },
    },
  };
}

describe("workflow GitHub locator admission", () => {
  it("names the repository the admitted github.com forms describe", function* () {
    for (const locator of [
      "https://github.com/octo/project",
      "https://github.com/octo/project.git",
      "ssh://git@github.com/octo/project",
      "ssh://git@github.com/octo/project.git",
      "git@github.com:octo/project",
      "git@github.com:octo/project.git",
    ]) {
      expect(parseGitHubRepository(locator)).toEqual({ owner: "octo", repository: "project" });
    }
  });

  it("names none of the forms this adapter does not act for", function* () {
    for (const locator of [
      // Another host, and a host that merely contains the name.
      "https://gitlab.com/octo/project",
      "https://github.com.example.invalid/octo/project",
      "git@gitlab.com:octo/project",
      // Transports this adapter has no API behind.
      "git://github.com/octo/project",
      "file:///srv/git/project.git",
      "http://github.com/octo/project",
      "/srv/git/project.git",
      "../project",
      // Not one repository.
      "https://github.com/octo",
      "https://github.com/octo/project/pull/1",
      "https://github.com/octo/project/",
      "https://github.com//project",
      "https://github.com/octo/",
      // Anything but the plain name of one. The two credentialed forms are
      // assembled rather than written: a literal `user:password@host` in a
      // source file is a secret as far as any scanner reading this diff can
      // tell, and this repository journals its own diffs.
      `https://${"token"}@github.com/octo/project`,
      `https://${["user", "password"].join(":")}@github.com/octo/project`,
      "https://github.com:8443/octo/project",
      "https://github.com/octo/project?token=secret",
      "https://github.com/octo/project#fragment",
    ]) {
      expect(parseGitHubRepository(locator)).toBeUndefined();
    }
  });
});

describe("workflow GitHub credentials", () => {
  function holding(token: string | undefined): GitHubLogin {
    return {
      // deno-lint-ignore require-yield
      *token(): Operation<string | undefined> {
        return token;
      },
    };
  }

  /**
   * Three sources now, in one order, shared by every shipped GitHub adapter.
   *
   * Only the first case is made against the default access. That one is
   * answered by a variable before anything else is consulted, so it can prove
   * the default reads this process's environment without reaching further. A
   * default access with neither variable set would ask the machine's own
   * `gh auth login` — a developer's real credential, which no suite may read.
   */
  /**
   * Which source answered, never what it answered with.
   *
   * A token is a token whether it is real or synthetic, and an assertion that
   * compares one prints it when it fails.
   */
  const SOURCES = new Map([
    ["gh-token-value", "GH_TOKEN"],
    ["github-token-value", "GITHUB_TOKEN"],
    ["login-token-value", "login"],
  ]);

  function whichSource(token: string | undefined): string {
    return token === undefined ? "none" : (SOURCES.get(token) ?? "unrecognized");
  }

  it("prefers GH_TOKEN, then GITHUB_TOKEN, then the host's own login", function* () {
    const before = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN };
    try {
      process.env.GH_TOKEN = "gh-token-value";
      process.env.GITHUB_TOKEN = "github-token-value";
      expect(whichSource(yield* denoGitHubAccess().token())).toBe("GH_TOKEN");
    } finally {
      restore("GH_TOKEN", before.gh);
      restore("GITHUB_TOKEN", before.github);
    }

    const login = holding("login-token-value");
    expect(
      whichSource(
        yield* denoGitHubAccess(undefined, {
          environment: { GH_TOKEN: "gh-token-value", GITHUB_TOKEN: "github-token-value" },
          login,
        }).token(),
      ),
    ).toBe("GH_TOKEN");
    expect(
      whichSource(
        yield* denoGitHubAccess(undefined, {
          environment: { GITHUB_TOKEN: "github-token-value" },
          login,
        }).token(),
      ),
    ).toBe("GITHUB_TOKEN");
    expect(
      whichSource(yield* denoGitHubAccess(undefined, { environment: {}, login }).token()),
    ).toBe("login");

    // An empty variable names no credential. Sending `Bearer ` would ask GitHub
    // to decide what an empty token means, and looking further would ignore a
    // caller who said outright which credential to use.
    expect(
      yield* denoGitHubAccess(undefined, { environment: { GITHUB_TOKEN: "" }, login }).token(),
    ).toBeUndefined();
    expect(
      whichSource(
        yield* denoGitHubAccess(undefined, {
          environment: {},
          login: holding(undefined),
        }).token(),
      ),
    ).toBe("none");
  });

  it("cannot observe without a credential, and creates nothing", function* () {
    const refusing = scripted(() => ({ status: 200, body: "[]" }), null);
    const observed = yield* gitHubPullRequests(
      refusing.access,
      {
        owner: "octo",
        repository: "project",
      },
      "sha1",
    ).observe(INPUTS);
    expect(observed.state).toBe("unavailable");
    expect(refusing.requests).toHaveLength(0);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("workflow GitHub response normalization", () => {
  it("reads exactly the eleven facts a snapshot holds", function* () {
    expect(normalized(PAYLOAD)).toEqual({
      providerId: "PR_node_1",
      number: 7,
      url: "https://github.com/octo/project/pull/7",
      state: "open",
      title: INPUTS.title,
      body: INPUTS.body,
      draft: false,
      headBranch: INPUTS.headBranch,
      headSha: HEAD,
      baseBranch: "main",
      baseSha: BASE,
    });
  });

  it("reads an absent body as an empty one", function* () {
    expect(normalized({ ...PAYLOAD, body: null })?.body).toBe("");
  });

  it("reads a closed pull request as one, rather than as a host it cannot read", function* () {
    const closed = readPullRequest({ ...PAYLOAD, state: "closed" }, "sha1");
    expect(closed?.state).toBe("closed");
    // It is not a snapshot: a snapshot is an open pull request by construction.
    expect(closed === undefined ? undefined : openSnapshot(closed)).toBeUndefined();
    // A payload that says only that something is closed says nothing else.
    expect(readPullRequest({ state: "closed" }, "sha1")).toBeUndefined();
  });

  it("names which repository the head and the base live in, without case", function* () {
    const reading = readPullRequest(PAYLOAD, "sha1");
    expect(reading?.headRepository).toBe("octo/project");
    expect(reading === undefined ? false : sameRepository(reading, "Octo/Project")).toBe(true);
    const fork = readPullRequest(
      { ...PAYLOAD, head: { ...PAYLOAD.head, repo: { full_name: "someone/fork" } } },
      "sha1",
    );
    expect(fork === undefined ? true : sameRepository(fork, "octo/project")).toBe(false);
  });

  it("reads nothing from a payload that is missing or malformed", function* () {
    for (const damage of [
      { node_id: undefined },
      { node_id: "" },
      { number: "7" },
      { number: 0 },
      { html_url: undefined },
      { head: { ref: INPUTS.headBranch, sha: HEAD } },
      { base: { ref: "main", sha: BASE, repo: null } },
      { title: undefined },
      { body: 7 },
      { draft: "false" },
      { head: undefined },
      { head: { ref: "publish/1.4" } },
      { head: { ref: "publish/1.4", sha: "nope" } },
      { base: { ref: "main", sha: "b".repeat(64) } },
    ]) {
      expect(normalized({ ...PAYLOAD, ...damage })).toBeUndefined();
    }
    expect(normalized(undefined)).toBeUndefined();
    expect(normalized("a pull request")).toBeUndefined();
  });
});

describe("workflow GitHub numbered lookup", () => {
  const numbered: PullRequestInputs = Object.freeze({ ...INPUTS, number: 7 });

  it("finds the pull request the number names", function* () {
    const state = store({ pullRequests: [open()] });
    const observed = yield* pulls(state).observe(numbered);
    expect(observed.state).toBe("found");
    // One request, by number: a numbered lookup never lists.
    expect(state.requests).toHaveLength(1);
    expect(new URL(state.requests[0]?.url ?? "").pathname).toBe("/repos/octo/project/pulls/7");
  });

  it("conflicts on a closed pull request, a foreign repository and a foreign head", function* () {
    for (const stored of [
      open({ state: "closed" }),
      open({ headRepository: "someone/fork" }),
      open({ baseRepository: "someone/else" }),
      open({ headRef: "another-branch" }),
      open({ headSha: "9".repeat(40) }),
    ]) {
      const state = store({ pullRequests: [stored] });
      expect((yield* pulls(state).observe(numbered)).state).toBe("conflict");
      // Nothing is rewritten onto state this element did not prove.
      expect(state.requests.every((request) => request.method === "GET")).toBe(true);
    }
  });

  it("cannot decide a pull request whose repository it could not read", function* () {
    // A deleted fork reports no repository at all. That proves neither that
    // this is the pull request the document named nor that it is somebody
    // else's, so it is a host that could not answer rather than a conflict.
    const state = store({ pullRequests: [open({ headRepository: null })] });
    expect((yield* pulls(state).observe(numbered)).state).toBe("unavailable");
    expect(state.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("cannot read a numbered answer that says only that something is closed", function* () {
    // Closed is a conflict only once the response has proven it is this pull
    // request. A payload that proves nothing is a host that could not answer.
    const answered = scripted(() => ({ status: 200, body: JSON.stringify({ state: "closed" }) }));
    const observed = yield* gitHubPullRequests(
      answered.access,
      { owner: "octo", repository: "project" },
      "sha1",
    ).observe(numbered);
    expect(observed.state).toBe("unavailable");
  });

  it("cannot decide a number the host will not answer for", function* () {
    const missing = store();
    expect((yield* pulls(missing).observe(numbered)).state).toBe("unavailable");

    for (const fault of [
      { on: "lookup" as const, status: 403 },
      { on: "lookup" as const, status: 500 },
      { on: "lookup" as const, status: 200, malformed: true },
      { on: "lookup" as const },
    ]) {
      const state = store({ pullRequests: [open()] });
      state.fault = fault;
      expect((yield* pulls(state).observe(numbered)).state).toBe("unavailable");
    }
  });
});

describe("workflow GitHub update", () => {
  const numbered: PullRequestInputs = Object.freeze({ ...INPUTS, number: 7 });

  /** The snapshot an observation of this stored pull request would produce. */
  function before(stored: StoredPullRequest): PullRequestSnapshot {
    return {
      providerId: stored.nodeId,
      number: stored.number,
      url: `https://github.com/owner/repository/pull/${stored.number}`,
      state: "open",
      title: stored.title,
      body: stored.body ?? "",
      draft: stored.draft,
      headBranch: stored.headRef,
      headSha: stored.headSha,
      baseBranch: stored.baseRef,
      baseSha: stored.baseSha,
    };
  }

  it("issues each required mutation once, then observes exactly once", function* () {
    const state = store({ pullRequests: [open({ title: "Before", draft: true })] });
    const settled = yield* pulls(state).update(
      { ...numbered, title: "Prepare 1.4", draft: false },
      before(open({ title: "Before", draft: true })),
    );
    expect(settled.state).toBe("settled");
    expect(state.pullRequests[0]?.title).toBe("Prepare 1.4");
    expect(state.pullRequests[0]?.draft).toBe(false);
    // One PATCH, one draft transition, one observation.
    expect(mutations(state)).toEqual(["patch", "draft"]);
    expect(state.requests.filter((request) => request.method === "GET")).toHaveLength(1);
  });

  it("moves only the fields that differ", function* () {
    const state = store({ pullRequests: [open({ title: "Before" })] });
    yield* pulls(state).update(numbered, before(open({ title: "Before" })));
    // Draft already matches, so no draft transition was asked for.
    expect(mutations(state)).toEqual(["patch"]);
    const asked = Object(JSON.parse(state.requests[0]?.body ?? "{}"));
    expect(Object.keys(asked)).toEqual(["title"]);
  });

  it("changes the base branch, and reports the base commit it moved to", function* () {
    const state = store({ pullRequests: [open({ baseRef: "develop", baseSha: "9".repeat(40) })] });
    state.heads.set("main", BASE);
    const settled = yield* pulls(state).update(
      numbered,
      before(open({ baseRef: "develop", baseSha: "9".repeat(40) })),
    );
    expect(settled.state === "settled" ? settled.pullRequest.baseBranch : "").toBe("main");
    expect(settled.state === "settled" ? settled.pullRequest.baseSha : "").toBe(BASE);
  });

  it("reports what it observed when a mutation is refused, and repeats none", function* () {
    const state = store({ pullRequests: [open({ title: "Before" })] });
    state.fault = { on: "patch", status: 422 };
    const settled = yield* pulls(state).update(numbered, before(open({ title: "Before" })));
    // The mutation was refused, so the observation that follows finds the pull
    // request exactly as it was. What the adapter reports is that final state;
    // whether it is the requested one is the provider's to decide, and the
    // document-level suite proves it publishes an unavailability.
    expect(settled.state === "settled" ? settled.pullRequest.title : "").toBe("Before");
    expect(mutations(state)).toEqual(["patch"]);
    expect(state.pullRequests[0]?.title).toBe("Before");
  });

  it("reports the half-applied state when one of two mutations failed", function* () {
    const state = store({ pullRequests: [open({ title: "Before", draft: true })] });
    state.fault = { on: "graphql", status: 502 };
    const settled = yield* pulls(state).update(
      { ...numbered, draft: false },
      before(open({ title: "Before", draft: true })),
    );
    // The REST half applied and the draft half did not, so the final
    // observation reports a pull request that is half of what was asked for.
    expect(settled.state === "settled" ? settled.pullRequest.title : "").toBe("Prepare 1.4");
    expect(settled.state === "settled" ? settled.pullRequest.draft : false).toBe(true);
    expect(state.pullRequests[0]?.title).toBe("Prepare 1.4");
    expect(state.pullRequests[0]?.draft).toBe(true);
    // Each mutation was issued once. Neither is repeated to make it stick.
    expect(mutations(state)).toEqual(["patch", "draft"]);
  });
});

describe("workflow GitHub observation", () => {
  it("proves absence only when the open and the all-state listings are empty", function* () {
    const state = store();
    expect((yield* pulls(state).observe(INPUTS)).state).toBe("absent");
    // Both listings were made: an empty open listing alone is not absence.
    expect(state.requests.map((request) => new URL(request.url).searchParams.get("state"))).toEqual(
      ["open", "all"],
    );
    expect(creations(state)).toBe(0);
  });

  it("finds the one open pull request for this branch pair", function* () {
    const state = store({ pullRequests: [open()] });
    const observed = yield* pulls(state).observe(INPUTS);
    expect(observed.state).toBe("found");
    expect(observed.state === "found" ? observed.pullRequest.number : 0).toBe(7);
    // One listing: an open candidate answers without the all-state lookup.
    expect(state.requests).toHaveLength(1);
  });

  it("ignores an open pull request for another branch pair", function* () {
    const state = store({ pullRequests: [open({ headRef: "publish/1.5" })] });
    expect((yield* pulls(state).observe(INPUTS)).state).toBe("absent");
  });

  it("conflicts on a closed or merged pull request for this branch pair", function* () {
    const state = store({ pullRequests: [open({ state: "closed" })] });
    expect((yield* pulls(state).observe(INPUTS)).state).toBe("conflict");
    expect(creations(state)).toBe(0);
  });

  it("is ambiguous when more than one is open, even if one of them fits", function* () {
    const state = store({
      pullRequests: [open(), open({ nodeId: "PR_node_2", number: 8, title: "Other" })],
    });
    expect((yield* pulls(state).observe(INPUTS)).state).toBe("ambiguous");
    expect(creations(state)).toBe(0);
  });

  it("follows pagination before it answers", function* () {
    const state = store({
      pullRequests: [open(), open({ nodeId: "PR_node_2", number: 8 })],
    });
    state.pageSize = 1;
    // Two candidates across two pages is still two candidates. A reader that
    // stopped at the first page would have adopted one of them.
    expect((yield* pulls(state).observe(INPUTS)).state).toBe("ambiguous");
    expect(state.requests).toHaveLength(2);
  });

  it("reads no answer as absence", function* () {
    for (const fault of [
      { on: "list" as const, status: 401 },
      { on: "list" as const, status: 403 },
      { on: "list" as const, status: 404 },
      { on: "list" as const, status: 429 },
      { on: "list" as const, status: 500 },
      { on: "list" as const, status: 200, malformed: true },
      { on: "list" as const },
    ]) {
      const state = store({ pullRequests: [] });
      state.fault = fault;
      expect((yield* pulls(state).observe(INPUTS)).state).toBe("unavailable");
      expect(creations(state)).toBe(0);
    }
  });

  it("reads an incomplete page walk as unknown rather than as the whole set", function* () {
    const answered = scripted((request) => ({
      status: 200,
      body: "[]",
      // A page that always names a next page: a reader with no limit would
      // follow it forever, and one that gave up quietly would report absence.
      link: `<${new URL(request.url).href}&page=2>; rel="next"`,
    }));
    const observed = yield* gitHubPullRequests(
      answered.access,
      {
        owner: "octo",
        repository: "project",
      },
      "sha1",
    ).observe(INPUTS);
    expect(observed.state).toBe("unavailable");
    expect(answered.requests.length).toBeGreaterThan(1);
  });

  it("will not follow a next page somewhere else, and says the walk is unknown", function* () {
    const answered = scripted(() => ({
      status: 200,
      body: "[]",
      link: '<https://elsewhere.invalid/pulls?page=2>; rel="next"',
    }));
    // The credential goes where this adapter decided, never where a response
    // says. An off-origin next page is not the end of the walk either: what is
    // on it was never read, so the candidate set is unknown rather than empty.
    const observed = yield* gitHubPullRequests(
      answered.access,
      { owner: "octo", repository: "project" },
      "sha1",
    ).observe(INPUTS);
    expect(observed.state).toBe("unavailable");
    // One page, nothing off-origin reached, and nothing created.
    expect(answered.requests).toHaveLength(1);
    expect(answered.requests.every((request) => request.url.startsWith(ENDPOINT))).toBe(true);
    expect(answered.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("cannot count candidates it could not read", function* () {
    // Two members, neither of them a pull request. A reader that counted first
    // would call this ambiguous — two of something — on the strength of a host
    // that answered with nothing at all.
    const answered = scripted(() => ({ status: 200, body: JSON.stringify([{}, {}]) }));
    const observed = yield* gitHubPullRequests(
      answered.access,
      { owner: "octo", repository: "project" },
      "sha1",
    ).observe(INPUTS);
    expect(observed.state).toBe("unavailable");
    expect(answered.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("cannot read an all-state listing as a conflict when it could not read it", function* () {
    // The open listing is genuinely empty, and the all-state one holds a member
    // this adapter cannot read. That is not "something is there": it is a host
    // that could not say.
    let call = 0;
    const answered = scripted(() => {
      call += 1;
      return { status: 200, body: call === 1 ? "[]" : JSON.stringify([{}]) };
    });
    const observed = yield* gitHubPullRequests(
      answered.access,
      { owner: "octo", repository: "project" },
      "sha1",
    ).observe(INPUTS);
    expect(observed.state).toBe("unavailable");
    expect(answered.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("does not count a fork candidate as one of this repository's", function* () {
    const state = store({ pullRequests: [open({ headRepository: "someone/fork" })] });
    // Readable, matching on every field the request names, and outside the
    // supported natural key: it is excluded before anything is counted, so this
    // is absence rather than a candidate to adopt.
    expect((yield* pulls(state).observe(INPUTS)).state).toBe("absent");
    expect(creations(state)).toBe(0);
  });

  it("records no completion for a creation naming another repository", function* () {
    const answered = scripted(() => ({
      status: 201,
      body: JSON.stringify({
        node_id: "PR_node_1",
        number: 1,
        html_url: "https://github.com/someone/fork/pull/1",
        state: "open",
        title: INPUTS.title,
        body: INPUTS.body,
        draft: false,
        head: { ref: INPUTS.headBranch, sha: HEAD, repo: { full_name: "someone/fork" } },
        base: { ref: "main", sha: BASE, repo: { full_name: "octo/project" } },
      }),
    }));
    const created = yield* gitHubPullRequests(
      answered.access,
      { owner: "octo", repository: "project" },
      "sha1",
    ).create(INPUTS);
    expect(created.state).toBe("unreadable");
  });

  it("sends the pinned media type, API version and credential", function* () {
    const state = store();
    yield* pulls(state).observe(INPUTS);
    const [first] = state.requests;
    expect(first?.headers["Accept"]).toBe("application/vnd.github+json");
    expect(first?.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(first?.headers["Authorization"]).toBe("Bearer test-token");
    const query = new URL(first?.url ?? "https://x.invalid").searchParams;
    expect(query.get("head")).toBe(`octo:${INPUTS.headBranch}`);
    expect(query.get("base")).toBe("main");
  });
});

describe("workflow GitHub creation", () => {
  it("creates one pull request with exactly what was asked for", function* () {
    const state = store();
    const created = yield* pulls(state).create(INPUTS);
    expect(created.state).toBe("settled");
    expect(created.state === "settled" ? created.pullRequest.number : 0).toBe(1);
    expect(creations(state)).toBe(1);
    const sent = Object(JSON.parse(state.requests[0]?.body ?? "{}"));
    expect(sent).toEqual({
      title: INPUTS.title,
      head: INPUTS.headBranch,
      base: "main",
      body: INPUTS.body,
      draft: false,
    });
  });

  it("is uncertain rather than failed when the host refuses the creation", function* () {
    for (const fault of [
      { on: "create" as const, status: 422 },
      { on: "create" as const, status: 500 },
      { on: "create" as const },
    ]) {
      const state = store();
      state.fault = fault;
      expect((yield* pulls(state).create(INPUTS)).state).toBe("uncertain");
    }
  });

  it("refuses a creation it cannot read", function* () {
    const answered = scripted(() => ({ status: 201, body: JSON.stringify({ number: 1 }) }));
    const created = yield* gitHubPullRequests(
      answered.access,
      {
        owner: "octo",
        repository: "project",
      },
      "sha1",
    ).create(INPUTS);
    expect(created.state).toBe("unreadable");
  });

  it("answers a duplicate creation the way GitHub does, and creates nothing", function* () {
    const state = store({ pullRequests: [open()] });
    expect((yield* pulls(state).create(INPUTS)).state).toBe("uncertain");
    expect(state.pullRequests).toHaveLength(1);
    // The fixture is the one that refuses, which is what makes the assertion
    // above about the adapter rather than about the fixture.
    expect(
      respond(state, state.requests[0] ?? { method: "GET", url: ENDPOINT, headers: {} }).status,
    ).toBe(422);
  });
});
