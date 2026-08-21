/**
 * Proof that a `<Test>` is running under a complete testing activation
 * (specs/testing-spec.md).
 *
 * `TestApi.testing` is public, replaceable policy. It answers whether testing
 * mode is on, and that is all it can answer: a boolean cannot say whether
 * anything is there to collect results, flush the last one, and decide the
 * run's outcome. Registration plus a bare `true` therefore runs test bodies
 * into nothing — the side effects happen and the run reports success with no
 * results.
 *
 * Two things establish the whole of testing, and nothing else does: a
 * `useTesting()` session for one root execution, and a `<Testing>` element for
 * a lexical subtree. Each calls `activateTesting()` once it owns the collector
 * that makes it complete.
 *
 * Where the requirement is enforced is canonical core's, and deliberately so.
 * Installing this package puts a guard on core's `TestActivation` seam, and
 * core's own `<Test>` takes that decision before it mints a harness and before
 * it dispatches the public `TestBehavior` chain. Asking inside that chain would
 * put the question behind a handler entitled to answer without delegating,
 * which is a handler entitled to skip it. What stays here is everything the
 * decision is *about*: the policy read, the proof, and the refusal.
 *
 * ## Why the proof is not a value
 *
 * The activation operation's name is stable, because a copy of this package
 * loaded beside another must compose with it. A stable name is reachable by
 * anyone, so the name cannot be the authority: a same-name descriptor, a
 * middleware return, a boolean or a structural marker would each let something
 * outside this package declare a complete boundary.
 *
 * Authority is a conjunction instead, and no part of it is published. Each
 * `<Test>` mints a private request nobody else holds; each live boundary mints
 * a private credential nobody else can construct; and the terminal that records
 * acceptance is the default handler of an Api instance created for that one
 * call and reachable from nowhere else. A handler that answers without
 * delegating, substitutes either argument, reconstructs the Api name, delegates
 * twice, or replays a retained request or a retired credential can refuse the
 * call — none of them can make that terminal record it as accepted.
 */

import { ensure } from "effection";
import type { Operation } from "effection";
import { type Api, createApi } from "@effectionx/context-api";
import { Test } from "./test-api.ts";

/** What a `<Test>` reports when nothing complete activated testing. */
export class IncompleteTestingActivationError extends Error {
  override name = "IncompleteTestingActivationError";

  constructor() {
    super(
      "<Test> reached testing mode without a complete testing activation. Use useTesting() " +
        "for one root document execution or <Testing> for a lexical subtree; " +
        "installTestingComponents() and Test.around({ testing: () => true }) do not activate " +
        "testing.",
    );
  }
}

/** Whether a failure is, or wraps, the incomplete-activation refusal. */
export function isIncompleteTestingActivationError(
  error: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (error instanceof IncompleteTestingActivationError) {
    return true;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (
    error instanceof AggregateError &&
    error.errors.some((member) => isIncompleteTestingActivationError(member, seen))
  ) {
    return true;
  }
  return error instanceof Error && error.cause !== undefined
    ? isIncompleteTestingActivationError(error.cause, seen)
    : false;
}

/**
 * One `<Test>`'s claim on a complete activation.
 *
 * Accepted means delivered exactly once, to this claim, carrying a live
 * boundary credential. Delivering the same request a second time is a protocol
 * violation rather than a second proof, so it withdraws the claim instead of
 * confirming it.
 */
class Claim {
  deliveries = 0;
  credentialed = false;

  get accepted(): boolean {
    return this.deliveries === 1 && this.credentialed;
  }
}

/**
 * A live complete boundary, as that boundary's own middleware presents it.
 *
 * Never constructed outside `activateTesting()` and never handed to the caller
 * of anything: a boundary's middleware passes it inward, so it exists only
 * between that middleware and whatever it delegates to.
 */
class ActivationCredential {
  #live = true;

  static retire(credential: ActivationCredential): void {
    credential.#live = false;
  }

  /** Whether this class built `value` and its boundary has not ended. */
  static live(value: unknown): boolean {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #live in value && value.#live;
    } catch {
      // A revoked proxy, or one whose `has` trap refuses. Not one of ours.
      return false;
    }
  }
}

/** One `<Test>`'s request for proof, carrying a claim only its terminal holds. */
class ActivationRequest {
  readonly #claim: Claim;

  constructor(claim: Claim) {
    this.#claim = claim;
    Object.freeze(this);
  }

  /**
   * Deliver `request` to `claim`, with whatever credential arrived beside it.
   *
   * The expected claim is supplied by the caller rather than read off the
   * request: a request another `<Test>` issued is also canonical, and settling
   * it on its own claim would let one invocation's proof answer another's.
   */
  static deliver(request: unknown, claim: Claim, credential: unknown): void {
    if (!ActivationRequest.own(request) || request.#claim !== claim) {
      return;
    }
    claim.deliveries += 1;
    claim.credentialed = ActivationCredential.live(credential);
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is ActivationRequest {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #claim in value;
    } catch {
      return false;
    }
  }
}

interface CompleteActivationApi {
  prove(request: ActivationRequest, credential?: unknown): Operation<void>;
}

const COMPLETE_ACTIVATION = "executablemd.testing.complete-activation";

/**
 * The shared descriptor, whose only job is to hold the middleware chain.
 *
 * Its default refuses, for the reason every reachable descriptor here refuses:
 * this is the one instance anybody can name, so it must not be a terminal that
 * would settle a request handed to it.
 */
const CompleteActivation: Api<CompleteActivationApi> = createApi<CompleteActivationApi>(
  COMPLETE_ACTIVATION,
  {
    // deno-lint-ignore require-yield
    *prove(): Operation<void> {
      throw new IncompleteTestingActivationError();
    },
  },
);

/**
 * Establish complete testing activation for the current scope.
 *
 * Called by a `useTesting()` session and by a `<Testing>` invocation, each once
 * it owns the collector that makes it complete. Nesting is ordinary lexical
 * composition: an inner boundary replaces one live credential with another, and
 * either proves a complete package-owned boundary.
 *
 * Retirement is registered before the credential can reach anything, so a
 * boundary that ends — or one halted while it was being established — leaves
 * nothing a later sibling could delegate with.
 */
export function* activateTesting(): Operation<void> {
  const credential = new ActivationCredential();
  yield* ensure(() => ActivationCredential.retire(credential));
  yield* CompleteActivation.around(
    {
      *prove([request], next) {
        // The supplied credential is discarded rather than forwarded: what this
        // boundary vouches for is itself, and a handler outside it holds
        // nothing this delegation would carry inward.
        yield* next(request, credential);
      },
    },
    { at: "min" },
  );
  yield* Test.around({ testing: () => true }, { at: "min" });
}

/**
 * Refuse unless a complete testing activation encloses this call.
 *
 * The terminal is the default handler of an Api instance created here, so it is
 * the only thing that can mark this call's request accepted, and it exists only
 * for the length of this call.
 */
export function* requireCompleteTestingActivation(): Operation<void> {
  const claim = new Claim();
  const terminal = createApi<CompleteActivationApi>(COMPLETE_ACTIVATION, {
    // deno-lint-ignore require-yield
    *prove(request: ActivationRequest, credential?: unknown): Operation<void> {
      ActivationRequest.deliver(request, claim, credential);
    },
  });
  // Whatever a handler returns is not a proof, so it is not read.
  yield* terminal.operations.prove(new ActivationRequest(claim));
  if (!claim.accepted) {
    throw new IncompleteTestingActivationError();
  }
}
