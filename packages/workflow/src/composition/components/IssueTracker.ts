/**
 * `<IssueTracker>` — which tracker or project the issues inside it belong in
 * (specs/workflow-workspace-spec.md §10.3).
 *
 * ```md
 * <IssueTracker url={props.tracker}>
 *   <Issue title="Retry the publish step" description={finding.evidence} as="issue" />
 * </IssueTracker>
 * ```
 *
 * `url` is a credential-free URL naming the container new issues are created
 * in — a GitHub repository issue collection, an Atlassian project. `provider`
 * is optional and names the only adapter allowed to act on it; without one the
 * host resolves a provider from the URL, and a URL no built-in mapping covers
 * is refused with a request to write one.
 *
 * ## It requests a destination; it grants nothing
 *
 * This installs composition data, not authority. A document can write any URL
 * here and reach nothing it was not already allowed to reach: the trusted host
 * installs an adapter-private ceiling beside its credentials, and a target
 * outside that ceiling fails before any provider observes anything. Narrowing
 * within the ceiling is what a context is for; widening it is not something a
 * context can express.
 *
 * ## Nesting replaces, and never merges
 *
 * A nested target replaces the whole target for its descendants. Parent and
 * child members are never merged, because a child that kept its parent's
 * `provider` while replacing its `url` would ask one service about another
 * service's container — and that is exactly the mistake an explicit
 * discriminator exists to prevent.
 */

import { content, hasContent } from "@executablemd/core";
import type { PropsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { IssueTrackerContext } from "../../issue/context.ts";
import type { IssueTracker as Tracker } from "../../issue/tracker.ts";

/** The component name, as a document writes it and as a refusal names it. */
export const ISSUE_TRACKER_ELEMENT = "<IssueTracker>";

export const props: PropsSchema = {
  type: "object",
  properties: {
    /** The credential-free URL naming the container new issues go in. */
    url: { type: "string", minLength: 1 },
    /**
     * The only adapter allowed to act on it.
     *
     * Any string, because which strings name a provider is the Issue
     * boundary's own closed question and its refusal is the one that says so.
     */
    provider: { type: "string" },
  },
  required: ["url"],
  additionalProperties: false,
};

export default function* IssueTracker(props: Record<string, Json>): Operation<string> {
  if (!(yield* hasContent())) {
    return "";
  }
  const tracker: Tracker = Object.freeze({
    url: typeof props.url === "string" ? props.url : "",
    // Absent rather than empty: the whole point of the discriminator is that
    // stating one and stating nothing are different requests, and an empty
    // string would be a third thing that is neither.
    ...(typeof props.provider === "string" && props.provider !== ""
      ? { provider: props.provider }
      : {}),
  });
  yield* IssueTrackerContext.around({ current: () => tracker }, { at: "min" });
  return yield* content();
}
