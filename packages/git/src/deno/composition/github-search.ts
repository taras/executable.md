import { isJsonObject, parseJson } from "@executablemd/core";
import type { JsonObject } from "@executablemd/core";
import type { Operation } from "effection";
import {
  GitHubSearch,
  SEARCH_CEILING,
  SEARCH_ELEMENT,
  type SearchRequest,
} from "../../composition/components/GitHubSearch.ts";
import { PullRequestReadError } from "../../composition/errors.ts";
import { PullRequestReadExecution } from "../../composition/pull-request-read-execution.ts";
import type { RepositorySelection } from "../../composition/selection.ts";
import {
  authorizedHeaders,
  GITHUB_API,
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
    *search([selection, request]): Operation<JsonObject> {
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
      return yield* PullRequestReadExecution.operations.search(url, request, () =>
        readSearchPage(() => resolved.transport(configuration), name, request),
      );
    },
  });
}

function* readSearchPage(
  source: () => GitHubSource,
  repository: string,
  request: SearchRequest,
): Operation<JsonObject> {
  const endpoint = "/search/issues";
  const parameters = new URLSearchParams({
    q: `repo:${repository} ${request.query}`,
    page: String(request.page),
    per_page: String(request.perPage),
  });
  if (request.sort !== undefined && request.order !== undefined) {
    parameters.set("sort", request.sort);
    parameters.set("order", request.order);
  }

  let response;
  let apiBase;
  try {
    const access = yield* source().open();
    apiBase = access.endpoint;
    const headers = yield* authorizedHeaders(access, false);
    if (headers !== undefined) {
      response = yield* access.send({
        method: "GET",
        url: `${access.endpoint}${endpoint}?${parameters}`,
        headers,
      });
    }
  } catch {
    throw unavailable("GitHub search could not authenticate or complete the request.");
  }
  if (response === undefined) {
    throw unavailable("GitHub search requires a credential.");
  }
  if (response.status !== 200) {
    throw unavailable("GitHub did not return a search page.");
  }
  let value;
  try {
    value = parseJson(readJson(response.body));
  } catch {
    throw invalid();
  }
  if (!isJsonObject(value)) {
    throw invalid();
  }
  const { total_count: total, incomplete_results: incomplete, items } = value;
  const start = (request.page - 1) * request.perPage;
  const capacity = Math.min(request.perPage, SEARCH_CEILING - start);
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    typeof incomplete !== "boolean" ||
    !Array.isArray(items) ||
    !items.every((item) => isJsonObject(item) && belongsToRepository(item, repository, apiBase)) ||
    items.length > capacity ||
    (!incomplete && items.length !== Math.max(0, Math.min(capacity, total - start)))
  ) {
    throw invalid();
  }

  const next = nextPage(response.link, apiBase);
  const page = request.page + 1;
  if (next.kind === "complete" || (page - 1) * request.perPage >= SEARCH_CEILING) {
    return { value, next: null };
  }
  if (next.kind === "unfollowable") {
    throw invalid();
  }
  const target = new URL(next.url);
  if (
    target.pathname !== new URL(`${apiBase}${endpoint}`).pathname ||
    target.searchParams.get("page") !== String(page)
  ) {
    throw invalid();
  }
  return { value, next: { ...request, page } };
}

function belongsToRepository(item: JsonObject, repository: string, apiBase: string): boolean {
  const url = item.repository_url;
  return (
    typeof url === "string" &&
    (url.toLowerCase() === `${apiBase}/repos/${repository}`.toLowerCase() ||
      url.toLowerCase() === `${GITHUB_API}/repos/${repository}`.toLowerCase())
  );
}
