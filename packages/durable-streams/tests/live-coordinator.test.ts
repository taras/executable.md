import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import {
  createDurableOperation,
  durableRun,
  InMemoryStream,
  type Json,
  type LiveDurableEffect,
  type Result,
  type Workflow,
} from "../mod.ts";

describe("live durable effect coordinator", () => {
  it("preserves the default live publication and replay behavior", function* () {
    const stream = new InMemoryStream();
    let executions = 0;

    function* workflow(): Workflow<Json> {
      yield createDurableOperation<Json>(
        { type: "coordinator", name: "default" },
        function* (): Operation<Json> {
          executions += 1;
          return "live";
        },
      );
      return "live";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("live");
    expect(executions).toBe(1);
    expect(stream.snapshot().filter((event) => event.type === "yield")).toHaveLength(1);

    expect(
      yield* durableRun(workflow, {
        stream: new InMemoryStream(stream.snapshot()),
      }),
    ).toBe("live");
    expect(executions).toBe(1);
  });

  it("lets a provider coordinate execution and publication without changing the protocol", function* () {
    const stream = new InMemoryStream();
    const order: string[] = [];

    function* coordinate<T extends Json>(effect: LiveDurableEffect<T>): Operation<Result> {
      order.push("begin");
      const value = yield* effect.execute();
      const result: Result = { status: "ok", value };
      order.push("publish");
      yield* effect.publish(result);
      order.push("commit");
      return result;
    }

    function* workflow(): Workflow<Json> {
      yield createDurableOperation<Json>(
        { type: "coordinator", name: "provider" },
        function* (): Operation<Json> {
          order.push("execute");
          return { retained: true };
        },
        coordinate,
      );
      return { retained: true };
    }

    expect(yield* durableRun(workflow, { stream })).toEqual({ retained: true });
    expect(order).toEqual(["begin", "execute", "publish", "commit"]);
    expect(stream.snapshot().filter((event) => event.type === "yield")).toHaveLength(1);
  });
});
