/**
 * Tier U — the GitHub issue adapter, on its own.
 *
 * What it sends, what it makes of an answer, and — the claim the whole
 * reconciliation rests on — that nothing it cannot read ever becomes "there is
 * no issue here". Every test drives the real adapter; what is substituted is
 * the transport and the environment, which is the whole of what it asks its
 * host for.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import {
  gitHubIssues,
  openIssue,
  readIssue,
  type GitHubAccess,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
} from "../src/deno/composition/github.ts";
import {
  issueBody,
  issueNaturalKey,
  issueOriginMarker,
  type IssueInputs,
  type IssueSnapshot,
} from "../src/composition/issue-records.ts";
import type { GitPushRepositoryIdentity } from "../src/composition/git-push-records.ts";
import type { PullRequestResult } from "../src/composition/pull-request-records.ts";
import type { GitHostEffectIdentity } from "../src/git-host/records.ts";
import {
  fakeGitHubAccess,
  gitHubStore,
  issueCalls,
  issueCreations,
  issuePatches,
  type GitHubStore,
  type StoredIssue,
} from "./support/github.ts";

const ENDPOINT = "https://api.github.test";

const IDENTITY: GitPushRepositoryIdentity = Object.freeze({
  name: "project",
  locatorFingerprint: "0".repeat(64),
  requestedBase: null,
  creationCommit: "d".repeat(40),
  primaryBranch: "main",
  objectFormat: "sha1",
});

const PULL_REQUEST: PullRequestResult = Object.freeze({
  repository: IDENTITY,
  providerId: "PR_node_1",
  number: 7,
  url: "https://github.com/octo/project/pull/7",
  state: "open",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
});

const INPUTS: IssueInputs = Object.freeze({
  repository: IDENTITY,
  pullRequest: PULL_REQUEST,
  finding: "F-17",
  disposition: "defer",
  title: "Retry the publish step on a 5xx",
  body: "The publish step failed twice in a row on 503.\n",
  rationale: "The retry needs a backoff policy nobody has settled yet.",
  dependencyImpact: "Blocks nothing.",
  intendedTiming: "Next release train.",
});

const WHERE: GitHostEffectIdentity = Object.freeze({
  runId: "release-1.4",
  expansionId: "expansion-1",
});

const MARKER = issueOriginMarker(issueNaturalKey(INPUTS));

const BODY = issueBody(INPUTS, WHERE);

function store(issues: StoredIssue[] = []): GitHubStore {
  return gitHubStore({ issues });
}

function issues(state: GitHubStore) {
  return gitHubIssues(fakeGitHubAccess(state, ENDPOINT), {
    owner: state.owner,
    repository: state.repository,
  });
}

/** One issue this GitHub already holds, carrying this obligation's marker. */
function held(overrides: Partial<StoredIssue> = {}): StoredIssue {
  return {
    nodeId: "I_node_1",
    number: 3,
    state: "open",
    title: INPUTS.title,
    body: BODY,
    ...overrides,
  };
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

const REPOSITORY_URL = `${ENDPOINT}/repos/octo/project`;

/** The URL the fixture reports, which is a payload's own word and not composed. */
const HELD_URL = "https://github.com/owner/repository/issues/3";

const PAYLOAD = {
  node_id: "I_node_1",
  number: 3,
  html_url: "https://github.com/octo/project/issues/3",
  state: "open",
  title: INPUTS.title,
  body: BODY,
  repository_url: REPOSITORY_URL,
};

function listed(...entries: unknown[]): GitHubHttpResponse {
  return { status: 200, body: JSON.stringify(entries) };
}

describe("workflow GitHub issue payloads", () => {
  it("reads the eight facts an issue answer has to carry", function* () {
    expect(readIssue(PAYLOAD)).toEqual({
      state: "open",
      providerId: "I_node_1",
      number: 3,
      url: "https://github.com/octo/project/issues/3",
      title: INPUTS.title,
      body: BODY,
      repository: REPOSITORY_URL,
      pullRequest: false,
    });
    // An absent body is an empty one, which is what GitHub means by `null`.
    expect(readIssue({ ...PAYLOAD, body: null })?.body).toBe("");
    // A pull request is an issue at GitHub, and says so.
    expect(readIssue({ ...PAYLOAD, pull_request: { url: "…" } })?.pullRequest).toBe(true);
  });

  it("reads no issue out of an answer missing any of them", function* () {
    for (const damage of [
      { node_id: "" },
      { node_id: 1 },
      { number: 0 },
      { number: "3" },
      { number: 3.5 },
      { html_url: "" },
      { state: "merged" },
      { title: "" },
      { body: 1 },
      { repository_url: "" },
    ]) {
      expect(readIssue({ ...PAYLOAD, ...damage })).toBeUndefined();
    }
    expect(readIssue(undefined)).toBeUndefined();
    expect(readIssue([PAYLOAD])).toBeUndefined();
  });

  it("makes a snapshot of an open issue and none of a closed one", function* () {
    const open = readIssue(PAYLOAD);
    expect(open === undefined ? undefined : openIssue(open)).toEqual({
      providerId: "I_node_1",
      number: 3,
      url: "https://github.com/octo/project/issues/3",
      state: "open",
      title: INPUTS.title,
      body: BODY,
    });
    const closed = readIssue({ ...PAYLOAD, state: "closed" });
    expect(closed === undefined ? undefined : openIssue(closed)).toBeUndefined();
  });
});

describe("workflow GitHub issue observation", () => {
  it("finds the one issue carrying this obligation's marker", function* () {
    const state = store([held()]);
    const observed = yield* issues(state).observe(INPUTS, WHERE);
    expect(observed).toEqual({
      state: "found",
      issue: {
        providerId: "I_node_1",
        number: 3,
        url: HELD_URL,
        state: "open",
        title: INPUTS.title,
        body: BODY,
      },
    });
    // Every issue in the repository, in one listing, and nothing else.
    expect(issueCalls(state)).toEqual(["GET /repos/octo/project/issues"]);
  });

  it("reports absence for an issue carrying somebody else's marker", function* () {
    const other = { ...INPUTS, finding: "F-18" };
    const state = store([held({ body: issueBody(other, WHERE) })]);
    expect(yield* issues(state).observe(INPUTS, WHERE)).toEqual({ state: "absent" });
  });

  it("never reads a pull request as the issue it is looking for", function* () {
    // GitHub lists pull requests among a repository's issues, and one could
    // carry this marker in its own body — a document quoting the evidence into
    // the pull request would do it. It is still not an issue.
    const state = gitHubStore({
      pullRequests: [
        {
          nodeId: "PR_node_1",
          number: 7,
          state: "open",
          title: INPUTS.title,
          body: BODY,
          draft: false,
          headRef: "publish/1.4",
          headSha: "a".repeat(40),
          baseRef: "main",
          baseSha: "b".repeat(40),
        },
      ],
    });
    expect(yield* issues(state).observe(INPUTS, WHERE)).toEqual({ state: "absent" });
  });

  it("refuses two issues carrying one marker rather than adopting either", function* () {
    const state = store([held(), held({ nodeId: "I_node_2", number: 4 })]);
    expect(yield* issues(state).observe(INPUTS, WHERE)).toEqual({ state: "ambiguous" });
    expect(issueCreations(state)).toBe(0);
  });

  it("refuses a marked issue somebody closed, and one in another repository", function* () {
    const closed = store([held({ state: "closed" })]);
    expect(yield* issues(closed).observe(INPUTS, WHERE)).toEqual({ state: "conflict" });

    const elsewhere = store([held({ repository: `${ENDPOINT}/repos/octo/other` })]);
    expect(yield* issues(elsewhere).observe(INPUTS, WHERE)).toEqual({ state: "conflict" });
  });

  it("finds a marked issue whose text has moved, so the update can be described", function* () {
    const state = store([held({ title: "Something else entirely" })]);
    const observed = yield* issues(state).observe(INPUTS, WHERE);
    expect(observed.state).toBe("found");
    expect(observed.state === "found" && observed.issue.title).toBe("Something else entirely");
  });
});

describe("workflow GitHub issue unavailability", () => {
  it("answers unavailable for every way a listing can fail to be an answer", function* () {
    const refusals: ((request: GitHubHttpRequest) => GitHubHttpResponse)[] = [
      () => {
        throw new Error("the transport refused the connection");
      },
      () => ({ status: 500, body: "{}" }),
      () => ({ status: 403, body: JSON.stringify({ message: "rate limited" }) }),
      // A 404 is a permission check as often as it is absence.
      () => ({ status: 404, body: JSON.stringify({ message: "Not Found" }) }),
      () => ({ status: 200, body: "{" }),
      () => ({ status: 200, body: JSON.stringify({ items: [] }) }),
      // One member of the page this adapter cannot read leaves the set unknown.
      () => listed(PAYLOAD, { node_id: "I_node_9" }),
    ];
    for (const answers of refusals) {
      const { access } = scripted(answers);
      const observed = yield* gitHubIssues(access, {
        owner: "octo",
        repository: "project",
      }).observe(INPUTS, WHERE);
      expect(observed).toEqual({ state: "unavailable" });
    }
  });

  it("answers unavailable with no credential, before anything is sent", function* () {
    const { access, requests } = scripted(() => listed(), null);
    const adapter = gitHubIssues(access, { owner: "octo", repository: "project" });
    expect(yield* adapter.observe(INPUTS, WHERE)).toEqual({ state: "unavailable" });
    expect(yield* adapter.create(INPUTS, WHERE)).toEqual({ state: "uncertain" });
    expect(requests).toHaveLength(0);
  });

  it("carries the credential on every call it does make", function* () {
    const state = store([held()]);
    yield* issues(state).observe(INPUTS, WHERE);
    expect(state.requests).not.toHaveLength(0);
    for (const request of state.requests) {
      expect(request.headers["Authorization"]).toBe(`Bearer ${state.token}`);
    }
  });

  it("refuses a next page it will not follow rather than reporting absence", function* () {
    const unfollowable = store();
    unfollowable.issueLink = '<https://evil.test/repos/octo/project/issues?page=2>; rel="next"';
    expect(yield* issues(unfollowable).observe(INPUTS, WHERE)).toEqual({ state: "unavailable" });

    // And a walk it can follow is followed to the end, so a marked issue on a
    // later page is found rather than missed.
    const paged = store([
      held({ nodeId: "I_node_0", number: 1, body: "unrelated" }),
      held({ nodeId: "I_node_0b", number: 2, body: "also unrelated" }),
      held(),
    ]);
    paged.issuePageSize = 1;
    const observed = yield* issues(paged).observe(INPUTS, WHERE);
    expect(observed.state).toBe("found");
    expect(observed.state === "found" && observed.issue.number).toBe(3);
  });
});

describe("workflow GitHub issue mutation", () => {
  it("creates one issue whose title and body are what the request says", function* () {
    const state = store();
    const created = yield* issues(state).create(INPUTS, WHERE);
    expect(created.state).toBe("settled");
    expect(created.state === "settled" && created.issue.title).toBe(INPUTS.title);
    expect(created.state === "settled" && created.issue.body).toBe(BODY);
    expect(issueCreations(state)).toBe(1);

    // The marker is in the body it wrote, which is what makes the next
    // observation find it.
    expect(state.issues[0]?.body).toContain(MARKER);
    // And the evidence is in it verbatim, with the rest recorded around it.
    expect(state.issues[0]?.body).toContain(INPUTS.body);
    expect(state.issues[0]?.body).toContain(INPUTS.rationale);
    expect(state.issues[0]?.body).toContain(INPUTS.dependencyImpact);
    expect(state.issues[0]?.body).toContain(INPUTS.intendedTiming);
    expect(state.issues[0]?.body).toContain(PULL_REQUEST.url);
    expect(state.issues[0]?.body).toContain(WHERE.runId);
    expect(state.issues[0]?.body).toContain(WHERE.expansionId);
  });

  it("reports a creation it cannot read, and one that is not this repository's", function* () {
    const unreadable = scripted(() => ({ status: 201, body: "{" }));
    expect(
      yield* gitHubIssues(unreadable.access, { owner: "octo", repository: "project" }).create(
        INPUTS,
        WHERE,
      ),
    ).toEqual({ state: "unreadable" });

    const foreign = scripted(() => ({
      status: 201,
      body: JSON.stringify({ ...PAYLOAD, repository_url: `${ENDPOINT}/repos/octo/other` }),
    }));
    expect(
      yield* gitHubIssues(foreign.access, { owner: "octo", repository: "project" }).create(
        INPUTS,
        WHERE,
      ),
    ).toEqual({ state: "unreadable" });
  });

  it("reports a rejected creation as uncertain rather than as a failure", function* () {
    const state = store();
    state.fault = { on: "issue-create", status: 422 };
    expect(yield* issues(state).create(INPUTS, WHERE)).toEqual({ state: "uncertain" });
  });

  it("updates the two fields it owns, once, and then observes exactly once", function* () {
    const state = store([held({ title: "Stale", body: "stale body" })]);
    const before: IssueSnapshot = Object.freeze({
      providerId: "I_node_1",
      number: 3,
      url: HELD_URL,
      state: "open",
      title: "Stale",
      body: "stale body",
    });
    const updated = yield* issues(state).update(INPUTS, WHERE, before);
    expect(updated.state).toBe("settled");
    expect(updated.state === "settled" && updated.issue.title).toBe(INPUTS.title);
    expect(updated.state === "settled" && updated.issue.body).toBe(BODY);
    expect(issuePatches(state)).toBe(1);
    expect(issueCreations(state)).toBe(0);
    expect(issueCalls(state)).toEqual([
      "PATCH /repos/octo/project/issues/3",
      "GET /repos/octo/project/issues/3",
    ]);
  });

  it("sends no mutation when both fields already say what was asked", function* () {
    const state = store([held()]);
    const before: IssueSnapshot = Object.freeze({
      providerId: "I_node_1",
      number: 3,
      url: HELD_URL,
      state: "open",
      title: INPUTS.title,
      body: BODY,
    });
    expect((yield* issues(state).update(INPUTS, WHERE, before)).state).toBe("settled");
    expect(issuePatches(state)).toBe(0);
    // The observation still happens: what the issue holds is never decided from
    // the absence of a call.
    expect(issueCalls(state)).toEqual(["GET /repos/octo/project/issues/3"]);
  });

  it("reports an update it could not confirm as uncertain, having sent one patch", function* () {
    const state = store([held({ title: "Stale" })]);
    state.fault = { on: "issue-lookup", status: 500 };
    const before: IssueSnapshot = Object.freeze({
      providerId: "I_node_1",
      number: 3,
      url: HELD_URL,
      state: "open",
      title: "Stale",
      body: BODY,
    });
    expect(yield* issues(state).update(INPUTS, WHERE, before)).toEqual({ state: "uncertain" });
    expect(issuePatches(state)).toBe(1);
  });
});
