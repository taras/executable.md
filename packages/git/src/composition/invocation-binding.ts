/**
 * How a declaring execution attaches its own policy to a shared component body.
 *
 * `<Git.Push />` and `<Issue>` are the two operations a REPL entry retains, so
 * their bodies take the operation they ask as an argument: an ordinary
 * registration passes the feature Api's own operations, and the entry's
 * declaration passes an envelope that encloses that Api. A body that reached
 * the Api itself could not be enclosed by a durable boundary above it, which is
 * what retention here means. The other four — `<PullRequest>` and its three
 * evidence reads — retain nothing in this delivery and ask their Api directly.
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
