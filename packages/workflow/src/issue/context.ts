/**
 * The contextual Issue tracker a lexical `<IssueTracker>` installs for its
 * content.
 *
 * A stable, namespaced contextual value holding a requested destination and no
 * authority. Installing or replacing it asks for a container for lexical
 * descendants; it grants no network access, no credential, no provider and no
 * permission to mutate that container. What decides whether the target may be
 * reached at all is the ceiling the provider middleware holds beside its
 * credentials, and a context cannot widen one.
 *
 * Installed with `{ at: "min" }` wherever it is installed, so the nearest
 * enclosing tracker answers and the outer one is restored when that scope ends.
 * Nesting one tracker inside another therefore means what it reads as — and it
 * replaces the whole value rather than merging with it, because a child that
 * inherited a parent's `provider` while replacing its `url` would ask one
 * service about another's container.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { IssueTracker } from "./tracker.ts";

export const ISSUE_TRACKER_CONTEXT = "executablemd.workflow.issue-tracker";

export const IssueTrackerContext: Api<{ readonly current: IssueTracker | undefined }> = createApi<{
  readonly current: IssueTracker | undefined;
}>(ISSUE_TRACKER_CONTEXT, { current: undefined });

/** The nearest enclosing Issue tracker, or `undefined` when there is none. */
export function currentIssueTracker(): Operation<IssueTracker | undefined> {
  return IssueTrackerContext.operations.current;
}
