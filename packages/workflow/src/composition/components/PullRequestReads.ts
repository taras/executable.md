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
import type { FormDeclaration, InvocationForm, PropsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { GitComposition } from "../git-api.ts";
import { currentRepository } from "../context.ts";
import { PullRequestReadError } from "../errors.ts";
import { pullRequestReadResultJson } from "../pull-request-read-records.ts";
import type { PullRequestReadKind } from "../pull-request-read-records.ts";

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

/**
 * No `returns`.
 *
 * Declaring one would compile a schema for an array whose item shapes are the
 * provider records, and a second description of those is a second contract to
 * keep in agreement. The provider parses what it retained; what reaches a
 * binding is that parsed value.
 */
function read(kind: PullRequestReadKind, element: string) {
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

    const result = yield* GitComposition.operations.readPullRequestEvidence({
      repository,
      workingDirectory: yield* cwd(),
      number,
      kind,
    });
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
