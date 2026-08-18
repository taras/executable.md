/**
 * The authority one canonical `<Test>` invocation holds, and nothing else does.
 *
 * A Markdown test can run another document as a real root execution
 * (specs/testing-spec.md). That is a capability no ordinary component may have:
 * a nested root execution imports its own root, selects its own journal, owns
 * its own scope and — under the workflow profile — writes durable run state. If
 * the thing that decided who may do it were a name, a prop, a public Api or a
 * replaceable Context, then a repository `Test.md`, a package that registers
 * `Test`, or middleware installed anywhere would decide it too.
 *
 * So the decision is made where the same decision is already made for a checked
 * command failure: canonical core recognizes its own `<Test>` definition
 * structurally, and only that invocation mints a harness. What core mints is
 * this — an opaque object with a private field, so nothing can construct one,
 * and a lifetime bounded by the invocation that minted it, so nothing can keep
 * one.
 *
 * ## What this is not
 *
 * It is not a transport that hides. It is published on a context, and a context
 * is keyed by name, so a `.ts` component running inside a test could name the
 * same context and read the same value. That is not the boundary. The boundary
 * is that holding a harness is worth nothing on its own: spending one is
 * `@executablemd/testing`'s private path, and running the child at all needs a
 * trusted host profile the CLI installs. What this rules out is the thing a
 * name-keyed context cannot rule out for itself — a *forged* harness, and a
 * *real* harness used after the test that owned it is over. Both are refused
 * here, by identity and by lifetime, rather than by asking the value what it is.
 *
 * ## Single use
 *
 * An authorization is spent once. Two nested executions are two authorizations,
 * and a replayed or copied one is a refusal rather than a second child — the
 * same rule, and for the same reason, as the one-use execution request canonical
 * core issues around every document (`execution-request.ts`).
 */

import { createContext, ensure } from "effection";
import type { Context, Operation } from "effection";

/** A harness was forged, kept past its test, or spent twice. */
export class TestHarnessError extends Error {
  override name = "TestHarnessError";

  constructor(problem: string) {
    super(
      `A nested execution ${problem}. Only an invocation of canonical <Test> holds this ` +
        "authority, and only for as long as that invocation lasts.",
    );
  }
}

/** One `<Test>` invocation's private state. */
class Invocation {
  live = true;
}

/**
 * A single-use authorization to run one nested execution.
 *
 * Opaque: `spend()` is the whole of what a holder may do with it, and spending
 * proves only that canonical core issued it and that the test it belongs to is
 * still running.
 */
export class TestHarnessAuthorization {
  readonly #invocation: Invocation;
  #spent = false;

  constructor(invocation: Invocation) {
    this.#invocation = invocation;
  }

  /**
   * Consume this authorization, once.
   *
   * Order matters: a spent authorization is refused before an expired one, so
   * the report names what the holder actually did rather than what happened to
   * the test afterwards.
   */
  spend(): void {
    if (this.#spent) {
      throw new TestHarnessError("spent one authorization twice");
    }
    if (!this.#invocation.live) {
      throw new TestHarnessError("was authorized by a test that has already finished");
    }
    this.#spent = true;
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is TestHarnessAuthorization {
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

/**
 * What a canonical `<Test>` invocation may authorize.
 *
 * One member, and it hands back nothing reusable. A harness is a permission to
 * ask, not a handle on the test: it reaches no scope, no bindings, no journal
 * and no result.
 */
export class TestHarness {
  readonly #invocation: Invocation;

  constructor(invocation: Invocation) {
    this.#invocation = invocation;
  }

  /** Authorize one nested execution. Refused once the test has finished. */
  authorize(): TestHarnessAuthorization {
    if (!this.#invocation.live) {
      throw new TestHarnessError("was requested after its test had already finished");
    }
    return new TestHarnessAuthorization(this.#invocation);
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is TestHarness {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #invocation in value;
    } catch {
      return false;
    }
  }
}

/**
 * The harness of the `<Test>` invocation currently expanding, if there is one.
 *
 * Named, like every Effection context, so a second loaded copy of this module
 * reads what the copy that is expanding the document published. What the name
 * does not buy anybody is a harness: a value planted here that this module did
 * not build is refused by `useTestHarness()`.
 */
const CurrentHarness: Context<unknown> = createContext<unknown>("core.test.harness", undefined);

/**
 * Mint this invocation's harness and publish it for the body it is about to
 * expand.
 *
 * Called from canonical core's own `<Test>`, in the invocation's own frame, so
 * the harness is reachable from everything the test expands and from nothing
 * after it. Expiry is registered before the value is published: a harness that
 * outlives its test would be a test's authority held by whatever kept it.
 */
export function* provideTestHarness(): Operation<void> {
  const invocation = new Invocation();
  yield* ensure(() => {
    invocation.live = false;
  });
  yield* CurrentHarness.set(new TestHarness(invocation));
}

/**
 * The harness this scope may spend, or `undefined` outside a canonical test.
 *
 * `undefined` rather than a throw, because "there is no harness here" is the
 * ordinary answer for every document that is not a test, and the caller has a
 * better sentence to say about it than this module does. A value that is not
 * one of ours is the same answer: it says nothing about who planted it.
 */
export function* useTestHarness(): Operation<TestHarness | undefined> {
  const published = yield* CurrentHarness.get();
  return TestHarness.own(published) ? published : undefined;
}
