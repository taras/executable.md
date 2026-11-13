import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Component } from "@executablemd/core/api";
import { scoped } from "effection";
import Capture from "../../../examples/adversarial-implementation/components/Ticket/Capture.ts";

describe("adversarial implementation example", () => {
  it("keeps each failure message when its stack omits it", function* () {
    const cause = new Error("cause sentinel");
    cause.stack = "Error\n    at cause-stack-marker";
    const error = new Error("root sentinel", { cause });
    error.stack = "Error\n    at root-stack-marker";
    const captured = yield* scoped(function* () {
      yield* Component.around({
        // deno-lint-ignore require-yield
        *tryContent(_args, _next) {
          return { text: "partial output", failure: error };
        },
      });
      return yield* Capture();
    });
    expect(captured.status).toBe("failed");
    expect(captured.output).toBe("partial output");
    expect(captured.failure).toContain("root sentinel");
    expect(captured.failure).toContain("root-stack-marker");
    expect(captured.failure).toContain("cause sentinel");
    expect(captured.failure).toContain("cause-stack-marker");
  });
});
