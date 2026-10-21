/**
 * How a declaring execution attaches its own policy to a shared component body.
 *
 * The six operations that reach something no local transaction encloses —
 * `<Git.Push />`, `<Issue>`, `<PullRequest>` and its three evidence reads —
 * take the operation they ask as an argument. An ordinary registration passes
 * the feature Api's own operations, and a retaining host's declaration passes
 * an envelope that encloses that Api. A body that reached the Api itself could
 * not be enclosed by a durable boundary above it, which is what retention here
 * means.
 *
 * A host may retain beneath the Api instead, and a workflow run does: it makes
 * the upsert durable in the Git-host reconciliation below, and each read
 * durable as policy on `PullRequestReadExecution`. That needs no binding. What
 * needs one is a boundary *over* the chain, which is why all six are bound
 * rather than only the two whose hosts happened to want one first.
 *
 * Either way the body receives semantic operations and nothing else: no
 * authenticator, no owner, no site, no native access and no record codec. The
 * site stays private to the policy it was handed to.
 */

import type { Operation } from "effection";
import type { ComponentInvocation, FunctionComponent } from "@executablemd/core";
import type { IdentityClaimant } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";

/** The one authored body of a repository operation. */
export type ComponentBody<Operations> = (
  props: Record<string, Json>,
  operations: Operations,
) => Operation<unknown>;

/** How a host answers with one authenticated invocation's own operations. */
export type BindOperations<Operations> = (site: string) => Operations;

/**
 * The body a declaration carries, over the policy the declaring execution owns.
 *
 * `claim` comes from `IdentityComponent.factory`, so it is the authenticator
 * that execution minted for this component name.
 */
export function boundComponent<Operations>(
  claim: IdentityClaimant,
  bind: BindOperations<Operations>,
  body: ComponentBody<Operations>,
): FunctionComponent {
  return function* (
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<unknown> {
    // In the frame the engine entered, and before the body reaches any content
    // of its own: a projecting ancestor is ineligible for an invocation.
    const site = yield* claim(invocation);
    return yield* body(props, bind(site));
  };
}
