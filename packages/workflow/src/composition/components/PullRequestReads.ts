/**
 * `<PullRequest.Reviews>`, `<PullRequest.Comments>` and `<PullRequest.Checks>` —
 * the existing evidence about a numbered pull request
 * (specs/workflow-workspace-spec.md §7.7).
 *
 * ```md
 * <PullRequest title="Prepare 1.4" as="pullRequest">…</PullRequest>
 * <PullRequest.Reviews  url={pullRequest.url} as="reviews"  />
 * <PullRequest.Comments url={pullRequest.url} as="comments" />
 * <PullRequest.Checks   url={pullRequest.url} as="checks"   />
 * ```
 *
 * A workflow Agent has no network, so an objection the prompt does not render
 * is an objection the review never saw. These are how a document renders them:
 * each binds one array, and a caller iterates it with `<Each>` into the prompt
 * and into whatever material a person is asked to approve.
 *
 * The URL is the identity. A pull request is a public object with a canonical
 * address, so a document that can name one can ask what it holds — there is no
 * `<Repository>` to be inside of, no working directory to be at, and no
 * repository or number prop, because the URL already says both and the selected
 * provider parses them out of it.
 *
 * `provider` names an adapter explicitly, for a self-hosted or non-standard
 * URL. There is no endpoint, token, credential, page, cursor or limit prop: a
 * document says which pull request, and the host says which places it may be
 * reached at.
 *
 * `as` is required. These read to be rendered, and an uncaptured one would
 * perform requests nobody reads.
 *
 * ## Where the evidence comes from
 *
 * From the selected provider, which owns its answer — the shape `<Issue>` has.
 * A provider is ordinary middleware around `PullRequestAPI`: it recognizes the
 * URLs it can act on, and once it matches, its validation and its refusal are
 * final. What a document binds is what that provider normalized.
 *
 * This supersedes the request-only route and invocation-private terminal an
 * earlier revision carried. Those kept evidence off a public surface at the
 * cost of a second authority model beside the Issue surface's, and of a read
 * that needed a Repository in scope to name a pull request by number.
 *
 * ## The form is declared, not asked about
 *
 * Each is self-closing only, and that is a declaration the engine turns into
 * the dispatcher every invocation arrives through. Neither weaker answer would
 * do: `hasContent()` resolves through the composable chain, where a handler
 * outside the invocation answers ahead of the engine, and an invocation object
 * a caller minted answers whatever it likes. A component that read either one
 * and got "no content" for a paired element would silently read a pull request
 * a document had written children beside.
 *
 * Three components rather than one for the reason `<Git.Push>` and
 * `<PullRequest>` are two: three separate remote collections, three durable
 * effects, three independent replays and failures. One component returning
 * three lists would make a partial answer indistinguishable from a complete
 * one.
 */

import type {
  FormDeclaration,
  InvocationForm,
  JsonObject,
  PropsSchema,
  ReturnsSchema,
} from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { PullRequestReadError } from "../errors.ts";
import { pullRequestReadResultJson } from "../pull-request-read-records.ts";
import { canonicalPullRequestUrl, pullRequestProviderName } from "../pull-request-target.ts";
import type { PullRequestReadKind } from "../pull-request-read-records.ts";
import { PullRequestOperations } from "../pull-request-operations.ts";

/** The component names, as a document writes them and a refusal names them. */
export const REVIEWS_ELEMENT = "<PullRequest.Reviews>";
export const COMMENTS_ELEMENT = "<PullRequest.Comments>";
export const CHECKS_ELEMENT = "<PullRequest.Checks>";

export const props: PropsSchema = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1 },
    provider: { type: "string", minLength: 1 },
  },
  required: ["url"],
  additionalProperties: false,
};

const AUTHOR: JsonObject = { type: ["string", "null"] };
const NULLABLE_TEXT: JsonObject = { type: ["string", "null"] };
const NULLABLE_COUNT: JsonObject = { type: ["integer", "null"] };
const SIDE: JsonObject = { enum: ["left", "right", null] };

function array(items: JsonObject): ReturnsSchema {
  return { type: "array", items };
}

function closed(properties: JsonObject): JsonObject {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/**
 * The evidence each component binds, exactly.
 *
 * Declared rather than left open, and for two reasons. It is the boundary a
 * document reads these records through, so a member arriving that the contract
 * does not name would be a provider detail reaching a binding. And declaring
 * `returns` is what makes `as` mandatory — which is checked before the body
 * runs, so an invocation that forgot it is refused before a credential is read
 * or a request is sent.
 */
export const reviewsReturns: ReturnsSchema = array(
  closed({
    id: { type: "string" },
    author: AUTHOR,
    state: { enum: ["approved", "changes-requested", "commented", "dismissed", "pending"] },
    body: { type: "string" },
    submittedAt: NULLABLE_TEXT,
    commitSha: NULLABLE_TEXT,
    url: { type: "string" },
  }),
);

export const commentsReturns: ReturnsSchema = array({
  oneOf: [
    closed({
      kind: { const: "conversation" },
      id: { type: "string" },
      author: AUTHOR,
      body: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
      url: { type: "string" },
    }),
    closed({
      kind: { const: "review" },
      id: { type: "string" },
      reviewId: NULLABLE_TEXT,
      author: AUTHOR,
      body: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
      url: { type: "string" },
      path: { type: "string" },
      diffHunk: { type: "string" },
      commitSha: { type: "string" },
      originalCommitSha: { type: "string" },
      line: NULLABLE_COUNT,
      side: SIDE,
      startLine: NULLABLE_COUNT,
      startSide: SIDE,
      inReplyToId: NULLABLE_TEXT,
    }),
  ],
});

export const checksReturns: ReturnsSchema = array({
  oneOf: [
    closed({
      kind: { const: "check-run" },
      id: { type: "string" },
      headSha: { type: "string" },
      name: { type: "string" },
      status: {
        enum: ["queued", "in_progress", "completed", "waiting", "requested", "pending"],
      },
      conclusion: {
        enum: [
          "success",
          "failure",
          "neutral",
          "cancelled",
          "skipped",
          "timed_out",
          "action_required",
          null,
        ],
      },
      url: NULLABLE_TEXT,
      startedAt: NULLABLE_TEXT,
      completedAt: NULLABLE_TEXT,
      title: NULLABLE_TEXT,
      summary: NULLABLE_TEXT,
      text: NULLABLE_TEXT,
    }),
    closed({
      kind: { const: "commit-status" },
      id: { type: "string" },
      headSha: { type: "string" },
      name: { type: "string" },
      state: { enum: ["error", "failure", "pending", "success"] },
      description: NULLABLE_TEXT,
      url: NULLABLE_TEXT,
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    }),
  ],
});
function read(kind: PullRequestReadKind, element: string) {
  return function* PullRequestRead(props: Record<string, Json>): Operation<Json> {
    // The props schema refuses a missing or empty `url` before this function is
    // entered, and therefore before any provider is asked anything.
    // Canonicalized before any provider sees it, so the component, the durable
    // request and every adapter read one answer.
    const url = canonicalPullRequestUrl(props.url);
    if (url === undefined) {
      throw new PullRequestReadError(
        "invalid-url",
        element,
        "its `url` is not the plain canonical address of a pull request. A credential, a " +
          "query or a fragment makes it something else, and none of them is stripped.",
      );
    }
    const provider =
      props.provider === undefined ? undefined : pullRequestProviderName(props.provider);
    if (props.provider !== undefined && provider === undefined) {
      throw new PullRequestReadError(
        "invalid-provider",
        element,
        "its `provider` is not a provider name: lower case, starting with a letter.",
      );
    }

    const result = yield* PullRequestOperations.operations.read({ url, kind, provider });
    if (result.kind !== kind) {
      throw new PullRequestReadError(
        "protocol",
        element,
        "the selected provider answered with a different collection than the one this element " +
          "asked for.",
      );
    }
    return pullRequestReadResultJson(result);
  };
}

function declare(kind: PullRequestReadKind, element: string): FormDeclaration {
  return {
    forms: "self-closing",
    fn: read(kind, element),
    refuse: (_props: Record<string, Json>, written: InvocationForm | undefined) =>
      new PullRequestReadError(
        "unexpected-content",
        element,
        written === "paired"
          ? "it names a pull request to read and renders nothing of its own, so it is written " +
              "self-closing."
          : "it was called without the invocation the engine issued, so which form it was " +
              "written as cannot be established.",
      ),
  };
}

export const reviewsForm: FormDeclaration = declare("reviews", REVIEWS_ELEMENT);
export const commentsForm: FormDeclaration = declare("comments", COMMENTS_ELEMENT);
export const checksForm: FormDeclaration = declare("checks", CHECKS_ELEMENT);
