/**
 * Tier U — the GitHub Issue adapter, on its own.
 *
 * Which targets it will act for, what it makes of an answer, and — the claim
 * the whole reconciliation rests on — that nothing it cannot read ever becomes
 * "there is no issue here". Every test drives the real adapter; what is
 * substituted is the transport, which is the whole of what it asks its host
 * for.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, type Operation } from "effection";
import {
  gitHubIssueProvider,
  issueBodyFor,
  issueOriginMarker,
  parseGitHubIssueTarget,
  readGitHubIssue,
} from "../src/deno/issue/github.ts";
import {
  canonicalIssueTarget,
  issueProviderName,
  withinIssueCeiling,
} from "../src/issue/target.ts";
import { builtInIssueProvider } from "../src/deno/issue/resolution.ts";
import {
  issueInputsJson,
  issueNaturalKey,
  issueNaturalKeyJson,
  issuePreStateJson,
  issueSnapshotJson,
  normalizedTags,
  type CompleteIssueRequest,
  type IssueInputs,
} from "../src/issue/records.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../src/deno/composition/github.ts";
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
const TARGET = "https://github.com/octo/project";
const IDENTITY = Object.freeze({ runId: "run-296", expansionId: "expansion-1" });

const INPUTS: IssueInputs = Object.freeze({
  title: "Retry the publish step on a 5xx",
  description: "The publish step failed twice in a row on 503.",
  tags: Object.freeze(["publish", "reliability"]),
  assignee: null,
});

const REQUEST: CompleteIssueRequest = Object.freeze({
  identity: IDENTITY,
  provider: "github",
  target: TARGET,
  inputs: issueInputsJson(INPUTS),
  naturalKey: issueNaturalKeyJson(issueNaturalKey(IDENTITY, TARGET)),
});

const MARKER = issueOriginMarker(REQUEST.naturalKey);
const BODY = issueBodyFor(INPUTS, MARKER);

function store(issues: StoredIssue[] = []): GitHubStore {
  return gitHubStore({ issues });
}

function provider(state: GitHubStore, ceiling: readonly string[] = [TARGET]) {
  return gitHubIssueProvider({ ceiling, access: fakeGitHubAccess(state, ENDPOINT) });
}

/** One issue this GitHub holds, carrying this position's marker. */
function held(overrides: Partial<StoredIssue> = {}): StoredIssue {
  return {
    nodeId: "I_node_1",
    number: 1,
    state: "open",
    title: INPUTS.title,
    body: BODY,
    labels: [...INPUTS.tags],
    assignee: null,
    ...overrides,
  };
}

function scripted(
  answers: (request: GitHubHttpRequest) => GitHubHttpResponse,
  token: string | null = "test-token",
): GitHubAccess {
  return {
    endpoint: ENDPOINT,
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      return token === null ? undefined : token;
    },
    // deno-lint-ignore require-yield
    *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      return answers(request);
    },
  };
}

describe("workflow Issue target canonicalization", () => {
  it("gives one container one spelling", function* () {
    expect(canonicalIssueTarget("https://github.com/octo/project/")).toBe(TARGET);
    expect(canonicalIssueTarget("HTTPS://GitHub.com/octo/project")).toBe(TARGET);
    expect(canonicalIssueTarget("https://acme.atlassian.net/browse/PROJ/")).toBe(
      "https://acme.atlassian.net/browse/PROJ",
    );
  });

  it("refuses every URL that is not the plain name of a container", function* () {
    for (const value of [
      "",
      "not a url",
      "github.com/octo/project",
      "ftp://github.com/octo/project",
      "file:///srv/issues",
      `https://${"token"}@github.com/octo/project`,
      `https://${["user", "password"].join(":")}@github.com/octo/project`,
      "https://github.com/octo/project?tab=issues",
      "https://github.com/octo/project#new",
    ]) {
      expect(canonicalIssueTarget(value)).toBeUndefined();
    }
  });

  it("maps only the hosts the compatibility contract names", function* () {
    expect(builtInIssueProvider(TARGET)).toBe("github");
    expect(builtInIssueProvider("https://acme.atlassian.net/browse/PROJ")).toBe("atlassian");
    expect(builtInIssueProvider("https://github.example.invalid/octo/project")).toBeUndefined();
    // A host that merely contains the name is not that host.
    expect(builtInIssueProvider("https://github.com.example.invalid/octo/project")).toBeUndefined();
    expect(
      builtInIssueProvider("https://atlassian.net.example.invalid/browse/PROJ"),
    ).toBeUndefined();
  });

  it("reads a provider discriminator as a stable lower-case name", function* () {
    expect(issueProviderName("github")).toBe("github");
    expect(issueProviderName("self-hosted-2")).toBe("self-hosted-2");
    for (const value of ["", "GitHub", "1provider", "with space", 7, null]) {
      expect(issueProviderName(value)).toBeUndefined();
    }
  });

  it("narrows a ceiling by whole path segments", function* () {
    expect(withinIssueCeiling([TARGET], TARGET)).toBe(true);
    expect(withinIssueCeiling([TARGET], `${TARGET}/issues`)).toBe(true);
    expect(withinIssueCeiling([TARGET], "https://github.com/octo/project-two")).toBe(false);
    expect(withinIssueCeiling([TARGET], "https://github.com/other/project")).toBe(false);
    expect(withinIssueCeiling([], TARGET)).toBe(false);
  });

  it("names the repository both spellings of an issue collection describe", function* () {
    expect(parseGitHubIssueTarget(TARGET)).toEqual({ owner: "octo", repository: "project" });
    expect(parseGitHubIssueTarget(`${TARGET}/issues`)).toEqual({
      owner: "octo",
      repository: "project",
    });
    for (const value of [
      "https://github.com/octo",
      "https://github.com/octo/project/pulls",
      "https://github.com/octo/project/issues/1",
      "https://github.com:8443/octo/project",
      "http://github.com/octo/project",
      "https://gitlab.com/octo/project",
    ]) {
      expect(parseGitHubIssueTarget(value)).toBeUndefined();
    }
  });
});

describe("workflow Issue tag normalization", () => {
  it("is a set, ordered by code point", function* () {
    expect(normalizedTags(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizedTags(undefined)).toEqual([]);
    expect(normalizedTags([])).toEqual([]);
    // Code point rather than UTF-16 code unit: a supplementary character sorts
    // after every character in the private-use area, which the default
    // comparison gets the other way round.
    expect(normalizedTags(["\u{10000}", ""])).toEqual(["", "\u{10000}"]);
  });

  it("names no tag set for a value that is not one", function* () {
    for (const value of ["a", 1, {}, ["a", ""], ["a", 1], [null]]) {
      expect(normalizedTags(value)).toBeUndefined();
    }
  });
});

describe("workflow GitHub issue observation", () => {
  it("finds the one issue carrying this position's marker", function* () {
    const state = store([held()]);
    const observed = yield* provider(state).observe(REQUEST);
    expect(observed.ok).toBe(true);
    expect(observed.ok && observed.value.state).toBe("compatible");
    // One listing of the repository, and nothing else.
    expect(issueCalls(state)).toEqual(["GET /repos/octo/project/issues"]);
  });

  it("reports absence for an issue carrying another position's marker", function* () {
    const other = { ...REQUEST, identity: { ...IDENTITY, expansionId: "expansion-2" } };
    const marker = issueOriginMarker(issueNaturalKeyJson(issueNaturalKey(other.identity, TARGET)));
    const state = store([held({ body: issueBodyFor(INPUTS, marker) })]);
    const observed = yield* provider(state).observe(REQUEST);
    expect(observed.ok && observed.value.state).toBe("absent");
  });

  it("never reads a pull request as the issue it is looking for", function* () {
    const state = gitHubStore({
      pullRequests: [
        {
          nodeId: "PR_node_1",
          number: 1,
          state: "open",
          title: INPUTS.title,
          body: BODY,
          draft: false,
          headRef: "publish",
          headSha: "a".repeat(40),
          baseRef: "main",
          baseSha: "b".repeat(40),
        },
      ],
    });
    const observed = yield* provider(state).observe(REQUEST);
    expect(observed.ok && observed.value.state).toBe("absent");
  });

  it("refuses two issues carrying one marker, a closed one, and a foreign one", function* () {
    const two = store([held(), held({ nodeId: "I_node_2", number: 2 })]);
    expect((yield* provider(two).observe(REQUEST)).ok && true).toBe(true);
    const ambiguous = yield* provider(two).observe(REQUEST);
    expect(ambiguous.ok && ambiguous.value.state).toBe("ambiguous");

    const closed = store([held({ state: "closed" })]);
    const conflicted = yield* provider(closed).observe(REQUEST);
    expect(conflicted.ok && conflicted.value.state).toBe("conflict");

    const elsewhere = store([held({ repository: `${ENDPOINT}/repos/octo/other` })]);
    const foreign = yield* provider(elsewhere).observe(REQUEST);
    expect(foreign.ok && foreign.value.state).toBe("conflict");
  });

  it("refuses a target outside the ceiling before anything is sent", function* () {
    const state = store();
    const refused = yield* provider(state, ["https://github.com/other/repo"]).observe(REQUEST);
    expect(refused.ok).toBe(false);
    expect(state.requests).toHaveLength(0);
  });

  it("refuses a request whose discriminator is not this adapter's", function* () {
    const state = store();
    const refused = yield* provider(state).observe({ ...REQUEST, provider: "atlassian" });
    expect(refused.ok).toBe(false);
    expect(state.requests).toHaveLength(0);
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
      () => ({ status: 404, body: JSON.stringify({ message: "Not Found" }) }),
      () => ({ status: 200, body: "{" }),
      () => ({ status: 200, body: JSON.stringify({ items: [] }) }),
      () => ({ status: 200, body: JSON.stringify([{ node_id: "I9" }]) }),
    ];
    for (const answers of refusals) {
      const refused = yield* gitHubIssueProvider({
        ceiling: [TARGET],
        access: scripted(answers),
      }).observe(REQUEST);
      expect(refused.ok).toBe(false);
    }
  });

  it("answers unavailable with no credential, before anything is sent", function* () {
    let sent = 0;
    const access = scripted(() => {
      sent += 1;
      return { status: 200, body: "[]" };
    }, null);
    const adapter = gitHubIssueProvider({ ceiling: [TARGET], access });
    expect((yield* adapter.observe(REQUEST)).ok).toBe(false);
    expect(sent).toBe(0);
  });

  it("refuses a next page it will not follow rather than reporting absence", function* () {
    const unfollowable = store();
    unfollowable.issueLink = '<https://evil.test/repos/octo/project/issues?page=2>; rel="next"';
    expect((yield* provider(unfollowable).observe(REQUEST)).ok).toBe(false);

    // And a walk it can follow is followed to the end.
    const paged = store([held({ nodeId: "I0", number: 9, body: "unrelated" }), held()]);
    paged.issuePageSize = 1;
    const observed = yield* provider(paged).observe(REQUEST);
    expect(observed.ok && observed.value.state).toBe("compatible");
  });

  it("carries the credential on every call it makes", function* () {
    const state = store([held()]);
    yield* provider(state).observe(REQUEST);
    expect(state.requests).not.toHaveLength(0);
    for (const request of state.requests) {
      expect(request.headers["Authorization"]).toBe(`Bearer ${state.token}`);
    }
  });
});

describe("workflow GitHub issue mutation", () => {
  it("creates one issue whose title, body, labels and assignee are the request", function* () {
    const state = store();
    const absent = yield* provider(state).observe(REQUEST);
    expect(absent.ok && absent.value.state).toBe("absent");

    const performed = yield* provider(state).perform(
      REQUEST,
      absent.ok ? absent.value : { state: "absent", preState: issuePreStateJson({ issue: null }) },
    );
    expect(performed.ok).toBe(true);
    expect(issueCreations(state)).toBe(1);

    const [created] = state.issues;
    expect(created?.title).toBe(INPUTS.title);
    expect(created?.labels).toEqual(["publish", "reliability"]);
    expect(created?.assignee).toBeNull();
    // The description verbatim, and the marker after it rather than inside it.
    expect(created?.body).toContain(INPUTS.description);
    expect(created?.body).toContain(MARKER);
  });

  it("sends one assignee when the request names one", function* () {
    const state = store();
    const request = { ...REQUEST, inputs: issueInputsJson({ ...INPUTS, assignee: "octocat" }) };
    const absent = yield* provider(state).observe(request);
    yield* provider(state).perform(
      request,
      absent.ok ? absent.value : { state: "absent", preState: issuePreStateJson({ issue: null }) },
    );
    expect(state.issues[0]?.assignee).toBe("octocat");
  });

  it("updates every field it owns once, then observes exactly once", function* () {
    const state = store([held({ title: "Stale", labels: ["stale"], assignee: "someone" })]);
    const observed = yield* provider(state).observe(REQUEST);
    expect(observed.ok && observed.value.state).toBe("absent");
    state.requests.length = 0;

    const performed = yield* provider(state).perform(
      REQUEST,
      observed.ok
        ? observed.value
        : { state: "absent", preState: issuePreStateJson({ issue: null }) },
    );

    expect(performed.ok).toBe(true);
    expect(issuePatches(state)).toBe(1);
    expect(issueCreations(state)).toBe(0);
    expect(issueCalls(state)).toEqual([
      "PATCH /repos/octo/project/issues/1",
      "GET /repos/octo/project/issues/1",
    ]);
    expect(state.issues[0]?.title).toBe(INPUTS.title);
    expect(state.issues[0]?.labels).toEqual(["publish", "reliability"]);
    expect(state.issues[0]?.assignee).toBeNull();
  });

  it("reports a rejected creation without creating a second issue", function* () {
    const state = store();
    state.fault = { on: "issue-create", status: 422 };
    const performed = yield* provider(state).perform(REQUEST, {
      state: "absent",
      preState: issuePreStateJson({ issue: null }),
    });
    expect(performed.ok).toBe(false);
    expect(state.issues).toHaveLength(0);
  });

  it("adopts an issue a rejected creation had already filed", function* () {
    const state = store();
    // The state an interrupted creation leaves: the issue exists, and this end
    // never learned that it does.
    state.fault = { on: "issue-create", status: 500, afterEffect: true };
    const performed = yield* provider(state).perform(REQUEST, {
      state: "absent",
      preState: issuePreStateJson({ issue: null }),
    });
    expect(performed.ok).toBe(true);
    expect(state.issues).toHaveLength(1);
    expect(issueCreations(state)).toBe(1);
  });
});

describe("workflow GitHub issue payloads", () => {
  const PAYLOAD = {
    node_id: "I_node_1",
    number: 1,
    html_url: "https://github.com/octo/project/issues/1",
    state: "open",
    title: INPUTS.title,
    body: BODY,
    repository_url: `${ENDPOINT}/repos/octo/project`,
    labels: [{ name: "reliability" }, { name: "publish" }],
    assignees: [{ login: "octocat" }],
  };

  it("reads the facts an issue answer has to carry, and normalizes them", function* () {
    expect(readGitHubIssue(PAYLOAD)).toEqual({
      state: "open",
      providerId: "I_node_1",
      number: 1,
      url: "https://github.com/octo/project/issues/1",
      title: INPUTS.title,
      body: BODY,
      tags: ["publish", "reliability"],
      assignee: "octocat",
      repository: `${ENDPOINT}/repos/octo/project`,
      pullRequest: false,
    });
    expect(readGitHubIssue({ ...PAYLOAD, body: null })?.body).toBe("");
    expect(readGitHubIssue({ ...PAYLOAD, assignees: [] })?.assignee).toBeNull();
    expect(readGitHubIssue({ ...PAYLOAD, pull_request: { url: "…" } })?.pullRequest).toBe(true);
  });

  it("reads no issue out of an answer missing or contradicting one", function* () {
    for (const damage of [
      { node_id: "" },
      { number: 0 },
      { html_url: "" },
      { state: "merged" },
      { title: "" },
      { body: 1 },
      { repository_url: "" },
      { labels: "reliability" },
      { labels: [{ name: "" }] },
      { assignees: "octocat" },
      // Two assignees is a state this primitive cannot express, and reading the
      // first would report an issue as agreeing when it does not.
      { assignees: [{ login: "one" }, { login: "two" }] },
    ]) {
      expect(readGitHubIssue({ ...PAYLOAD, ...damage })).toBeUndefined();
    }
  });

  it("round-trips a snapshot through the durable shape", function* () {
    const reading = readGitHubIssue(PAYLOAD);
    expect(reading).toBeDefined();
    const snapshot = {
      providerId: "I_node_1",
      url: "https://github.com/octo/project/issues/1",
      state: "open" as const,
      title: INPUTS.title,
      description: INPUTS.description,
      tags: ["publish", "reliability"],
      assignee: "octocat",
    };
    expect(issueSnapshotJson(snapshot)).toEqual({ ...snapshot, tags: [...snapshot.tags] });
    expect(Ok(snapshot).ok).toBe(true);
  });
});
