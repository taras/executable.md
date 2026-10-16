import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Execution } from "../api.ts";
import { parseFilesFatal } from "@executablemd/runtime";
import { fatalCause } from "../src/errors.ts";
import { collect, execute, Execution as RootExecution, inlineSource } from "../mod.ts";
import { executeInstalled, Markdown, sourceDigest } from "../host.ts";
import type { JournalAdmission } from "../host.ts";
import { useSelection } from "./support/generated-selection.ts";
import { Documentation } from "../src/documentation-api.ts";
import { recordedFiles, useRecordedFiles } from "./support/fragment-files.ts";

const State = createContext<{ id: number } | undefined>("executablemd.test.init.state", undefined);

function* run(text = "hello\n"): Operation<string> {
  return String(
    yield* collect(
      yield* execute({ ...inlineSource(text), stream: new InMemoryStream(), includes: [] }),
    ),
  );
}

function* failure(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("Tier EI — execution-owned initialization", () => {
  it("EI1: the public descriptors agree, default init is no-op and each fresh owner dispatches once", function* () {
    expect(Execution).toBe(RootExecution);
    yield* Execution.operations.init();
    expect(yield* State.get()).toBe(undefined);
    let calls = 0;
    yield* Execution.around({
      *init(_args, next) {
        calls += 1;
        yield* State.set({ id: calls });
        yield* next();
      },
    });
    const execution = yield* execute({
      ...inlineSource("hello\n"),
      stream: new InMemoryStream(),
      includes: [],
    });
    expect(String(yield* collect(execution))).toContain("hello");
    const completed = yield* execution;
    expect(yield* execution).toBe(completed);
    expect(calls).toBe(1);
    yield* run();
    expect(calls).toBe(2);
    expect(yield* State.get()).toBe(undefined);
  });

  it("EI2: initialization precedes assembly, captured documentation and execution/document policy", function* () {
    const order: string[] = [];
    yield* Execution.around({
      *init(_args, next) {
        order.push("init");
        yield* State.set({ id: 7 });
        yield* next();
      },
      *execute([request], next) {
        expect((yield* State.expect())?.id).toBe(7);
        order.push("execute");
        yield* next(request);
      },
      *document([request], next) {
        expect((yield* State.expect())?.id).toBe(7);
        order.push("document");
        yield* next(request);
      },
    });
    yield* Documentation.around({
      *contributions([read], next) {
        expect((yield* State.expect())?.id).toBe(7);
        order.push("documentation");
        return yield* next(read);
      },
    });
    const execution = yield* executeInstalled(
      { ...inlineSource("<Syntax />\n"), includes: [], stream: new InMemoryStream() },
      [
        {
          *install() {
            expect((yield* State.expect())?.id).toBe(7);
            order.push("install");
          },
        },
      ],
    );
    expect(String(yield* collect(execution))).toContain("### `<Syntax>`");
    expect(order).toEqual(["init", "install", "documentation", "execute", "document"]);
  });

  /**
   * EI3 — what init runs *after*, and what it runs *before*.
   *
   * Admissions and declarations are read once and copied before any
   * installation runs, so init editing the host's arrays changes nothing. The
   * generated selection is deliberately the other way round: init is where a
   * host establishes it, and core reads the final contextual answer afterwards
   * — before public execution policy, which is the boundary the selection is
   * protected at. That half is `generated-selection` U5-2's.
   */
  it("EI3: init cannot rewrite captured admissions or declarations", function* () {
    const admitted: string[] = [];
    const admissions: JournalAdmission[] = [
      function* () {
        admitted.push("original");
      },
    ];
    const source = "CAPTURED DECLARATION\n";
    const declarations = [
      Markdown({ name: "Kept", origin: "test://init/kept", source, digest: sourceDigest(source) }),
    ];
    const files = recordedFiles({ "note.md": "CAPTURED PROFILE" });
    yield* Execution.around({
      *init(_args, next) {
        admissions.length = 0;
        declarations.length = 0;
        // The selection, established here: this is init's own job rather than
        // something it is editing behind core's back.
        yield* useSelection({ File: ["self-closing"] });
        yield* useRecordedFiles(files);
        yield* next();
      },
    });
    const text = "<Kept />\n<Evaluate text={'<File path=\"note.md\" />'} />\n";
    const execution = yield* executeInstalled(
      { ...inlineSource(text), includes: [], stream: new InMemoryStream() },
      [{ admissions, declarations }],
    );
    const output = String(yield* collect(execution));
    expect(admitted).toEqual(["original"]);
    expect(output).toContain("CAPTURED DECLARATION");
    expect(output).toContain("CAPTURED PROFILE");
    expect(files.performed).toEqual(["read note.md"]);
  });

  it("EI4: initializer failure settles only after acquired teardown and reaches no policy or root", function* () {
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const cleanup = withResolvers<void>();
    const phases: string[] = [];
    const stream = new InMemoryStream();
    yield* Execution.around({
      *init() {
        yield* ensure(function* () {
          cleanup.resolve();
          yield* release.operation;
          phases.push("released");
        });
        entered.resolve();
        throw new Error("init refused");
      },
      *execute([request], next) {
        phases.push("policy");
        yield* next(request);
      },
    });
    let settled = false;
    const running = yield* spawn(function* () {
      const error = yield* failure(
        execute({ ...inlineSource("must not run"), stream, includes: [] }),
      );
      settled = true;
      return error;
    });
    yield* entered.operation;
    yield* cleanup.operation;
    expect(settled).toBe(false);
    expect(stream.snapshot()).toEqual([]);
    release.resolve();
    expect(String(yield* running)).toContain("init refused");
    expect(phases).toEqual(["released"]);
  });

  it("EI5: deterministic cancellation during init joins cleanup before halt returns", function* () {
    const entered = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    const phases: string[] = [];
    const stream = new InMemoryStream();
    yield* Execution.around({
      *init() {
        yield* ensure(function* () {
          cleaning.resolve();
          yield* release.operation;
          phases.push("released");
        });
        entered.resolve();
        yield* suspend();
      },
      *execute([request], next) {
        phases.push("policy");
        yield* next(request);
      },
    });
    const running = yield* spawn(() =>
      execute({ ...inlineSource("must not run"), stream, includes: [] }),
    );
    yield* entered.operation;
    let halted = false;
    const halting = yield* spawn(function* () {
      yield* running.halt();
      halted = true;
    });
    yield* cleaning.operation;
    expect(halted).toBe(false);
    expect(stream.snapshot()).toEqual([]);
    release.resolve();
    yield* halting;
    expect(phases).toEqual(["released"]);
  });

  it("EI6: concurrent owners get independent state inherited by ordinary descendants", function* () {
    let counter = 0;
    const both = withResolvers<void>();
    const release = withResolvers<void>();
    const seen: number[] = [];
    yield* Execution.around({
      *init(_args, next) {
        yield* State.set({ id: ++counter });
        yield* next();
      },
      *execute([request], next) {
        seen.push((yield* State.expect())?.id ?? 0);
        if (seen.length === 2) {
          both.resolve();
        }
        yield* release.operation;
        const parent = yield* State.get();
        expect(yield* scoped(() => State.get())).toBe(parent);
        yield* next(request);
      },
    });
    const first = yield* spawn(() => run());
    const second = yield* spawn(() => run());
    yield* both.operation;
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(yield* State.get()).toBe(undefined);
    release.resolve();
    yield* first;
    yield* second;
    expect(yield* scoped(() => State.get())).toBe(undefined);
  });

  it("EI7: a no-op initializer invents no Files provider; explicit initialization supplies one", function* () {
    expect(parseFilesFatal(fatalCause(yield* failure(run('<File path="note.md" />'))))).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "provider-unavailable",
    });
    const files = recordedFiles({ "note.md": "INSTALLED BY INIT" });
    const output = yield* scoped(function* () {
      yield* Execution.around({
        *init(_args, next) {
          yield* useRecordedFiles(files);
          yield* next();
        },
      });
      return yield* run('<File path="note.md" />');
    });
    expect(output).toContain("INSTALLED BY INIT");
    expect(files.performed).toEqual(["read note.md"]);
    expect(parseFilesFatal(fatalCause(yield* failure(run('<File path="note.md" />'))))).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "provider-unavailable",
    });
  });
});
