/**
 * Tier PB — permission bridge tests (specs/acp-client-spec.md §Permissions).
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, until, useScope } from "effection";
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
        const result = yield* until(
          bridge.onPermissionRequest(makeAcpRequest("backend-1"), { signal }),
        );
        expect(seen).toEqual(["edit"]);
        return result;
      } finally {
        unregister();
      }
    });
    expect(decision).toEqual({ outcome: "allow_once" });
  });

  it("PB2: the base deny selects reject_once and maps its kind back to ACP", function* () {
    const bridge = createPermissionBridge();
    const decision = yield* scoped(function* () {
      const scope = yield* useScope();
      bridge.register("backend-2", scope, SESSION);
      return yield* until(bridge.onPermissionRequest(makeAcpRequest("backend-2"), { signal }));
    });
    expect(decision).toEqual({ outcome: "reject_once" });
  });

  it("PB3: an unknown session id cancels — never undefined, never another scope", function* () {
    const bridge = createPermissionBridge();
    yield* scoped(function* () {
      const scope = yield* useScope();
      bridge.register("backend-known", scope, SESSION);
      const decision = yield* until(
        bridge.onPermissionRequest(makeAcpRequest("backend-unknown"), { signal }),
      );
      expect(decision).toEqual({ outcome: "cancel" });
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
      const scope = yield* useScope();
      bridge.register("backend-4", scope, SESSION);
      return yield* until(bridge.onPermissionRequest(makeAcpRequest("backend-4"), { signal }));
    });
    expect(decision).toEqual({ outcome: "cancel" });
  });

  it("PB5: unregistering removes routing so later requests cancel", function* () {
    const bridge = createPermissionBridge();
    yield* scoped(function* () {
      const scope = yield* useScope();
      const unregister = bridge.register("backend-5", scope, SESSION);
      unregister();
      const decision = yield* until(
        bridge.onPermissionRequest(makeAcpRequest("backend-5"), { signal }),
      );
      expect(decision).toEqual({ outcome: "cancel" });
    });
  });
});
