import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { API, SERVICE_HOSTNAME, startService } from "@executablemd/runtime";
import { useWorkflowServiceDenial, WorkflowServiceDeniedError } from "../src/service-denial.ts";

describe("workflow service denial", () => {
  it("blocks an inherited host provider without delegating", function* () {
    let hostCalls = 0;
    yield* API.Service.around(
      {
        *start() {
          hostCalls += 1;
          return {
            endpoint: Object.freeze({ hostname: SERVICE_HOSTNAME, port: 41_111 }),
          };
        },
      },
      { at: "min" },
    );

    let failure: unknown;
    try {
      yield* scoped(function* () {
        yield* useWorkflowServiceDenial();
        yield* startService({ command: "must-not-run" });
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorkflowServiceDeniedError);
    expect(hostCalls).toBe(0);

    const service = yield* startService({ command: "allowed-outside-workflow" });
    expect(service.endpoint.port).toBe(41_111);
    expect(hostCalls).toBe(1);
  });
});
