/**
 * Tier 2 tests — divergence detection.
 *
 * Tests 8-14 from the protocol specification. These validate that
 * durableRun correctly detects when the workflow code has changed
 * in ways incompatible with the stored journal.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  type DurableEvent,
  EarlyReturnDivergenceError,
  InMemoryStream,
  type Json,
  SOURCE_POSITION_FIELD,
  TerminalDivergenceError,
  type Workflow,
  createDurableOperation,
  durableCall,
  durableRun,
  durableSleep,
} from "../mod.ts";

describe("divergence detection", () => {
  it("added step — generator yields more effects than journal (completed workflow stays completed)", function* () {
    // Journal recorded a workflow with 2 steps, but now code has 3
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepB" },
        result: { status: "ok", value: "beta" },
      },
      {
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: "done" },
      },
    ];
    const stream = new InMemoryStream(events);

    // This workflow has a Close event, so durableRun returns stored result
    // directly. The added step isn't detected because the workflow is never
    // re-run. This is correct: a completed workflow stays completed.
    const result = yield* durableRun(
      function* (): Workflow<string> {
        yield* durableCall<string>("stepA", () => Promise.resolve("alpha"));
        yield* durableCall<string>("stepNew", () => Promise.resolve("new"));
        yield* durableCall<string>("stepB", () => Promise.resolve("beta"));
        return "done";
      },
      { stream },
    );

    expect(result).toBe("done");
  });

  it("added step — detected during partial replay", function* () {
    // Journal has 2 steps but NO Close. The new code inserts a step between them.
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepB" },
        result: { status: "ok", value: "beta" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          yield* durableCall<string>("stepA", () => Promise.resolve("alpha"));
          // This step wasn't in the journal — journal[1] is stepB, not stepNew
          yield* durableCall<string>("stepNew", () => Promise.resolve("new"));
          yield* durableCall<string>("stepB", () => Promise.resolve("beta"));
          return "done";
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("DivergenceError");
    }
  });

  it("removed step — generator finishes before journal exhausted", function* () {
    // Journal has 3 steps, but new code only has 2
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepB" },
        result: { status: "ok", value: "beta" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepC" },
        result: { status: "ok", value: "gamma" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          yield* durableCall<string>("stepA", () => Promise.resolve("alpha"));
          yield* durableCall<string>("stepB", () => Promise.resolve("beta"));
          // stepC was removed — generator returns early
          return "done";
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("EarlyReturnDivergenceError");
      if (e instanceof EarlyReturnDivergenceError) {
        expect(e.consumedCount).toBe(2);
        expect(e.totalCount).toBe(3);
      }
    }
  });

  it("reordered steps — description mismatch at position", function* () {
    // Journal: stepA then stepB. Code: stepB then stepA.
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepB" },
        result: { status: "ok", value: "beta" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          // Reordered: stepB first, but journal has stepA at position 0
          yield* durableCall<string>("stepB", () => Promise.resolve("beta"));
          yield* durableCall<string>("stepA", () => Promise.resolve("alpha"));
          return "done";
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("DivergenceError");
      if (e instanceof DivergenceError) {
        expect(e.position).toBe(0);
        expect(e.expected).toEqual({ type: "call", name: "stepA" });
        expect(e.actual).toEqual({ type: "call", name: "stepB" });
      }
    }
  });

  it("type mismatch — call vs sleep", function* () {
    // Journal recorded a "call" effect, but code now yields a "sleep"
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<void> {
          // Journal has call("stepA"), but we yield sleep("sleep")
          yield* durableSleep(1000);
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("DivergenceError");
      if (e instanceof DivergenceError) {
        expect(e.expected.type).toBe("call");
        expect(e.actual.type).toBe("sleep");
      }
    }
  });

  it("name mismatch — same type, different name", function* () {
    // Journal has call("fetchOrder"), code has call("fetchUser")
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "fetchOrder" },
        result: { status: "ok", value: "order-data" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          return yield* durableCall<string>("fetchUser", () => Promise.resolve("user-data"));
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("DivergenceError");
      if (e instanceof DivergenceError) {
        expect(e.expected).toEqual({ type: "call", name: "fetchOrder" });
        expect(e.actual).toEqual({ type: "call", name: "fetchUser" });
      }
    }
  });

  it("generator finishes early — returns with unconsumed yields", function* () {
    // Journal has 3 yields, generator returns after consuming only 1
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepB" },
        result: { status: "ok", value: "beta" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepC" },
        result: { status: "ok", value: "gamma" },
      },
    ];
    const stream = new InMemoryStream(events);

    const before = stream.snapshot();
    try {
      yield* durableRun(
        function* (): Workflow<string> {
          const a = yield* durableCall<string>("stepA", () => Promise.resolve("alpha"));
          // Steps B and C were removed
          return a;
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("EarlyReturnDivergenceError");
      if (e instanceof EarlyReturnDivergenceError) {
        expect(e.consumedCount).toBe(1);
        expect(e.totalCount).toBe(3);
      }
    }
    expect(stream.snapshot()).toEqual(before);
  });

  it("generator failure cannot close over unconsumed replay entries", function* () {
    const original = new Error("current workflow failed");
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "removed" },
        result: { status: "ok", value: "recorded" },
      },
    ];
    const stream = new InMemoryStream(events);
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          throw original;
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected terminal divergence");
    }
    expect(failure.name).toBe("TerminalDivergenceError");
    expect(failure.cause).toBe(original);
    expect(stream.snapshot()).toEqual(events);
  });

  it("continues past close — journal has Close but generator keeps yielding (completed workflow stays completed)", function* () {
    // Journal: 1 yield + Close. Code adds a second step.
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: "alpha" },
      },
    ];
    const stream = new InMemoryStream(events);

    // The workflow already has a Close event, so durableRun returns stored
    // result directly. The new step isn't detected.
    // This is the correct behavior: a completed workflow stays completed.
    const result = yield* durableRun(
      function* (): Workflow<string> {
        yield* durableCall<string>("stepA", () => Promise.resolve("alpha"));
        yield* durableCall<string>("stepB", () => Promise.resolve("beta"));
        return "done";
      },
      { stream },
    );

    expect(result).toBe("alpha");
  });

  it("ContinuePastCloseDivergenceError can be constructed", function* () {
    // deno-lint-ignore require-yield
    // Verify the error class exists and can be constructed.
    const err = new ContinuePastCloseDivergenceError("root.0", 2);
    expect(err.name).toBe("ContinuePastCloseDivergenceError");
    expect(err.coroutineId).toBe("root.0");
    expect(err.yieldCount).toBe(2);
  });

  it("action type mismatch — action vs call", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "action", name: "doSomething" },
        result: { status: "ok", value: 42 },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<number> {
          // Journal has action("doSomething"), code has call("doSomething")
          return yield* durableCall<number>("doSomething", () => Promise.resolve(42));
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("DivergenceError");
      if (e instanceof DivergenceError) {
        expect(e.expected.type).toBe("action");
        expect(e.actual.type).toBe("call");
      }
    }
  });

  it("positioned mismatch — each side names its own authored site", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "workspace_file",
          name: "write:notes.md",
          [SOURCE_POSITION_FIELD]: {
            path: "workflows/adversarial-implementation/Implementation.md",
            offset: 9021,
            line: 305,
            column: 3,
          },
        },
        result: { status: "ok", value: "written" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          yield createDurableOperation<Json>(
            {
              type: "loop",
              name: "loop:5",
              [SOURCE_POSITION_FIELD]: {
                path: "workflows/adversarial-implementation/Implementation.md",
                offset: 9188,
                line: 312,
                column: 1,
              },
            },
            function* () {
              return "looped";
            },
          );
          return "done";
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(DivergenceError);
      if (!(e instanceof DivergenceError)) {
        throw e;
      }
      expect(e.position).toBe(0);
      expect(e.message).toContain(
        'expected workspace_file("write:notes.md") ' +
          "at workflows/adversarial-implementation/Implementation.md:305:3",
      );
      expect(e.message).toContain(
        'got loop("loop:5") at workflows/adversarial-implementation/Implementation.md:312:1',
      );
    }
  });

  it("a changed source position is metadata — replay still matches", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "call",
          name: "stepA",
          [SOURCE_POSITION_FIELD]: { path: "docs/Plan.md", offset: 120, line: 10, column: 1 },
        },
        result: { status: "ok", value: "alpha" },
      },
    ];
    const stream = new InMemoryStream(events);
    let executions = 0;

    const result = yield* durableRun(
      function* (): Workflow<string> {
        const replayed = yield createDurableOperation<Json>(
          {
            type: "call",
            name: "stepA",
            [SOURCE_POSITION_FIELD]: { path: "docs/Plan.md", offset: 2048, line: 99, column: 7 },
          },
          function* () {
            executions++;
            return "live";
          },
        );
        return String(replayed);
      },
      { stream },
    );

    expect(result).toBe("alpha");
    expect(executions).toBe(0);
  });

  it("early return names the first unreached retained yield", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "call",
          name: "stepB",
          [SOURCE_POSITION_FIELD]: { path: "docs/Plan.md", offset: 64, line: 7, column: 5 },
        },
        result: { status: "ok", value: "beta" },
      },
    ];
    const stream = new InMemoryStream(events);
    const before = stream.snapshot();

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          return yield* durableCall<string>("stepA", () => Promise.resolve("alpha"));
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(EarlyReturnDivergenceError);
      if (!(e instanceof EarlyReturnDivergenceError)) {
        throw e;
      }
      expect(e.consumedCount).toBe(1);
      expect(e.totalCount).toBe(2);
      expect(e.message).toContain('first unreached entry is call("stepB") at docs/Plan.md:7:5');
    }
    expect(stream.snapshot()).toEqual(before);
  });

  it("ordinary failure names the first unreached retained yield and keeps its cause", function* () {
    const original = new Error("current workflow failed");
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "call",
          name: "removed",
          // No path: a normalized source scanned from a dynamic string spells
          // itself as line:column alone.
          [SOURCE_POSITION_FIELD]: { offset: 31, line: 4, column: 2 },
        },
        result: { status: "ok", value: "recorded" },
      },
    ];
    const stream = new InMemoryStream(events);
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          throw original;
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TerminalDivergenceError);
    if (!(failure instanceof TerminalDivergenceError)) {
      throw new Error("expected terminal divergence");
    }
    expect(failure.cause).toBe(original);
    expect(failure.message).toContain('first unreached entry is call("removed") at 4:2');
    expect(stream.snapshot()).toEqual(events);
  });

  it("a malformed retained source keeps the existing diagnostic wording", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "call",
          name: "stepA",
          [SOURCE_POSITION_FIELD]: { path: "", line: 0, column: "third" },
        },
        result: { status: "ok", value: "alpha" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          return yield* durableCall<string>("stepB", () => Promise.resolve("beta"));
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(DivergenceError);
      if (!(e instanceof DivergenceError)) {
        throw e;
      }
      // The identity is followed directly by the comma and the other side:
      // nothing of the malformed field reached the message.
      expect(e.message).toContain('expected call("stepA"), got call("stepB")');
    }
  });

  it("a mismatch side missing its offset keeps the existing wording", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "call",
          name: "stepA",
          [SOURCE_POSITION_FIELD]: { path: "docs/Plan.md", line: 10, column: 1 },
        },
        result: { status: "ok", value: "alpha" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          return yield* durableCall<string>("stepB", () => Promise.resolve("beta"));
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(DivergenceError);
      if (!(e instanceof DivergenceError)) {
        throw e;
      }
      expect(e.message).toContain('expected call("stepA"), got call("stepB")');
    }
  });

  it("a mismatch side with an extra member keeps the existing wording", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          yield createDurableOperation<Json>(
            {
              type: "call",
              name: "stepB",
              [SOURCE_POSITION_FIELD]: {
                path: "docs/Plan.md",
                offset: 12,
                line: 10,
                column: 1,
                generated: true,
              },
            },
            function* () {
              return "beta";
            },
          );
          return "done";
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(DivergenceError);
      if (!(e instanceof DivergenceError)) {
        throw e;
      }
      expect(e.message).toMatch(/got call\("stepB"\)$/);
    }
  });

  it("a terminal diagnostic omits a retained source missing its offset", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "stepA" },
        result: { status: "ok", value: "alpha" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "call",
          name: "stepB",
          [SOURCE_POSITION_FIELD]: { path: "docs/Plan.md", line: 7, column: 5 },
        },
        result: { status: "ok", value: "beta" },
      },
    ];
    const stream = new InMemoryStream(events);

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          return yield* durableCall<string>("stepA", () => Promise.resolve("alpha"));
        },
        { stream },
      );
      throw new Error("expected divergence error");
    } catch (e) {
      expect(e).toBeInstanceOf(EarlyReturnDivergenceError);
      if (!(e instanceof EarlyReturnDivergenceError)) {
        throw e;
      }
      expect(e.consumedCount).toBe(1);
      expect(e.totalCount).toBe(2);
      expect(e.message).toMatch(/first unreached entry is call\("stepB"\)$/);
    }
  });

  it("a terminal diagnostic omits a retained source with an extra member", function* () {
    const original = new Error("current workflow failed");
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "call",
          name: "removed",
          [SOURCE_POSITION_FIELD]: {
            path: "docs/Plan.md",
            offset: 31,
            line: 4,
            column: 2,
            generated: true,
          },
        },
        result: { status: "ok", value: "recorded" },
      },
    ];
    const stream = new InMemoryStream(events);
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          throw original;
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TerminalDivergenceError);
    if (!(failure instanceof TerminalDivergenceError)) {
      throw new Error("expected terminal divergence");
    }
    expect(failure.cause).toBe(original);
    expect(failure.message).toMatch(/first unreached entry is call\("removed"\)$/);
    expect(stream.snapshot()).toEqual(events);
  });
});
