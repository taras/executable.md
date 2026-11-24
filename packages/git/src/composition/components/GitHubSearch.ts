import { documented, formDispatcher } from "@executablemd/core";
import type { ComponentRegistration, Json, JsonObject } from "@executablemd/core";
import { createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import { selectedRepository } from "../context.ts";
import { COMPOSITION_ORIGIN } from "../definitions.ts";
import { GitOperationAdmissionError } from "../errors.ts";
import type { RepositorySelection } from "../selection.ts";

export const SEARCH_ELEMENT = "<GitHub.Search>";
export const SEARCH_CEILING = 1000;

export type SearchRequest = JsonObject & {
  query: string;
  sort?: string;
  order?: string;
  page: number;
  perPage: number;
};

interface GitHubSearchApi {
  search(repository: RepositorySelection, request: SearchRequest): Operation<JsonObject>;
}

export const GitHubSearch = createApi<GitHubSearchApi>("executablemd.git.github.search", {
  *search(): Operation<JsonObject> {
    throw new GitOperationAdmissionError(
      SEARCH_ELEMENT,
      "this host has no GitHub search provider.",
    );
  },
});

const sorts = [
  "comments",
  "reactions",
  "reactions-+1",
  "reactions--1",
  "reactions-smile",
  "reactions-thinking_face",
  "reactions-heart",
  "reactions-tada",
  "interactions",
  "created",
  "updated",
];

function admitQuery(query: string): void {
  // Keep quoted search terms intact while inspecting qualifier names and values.
  const tokens = query.match(/(?:[^\s"()]|"(?:\\.|[^"\\])*")+/gu) ?? [];
  const kinds = tokens.filter((token) => /^[+-]?(?:is|type):"?(?:issue|pr)"?$/i.test(token));
  if (
    tokens.some((token) => /^[+-]?(?:repo|org|user):/i.test(token)) ||
    query.replace(/"(?:\\.|[^"\\])*"/gu, "").includes('"')
  ) {
    throw new GitOperationAdmissionError(
      SEARCH_ELEMENT,
      "use a GitHub query without repository, organization or user scope qualifiers and with balanced quotes.",
    );
  }
  if (kinds.length !== 1 || !/^is:/i.test(kinds[0] ?? "")) {
    throw new GitOperationAdmissionError(
      SEARCH_ELEMENT,
      "select exactly one kind with is:issue or is:pr.",
    );
  }
}

function* search(props: Record<string, Json>): Operation<JsonObject> {
  const { query, sort, order, page = 1, perPage = 20 } = props;
  if (typeof query !== "string" || typeof page !== "number" || typeof perPage !== "number") {
    throw new GitOperationAdmissionError(SEARCH_ELEMENT, "the search arguments are invalid.");
  }
  admitQuery(query);
  if ((page - 1) * perPage >= SEARCH_CEILING) {
    throw new GitOperationAdmissionError(
      SEARCH_ELEMENT,
      "the page must start within the first 1,000 results.",
    );
  }
  if (order !== undefined && sort === undefined) {
    throw new GitOperationAdmissionError(SEARCH_ELEMENT, "order requires sort.");
  }
  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new GitOperationAdmissionError(SEARCH_ELEMENT, "select a Repository before searching.");
  }
  return yield* GitHubSearch.operations.search(repository, {
    query,
    page,
    perPage,
    ...(typeof sort === "string"
      ? { sort, order: typeof order === "string" ? order : "desc" }
      : {}),
  });
}

export const githubSearchRegistration: ComponentRegistration = {
  name: "GitHub.Search",
  origin: COMPOSITION_ORIGIN,
  props: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      sort: { enum: sorts },
      order: { enum: ["asc", "desc"] },
      page: { type: "integer", minimum: 1, maximum: SEARCH_CEILING },
      perPage: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  returns: {
    type: "object",
    properties: { value: { type: "object" }, next: { type: ["object", "null"] } },
    required: ["value", "next"],
    additionalProperties: false,
  },
  fn: formDispatcher({
    forms: "self-closing",
    fn: search,
    refuse: () =>
      new GitOperationAdmissionError(SEARCH_ELEMENT, "write it as a self-closing element."),
  }),
  ...documented({
    description:
      "Search the selected GitHub repository with GitHub's issue and pull-request query syntax.",
    as: "Required. Binds the original GitHub JSON under value and the next request arguments or null under next.",
    context: null,
  }),
};
