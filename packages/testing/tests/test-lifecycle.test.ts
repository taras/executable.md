import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createApi } from "@effectionx/context-api";
import { ensure, scoped, spawn, suspend, useScope, withResolvers } from "effection";
import type { Operation } from "effection";
import { Component, execute, registerComponents, useTempFileCompiler } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Test, useTesting } from "../mod.ts";
import type { TestApi, TestInvocation, TestLifecycle, Testing } from "../mod.ts";
import { runDoc } from "./helpers.ts";

function* runObserved(
  files: Record<string, string>,
  configure: (session: Testing, events: TestLifecycle[], stream: InMemoryStream) => Operation<void>,
  stream = new InMemoryStream(),
) {
  const owner = yield* useScope();
  const events: TestLifecycle[] = [];
  const run = yield* scoped(function* () {
    yield* useStubFs(files);
    const session = yield* useTesting();
    const ready = withResolvers<void>();
    const reader = owner.run(function* () {
      const subscription = yield* session.lifecycle;
      ready.resolve();
      for (let item = yield* subscription.next(); !item.done; item = yield* subscription.next()) {
        const event = item.value;
        events.push(event);
      }
    });
    yield* ready.operation;
    yield* configure(session, events, stream);
    const completion = yield* yield* execute({ path: "README.md", stream });
    return { completion, results: yield* session.results, reader };
  });
  yield* run.reader;
  return { ...run, events, stream };
}

function* nothing(): Operation<void> {}

describe("test lifecycle", () => {
  beforeAll(() => useTempFileCompiler());

  it("publishes frozen per-run references before concurrent body work and exposes them through nested observers", function* () {
    const body: TestInvocation[] = [];
    const blocks: TestInvocation[] = [];
    const both = withResolvers<void>();
    const copy = createApi<Pick<TestApi, "invocation">>("Test", { invocation: undefined });
    expect(yield* Test.operations.invocation).toBeUndefined();
    const run = yield* runObserved(
      {
        "README.md": "<All><Spawn><Repeated /></Spawn><Spawn><Repeated /></Spawn></All>",
        "Repeated.md": '<Test name="same"><Probe />\n\n```sh exec\nheld\n```\n</Test>',
      },
      function* (_session, events) {
        yield* registerComponents([
          {
            name: "Probe",
            origin: "lifecycle-fixture",
            props: { type: "object" },
            *fn() {
              const invocation = yield* Test.operations.invocation;
              expect(invocation).toBeDefined();
              if (invocation === undefined) {
                throw new Error("missing invocation");
              }
              expect(yield* copy.operations.invocation).toBe(invocation);
              expect(Object.isFrozen(invocation)).toBe(true);
              expect(Object.keys(invocation).sort()).toEqual(["location", "name"]);
              body.push(invocation);
              if (body.length === 2) {
                both.resolve();
              }
              yield* both.operation;
              expect(
                events.some((event) => event.kind === "started" && event.invocation === invocation),
              ).toBe(true);
              return "";
            },
          },
        ]);
        yield* Component.around({
          *applyModifiers([modifiers, context], next) {
            const invocation = yield* Test.operations.invocation;
            if (invocation === undefined) {
              throw new Error("block has no invocation");
            }
            blocks.push(invocation);
            return yield* next(modifiers, context);
          },
        });
        yield* API.Process.around({
          *exec() {
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        });
      },
    );
    expect(run.completion.ok).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]).not.toBe(body[1]);
    expect(body[0]?.location).toBe(body[1]?.location);
    expect(blocks).toHaveLength(2);
    expect(blocks).toEqual(expect.arrayContaining(body));
    for (const invocation of body) {
      expect(
        run.events.filter((event) => event.kind === "recorded" && event.invocation === invocation),
      ).toHaveLength(1);
    }
    expect(yield* Test.operations.invocation).toBeUndefined();
  });

  it("publishes each deferred parsed result after persistence and the complete collector chain, including nested Testing", function* () {
    const delegated: string[] = [];
    const snapshots: string[] = [];
    const run = yield* runObserved(
      {
        "README.md":
          '<Test name="first" /><Test name="second" /><Testing><Test name="nested" /></Testing>',
      },
      function* (session, _events, stream) {
        yield* Test.around({
          *record([result], next) {
            yield* next(result);
            delegated.push(result.name ?? "");
          },
        });
        const subscription = yield* session.lifecycle;
        yield* spawn(function* () {
          for (
            let item = yield* subscription.next();
            !item.done;
            item = yield* subscription.next()
          ) {
            const event = item.value;
            if (event.kind === "recorded") {
              expect(delegated).toContain(event.result.name);
              expect(yield* session.results).toContain(event.result);
              const persisted = (yield* stream.readAll()).filter(
                (item) => item.type === "yield" && item.description.type === "test_result",
              );
              expect(persisted).toHaveLength(delegated.length);
              snapshots.push(event.result.name ?? "");
            }
          }
        });
      },
    );
    expect(run.completion.ok).toBe(true);
    expect(snapshots).toEqual(["first", "second", "nested"]);
    const starts = run.events.filter((event) => event.kind === "started");
    const records = run.events.filter((event) => event.kind === "recorded");
    expect(starts).toHaveLength(3);
    expect(records).toHaveLength(3);
    expect(run.events.indexOf(starts[1]!)).toBeLessThan(run.events.indexOf(records[0]!));
    for (const event of records) {
      expect(event.invocation).toBe(
        starts.find((start) => start.invocation.name === event.result.name)?.invocation,
      );
    }
  });

  it("retains the invocation through teardown replacement and leaves a before-staging failure unpaired", function* () {
    const run = yield* runObserved(
      {
        "README.md": [
          '<Test name="tears">',
          "```js persist eval",
          'yield* spawn(function* () { try { yield* suspend(); } finally { throw new Error("cleanup exploded"); } });',
          "```",
          "</Test>",
          '<Test name="broken" timeout="soon" />',
        ].join("\n"),
      },
      nothing,
    );
    expect(run.completion.ok).toBe(false);
    const starts = run.events.filter((event) => event.kind === "started");
    const records = run.events.filter((event) => event.kind === "recorded");
    expect(starts).toHaveLength(1);
    expect(records).toHaveLength(2);
    expect(records[0]?.invocation).toBe(starts[0]?.invocation);
    expect(records[0]?.result.error?.kind).toBe("teardown");
    expect(records[1]?.invocation).toBeUndefined();
    expect(records[1]?.result.error?.message).toContain("must be a duration");
  });

  it("joins a halted live owner without recording, closes subscribers, and isolates subscriber cancellation", function* () {
    const owner = yield* useScope();
    const entered = withResolvers<void>();
    const cleanup = withResolvers<void>();
    const release = withResolvers<void>();
    const events: TestLifecycle[] = [];
    const closed = withResolvers<void>();
    const subscribed = withResolvers<void>();
    const sessionOwner = yield* spawn(function* () {
      yield* useStubFs({ "README.md": "<Test><Held /></Test>" });
      const session = yield* useTesting();
      owner.run(function* () {
        const subscription = yield* session.lifecycle;
        subscribed.resolve();
        for (let item = yield* subscription.next(); !item.done; item = yield* subscription.next()) {
          const event = item.value;
          events.push(event);
        }
        closed.resolve();
      });
      yield* subscribed.operation;
      const cancelledReady = withResolvers<void>();
      const subscriber = yield* spawn(function* () {
        yield* session.lifecycle;
        cancelledReady.resolve();
        yield* suspend();
      });
      yield* cancelledReady.operation;
      yield* subscriber.halt();
      yield* registerComponents([
        {
          name: "Held",
          origin: "lifecycle-fixture",
          props: { type: "object" },
          *fn() {
            yield* ensure(function* () {
              cleanup.resolve();
              yield* release.operation;
            });
            entered.resolve();
            yield* suspend();
            return "";
          },
        },
      ]);
      yield* yield* execute({ path: "README.md", stream: new InMemoryStream() });
    });
    yield* entered.operation;
    const halt = yield* spawn(() => sessionOwner.halt());
    yield* cleanup.operation;
    expect(events.filter((event) => event.kind === "recorded")).toEqual([]);
    release.resolve();
    yield* halt;
    yield* closed.operation;
    expect(events.map((event) => event.kind)).toEqual(["started"]);
    expect(yield* Test.operations.invocation).toBeUndefined();
  });

  it("keeps standalone Testing results without a session publisher", function* () {
    const run = yield* runDoc({ "README.md": '<Testing><Test name="standalone" /></Testing>' });
    expect(run.completion.ok).toBe(true);
    expect(run.results.map((result) => result.name)).toEqual(["standalone"]);
  });
});
