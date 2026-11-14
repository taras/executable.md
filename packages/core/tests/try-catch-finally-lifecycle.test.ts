import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  InMemoryStream,
  DurableContext,
  createDurableOperation,
  DurablePersistenceError,
} from "@executablemd/durable-streams";
import { API, FilesInvariantError, FilesProviderUnavailableError } from "@executablemd/runtime";
import { invokeFiles } from "../src/files.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { Component, content, retain } from "../src/component-api.ts";
import { printErrors } from "../src/component-failures.ts";
import { durabilityFailure, filesFatalFailure, firstCause } from "../src/errors.ts";
import { InvocationTeardownError } from "../src/invocation.ts";
import { fixture, run, start } from "./try-catch-finally-harness.ts";

const noProps = { type: "object", properties: {}, additionalProperties: false };

describe("Try owned lifetimes", () => {
  it("A8: exact Stop deletes the progress file, joins finalizer resources, then closes cancelled", function* () {
    const source = (yield* fixture("progress-cleanup")).replace(
      '<File.Delete path="review-in-progress.txt" />',
      '<Cleanup><File.Delete path="review-in-progress.txt" /></Cleanup>',
    );
    const entered = withResolvers<void>();
    const cleanupEntered = withResolvers<void>();
    const release = withResolvers<void>();
    const trace: string[] = [];
    yield* Component.around({
      *expand([request], next) {
        if (request.expansion.name === "Catch") {
          trace.push("catch");
        }
        yield* next(request);
      },
    });
    yield* Elicitation.around({
      *elicit() {
        yield* ensure(() => {
          trace.push("body released");
        });
        entered.resolve();
        return yield* withResolvers<string>().operation;
      },
    });
    yield* registerComponents([
      {
        name: "Cleanup",
        origin: "try-lifecycle",
        props: noProps,
        *fn() {
          yield* ensure(function* () {
            cleanupEntered.resolve();
            yield* release.operation;
            trace.push("finalizer released");
          });
          trace.push("finally");
          return yield* content();
        },
      },
    ]);
    const stream = new InMemoryStream();
    const execution = yield* start(source, stream);
    yield* entered.operation;
    let stopped = false;
    const stop = yield* spawn(function* () {
      const result = yield* execution.stop();
      stopped = true;
      return result;
    });
    yield* cleanupEntered.operation;
    expect(trace).toEqual(["body released", "finally"]);
    expect(stopped).toBe(false);
    expect(
      stream.snapshot().some((event) => event.type === "close" && event.coroutineId === "root"),
    ).toBe(false);
    release.resolve();
    expect((yield* stop).ok).toBe(true);
    expect((yield* execution).ok).toBe(false);
    expect(trace).toEqual(["body released", "finally", "finalizer released"]);
    const events = stream.snapshot();
    const ending = events[events.length - 1];
    expect(ending?.type === "close" ? ending.result.status : "missing").toBe("cancelled");
    expect(JSON.stringify(events)).toContain("review-in-progress.txt");
  });

  it("A8: resumable Exit of the same progress source joins physical cleanup and defers authored deletion", function* () {
    const source = yield* fixture("progress-cleanup");
    const stream = new InMemoryStream();
    const entered = withResolvers<void>();
    let held = true;
    let asks = 0;
    let releases = 0;
    let deletions = 0;
    yield* Elicitation.around({
      *elicit() {
        asks++;
        yield* ensure(() => {
          releases++;
        });
        entered.resolve();
        if (held) {
          return yield* withResolvers<string>().operation;
        }
        return "continue";
      },
    });
    yield* API.Files.around({
      *deleteFile([input], next) {
        deletions++;
        return yield* next(input);
      },
    });
    const first = yield* spawn(() => run(source, undefined, stream));
    yield* entered.operation;
    yield* first.halt();
    expect(releases).toBe(1);
    expect(deletions).toBe(0);
    expect(stream.snapshot().filter((event) => event.type === "close")).toHaveLength(0);
    held = false;
    const resumed = yield* run(source, undefined, stream);
    expect(resumed.result.ok).toBe(true);
    expect(asks).toBe(2);
    expect(releases).toBe(2);
    expect(deletions).toBe(1);
  });

  it("A8: Stop during entered Finally waits for its single entry", function* () {
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    let calls = 0;
    let finished = false;
    yield* registerComponents([
      {
        name: "Held",
        origin: "try-lifecycle",
        props: noProps,
        *fn() {
          calls++;
          entered.resolve();
          yield* release.operation;
          finished = true;
          return "finished";
        },
      },
    ]);
    const execution = yield* start("<Try>body<Finally><Held /></Finally></Try>");
    yield* entered.operation;
    const requested = withResolvers<void>();
    let stopped = false;
    const stop = yield* spawn(function* () {
      requested.resolve();
      const result = yield* execution.stop();
      stopped = true;
      return result;
    });
    yield* requested.operation;
    expect(stopped).toBe(false);
    expect(calls).toBe(1);
    release.resolve();
    expect((yield* stop).ok).toBe(true);
    expect((yield* execution).ok).toBe(false);
    expect(finished).toBe(true);
    expect(calls).toBe(1);
  });

  for (const terminal of [false, true]) {
    it(`A8: ${terminal ? "sibling abandonment finalizes" : "enclosing unwind preserves pending finalization"}`, function* () {
      const entered = withResolvers<void>();
      const failed = withResolvers<void>();
      const finalizerReady = withResolvers<void>();
      const finalizerRelease = withResolvers<void>();
      let settled = false;
      const stream = new InMemoryStream();
      const trace: string[] = [];
      let liveEffect = 0;
      function install(held: boolean): Operation<void> {
        return registerComponents([
          {
            name: "Held",
            origin: "try-paired",
            props: noProps,
            *fn() {
              yield createDurableOperation({ type: "try_marker", name: "completed" }, function* () {
                liveEffect++;
                return "saved";
              });
              yield* ensure(() => {
                trace.push("physical");
              });
              entered.resolve();
              if (held) {
                yield* withResolvers<void>().operation;
              }
              return "body";
            },
          },
          {
            name: "Sibling",
            origin: "try-paired",
            props: noProps,
            *fn() {
              if (held) {
                yield* failed.operation;
              }
              if (terminal) {
                throw new Error("sibling failed");
              }
              return "sibling";
            },
          },
          {
            name: "Final",
            origin: "try-paired",
            props: noProps,
            *fn() {
              if (terminal) {
                yield* ensure(function* () {
                  finalizerReady.resolve();
                  yield* finalizerRelease.operation;
                  trace.push("finalizer released");
                });
              }
              trace.push("finally");
              return "final";
            },
          },
        ]);
      }
      const source =
        "<All><Spawn><Try><Held /><Finally><Final /></Finally></Try></Spawn><Spawn><Sibling /></Spawn></All>";
      const task = yield* spawn(function* () {
        yield* install(true);
        const result = yield* run(source, undefined, stream);
        settled = true;
        return result;
      });
      yield* entered.operation;
      if (terminal) {
        failed.resolve();
        yield* finalizerReady.operation;
        expect(settled).toBe(false);
        expect(
          stream
            .snapshot()
            .some((event) => event.type === "close" && event.coroutineId === "root.0"),
        ).toBe(false);
        finalizerRelease.resolve();
        expect((yield* task).result.ok).toBe(false);
        expect(trace).toEqual(["physical", "finally", "finalizer released"]);
        expect(
          stream
            .snapshot()
            .some((event) => event.type === "close" && event.result.status === "cancelled"),
        ).toBe(true);
      } else {
        yield* task.halt();
        expect(trace).toEqual(["physical"]);
        expect(stream.snapshot().filter((event) => event.type === "close")).toHaveLength(0);
        const resumed = yield* scoped(function* () {
          yield* install(false);
          return yield* run(source, undefined, stream);
        });
        expect(resumed.result.ok).toBe(true);
        expect(resumed.output).toBe("bodyfinalsibling");
        expect(liveEffect).toBe(1);
        expect(trace).toEqual(["physical", "physical", "finally"]);
      }
    });
  }

  it("A8: a callee's authored Try joins projected retained resources before recovery", function* () {
    const trace: string[] = [];
    yield* registerComponents([
      {
        name: "Keep",
        origin: "try-projection",
        props: noProps,
        *fn() {
          return yield* retain(function* () {
            yield* ensure(() => {
              trace.push("released");
            });
            return "prefix";
          });
        },
      },
      {
        name: "Recovered",
        origin: "try-projection",
        props: noProps,
        *fn() {
          trace.push("catch");
          expect(trace).toEqual(["released", "catch"]);
          return "recovered";
        },
      },
    ]);
    const result = yield* run(
      '<Recover><Keep /><Fail message="ordinary" /></Recover>',
      undefined,
      new InMemoryStream(),
      {
        "components/Recover.md":
          "<Try><Content /><Catch><Recovered /></Catch><Finally>done</Finally></Try>",
      },
    );
    expect(result.result).toEqual({ ok: true, value: "prefixrecovereddone" });
    expect(result.output).toBe("prefixrecovereddone");
    expect(trace).toEqual(["released", "catch"]);
    trace.length = 0;
    yield* registerComponents([
      {
        name: "After",
        origin: "try-projection",
        props: noProps,
        *fn() {
          trace.push("after");
          expect(trace).toEqual(["released", "after"]);
          return "after";
        },
      },
    ]);
    const nested = yield* run(
      "<Try><Plain><Keep /></Plain><After /><Finally>done</Finally></Try>",
      undefined,
      new InMemoryStream(),
      { "components/Plain.md": "<Content />" },
    );
    expect(nested.result.ok).toBe(true);
    expect(nested.output).toBe("prefixafterdone");
    expect(trace).toEqual(["released", "after"]);
  });

  it("A8: real Prompt stream teardown failure is terminal before failed-turn publication", function* () {
    const released = new Error("stream release failed");
    const initiating = new Error("initiating provider failure");
    const provider = {
      fail: true,
      trace: new Array<string>(),
      releaseError: released,
      failure: initiating,
    };
    const result = yield* run(yield* fixture("fallback"), provider);
    expect(result.result.ok).toBe(false);
    expect(provider.trace).not.toContain("prompt:codex");
    expect(result.output).not.toContain("Review attempt finished");
    expect(
      result.events.some(
        (event) =>
          event.type === "yield" &&
          event.description.type === "agent_prompt" &&
          event.result.status === "ok",
      ),
    ).toBe(false);
    if (!result.result.ok) {
      expect(
        firstCause(result.result.error, (cause) => (cause === released ? released : undefined)),
      ).toBe(released);
      expect(
        firstCause(result.result.error, (cause) => (cause === initiating ? initiating : undefined)),
      ).toBe(initiating);
    }
  });

  it("A8: nested PrintErrors cannot conceal actual invocation teardown", function* () {
    const released = new Error("release failed");
    yield* registerComponents([
      {
        name: "BadRelease",
        origin: "try-lifecycle",
        props: noProps,
        fn: printErrors(function* () {
          yield* ensure(() => {
            throw released;
          });
          throw new Error("initiating failure");
        }),
      },
    ]);
    const result = yield* run(
      "<Try><PrintErrors><BadRelease /></PrintErrors><Catch>WRONG</Catch><Finally>WRONG</Finally></Try>WRONG",
    );
    expect(result.result.ok).toBe(false);
    expect(result.output).not.toContain("WRONG");
    if (!result.result.ok) {
      expect(
        firstCause(result.result.error, (cause) =>
          cause instanceof InvocationTeardownError ? cause : undefined,
        ),
      ).toBeDefined();
    }
  });

  it("R1: failed child release never becomes recoverable through an actual retained prefix", function* () {
    yield* race([
      scoped(function* () {
        const saved = withResolvers<void>();
        const release = withResolvers<void>();
        const entered = withResolvers<void>();
        const cancelled = withResolvers<void>();
        const completed = withResolvers<void>();
        let paused = true;
        let caught = 0;
        const failure = new Error("owned native release failed");
        class History extends InMemoryStream {
          override *append(event: DurableEvent): Operation<void> {
            yield* super.append(event);
            if (
              paused &&
              event.type === "close" &&
              event.coroutineId === "root.0" &&
              event.result.status === "err"
            ) {
              saved.resolve();
              yield* release.operation;
            }
          }
        }
        const stream = new History();
        yield* registerComponents([
          {
            name: "BrokenRelease",
            origin: "try-lifecycle",
            props: noProps,
            *fn() {
              yield* ensure(function* () {
                throw failure;
              });
              yield* entered.operation;
              return "body";
            },
          },
          {
            name: "HeldSibling",
            origin: "try-lifecycle",
            props: noProps,
            *fn() {
              yield* ensure(function* () {
                cancelled.resolve();
              });
              entered.resolve();
              yield* suspend();
              return "unreachable";
            },
          },
          {
            name: "Recovered",
            origin: "try-lifecycle",
            props: noProps,
            *fn() {
              caught += 1;
              return "recovery entered";
            },
          },
        ]);
        const source =
          "<Try><All><Spawn><BrokenRelease /></Spawn><Spawn><HeldSibling /></Spawn></All><Catch><Recovered /></Catch></Try>";
        const live = yield* spawn(function* () {
          try {
            return yield* run(source, undefined, stream);
          } finally {
            completed.resolve();
          }
        });
        const boundary = yield* race([
          (function* () {
            yield* saved.operation;
            return "child close";
          })(),
          (function* () {
            yield* completed.operation;
            return "joined";
          })(),
        ]);
        if (boundary === "child close") {
          const halt = yield* spawn(() => live.halt());
          yield* cancelled.operation;
          release.resolve();
          yield* halt;
        } else {
          const result = yield* live;
          expect(result.result.ok).toBe(false);
          if (!result.result.ok) {
            expect(
              firstCause(result.result.error, (cause) => (cause === failure ? failure : undefined)),
            ).toBe(failure);
          }
          yield* cancelled.operation;
          expect(stream.snapshot().filter((event) => event.type === "close")).toHaveLength(0);
        }
        expect(
          stream.snapshot().some((event) => event.type === "close" && event.coroutineId === "root"),
        ).toBe(false);
        expect(caught).toBe(0);
        paused = false;
        const resumed = yield* run(source, undefined, stream);
        expect(caught).toBe(0);
        expect(resumed.result.ok).toBe(false);
      }),
      (function* (): Operation<never> {
        yield* sleep(10000);
        throw new Error("retained release regression deadline");
      })(),
    ]);
  });

  it("R1: invocation context replacement cannot redirect the root release fence", function* () {
    const failure = new Error("shadowed invocation release failed");
    const initiating = new Error("shadowed invocation body failed");
    let replaced: import("@executablemd/durable-streams").DurableContext | undefined;
    yield* registerComponents([
      {
        name: "ShadowedRelease",
        origin: "try-lifecycle",
        props: noProps,
        *fn() {
          const current = yield* DurableContext.expect();
          replaced = { ...current, durability: {} };
          yield* DurableContext.set(replaced);
          yield* ensure(function* () {
            throw failure;
          });
          throw initiating;
        },
      },
    ]);
    const result = yield* run(
      "<Try><All><Spawn><ShadowedRelease /></Spawn><Spawn>other</Spawn></All><Catch>WRONG</Catch><Finally>WRONG</Finally></Try>WRONG",
    );
    expect(result.result.ok).toBe(false);
    expect(result.output).not.toContain("WRONG");
    expect(
      result.events.filter((event) => event.type === "close" && event.coroutineId !== "root.1"),
    ).toHaveLength(0);
    expect(replaced?.durability?.failure).toBeUndefined();
    if (!result.result.ok) {
      expect(
        firstCause(result.result.error, (cause) => (cause === initiating ? initiating : undefined)),
      ).toBe(initiating);
      expect(
        firstCause(result.result.error, (cause) => (cause === failure ? failure : undefined)),
      ).toBe(failure);
    }
  });

  it("F1: a genuine Files failure in Catch joins cleanup and skips unentered Finally", function* () {
    let finalized = 0;
    let released = false;
    let fatal: unknown;
    yield* registerComponents([
      {
        name: "CatchInfra",
        origin: "try-lifecycle",
        props: noProps,
        *fn() {
          yield* ensure(() => {
            released = true;
          });
          yield* API.Files.around({
            *readTextFile() {
              throw new Error("provider broke read contract");
            },
          });
          try {
            yield* invokeFiles(API.Files.operations.readTextFile({ cwd: ".", path: "notes.txt" }));
          } catch (error) {
            fatal = filesFatalFailure(error);
            throw error;
          }
          return "unreachable";
        },
      },
      {
        name: "FinalMark",
        origin: "try-lifecycle",
        props: noProps,
        *fn() {
          finalized++;
          return "FINALIZED";
        },
      },
    ]);
    const result = yield* run(
      '<Try><Fail message="ordinary" /><Catch><CatchInfra /></Catch><Finally><FinalMark /></Finally></Try>WRONG',
    );
    expect(released).toBe(true);
    expect(fatal).toBeDefined();
    expect(result.result.ok).toBe(false);
    expect(finalized).toBe(0);
    expect(result.output).not.toContain("FINALIZED");
    expect(result.output).not.toContain("WRONG");
    if (!result.result.ok) {
      expect(filesFatalFailure(result.result.error)).toBe(fatal);
    }
  });

  it("A9: an actual failed attempted append fences Catch, Finally and compensating Close", function* () {
    const inner = new InMemoryStream();
    const backing = new Error("backing append failed");
    const stream = {
      readAll: () => inner.readAll(),
      *append(event: import("@executablemd/durable-streams").DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === "exec") {
          throw backing;
        }
        yield* inner.append(event);
      },
    };
    const execution = yield* start(
      "<Try>\n```sh exec\nOK\n```\n<Catch>WRONG</Catch><Finally>WRONG</Finally></Try>WRONG",
      stream,
    );
    const result = yield* execution;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DurablePersistenceError);
      expect(result.error.cause).toBe(backing);
    }
    expect(inner.snapshot().filter((event) => event.type === "close")).toHaveLength(0);
    expect(
      inner.snapshot().some((event) => event.type === "yield" && event.description.type === "exec"),
    ).toBe(false);
  });

  for (const kind of ["release", "files", "durability", "append"]) {
    it(`checked eval fences ${kind} before modifier reporting or recovery`, function* () {
      yield* useTempFileCompiler();
      const files = new FilesInvariantError("protocol");
      const backing = new Error("fixture backing append failure");
      const durability = new DurablePersistenceError("yield", backing);
      const release = new Error("fixture owning release failure");
      let attempts = 0;
      let released = 0;
      let swallowed: unknown;
      let later = 0;
      const inner = new InMemoryStream();
      const stream = {
        readAll: () => inner.readAll(),
        *append(event: DurableEvent) {
          if (event.type === "yield" && event.description.type === "eval") {
            attempts++;
            throw backing;
          }
          yield* inner.append(event);
        },
      };
      yield* Component.around({
        *applyModifiers(args, next) {
          try {
            return yield* next(...args);
          } catch (error) {
            swallowed = error;
            return { output: "WRONG", exitCode: 0, stderr: "" };
          }
        },
      });
      yield* registerComponents([
        {
          name: "Owned",
          origin: "eval-lifecycle",
          props: noProps,
          *fn() {
            yield* ensure(() => {
              released++;
              if (kind === "release") {
                throw release;
              }
              if (kind === "files") {
                throw new AggregateError([release, files]);
              }
              if (kind === "durability") {
                throw new AggregateError([files, durability]);
              }
            });
            return "checked export";
          },
        },
        {
          name: "Later",
          origin: "eval-lifecycle",
          props: noProps,
          *fn() {
            later++;
            return "WRONG";
          },
        },
      ]);
      const result = yield* run(
        "<PrintErrors><Try><EvalOwner><Owned /></EvalOwner><Catch><Later /></Catch><Finally><Later /></Finally></Try><Later /></PrintErrors>",
        undefined,
        stream,
        {
          "components/EvalOwner.md": "~~~js eval\nconst exported = yield* renderChildren();\n~~~",
        },
      );
      expect(released).toBe(1);
      expect(later).toBe(0);
      expect(result.output).not.toContain("WRONG");
      expect(attempts).toBe(kind === "append" ? 1 : 0);
      expect(
        inner
          .snapshot()
          .some(
            (event) =>
              event.type === "close" ||
              (event.type === "yield" && event.description.type === "eval"),
          ),
      ).toBe(false);
      expect(result.result.ok).toBe(false);
      if (!result.result.ok) {
        expect(result.result.error).toBe(swallowed);
        if (kind === "files") {
          expect(result.result.error).toBe(files);
        } else if (kind === "durability") {
          expect(result.result.error).toBe(durability);
        } else if (kind === "append") {
          expect(result.result.error).toBeInstanceOf(DurablePersistenceError);
          expect(result.result.error.cause).toBe(backing);
        } else {
          expect(
            firstCause(result.result.error, (cause) => (cause === release ? release : undefined)),
          ).toBe(release);
          expect(
            firstCause(result.result.error, (cause) =>
              cause instanceof InvocationTeardownError ? cause : undefined,
            ),
          ).toBeDefined();
        }
      }
    });
  }

  for (const kind of ["files", "durability"]) {
    it(`A9: ${kind} failure beneath teardown wins by identity`, function* () {
      const failure =
        kind === "files"
          ? new FilesProviderUnavailableError()
          : new DurablePersistenceError("yield", new Error("append failed"));
      yield* registerComponents([
        {
          name: "Fatal",
          origin: "try-lifecycle",
          props: noProps,
          *fn() {
            yield* ensure(() => {
              throw new AggregateError([new Error("other release"), failure]);
            });
            throw new Error("ordinary body");
          },
        },
      ]);
      const result = yield* run(
        "<Try><Fatal /><Catch>WRONG</Catch><Finally>WRONG</Finally></Try>WRONG",
      );
      expect(result.result.ok).toBe(false);
      expect(result.output).not.toContain("WRONG");
      if (!result.result.ok) {
        expect(
          kind === "files"
            ? filesFatalFailure(result.result.error)
            : durabilityFailure(result.result.error),
        ).toBe(failure);
      }
    });
  }
});
