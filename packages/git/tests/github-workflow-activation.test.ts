/**
 * The real host assembly, with every outward boundary refusing.
 *
 * The companion to `github-activation.test.ts`. What is here drives the
 * assemblies a command actually installs — the ordinary-run profile, and a
 * retained source-bundle run through the Workflow host — rather than the
 * adapters on their own. Both reach Workflow's storage adapter and so
 * `node:sqlite`, which Bun does not have and Node keeps behind a flag, so this
 * file is Deno's alone and the portable ordering cases stay next door.
 *
 * Installing any of it must read no variable, obtain no credential and open no
 * socket. The boundaries here therefore *throw* rather than count: a crossing
 * fails where it happens.
 *
 * Syntax and Plan are the CLI's own surfaces and are exercised for real in
 * `packages/cli/tests/github-zero-effect.test.ts`, which renders the catalog
 * and describes the Plan component under the same refusing boundary.
 */

import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { API, useHostFiles } from "@executablemd/runtime";
import { useRunComposition } from "../src/deno/run-composition/provider.ts";
import { gitPlugin } from "../src/plugin.ts";
import { collect, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { InMemoryStream } from "@executablemd/durable-streams";
import { useTempDirectory } from "@executablemd/test-support/temp";
import {
  gitHubSource,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubSource,
} from "../src/deno/composition/github.ts";
import {
  runOrdinaryDocument,
  raised,
  rewritingHost,
  useNamedOriginCheckout,
} from "./support/run-composition.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { dropRootClose, REMOTE } from "./support/replay.ts";
import { runWorkflowDocument } from "./support/composition.ts";
import {
  BUNDLE_SOURCE,
  createRun,
  runPath,
  withStorage,
  sourceBundleCreation,
  useStorageRoot,
  withExecutorRun,
  withRunHost,
} from "../../workflow/tests/support/storage.ts";
import { journalBeforeEach, useJournalStream } from "@executablemd/test-support/failure-journal";

const OWNER = "packages/git/tests/github-workflow-activation.test.ts";

/** A transport factory that refuses to be built at all. */
function forbidden(): GitHubSource {
  throw new Error("a GitHub transport was built");
}

/** A host whose configuration boundary refuses to be read. */
function* refusing(): Operation<void> {
  yield* API.Env.around(
    {
      *env([name], next): Operation<string | undefined> {
        if (name.startsWith("XMD_WORKFLOW_GITHUB")) {
          throw new Error(`configuration was read: ${name}`);
        }
        return yield* next(name);
      },
    },
    { at: "min" },
  );
}

/** One document, executed with the bundled Plugin installed and nothing else. */
function* document(stream: InMemoryStream | undefined, source: string): Operation<unknown> {
  const install = gitPlugin.install;
  if (install === undefined) {
    throw new Error("the Git Plugin installed nothing");
  }
  const contribution = yield* install.call(gitPlugin, { command: "run", args: ["run"] });
  return yield* collect(
    yield* executeInstalled(
      { ...inlineSource(source), stream: stream ?? (yield* useJournalStream("<eval>")) },
      [{ admissions: [...(contribution?.admissions ?? [])] }],
    ),
  );
}

describe("the bundled profile, assembled", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("installs the whole ordinary-run profile without reading any of it", function* () {
    // The real assembly this time, not the adapters alone: `useRunComposition`
    // is what `xmd run` installs, and it brings the repository provider, the
    // Git capability, both GitHub adapters and the retained lifecycles with it.
    // Every outward boundary refuses, so installing any of them wrongly is a
    // failure here rather than a count checked afterwards.
    const rendered = yield* scoped(function* () {
      yield* refusing();
      yield* useRunComposition({
        root: yield* useTempDirectory("xmd-zero-root"),
        cwd: yield* useTempDirectory("xmd-zero-cwd"),
        gitHubIssues: { host: forbidden },
        gitHubPullRequests: { host: forbidden },
      });
      return yield* document(undefined, "a plain document that reaches nothing\n");
    });
    expect(String(rendered)).toContain("a plain document that reaches nothing");
  });

  it("does local Git work without reading any GitHub configuration", function* () {
    // `<Dir>` is Git's own and reaches no service. A profile that read GitHub
    // configuration to do local work would be reading it for every run.
    const rendered = yield* scoped(function* () {
      yield* refusing();
      yield* useHostFiles();
      yield* useRunComposition({
        root: yield* useTempDirectory("xmd-zero-root"),
        cwd: yield* useTempDirectory("xmd-zero"),
        gitHubIssues: { host: forbidden },
        gitHubPullRequests: { host: forbidden },
      });
      return yield* document(undefined, '<Dir path="notes">local work only</Dir>\n');
    });
    expect(String(rendered)).toContain("local work only");
  });

  it("runs a version-2 source-bundle workflow outside Git without reaching GitHub", function* () {
    // The real lifecycle, not a test-shaped run: a source-bundle creation
    // begun through the same transitions `xmd workflow start` uses, so what
    // executes below is a retained version-2 definition rather than a v1 Git
    // run that happens to render.
    const root = yield* useStorageRoot();
    yield* withRunHost(root, function* (transitions) {
      const creation = yield* sourceBundleCreation();
      return yield* withExecutorRun(
        transitions,
        { runId: "outside-git", action: "start", creation },
        function* (begun) {
          // Pinned so this cannot regress to a v1 run silently. A v1 record
          // would render the same and prove nothing about the bundle path.

          const rendered = yield* scoped(function* () {
            yield* refusing();
            return yield* runWorkflowDocument(begun.database, BUNDLE_SOURCE, {
              gitHubIssues: { host: forbidden },
              gitHubPullRequests: { host: forbidden },
            });
          });

          expect(String(rendered)).toContain("this run retains these exact bytes");
          // The run really executed: a document that never ran would render
          // nothing and satisfy every refusal above by doing nothing at all.
          expect(yield* begun.database.journal.readAll()).not.toEqual([]);
        },
      );
    });
  });
});

const REPOSITORY = "https://github.com/octo/project";
const ENDPOINT = "https://api.github.com";
const QUERY = 'is:pr is:open label:"help wanted"';
const ITEM = {
  html_url: `${REPOSITORY}/pull/7`,
  repository_url: `${ENDPOINT}/repos/octo/project`,
  closed_at: null,
  pull_request: { merged_at: null },
  future_field: { values: [null, { source_id: 43 }] },
};
const FIRST_PAGE = {
  total_count: 2,
  incomplete_results: false,
  search_type: "hybrid",
  items: [ITEM],
};

function searchProvider(
  allowed = [REPOSITORY],
  answer?: () => GitHubHttpResponse,
  token: () => string | undefined = () => "private-test-token",
) {
  const requests: GitHubHttpRequest[] = [];
  const credentials: string[] = [];
  const access = gitHubSource({
    endpoint: ENDPOINT,
    // deno-lint-ignore require-yield
    *token() {
      credentials.push("token");
      return token();
    },
    // deno-lint-ignore require-yield
    *send(request) {
      requests.push(request);
      if (answer !== undefined) {
        return answer();
      }
      const url = new URL(request.url);
      if (url.pathname === "/repos/octo/project/pulls/7/reviews") {
        return { status: 200, body: "[]" };
      }
      const args = url.searchParams;
      const page = args.get("page");
      const beyond = page === "10";
      return {
        status: 200,
        body: JSON.stringify(
          page === "1"
            ? FIRST_PAGE
            : {
                total_count: beyond ? 1500 : 2,
                incomplete_results: true,
                items: [],
              },
        ),
        ...(page === "2"
          ? {}
          : {
              link: `<${ENDPOINT}/search/issues?page=${beyond ? 11 : 2}>; rel="next"`,
            }),
      };
    },
  });
  return { requests, credentials, options: { access, configuration: { allowed } } };
}

describe("GitHub repository search", () => {
  beforeEach(journalBeforeEach(OWNER));

  it("runs the search and Query example with the original page as its input", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useNamedOriginCheckout(remote, REPOSITORY);
    const root = yield* useTempDirectory("github-search");
    const page = { ...FIRST_PAGE, total_count: 1 };
    const provider = searchProvider([REPOSITORY], () => ({
      status: 200,
      body: JSON.stringify(page),
    }));
    const output = yield* runOrdinaryDocument(
      [
        '<GitHub.Search query="is:pr is:open label:bug" sort="created" perPage={20} as="page" />',
        '<Query value={page} yq="[.items[].html_url]" as="pullRequestUrls" />',
        "<Json value={{ page, pullRequestUrls }} />",
      ].join("\n"),
      { cwd: checkout.root, root, gitHubPullRequests: provider.options },
    );
    expect(JSON.parse(String(output))).toEqual({ page, pullRequestUrls: [ITEM.html_url] });
    expect(provider.requests).toHaveLength(1);
  });

  it("binds original pages, projects URLs and exposes only reusable continuation arguments", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useNamedOriginCheckout(remote, REPOSITORY);
    const root = yield* useTempDirectory("github-search");
    const provider = searchProvider();
    const output = yield* runOrdinaryDocument(
      [
        `<GitHub.Search query={${JSON.stringify(QUERY)}} sort="created" perPage={1} as="first" nextAs="next" />`,
        '<Query value={first} yq="[.items[].html_url]" as="urls" />',
        '<PullRequest.Reviews url={urls[0]} as="reviews" />',
        '<GitHub.Search query={next.query} sort={next.sort} order={next.order} page={next.page} perPage={next.perPage} as="second" nextAs="after" />',
        '<GitHub.Search query="is:issue" page={10} perPage={100} as="ceiling" nextAs="beyond" />',
        "",
        "<Json value={{ first, next, second, after, ceiling, beyond, urls, reviews }} />",
      ].join("\n"),
      {
        cwd: checkout.root,
        root,
        gitHubPullRequests: provider.options,
      },
    );
    expect(JSON.parse(String(output))).toEqual({
      first: FIRST_PAGE,
      next: { query: QUERY, sort: "created", order: "desc", page: 2, perPage: 1 },
      second: { total_count: 2, incomplete_results: true, items: [] },
      after: null,
      ceiling: { total_count: 1500, incomplete_results: true, items: [] },
      beyond: null,
      urls: [ITEM.html_url],
      reviews: [],
    });
    const requests = provider.requests.map(({ url }) => new URL(url));
    expect(requests.map((url) => url.pathname)).toEqual([
      "/search/issues",
      "/repos/octo/project/pulls/7/reviews",
      "/search/issues",
      "/search/issues",
    ]);
    expect(Object.fromEntries(requests[0]?.searchParams ?? [])).toEqual({
      q: `repo:octo/project ${QUERY}`,
      page: "1",
      per_page: "1",
      sort: "created",
      order: "desc",
    });
    expect(requests[2]?.searchParams.get("page")).toBe("2");
  });

  it("refuses invalid arguments and unauthorized repository contexts before credentials", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useNamedOriginCheckout(remote, REPOSITORY);
    const local = yield* useNamedOriginCheckout(remote, "https://example.com/octo/project");
    const root = yield* useTempDirectory("github-search");
    const provider = searchProvider(["https://github.com/octo/other"]);
    const outside = yield* useTempDirectory("github-search-outside");
    for (const [cwd, invocation, diagnostic] of [
      [checkout.root, 'query="is:pr org:other"', "scope qualifiers"],
      [checkout.root, 'query="is:pr -RePo:other/project"', "scope qualifiers"],
      [checkout.root, 'query="is:pr user:other"', "scope qualifiers"],
      [checkout.root, 'query="is:issue is:pr"', "exactly one kind"],
      [checkout.root, 'query="is:open"', "exactly one kind"],
      [checkout.root, 'query="is:pr" page={11} perPage={100}', "first 1,000"],
      [checkout.root, 'query="is:pr" nextAs="page"', "Duplicate result binding"],
      [checkout.root, 'query="is:pr" nextAs="class"', "valid JavaScript binding name"],
      [checkout.root, 'query="is:pr"', "has not authorized"],
      [local.root, 'query="is:pr"', "does not name a GitHub repository"],
      [outside, 'query="is:pr"', "repository"],
    ]) {
      const error = yield* raised(
        runOrdinaryDocument(`<GitHub.Search ${invocation} as="page" />`, {
          cwd: cwd ?? outside,
          root,
          gitHubPullRequests: provider.options,
        }),
      );
      expect(String(error)).toContain(diagnostic ?? "");
    }
    expect(provider.credentials).toEqual([]);
    expect(provider.requests).toEqual([]);
  });

  it("defaults to best match and reads a fresh page on another ordinary run", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useNamedOriginCheckout(remote, REPOSITORY);
    const root = yield* useTempDirectory("github-search");
    let count = 0;
    const provider = searchProvider([REPOSITORY], () => ({
      status: 200,
      body: JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [{ ...ITEM, title: `observation ${++count}` }],
      }),
    }));
    const doc = '<GitHub.Search query="is:pr" as="page" />\n<Json value={page} />';
    const options = { cwd: checkout.root, root, gitHubPullRequests: provider.options };
    const first = yield* runOrdinaryDocument(doc, options);
    const second = yield* runOrdinaryDocument(doc, options);
    expect(String(first)).toContain("observation 1");
    expect(String(second)).toContain("observation 2");
    expect(provider.credentials).toEqual(["token", "token"]);
    expect(
      provider.requests.map(({ url }) => Object.fromEntries(new URL(url).searchParams)),
    ).toEqual([
      { q: "repo:octo/project is:pr", page: "1", per_page: "20" },
      { q: "repo:octo/project is:pr", page: "1", per_page: "20" },
    ]);
  });

  it("refuses missing credentials, provider errors, malformed pages and another repository's items", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useNamedOriginCheckout(remote, REPOSITORY);
    const root = yield* useTempDirectory("github-search");
    const doc = '<GitHub.Search query="is:pr" as="page" />';
    const unavailable = searchProvider([REPOSITORY], undefined, () => undefined);
    const error = yield* raised(
      runOrdinaryDocument(doc, {
        cwd: checkout.root,
        root,
        gitHubPullRequests: unavailable.options,
      }),
    );
    expect(String(error)).toContain("requires a credential");
    expect(unavailable.requests).toHaveLength(0);

    for (const [response, diagnostic] of [
      [{ status: 429, body: "private-provider-detail" }, "did not return a search page"],
      [{ status: 200, body: "{}" }, "invalid search page"],
      [
        {
          status: 200,
          body: JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [{ ...ITEM, repository_url: `${ENDPOINT}/repos/octo/other` }],
          }),
        },
        "invalid search page",
      ],
    ] satisfies [GitHubHttpResponse, string][]) {
      const provider = searchProvider([REPOSITORY], () => response);
      const failure = yield* raised(
        runOrdinaryDocument(doc, {
          cwd: checkout.root,
          root,
          gitHubPullRequests: provider.options,
        }),
      );
      expect(String(failure)).toContain(diagnostic);
      expect(String(failure)).not.toContain("private-provider-detail");
      expect(provider.requests).toHaveLength(1);
    }
  });

  it("restores a completed search during partial workflow replay without a new credential", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useStorageRoot();
    const provider = searchProvider();
    const source = [
      `<Repository name="search" url="${REPOSITORY}">`,
      '<GitHub.Search query="is:pr" perPage={1} as="page" nextAs="next" />',
      "",
      "<Json value={{ page, next }} />",
      "</Repository>",
    ].join("\n");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const options = {
        composition: { host: rewritingHost(REPOSITORY, remote.locator) },
        gitHubPullRequests: provider.options,
      };
      const first = yield* runWorkflowDocument(database, source, options);
      expect(String(first)).toContain('"future_field"');
      expect(provider.requests).toHaveLength(1);
      dropRootClose(runPath(root, "release-1.4"));
      expect(yield* runWorkflowDocument(database, source, options)).toEqual(first);
      expect(provider.credentials).toEqual(["token"]);
      expect(provider.requests).toHaveLength(1);
      const journal = JSON.stringify(yield* database.journal.readAll());
      expect(journal).not.toContain("private-test-token");
      expect(journal).not.toContain(`${ENDPOINT}/search/issues?page=2`);
    });
  });
});
