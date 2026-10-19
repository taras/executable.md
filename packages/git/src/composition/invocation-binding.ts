/**
 * The handoff between a repository component's invocation and the host policy
 * that performs it, for the six operations no local transaction encloses.
 *
 * `boundComponent` is for a host that retains work named after the invocation:
 * it authenticates the invocation core issued and hands the site to
 * feature-owned policy, which answers with this invocation's own semantic
 * operations. An ordinary registration needs none of that and calls the public
 * feature operations directly.
 *
 * Either way the body receives semantic operations and nothing else — no
 * authenticator, no owner, no site, no native access, no record codec — and the
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

/** The body an ordinary registration carries, over the public feature operations. */
export function registeredComponent<Operations>(
  operations: Operations,
  body: ComponentBody<Operations>,
): FunctionComponent {
  return (props: Record<string, Json>) => body(props, operations);
}

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
