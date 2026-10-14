/**
 * Select the issue destination for a lexical subtree
 * (specs/workflow-workspace-spec.md §10.3).
 *
 * `<IssueTracker url={props.tracker}>
 *   <Issue title="Retry" as="issue">{finding.evidence}</Issue>
 * </IssueTracker>`
 * names a credential-free issue container. Optional `provider` selects the only
 * adapter that may act; without it, each installed middleware recognizes its own
 * URLs, and complete delegation reaches NoIssueProvider.
 *
 * The context carries composition data, never permission. The adapter-private
 * ceiling beside its credentials refuses outside targets before observation.
 * Nesting replaces the entire target rather than merging URL and provider from
 * different trackers.
 */

import { content, hasContent } from "@executablemd/core";
import type { PropsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { IssueTrackerContext } from "../../issue/context.ts";
import type { IssueTracker as Tracker } from "../../issue/tracker.ts";

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
