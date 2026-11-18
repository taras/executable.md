/**
 * Tier PAF — the authored `<PullRequest>` forms (specs/workflow-workspace-spec.md §7.5).
 *
 * A self-closing element reads a pull request by URL; a paired element writes one.
 * These drive the real component through a real workflow run and the shared GitHub
 * model, so every request the adapter sends is recorded by the host double. A read
 * is held to zero mutations and one exact lookup, and a refusal to zero requests.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, type Operation } from "effection";
import { Component, getExpansion, hasContent, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { PullRequestAPI } from "@executablemd/git/api";
import type { GitWorkspaceOptions } from "../src/deno/attachment.ts";
import { PullRequestContentError, PullRequestReadError } from "../src/composition/errors.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import { createRun, useStorageRoot, withStorage } from "../../workflow/tests/support/storage.ts";
import type { WorkflowRunDatabase } from "../../workflow/src/storage/api.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { causedBy, raised, runWorkflowDocument } from "./support/composition.ts";
import { creations, fakeGitHubAccess, gitHubStore, mutations } from "./support/github.ts";
import type { GitHubStore, StoredPullRequest } from "./support/github.ts";
import {
  BRANCH,
  fixture,
  published,
  REMOTE,
  stored,
  TITLE,
  TOKEN,
} from "./support/pull-requests.ts";

const URL_1 = "https://github.com/octo/project/pull/1";
const URL_2 = "https://github.com/octo/project/pull/2";
const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);

/** Indentation, trailing spaces, blank lines and non-ASCII text, verbatim. */
const DESCRIPTION = "  Indented line  \n\n\tTabbed é \u{1F680} done\n\n";

/** More code points than two pages, with an astral character ending the first page. */
const LONG = `${"x".repeat(4095)}\u{1F600}${"y".repeat(9000)}`;

interface Page {
  readonly value: unknown;
  readonly next: string | null;
  readonly prev: string | null;
  readonly last: string | null;
}

/** The read options a deployment allows for this GitHub: the octo owner only. */
function readOptions(store: GitHubStore): GitWorkspaceOptions {
  return {
    gitHubPullRequests: {
      access: gitHubSource(fakeGitHubAccess(store)),
      configuration: { allowed: ["https://github.com/octo"] },
    },
  };
}

/** A GitHub that holds these pull requests, and nothing else. */
function githubWith(...pullRequests: StoredPullRequest[]): GitHubStore {
  return gitHubStore({ pullRequests, token: TOKEN });
}

/** The pull request the first fixture holds, with fully specified commits. */
function openPullRequest(overrides: Partial<StoredPullRequest> = {}): StoredPullRequest {
  return stored({
    body: DESCRIPTION,
    headRef: BRANCH,
    headSha: HEAD,
    baseSha: BASE,
    ...overrides,
  });
}

/** The read URL's request count, and every lookup of one pull request number. */
function lookups(store: GitHubStore, number: number): number {
  return store.requests.filter(
    (request) =>
      request.method === "GET" &&
      new URL(request.url).pathname === `/repos/octo/project/pulls/${number}`,
  ).length;
}

/**
 * Run one document in a storage root of its own.
 *
 * A run's identity is fixed by its request, so two runs under one root are one
 * run: the second would replay the first's answers instead of asking afresh.
 */
function* inOwnRun<T>(body: (database: WorkflowRunDatabase) => Operation<T>): Operation<T> {
  const root = yield* useStorageRoot();
  return yield* withStorage(root, function* () {
    return yield* body(yield* createRun());
  });
}

/** Render one document, as the text it produces. */
function* renderText(store: GitHubStore, source: string): Operation<string> {
  return yield* inOwnRun(function* (database) {
    return String(yield* runWorkflowDocument(database, source, readOptions(store)));
  });
}

/** What one document renders, parsed as the JSON it is. */
function* renderJson(store: GitHubStore, source: string): Operation<unknown> {
  return JSON.parse(yield* renderText(store, source));
}

/** The page one document renders without `as`. */
function* renderPage(store: GitHubStore, source: string): Operation<Page> {
  return JSON.parse(yield* renderText(store, source));
}

/** The refusal one document ends with, which must be raised rather than rendered. */
function* refusalOf(store: GitHubStore, source: string): Operation<unknown> {
  return yield* inOwnRun(function* (database) {
    return yield* raised(runWorkflowDocument(database, source, readOptions(store)));
  });
}

function isContentError(value: unknown): value is PullRequestContentError {
  return value instanceof PullRequestContentError;
}

function isReadError(value: unknown): value is PullRequestReadError {
  return value instanceof PullRequestReadError;
}

describe("PullRequest authored read", () => {
  it("binds the complete record and changes nothing at GitHub", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const store = githubWith(openPullRequest());
      const before = JSON.stringify(store.pullRequests);

      const page = yield* renderPage(store, `<PullRequest url="${URL_1}" />`);

      expect(page).toEqual({
        value: {
          providerId: "PR_node_1",
          number: 1,
          url: URL_1,
          state: "open",
          title: TITLE,
          body: DESCRIPTION,
          draft: false,
          headBranch: BRANCH,
          headSha: HEAD,
          headRepository: "octo/project",
          baseBranch: "main",
          baseSha: BASE,
          baseRepository: "octo/project",
        },
        next: null,
        prev: null,
        last: null,
      });
      expect(lookups(store, 1)).toBe(1);
      expect(mutations(store)).toEqual([]);
      expect(creations(store)).toBe(0);
      expect(JSON.stringify(store.pullRequests)).toBe(before);
    });
  });

  it("binds without rendering, and selects by yq", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const store = githubWith(openPullRequest());

      const bound = yield* renderText(store, `<PullRequest url="${URL_1}" as="pr" />`);
      expect(bound.trim()).toBe("");

      const description = yield* renderJson(
        store,
        `<PullRequest url="${URL_1}" yq=".body" as="description" />\n` +
          `<Query value={description} yq=".value" />`,
      );
      expect(description).toBe(DESCRIPTION);

      const details = yield* renderJson(
        store,
        `<PullRequest url="${URL_1}" yq='pick(["title", "body", "state", "headSha", "baseSha"])' as="details" />\n` +
          `<Query value={details} yq=".value" />`,
      );
      expect(details).toEqual({
        title: TITLE,
        body: DESCRIPTION,
        state: "open",
        headSha: HEAD,
        baseSha: BASE,
      });
    });
  });

  it("renders the page as JSON without as, with the value JSON-quoted", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const store = githubWith(openPullRequest({ state: "closed" }));

      const selected = yield* renderPage(store, `<PullRequest url="${URL_1}" yq=".draft" />`);
      expect(selected.value).toBe(false);
      const nothing = yield* renderPage(store, `<PullRequest url="${URL_1}" yq="null" />`);
      expect(nothing.value).toBeNull();
      const closed = yield* renderPage(store, `<PullRequest url="${URL_1}" yq=".state" />`);
      expect(closed.value).toBe("closed");
    });
  });

  it("reads a fork head through the read-only admission", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const store = githubWith(openPullRequest({ headRepository: "fork-owner/project" }));

      const page = yield* renderPage(store, `<PullRequest url="${URL_1}" yq=".headRepository" />`);
      expect(page.value).toBe("fork-owner/project");
    });
  });

  it("pages a long description so that following navigation reconstructs it", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const store = githubWith(openPullRequest({ body: LONG }));

      const pages: Page[] = [];
      let source = `<PullRequest url="${URL_1}" yq=".body" />`;
      for (let index = 0; index < 8; index += 1) {
        const page = yield* renderPage(store, source);
        pages.push(page);
        if (page.next === null) {
          break;
        }
        source = `<PullRequest url="${URL_1}" yq={${JSON.stringify(page.next)}} />`;
      }

      // Four pages: 4096 code points each, with the astral character ending the first.
      expect(pages).toHaveLength(4);
      expect(pages[0]?.prev).toBeNull();
      expect(pages[0]?.last).not.toBeNull();
      expect([...(pages[0]?.value as string)]).toHaveLength(4096);
      expect([...(pages[0]?.value as string)].at(-1)).toBe("\u{1F600}");
      expect(pages[1]?.prev).not.toBeNull();
      expect(pages[1]?.value).toBe("y".repeat(4096));
      expect(pages.at(-1)?.value).toBe("y".repeat(808));
      expect(pages.map((page) => page.value).join("")).toBe(LONG);
    });
  });

  it("pages an array by twenty items and carries an explicit byte budget", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const store = githubWith(openPullRequest({ body: LONG }));

      const lines = Array.from({ length: 25 }, (_, index) => `line ${index}`);
      const lined = githubWith(openPullRequest({ body: lines.join("\n") }));
      const selection = `[.body | split("\\n")[]]`;
      const first = yield* renderPage(lined, `<PullRequest url="${URL_1}" yq='${selection}' />`);
      expect(first.value).toEqual(lines.slice(0, 20));
      expect(first.next).not.toBeNull();
      const second = yield* renderPage(
        lined,
        `<PullRequest url="${URL_1}" yq={${JSON.stringify(first.next)}} />`,
      );
      expect(second.value).toEqual(lines.slice(20));
      expect(second.next).toBeNull();

      // The budget counts the serialized page, navigation included, and travels with it.
      const budgeted = yield* renderPage(
        store,
        `<PullRequest url="${URL_1}" yq=".body" maxBytes={2000} />`,
      );
      const size = (page: Page) => new TextEncoder().encode(JSON.stringify(page)).length;
      expect(size(budgeted)).toBeLessThanOrEqual(2000);
      expect(budgeted.next).not.toBeNull();
      const carried = yield* renderPage(
        store,
        `<PullRequest url="${URL_1}" yq={${JSON.stringify(budgeted.next)}} />`,
      );
      expect(size(carried)).toBeLessThanOrEqual(2000);
    });
  });

  it("replays a completed read from its retained record without asking GitHub again", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const store = githubWith(openPullRequest({ body: DESCRIPTION }));
      const source = `<PullRequest url="${URL_1}" yq=".body" />`;

      // Two runs under one root are one run, so the second restores what the first retained.
      const first = String(
        yield* runWorkflowDocument(yield* createRun(), source, readOptions(store)),
      );
      const asked = store.requests.length;
      store.pullRequests[0] = openPullRequest({ body: "changed upstream" });

      const replayed = String(
        yield* runWorkflowDocument(yield* createRun(), source, readOptions(store)),
      );
      expect(store.requests).toHaveLength(asked);
      expect(replayed).toBe(first);
      expect(JSON.parse(replayed).value).toBe(DESCRIPTION);
    });
  });

  it("refuses an unfit selection and a stale continuation", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const store = githubWith(
        openPullRequest({ body: LONG }),
        openPullRequest({
          number: 2,
          nodeId: "PR_node_2",
        }),
      );

      const first = yield* renderPage(store, `<PullRequest url="${URL_1}" yq=".body" />`);

      // The same continuation against another pull request is not this record's page.
      const other = yield* refusalOf(
        store,
        `<PullRequest url="${URL_2}" yq={${JSON.stringify(first.next)}} />`,
      );
      expect(causedBy(other, isReadError)?.reason).toBe("stale-continuation");

      // A body edit that leaves the head commit alone still makes the continuation stale.
      store.pullRequests[0] = { ...openPullRequest({ body: `${LONG}!` }), number: 1 };
      const edited = yield* refusalOf(
        store,
        `<PullRequest url="${URL_1}" yq={${JSON.stringify(first.next)}} />`,
      );
      expect(causedBy(edited, isReadError)?.reason).toBe("stale-continuation");

      // A whole object that cannot fit the budget refuses rather than paging a fragment.
      const unfit = yield* refusalOf(store, `<PullRequest url="${URL_1}" maxBytes={50} />`);
      expect(causedBy(unfit, isReadError)?.reason).toBe("invalid-query");

      // Several values, and no value, are both refusals rather than a fallback.
      for (const yq of [".title, .body", "empty"]) {
        const refused = yield* refusalOf(
          store,
          `<PullRequest url="${URL_1}" yq=${JSON.stringify(yq)} />`,
        );
        expect(causedBy(refused, isReadError)?.reason).toBe("invalid-query");
      }
    });
  });

  it("binds nothing from a record about another repository, or a malformed one", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      // A durable read's failure is retained and re-raised as the message it carried, so the
      // witness is the protocol sentence rather than the class.
      const elsewhere = githubWith(openPullRequest({ baseRepository: "other/project" }));
      const wrongSubject = yield* refusalOf(elsewhere, `<PullRequest url="${URL_1}" />`);
      expect(String(wrongSubject)).toContain("answered about a different subject");

      const otherHost = githubWith(
        openPullRequest({ payload: { html_url: "https://elsewhere.test/octo/project/pull/1" } }),
      );
      const wrongHost = yield* refusalOf(otherHost, `<PullRequest url="${URL_1}" />`);
      expect(String(wrongHost)).toContain("answered about a different subject");

      const malformed = githubWith(openPullRequest({ payload: { title: 5 } }));
      const broken = yield* refusalOf(malformed, `<PullRequest url="${URL_1}" />`);
      expect(String(broken)).toContain("outside the evidence contract");
    });
  });

  it("refuses a normalized details record with an empty title", function* () {
    const store = githubWith(openPullRequest());
    yield* PullRequestAPI.around({
      *read(args, next) {
        const read = yield* next(...args);
        if (read.kind === "details") {
          return { ...read, details: { ...read.details, title: "" } };
        }
        return read;
      },
    });
    const failure = yield* refusalOf(store, `<PullRequest url="${URL_1}" as="pr" />`);
    expect(causedBy(failure, isReadError)?.reason).toBe("protocol");
    expect(lookups(store, 1)).toBe(1);
  });

  it("publishes the read and write forms through Syntax", function* () {
    const store = githubWith();
    const syntax = yield* renderText(store, '<Syntax names={["PullRequest"]} />\n\n<Syntax />');
    expect(syntax).toContain("**Forms:** `<PullRequest />`, `<PullRequest>…</PullRequest>`");
    for (const prop of ["url", "provider", "yq", "maxBytes", "number", "title", "base", "draft"]) {
      expect(syntax).toContain(`| \`${prop}\` |`);
    }
    expect(syntax).toContain(
      "Optional for a read: binds value, next, prev and last instead of rendering JSON.",
    );
    expect(syntax).toContain("Required for a paired write: binds its settled PR identity.");
    expect(syntax).not.toContain("PullRequest.Snapshot");
    expect(syntax).not.toContain("PullRequest.Details");
    expect(store.requests).toEqual([]);
  });

  it("refuses an invalid read before any GitHub request", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const cases: [string, (candidate: unknown) => candidate is Error][] = [
        ["<PullRequest />", isContentError],
        ['<PullRequest title="t" />', isContentError],
        [`<PullRequest url="${URL_1}" draft={false} />`, isContentError],
        [`<PullRequest url="${URL_1}" title="t">body</PullRequest>`, isContentError],
        [`<PullRequest title="t">body</PullRequest>`, isContentError],
        [`<PullRequest url="${URL_1}" provider="github"></PullRequest>`, isContentError],
        [`<PullRequest url="${URL_1}" yq=" " as="x" />`, isReadError],
        [`<PullRequest url="${URL_1}?tab=files" />`, isReadError],
      ];
      for (const [source, is] of cases) {
        const store = githubWith(openPullRequest());
        const failure = yield* refusalOf(store, source);
        if (causedBy(failure, is) === undefined) {
          throw new Error(
            `${source} was not refused as expected: ${String(failure).slice(0, 400)}`,
          );
        }
        expect(store.requests).toHaveLength(0);
      }
    });
  });
});

describe("PullRequest authored write", () => {
  it("validates a pair before expanding children, and a valid pair expands even when hasContent denies it", function* () {
    let expanded = 0;
    const contentAnswers: boolean[] = [];
    const child: ComponentRegistration = {
      name: "CountChild",
      origin: "test",
      props: { type: "object", additionalProperties: false },
      *fn(): Operation<string> {
        expanded += 1;
        contentAnswers.push(yield* hasContent());
        return "";
      },
    };
    const register = (run: () => Operation<Json>) =>
      scoped(function* () {
        yield* registerComponents([child]);
        return yield* run();
      });

    const store = githubWith(openPullRequest());
    for (const attributes of [
      'as="pr"',
      'title="Missing binding"',
      `title="Mixed props" as="pr" url="${URL_1}"`,
    ]) {
      yield* inOwnRun(function* (database) {
        const failure = yield* raised(
          runWorkflowDocument(
            database,
            `<PullRequest ${attributes}><CountChild></CountChild></PullRequest>`,
            readOptions(store),
            register,
          ),
        );
        expect(causedBy(failure, isContentError)).toBeDefined();
      });
    }
    expect(expanded).toBe(0);
    expect(store.requests).toEqual([]);

    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);
    yield* inOwnRun(function* (database) {
      yield* runWorkflowDocument(
        database,
        published('<PullRequest title="Valid" as="pr"><CountChild></CountChild></PullRequest>'),
        run.options,
        (execute) =>
          register(function* () {
            yield* Component.around({
              *hasContent(_args, next) {
                const { name } = yield* getExpansion();
                if (name === "PullRequest" || name === "CountChild") {
                  return false;
                }
                return yield* next();
              },
            });
            return yield* execute();
          }),
      );
    });
    expect(expanded).toBe(1);
    expect(contentAnswers).toEqual([false]);
    expect(creations(run.store)).toBe(1);
  });

  it("writes an explicitly empty pair", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = fixture(remote);
      yield* runWorkflowDocument(
        database,
        published(`<PullRequest title="Empty" as="pr"></PullRequest>`),
        run.options,
      );

      expect(creations(run.store)).toBe(1);
      // GitHub stores an empty body as null; what matters is what the write sent.
      const creation = run.store.requests.find(
        (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/pulls"),
      );
      expect(JSON.parse(String(creation?.body))).toMatchObject({ title: "Empty", body: "" });
    });
  });
});
