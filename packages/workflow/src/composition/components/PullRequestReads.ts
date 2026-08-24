/**
 * `<PullRequest.Reviews>`, `<PullRequest.Comments>` and `<PullRequest.Checks>` —
 * the existing evidence about a numbered pull request
 * (specs/workflow-workspace-spec.md §7.7).
 *
 * ```md
 * <PullRequest number={pullRequest.number} title="Prepare 1.4" as="pullRequest">…</PullRequest>
 * <PullRequest.Reviews  number={pullRequest.number} as="reviews"  />
 * <PullRequest.Comments number={pullRequest.number} as="comments" />
 * <PullRequest.Checks   number={pullRequest.number} as="checks"   />
 * ```
 *
 * A workflow Agent has no network, so an objection the prompt does not render
 * is an objection the review never saw. These are how a document renders them:
 * each binds one array, and a caller iterates it with `<Each>` into the prompt
 * and into whatever material a person is asked to approve.
 *
 * `number` is the only prop, and the enclosing `<Repository>` and the
 * contextual working directory decide which repository it names — the way §7.1
 * decides every Git operation's place. There is no repository, URL, host,
 * provider, endpoint, token, credential, page, cursor or limit prop, because
 * every one of those would be a way to say what the document already said by
 * writing the element where it wrote it, or a way to send a credential
 * somewhere the host never authorized.
 *
 * `as` is required. These read to be rendered, and an uncaptured one would
 * perform requests nobody reads.
 *
 * ## Where the evidence comes from
 *
 * Not from any public Api. The structural request — the retained Repository
 * identity, the number and the collection — crosses the public request-only
 * route, where middleware may see it, refuse it, or narrow which reads a run
 * performs. The evidence crosses no public surface at all: the host builds
 * these components closed over a terminal, and the terminal is the only thing
 * that can author a result.
 *
 * What the terminal authenticates is the object this activation is holding, not
 * a name for it. An expansion identifier is stable across continuations, so a
 * handler could keep a genuine request from one execution and present it in the
 * next execution of the same element; a fresh object per activation has no such
 * afterlife.
 *
 * An operation on a public Api would undo that. Anything installed on it could
 * answer with a fabricated collection without delegating, and what a document
 * bound and the journal retained would be that answer rather than a host's.
 *
 * The attachment — the whole Repository record and the working directory — goes
 * straight from here to the terminal and is never part of a request. A provider
 * needs it; middleware has no business seeing a checkout path.
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

import { cwd } from "@executablemd/runtime";
import type {
  FormDeclaration,
  InvocationForm,
  JsonObject,
  PropsSchema,
  ReturnsSchema,
} from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { currentRepository } from "../context.ts";
import { PullRequestReadError } from "../errors.ts";
import { pullRequestReadResultJson, readRequest } from "../pull-request-read-records.ts";
import type {
  PullRequestReadAttachment,
  PullRequestReadKind,
  PullRequestReadRequest,
  PullRequestReadResult,
} from "../pull-request-read-records.ts";
import { PullRequestAPI } from "../pull-request-api.ts";

/** The component names, as a document writes them and a refusal names them. */
export const REVIEWS_ELEMENT = "<PullRequest.Reviews>";
export const COMMENTS_ELEMENT = "<PullRequest.Comments>";
export const CHECKS_ELEMENT = "<PullRequest.Checks>";

export const props: PropsSchema = {
  type: "object",
  properties: {
    number: { type: "integer", minimum: 1 },
  },
  required: ["number"],
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
/**
 * What authors evidence for one invocation.
 *
 * Implemented by the host that has the run's storage and its Git-host source,
 * and reachable only through the closure these components capture.
 */
export interface PullRequestReadTerminal {
  /**
   * Read on behalf of one live activation.
   *
   * `issued` is the object the component created for the activation now
   * running and is still holding; `asked` is what came back from the public
   * route. The terminal performs the read only when they are the same object.
   */
  read(
    issued: PullRequestReadRequest,
    asked: PullRequestReadRequest,
    attachment: PullRequestReadAttachment,
  ): Operation<PullRequestReadResult>;
}

function read(kind: PullRequestReadKind, element: string, terminal: PullRequestReadTerminal) {
  return function* PullRequestRead(props: Record<string, Json>): Operation<Json> {
    // The props schema is what refuses a missing, fractional or non-positive
    // number, before this function is entered and therefore before a credential
    // is read. A second hand-written check here would be one no test could tell
    // from the first.
    const number = props.number;
    if (typeof number !== "number") {
      throw new PullRequestReadError(
        "invalid-number",
        element,
        "it requires a positive integer `number` naming the pull request to read.",
      );
    }

    const repository = yield* currentRepository();
    if (repository === undefined) {
      throw new PullRequestReadError(
        "no-repository-context",
        element,
        "it is written outside a lexical <Repository>, so there is no repository in scope " +
          "holding the pull request it names.",
      );
    }

    // Minted here, so the object the provider admits is the one this
    // invocation issued and nothing a handler can reconstruct.
    // One object for this activation, created here and held here. Nothing
    // names it and nothing else can produce it.
    const issued = readRequest(repository, number, kind);

    // Request-only, and structural. Middleware sees what is about to be read
    // and may refuse it by raising, or delegate; what it answers with is a
    // request, so there is nothing here it could answer with instead of the
    // evidence.
    const asked = yield* PullRequestAPI.operations.read(issued);

    const result = yield* terminal.read(issued, asked, {
      repository,
      workingDirectory: yield* cwd(),
    });
    return pullRequestReadResultJson(result);
  };
}

function declare(
  kind: PullRequestReadKind,
  element: string,
  terminal: PullRequestReadTerminal,
): FormDeclaration {
  return {
    forms: "self-closing",
    fn: read(kind, element, terminal),
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

/** The three declarations, built over one host terminal. */
export function pullRequestReadForms(terminal: PullRequestReadTerminal): {
  readonly reviews: FormDeclaration;
  readonly comments: FormDeclaration;
  readonly checks: FormDeclaration;
} {
  return {
    reviews: declare("reviews", REVIEWS_ELEMENT, terminal),
    comments: declare("comments", COMMENTS_ELEMENT, terminal),
    checks: declare("checks", CHECKS_ELEMENT, terminal),
  };
}
