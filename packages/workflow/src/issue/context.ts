/**
 * The contextual Issue target a lexical `<IssueTarget>` installs for its
 * content.
 *
 * A stable, namespaced contextual value holding a requested destination and no
 * authority. Installing or replacing it asks for a container for lexical
 * descendants; it grants no network access, no credential, no provider and no
 * permission to mutate that container. What decides whether the target may be
 * reached at all is the adapter-private ceiling the trusted host installs
 * beside its credentials, and a context cannot widen one.
 *
 * Installed with `{ at: "min" }` wherever it is installed, so the nearest
 * enclosing target answers and the outer one is restored when that scope ends.
 * Nesting one target inside another therefore means what it reads as — and it
 * replaces the whole target rather than merging with it, because a child that
 * inherited a parent's `provider` while replacing its `url` would ask one
 * service about another's container.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { IssueTarget } from "./target.ts";

export interface IssueTargetContextApi {
  readonly current: IssueTarget | undefined;
  /**
   * The provider this canonical target selects when the context named none.
   *
   * Installed by the trusted host beside its adapters, because the table of
   * well-known hosts is host policy and the shared boundary may not name a
   * provider. It carries no authority whatever: it maps one string to another,
   * and the host's ceiling still decides whether the target may be reached.
   *
   * The default resolves nothing, so a run whose host installed no issue
   * providers refuses locally and says to name one.
   */
  resolve(target: string): Operation<string | undefined>;
}

export const ISSUE_TARGET_CONTEXT = "executablemd.workflow.issue-target";

export const IssueTargetContext: Api<IssueTargetContextApi> = createApi<IssueTargetContextApi>(
  ISSUE_TARGET_CONTEXT,
  {
    current: undefined,
    // deno-lint-ignore require-yield
    *resolve(): Operation<string | undefined> {
      return undefined;
    },
  },
);

/** The nearest enclosing Issue target, or `undefined` when there is none. */
export function currentIssueTarget(): Operation<IssueTarget | undefined> {
  return IssueTargetContext.operations.current;
}

/** What this host maps this canonical target to, when a context named nothing. */
export function issueProviderFor(target: string): Operation<string | undefined> {
  return IssueTargetContext.operations.resolve(target);
}
