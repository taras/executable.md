import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, race, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import {
  createDurableOperation,
  InMemoryStream,
  DurablePersistenceError,
  ReplayGuard,
} from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { Component } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { invokeFiles } from "../src/files.ts";
import { filesFatalFailure } from "../src/errors.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import { fixture, run, start } from "./try-catch-finally-harness.ts";

const noProps = { type: "object", properties: {}, additionalProperties: false };

describe("Try retained continuation", () => {
  it("preserves the durable owner's exact selected Error through a replayed Files operation", function* () {
    const stream = new InMemoryStream();
    const entered = withResolvers<void>();
    const selected = new Error("owned replay checkpoint");
    let reads = 0;
    let after = 0;
    let released = 0;
    let held = true;
    yield* registerComponents([
      {
        name: "GuardedRead",
        origin: "try-replay",
        props: noProps,
        *fn() {
          yield* ensure(() => {
            released++;
          });
          yield* API.Files.around({
            *readTextFile([input]) {
              const text = yield createDurableOperation(
                { type: "guarded_file_read", name: "read", path: input.path },
                function* () {
                  reads++;
                  return "retained file";
                },
              );
              if (typeof text !== "string") {
                throw new Error("recorded Files read did not return text");
              }
              return Ok(text);
            },
          });
          yield* invokeFiles(API.Files.operations.readTextFile({ cwd: ".", path: "notes.txt" }));
          entered.resolve();
          if (held) {
            yield* suspend();
          }
          after++;
          return "WRONG";
        },
      },
    ]);
    const source = "<Try><GuardedRead /><Catch>WRONG</Catch><Finally>WRONG</Finally></Try>WRONG";
    const live = yield* spawn(() => run(source, undefined, stream));
    yield* entered.operation;
    yield* live.halt();
    expect(reads).toBe(1);
    expect(released).toBe(1);
    const prefix = stream.snapshot();
    expect(
      prefix.some(
        (event) => event.type === "yield" && event.description.type === "guarded_file_read",
      ),
    ).toBe(true);
    expect(prefix.some((event) => event.type === "close")).toBe(false);
    held = false;
    yield* ReplayGuard.around({
      decide([event], next) {
        return event.description.type === "guarded_file_read"
          ? { outcome: "error", error: selected }
          : next(event);
      },
    });
    const resumed = yield* run(source, undefined, stream);
    expect(resumed.result.ok).toBe(false);
    if (!resumed.result.ok) {
      expect(resumed.result.error).toBe(selected);
    }
    expect(reads).toBe(1);
    expect(after).toBe(0);
    expect(released).toBe(2);
    expect(resumed.output).not.toContain("WRONG");
    expect(stream.snapshot()).toEqual(prefix);
  });

  for (const kind of ["Files", "ordinary"]) {
    it(`F2: ${kind} child failure keeps its recovery policy across the actual retained prefix`, function* () {
      yield* race([
        scoped(function* () {
          const saved = withResolvers<void>();
          const release = withResolvers<void>();
          const entered = withResolvers<void>();
          const cancelled = withResolvers<void>();
          const completed = withResolvers<void>();
          let paused = true;
          let caught = 0;
          let released = 0;
          const fatals: unknown[] = [];
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
              name: "ChildInfra",
              origin: "try-replay",
              props: noProps,
              *fn() {
                yield* ensure(() => {
                  released++;
                });
                yield* entered.operation;
                if (kind === "ordinary") {
                  throw new Error("ordinary child failure");
                }
                yield* API.Files.around({
                  *readTextFile() {
                    throw new Error("provider broke read contract");
                  },
                });
                try {
                  yield* invokeFiles(
                    API.Files.operations.readTextFile({ cwd: ".", path: "notes.txt" }),
                  );
                } catch (error) {
                  fatals.push(filesFatalFailure(error));
                  throw error;
                }
                return "unreachable";
              },
            },
            {
              name: "HeldInfraSibling",
              origin: "try-replay",
              props: noProps,
              *fn() {
                yield* ensure(() => {
                  cancelled.resolve();
                });
                entered.resolve();
                yield* suspend();
                return "unreachable";
              },
            },
            {
              name: "InfraRecovered",
              origin: "try-replay",
              props: noProps,
              *fn() {
                caught++;
                return "RECOVERED";
              },
            },
          ]);
          const source =
            "<Try><All><Spawn><ChildInfra /></Spawn><Spawn><HeldInfraSibling /></Spawn></All><Catch><InfraRecovered /></Catch></Try>";
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
            expect(kind).toBe("Files");
            expect(result.result.ok).toBe(false);
            expect(fatals[0]).toBeDefined();
            if (!result.result.ok) {
              expect(filesFatalFailure(result.result.error)).toBe(fatals[0]);
            }
            yield* cancelled.operation;
            expect(stream.snapshot().filter((event) => event.type === "close")).toHaveLength(0);
          }
          expect(released).toBe(1);
          expect(caught).toBe(0);
          expect(
            stream
              .snapshot()
              .some((event) => event.type === "close" && event.coroutineId === "root"),
          ).toBe(false);
          paused = false;
          const resumed = yield* run(source, undefined, stream);
          if (kind === "Files") {
            expect(caught).toBe(0);
            expect(resumed.result.ok).toBe(false);
            expect(resumed.output).not.toContain("RECOVERED");
            expect(fatals[fatals.length - 1]).toBeDefined();
            if (!resumed.result.ok) {
              expect(filesFatalFailure(resumed.result.error)).toBe(fatals[fatals.length - 1]);
            }
          } else {
            expect(boundary).toBe("child close");
            expect(caught).toBe(1);
            expect(resumed.result.ok).toBe(true);
            expect(resumed.output).toContain("RECOVERED");
            expect(released).toBe(1);
          }
        }),
        (function* (): Operation<never> {
          yield* sleep(10000);
          throw new Error("retained infrastructure regression deadline");
        })(),
      ]);
    });
  }

  for (const frontier of ["Catch", "Finally", "finalizer effect"]) {
    it(`A7: resumes the genuine prefix at ${frontier} without repeating completed providers or effects`, function* () {
      const stream = new InMemoryStream();
      const entered = withResolvers<void>();
      const trace: string[] = [];
      let effects = 0;
      const source = (yield* fixture("fallback")).replace(
        "Review attempt finished.",
        "<Mark /><Frontier />Review attempt finished.",
      );
      function* install(held: boolean): Operation<void> {
        yield* registerComponents([
          {
            name: "Mark",
            origin: "try-replay",
            props: noProps,
            *fn() {
              yield createDurableOperation({ type: "try_finalizer", name: "mark" }, function* () {
                effects++;
                return "acknowledged";
              });
              return "";
            },
          },
          {
            name: "Frontier",
            origin: "try-replay",
            props: noProps,
            *fn() {
              if (held && frontier === "finalizer effect") {
                entered.resolve();
                yield* withResolvers<void>().operation;
              }
              return "";
            },
          },
        ]);
        if (held && frontier !== "finalizer effect") {
          yield* Component.around({
            *expand([request], next) {
              if (request.expansion.name === frontier) {
                entered.resolve();
                yield* withResolvers<void>().operation;
              }
              yield* next(request);
            },
          });
        }
      }
      const initial = yield* spawn(function* () {
        yield* install(true);
        return yield* run(source, { fail: true, trace }, stream);
      });
      yield* entered.operation;
      yield* initial.halt();
      expect(
        stream.snapshot().some((event) => event.type === "close" && event.coroutineId === "root"),
      ).toBe(false);
      const callsBefore = [...trace.filter((entry) => entry.startsWith("prompt:"))];
      const effectBefore = effects;
      const resumed = yield* scoped(function* () {
        yield* install(false);
        return yield* run(source, { fail: true, trace }, stream);
      });
      expect(resumed.result.ok).toBe(true);
      expect(resumed.output).toMatch(
        /primary unavailable[\s\S]*PASS[\s\S]*Review attempt finished/,
      );
      expect(trace.filter((entry) => entry.startsWith("prompt:"))).toEqual([
        "prompt:claude",
        "prompt:codex",
      ]);
      expect(callsBefore).toEqual(
        frontier === "Catch" ? ["prompt:claude"] : ["prompt:claude", "prompt:codex"],
      );
      expect(effects).toBe(1);
      expect(effectBefore).toBe(frontier === "finalizer effect" ? 1 : 0);
      const replayTrace: string[] = [];
      const replay = yield* scoped(function* () {
        yield* install(false);
        return yield* run(source, { fail: true, trace: replayTrace }, stream);
      });
      expect(replay.result).toEqual(resumed.result);
      expect(replay.output).toBe(resumed.output);
      expect(replayTrace).toEqual([]);
      expect(effects).toBe(1);
    });
  }

  for (const refuseClose of [false, true]) {
    it(`A7: ${refuseClose ? "acknowledged cleanup without cancelled Close refuses cold continuation" : "completed exact Stop replays no body or finalizer"}`, function* () {
      const source = yield* fixture("progress-cleanup");
      const inner = new InMemoryStream();
      const backingFailure = new Error("cancelled Close rejected");
      const stream = {
        readAll: () => inner.readAll(),
        *append(event: DurableEvent): Operation<void> {
          if (
            refuseClose &&
            event.type === "close" &&
            event.coroutineId === "root" &&
            event.result.status === "cancelled"
          ) {
            throw backingFailure;
          }
          yield* inner.append(event);
        },
      };
      let deletions = 0;
      yield* API.Files.around({
        *deleteFile([input], next) {
          yield createDurableOperation(
            { type: "test_file_delete", name: input.path },
            function* () {
              const result = yield* next(input);
              if (!result.ok) {
                throw result.error;
              }
              deletions++;
              return null;
            },
          );
          return Ok(undefined);
        },
      });
      const entered = withResolvers<void>();
      let bodyCalls = 0;
      let physicalCleanup = 0;
      yield* Elicitation.around({
        *elicit() {
          bodyCalls++;
          yield* ensure(() => {
            physicalCleanup++;
          });
          entered.resolve();
          return yield* withResolvers<string>().operation;
        },
      });
      const execution = yield* start(source, stream);
      yield* entered.operation;
      const stop = yield* execution.stop();
      expect(stop.ok).toBe(!refuseClose);
      if (!stop.ok) {
        expect(stop.error).toBeInstanceOf(DurablePersistenceError);
      }
      expect(physicalCleanup).toBe(1);
      expect(deletions).toBe(1);
      const prefix = inner.snapshot();
      expect(
        prefix.some(
          (event) => event.type === "yield" && JSON.stringify(event.description).includes("delete"),
        ),
      ).toBe(true);
      expect(prefix.some((event) => event.type === "close" && event.coroutineId === "root")).toBe(
        !refuseClose,
      );
      const replay = yield* run(source, undefined, inner);
      expect(replay.result.ok).toBe(false);
      expect(bodyCalls).toBe(1);
      expect(physicalCleanup).toBe(1);
      expect(inner.snapshot()).toEqual(prefix);
      expect(deletions).toBe(1);
    });
  }
});
