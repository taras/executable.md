/**
 * The one handoff between a repository component's invocation and the host
 * policy that performs it.
 *
 * Every authored repository operation — `<Git.Push />`, `<Issue>`,
 * `<PullRequest>` and the three pull-request evidence reads — has one
 * implementation, and that implementation asks a semantic feature operation for
 * its work. What differs between an ordinary run, a workflow run and a REPL
 * entry is not the component: it is how the operation it asks is performed,
 * retained and admitted. This is where those two meet.
 *
 * ## What the binding owns, and what it never touches
 *
 * It authenticates the actual invocation canonical core issued, once, in the
 * engine frame the component was entered in — before the component projects any
 * content, because a projecting ancestor is deliberately ineligible for one.
 * It then builds this invocation's own operation facade from the host's policy
 * and runs the one shared body against it.
 *
 * It interprets no prop, expands no content, names no durable record and reads
 * nothing of the document. The site it authenticated is private to the policy
 * it hands it to: no facade method answers with it, no request carries it and
 * no Context holds it.
 *
 * ## The facade ends with its invocation
 *
 * Revocation is armed before the facade can be used, so an invocation halted
 * while it is being built leaves nothing usable behind, and it runs on success,
 * failure and cancellation alike. A facade kept past its own invocation
 * performs nothing, and one authored operation performs one retained
 * operation — a second call through the same facade is refused rather than
 * repeating external work this invocation has already asked for.
 */

import { ensure } from "effection";
import type { Operation } from "effection";
import type { ComponentInvocation, FunctionComponent } from "@executablemd/core";
import type { IdentityClaimant } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";

/** Why a facade refused rather than performing. */
export type FacadeRefusal =
  /** The invocation that owns this facade has finished. */
  | "ended"
  /** This invocation already performed its one retained operation. */
  | "spent";

/**
 * A facade asked to perform where it names no invocation to perform for.
 *
 * One sentence for one boundary, parameterized by the element that was written,
 * because this is the binding's own refusal rather than any feature's: neither
 * condition is something a document can arrange, a provider can answer or a
 * tracker can explain. Every feature keeps its own vocabulary for every refusal
 * it does decide.
 */
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
 * What a host policy performs one invocation's work through.
 *
 * Handed to the policy rather than applied around it, because only the policy
 * knows which of its members is the operation an authored element asks for: a
 * facade of two operations where the document wrote one is still one
 * invocation, and the second member exists to be refused.
 */
export interface InvocationGate {
  /** Perform this invocation's one retained operation. */
  once<T>(operation: () => Operation<T>): Operation<T>;
}

/** How one host builds the operations one authenticated invocation may use. */
export type BindOperations<Operations> = (site: string, gate: InvocationGate) => Operations;

/** The one authored implementation of a repository operation. */
export type ComponentBody<Operations> = (
  props: Record<string, Json>,
  operations: Operations,
) => Operation<unknown>;

/** One authored operation, as its declaration states it. */
export interface BoundComponent<Operations> {
  /** The element a refusal names, as a document writes it. */
  readonly element: string;
  /** The host policy this execution selected for this operation. */
  readonly bind: BindOperations<Operations>;
  /** The one implementation, which receives only semantic operations. */
  readonly body: ComponentBody<Operations>;
}

/** Whether this invocation's facade is usable, and whether it has been used. */
interface Live {
  open: boolean;
  used: boolean;
}

/**
 * The implementation an ordinary registration carries for one authored
 * operation.
 *
 * The same body, over the same kind of facade, for a host that retains nothing
 * named after an invocation. No identity is authenticated because there is
 * nothing for one to name: the operations are the public feature Apis, and whichever
 * provider the host installed is what answers. The facade still ends with the
 * invocation, so a body that kept one performs nothing afterwards.
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
 * The implementation a declaration registers for one authored operation.
 *
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
    // Authenticated here, in the frame the engine entered, and before the body
    // reaches any content of its own.
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
