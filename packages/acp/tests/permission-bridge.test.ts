/**
 * Tier PB — permission bridge tests (specs/acp-client-spec.md
 * §Permissions): operation-based decisions that fail closed with ACP
 * cancellation on missing/torn-down registrations, policy errors,
 * aborts, and unknown option ids. Promise adaptation exists only at
 * the simulated ACPX callback boundary.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure, scoped, sleep, until, useScope } from "effection";
import { Agent } from "@executablemd/core";
import type { Session } from "@executablemd/core";
import type { AcpPermissionRequest } from "acpx/runtime";
import { createPermissionBridge } from "../src/permission-bridge.ts";

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

describe("Tier PB — permission bridge", () => {
  it("PB1: requests re-enter the registered scope where scoped middleware answers", function* () {
    const bridge = createPermissionBridge();
    const decision = yield* scoped(function* () {
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
      const scope = yield* useScope();
      const unregister = bridge.register("backend-1", scope, SESSION);
      try {
        const result = yield* bridge.decision(makeAcpRequest("backend-1"), signal);
        expect(seen).toEqual(["edit"]);
        return result;
      } finally {
        unregister();
      }
    });
    expect(decision).toEqual({ outcome: "allow_once" });
  });

  it("PB2: concurrent sessions route to their own prompt scopes", function* () {
    const bridge = createPermissionBridge();
    yield* scoped(function* () {
      yield* scoped(function* () {
        yield* Agent.around(
          {
            // deno-lint-ignore require-yield
            *requestPermission() {
              return { outcome: "selected", optionId: "opt-allow" };
            },
          },
          { at: "min" },
        );
        bridge.register("backend-a", yield* useScope(), SESSION);
      });
      // The second scope's policy rejects — proving each decision saw
      // exactly its own scope's middleware.
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *requestPermission() {
            return { outcome: "selected", optionId: "opt-reject" };
          },
        },
        { at: "min" },
      );
      bridge.register("backend-b", yield* useScope(), SESSION);

      const [first, second] = [
        yield* bridge.decision(makeAcpRequest("backend-a"), signal),
        yield* bridge.decision(makeAcpRequest("backend-b"), signal),
      ];
      expect(first).toEqual({ outcome: "allow_once" });
      expect(second).toEqual({ outcome: "reject_once" });
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
      const unregister = bridge.register("backend-dead", yield* useScope(), SESSION);
      yield* ensure(() => {
        unregister();
      });
    });
    expect(yield* bridge.decision(makeAcpRequest("backend-dead"), signal)).toEqual({
      outcome: "cancel",
    });
  });

  it("PB4: an unknown selected option id cancels", function* () {
    const bridge = createPermissionBridge();
    const decision = yield* scoped(function* () {
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *requestPermission() {
            return { outcome: "selected", optionId: "not-a-real-option" };
          },
        },
        { at: "min" },
      );
      bridge.register("backend-4", yield* useScope(), SESSION);
      return yield* bridge.decision(makeAcpRequest("backend-4"), signal);
    });
    expect(decision).toEqual({ outcome: "cancel" });
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
      bridge.register("backend-5", yield* useScope(), SESSION);

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
      bridge.register("backend-6", yield* useScope(), SESSION);
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
      bridge.register("backend-7", yield* useScope(), SESSION);
      const scope = yield* useScope();
      // Mirror provider.ts's onPermissionRequest assignment exactly.
      const callback = (request: AcpPermissionRequest, ctx: { signal: AbortSignal }) =>
        Promise.resolve(scope.run(() => bridge.decision(request, ctx.signal)));
      const decision = yield* until(callback(makeAcpRequest("backend-7"), { signal }));
      expect(decision).toEqual({ outcome: "reject_once" });
    });
  });
});
