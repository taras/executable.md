/**
 * Tier PB — permission bridge tests (specs/acp-client-spec.md
 * §Permissions): operation-based decisions that fail closed with ACP
 * cancellation on missing/torn-down registrations, policy errors,
 * aborts, and unknown option ids. Promise adaptation exists only at
 * the simulated ACPX callback boundary.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import {
  createScope,
  ensure,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Scope } from "effection";
import { Agent } from "@executablemd/core";
import type { Session } from "@executablemd/core";
import type { AcpPermissionRequest } from "acpx/runtime";
import { createPermissionBridge } from "../src/permission-bridge.ts";

interface Release {
  pending: boolean;
}

/**
 * A long-lived scope whose `requestPermission` policy blocks until
 * `release.pending` clears, so two policies can be genuinely in-flight
 * at once. The published scope is the frame the middleware was
 * installed on, so the bridge's `scope.run(policy)` child inherits it.
 */
function* startPolicyScope(optionId: string, release: Release): Operation<Scope> {
  const [outer, destroy] = createScope();
  yield* ensure(() => until(destroy()));
  const ready = withResolvers<Scope>();
  outer.run(function* () {
    yield* Agent.around(
      {
        *requestPermission() {
          while (release.pending) {
            yield* sleep(1);
          }
          return { outcome: "selected", optionId };
        },
      },
      { at: "min" },
    );
    ready.resolve(yield* useScope());
    yield* suspend();
  });
  return yield* ready.operation;
}

const SESSION: Session = { sessionKey: "xmd:v1:codex:abc:default", cwd: "/work" };

function makeAcpRequest(sessionId: string): AcpPermissionRequest {
  return {
    sessionId,
    inferredKind: "edit",
    raw: {
      sessionId,
      toolCall: { toolCallId: "call-1", title: "write file", rawInput: { path: "a.ts" } },
      options: [
        { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
        { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
      ],
    },
  };
}

const signal = new AbortController().signal;

/** A refresh that keeps the registration's ACP session id unchanged. */
function keep(id: string): () => Operation<{ acpSessionId: string }> {
  // deno-lint-ignore require-yield
  return function* () {
    return { acpSessionId: id };
  };
}

describe("Tier PB — permission bridge", () => {
  it("PB1: requests re-enter the registered scope where scoped middleware answers", function* () {
    const bridge = createPermissionBridge();
    const seen: string[] = [];
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *requestPermission([request]) {
          seen.push(request.toolCall.kind ?? "none");
          return { outcome: "selected", optionId: "opt-allow" };
        },
      },
      { at: "min" },
    );
    const registration = bridge.register(
      "backend-1",
      yield* useScope(),
      SESSION,
      keep("backend-1"),
    );
    try {
      const result = yield* bridge.decision(makeAcpRequest("backend-1"), signal);
      expect(seen).toEqual(["edit"]);
      expect(result).toEqual({ outcome: "allow_once" });
    } finally {
      registration.unregister();
    }
  });

  it("PB2: two simultaneously active scopes route concurrent decisions independently", function* () {
    const bridge = createPermissionBridge();
    yield* scoped(function* () {
      // Both scopes are live at once; each blocks in its own policy
      // until released, so the decisions genuinely overlap.
      const releaseA = { pending: true };
      const releaseB = { pending: true };
      const scopeA = yield* startPolicyScope("opt-allow", releaseA);
      const scopeB = yield* startPolicyScope("opt-reject", releaseB);
      bridge.register("backend-a", scopeA, SESSION, keep("backend-a"));
      bridge.register("backend-b", scopeB, SESSION, keep("backend-b"));

      const results: Record<string, unknown> = {};
      const a = yield* spawn(function* () {
        results.a = yield* bridge.decision(makeAcpRequest("backend-a"), signal);
      });
      const b = yield* spawn(function* () {
        results.b = yield* bridge.decision(makeAcpRequest("backend-b"), signal);
      });
      yield* sleep(10);
      // Release B first to prove ordering is independent of arrival.
      releaseB.pending = false;
      releaseA.pending = false;
      yield* a;
      yield* b;
      expect(results.a).toEqual({ outcome: "allow_once" });
      expect(results.b).toEqual({ outcome: "reject_once" });
    });
  });

  it("PB3: unknown and torn-down session ids cancel", function* () {
    const bridge = createPermissionBridge();
    expect(yield* bridge.decision(makeAcpRequest("never-registered"), signal)).toEqual({
      outcome: "cancel",
    });

    // The production teardown path: the prompt scope's ensure
    // unregisters as it exits, so a request after teardown finds no
    // registration and cancels.
    yield* scoped(function* () {
      const registration = bridge.register(
        "backend-dead",
        yield* useScope(),
        SESSION,
        keep("backend-dead"),
      );
      yield* ensure(() => {
        registration.unregister();
      });
    });
    expect(yield* bridge.decision(makeAcpRequest("backend-dead"), signal)).toEqual({
      outcome: "cancel",
    });
  });

  it("PB4: an unknown selected option id cancels", function* () {
    const bridge = createPermissionBridge();
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *requestPermission() {
          return { outcome: "selected", optionId: "not-a-real-option" };
        },
      },
      { at: "min" },
    );
    bridge.register("backend-4", yield* useScope(), SESSION, keep("backend-4"));
    expect(yield* bridge.decision(makeAcpRequest("backend-4"), signal)).toEqual({
      outcome: "cancel",
    });
  });

  it("PB10: a policy that synchronously aborts then suspends cancels without hanging", function* () {
    const bridge = createPermissionBridge();
    yield* scoped(function* () {
      const controller = new AbortController();
      let halted = false;
      yield* Agent.around(
        {
          *requestPermission() {
            // Abort synchronously, before suspending — the abort listener
            // must already be attached or this would be lost.
            controller.abort();
            try {
              yield* suspend();
            } finally {
              halted = true;
            }
            return { outcome: "cancelled" };
          },
        },
        { at: "min" },
      );
      bridge.register("backend-10", yield* useScope(), SESSION, keep("backend-10"));
      const decision = yield* bridge.decision(makeAcpRequest("backend-10"), controller.signal);
      expect(decision).toEqual({ outcome: "cancel" });
      expect(halted).toBe(true);
    });
  });

  it("PB9: the scope halting while a policy is pending resolves to cancel", function* () {
    const bridge = createPermissionBridge();
    yield* scoped(function* () {
      const [outer, destroy] = createScope();
      const ready = withResolvers<Scope>();
      outer.run(function* () {
        yield* Agent.around(
          {
            *requestPermission() {
              yield* suspend();
              return { outcome: "cancelled" };
            },
          },
          { at: "min" },
        );
        ready.resolve(yield* useScope());
        yield* suspend();
      });
      const scope = yield* ready.operation;
      bridge.register("backend-9", scope, SESSION, keep("backend-9"));

      let decision: unknown;
      const task = yield* spawn(function* () {
        decision = yield* bridge.decision(makeAcpRequest("backend-9"), signal);
      });
      yield* sleep(10);
      // The registered prompt scope is torn down mid-evaluation; the
      // ACPX-facing decision must still resolve to cancel.
      yield* until(destroy());
      yield* task;
      expect(decision).toEqual({ outcome: "cancel" });
    });
  });

  it("PB5: aborts cancel — before evaluation and while it is pending", function* () {
    const bridge = createPermissionBridge();
    yield* scoped(function* () {
      let invoked = false;
      let halted = false;
      yield* Agent.around(
        {
          *requestPermission() {
            invoked = true;
            try {
              yield* sleep(5_000);
            } finally {
              halted = true;
            }
            return { outcome: "cancelled" };
          },
        },
        { at: "min" },
      );
      bridge.register("backend-5", yield* useScope(), SESSION, keep("backend-5"));

      const aborted = new AbortController();
      aborted.abort();
      expect(yield* bridge.decision(makeAcpRequest("backend-5"), aborted.signal)).toEqual({
        outcome: "cancel",
      });
      expect(invoked).toBe(false);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const decision = yield* bridge.decision(makeAcpRequest("backend-5"), controller.signal);
      expect(decision).toEqual({ outcome: "cancel" });
      expect(invoked).toBe(true);
      expect(halted).toBe(true);
    });
  });

  it("PB6: a policy error cancels without falling through to another policy", function* () {
    const bridge = createPermissionBridge();
    const decision = yield* scoped(function* () {
      let fellThrough = false;
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *requestPermission() {
            fellThrough = true;
            return { outcome: "selected", optionId: "opt-allow" };
          },
        },
        { at: "min" },
      );
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *requestPermission() {
            throw new Error("policy exploded");
          },
        },
        { at: "min" },
      );
      bridge.register("backend-6", yield* useScope(), SESSION, keep("backend-6"));
      const result = yield* bridge.decision(makeAcpRequest("backend-6"), signal);
      expect(fellThrough).toBe(false);
      return result;
    });
    expect(decision).toEqual({ outcome: "cancel" });
  });

  it("PB7: Promise adaptation exists only at the ACPX callback boundary", function* () {
    const bridge = createPermissionBridge();
    // The bridge exposes no promise-returning member.
    expect(Object.keys(bridge).sort()).toEqual(["decision", "register"]);

    yield* scoped(function* () {
      bridge.register("backend-7", yield* useScope(), SESSION, keep("backend-7"));
      const scope = yield* useScope();
      // Mirror provider.ts's onPermissionRequest assignment exactly.
      const callback = (request: AcpPermissionRequest, ctx: { signal: AbortSignal }) =>
        Promise.resolve(scope.run(() => bridge.decision(request, ctx.signal)));
      const decision = yield* until(callback(makeAcpRequest("backend-7"), { signal }));
      expect(decision).toEqual({ outcome: "reject_once" });
    });
  });
});
