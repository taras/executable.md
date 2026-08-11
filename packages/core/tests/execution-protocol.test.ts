/**
 * Tier EP — the capability-backed execution protocol.
 *
 * `Execution.execute` middleware is policy. It is handed a request, not an
 * execution: it may read the options, narrow them, register an additive
 * completion failure, install contextual behavior, refuse, and delegate. What
 * it may not do is *complete* an execution — and the tests below are mostly
 * about what happens when something tries.
 *
 * Every refusal is checked the same way: the journal is a real `InMemoryStream`
 * and it must be untouched. A protocol failure that still managed to read the
 * history, expand the document, or append a Yield or Close would be a refusal
 * in name only.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { createApi } from "@effectionx/context-api";
import type { Api } from "@effectionx/context-api";
import { DurablePersistenceError, InMemoryStream } from "@executablemd/durable-streams";
import { FilesInvariantError } from "@executablemd/runtime";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { Result } from "effection";
import {
  collect,
  execute,
  Execution,
  ExecutionProtocolError,
  inlineSource,
  registerComponents,
} from "../mod.ts";
import type { ExecutionRequest, ModifierFactory } from "../mod.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation, JournalAdmission } from "../host.ts";

const DOC = "# Hello\n";

/** A document that fails on its own terms, under <Output> error mode. */
const FAILING_DOC = ["<Output>", "", "```bash exec", "exit 3", "```", "", "</Output>", ""].join(
  "\n",
);

/** A journal that reports what a refused execution managed to do to it. */
function watched(): { stream: InMemoryStream; reads: number } {
  const stream = new InMemoryStream();
  const watcher = { stream, reads: 0 };
  const readAll = stream.readAll.bind(stream);
  stream.readAll = function* (): Operation<DurableEvent[]> {
    watcher.reads += 1;
    return yield* readAll();
  };
  return watcher;
}

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** `<Mark />` — records that authored work ran. */
function useMark(expanded: string[]): Operation<void> {
  return registerComponents([
    {
      name: "Mark",
      origin: "tier-ep",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn() {
        expanded.push("expanded");
        return "";
      },
    },
  ]);
}

describe("Tier EP — the execution protocol", () => {
  it("EP1: an ordinary execute() with nothing installed still runs the document", function* () {
    const output = yield* scoped(function* () {
      return yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });
    expect(String(output)).toContain("Hello");
  });

  it("EP2: an option transformation reaches the document", function* () {
    const output = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          yield* next(request.withOptions({ ...request.options, ...inlineSource("# Replaced\n") }));
        },
      });
      return yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });
    expect(String(output)).toContain("Replaced");
    expect(String(output)).not.toContain("Hello");
  });

  it("EP3: a handler that answers without delegating is refused, and nothing runs", function* () {
    const journal = watched();
    const expanded: string[] = [];

    const failure = yield* scoped(function* () {
      yield* useMark(expanded);
      yield* Execution.around({
        // deno-lint-ignore require-yield
        *execute() {
          // Returning a synthetic execution instead of delegating.
          return undefined;
        },
      });
      return yield* raised(execute({ ...inlineSource("<Mark />\n"), stream: journal.stream }));
    });

    expect(failure).toBeInstanceOf(ExecutionProtocolError);
    expect(journal.reads).toEqual(0);
    expect(expanded).toEqual([]);
    expect(journal.stream.snapshot()).toEqual([]);
  });

  it("EP4: a substitute return after delegating is ignored", function* () {
    // Typed as returning something, which the canonical surface no longer
    // permits — so this is written the only way it can still happen: through a
    // same-named descriptor whose own types allow it.
    const loose: Api<{ execute(request: ExecutionRequest): Operation<unknown> }> = createApi(
      "Execution",
      {
        // deno-lint-ignore require-yield
        *execute(_request: ExecutionRequest): Operation<unknown> {
          return undefined;
        },
      },
    );

    const output = yield* scoped(function* () {
      yield* loose.around({
        *execute([request], next) {
          yield* next(request);
          // Whatever a handler hands back is not an execution.
          return { output: undefined, [Symbol.iterator]: () => undefined };
        },
      });
      return yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });
    expect(String(output)).toContain("Hello");
  });

  it("EP5: a refusal before delegating performs no read, expansion or append", function* () {
    const journal = watched();
    const expanded: string[] = [];

    const failure = yield* scoped(function* () {
      yield* useMark(expanded);
      yield* Execution.around({
        // deno-lint-ignore require-yield
        *execute() {
          throw new Error("this policy says no");
        },
      });
      return yield* raised(execute({ ...inlineSource("<Mark />\n"), stream: journal.stream }));
    });

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("this policy says no");
    expect(journal.reads).toEqual(0);
    expect(expanded).toEqual([]);
    expect(journal.stream.snapshot()).toEqual([]);
  });

  it("EP6: delegating twice fails", function* () {
    const failure = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          yield* next(request);
          yield* next(request);
        },
      });
      return yield* raised(execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });
    expect(failure).toBeInstanceOf(ExecutionProtocolError);
    expect(String(failure)).toContain("more than once");
  });

  it("EP7: reusing a request a previous execution consumed fails", function* () {
    const captured: ExecutionRequest[] = [];
    yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          captured.push(request);
          yield* next(request);
        },
      });
      yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });

    const stale = captured[0];
    expect(stale).toBeDefined();
    const failure = yield* scoped(function* () {
      yield* Execution.around({
        *execute([,], next) {
          // Delegating the *previous* execution's request.
          yield* next(stale!);
        },
      });
      return yield* raised(execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });
    expect(failure).toBeInstanceOf(ExecutionProtocolError);
  });

  it("EP8: delegating a reconstructed look-alike fails", function* () {
    const journal = watched();
    const failure = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          const lookalike: ExecutionRequest = {
            options: request.options,
            withOptions: (options) => ({ ...lookalike, options }),
            addCompletionFailure: () => {},
          };
          yield* next(lookalike);
        },
      });
      return yield* raised(execute({ ...inlineSource(DOC), stream: journal.stream }));
    });
    expect(failure).toBeInstanceOf(ExecutionProtocolError);
    // The look-alike itself is what is refused — not merely "nothing reached
    // the terminal", which a silently ignored look-alike would also produce.
    expect(String(failure)).toContain("did not issue");
    expect(journal.reads).toEqual(0);
    expect(journal.stream.snapshot()).toEqual([]);
  });

  it("EP9: delegating a request a later withOptions() superseded fails", function* () {
    const failure = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          request.withOptions({ ...request.options, ...inlineSource("# Other\n") });
          // The superseded request, not the one just derived.
          yield* next(request);
        },
      });
      return yield* raised(execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });
    expect(failure).toBeInstanceOf(ExecutionProtocolError);
    expect(String(failure)).toContain("superseded");
  });

  it("EP10: middleware from another loaded copy inspects, transforms and delegates", function* () {
    const seen: string[] = [];
    // A descriptor of the same stable name, built here rather than imported —
    // which is what a separately loaded copy of core is.
    const foreign: Api<{
      execute(request: ExecutionRequest): Operation<void>;
    }> = createApi("Execution", {
      // deno-lint-ignore require-yield
      *execute(_request: ExecutionRequest): Operation<void> {},
    });

    const output = yield* scoped(function* () {
      yield* foreign.around({
        *execute([request], next) {
          seen.push(typeof request.options.stream);
          yield* next(request.withOptions({ ...request.options, ...inlineSource("# Foreign\n") }));
        },
      });
      return yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });

    expect(seen).toEqual(["object"]);
    expect(String(output)).toContain("Foreign");
  });

  // EP19: a nested invocation cannot settle its caller. The outer request is
  // still live and unconsumed when the nested chain hands it to the nested
  // terminal, so what refuses it is the exact-invocation comparison.
  it("EP19: a nested invocation cannot delegate its caller's live request", function* () {
    let refusal: unknown;
    const expanded: string[] = [];
    let outer: ExecutionRequest | undefined;
    const nested = new InMemoryStream();
    const outer_ = new InMemoryStream();
    let depth = 0;

    const output = yield* scoped(function* () {
      yield* useMark(expanded);
      yield* Execution.around({
        *execute([request], next) {
          const mine = depth++;
          if (mine === 0) {
            outer = request;
            // Started while this invocation is still live and unconsumed.
            yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
            yield* next(request);
            return;
          }
          // The nested invocation, handing its own terminal the caller's request.
          const captured = outer;
          expect(captured).toBeDefined();
          refusal = captured === undefined ? undefined : yield* raised(next(captured));
          yield* next(request);
        },
      });
      return yield* collect(
        yield* execute({ ...inlineSource("<Mark />\n\n# Outer\n"), stream: outer_ }),
      );
    });

    expect(refusal).toBeInstanceOf(ExecutionProtocolError);
    expect(String(refusal)).toContain("another execution issued");
    expect(refusal instanceof Error ? refusal.cause : "none").toBeUndefined();
    // The outer invocation settled on its own request afterwards: its document
    // expanded and its own journal — not the nested one — carries it. That two
    // live invocations each run their own document is EP20's claim, proved
    // there with barriers rather than through nesting.
    expect(String(output)).toContain("Outer");
    expect(String(output)).not.toContain("Nested");
    expect(JSON.stringify(outer_.snapshot())).toContain("Outer");
    expect(JSON.stringify(nested.snapshot())).not.toContain("Outer");
    expect(expanded).toEqual(["expanded"]);
  });

  // EP20: two invocations, both live and both unconsumed at the moment each
  // tries to delegate the other's request. The barrier is what makes that true
  // — without it one could already be consumed, and a consumed-request check
  // alone would satisfy the assertions.
  it("EP20: concurrent invocations cannot swap live requests", function* () {
    const arrived = [withResolvers<void>(), withResolvers<void>()];
    const captured: Array<ExecutionRequest | undefined> = [undefined, undefined];
    const refusals: unknown[] = [];
    let index = 0;

    const outputs = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          const mine = index++;
          captured[mine] = request;
          arrived[mine]!.resolve();
          // Both requests exist and neither has reached a terminal yet.
          yield* arrived[0]!.operation;
          yield* arrived[1]!.operation;

          const foreign = captured[mine === 0 ? 1 : 0];
          refusals.push(yield* raised(next(foreign!)));
          // Its own request still settles this invocation afterwards.
          yield* next(request);
        },
      });

      const run = (doc: string) =>
        function* (): Operation<string> {
          return String(
            yield* collect(yield* execute({ ...inlineSource(doc), stream: new InMemoryStream() })),
          );
        };
      const first = yield* spawn(run("# First\n"));
      const second = yield* spawn(run("# Second\n"));
      return [yield* first, yield* second];
    });

    expect(refusals).toHaveLength(2);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(ExecutionProtocolError);
      expect(String(refusal)).toContain("another execution issued");
      expect(refusal instanceof Error ? refusal.cause : "none").toBeUndefined();
    }
    // Each still ran its own document under its own options.
    expect(outputs[0]).toContain("First");
    expect(outputs[1]).toContain("Second");
  });

  it("EP21: the exported default refuses and consumes nothing", function* () {
    const captured: ExecutionRequest[] = [];
    const output = yield* scoped(function* () {
      let reentered = false;
      yield* Execution.around({
        *execute([request], next) {
          // The standalone call below re-enters this same handler, because the
          // public descriptor shares the stable name. Let it pass straight
          // through so what is under test is the default it reaches.
          if (reentered) {
            yield* next(request);
            return;
          }
          captured.push(request);
          reentered = true;
          const standalone = yield* raised(Execution.operations.execute(request));
          reentered = false;
          expect(standalone).toBeInstanceOf(ExecutionProtocolError);
          expect(String(standalone)).toContain("outside canonical core");
          // The request survived that, and still settles this invocation.
          yield* next(request);
        },
      });
      return yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });

    expect(String(output)).toContain("Hello");
    expect(captured).toHaveLength(1);
  });

  it("EP22: null, primitives and hostile shapes are refused without a native error", function* () {
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error("PLANTED-HAS-TRAP");
        },
        get() {
          throw new Error("PLANTED-GET-TRAP");
        },
      },
    );
    const values: unknown[] = [null, undefined, 7, "request", true, Symbol("r"), {}, hostile];

    for (const value of values) {
      const journal = watched();
      const failure = yield* scoped(function* () {
        yield* Execution.around({
          *execute([,], next) {
            yield* next(value as ExecutionRequest);
          },
        });
        return yield* raised(execute({ ...inlineSource(DOC), stream: journal.stream }));
      });

      expect(failure).toBeInstanceOf(ExecutionProtocolError);
      expect(String(failure)).not.toContain("PLANTED");
      expect(failure instanceof Error ? failure.cause : "none").toBeUndefined();
      expect(journal.reads).toEqual(0);
      expect(journal.stream.snapshot()).toEqual([]);
    }
  });

  // EP23: contextual behavior an installation establishes is the invocation's.
  // It has to reach document teardown, stay out of a concurrent invocation, and
  // be gone from the next ordinary execution in the same host scope.
  it("EP23: invocation-installed context reaches teardown and leaks nowhere", function* () {
    const Marker = createContext<string | undefined>("tier-ep.marker", undefined);
    const seen: string[] = [];

    yield* scoped(function* () {
      yield* Execution.around({
        *document([props], next) {
          seen.push(`document:${(yield* Marker.get()) ?? "absent"}`);
          try {
            return yield* next(props);
          } finally {
            seen.push("teardown");
          }
        },
      });

      yield* collect(
        yield* executeInstalled({ ...inlineSource(DOC), stream: new InMemoryStream() }, [
          {
            *install(): Operation<void> {
              yield* Marker.set("installed");
            },
          },
        ]),
      );

      // A later ordinary execution in the same host scope must not inherit it.
      yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });

    expect(seen).toEqual(["document:installed", "teardown", "document:absent", "teardown"]);
  });

  // EP26: what the terminal accepted stops being the caller's to change. The
  // chain unwinds before the document runs, so a handler that delegates and
  // then edits what it delegated would otherwise change what executes.
  // EP24: settlement owns the invocation scope. A caller that continues on the
  // completion continues after this invocation's cleanup has finished — which a
  // caller-owned resource would not give, since it would still be standing.
  it("EP24: cleanup finishes before completion is observed", function* () {
    const cases: Array<{ says: string; doc: string; policy: boolean }> = [
      { says: "success", doc: DOC, policy: false },
      { says: "document failure", doc: FAILING_DOC, policy: false },
      { says: "completion-policy failure", doc: DOC, policy: true },
    ];

    for (const scenario of cases) {
      const finalized: string[] = [];
      const observed: string[] = [];

      yield* scoped(function* () {
        if (scenario.policy) {
          yield* Execution.around({
            *execute([request], next) {
              request.addCompletionFailure(() => new Error("the policy failed it"));
              yield* next(request);
            },
          });
        }

        const execution = yield* executeInstalled(
          { ...inlineSource(scenario.doc), stream: new InMemoryStream() },
          [
            {
              *install(): Operation<void> {
                yield* ensure(() => {
                  finalized.push("cleanup");
                });
              },
            },
          ],
        );
        yield* execution;
        observed.push(`completion:${finalized.length}`);
      });

      // Exactly once, and already done when the completion was read.
      expect(finalized).toEqual(["cleanup"]);
      expect(observed).toEqual(["completion:1"]);
    }
  });

  it("EP24b: concurrent invocations finalize independently, and leave nothing behind", function* () {
    const finalized: string[] = [];

    yield* scoped(function* () {
      const run = (name: string) =>
        function* (): Operation<void> {
          const execution = yield* executeInstalled(
            { ...inlineSource(DOC), stream: new InMemoryStream() },
            [
              {
                *install(): Operation<void> {
                  yield* ensure(() => {
                    finalized.push(name);
                  });
                },
              },
            ],
          );
          yield* execution;
        };
      const first = yield* spawn(run("first"));
      const second = yield* spawn(run("second"));
      yield* first;
      yield* second;
    });

    expect([...finalized].sort()).toEqual(["first", "second"]);
  });

  it("EP24c: a completed handle can be re-observed without refinalizing", function* () {
    const finalized: string[] = [];

    const results = yield* scoped(function* () {
      const execution = yield* executeInstalled(
        { ...inlineSource(DOC), stream: new InMemoryStream() },
        [
          {
            *install(): Operation<void> {
              yield* ensure(() => {
                finalized.push("cleanup");
              });
            },
          },
        ],
      );
      const first = yield* execution;
      const second = yield* execution;
      // Late subscription still replays the whole output.
      const late = yield* collect(execution);
      return [first.ok, second.ok, String(late).includes("Hello")];
    });

    expect(results).toEqual([true, true, true]);
    expect(finalized).toEqual(["cleanup"]);
  });

  // EP25: cancelling a consumer of an *already-returned* handle cancels the
  // invocation. The handle is obtained in a caller scope that keeps running, and
  // the task that is halted never started the execution — nothing but the handle
  // connects them.
  it("EP25: halting a consumer of a returned handle cancels the invocation", function* () {
    const finalized: string[] = [];
    const halted: string[] = [];
    const reached = withResolvers<void>();
    const settledBy: Array<boolean> = [];

    yield* scoped(function* () {
      yield* Execution.around({
        *document([props], next) {
          try {
            reached.resolve();
            yield* suspend();
            return yield* next(props);
          } finally {
            halted.push("document");
          }
        },
      });

      const execution = yield* executeInstalled(
        { ...inlineSource(DOC), stream: new InMemoryStream() },
        [
          {
            *install(): Operation<void> {
              yield* ensure(() => {
                finalized.push("cleanup");
              });
            },
          },
        ],
      );
      yield* reached.operation;

      const consumer = yield* spawn(function* () {
        yield* execution;
      });
      // The spawned task has to reach its observation before halting it means
      // anything — a halt delivered first would tear down a task that had not
      // started, which proves nothing about a returned handle.
      yield* sleep(1);
      yield* consumer.halt();

      // Asserted before this scope exits: halting the consumer is what closed
      // the invocation, not the surrounding scope unwinding.
      expect(halted).toEqual(["document"]);
      expect(finalized).toEqual(["cleanup"]);

      // Another observer of the same handle settles rather than hanging...
      settledBy.push((yield* execution).ok);
      // ...and observing it again starts nothing and refinalizes nothing.
      settledBy.push((yield* execution).ok);
    });

    expect(settledBy).toEqual([false, false]);
    expect(halted).toEqual(["document"]);
    expect(finalized).toEqual(["cleanup"]);
  });

  it("EP25b: a fatal document result survives cancellation by identity", function* () {
    const durable = new DurablePersistenceError("yield", new Error("planted"));
    const released = withResolvers<void>();
    const finalized: string[] = [];

    const observed = yield* scoped(function* () {
      yield* Execution.around({
        // deno-lint-ignore require-yield
        *document() {
          throw durable;
        },
      });

      const execution = yield* executeInstalled(
        { ...inlineSource(DOC), stream: new InMemoryStream() },
        [
          {
            *install(): Operation<void> {
              yield* ensure(function* () {
                finalized.push("cleanup");
                // Teardown is still running when the consumer below is halted.
                yield* released.operation;
              });
            },
          },
        ],
      );

      const consumer = yield* spawn(function* () {
        yield* execution;
      });
      const halting = yield* spawn(function* () {
        yield* consumer.halt();
      });
      released.resolve();
      yield* halting;

      return yield* execution;
    });

    // The document had already decided, and cancelling a consumer during
    // teardown did not erase that — by identity.
    expect(observed.ok).toBe(false);
    expect(observed.ok ? undefined : observed.error).toBe(durable);
    expect(finalized).toEqual(["cleanup"]);
  });

  // EP27: a document outcome and an invocation-teardown failure are ranked, not
  // replaced. A fatal failure is reported by identity from wherever it came.
  it("EP27: teardown reconciles with the document outcome by precedence", function* () {
    const durable = new DurablePersistenceError("yield", new Error("planted"));
    const otherDurable = new DurablePersistenceError("close", new Error("planted-second"));
    const filesFatal = new FilesInvariantError("protocol");
    const otherFilesFatal = new FilesInvariantError("protocol");
    const cleanup = new Error("INSTALLATION-CLEANUP");

    const cases: Array<{
      says: string;
      fail?: Error;
      teardown?: Error;
      expected: (result: Result<Json>) => void;
    }> = [
      {
        says: "durability failure outranks an ordinary cleanup error",
        fail: durable,
        teardown: cleanup,
        expected: (result) => {
          expect(result.ok).toBe(false);
          // By identity: the engine's fences match the exact object.
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
      {
        says: "an ordinary document failure stays authoritative",
        fail: new Error("DOCUMENT-FAILED"),
        teardown: cleanup,
        expected: (result) => {
          expect(String(result.ok ? "" : result.error.message)).toContain("DOCUMENT-FAILED");
          expect(String(result.ok ? "" : result.error.message)).not.toContain(
            "INSTALLATION-CLEANUP",
          );
        },
      },
      {
        says: "a cleanup error converts a successful document",
        teardown: cleanup,
        expected: (result) => {
          expect(result.ok).toBe(false);
          expect(result.ok ? undefined : result.error).toBe(cleanup);
        },
      },
      {
        says: "a fatal teardown outranks an ordinary document failure",
        fail: new Error("DOCUMENT-FAILED"),
        teardown: durable,
        expected: (result) => {
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
      {
        says: "the document's durability failure precedes the teardown's",
        fail: durable,
        teardown: otherDurable,
        expected: (result) => {
          // Same kind on both sides: the one that happened first wins, and it
          // is the exact object rather than a rebuilt one.
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
      {
        says: "the document's Files failure precedes the teardown's",
        fail: filesFatal,
        teardown: otherFilesFatal,
        expected: (result) => {
          expect(result.ok ? undefined : result.error).toBe(filesFatal);
        },
      },
      {
        says: "durability outranks Files wherever each came from",
        fail: filesFatal,
        teardown: durable,
        expected: (result) => {
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
      {
        says: "a document durability failure outranks a Files teardown",
        fail: durable,
        teardown: filesFatal,
        expected: (result) => {
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
    ];

    for (const scenario of cases) {
      const finalized: string[] = [];
      const observed: number[] = [];

      const result = yield* scoped(function* () {
        if (scenario.fail) {
          const failure = scenario.fail;
          yield* Execution.around({
            // deno-lint-ignore require-yield
            *document() {
              throw failure;
            },
          });
        }
        const execution = yield* executeInstalled(
          { ...inlineSource(DOC), stream: new InMemoryStream() },
          [
            {
              *install(): Operation<void> {
                yield* ensure(() => {
                  finalized.push("cleanup");
                  if (scenario.teardown) {
                    throw scenario.teardown;
                  }
                });
              },
            },
          ],
        );
        const settled = yield* execution;
        observed.push(finalized.length);
        return settled;
      });

      scenario.expected(result);
      // Every finalizer ran, exactly once, before the result was observable.
      expect(finalized).toEqual(["cleanup"]);
      expect(observed).toEqual([1]);
    }
  });

  // EP26: what the terminal accepted stops being the caller's to change. Each
  // field below is mutated *after* the private terminal returned and before the
  // public chain finishes, and each one materially affects execution — so the
  // accepted snapshot is what the assertions read, not the edited original.
  it("EP26: the accepted options are a detached snapshot", function* () {
    // Control: replacing the same fields *before* delegating still works.
    const replaced = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          yield* next(request.withOptions({ ...request.options, ...inlineSource("# Control\n") }));
        },
      });
      return yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
    });
    expect(String(replaced)).toContain("Control");

    const accepted = new InMemoryStream();
    const smuggled = new InMemoryStream();
    const acceptedDirs = ["./components", "./"];
    const acceptedModifiers: Record<string, ModifierFactory> = {
      shout: (_params) => (_args, next) =>
        (function* () {
          const inner = yield* next();
          return { ...inner, output: `SHOUTED:${inner.output}` };
        })(),
    };

    const output = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          const options = request.options;
          yield* next(request);

          // Every one of these is the caller's own object, edited after the
          // terminal accepted a copy of it.
          Reflect.set(options, "stream", smuggled);
          Reflect.set(options, "path", "/nowhere/replaced.md");
          const dirs = options.componentDirs;
          if (Array.isArray(dirs)) {
            Reflect.set(dirs, 0, "/nowhere");
            Reflect.set(dirs, "length", 0);
          }
          const modifiers = options.modifiers;
          if (typeof modifiers === "object" && modifiers !== null) {
            Reflect.deleteProperty(modifiers, "shout");
            Reflect.set(modifiers, "shout", () => () => "REPLACED");
          }
        },
      });

      return yield* collect(
        yield* execute({
          ...inlineSource(["```bash shout exec", "echo hi", "```", ""].join("\n")),
          stream: accepted,
          componentDirs: acceptedDirs,
          modifiers: acceptedModifiers,
        }),
      );
    });

    // The accepted modifier ran, by identity — not the replacement.
    expect(String(output)).toContain("SHOUTED:");
    expect(String(output)).not.toContain("REPLACED");
    // Events went to the accepted stream, and the substituted one saw nothing.
    expect(accepted.snapshot().length).toBeGreaterThan(0);
    expect(smuggled.snapshot()).toEqual([]);
    // The caller's own arrays and records really were edited — the snapshot is
    // what protected the execution, not an absence of mutation.
    expect(acceptedDirs).toEqual([]);
    expect(Object.keys(acceptedModifiers)).toEqual(["shout"]);
  });

  // EP27: a document outcome and an invocation-teardown failure are ranked, not
  // replaced. A fatal failure is reported by identity from wherever it came.
  it("EP27: teardown reconciles with the document outcome by precedence", function* () {
    const durable = new DurablePersistenceError("yield", new Error("planted"));
    const otherDurable = new DurablePersistenceError("close", new Error("planted-second"));
    const filesFatal = new FilesInvariantError("protocol");
    const otherFilesFatal = new FilesInvariantError("protocol");
    const cleanup = new Error("INSTALLATION-CLEANUP");

    const cases: Array<{
      says: string;
      fail?: Error;
      teardown?: Error;
      expected: (result: Result<Json>) => void;
    }> = [
      {
        says: "durability failure outranks an ordinary cleanup error",
        fail: durable,
        teardown: cleanup,
        expected: (result) => {
          expect(result.ok).toBe(false);
          // By identity: the engine's fences match the exact object.
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
      {
        says: "an ordinary document failure stays authoritative",
        fail: new Error("DOCUMENT-FAILED"),
        teardown: cleanup,
        expected: (result) => {
          expect(String(result.ok ? "" : result.error.message)).toContain("DOCUMENT-FAILED");
          expect(String(result.ok ? "" : result.error.message)).not.toContain(
            "INSTALLATION-CLEANUP",
          );
        },
      },
      {
        says: "a cleanup error converts a successful document",
        teardown: cleanup,
        expected: (result) => {
          expect(result.ok).toBe(false);
          expect(result.ok ? undefined : result.error).toBe(cleanup);
        },
      },
      {
        says: "a fatal teardown outranks an ordinary document failure",
        fail: new Error("DOCUMENT-FAILED"),
        teardown: durable,
        expected: (result) => {
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
      {
        says: "the document's durability failure precedes the teardown's",
        fail: durable,
        teardown: otherDurable,
        expected: (result) => {
          // Same kind on both sides: the one that happened first wins, and it
          // is the exact object rather than a rebuilt one.
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
      {
        says: "the document's Files failure precedes the teardown's",
        fail: filesFatal,
        teardown: otherFilesFatal,
        expected: (result) => {
          expect(result.ok ? undefined : result.error).toBe(filesFatal);
        },
      },
      {
        says: "durability outranks Files wherever each came from",
        fail: filesFatal,
        teardown: durable,
        expected: (result) => {
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
      {
        says: "a document durability failure outranks a Files teardown",
        fail: durable,
        teardown: filesFatal,
        expected: (result) => {
          expect(result.ok ? undefined : result.error).toBe(durable);
        },
      },
    ];

    for (const scenario of cases) {
      const finalized: string[] = [];
      const observed: number[] = [];

      const result = yield* scoped(function* () {
        if (scenario.fail) {
          const failure = scenario.fail;
          yield* Execution.around({
            // deno-lint-ignore require-yield
            *document() {
              throw failure;
            },
          });
        }
        const execution = yield* executeInstalled(
          { ...inlineSource(DOC), stream: new InMemoryStream() },
          [
            {
              *install(): Operation<void> {
                yield* ensure(() => {
                  finalized.push("cleanup");
                  if (scenario.teardown) {
                    throw scenario.teardown;
                  }
                });
              },
            },
          ],
        );
        const settled = yield* execution;
        observed.push(finalized.length);
        return settled;
      });

      scenario.expected(result);
      // Every finalizer ran, exactly once, before the result was observable.
      expect(finalized).toEqual(["cleanup"]);
      expect(observed).toEqual([1]);
    }
  });

  it("EP11: admissions are copied before install() runs", function* () {
    const order: string[] = [];
    const late: JournalAdmission[] = [];
    const installation: ExecutionInstallation = {
      admissions: late,
      *install(): Operation<void> {
        order.push("install");
        // Too late: the collection was copied before this ran.
        // deno-lint-ignore require-yield
        late.push(function* () {
          order.push("late-admission");
        });
      },
    };

    yield* scoped(function* () {
      yield* collect(
        yield* executeInstalled({ ...inlineSource(DOC), stream: new InMemoryStream() }, [
          installation,
        ]),
      );
    });

    expect(order).toEqual(["install"]);
  });

  it("EP12: every captured admission runs, in order, on the retained history", function* () {
    const order: string[] = [];
    const seen: number[] = [];
    const admission = (name: string): JournalAdmission =>
      // deno-lint-ignore require-yield
      function* (retained) {
        order.push(name);
        seen.push(retained.length);
      };

    yield* scoped(function* () {
      yield* collect(
        yield* executeInstalled({ ...inlineSource(DOC), stream: new InMemoryStream() }, [
          { admissions: [admission("first")] },
          { admissions: [admission("second")] },
        ]),
      );
    });

    expect(order).toEqual(["first", "second"]);
    expect(seen).toEqual([0, 0]);
  });

  it("EP13: one admission refusal stops everything after it", function* () {
    for (const refusing of [0, 1]) {
      const journal = watched();
      const expanded: string[] = [];
      const ran: string[] = [];
      const admissions: JournalAdmission[] = [0, 1].map(
        (index) =>
          // deno-lint-ignore require-yield
          function* () {
            ran.push(`admission-${index}`);
            if (index === refusing) {
              throw new Error(`admission ${index} says no`);
            }
          },
      );

      const failure = yield* scoped(function* () {
        yield* useMark(expanded);
        return yield* raised(
          collect(
            yield* executeInstalled({ ...inlineSource("<Mark />\n"), stream: journal.stream }, [
              { admissions: [admissions[0]!] },
              { admissions: [admissions[1]!] },
            ]),
          ),
        );
      });

      expect(String(failure)).toContain(`admission ${refusing} says no`);
      // Nothing after the refusal: no expansion, no Yield, no Close.
      expect(expanded).toEqual([]);
      expect(journal.stream.snapshot()).toEqual([]);
      expect(ran).toEqual(refusing === 0 ? ["admission-0"] : ["admission-0", "admission-1"]);
    }
  });

  // EP15: additive means one direction. A policy can fail a success; it cannot
  // stand in for a failure the document already earned.
  // EP18: an admission inspects or refuses. It does not edit. `readonly` is a
  // compile-time claim, so each attempt below is made at runtime through the
  // reflective route that ignores it — and every one has to be ineffective or
  // throw, with the next admission still seeing the original history.
  it("EP18: an admission cannot change the history anyone else reads", function* () {
    const attempts: Array<{ says: string; edit: (retained: readonly DurableEvent[]) => void }> = [
      { says: "length", edit: (retained) => void Reflect.set(retained, "length", 0) },
      { says: "indexed replacement", edit: (retained) => void Reflect.set(retained, 0, undefined) },
      { says: "deletion", edit: (retained) => void Reflect.deleteProperty(retained, 0) },
      { says: "reverse", edit: (retained) => void [...[]].reverse.call(retained) },
      { says: "splice", edit: (retained) => void [...[]].splice.call(retained, 0, 99) },
    ];

    // One completed journal, replayed once per attempt.
    const first = new InMemoryStream();
    yield* scoped(function* () {
      yield* collect(yield* execute({ ...inlineSource(DOC), stream: first }));
    });
    const original = first.snapshot().length;
    expect(original).toBeGreaterThan(0);

    for (const attempt of attempts) {
      const journal = new InMemoryStream(first.snapshot());
      const observed: number[] = [];
      const expanded: string[] = [];

      const output = yield* scoped(function* () {
        yield* useMark(expanded);
        return yield* collect(
          yield* executeInstalled({ ...inlineSource(DOC), stream: journal }, [
            {
              admissions: [
                // deno-lint-ignore require-yield
                function* (retained) {
                  observed.push(retained.length);
                  // Ineffective or throwing — either is a refusal to edit.
                  try {
                    attempt.edit(retained);
                  } catch {
                    // A frozen array throws in strict mode; that is the point.
                  }
                },
                // deno-lint-ignore require-yield
                function* (retained) {
                  observed.push(retained.length);
                },
              ],
            },
          ]),
        );
      });

      // The second admission saw exactly what the first was given.
      expect(observed).toEqual([original, original]);
      // Still a completed replay: nothing authored ran and nothing was appended.
      expect(String(output)).toContain("Hello");
      expect(expanded).toEqual([]);
      expect(journal.snapshot().length).toEqual(original);
    }
  });

  it("EP15: a completion policy cannot replace an existing failure", function* () {
    const asked: string[] = [];
    const result = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          request.addCompletionFailure(() => {
            asked.push("policy");
            return new Error("the policy's failure");
          });
          yield* next(request);
        },
      });
      // A value root that declares `returns` and produces no <Return> fails on
      // its own terms.
      return yield* yield* execute({
        ...inlineSource("---\nreturns:\n  type: object\n---\n\nbody\n"),
        stream: new InMemoryStream(),
      });
    });

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.error.message;
    expect(message).not.toContain("the policy's failure");
    // Not even consulted: the result was already a failure.
    expect(asked).toEqual([]);
  });

  it("EP16: an additive failure still converts a success", function* () {
    const result = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          request.addCompletionFailure(() => new Error("the policy's failure"));
          yield* next(request);
        },
      });
      return yield* yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() });
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("the policy's failure");
  });

  it("EP17: the first policy to fail wins, and later ones do not replace it", function* () {
    const asked: string[] = [];
    const result = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          request.addCompletionFailure(() => {
            asked.push("first");
            return new Error("the first policy");
          });
          request.addCompletionFailure(() => {
            asked.push("second");
            return new Error("the second policy");
          });
          yield* next(request);
        },
      });
      return yield* yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() });
    });

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.error.message;
    expect(message).toContain("the first policy");
    expect(message).not.toContain("the second policy");
    // The second is never even consulted once the result is a failure.
    expect(asked).toEqual(["first"]);
  });

  it("EP14: the obsolete ambient admission channel does not exist", function* () {
    const ran: string[] = [];
    // The exact channel a previous revision used, rebuilt by name and cleared —
    // before the invocation and again from inside the middleware chain. There
    // is nothing behind the name now, so neither clearing removes anything.
    const obsolete = createContext<unknown>("executablemd.core.journal-admission", undefined);

    yield* scoped(function* () {
      yield* obsolete.set([]);
      yield* Execution.around({
        *execute([request], next) {
          yield* obsolete.set([]);
          yield* next(request);
        },
      });
      yield* collect(
        yield* executeInstalled({ ...inlineSource(DOC), stream: new InMemoryStream() }, [
          {
            admissions: [
              // deno-lint-ignore require-yield
              function* () {
                ran.push("still-ran");
              },
            ],
          },
        ]),
      );
    });

    expect(ran).toEqual(["still-ran"]);
  });
});
