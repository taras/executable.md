/**
 * Two wrappers around one authored repository operation's body: `boundComponent`
 * for a host that retains work named after the invocation, `unboundComponent`
 * for one that does not.
 *
 * Both hand the body a facade of semantic operations and nothing else — no
 * authenticator, no owner, no site, no native access, no record codec. The site
 * `boundComponent` authenticates stays private to the policy it is handed to.
 *
 * The facade is single use and ends with its invocation. That is a boundary on
 * what one authored element may ask the host for, not a receipt: it is marked
 * used before the work runs, so it never says an external effect was
 * acknowledged.
 */
import { ensure } from "effection";
import type { Operation } from "effection";
import type { ComponentInvocation, FunctionComponent } from "@executablemd/core";
import type { IdentityClaimant } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";

export type FacadeRefusal = "ended" | "spent";

/** The binding's own refusal: neither condition is one a document can arrange. */
export class BoundOperationError extends Error {
  override name = "BoundOperationError";

  readonly reason: FacadeRefusal;

  constructor(element: string, reason: FacadeRefusal) {
    super(
      reason === "ended"
        ? `${element} belongs to an invocation that has finished, so there is no invocation for ` +
            "this operation to be performed under. Nothing was asked of the host"
        : `${element} has already performed its one external operation, so performing again ` +
            "would repeat work this invocation acknowledged. Nothing was asked of the host",
    );
    this.reason = reason;
  }
}

/**
 * Handed to the policy rather than applied around it, because only the policy
 * knows which of its members the authored element asked for: a facade of two
 * operations where the document wrote one is still one invocation.
 */
export interface InvocationGate {
  once<T>(operation: () => Operation<T>): Operation<T>;
}

export type BindOperations<Operations> = (site: string, gate: InvocationGate) => Operations;

export type ComponentBody<Operations> = (
  props: Record<string, Json>,
  operations: Operations,
) => Operation<unknown>;

export interface BoundComponent<Operations> {
  /** The element a refusal names, as a document writes it. */
  readonly element: string;
  readonly bind: BindOperations<Operations>;
  readonly body: ComponentBody<Operations>;
}

interface Live {
  open: boolean;
  used: boolean;
}

/**
 * No identity is authenticated here because there is nothing for one to name:
 * the operations are the public feature Apis, and whichever provider the host
 * installed answers them.
 */
export function unboundComponent<Operations>(
  element: string,
  operations: (gate: InvocationGate) => Operations,
  body: ComponentBody<Operations>,
): FunctionComponent {
  return function* (props: Record<string, Json>): Operation<unknown> {
    const live: Live = { open: false, used: false };
    yield* ensure(() => {
      live.open = false;
    });
    const facade = operations({
      once: <T>(operation: () => Operation<T>): Operation<T> => performed(live, element, operation),
    });
    live.open = true;
    return yield* body(props, facade);
  };
}

/**
 * Built once per execution, from the authenticator that execution minted for
 * this component name, and invoked by the engine with the invocation it issued.
 */
export function boundComponent<Operations>(
  claim: IdentityClaimant,
  bound: BoundComponent<Operations>,
): FunctionComponent {
  return function* (
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<unknown> {
    // In the frame the engine entered, and before the body reaches any content
    // of its own: a projecting ancestor is ineligible for an invocation.
    const site = yield* claim(invocation);
    const live: Live = { open: false, used: false };
    // Armed before the facade exists, because an invocation halted while it is
    // registering this would unwind with no revocation on it at all.
    yield* ensure(() => {
      live.open = false;
    });
    const operations = bound.bind(site, {
      once: <T>(operation: () => Operation<T>): Operation<T> =>
        performed(live, bound.element, operation),
    });
    live.open = true;
    return yield* bound.body(props, operations);
  };
}

function* performed<T>(live: Live, element: string, operation: () => Operation<T>): Operation<T> {
  if (!live.open) {
    throw new BoundOperationError(element, "ended");
  }
  if (live.used) {
    throw new BoundOperationError(element, "spent");
  }
  live.used = true;
  return yield* operation();
}
