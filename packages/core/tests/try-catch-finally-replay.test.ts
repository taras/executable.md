import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, scoped, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import {
  createDurableOperation,
  InMemoryStream,
  DurablePersistenceError,
} from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { Component } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import { fixture, run, start } from "./try-catch-finally-harness.ts";

const noProps = { type: "object", properties: {}, additionalProperties: false };

describe("Try retained continuation", () => {
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
