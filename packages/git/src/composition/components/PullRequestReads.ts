/**
 * Read pull-request reviews, comments or checks into separate bound arrays
 * (specs/workflow-workspace-spec.md §7.7).
 *
 * `<PullRequest.Reviews url={pullRequest.url} as="reviews" />` and the Comments
 * and Checks variants identify a numbered pull request by canonical URL, without
 * Repository or cwd. Optional `provider` addresses self-hosted/non-standard URLs;
 * the host owns endpoint, credential and pagination configuration. Each requires
 * `as` so an Agent prompt can explicitly render the evidence it receives.
 *
 * Providers compose ordinary PullRequestAPI middleware. Once a provider matches,
 * its normalized answer, validation and refusal are final. Each collection has its
 * own durable effect, replay and failure, so a partial answer cannot masquerade as
 * all three collections.
 *
 * Self-closing form is declared to canonical dispatch. Neither replaceable
 * `hasContent()` nor a caller-made invocation object can turn a paired element
 * into an evidence read.
 */

import { documented, formDispatcher } from "@executablemd/core";
import type {
  ComponentRegistration,
  FirstPartyDocumentation,
  FormDeclaration,
  FunctionComponent,
  InvocationForm,
  JsonObject,
  PropsSchema,
  ReturnsSchema,
} from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { COMPOSITION_ORIGIN } from "../definitions.ts";
import { PullRequestReadError } from "../errors.ts";
import { pullRequestReadResultJson } from "../pull-request-read-records.ts";
import { canonicalPullRequestUrl, pullRequestProviderName } from "../pull-request-target.ts";
import type { PullRequestReadKind } from "../pull-request-read-records.ts";
import type { PullRequestOperationsApi } from "../pull-request-operations.ts";
import { boundComponent, unboundComponent } from "../invocation-binding.ts";
import type { BindOperations, ComponentBody, InvocationGate } from "../invocation-binding.ts";

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
function read(kind: PullRequestReadKind, element: string): ComponentBody<PullRequestOperationsApi> {
  return function* PullRequestRead(
    props: Record<string, Json>,
    operations: PullRequestOperationsApi,
  ): Operation<Json> {
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

    const result = yield* operations.read({ url, kind, provider });
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

function declare(fn: FunctionComponent, element: string): FormDeclaration {
  return {
    forms: "self-closing",
    fn,
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

/** What the catalog says about each of the three reads. */
const DOCUMENTATION: Readonly<Record<PullRequestReadKind, FirstPartyDocumentation>> = Object.freeze(
  {
    reviews: {
      description:
        `Read pull request reviews. \`<PullRequest.Reviews url={pullRequest.url} as="reviews" />\` ` +
        `reads reviews from the specified pull request.`,
      as: "Required. Each review's author, state, body, submission time, commit and url.",
      context: null,
    },
    comments: {
      description:
        `Read pull request comments. \`<PullRequest.Comments url={pullRequest.url} as="comments" />\` ` +
        `reads both conversation and review comments.`,
      as:
        "Required. Each comment's kind, author, body, timestamps and url, and a review " +
        "comment's file, hunk and line.",
      context: null,
    },
    checks: {
      description:
        `Read pull request checks. \`<PullRequest.Checks url={pullRequest.url} as="checks" />\` ` +
        `reads check runs and commit statuses for its head.`,
      as: "Required. Each check's kind, name, head commit and outcome.",
      context: null,
    },
  },
);

/** The three evidence reads, as the names a document writes. */
const NAMES: Readonly<Record<PullRequestReadKind, string>> = Object.freeze({
  reviews: "PullRequest.Reviews",
  comments: "PullRequest.Comments",
  checks: "PullRequest.Checks",
});

const ELEMENTS: Readonly<Record<PullRequestReadKind, string>> = Object.freeze({
  reviews: REVIEWS_ELEMENT,
  comments: COMMENTS_ELEMENT,
  checks: CHECKS_ELEMENT,
});

const RETURNS: Readonly<Record<PullRequestReadKind, ReturnsSchema>> = Object.freeze({
  reviews: reviewsReturns,
  comments: commentsReturns,
  checks: checksReturns,
});

/** What a catalog says about one read, whichever path declares it. */
function metadata(kind: PullRequestReadKind) {
  return {
    name: NAMES[kind],
    origin: COMPOSITION_ORIGIN,
    props,
    returns: RETURNS[kind],
    forms: ["self-closing"] as const,
    ...documented(DOCUMENTATION[kind]),
  };
}

/** One evidence read as an ordinary registered default, over the public Api. */
export function pullRequestReadRegistration(
  kind: PullRequestReadKind,
  operations: (gate: InvocationGate) => PullRequestOperationsApi,
): ComponentRegistration {
  const element = ELEMENTS[kind];
  return {
    ...metadata(kind),
    fn: formDispatcher(
      declare(unboundComponent(element, operations, read(kind, element)), element),
    ),
  };
}

/** One evidence read as a declaration, for a host that supplies its own policy. */
export function pullRequestReadDeclaration(
  kind: PullRequestReadKind,
  bind: BindOperations<PullRequestOperationsApi>,
): IdentityComponent {
  const element = ELEMENTS[kind];
  return {
    ...metadata(kind),
    factory: (claim: IdentityClaimant) =>
      formDispatcher(
        declare(boundComponent(claim, { element, bind, body: read(kind, element) }), element),
      ),
  };
}

/** The three kinds, in the order a catalog lists them. */
export const PULL_REQUEST_READ_KINDS: readonly PullRequestReadKind[] = Object.freeze([
  "reviews",
  "comments",
  "checks",
]);
