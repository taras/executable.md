/**
 * Tier WI — `<Issue>` as a document writes it.
 *
 * The claim this suite exists for is that the primitive is portable: the same
 * four props reach GitHub or an Atlassian-shaped tracker, and which one is
 * decided by the nearest lexical context rather than by anything in the
 * element. Everything else here is what stands between a document naming a
 * destination and one being reached — the context that must exist, the URL that
 * must resolve, the discriminator that never falls back, and the host ceiling a
 * context cannot widen.
 *
 * Nothing here reaches a network, and nothing here needs a Repository, a
 * Workspace or SQLite. That is the contract rather than an economy: an issue
 * provider need not own a Git repository, so the primitive that reaches one
 * must not need one either.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { IssueContentError, IssueProviderError, IssueTrackerError } from "../src/issue/errors.ts";
import { parseIssueInputs } from "../src/issue/records.ts";
import {
  atlassianProvider,
  atlassianTracker,
  ATLASSIAN_TARGET,
  causedBy,
  DESCRIPTION,
  document,
  forbiddenProvider,
  gitHub,
  issueYields,
  runIssueDocument,
  store,
  TARGET,
  TITLE,
  TOKEN,
} from "./support/issues.ts";

function isTargetFailure(value: unknown): value is IssueTrackerError {
  return value instanceof IssueTrackerError;
}

function isProviderFailure(value: unknown): value is IssueProviderError {
  return value instanceof IssueProviderError;
}

function isContentFailure(value: unknown): value is IssueContentError {
  return value instanceof IssueContentError;
}

describe("workflow Issue", () => {
  it("creates one issue in the container the nearest context names", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    expect(run.thrown).toBeUndefined();
    const [created] = state.issues;
    expect(created?.title).toBe(TITLE);
    expect(created?.state).toBe("open");
    expect(state.issues).toHaveLength(1);

    // The description is the document's, verbatim, with the marker the adapter
    // needs after it rather than woven through it.
    expect(created?.body).toContain(DESCRIPTION);

    // The binding is the URL, and only the URL.
    expect(String(run.rendered)).toContain("recorded https://github.com/owner/repository/issues/1");
    const [record] = run.records;
    expect(record?.decision).toBe("performed");
    expect(record?.request.provider).toBe("github");
    expect(record?.request.target).toBe(TARGET);
  });

  it("binds exactly a url while the record keeps what a provider owns", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    // What the document can read.
    expect(String(run.rendered)).toContain(
      `recorded ${state.issues[0]?.nodeId === undefined ? "" : "https://github.com/owner/repository/issues/1"}`,
    );

    // What the run retains instead: the destination and the provider's own
    // identity, which are evidence rather than something a document builds on.
    const [record] = run.records;
    expect(Object.keys(Object(record?.result)).sort()).toEqual([
      "provider",
      "providerId",
      "target",
      "url",
    ]);
    expect(Object(record?.result).providerId).toBe(state.issues[0]?.nodeId);
    expect(Object(record?.result).target).toBe(TARGET);
  });

  it("normalizes tags to a set and absence of an assignee to one spelling", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      source: document(TARGET, ` tags={["publish", "reliability", "publish"]}`),
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });

    expect(run.thrown).toBeUndefined();
    // Deduplicated and code-point sorted, in the request and at the provider.
    const [record] = run.records;
    expect(parseIssueInputs(record?.request.inputs)?.tags).toEqual(["publish", "reliability"]);
    expect(parseIssueInputs(record?.request.inputs)?.assignee).toBeNull();
    expect(state.issues[0]?.labels).toEqual(["publish", "reliability"]);
    expect(state.issues[0]?.assignee).toBeNull();
  });

  it("carries an assignee opaquely to the provider that was selected", function* () {
    const state = store();
    yield* runIssueDocument({
      source: document(TARGET, ` assignee="octocat"`),
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });
    expect(state.issues[0]?.assignee).toBe("octocat");
  });

  it("renders nothing of its own", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      source: [
        `<IssueTracker url="${TARGET}">`,
        "before",
        `<Issue title="${TITLE}" description="${DESCRIPTION}" as="issue" />`,
        "after",
        "</IssueTracker>",
      ].join("\n"),
      providers: [{ discriminator: "github", provider: gitHub(state) }],
    });
    const rendered = String(run.rendered);
    expect(rendered).toContain("before");
    expect(rendered).toContain("after");
    expect(rendered).not.toContain(TITLE);
    expect(rendered).not.toContain(DESCRIPTION);
  });

  it("refuses a paired invocation before it resolves, routes or creates anything", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      source: [
        `<IssueTracker url="${TARGET}">`,
        `<Issue title="${TITLE}" description="${DESCRIPTION}" as="issue">`,
        "text nobody would ever see",
        "</Issue>",
        "</IssueTracker>",
        "",
        "later sibling ran",
      ].join("\n"),
      // Reaching this provider at all fails the test, which is the claim: the
      // refusal happens before the destination is resolved and before routing.
      providers: [{ discriminator: "github", provider: forbiddenProvider("github") }],
    });

    expect(causedBy(run.thrown, isContentFailure)).toBeDefined();
    expect(String(run.thrown)).toContain("takes no content");
    // Nothing was created, nothing was journaled, and the work after it stopped.
    expect(state.issues).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
    expect(issueYields(run.events)).toHaveLength(0);
    expect(String(run.rendered ?? "")).not.toContain("later sibling ran");
  });

  it("refuses a paired invocation even where the content renders nothing", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      source: [
        `<IssueTracker url="${TARGET}">`,
        `<Issue title="${TITLE}" description="${DESCRIPTION}" as="issue"></Issue>`,
        "</IssueTracker>",
      ].join("\n"),
      providers: [{ discriminator: "github", provider: forbiddenProvider("github") }],
    });

    // The shape of the invocation, not a prediction about what it renders:
    // `<Issue></Issue>` is paired and `<Issue />` is not.
    expect(causedBy(run.thrown, isContentFailure)).toBeDefined();
    expect(state.issues).toHaveLength(0);
    expect(issueYields(run.events)).toHaveLength(0);
  });

  it("refuses props this primitive does not declare", function* () {
    const state = store();
    for (const attribute of [
      ` repository="octo/project"`,
      ` url="${TARGET}"`,
      ` provider="github"`,
      ` finding="F-17"`,
      ` disposition="defer"`,
      ` milestone="1.4"`,
      ` close={true}`,
    ]) {
      const run = yield* runIssueDocument({
        source: document(TARGET, attribute),
        providers: [{ discriminator: "github", provider: gitHub(state) }],
      });
      expect(String(run.thrown)).toContain("Prop validation failed");
    }
    expect(state.issues).toHaveLength(0);
  });
});

describe("workflow Issue target context", () => {
  it("fails before routing when it is written outside any context", function* () {
    const run = yield* runIssueDocument({
      source: [
        `<Issue title="${TITLE}" description="${DESCRIPTION}" as="issue" />`,
        "",
        "later sibling ran",
      ].join("\n"),
      providers: [{ discriminator: "github", provider: forbiddenProvider("github") }],
    });

    expect(causedBy(run.thrown, isTargetFailure)?.reason).toBe("no-issue-tracker");
    expect(String(run.thrown)).toContain("<IssueTracker");
    expect(String(run.rendered ?? "")).not.toContain("later sibling ran");
    // No effect exists, so nothing was journaled for it either.
    expect(issueYields(run.events)).toHaveLength(0);
  });

  it("fails before routing on a URL that names no container", function* () {
    for (const url of [
      "not a url",
      "ftp://github.com/octo/project",
      `https://${"token"}@github.com/octo/project`,
      "https://github.com/octo/project?tab=readme",
      "https://github.com/octo/project#issues",
    ]) {
      const run = yield* runIssueDocument({
        source: document(url),
        providers: [{ discriminator: "github", provider: forbiddenProvider("github") }],
      });
      expect(causedBy(run.thrown, isTargetFailure)?.reason).toBe("invalid-tracker-url");
      expect(issueYields(run.events)).toHaveLength(0);
    }
  });

  it("replaces the whole target for its descendants and never merges it", function* () {
    const state = store();
    const tracker = atlassianTracker();
    const run = yield* runIssueDocument({
      source: [
        `<IssueTracker url="${TARGET}" provider="github">`,
        `<IssueTracker url="${ATLASSIAN_TARGET}">`,
        `<Issue title="${TITLE}" description="${DESCRIPTION}" as="inner" />`,
        "</IssueTracker>",
        "",
        "inner: {inner.url}",
        "</IssueTracker>",
      ].join("\n"),
      providers: [
        { discriminator: "github", provider: gitHub(state) },
        { discriminator: "atlassian", provider: atlassianProvider(tracker) },
      ],
    });

    // The nested target carried no provider, so the URL resolved one. Had the
    // members merged, the parent's `github` would have selected GitHub for an
    // Atlassian URL — which is the mistake nesting must not be able to make.
    expect(run.thrown).toBeUndefined();
    expect(String(run.rendered)).toContain("inner: https://acme.atlassian.net/browse/PROJ-1");
    expect(tracker.issues.size).toBe(1);
    expect(state.issues).toHaveLength(0);
  });

  it("restores the outer target after a nested one ends", function* () {
    const state = store();
    const tracker = atlassianTracker();
    const run = yield* runIssueDocument({
      source: [
        `<IssueTracker url="${TARGET}">`,
        `<IssueTracker url="${ATLASSIAN_TARGET}">`,
        `<Issue title="${TITLE}" description="${DESCRIPTION}" as="inner" />`,
        "</IssueTracker>",
        `<Issue title="${TITLE}" description="${DESCRIPTION}" as="outer" />`,
        "</IssueTracker>",
        "",
        "outer: {outer.url}",
      ].join("\n"),
      providers: [
        { discriminator: "github", provider: gitHub(state) },
        { discriminator: "atlassian", provider: atlassianProvider(tracker) },
      ],
    });

    expect(run.thrown).toBeUndefined();
    expect(tracker.issues.size).toBe(1);
    expect(state.issues).toHaveLength(1);
    expect(String(run.rendered)).toContain("outer: https://github.com/owner/repository/issues/1");
  });
});

describe("workflow Issue provider resolution", () => {
  it("resolves GitHub and Atlassian Cloud from the canonical URL", function* () {
    const state = store();
    const tracker = atlassianTracker();
    const providers = [
      { discriminator: "github", provider: gitHub(state) },
      { discriminator: "atlassian", provider: atlassianProvider(tracker) },
    ];

    const github = yield* runIssueDocument({ source: document(TARGET), providers });
    expect(github.records[0]?.request.provider).toBe("github");

    const atlassian = yield* runIssueDocument({
      source: document(ATLASSIAN_TARGET),
      providers,
    });
    expect(atlassian.records[0]?.request.provider).toBe("atlassian");

    // Installed together, each received only its own requests.
    expect(state.issues).toHaveLength(1);
    expect(tracker.issues.size).toBe(1);
    expect(tracker.observed.every((request) => request.provider === "atlassian")).toBe(true);
  });

  it("refuses a URL no built-in mapping names a provider for", function* () {
    const run = yield* runIssueDocument({
      source: document("https://tracker.example.invalid/projects/one"),
      providers: [{ discriminator: "github", provider: forbiddenProvider("github") }],
    });
    expect(causedBy(run.thrown, isTargetFailure)?.reason).toBe("unresolved-provider");
    // The refusal names the remedy rather than a guess.
    expect(String(run.thrown)).toContain("provider");
    expect(issueYields(run.events)).toHaveLength(0);
  });

  it("lets an explicit discriminator carry a non-standard URL", function* () {
    const tracker = atlassianTracker(["https://tracker.example.invalid/projects/one"]);
    const run = yield* runIssueDocument({
      source: document("https://tracker.example.invalid/projects/one", "", "atlassian"),
      providers: [
        { discriminator: "github", provider: forbiddenProvider("github") },
        { discriminator: "atlassian", provider: atlassianProvider(tracker) },
      ],
    });

    expect(run.thrown).toBeUndefined();
    expect(tracker.issues.size).toBe(1);
    expect(run.records[0]?.request.provider).toBe("atlassian");
  });

  it("never falls back to another provider when the selected one refuses", function* () {
    const state = store();
    // The discriminator says atlassian; the tracker's ceiling does not hold a
    // GitHub URL, so it refuses. GitHub is installed and would have accepted.
    const tracker = atlassianTracker();
    const run = yield* runIssueDocument({
      source: document(TARGET, "", "atlassian"),
      providers: [
        { discriminator: "github", provider: gitHub(state) },
        { discriminator: "atlassian", provider: atlassianProvider(tracker) },
      ],
    });

    expect(causedBy(run.thrown, isProviderFailure)).toBeDefined();
    expect(state.issues).toHaveLength(0);
    expect(tracker.issues.size).toBe(0);
  });

  it("completes nothing when no provider is registered for the discriminator", function* () {
    const run = yield* runIssueDocument({
      source: document(TARGET, "", "gitlab"),
      providers: [{ discriminator: "github", provider: forbiddenProvider("github") }],
    });

    expect(String(run.thrown)).toContain("executed and published nothing");
    expect(run.records).toHaveLength(0);
  });
});

describe("workflow Issue host ceiling", () => {
  it("fails before external observation for a target outside the ceiling", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      // The context asks for a repository the host never authorized.
      source: document("https://github.com/other/secrets"),
      providers: [{ discriminator: "github", provider: gitHub(state, [TARGET]) }],
    });

    expect(causedBy(run.thrown, isProviderFailure)).toBeDefined();
    // Nothing was sent, and no Issue outcome was recorded for it.
    expect(state.requests).toHaveLength(0);
    expect(run.records).toHaveLength(0);
    // The refusal repeats neither the target nor the credential.
    expect(String(run.thrown)).not.toContain("other/secrets");
    expect(String(run.thrown)).not.toContain(TOKEN);
  });

  it("admits a container beneath one the host authorized", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      source: document(`${TARGET}/issues`),
      providers: [{ discriminator: "github", provider: gitHub(state, [TARGET]) }],
    });

    expect(run.thrown).toBeUndefined();
    expect(state.issues).toHaveLength(1);
  });

  it("does not admit a sibling whose name merely starts the same way", function* () {
    const state = store();
    const run = yield* runIssueDocument({
      source: document("https://github.com/octo/project-two"),
      providers: [{ discriminator: "github", provider: gitHub(state, [TARGET]) }],
    });

    expect(causedBy(run.thrown, isProviderFailure)).toBeDefined();
    expect(state.requests).toHaveLength(0);
  });
});
