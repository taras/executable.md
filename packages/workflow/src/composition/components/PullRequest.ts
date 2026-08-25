/**
 * `<PullRequest>` — one pull request for the branch this run published, created
 * or brought up to date (specs/workflow-workspace-spec.md §7.5).
 *
 * ```md
 * <Repository name="project" url={props.repository}>
 *   <Git.Switch branch="release/1.4" />
 *   <Git.Add paths="release/notes.md" />
 *   <Git.Commit message="Prepare 1.4" as="commit" />
 *   <Git.Push />
 *   <PullRequest number={props.pullRequestNumber} title="Prepare 1.4" as="pullRequest">
 *     Prepared from commit {commit}.
 *   </PullRequest>
 * </Repository>
 * ```
 *
 * `title` is required, `number` defaults to none, `base` defaults to the
 * Repository's recorded initial branch, `draft` defaults to false, and the
 * rendered content is the body. The head is the branch the selected checkout is
 * on — decided the way §7.1 decides every Git operation's place, by the
 * enclosing `<Repository>` and the contextual working directory — so there is no
 * `head`, `repository`, `remote` or `provider` prop to say it a second way.
 *
 * ## An upsert over one explicit identity
 *
 * Without a number the document is asking for *a pull request from this head to
 * this base*: one is created, or the compatible one an interrupted earlier
 * attempt already created is adopted. With a number it is asking for *that pull
 * request*: its title, body, draft state and base are brought to what this
 * invocation says, and if they already say it, nothing is performed and the
 * no-op is recorded.
 *
 * Which of the two it is, is the document's own word rather than a search. A
 * number that names a pull request belonging to another Repository, opened from
 * another head, or no longer open is a conflict — never a rewrite onto
 * unrelated state. The head is never rewritten either: an update moves the four
 * fields it names and nothing else.
 *
 * ## It publishes nothing
 *
 * A pull request is a statement about a branch that already exists on the Git
 * host, and this component never makes one exist. `<Git.Push />` is written
 * explicitly, and the run must already hold that Push's own successful result
 * for this exact Repository, head branch, destination ref and commit — before a
 * creation and before an update alike. Direct remote observation is not a
 * substitute: a branch this run finds at the host may have been put there by
 * anything, and opening or repointing a pull request for it would be publishing
 * somebody else's work under this run's name.
 *
 * ## What it produces
 *
 * Stable evidence of what this effect settled on, bound through `as`: the
 * filtered Repository identity, the provider's own stable identity for the pull
 * request, its number, its URL, its open state, and the head and base commits
 * of the snapshot the reconciliation finished at. Reviews, comments, checks,
 * labels, merge state and later edits are separate reads rather than freshness
 * smuggled into the result — a replayed run hands back exactly what the run
 * recorded, whatever the pull request looks like now.
 *
 * ## Failure
 *
 * Content expands first and completely, so a body that failed to render stops
 * everything this component owns before a Repository is even observed. After
 * that, a missing Repository context, a checkout whose HEAD names no branch and
 * missing, conflicting or unreadable Push evidence are all decided locally,
 * before the Git host exists in the story, and each fails the run rather than
 * printing: a later sibling must not run as though a pull request had been
 * opened. What the Git host itself answers — a conflict, an ambiguity, an
 * unavailability — travels under §10.2's shared vocabulary.
 */

import { cwd } from "@executablemd/runtime";
import { content, hasContent } from "@executablemd/core";
import type { PropsSchema, ReturnsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { PullRequestAPI } from "../pull-request-api.ts";
import { currentRepository } from "../context.ts";
import { PullRequestAuthorityError } from "../errors.ts";
import { pullRequestResultJson } from "../pull-request-records.ts";

/** The component name, as a document writes it and as a refusal names it. */
export const PULL_REQUEST_ELEMENT = "<PullRequest>";

export const props: PropsSchema = {
  type: "object",
  properties: {
    /** The pull request to bring up to date. Absent asks for one to exist. */
    number: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
    draft: { type: "boolean", default: false },
  },
  required: ["title"],
  additionalProperties: false,
};

/**
 * The evidence a document binds, exactly.
 *
 * Closed, because this is the boundary a document reads the record through: a
 * member arriving here that the contract does not declare would be a provider
 * detail reaching a binding, and a missing one would be a document reading
 * `undefined` where a number was promised.
 */
export const returns: ReturnsSchema = {
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
    providerId: { type: "string", minLength: 1 },
    number: { type: "integer", minimum: 1 },
    url: { type: "string", minLength: 1 },
    state: { const: "open" },
    headSha: { type: "string", pattern: "^([0-9a-f]{40}|[0-9a-f]{64})$" },
    baseSha: { type: "string", pattern: "^([0-9a-f]{40}|[0-9a-f]{64})$" },
  },
  required: ["repository", "providerId", "number", "url", "state", "headSha", "baseSha"],
  additionalProperties: false,
};

export default function* PullRequest(props: Record<string, Json>): Operation<Json> {
  // Before anything of this element's own exists — before a Repository is
  // observed, before a checkout is selected, before retained Push evidence is
  // read and long before a Git host is contacted. The body is what the pull
  // request would say, and a body that never finished rendering must not become
  // one that was published.
  const body = (yield* hasContent()) ? yield* content() : "";

  const repository = yield* currentRepository();
  if (repository === undefined) {
    throw new PullRequestAuthorityError(
      "no-repository-context",
      "it is written outside a lexical <Repository>, so there is no repository in scope for a " +
        "pull request to be opened in.",
    );
  }

  const result = yield* PullRequestAPI.operations.upsert(
    {
      // Normalized once, here: absence is `null` from this point on, because
      // the durable request is JSON and a member that is sometimes missing
      // would be a second shape rather than a value.
      number: typeof props.number === "number" ? props.number : null,
      title: typeof props.title === "string" ? props.title : "",
      // Verbatim. What a document wrote is the pull request's body, and
      // trimming or reflowing it here would publish something nobody authored.
      body,
      draft: props.draft === true,
      // The Repository's own initial branch, retained when it was created,
      // rather than whatever its default branch is at the host right now.
      base:
        typeof props.base === "string" && props.base !== "" ? props.base : repository.primaryBranch,
    },
    { repository, workingDirectory: yield* cwd() },
  );
  return pullRequestResultJson(result);
}
