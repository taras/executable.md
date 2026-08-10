/**
 * Retained history — one settled answer per event, for every phase.
 *
 * A journal is data a backend supplies, and every phase of a replay reads the
 * same events: a consumer's own admission gate, the replay index, public guard
 * policy, and the replay path. Where those are separate reads of the backend's
 * objects, a source that answers differently between them decides one thing for
 * validation and another for execution.
 *
 * Classification is the read everything else rests on: an event that is a Yield
 * to one phase and a Close to the next cannot be reasoned about at all. These
 * go through `retainEvents`, which is how a run actually obtains its history,
 * rather than constructing wrappers directly.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { detachJson, retainEvents } from "../retained.ts";
import { ReplayIndex } from "../replay-index.ts";
import type { DurableEvent, Json } from "../types.ts";

/** An event whose members answer from a list, counting reads per member. */
function shifting(
  members: Record<string, unknown[]>,
  fixed: Record<string, unknown> = {},
): { event: DurableEvent; reads: Record<string, number> } {
  const reads: Record<string, number> = {};
  const event: Record<string, unknown> = { ...fixed };
  for (const [key, answers] of Object.entries(members)) {
    reads[key] = 0;
    Object.defineProperty(event, key, {
      enumerable: true,
      get() {
        const index = Math.min(reads[key]!, answers.length - 1);
        reads[key] = reads[key]! + 1;
        return answers[index];
      },
    });
  }
  return { event: event as unknown as DurableEvent, reads };
}

function retain(event: DurableEvent): DurableEvent {
  return retainEvents([event])[0]!;
}

describe("retained history — classification settles once", () => {
  it("an event that turns from Yield into Close stays a Yield", function* () {
    const { event, reads } = shifting(
      { type: ["yield", "close"] },
      {
        coroutineId: "root",
        description: { type: "call", name: "work" },
        result: { status: "ok" },
      },
    );
    const retained = retain(event);
    expect(retained.type).toBe("yield");
    expect(retained.type).toBe("yield");
    // Classified once; the wrapper never asks the source again.
    expect(reads["type"]).toBe(1);
  });

  it("an event that turns from Close into Yield stays a Close", function* () {
    const { event, reads } = shifting(
      { type: ["close", "yield"] },
      { coroutineId: "root", result: { status: "ok", value: "kept" } },
    );
    const retained = retain(event);
    expect(retained.type).toBe("close");
    expect(retained.type).toBe("close");
    expect(reads["type"]).toBe(1);
  });

  it("a discriminator that refuses is refused from every member, once", function* () {
    let asked = 0;
    const event: Record<string, unknown> = {};
    Object.defineProperty(event, "type", {
      enumerable: true,
      get() {
        asked++;
        throw new Error("the backend will not say what this event is");
      },
    });
    const retained = retain(event as unknown as DurableEvent);
    for (const read of [() => retained.type, () => retained.coroutineId, () => retained.result]) {
      let caught: unknown;
      try {
        read();
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message).toBe(
        "the backend will not say what this event is",
      );
    }
    expect(asked).toBe(1);
  });

  it("an event that is neither is refused rather than passed through", function* () {
    const retained = retain({ type: "something-else" } as unknown as DurableEvent);
    let caught: unknown;
    try {
      void retained.type;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
  });

  it("retaining an already-retained event returns it unchanged", function* () {
    const once = retain({
      type: "yield",
      coroutineId: "root",
      description: { type: "call", name: "work" },
      result: { status: "ok" },
    });
    expect(retainEvents([once])[0]).toBe(once);
  });
});

describe("retained history — a Close settles once", () => {
  it("a coroutine that moves from a child to the root stays the child's", function* () {
    const { event, reads } = shifting(
      { coroutineId: ["root.7", "root"] },
      { type: "close", result: { status: "ok", value: "alpha" } },
    );
    const retained = retain(event);
    expect(retained.coroutineId).toBe("root.7");
    expect(retained.coroutineId).toBe("root.7");
    expect(reads["coroutineId"]).toBe(1);

    // And the index — the phase that decides whether a terminal result exists —
    // sees exactly what the first reader saw.
    const index = new ReplayIndex([retained]);
    expect(index.hasClose("root")).toBe(false);
    expect(index.hasClose("root.7")).toBe(true);
  });

  it("a coroutine that moves from the root to a child stays the root's", function* () {
    const { event } = shifting(
      { coroutineId: ["root", "root.7"] },
      { type: "close", result: { status: "ok", value: "alpha" } },
    );
    const index = new ReplayIndex([retain(event)]);
    expect(index.hasClose("root")).toBe(true);
    expect(index.hasClose("root.7")).toBe(false);
  });

  it("a successful terminal result that changes is answered once", function* () {
    const { event, reads } = shifting(
      {
        result: [
          { status: "ok", value: "first" },
          { status: "ok", value: "second" },
        ],
      },
      { type: "close", coroutineId: "root" },
    );
    const retained = retain(event);
    expect(retained.result).toEqual({ status: "ok", value: "first" });
    expect(retained.result).toEqual({ status: "ok", value: "first" });
    expect(reads["result"]).toBe(1);
  });

  it("a failed terminal result that changes is answered once", function* () {
    const { event } = shifting(
      {
        result: [
          { status: "err", error: { message: "first" } },
          { status: "err", error: { message: "second" } },
        ],
      },
      { type: "close", coroutineId: "root" },
    );
    const retained = retain(event);
    expect(retained.result).toEqual({ status: "err", error: { message: "first" } });
    expect(retained.result).toEqual({ status: "err", error: { message: "first" } });
  });

  it("a terminal result that refuses and then answers stays refused", function* () {
    let asked = 0;
    const event: Record<string, unknown> = { type: "close", coroutineId: "root" };
    Object.defineProperty(event, "result", {
      enumerable: true,
      get() {
        asked++;
        if (asked === 1) {
          throw new Error("the backend will not produce this result");
        }
        return { status: "ok", value: "answered later" };
      },
    });
    const retained = retain(event as unknown as DurableEvent);
    for (let attempt = 0; attempt < 3; attempt++) {
      let caught: unknown;
      try {
        void retained.result;
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message).toBe(
        "the backend will not produce this result",
      );
    }
    expect(asked).toBe(1);
  });

  /**
   * Detached while the history is retained, not at a first later read.
   *
   * Memoizing on first access closes repeated reads and leaves the interval
   * between a consumer's admission and terminal reuse open: nobody has touched
   * the getter yet, so the backend still owns the answer.
   */
  it("a terminal result is detached before anyone reads it", function* () {
    const value: Record<string, unknown> = { output: "original" };
    const retained = retain({
      type: "close",
      coroutineId: "root",
      result: { status: "ok", value },
    } as unknown as DurableEvent);

    // Mutated before the retained result has ever been read.
    value["output"] = "planted after retention";
    expect(retained.result).toEqual({ status: "ok", value: { output: "original" } });
  });

  it("a terminal result is detached from the source", function* () {
    const value = { list: ["a"] };
    const retained = retain({
      type: "close",
      coroutineId: "root",
      result: { status: "ok", value },
    } as unknown as DurableEvent);
    const held = retained.result;
    value.list.push("injected");
    expect(held).toEqual({ status: "ok", value: { list: ["a"] } });
  });

  it("a cancelled terminal result is retained as itself", function* () {
    const retained = retain({
      type: "close",
      coroutineId: "root",
      result: { status: "cancelled" },
    } as unknown as DurableEvent);
    expect(retained.result).toEqual({ status: "cancelled" });
  });

  it("the control — an intact history classifies and settles normally", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "import_component", name: "__root__" },
        result: { status: "ok", value: { kind: "repository" } },
      },
      { type: "close", coroutineId: "root", result: { status: "ok", value: "done" } },
    ];
    const index = new ReplayIndex(retainEvents(events));
    expect(index.peekYield("root")?.description).toEqual({
      type: "import_component",
      name: "__root__",
    });
    expect(index.hasClose("root")).toBe(true);
    expect(index.getClose("root")?.result).toEqual({ status: "ok", value: "done" });
  });
});

describe("retained history — a Yield's identity settles once", () => {
  const BASE = { result: { status: "ok", value: 1 } };

  it("a name that turns into __root__ is seen the same way by every phase", function* () {
    const { event } = shifting(
      { name: ["unrelated", "__root__"] },
      { type: "yield", coroutineId: "root" },
    );
    const description = { type: "import_component" };
    Object.defineProperty(description, "name", {
      enumerable: true,
      get: Object.getOwnPropertyDescriptor(event, "name")!.get!,
    });
    const retained = retain({
      type: "yield",
      coroutineId: "root",
      description,
      ...BASE,
    } as unknown as DurableEvent);
    expect(retained.type === "yield" ? retained.description.name : undefined).toBe("unrelated");
    expect(retained.type === "yield" ? retained.description.name : undefined).toBe("unrelated");
  });

  it("a name that turns away from __root__ keeps naming the root import", function* () {
    const { event } = shifting(
      { name: ["__root__", "unrelated"] },
      { type: "yield", coroutineId: "root" },
    );
    const description = { type: "import_component" };
    Object.defineProperty(description, "name", {
      enumerable: true,
      get: Object.getOwnPropertyDescriptor(event, "name")!.get!,
    });
    const retained = retain({
      type: "yield",
      coroutineId: "root",
      description,
      ...BASE,
    } as unknown as DurableEvent);
    expect(retained.type === "yield" ? retained.description.name : undefined).toBe("__root__");
    expect(retained.type === "yield" ? retained.description.name : undefined).toBe("__root__");
  });

  it("a shifting coroutine id settles once", function* () {
    const { event, reads } = shifting(
      { coroutineId: ["root", "root.3"] },
      { type: "yield", description: { type: "call", name: "work" }, ...BASE },
    );
    const retained = retain(event);
    expect(retained.coroutineId).toBe("root");
    expect(retained.coroutineId).toBe("root");
    expect(reads["coroutineId"]).toBe(1);
  });

  it("a shifting nested description member settles once", function* () {
    const description: Record<string, unknown> = { type: "call", name: "work" };
    let asked = 0;
    Object.defineProperty(description, "marker", {
      enumerable: true,
      get() {
        asked++;
        return asked === 1 ? "stable" : "swapped";
      },
    });
    const retained = retain({
      type: "yield",
      coroutineId: "root",
      description,
      ...BASE,
    } as unknown as DurableEvent);
    const read = () => (retained.type === "yield" ? retained.description["marker"] : undefined);
    expect(read()).toBe("stable");
    expect(read()).toBe("stable");
    expect(asked).toBe(1);
  });

  it("an identity accessor that refuses is refused once, not retried", function* () {
    let asked = 0;
    const event: Record<string, unknown> = {
      type: "yield",
      description: { type: "call", name: "work" },
      ...BASE,
    };
    Object.defineProperty(event, "coroutineId", {
      enumerable: true,
      get() {
        asked++;
        throw new Error("the backend will not say which coroutine this is");
      },
    });
    const retained = retain(event as unknown as DurableEvent);
    for (let attempt = 0; attempt < 3; attempt++) {
      let caught: unknown;
      try {
        void retained.coroutineId;
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message).toBe(
        "the backend will not say which coroutine this is",
      );
    }
    expect(asked).toBe(1);
  });

  it("a Yield's settlement stays lazy, so a guard can refuse before it is read", function* () {
    let asked = 0;
    const event: Record<string, unknown> = {
      type: "yield",
      coroutineId: "root",
      description: { type: "call", name: "work" },
    };
    Object.defineProperty(event, "result", {
      enumerable: true,
      get() {
        asked++;
        return { status: "ok", value: 1 };
      },
    });
    const index = new ReplayIndex(retainEvents([event as unknown as DurableEvent]));
    expect(index.peekYield("root")?.description.name).toBe("work");
    expect(asked).toBe(0);
    expect(index.peekYield("root")?.result).toEqual({ status: "ok", value: 1 });
    expect(index.peekYield("root")?.result).toEqual({ status: "ok", value: 1 });
    expect(asked).toBe(1);
  });
});

describe("retained history — detached values stay ordinary JSON", () => {
  it("`__proto__` is retained as an own data member", function* () {
    const source: Record<string, unknown> = {};
    Object.defineProperty(source, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const detached = detachJson(source as Json);
    expect(Object.getPrototypeOf(detached)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(detached)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBe(undefined);
  });

  it("nested objects and arrays detach from the journal's own", function* () {
    const list = ["a"];
    const nested = { list };
    const detached = detachJson({ nested } as unknown as Json);
    const held = (detached as Record<string, Json>)["nested"];
    expect(held).not.toBe(nested);
    expect((held as Record<string, Json>)["list"]).not.toBe(list);

    list.push("injected");
    nested.list = ["replaced"];
    expect((held as Record<string, Json>)["list"]).toEqual(["a"]);
  });

  it("a detached member is writable and configurable", function* () {
    const detached = detachJson({ count: 0, tags: ["a"] } as unknown as Json);
    const held = detached as Record<string, Json>;
    held["count"] = 1;
    (held["tags"] as Json[]).push("b");
    expect(held).toEqual({ count: 1, tags: ["a", "b"] });
  });

  it("a cycle is refused rather than followed", function* () {
    const looped: Record<string, unknown> = {};
    looped["self"] = looped;
    let caught: unknown;
    try {
      detachJson(looped as Json);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
  });
});
