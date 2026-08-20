/**
 * `<Issue>` — one approved deferred obligation, recorded as a Git-host issue
 * (specs/workflow-workspace-spec.md §7.6).
 *
 * ```md
 * <Repository name="project" url={props.repository}>
 *   <Git.Push />
 *   <PullRequest title="Prepare release 1.4" as="pullRequest">
 *     Prepared from commit {commit}.
 *   </PullRequest>
 *
 *   <Issue
 *     finding={finding.id}
 *     disposition={finding.disposition}
 *     pullRequest={pullRequest}
 *     title={finding.title}
 *     rationale={finding.deferralRationale}
 *     dependencyImpact={finding.dependencyImpact}
 *     intendedTiming={finding.intendedTiming}
 *     as="issue"
 *   >
 *     {finding.evidence}
 *   </Issue>
 * </Repository>
 * ```
 *
 * Seven props, all required, and the rendered content is the evidence body —
 * verbatim, because trimming or summarizing a finding inside this element would
 * publish something nobody wrote. Which repository owns the issue is decided the
 * way §7.1 decides every Git-host effect's place, by the enclosing
 * `<Repository>`, so there is no `repository`, `provider` or `token` prop to say
 * it a second way — and no `label`, `assignee`, `milestone`, `project`,
 * `comment` or `close` control either. This element records one decision; it is
 * not an issue tracker.
 *
 * ## Only a deferral records anything
 *
 * `disposition` is a closed word. `rejected`, `fix-now` and `inserted-repair`
 * are decisions that leave no trace outside the document: they bind a skipped
 * result naming the disposition, and they do not render the evidence, read a
 * Repository, or let any provider know they happened. A word that is none of the
 * four is a local authority failure, before retained history and before any Git
 * host exists in the story.
 *
 * ## An approved deferral, and nothing else
 *
 * A deferred issue is not created because the document declared one. The
 * evidence renders, the pull request the document supplied is read, and then one
 * durable suspension request is published whose body is the normalized Issue
 * request — Repository identity, PullRequest evidence, finding, title,
 * rationale, dependency impact, intended timing and evidence. The run stops
 * there until somebody answers `{ "approved": true }` or
 * `{ "approved": false }`.
 *
 * A false answer binds the same skipped result a non-deferred disposition does.
 * A true answer authorizes that exact request and no other: change any member of
 * it and the document arrives at a different suspension request before it can
 * arrive at a different Git-host effect. The approval is not a prop, a context
 * value, a frontmatter flag or a component name, so authored Markdown cannot
 * manufacture it without passing through typed answer delivery.
 *
 * ## What it produces
 *
 * Stable evidence, bound through `as`. A skipped result names the disposition
 * and carries no provider data at all. A recorded one carries the filtered
 * Repository identity, the pull request's number and URL, the provider's own
 * stable identity for the issue, its number, its URL, its open state, the
 * finding, and what the reconciliation decided. It is not a live issue snapshot:
 * comments, labels and later edits are separate reads, and a replayed run hands
 * back exactly what the run recorded.
 *
 * ## Failure
 *
 * A disposition that is not one of the four, a missing Repository context, and
 * PullRequest evidence that is missing, conflicting or unreadable are all
 * decided locally — before an approval is published for the last three of them,
 * and before the Git host exists in the story for all four. Each fails the run
 * rather than printing: a later sibling must not run as though an obligation had
 * been recorded. What the Git host itself answers — a conflict, an ambiguity, an
 * unavailability — travels under §10.2's shared vocabulary.
 */

import { cwd } from "@executablemd/runtime";
import { content, hasContent } from "@executablemd/core";
import type { JsonObject, PropsSchema, ReturnsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { GitComposition } from "../git-api.ts";
import { currentRepository } from "../context.ts";
import { IssueAuthorityError } from "../errors.ts";
import { filteredRepositoryIdentity } from "../git-push-records.ts";
import { parsePullRequestEvidence } from "../pull-request-records.ts";
import {
  DEFER,
  issueDispositions,
  issueBindingJson,
  issueInputsJson,
  parseIssueDisposition,
  type IssueDisposition,
  type IssueInputs,
} from "../issue-records.ts";
import { suspendFor } from "../../suspension/suspend.ts";

/** The component name, as a document writes it and as a refusal names it. */
export const ISSUE_ELEMENT = "<Issue>";

/** The only two answers that end this element's wait. */
export const APPROVAL_SCHEMA: JsonObject = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
  additionalProperties: false,
};

export const props: PropsSchema = {
  type: "object",
  properties: {
    /** The obligation's own identifier, which is what makes it one obligation. */
    finding: { type: "string", minLength: 1 },
    /**
     * What the document decided. Only `defer` records anything.
     *
     * Any string, because which strings mean something is this element's own
     * closed question and its refusal is the one that names the four words. A
     * schema enum here would answer it as "this prop is malformed", which is a
     * different mistake from writing a decision this element has no meaning for.
     */
    disposition: { type: "string" },
    /** The `<PullRequest>` result this run bound, exactly as it was bound. */
    pullRequest: { type: "object" },
    title: { type: "string", minLength: 1 },
    rationale: { type: "string", minLength: 1 },
    dependencyImpact: { type: "string", minLength: 1 },
    intendedTiming: { type: "string", minLength: 1 },
  },
  required: [
    "finding",
    "disposition",
    "pullRequest",
    "title",
    "rationale",
    "dependencyImpact",
    "intendedTiming",
  ],
  additionalProperties: false,
};

/**
 * The evidence a document binds, exactly: one of two closed shapes.
 *
 * A decision that recorded nothing and one that recorded an issue are different
 * things, and a single shape with members that are sometimes absent would make a
 * document read `undefined` where a number was promised. Which of the two it is
 * is answered by asking for `decision`, which only a recorded issue has.
 */
export const returns: ReturnsSchema = {
  oneOf: [
    {
      type: "object",
      properties: { disposition: { enum: [...issueDispositions()] } },
      required: ["disposition"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        repository: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            locatorFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
            requestedBase: { type: ["string", "null"] },
            creationCommit: { type: "string", pattern: "^([0-9a-f]{40}|[0-9a-f]{64})$" },
            primaryBranch: { type: "string", minLength: 1 },
            objectFormat: { enum: ["sha1", "sha256"] },
          },
          required: [
            "name",
            "locatorFingerprint",
            "requestedBase",
            "creationCommit",
            "primaryBranch",
            "objectFormat",
          ],
          additionalProperties: false,
        },
        pullRequest: {
          type: "object",
          properties: {
            number: { type: "integer", minimum: 1 },
            url: { type: "string", minLength: 1 },
          },
          required: ["number", "url"],
          additionalProperties: false,
        },
        providerId: { type: "string", minLength: 1 },
        number: { type: "integer", minimum: 1 },
        url: { type: "string", minLength: 1 },
        state: { const: "open" },
        finding: { type: "string", minLength: 1 },
        decision: { enum: ["adopted", "performed"] },
      },
      required: [
        "repository",
        "pullRequest",
        "providerId",
        "number",
        "url",
        "state",
        "finding",
        "decision",
      ],
      additionalProperties: false,
    },
  ],
};

/** What a decision that records nothing binds. */
function skipped(disposition: IssueDisposition): Json {
  return { disposition };
}

/**
 * One of the required text props, read as the string the schema already decided
 * it is.
 *
 * Each is declared `minLength: 1` and required, so validation refuses every
 * value this would otherwise have to answer for. Reading it is still a parse
 * rather than a cast: a component is handed JSON, and JSON is read.
 */
function writtenText(props: Record<string, Json>, name: string): string {
  const value = props[name];
  return typeof value === "string" ? value : "";
}

export default function* Issue(props: Record<string, Json>): Operation<Json> {
  // The document's own word, read before anything else happens. Three of the
  // four dispositions record nothing anywhere, and deciding that first is what
  // keeps them from rendering evidence, reading a Repository or publishing a
  // wait for an approval nobody would ever act on.
  const disposition = parseIssueDisposition(props.disposition);
  if (disposition === undefined) {
    throw new IssueAuthorityError(
      "unknown-disposition",
      `it names a disposition this element has no meaning for. Write one of ` +
        `${issueDispositions().join(", ")}.`,
    );
  }
  if (disposition !== DEFER) {
    return skipped(disposition);
  }

  // Before a Repository is observed, before an approval is published and long
  // before a Git host is contacted. The body is what the issue would say, and a
  // body that never finished rendering must not become one that was published.
  const body = (yield* hasContent()) ? yield* content() : "";

  const repository = yield* currentRepository();
  if (repository === undefined) {
    throw new IssueAuthorityError(
      "no-repository-context",
      "it is written outside a lexical <Repository>, so there is no repository in scope for an " +
        "issue to be recorded in.",
    );
  }

  const pullRequest = parsePullRequestEvidence(props.pullRequest);
  if (pullRequest === undefined) {
    throw new IssueAuthorityError(
      "unreadable-pull-request-evidence",
      "the pullRequest it was given is not a <PullRequest> result. Pass the binding a " +
        '<PullRequest ... as="pullRequest"> produced, unchanged.',
    );
  }

  const inputs: IssueInputs = Object.freeze({
    repository: filteredRepositoryIdentity(repository),
    pullRequest,
    finding: writtenText(props, "finding"),
    disposition: DEFER,
    title: writtenText(props, "title"),
    // Verbatim. What a document wrote is the evidence, and reflowing it here
    // would record something nobody authored.
    body,
    rationale: writtenText(props, "rationale"),
    dependencyImpact: writtenText(props, "dependencyImpact"),
    intendedTiming: writtenText(props, "intendedTiming"),
  });

  // The exact normalized request, published as what is being approved. A
  // changed member is a changed request, which is a different durable position
  // — so an answer cannot be carried across from a decision somebody else made.
  const answer = yield* suspendFor({
    request: issueInputsJson(inputs),
    responseSchema: APPROVAL_SCHEMA,
  });
  if (!approved(answer)) {
    return skipped(disposition);
  }

  const outcome = yield* GitComposition.operations.upsertIssue({
    repository,
    workingDirectory: yield* cwd(),
    finding: inputs.finding,
    disposition: DEFER,
    pullRequest,
    title: inputs.title,
    rationale: inputs.rationale,
    dependencyImpact: inputs.dependencyImpact,
    intendedTiming: inputs.intendedTiming,
    body,
  });
  return issueBindingJson(outcome);
}

/** Whether the value that ended the wait says yes, and says only that. */
function approved(answer: Json): boolean {
  return (
    typeof answer === "object" &&
    answer !== null &&
    !Array.isArray(answer) &&
    Reflect.get(answer, "approved") === true
  );
}
