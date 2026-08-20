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
 * ## Where it goes, and how
 *
 * Nowhere anybody can ask for it. There is no reader, no exported accessor and
 * no context holding a harness: an authority published on a name is an
 * authority every same-name context, every loaded copy and every component
 * running inside a test can take, and this architecture keeps contextual
 * surfaces for policy and composition only.
 *
 * So the capability is *delivered*, not published. A trusted host attaches a
 * `TestHarnessInstaller` to the execution — a plain function the host holds and
 * passes, the same way it attaches an admission or a preparation — and
 * canonical `<Test>` calls it, inside the invocation, with that invocation's
 * harness. What the installer does with it is close over it. Nothing that did
 * not receive the call has it, and there is nowhere to go and read it.
 *
 * The installers reach `<Test>` through a context, because a component function
 * is reached through the engine and there is no other way down. That context
 * carries no authority: it holds the host's functions, and calling one requires
 * a harness that only this module mints. It is also branded, so a value planted
 * under the same name is refused rather than handed a capability — a shadowing
 * attempt ends with no harness installed, which is the safe direction.
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
import type { Json } from "./types.ts";

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

  /**
   * Create a component definition that receives this test's private invocation
   * binding channel directly from the engine.
   */
  component(
    component: (props: Record<string, Json>, binding: TestHarnessBinding) => Operation<unknown>,
  ): TestHarnessComponentDefinition {
    return new TestHarnessComponentDefinition(component);
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
 * What a trusted host attaches in order to receive one test's harness.
 *
 * Called once per canonical `<Test>` invocation, inside that invocation, before
 * its body expands. The harness it is handed is that invocation's and expires
 * with it, so an installer that keeps one keeps something already dead.
 */
export type TestHarnessInstaller = (harness: TestHarness) => Operation<void>;

export interface TestHarnessBinding {
  /** Whether this exact invocation was written with `as`. */
  has(): boolean;
  /** Publish this invocation's outcome once, before its assertion body expands. */
  publish(value: unknown): Operation<void>;
}

type TestHarnessComponent = (
  props: Record<string, Json>,
  binding: TestHarnessBinding,
) => Operation<unknown>;

export class TestHarnessComponentDefinition {
  readonly #component: TestHarnessComponent;

  constructor(component: TestHarnessComponent) {
    this.#component = component;
  }

  invoke(props: Record<string, Json>, binding: TestHarnessBinding): Operation<unknown> {
    return this.#component(props, binding);
  }

  static own(value: unknown): value is TestHarnessComponentDefinition {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #component in value;
    } catch {
      return false;
    }
  }
}

/**
 * The installers this execution runs, as a value only this module builds.
 *
 * Branded on purpose, and against the ordinary rule that a context value must
 * cross loaded copies unbranded. Nothing here is meant to cross: these are the
 * functions one execution's own host attached, read by the same copy of core
 * that is expanding the document. What branding buys is that a value somebody
 * planted under this name is not mistaken for the host's — the harness is never
 * handed to it, and `<Test>` proceeds with no harness at all.
 */
class Attached {
  readonly #installers: readonly TestHarnessInstaller[];

  constructor(installers: readonly TestHarnessInstaller[]) {
    this.#installers = Object.freeze([...installers]);
  }

  /** The functions this execution's host attached, in attachment order. */
  get installers(): readonly TestHarnessInstaller[] {
    return this.#installers;
  }

  /** Whether this class built `value`, answered without trusting it. */
  static own(value: unknown): value is Attached {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return #installers in value;
    } catch {
      return false;
    }
  }
}

const AttachedInstallers: Context<unknown> = createContext<unknown>(
  "core.test.harness-installers",
  undefined,
);

/**
 * Publish what this execution's host attached.
 *
 * Called by canonical execution before the document runs, with the functions it
 * captured by value from the installations — so what a `<Test>` can deliver to
 * is fixed before any installation, middleware or document code exists.
 */
export function* provideTestHarnessInstallers(
  installers: readonly TestHarnessInstaller[],
): Operation<void> {
  yield* AttachedInstallers.set(new Attached(installers));
}

/**
 * Mint this invocation's harness and deliver it to whoever the host attached.
 *
 * Called from canonical core's own `<Test>`, in the invocation's own frame, so
 * an installer's registrations land where the test's body will see them and are
 * removed with the test. Expiry is registered before the capability exists: a
 * harness that outlived its test would be a test's authority held by whatever
 * kept it.
 *
 * With nothing attached this mints nothing and does nothing. A document run by
 * a host that never attached an installer therefore has no nested-execution
 * authority anywhere in it, which is the default.
 */
export function* installTestHarness(): Operation<void> {
  const attached = yield* AttachedInstallers.get();
  if (!Attached.own(attached) || attached.installers.length === 0) {
    return;
  }
  const invocation = new Invocation();
  yield* ensure(() => {
    invocation.live = false;
  });
  const harness = new TestHarness(invocation);
  for (const install of attached.installers) {
    yield* install(harness);
  }
}
