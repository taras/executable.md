/**
 * The durable execution state is reachable from a workflow through the
 * exported DurableContext, which names both the Effection context and the
 * shape that context holds.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, useScope } from "effection";
import { DurableContext, durableRun, InMemoryStream } from "../mod.ts";

describe("DurableContext", () => {
  it("holds the state durableRun installs on the workflow scope", function* () {
    const stream = new InMemoryStream();

    function* workflow(): Operation<string> {
      const scope = yield* useScope();
      const state: DurableContext = scope.expect(DurableContext);
      expect(state.stream).toBe(stream);
      expect(state.childCounter).toBe(0);
      return state.coroutineId;
    }

    const coroutineId = yield* durableRun(workflow, { stream, coroutineId: "root.7" });

    expect(coroutineId).toBe("root.7");
  });
});
