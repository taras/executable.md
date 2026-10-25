import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, Ok, scoped } from "effection";
import { Files } from "../files.ts";
import { registerFileRecorder, assembleFileCall } from "../files-host.ts";

describe("entry Files continuation", () => {
  it("excludes only its exact recorder and keeps inline scope and teardown", function* () {
    const value = createContext<string>("test.mount.files.inline", "initial");
    const order: string[] = [];
    let direct = Files.operations.readTextFile;
    yield* scoped(function* () {
      yield* Files.around({
        *readTextFile([input], next) {
          order.push("outer");
          const result = yield* next(input);
          order.push("outer-after");
          return result;
        },
      });
      const boundary = {
        *readTextFile(
          [input]: Parameters<typeof Files.operations.readTextFile>,
          next: typeof Files.operations.readTextFile,
        ) {
          order.push("recorder");
          return yield* next(input);
        },
      };
      const handle = yield* registerFileRecorder(boundary);
      direct = assembleFileCall(handle, "readTextFile");
      yield* Files.around({
        *readTextFile([input], next) {
          yield* ensure(() => {
            order.push("released");
          });
          yield* value.set(input.path);
          const result = yield* next({ ...input, path: "terminal" });
          expect(yield* value.get()).toBe("selected");
          return result;
        },
      });
      yield* Files.around(
        {
          *readTextFile([input]) {
            order.push(input.path);
            return Ok("text");
          },
        },
        { at: "min" },
      );
      expect(yield* direct({ cwd: "/", path: "selected" })).toEqual(Ok("text"));
      expect(yield* value.get()).toBe("selected");
      expect(order).toEqual(["outer", "terminal", "outer-after"]);
    });
    expect(order.at(-1)).toBe("released");
    let error: unknown;
    try {
      yield* direct({ cwd: "/", path: "late" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
  });
});

import { Err, spawn } from "effection";
import { filesFailure } from "../files.ts";
describe("additional focused boundary 1", () => {
  it("keeps synthetic outcomes, repeated delegation and descendant calls inline", function* () {
    const values = createContext<number>("test.mount.files.repeat", 0);
    const entered: string[] = [];
    const boundary = {
      *readTextFile(
        [input]: Parameters<typeof Files.operations.readTextFile>,
        next: typeof Files.operations.readTextFile,
      ) {
        entered.push("B");
        return yield* next(input);
      },
    };
    const handle = yield* registerFileRecorder(boundary);
    const call = assembleFileCall(handle, "readTextFile");
    yield* Files.around({
      *readTextFile([input], next) {
        const before = yield* values.expect();
        const first = yield* next({ ...input, path: "one" });
        const second = yield* next({ ...input, path: "two" });
        if (first.ok && second.ok) {
          expect(yield* values.get()).toBe(before + 2);
        }
        return first.ok && second.ok ? Ok(first.value + second.value) : first;
      },
    });
    yield* Files.around(
      {
        *readTextFile([input]) {
          yield* values.set((yield* values.expect()) + 1);
          return Ok(input.path);
        },
      },
      { at: "min" },
    );
    expect(yield* call({ cwd: "/", path: "original" })).toEqual(Ok("onetwo"));
    expect(entered).toEqual([]);
    yield* scoped(function* () {
      yield* Files.around({
        *readTextFile() {
          return Err(filesFailure({ operation: "read", phase: "access", reason: "missing" }));
        },
      });
      const result = yield* call({ cwd: "/", path: "synthetic" });
      expect(result.ok).toBe(false);
    });
    const task = yield* spawn(() => call({ cwd: "/", path: "descendant" }));
    expect(yield* task).toEqual(Ok("onetwo"));
    expect(yield* Files.operations.readTextFile({ cwd: "/", path: "raw" })).toEqual(Ok("onetwo"));
    expect(entered).toEqual(["B"]);
    entered.length = 0;
    yield* Files.around(boundary);
    let refused: unknown;
    try {
      yield* call({ cwd: "/", path: "duplicate" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
    expect(entered).toEqual([]);
  });
});
