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
 * The head is the branch the selected checkout is on, decided the way §7.1
 * decides every Git operation's place, so there is no `head`, `repository`,
 * `remote` or `provider` prop to say it a second way. Whether the document
 * named a number is the document's own word rather than a search: without one
 * it asks for a pull request from this head to this base, with one it asks for
 * that pull request, and a number belonging elsewhere is a conflict rather than
 * a rewrite onto unrelated state.
 *
 * It publishes nothing. A pull request is a statement about a branch that
 * already exists at the Git host, and the run must already hold `<Git.Push />`'s
 * own successful result for this exact Repository, head, destination ref and
 * commit. Direct remote observation is not a substitute: a branch found at the
 * host may have been put there by anything, and opening a pull request for it
 * would be publishing somebody else's work under this run's name.
 */
import { cwd } from "@executablemd/runtime";
import { content, documented, hasContent } from "@executablemd/core";
import type {
  ComponentRegistration,
  FirstPartyDocumentation,
  FunctionComponent,
  PropsSchema,
  ReturnsSchema,
} from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { PullRequestOperations } from "../pull-request-operations.ts";
import { COMPOSITION_ORIGIN } from "../definitions.ts";
import { selectedRepository } from "../context.ts";
import { PullRequestAdmissionError } from "../errors.ts";
import { pullRequestResultJson } from "../pull-request-records.ts";

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

export const documentation: FirstPartyDocumentation = {
  description:
    `Open or update a pull request. \`<PullRequest title="Prepare 1.4">…</PullRequest>\` uses its ` +
    `content as the body after \`<Git.Push />\`.`,
  as: "Optional. The pull request's repository, number, url, state and head and base commits.",
  context: "The pull request's body.",
};

const body: FunctionComponent = function* PullRequest(
  props: Record<string, Json>,
): Operation<Json> {
  // Before a Repository is observed, a checkout selected or retained Push
  // evidence read: a body that never finished rendering must not become one
  // that was published, and a child that retains work of its own finishes at
  // its own journal position first.
  const body = (yield* hasContent()) ? yield* content() : "";

  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new PullRequestAdmissionError(
      "no-repository-context",
      "it is written outside a lexical <Repository>, so there is no repository in scope for a " +
        "pull request to be opened in.",
    );
  }

  const result = yield* PullRequestOperations.operations.upsert({
    pullRequest: {
      // Absence is `null` from here on: the durable request is JSON, and a
      // member that is sometimes missing would be a second shape.
      number: typeof props.number === "number" ? props.number : null,
      title: typeof props.title === "string" ? props.title : "",
      // Verbatim: trimming or reflowing it would publish something nobody wrote.
      body,
      draft: props.draft === true,
      // The Repository's own initial branch, pinned when it was selected,
      // rather than whatever its default branch is at the host right now.
      base:
        typeof props.base === "string" && props.base !== ""
          ? props.base
          : repository.identity.primaryBranch,
    },
    repository,
    workingDirectory: yield* cwd(),
  });
  return pullRequestResultJson(result);
};

const METADATA = {
  name: "PullRequest",
  origin: COMPOSITION_ORIGIN,
  props,
  returns,
  forms: ["self-closing", "paired"] as const,
  ...documented(documentation),
};

/** An ordinary registered default, over whichever provider the host installed. */
export const pullRequestRegistration: ComponentRegistration = { ...METADATA, fn: body };
