/**
 * `<Issue>` — one issue, in the container the nearest lexical Issue context
 * names (specs/workflow-workspace-spec.md §10.3).
 *
 * ```md
 * <IssueTracker url={props.tracker}>
 *   <Issue
 *     title="Retry the publish step on a 5xx"
 *     description={finding.evidence}
 *     tags={["reliability", "publish"]}
 *     as="issue"
 *   />
 * </IssueTracker>
 *
 * Recorded at {issue.url}.
 * ```
 *
 * Four props, two of them required, and nothing else. There is no
 * `repository`, `url`, `provider`, `token`, `finding`, `disposition`,
 * `pullRequest`, `rationale`, `dependencyImpact`, `intendedTiming`, `label`,
 * `milestone`, `project`, `comment`, `close` or approval prop, and no rendered
 * children. It renders nothing and binds through `as`.
 *
 * ## The destination is context, not a prop
 *
 * Which tracker an issue belongs in is a deployment fact, and a deployment fact
 * written into every element is one that cannot be changed without editing
 * every element. `<IssueTracker>` says it once for a region; the nearest one
 * wins, and a nested one replaces the whole target rather than merging with it.
 *
 * The context is composition data. It requests a destination and grants
 * nothing: the trusted host's adapter-private ceiling decides whether that
 * target may be reached at all, before any provider observes anything.
 *
 * ## Policy is the document's, not the primitive's
 *
 * Deferral classification, typed approval, PullRequest provenance, rationale,
 * dependency impact and intended timing are workflow policy. A workflow
 * expresses them through ordinary document structure — an `<If>` around the
 * element, a suspension before it — or through `IssueApi` middleware that
 * inspects the request before delegating it. Folding any of them into this
 * component would make one team's review process part of the portable contract
 * every other integration has to satisfy.
 *
 * ## What it produces
 *
 * Exactly `{ url }`. Not the issue number, the target, the provider, the
 * provider's own identity or what the reconciliation decided — those stay in
 * the retained record, where they are evidence rather than something a document
 * can build a dependency on. A replayed run hands back the same URL, whatever
 * the issue looks like now.
 *
 * ## Failure
 *
 * Content written around it, a missing tracker and a URL that is not a
 * credential-free container are decided here, before the boundary exists in the
 * story. What a provider answers — a conflict, an ambiguity, an unavailability,
 * a target outside its ceiling — is the provider's own closed vocabulary. What a provider answers — a conflict, an ambiguity, an
 */

import { hasContent } from "@executablemd/core";
import type { PropsSchema, ReturnsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { currentIssueTracker } from "../../issue/context.ts";
import { resolveIssueDestination } from "../../issue/tracker.ts";
import { upsertIssue } from "../../issue/effect.ts";
import type { IssueInput } from "../../issue/api.ts";
import { normalizedTags } from "../../issue/records.ts";
import { IssueContentError, IssueProtocolError } from "../../issue/errors.ts";

/** The component name, as a document writes it and as a refusal names it. */
export const ISSUE_ELEMENT = "<Issue>";

export const props: PropsSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    /**
     * A set, written as a list.
     *
     * Order is not issue identity, so the request normalizes it: duplicates
     * removed, sorted by code point. A document that reorders its own list is
     * asking the same question.
     */
    tags: { type: "array", items: { type: "string", minLength: 1 } },
    /**
     * An opaque provider account identifier.
     *
     * No provider translates it through another directory: what a GitHub
     * adapter receives is a GitHub login and what an Atlassian adapter receives
     * is an Atlassian account id, and deciding which is the document's.
     */
    assignee: { type: "string", minLength: 1 },
  },
  required: ["title", "description"],
  additionalProperties: false,
};

/**
 * The evidence a document binds, exactly.
 *
 * Closed, and one member. Everything else this effect knows — the target, the
 * provider, the provider's own identity, the decision — is retained evidence
 * rather than something a document reads, because a document that branched on
 * a provider's identity would stop being portable across providers, which is
 * the whole point of this primitive.
 */
export const returns: ReturnsSchema = {
  type: "object",
  properties: { url: { type: "string", minLength: 1 } },
  required: ["url"],
  additionalProperties: false,
};

export default function* Issue(props: Record<string, Json>): Operation<Json> {
  // Before the destination is resolved, before routing and before any provider
  // is asked anything. This element renders nothing, so content written around
  // it would be discarded in silence — and an issue created beside text nobody
  // ever saw is worse than one not created at all.
  if (yield* hasContent()) {
    throw new IssueContentError(
      `${ISSUE_ELEMENT} renders nothing, so it takes no content. The issue's text is its ` +
        `description prop. Write it as <Issue title=… description=… as=… />.`,
    );
  }

  // The destination next, and locally. A document that named no tracker, or one
  // whose URL is not a credential-free container, is refused before an effect
  // identity exists and before the boundary has been asked anything.
  const destination = resolveIssueDestination(yield* currentIssueTracker());

  const tags = normalizedTags(props.tags);
  if (tags === undefined) {
    throw new IssueProtocolError(
      "the tags this invocation was given are not a list of non-empty strings",
    );
  }
  const issue: IssueInput = Object.freeze({
    title: typeof props.title === "string" ? props.title : "",
    description: typeof props.description === "string" ? props.description : "",
    tags,
    // One spelling of absence, from here to the journal.
    assignee: typeof props.assignee === "string" && props.assignee !== "" ? props.assignee : null,
  });

  const result = yield* upsertIssue({
    target: destination.target,
    provider: destination.provider,
    issue,
  });
  return { url: result.url };
}
