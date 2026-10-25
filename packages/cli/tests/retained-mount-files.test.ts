import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { mountedRun, trace } from "./support/mount-run.ts";
import { MOUNT_FILE } from "../src/repl/mount-records.ts";

const question = '<Elicit schema={{ type: "object" }} as="answer">Continue?</Elicit>';
describe("retained mount files", () => {
  for (const current of ["/old", "/new", undefined]) {
    it(`restores saved read before a new read under ${current ?? "omission"}`, function* () {
      const stream = new InMemoryStream();
      const source = `<Dir path="/reference"><File path="old.md" as="saved" />${question}{saved}<File path="next.md" /></Dir>`;
      const first = trace();
      yield* mountedRun(source, stream, [{ source: "/old", target: "/reference" }], first, {
        pause: true,
        onRead: () => "historical",
      });
      const before = yield* stream.readAll();
      expect(
        before.filter((event) => event.type === "yield" && event.description.type === MOUNT_FILE),
      ).toHaveLength(1);
      const second = trace();
      const mounts = current === undefined ? [] : [{ source: current, target: "/reference" }];
      const output = yield* mountedRun(source, stream, mounts, second, { onRead: () => "live" });
      expect(output).toContain("historical");
      expect(output).toContain("live");
      expect(second.reads).toEqual([{ cwd: current ?? "/reference", path: "next.md" }]);
      const fresh = trace();
      yield* mountedRun(
        '<Dir path="/reference"><File path="old.md" /></Dir>',
        new InMemoryStream(),
        mounts,
        fresh,
      );
      expect(fresh.reads).toHaveLength(1);
    });
  }
  it("replays a covered ensure's own Unit after reassignment without current ensure IO", function* () {
    const stream = new InMemoryStream();
    const source = `<Dir path="/reference">${question}<File path="next.md" /></Dir>`;
    const first = trace();
    yield* mountedRun(source, stream, [{ source: "/owned/old", target: "/reference" }], first, {
      pause: true,
      workspace: "/owned",
    });
    const second = trace();
    const output = yield* mountedRun(
      source,
      stream,
      [{ source: "/missing/new", target: "/reference" }],
      second,
      { workspace: "/owned" },
    );
    expect(second.ensures).toEqual([]);
    expect(second.reads).toEqual([{ cwd: "/missing/new", path: "next.md" }]);
    expect(output).toContain("/missing/new/next.md");
  });
  it("keeps an external ensure live and gates children on its refusal", function* () {
    const calls = trace();
    let failure: unknown;
    try {
      yield* mountedRun(
        '<Dir path="/reference"><File path="never.md" /></Dir>',
        new InMemoryStream(),
        [{ source: "/external", target: "/reference" }],
        calls,
        { refuseEnsure: true },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(calls.reads).toEqual([]);
  });
});

import { API, filesFailure } from "@executablemd/runtime";
import { Err, Ok, scoped, spawn, suspend, withResolvers, ensure } from "effection";
import { DurablePersistenceError } from "@executablemd/durable-streams";
describe("additional focused boundary 1", () => {
  it("an ensure whose append fails binds no child and preserves the first persistence failure", function* () {
    const stream = new InMemoryStream();
    const original = new Error("fixture append failure");
    stream.onAppend = (event) => {
      if (event.type === "yield" && event.description.type === MOUNT_FILE) {
        throw original;
      }
    };
    const calls = trace();
    let failure: unknown;
    try {
      yield* mountedRun(
        '<Dir path="/reference"><File path="never" /></Dir>',
        stream,
        [{ source: "/owned/source", target: "/reference" }],
        calls,
        { workspace: "/owned" },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    expect(failure instanceof Error && failure.cause).toBe(original);
    expect(calls.ensures).toHaveLength(1);
    expect(calls.reads).toEqual([]);
    expect(
      (yield* stream.readAll()).filter(
        (event) => event.type === "yield" && event.description.type === MOUNT_FILE,
      ),
    ).toEqual([]);
  });
});
describe("additional focused boundary 2", () => {
  it("cancellation joins a pending ensure before any child and restores enclosing cwd", function* () {
    const entered = withResolvers<void>();
    let released = false;
    const calls = trace();
    const task = yield* spawn(() =>
      mountedRun(
        '<Dir path="/reference"><File path="never" /></Dir>',
        new InMemoryStream(),
        [{ source: "/external", target: "/reference" }],
        calls,
        {
          *before() {
            yield* API.Files.around({
              *ensureDirectory() {
                yield* ensure(() => {
                  released = true;
                });
                entered.resolve();
                yield* suspend();
                return Ok(undefined);
              },
            });
          },
        },
      ),
    );
    yield* entered.operation;
    yield* task.halt();
    expect(released).toBe(true);
    expect(calls.reads).toEqual([]);
  });
});
describe("additional focused boundary 3", () => {
  it("retains a composed safe refusal and bypasses all middleware when replaying it", function* () {
    const source = '<Dir path="/reference"><File path="refused.md" /></Dir>';
    const stream = new InMemoryStream();
    const first = trace();
    const options = {
      *before() {
        yield* API.Files.around({
          *readTextFile() {
            return Err(
              filesFailure({ operation: "read", phase: "access", reason: "permission-denied" }),
            );
          },
        });
      },
    };
    const output = yield* mountedRun(
      source,
      stream,
      [{ source: "/external", target: "/reference" }],
      first,
      options,
    );
    expect(output).toContain("permission denied");
    const events = yield* stream.readAll();
    const partial = new InMemoryStream(events.filter((event) => event.type !== "close"));
    let reads = 0;
    yield* mountedRun(source, partial, [{ source: "/different", target: "/reference" }], trace(), {
      *before() {
        yield* API.Files.around({
          *readTextFile() {
            reads++;
            throw new Error("replayed read reached middleware");
          },
        });
      },
    });
    expect(reads).toBe(0);
  });
});

import { Component } from "@executablemd/core/api";
import { cwd } from "@executablemd/runtime";
describe("additional focused boundary 4", () => {
  it("an acknowledged Unit precedes child admission and survives joined cancellation", function* () {
    const stream = new InMemoryStream();
    const calls = trace();
    const child = withResolvers<void>();
    let restored = false;
    const task = yield* spawn(() =>
      mountedRun(
        '<Dir path="/reference"><File path="next.md" /></Dir>',
        stream,
        [{ source: "/owned/source", target: "/reference" }],
        calls,
        {
          workspace: "/owned",
          *before() {
            yield* Component.around({
              *expand([request], next) {
                if (request.expansion.name === "File") {
                  expect(yield* cwd()).toBe("/owned/source");
                  yield* ensure(() => {
                    restored = true;
                  });
                  child.resolve();
                  yield* suspend();
                }
                yield* next(request);
              },
            });
          },
        },
      ),
    );
    yield* child.operation;
    expect(
      (yield* stream.readAll()).filter(
        (event) => event.type === "yield" && event.description.type === MOUNT_FILE,
      ),
    ).toHaveLength(1);
    yield* task.halt();
    expect(restored).toBe(true);
    expect(calls.reads).toEqual([]);
    const resumed = trace();
    yield* mountedRun(
      '<Dir path="/reference"><File path="next.md" /></Dir>',
      stream,
      [{ source: "/owned/new", target: "/reference" }],
      resumed,
      { workspace: "/owned" },
    );
    expect(resumed.ensures).toEqual([]);
    expect(resumed.reads).toEqual([{ cwd: "/owned/new", path: "next.md" }]);
  });
});
describe("additional focused boundary 5", () => {
  it("replays its own ordinary ensure refusal without installing children", function* () {
    const source = `<PrintErrors><Dir path="/reference"><File path="never" /></Dir></PrintErrors>${question}`;
    const stream = new InMemoryStream();
    yield* mountedRun(source, stream, [{ source: "/owned/old", target: "/reference" }], trace(), {
      workspace: "/owned",
      pause: true,
      refuseEnsure: true,
    });
    const calls = trace();
    yield* mountedRun(source, stream, [{ source: "/owned/new", target: "/reference" }], calls, {
      workspace: "/owned",
    });
    expect(calls.ensures).toEqual([]);
    expect(calls.reads).toEqual([]);
  });
});

import type { DurableEvent } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { FilesInvariantError } from "@executablemd/runtime";
describe("additional focused boundary 6", () => {
  it("joins cancellation during append without granting a historical Unit", function* () {
    const entered = withResolvers<void>();
    let settled = false;
    const enclosing = yield* cwd();
    class PendingAppend extends InMemoryStream {
      override *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === MOUNT_FILE) {
          yield* ensure(() => {
            settled = true;
          });
          entered.resolve();
          yield* suspend();
        }
        yield* super.append(event);
      }
    }
    const stream = new PendingAppend();
    const calls = trace();
    const task = yield* spawn(() =>
      mountedRun(
        '<Dir path="/reference"><File path="never" /></Dir>',
        stream,
        [{ source: "/owned/source", target: "/reference" }],
        calls,
        { workspace: "/owned" },
      ),
    );
    yield* entered.operation;
    expect(calls.ensures).toHaveLength(1);
    expect(calls.reads).toEqual([]);
    yield* task.halt();
    expect(settled).toBe(true);
    expect(yield* cwd()).toBe(enclosing);
    expect(
      (yield* stream.readAll()).some(
        (event) => event.type === "yield" && event.description.type === MOUNT_FILE,
      ),
    ).toBe(false);
  });
});
describe("additional focused boundary 7", () => {
  it("fences malformed provider settlement without publishing a success or admitting children", function* () {
    const stream = new InMemoryStream();
    const calls = trace();
    let failure: unknown;
    try {
      yield* mountedRun(
        '<Dir path="/reference"><File path="never" /></Dir>',
        stream,
        [{ source: "/owned/source", target: "/reference" }],
        calls,
        {
          workspace: "/owned",
          *before() {
            yield* API.Files.around({
              *ensureDirectory() {
                return new Proxy(Ok(undefined), {
                  get(target, property, receiver) {
                    if (property === "ok") {
                      throw new Error("invalid fixture getter");
                    }
                    return Reflect.get(target, property, receiver);
                  },
                });
              },
            });
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FilesInvariantError);
    expect(calls.reads).toEqual([]);
    expect(
      (yield* stream.readAll()).some(
        (event) => event.type === "yield" && event.description.type === MOUNT_FILE,
      ),
    ).toBe(false);
  });
});
describe("whole composed answer retention", () => {
  it("retains one outer answer and the original request around transformed repeated delegation", function* () {
    const stream = new InMemoryStream();
    const first = trace();
    const source = `<Dir path="/reference"><File path="original.md" />${question}</Dir>`;
    yield* mountedRun(source, stream, [{ source: "/external", target: "/reference" }], first, {
      pause: true,
      *before() {
        yield* API.Files.around({
          *readTextFile([input], next) {
            const one = yield* next({ ...input, path: "one.md" });
            const two = yield* next({ ...input, path: "two.md" });
            return one.ok && two.ok ? Ok(`outer:${one.value}|${two.value}`) : one;
          },
        });
      },
    });
    expect(first.reads).toEqual([
      { cwd: "/external", path: "one.md" },
      { cwd: "/external", path: "two.md" },
    ]);
    const events = (yield* stream.readAll()).filter(
      (event) => event.type === "yield" && event.description.type === MOUNT_FILE,
    );
    expect(events).toHaveLength(1);
    const calls = trace();
    const output = yield* mountedRun(
      source,
      stream,
      [{ source: "/new", target: "/reference" }],
      calls,
      {
        *before() {
          yield* API.Files.around({
            *readTextFile() {
              throw new Error("composed replay ran middleware");
            },
          });
        },
      },
    );
    expect(output).toContain("outer:/external/one.md|/external/two.md");
    expect(calls.reads).toEqual([]);
  });
});
