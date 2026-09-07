/**
 * Tier PCL — the lifetime of a protected body's one content projection.
 *
 * `PCL` rather than `PC`, which is the Plan component suite's.
 *
 * These guards are unreachable from a document. Only canonical `<Evaluate>`
 * consumes a projector and it consumes one once, so a black-box test cannot
 * make a second call, cannot retain a callback past a body, and cannot race
 * two. A test that could would need a protected component of its own, which is
 * a hole in the tier the projector exists inside. So the state machine is a
 * module and this is its unit test.
 *
 * Every row counts how many times the *underlying* operation ran, because that
 * is the fact that matters: a lease that refused with the right error while
 * still projecting would satisfy an error-shape assertion and none of these.
 * The rows assert the error class and the timing rather than the diagnostic
 * prose, which is free to improve.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";

import { ComponentInvocationError } from "../src/invocation-identity.ts";
import { protectedContentLease } from "../src/protected-content.ts";
import type { SyntaxReference } from "../src/syntax-reference.ts";

/**
 * A structurally complete reference that answers nothing interesting.
 *
 * The lease never reads it — it forwards whatever it was handed — so what
 * matters is that this *is* a `SyntaxReference` rather than an object asserted
 * into the position of one. A cast here would let the lease's parameter type
 * drift without any row noticing.
 */
const REFERENCE: SyntaxReference = {
  // deno-lint-ignore require-yield
  *symbols(): Operation<string> {
    return "";
  },
  // deno-lint-ignore require-yield
  *documentation(): Operation<string> {
    return "";
  },
  available(): SyntaxReference {
    return REFERENCE;
  },
};

const PROJECTED = "the exact projected bytes";

/** One underlying operation, with a call count and an optional hold. */
function counted(options: { hold?: () => Operation<void>; fail?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    *perform(): Operation<string> {
      calls.push("performed");
      if (options.hold !== undefined) {
        yield* options.hold();
      }
      if (options.fail !== undefined) {
        throw new Error(options.fail);
      }
      return PROJECTED;
    },
  };
}

/** What one call refused with, or `undefined` when it did not refuse. */
function* refusalOf(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("Tier PCL — one projection, then nothing", () => {
  it("PCL1: the first call projects exactly, the second refuses, and one ran", function* () {
    const underlying = counted();
    const lease = protectedContentLease("Evaluate", underlying.perform);

    expect(yield* lease.project(REFERENCE)).toBe(PROJECTED);

    const second = yield* refusalOf(lease.project(REFERENCE));
    expect(second).toBeInstanceOf(ComponentInvocationError);
    // The refusal did not merely report: it did not project.
    expect(underlying.calls).toHaveLength(1);
  });

  it("PCL2: a closed lease refuses, and the operation is never constructed", function* () {
    const underlying = counted();
    const lease = protectedContentLease("Evaluate", underlying.perform);

    // Built while open, closed before it is interpreted. An operation is inert
    // until something runs it, so this is the shape a body that returned an
    // unstarted operation would leave behind.
    const pending = lease.project(REFERENCE);
    lease.close();

    const refused = yield* refusalOf(pending);
    expect(refused).toBeInstanceOf(ComponentInvocationError);
    expect(underlying.calls).toHaveLength(0);
  });

  it("PCL3: a retained callback called after close refuses", function* () {
    const underlying = counted();
    const lease = protectedContentLease("Evaluate", underlying.perform);
    // Exactly what a body keeping the callback in a closure, on a returned
    // object, or in something it spawned would hold.
    const retained = lease.project;

    lease.close();

    const refused = yield* refusalOf(retained(REFERENCE));
    expect(refused).toBeInstanceOf(ComponentInvocationError);
    expect(underlying.calls).toHaveLength(0);
  });

  it("PCL4: a second call while the first is suspended refuses", function* () {
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    const underlying = counted({
      *hold() {
        reached.resolve();
        yield* release.operation;
      },
    });
    const lease = protectedContentLease("Evaluate", underlying.perform);

    const first = yield* spawn(() => lease.project(REFERENCE));
    // The first call is inside the underlying operation and has not returned.
    yield* reached.operation;

    const concurrent = yield* refusalOf(lease.project(REFERENCE));
    expect(concurrent).toBeInstanceOf(ComponentInvocationError);
    // Consumption happened before the first call could suspend, so the
    // concurrent one found a spent lease rather than an open one.
    expect(underlying.calls).toHaveLength(1);

    release.resolve();
    expect(yield* first).toBe(PROJECTED);
    expect(underlying.calls).toHaveLength(1);
  });

  it("PCL5: a failed first call leaves the lease spent", function* () {
    const underlying = counted({ fail: "the producer refused" });
    const lease = protectedContentLease("Evaluate", underlying.perform);

    const failure = yield* refusalOf(lease.project(REFERENCE));
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("the producer refused");

    // A retry is not a second chance: the content was projected, and what
    // failed was the projection. Re-running it would render the document's
    // children twice.
    const retry = yield* refusalOf(lease.project(REFERENCE));
    expect(retry).toBeInstanceOf(ComponentInvocationError);
    expect(underlying.calls).toHaveLength(1);
  });

  it("PCL6: a cancelled first call leaves the lease spent", function* () {
    const reached = withResolvers<void>();
    const underlying = counted({
      *hold() {
        reached.resolve();
        yield* suspend();
      },
    });
    const lease = protectedContentLease("Evaluate", underlying.perform);

    const first = yield* spawn(() => lease.project(REFERENCE));
    yield* reached.operation;
    yield* first.halt();

    const retry = yield* refusalOf(lease.project(REFERENCE));
    expect(retry).toBeInstanceOf(ComponentInvocationError);
    expect(underlying.calls).toHaveLength(1);
  });

  it("PCL7: two leases are independent", function* () {
    const one = counted();
    const other = counted();
    const first = protectedContentLease("Evaluate", one.perform);
    const second = protectedContentLease("Evaluate", other.perform);

    expect(yield* first.project(REFERENCE)).toBe(PROJECTED);
    // Spending one does not spend the other. Module-scoped state shared between
    // leases — a file-level flag, a registry keyed by name — would refuse here.
    expect(yield* second.project(REFERENCE)).toBe(PROJECTED);

    expect(yield* refusalOf(first.project(REFERENCE))).toBeInstanceOf(ComponentInvocationError);
    expect(yield* refusalOf(second.project(REFERENCE))).toBeInstanceOf(ComponentInvocationError);
    expect(one.calls).toHaveLength(1);
    expect(other.calls).toHaveLength(1);
  });

  it("PCL8: closing twice, and closing after spending, stay refusals", function* () {
    const underlying = counted();
    const lease = protectedContentLease("Evaluate", underlying.perform);

    expect(yield* lease.project(REFERENCE)).toBe(PROJECTED);
    lease.close();
    lease.close();
    yield* sleep(0);

    expect(yield* refusalOf(lease.project(REFERENCE))).toBeInstanceOf(ComponentInvocationError);
    expect(underlying.calls).toHaveLength(1);
  });
});
