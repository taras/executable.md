import { isJsonObject, parseJson } from "@executablemd/core";
import type { JsonObject } from "@executablemd/core";
import type { Operation } from "effection";
import {
  GitHubSearch,
  SEARCH_CEILING,
  SEARCH_ELEMENT,
  type SearchRequest,
  type SearchResult,
} from "../../composition/components/GitHubSearch.ts";
import { PullRequestReadError } from "../../composition/errors.ts";
import { PullRequestReadExecution } from "../../composition/pull-request-read-execution.ts";
import type { RepositorySelection } from "../../composition/selection.ts";
import {
  authorizedHeaders,
  GITHUB_API,
  type GitHubAccess,
  type GitHubHttpResponse,
  type GitHubSource,
  nextPage,
  parseGitHubRepository,
  readJson,
} from "./github.ts";
import {
  gitHubPullRequestReadResolver,
  type GitHubPullRequestsOptions,
  pullRequestAllowed,
} from "./pull-request-reads.ts";

function unavailable(message: string): PullRequestReadError {
  return new PullRequestReadError("unavailable", SEARCH_ELEMENT, message);
}

function invalid(): PullRequestReadError {
  return new PullRequestReadError(
    "protocol",
    SEARCH_ELEMENT,
    "GitHub returned an invalid search page.",
  );
}

export function useGitHubSearch(
  options: GitHubPullRequestsOptions,
  locator: (selection: RepositorySelection) => Operation<string | undefined>,
): Operation<void> {
  const resolved = gitHubPullRequestReadResolver(options);
  return GitHubSearch.around({
    *search([selection, request]): Operation<SearchResult> {
      const origin = yield* locator(selection);
      const repository = origin === undefined ? undefined : parseGitHubRepository(origin);
      if (repository === undefined) {
        throw unavailable("the selected Repository does not name a GitHub repository.");
      }
      const name = `${repository.owner}/${repository.repository}`;
      const url = `https://github.com/${name}`;
      const configuration = yield* resolved.authorized();
      if (!configuration?.allowed || !pullRequestAllowed(configuration.allowed, url)) {
        throw unavailable("this host has not authorized search in the selected Repository.");
      }
      const apiBase = options.access?.endpoint ?? configuration.endpoint ?? GITHUB_API;
      const validate = (value: unknown, page: number) =>
        validateSearchPage(value, request, page, name, apiBase);
      return yield* PullRequestReadExecution.operations.search(
        url,
        request,
        () => readSearch(() => resolved.transport(configuration), name, request, validate),
        (value) => validateSearchResult(value, request, validate),
      );
    },
  });
}

function* readSearch(
  source: () => GitHubSource,
  repository: string,
  request: SearchRequest,
  validate: (value: unknown, page: number) => JsonObject,
): Operation<SearchResult> {
  const parameters = new URLSearchParams({
    q: `repo:${repository} ${request.query}`,
    page: String(request.page),
    per_page: String(request.perPage),
  });
  if (request.sort !== undefined && request.order !== undefined) {
    parameters.set("sort", request.sort);
    parameters.set("order", request.order);
  }

  let access: GitHubAccess;
  let headers: Record<string, string> | undefined;
  try {
    access = yield* source().open();
    headers = yield* authorizedHeaders(access, false);
  } catch {
    throw unavailable("GitHub search could not authenticate or complete the request.");
  }
  if (headers === undefined) {
    throw unavailable("GitHub search requires a credential.");
  }

  const first = new URL(`${access.endpoint}/search/issues?${parameters}`);
  let url = first.href;
  const pages: JsonObject[] = [];
  const last = lastAccessiblePage(request);
  for (let page = request.page; page <= last; page += 1) {
    let response: GitHubHttpResponse;
    try {
      response = yield* access.send({
        method: "GET",
        url,
        headers,
        ...(request.paginate ? { redirect: "error" } : {}),
      });
    } catch {
      throw unavailable("GitHub search could not complete the request.");
    }
    if (response.status !== 200) {
      throw unavailable("GitHub did not return a search page.");
    }
    const value = validate(readJson(response.body), page);
    if (!request.paginate) {
      return value;
    }
    pages.push(value);
    if (page === last) {
      break;
    }
    const walk = nextPage(response.link, access.endpoint);
    if (walk.kind === "complete") {
      break;
    }
    if (walk.kind === "unfollowable" || !sameSearch(walk.url, first, page + 1)) {
      throw invalid();
    }
    url = walk.url;
  }
  return pages;
}

function lastAccessiblePage(request: SearchRequest): number {
  return Math.ceil(SEARCH_CEILING / request.perPage);
}

function sameSearch(link: string, first: URL, page: number): boolean {
  const next = new URL(link);
  const expected = new URLSearchParams(first.searchParams);
  expected.set("page", String(page));
  expected.sort();
  next.searchParams.sort();
  return (
    next.origin === first.origin &&
    next.pathname === first.pathname &&
    next.username === "" &&
    next.password === "" &&
    next.hash === "" &&
    next.searchParams.toString() === expected.toString()
  );
}

function validateSearchResult(
  value: unknown,
  request: SearchRequest,
  validate: (value: unknown, page: number) => JsonObject,
): SearchResult {
  if (!request.paginate) {
    return validate(value, request.page);
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > lastAccessiblePage(request) - request.page + 1
  ) {
    throw invalid();
  }
  return value.map((page, index) => validate(page, request.page + index));
}

function validateSearchPage(
  received: unknown,
  request: SearchRequest,
  page: number,
  repository: string,
  apiBase: string,
): JsonObject {
  let value;
  try {
    value = parseJson(received);
  } catch {
    throw invalid();
  }
  if (!isJsonObject(value)) {
    throw invalid();
  }
  const { total_count: total, incomplete_results: incomplete, items } = value;
  const start = (page - 1) * request.perPage;
  const expectedRepository = `${apiBase}/repos/${repository}`.toLowerCase();
  const publicRepository = `${GITHUB_API}/repos/${repository}`.toLowerCase();
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    typeof incomplete !== "boolean" ||
    !Array.isArray(items) ||
    items.length > request.perPage ||
    (!incomplete && items.length !== Math.max(0, Math.min(request.perPage, total - start))) ||
    !items.every((item) => {
      if (!isJsonObject(item) || typeof item.repository_url !== "string") {
        return false;
      }
      const url = item.repository_url.toLowerCase();
      return (
        (url === expectedRepository || url === publicRepository) &&
        (request.kind === "pr"
          ? isJsonObject(item.pull_request)
          : !Object.hasOwn(item, "pull_request"))
      );
    })
  ) {
    throw invalid();
  }
  return value;
}
