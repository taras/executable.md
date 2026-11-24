import { isJsonObject, parseJson } from "@executablemd/core";
import type { JsonObject } from "@executablemd/core";
import type { Operation } from "effection";
import {
  GitHubSearch,
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
      const validate = (value: unknown) =>
        validateSearchPage(
          value,
          request,
          name,
          options.access?.endpoint ?? configuration.endpoint ?? GITHUB_API,
        );
      return yield* PullRequestReadExecution.operations.search(
        url,
        request,
        () => readSearchPage(() => resolved.transport(configuration), name, request, validate),
        validate,
      );
    },
  });
}

function* readSearchPage(
  source: () => GitHubSource,
  repository: string,
  request: SearchRequest,
  validate: (value: unknown) => JsonObject,
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
  try {
    const access = yield* source().open();
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
  return validate(readJson(response.body));
}

function validateSearchPage(
  received: unknown,
  request: SearchRequest,
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
  const start = (request.page - 1) * request.perPage;
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
