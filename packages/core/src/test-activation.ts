/**
 * Whether one canonical `<Test>` invocation may proceed at all
 * (specs/testing-spec.md).
 *
 * What a test *does* arrives through `TestBehavior`, and that is ordinary
 * public middleware: a handler composed around it may observe, wrap, refuse or
 * answer without delegating, and answering without delegating is a legitimate
 * thing for it to do — a second loaded copy of core supplies a test's behavior
 * exactly that way.
 *
 * Which is why the question *may this run* cannot be asked inside that chain. A
 * handler that answers for the behavior would answer for the decision too, and
 * a test that should have been refused would instead complete as whatever the
 * handler returned. So the decision is taken here, before the harness is minted
 * and before the behavior chain is dispatched, by the invocation itself.
 *
 * Core does not own testing, so it does not make the decision — it *takes* one.
 * A testing package installs a handler that reads its own activation policy and
 * refuses by throwing; core only insists that the chain it dispatched reached
 * the end. With nothing installed the terminal is reached immediately, so core
 * on its own, or core beside a package that supplies behavior and nothing else,
 * is unaffected.
 *
 * The request is the capability, and it is one-use. It carries a private
 * reference to one invocation, so a handler that answers without delegating,
 * substitutes a look-alike, replays another invocation's request, or delegates
 * twice leaves the decision unmade — and an unmade decision refuses. Fail-closed
 * is the whole point: the failure mode this exists to prevent is a test that
 * quietly did not run.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

/**
 * Whether a failure is, or wraps, a refusal of the activation decision itself.
 *
 * A predicate rather than the class, because what a testing package needs is to
 * recognize this exact refusal and nothing else. The class, the request, and
 * the decision state stay here: recognizing a failure is not being able to
 * cause one.
 *
 * A `<Test>` whose decision was refused never ran, so this is a configuration
 * failure of the composition and never a test outcome. A package that contains
 * test failures reports it outward unchanged instead of absorbing it — absorbing
 * it would let a run that never ran a test end successfully.
 */
export function isTestActivationProtocolError(error: unknown): boolean {
  return carriesActivationError(error, new Set());
}

function carriesActivationError(error: unknown, seen: Set<unknown>): boolean {
  if (error instanceof TestActivationError) {
    return true;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (
    error instanceof AggregateError &&
    error.errors.some((member) => carriesActivationError(member, seen))
  ) {
    return true;
  }
  return error instanceof Error && error.cause !== undefined
    ? carriesActivationError(error.cause, seen)
    : false;
}

/** A protocol violation by whoever is composed around the activation decision. */
class TestActivationError extends Error {
  override name = "TestActivationError";

  constructor(problem: string) {
    super(
      `Test activation middleware ${problem}. A handler may read the request, refuse by ` +
        "throwing, and delegate it once; only the invocation that issued one decides.",
    );
  }
}

/** One `<Test>` invocation's private decision state. */
class Invocation {
  decided = false;
}

/**
 * What an activation handler is given, and the whole of what it may do with it.
 *
 * Opaque on purpose: it names nothing about the test and answers nothing about
 * the run. Delegating it is the only thing it is for.
 */
export class TestActivationRequest {
  readonly #invocation: Invocation;

  constructor(invocation: Invocation) {
    this.#invocation = invocation;
    Object.freeze(this);
  }

  /**
   * Take this request's decision on behalf of `invocation`, once.
   *
   * The expected invocation is supplied by the caller rather than read off the
   * request: a request another `<Test>` issued is also canonical, and accepting
   * it would let one invocation's decision stand in for another's.
   */
  static decide(request: unknown, invocation: Invocation): void {
    if (!TestActivationRequest.own(request)) {
      throw new TestActivationError("delegated a request no <Test> issued");
    }
    if (request.#invocation !== invocation) {
      throw new TestActivationError("delegated a request another <Test> issued");
    }
    if (invocation.decided) {
      throw new TestActivationError("delegated an activation request more than once");
    }
    invocation.decided = true;
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is TestActivationRequest {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #invocation in value;
    } catch {
      // A revoked proxy, or one whose `has` trap refuses. Not one of ours.
      return false;
    }
  }
}

export interface TestActivationApi {
  /**
   * Decide whether this `<Test>` invocation may proceed.
   *
   * Called once per canonical `<Test>`, before its harness exists and before
   * `TestBehavior` is dispatched. A handler reads whatever activation policy it
   * owns, refuses by throwing, and otherwise delegates the exact request. It
   * returns nothing, and nothing it returns is read.
   */
  require(request: TestActivationRequest): Operation<void>;
}

/**
 * Test activation Api — the seam a testing package installs its guard on.
 *
 * Its default always refuses. A stable name shares the middleware context, so a
 * package loaded beside a second copy of core installs its guard exactly as it
 * always would; what a name does not share is the default handler, and that is
 * where the decision sits. Each invocation dispatches through a private
 * same-name instance of its own, so calling this descriptor with a captured
 * request decides nothing.
 */
export const TestActivation: Api<TestActivationApi> = createApi<TestActivationApi>(
  "TestActivation",
  {
    // deno-lint-ignore require-yield
    *require(_request: TestActivationRequest): Operation<void> {
      throw new TestActivationError("was invoked outside a <Test> invocation");
    },
  },
);

/**
 * Take this invocation's activation decision, or refuse it.
 *
 * The terminal is the default handler of an Api instance created here and
 * reachable from nowhere else, so reaching it is what "the chain agreed" means.
 * Nothing is installed by default, and then it is reached immediately.
 */
export function* requireTestActivation(): Operation<void> {
  const invocation = new Invocation();
  const terminal = createApi<TestActivationApi>("TestActivation", {
    // deno-lint-ignore require-yield
    *require(request: TestActivationRequest): Operation<void> {
      TestActivationRequest.decide(request, invocation);
    },
  });
  // Whatever a handler returns is not a decision, so it is not read.
  yield* terminal.operations.require(new TestActivationRequest(invocation));
  if (!invocation.decided) {
    throw new TestActivationError("answered the activation request without delegating it");
  }
}
