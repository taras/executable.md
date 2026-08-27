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
import {
  createContext,
  ensure,
  resource,
  scoped,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Operation } from "effection";
import { createApi } from "@effectionx/context-api";
import type { Api } from "@effectionx/context-api";
import {
  createDurableOperation,
  DurablePersistenceError,
  InMemoryStream,
} from "@executablemd/durable-streams";
import type { Workflow } from "@executablemd/durable-streams";
import { FilesInvariantError } from "@executablemd/runtime";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { Result } from "effection";
import {
  collect,
  Component,
  execute,
  Execution,
  ExecutionProtocolError,
  fileSource,
  inlineSource,
  registerComponents,
} from "../mod.ts";
import type { ExecutionRequest, ModifierFactory, RootDocumentSource } from "../mod.ts";
import { executeInstalled } from "../host.ts";
import { DocumentProtocolError } from "../src/document-request.ts";
import type { DocumentRequest } from "../src/document-request.ts";
import { executeObserved } from "../src/execute.ts";
import type { InvocationObservers } from "../src/execute.ts";
import type { DurablePreparation, ExecutionInstallation, JournalAdmission } from "../host.ts";

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

/**
 * A directory holding one Markdown component, for this test only.
 *
 * `mkdtemp` is the one step `@effectionx/fs` has no equivalent for; the write
 * and the removal go through it. Cleanup is an `ensure`, so a cancelled test
 * cannot strand the directory.
 */
function useComponentFixture(): Operation<string> {
  return resource<string>(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "xmd-ep26-")));
    yield* ensure(function* () {
      yield* rm(dir, { recursive: true, force: true });
    });
    yield* writeTextFile(join(dir, "Accepted.md"), "ACCEPTED-COMPONENT\n");
    yield* provide(dir);
  });
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

/** A root that reports the props it was actually given. */
const PROPS_DOC = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    nested:",
  "      type: object",
  "      properties:",
  "        value: { type: string }",
  "      required: [value]",
  "      additionalProperties: false",
  "    items:",
  "      type: array",
  "      items: { type: string }",
  "  required: [nested, items]",
  "  additionalProperties: false",
  "---",
  "",
  "<Mutate />",
  "",
  "nested={props.nested.value} items={props.items}",
  "",
].join("\n");

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

      const observing = withResolvers<void>();
      const execution = yield* executeObserved(
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
        { observed: () => observing.resolve() },
      );
      yield* reached.operation;

      // The consumer says when it is about to observe the handle, so the halt
      // lands on a task that is *inside* the observation rather than on one
      // that never started. A delay would only make that likely.
      // The acknowledgement comes from inside the observation itself: the
      // handle notifies once the consumer is cancellable. No elapsed time, and
      // a halt delivered earlier would leave `halted` empty.
      const consumer = yield* spawn(function* () {
        yield* execution;
      });
      yield* observing.operation;
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
    const enteredTeardown = withResolvers<void>();
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
                enteredTeardown.resolve();
                // Held open until the test says so, so cancellation lands while
                // teardown is genuinely in progress.
                yield* released.operation;
              });
            },
          },
        ],
      );

      const observing = withResolvers<void>();
      const consumer = yield* spawn(function* () {
        observing.resolve();
        yield* execution;
      });
      yield* observing.operation;
      // The document has already failed, so teardown is what is running now.
      yield* enteredTeardown.operation;
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

  // EP25c: §8.1's other cancellation promise — a fatal failure raised *while*
  // cancellation tears the invocation down is ranked and returned by identity,
  // rather than being swallowed by the cancellation result.
  it("EP25c: a fatal failure raised by cancellation teardown wins by identity", function* () {
    const durable = new DurablePersistenceError("close", new Error("planted-teardown"));
    const enteredTeardown = withResolvers<void>();
    const released = withResolvers<void>();
    const reached = withResolvers<void>();
    const finalized: string[] = [];

    const observed = yield* scoped(function* () {
      yield* Execution.around({
        *document([props], next) {
          reached.resolve();
          yield* suspend();
          return yield* next(props);
        },
      });

      const observing = withResolvers<void>();
      const execution = yield* executeObserved(
        { ...inlineSource(DOC), stream: new InMemoryStream() },
        [
          {
            *install(): Operation<void> {
              yield* ensure(function* () {
                finalized.push("cleanup");
                enteredTeardown.resolve();
                yield* released.operation;
                throw durable;
              });
            },
          },
        ],
        { observed: () => observing.resolve() },
      );
      yield* reached.operation;

      const consumer = yield* spawn(function* () {
        yield* execution;
      });
      yield* observing.operation;
      const halting = yield* spawn(function* () {
        yield* consumer.halt();
      });
      // Cancellation is now inside teardown; let the finalizer raise.
      yield* enteredTeardown.operation;
      released.resolve();
      yield* halting;

      const first = yield* execution;
      // Again: nothing restarts, nothing refinalizes.
      const second = yield* execution;
      return [first, second];
    });

    for (const result of observed) {
      expect(result.ok).toBe(false);
      expect(result.ok ? undefined : result.error).toBe(durable);
    }
    expect(finalized).toEqual(["cleanup"]);
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
    const acceptedModifiers: Record<string, ModifierFactory> = {
      shout: (_params) => (_args, next) =>
        (function* () {
          const inner = yield* next();
          return { ...inner, output: `SHOUTED:${inner.output}` };
        })(),
    };

    // A component reachable only through the accepted directory.
    const fixture = yield* useComponentFixture();
    const acceptedDirs = [fixture];

    const source = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    nested:",
      "      type: object",
      "      properties:",
      "        value: { type: string }",
      "      required: [value]",
      "      additionalProperties: false",
      "    items:",
      "      type: array",
      "      items: { type: string }",
      "  required: [nested, items]",
      "  additionalProperties: false",
      "---",
      "",
      "<Accepted />",
      "",
      "nested={props.nested.value} items={props.items}",
      "",
      "```bash shout exec",
      "echo hi",
      "```",
      "",
    ].join("\n");

    const nested = { value: "accepted-value" };
    const items = ["accepted-item"];

    const output = yield* scoped(function* () {
      yield* Execution.around({
        *execute([request], next) {
          const options = request.options;
          yield* next(request);

          // Every one of these is the caller's own object, edited after the
          // terminal accepted a copy of it.
          Reflect.set(options, "stream", smuggled);
          Reflect.set(options, "path", "/nowhere/replaced.md");
          const dirs = options.includes;
          if (Array.isArray(dirs)) {
            Reflect.set(dirs, 0, "/nowhere");
            Reflect.set(dirs, "length", 0);
          }
          const modifiers = options.modifiers;
          if (typeof modifiers === "object" && modifiers !== null) {
            Reflect.deleteProperty(modifiers, "shout");
            Reflect.set(modifiers, "shout", () => () => "REPLACED");
          }
          // The caller's own nested values, edited after acceptance.
          Reflect.set(nested, "value", "smuggled-value");
          Reflect.set(items, 0, "smuggled-item");
        },
      });

      return yield* collect(
        yield* execute({
          ...inlineSource(source),
          stream: accepted,
          includes: acceptedDirs,
          modifiers: acceptedModifiers,
          props: { nested, items },
        }),
      );
    });

    // The accepted modifier ran, by identity — not the replacement.
    expect(String(output)).toContain("SHOUTED:");
    expect(String(output)).not.toContain("REPLACED");
    // Events went to the accepted stream, and the substituted one saw nothing.
    expect(accepted.snapshot().length).toBeGreaterThan(0);
    expect(smuggled.snapshot()).toEqual([]);
    // The component resolved through the accepted directory, even though the
    // caller's array was emptied after acceptance.
    expect(String(output)).toContain("ACCEPTED-COMPONENT");
    // Nested props: the accepted object and array, not the edited ones.
    expect(String(output)).toContain("accepted-value");
    expect(String(output)).not.toContain("smuggled-value");
    expect(String(output)).toContain("accepted-item");
    expect(String(output)).not.toContain("smuggled-item");
    // The caller's own arrays and records really were edited — the snapshot is
    // what protected the execution, not an absence of mutation.
    expect(acceptedDirs).toEqual([]);
    expect(nested.value).toEqual("smuggled-value");
    expect(items[0]).toEqual("smuggled-item");
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

  // EP28: an observer belongs to the invocation it watches. Two executions run
  // concurrently, each with its own callback and its own finalizer; cancelling
  // one consumer must reach only that invocation. A single shared slot would
  // let one execution receive or overwrite the other's notification.
  it("EP28: observers, cancellation and cleanup never cross invocations", function* () {
    const seen: string[] = [];
    const finalized: string[] = [];
    const halted: string[] = [];
    const reachedFirst = withResolvers<void>();
    const reachedSecond = withResolvers<void>();
    const observingFirst = withResolvers<void>();
    const observingSecond = withResolvers<void>();

    // A descriptor the caller keeps and edits after the invocation started:
    // only the callback it held at the start may run.
    yield* scoped(function* () {
      const retained: InvocationObservers = { observed: () => seen.push("observed:A") };
      const replaced = yield* executeObserved(
        { ...inlineSource(DOC), stream: new InMemoryStream() },
        [],
        retained,
      );
      retained.observed = () => seen.push("observed:B");
      yield* replaced;
    });

    const settledSecond = yield* scoped(function* () {
      yield* Execution.around({
        *document([props], next) {
          const which = seen.includes("start:first") ? "second" : "first";
          seen.push(`start:${which}`);
          if (which === "first") {
            reachedFirst.resolve();
            try {
              yield* suspend();
            } finally {
              halted.push("first");
            }
          }
          reachedSecond.resolve();
          return yield* next(props);
        },
      });

      const start = (name: string, observing: { resolve(): void }) =>
        executeObserved(
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
          {
            observed: () => {
              seen.push(`observed:${name}`);
              observing.resolve();
            },
          },
        );

      const first = yield* start("first", observingFirst);
      yield* reachedFirst.operation;
      const second = yield* start("second", observingSecond);

      const firstConsumer = yield* spawn(function* () {
        yield* first;
      });
      const secondConsumer = yield* spawn(function* () {
        return yield* second;
      });
      yield* observingFirst.operation;
      yield* observingSecond.operation;

      // Only the first invocation's consumer is cancelled.
      yield* firstConsumer.halt();

      expect(halted).toEqual(["first"]);
      expect(finalized).toEqual(["first"]);

      // The second invocation is untouched and settles on its own.
      return yield* secondConsumer;
    });

    // Each callback fired for its own invocation, once — and the invocation
    // started with A ran A, not the B its caller substituted afterwards.
    expect(seen.filter((entry) => entry.startsWith("observed:")).sort()).toEqual([
      "observed:A",
      "observed:first",
      "observed:second",
    ]);
    expect(settledSecond.ok).toBe(true);
    expect(halted).toEqual(["first"]);
    expect(finalized).toEqual(["first", "second"]);
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

/**
 * Tier DP — the document protocol.
 *
 * `Execution.document` is policy on the same terms `Execution.execute` is, with
 * one difference: its chain *surrounds* canonical document execution rather than
 * unwinding before it. A handler runs while the document is running, so it can
 * answer instead of it, throw after it, or keep hold of what it handed in —
 * and none of those may decide what the document was.
 */
describe("Tier DP — the document protocol", () => {
  /** `<Mutate />` — edits the caller's own containers while the document runs. */
  function useMutate(edit: () => void): Operation<void> {
    return registerComponents([
      {
        name: "Mutate",
        origin: "tier-dp",
        props: { type: "object", properties: {}, additionalProperties: false },
        // deno-lint-ignore require-yield
        *fn() {
          edit();
          return "";
        },
      },
    ]);
  }

  /** `<Boom />` — canonical execution raises this exact object. */
  function useBoom(error: unknown): Operation<void> {
    return registerComponents([
      {
        name: "Boom",
        origin: "tier-dp",
        props: { type: "object", properties: {}, additionalProperties: false },
        // deno-lint-ignore require-yield
        *fn(): Operation<string> {
          throw error;
        },
      },
    ]);
  }

  const BOOM_DOC = "<Boom />\n";

  /**
   * A descriptor of the Api's name whose `document` accepts anything.
   *
   * The canonical surface types a `DocumentRequest`, so a handler cannot offer
   * the terminal a number or a look-alike through it. Middleware from elsewhere
   * is under no such obligation — its types are its own — and this is what that
   * looks like from the inside.
   */
  function loose(): Api<{ document(request: unknown): Operation<unknown> }> {
    return createApi("Execution", {
      // deno-lint-ignore require-yield
      *document(_request: unknown): Operation<unknown> {
        return undefined;
      },
    });
  }

  /**
   * Every way a consumer might read a reported failure.
   *
   * Calling this at all is the assertion: if any member throws, the test fails
   * where it stands.
   */
  function inspect(reported: unknown): string[] {
    if (!(reported instanceof Error)) {
      return [String(reported)];
    }
    return [
      String(reported),
      reported.name,
      reported.message,
      String(reported.stack),
      String(reported.cause),
      JSON.stringify({ name: reported.name, message: reported.message }),
    ];
  }

  /** Every retained event's type and, for a Yield, what it was. */
  function shape(stream: InMemoryStream): string[] {
    return stream
      .snapshot()
      .map((event) =>
        event.type === "yield"
          ? `yield:${event.description.type}(${event.description.name})`
          : `${event.type}:${event.coroutineId}`,
      );
  }

  describe("lineage", () => {
    it("DP1: a handler that answers without delegating is refused, and nothing is authored", function* () {
      const journal = new InMemoryStream();
      const expanded: string[] = [];
      const failure = yield* scoped(function* () {
        yield* useMark(expanded);
        yield* Execution.around({
          // deno-lint-ignore require-yield
          *document() {
            return undefined;
          },
        });
        return yield* raised(
          collect(yield* execute({ ...inlineSource("<Mark />\n"), stream: journal })),
        );
      });

      expect(failure).toBeInstanceOf(DocumentProtocolError);
      expect(expanded).toEqual([]);
      // No import was authorized and nothing expanded. The durable root still
      // records the refusal, because that is what this run turned out to be.
      expect(shape(journal)).toEqual(["close:root"]);
    });

    it("DP2: a substitute return after delegating is ignored", function* () {
      const output = yield* scoped(function* () {
        yield* loose().around({
          *document([request], next) {
            yield* next(request);
            return { status: "ok", output: "SUBSTITUTE", value: "SUBSTITUTE" };
          },
        });
        return yield* collect(
          yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }),
        );
      });
      expect(String(output)).toContain("Hello");
      expect(String(output)).not.toContain("SUBSTITUTE");
    });

    it("DP3: props replaced through withProps() are the ones the document runs on", function* () {
      const output = yield* scoped(function* () {
        yield* useMutate(() => {});
        yield* Execution.around({
          *document([request], next) {
            yield* next(
              request.withProps({ nested: { value: "replaced-value" }, items: ["replaced-item"] }),
            );
          },
        });
        return yield* collect(
          yield* execute({
            ...inlineSource(PROPS_DOC),
            stream: new InMemoryStream(),
            props: { nested: { value: "original" }, items: ["original-item"] },
          }),
        );
      });
      expect(String(output)).toContain("replaced-value");
      expect(String(output)).not.toContain("original");
    });

    it("DP4: a second delegation adds no second expansion to the first one's work", function* () {
      const journal = new InMemoryStream();
      const expanded: string[] = [];
      const result = yield* scoped(function* () {
        yield* useMark(expanded);
        yield* Execution.around({
          *document([request], next) {
            yield* next(request);
            yield* next(request);
          },
        });
        return yield* yield* execute({ ...inlineSource("<Mark />\n"), stream: journal });
      });

      expect(result.ok).toBe(false);
      expect(String(result.ok ? "" : result.error)).toContain("more than once");
      // The first delegation's work stands: one import, one expansion. The
      // second produced nothing at all.
      expect(expanded).toEqual(["expanded"]);
      expect(
        shape(journal).filter((entry) => entry === "yield:import_component(__root__)"),
      ).toEqual(["yield:import_component(__root__)"]);
    });

    it("DP5: a request a later withProps() superseded is refused", function* () {
      const failure = yield* scoped(function* () {
        yield* Execution.around({
          *document([request], next) {
            request.withProps({ ...request.props });
            yield* next(request);
          },
        });
        return yield* raised(
          collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() })),
        );
      });
      expect(failure).toBeInstanceOf(DocumentProtocolError);
      expect(String(failure)).toContain("superseded");
    });

    it("DP6: invalid, reconstructed and hostile values are refused without a native error", function* () {
      const hostile = new Proxy(
        {},
        {
          has() {
            throw new Error("PLANTED-HAS");
          },
        },
      );
      // A look-alike carrying the whole public shape and none of the lineage.
      const reconstructed = {
        props: {},
        withProps(): never {
          throw new Error("PLANTED-WITHPROPS");
        },
      };
      const values: unknown[] = [null, undefined, 7, "request", true, {}, hostile, reconstructed];

      for (const value of values) {
        const journal = new InMemoryStream();
        const expanded: string[] = [];
        const failure = yield* scoped(function* () {
          yield* useMark(expanded);
          yield* loose().around({
            *document([,], next) {
              yield* next(value);
            },
          });
          return yield* raised(
            collect(yield* execute({ ...inlineSource("<Mark />\n"), stream: journal })),
          );
        });
        expect(failure).toBeInstanceOf(DocumentProtocolError);
        expect(failure instanceof Error ? failure.cause : "unset").toBeUndefined();
        expect(String(failure)).not.toContain("PLANTED");
        expect(expanded).toEqual([]);
        expect(shape(journal)).toEqual(["close:root"]);
      }
    });

    it("DP7: a stale request is refused after the expansion it belonged to is over", function* () {
      const held = withResolvers<DocumentRequest>();
      yield* scoped(function* () {
        yield* Execution.around({
          *document([request], next) {
            held.resolve(request);
            yield* next(request);
          },
        });
        yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }));
      });

      // The same request, offered to a *later* invocation's terminal.
      const stale = yield* held.operation;
      const failure = yield* scoped(function* () {
        yield* Execution.around({
          *document([,], next) {
            yield* next(stale);
          },
        });
        return yield* raised(
          collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() })),
        );
      });
      expect(failure).toBeInstanceOf(DocumentProtocolError);
      expect(String(failure)).toContain("another expansion");
    });

    it("DP8: middleware from another loaded copy composes and delegates", function* () {
      const seen: string[] = [];
      const foreign: Api<{ document(request: DocumentRequest): Operation<void> }> = createApi(
        "Execution",
        {
          // deno-lint-ignore require-yield
          *document(_request: DocumentRequest): Operation<void> {},
        },
      );
      const output = yield* scoped(function* () {
        yield* foreign.around({
          *document([request], next) {
            seen.push(typeof request.props);
            yield* next(request);
          },
        });
        return yield* collect(
          yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }),
        );
      });
      expect(seen).toEqual(["object"]);
      expect(String(output)).toContain("Hello");
    });

    it("DP9: two live expansions cannot settle each other, and both still settle themselves", function* () {
      const published: Array<ReturnType<typeof withResolvers<DocumentRequest>>> = [
        withResolvers<DocumentRequest>(),
        withResolvers<DocumentRequest>(),
      ];
      const refusals: unknown[] = [];
      const expanded: string[] = [];

      function side(index: number): Operation<string> {
        return scoped(function* () {
          yield* useMark(expanded);
          yield* Execution.around({
            *document([request], next) {
              // Both requests are live and unconsumed before either crosses over.
              published[index]!.resolve(request);
              const other = yield* published[index === 0 ? 1 : 0]!.operation;
              refusals.push(yield* raised(next(other)));
              yield* next(request);
            },
          });
          return String(
            yield* collect(
              yield* execute({ ...inlineSource("<Mark />\n"), stream: new InMemoryStream() }),
            ),
          );
        });
      }

      const first = yield* spawn(() => side(0));
      const second = yield* spawn(() => side(1));
      const outputs = [yield* first, yield* second];

      expect(refusals.length).toEqual(2);
      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(DocumentProtocolError);
        expect(refusal instanceof Error ? refusal.cause : "unset").toBeUndefined();
        expect(String(refusal)).toContain("another expansion");
      }
      // A rejected foreign delegation consumed neither: each expansion then
      // settled its own request, exactly once.
      expect(outputs.length).toEqual(2);
      expect(expanded).toEqual(["expanded", "expanded"]);
    });

    it("DP10: the exported default refuses a live request and consumes nothing", function* () {
      const captured = withResolvers<DocumentRequest>();
      const proceed = withResolvers<void>();

      // The capturing handler lives in an inner scope, so the call below reaches
      // the exported default rather than re-entering the chain.
      const running = yield* spawn(function* () {
        return yield* scoped(function* () {
          yield* Execution.around({
            *document([request], next) {
              captured.resolve(request);
              yield* proceed.operation;
              yield* next(request);
            },
          });
          return String(
            yield* collect(yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() })),
          );
        });
      });

      const request = yield* captured.operation;
      const refusal = yield* raised(Execution.operations.document(request));
      expect(refusal).toBeInstanceOf(DocumentProtocolError);
      expect(refusal instanceof Error ? refusal.cause : "unset").toBeUndefined();

      proceed.resolve();
      // The request the default refused was never consumed, so its own terminal
      // still accepts it.
      expect(yield* running).toContain("Hello");
    });
  });

  describe("detached props", () => {
    it("DP11: props accepted by the terminal are detached from the caller's containers", function* () {
      const nested = { value: "accepted-value" };
      const items = ["accepted-item"];
      const edited: string[] = [];

      const output = yield* scoped(function* () {
        yield* useMutate(() => {});
        // The window that actually exists: the terminal has accepted the props
        // and canonical execution has begun, but the root import has not
        // returned and nothing has read them yet. Editing here is the strongest
        // form of the attack — after acceptance, before use.
        yield* Component.around({
          *importComponent([name], next) {
            Reflect.set(nested, "value", "smuggled-value");
            Reflect.set(items, 0, "smuggled-item");
            edited.push(name);
            return yield* next(name);
          },
        });
        yield* Execution.around({
          *document([request], next) {
            yield* next(request.withProps({ nested, items }));
          },
        });
        return String(
          yield* collect(
            yield* execute({
              ...inlineSource(PROPS_DOC),
              stream: new InMemoryStream(),
              props: { nested: { value: "unused" }, items: ["unused"] },
            }),
          ),
        );
      });

      // The edit landed at the root import — after acceptance, before use.
      expect(edited[0]).toEqual("__root__");
      expect(output).toContain("accepted-value");
      expect(output).not.toContain("smuggled-value");
      expect(output).toContain("accepted-item");
      expect(output).not.toContain("smuggled-item");
      // The handler's own containers really were edited — the snapshot is what
      // protected the document, not an absence of mutation.
      expect(nested.value).toEqual("smuggled-value");
      expect(items[0]).toEqual("smuggled-item");
    });

    it('DP12: "__proto__" survives detachment as an ordinary member', function* () {
      const props: Record<string, Json> = { nested: { value: "kept" } };
      Object.defineProperty(props, "__proto__", {
        value: { polluted: "yes" },
        enumerable: true,
        writable: true,
        configurable: true,
      });

      const source = [
        "---",
        "props: { type: object, additionalProperties: true }",
        "---",
        "",
        '<Reader carried={props["__proto__"]} />',
        "",
        "leaked=[{props.polluted}]",
        "",
      ].join("\n");

      const captured: Array<Record<string, Json>> = [];
      const output = yield* scoped(function* () {
        yield* registerComponents([
          {
            name: "Reader",
            origin: "tier-dp",
            props: { type: "object", additionalProperties: true },
            // deno-lint-ignore require-yield
            *fn(componentProps: Record<string, Json>) {
              captured.push(componentProps);
              return "";
            },
          },
        ]);
        yield* Execution.around({
          *document([request], next) {
            yield* next(request.withProps(props));
          },
        });
        return String(
          yield* collect(yield* execute({ ...inlineSource(source), stream: new InMemoryStream() })),
        );
      });

      // Carried as data: not dropped, and not installed as the copy's prototype.
      // Assigning it instead installs it as the prototype on the runtimes whose
      // setter fires, which loses the member and makes what it held readable
      // through the chain.
      expect(captured[0]?.carried).toEqual({ polluted: "yes" });
      expect(output).toContain("leaked=[]");
    });

    it("DP13: a refused detachment consumes nothing, and the expansion still settles", function* () {
      const refusals: unknown[] = [];
      const hostile = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("PLANTED-OWNKEYS");
          },
        },
      );

      const output = yield* scoped(function* () {
        yield* Execution.around({
          *document([request], next) {
            refusals.push(yield* raised(next(request.withProps(hostile))));
            // The refusal changed nothing, so the current request still settles.
            yield* next(request.withProps({}));
          },
        });
        return yield* collect(
          yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() }),
        );
      });

      expect(refusals.length).toEqual(1);
      expect(refusals[0]).toBeInstanceOf(DocumentProtocolError);
      expect(refusals[0] instanceof Error ? refusals[0].cause : "unset").toBeUndefined();
      expect(String(refusals[0])).not.toContain("PLANTED");
      expect(String(output)).toContain("Hello");
    });

    it("DP14: props superseded from inside detachment are refused, and the newest ones run", function* () {
      // Detachment reads caller-controlled objects, so it runs caller code: a
      // getter, an `ownKeys` trap and an array's own accessors all get a turn
      // while the copy is being built. Each of these calls `withProps()` from
      // there, which supersedes the request the terminal is halfway through
      // accepting. Accepting it anyway would run the document on props the
      // handler had already replaced.
      const attacks: Array<{
        says: string;
        hostile: (supersede: () => void) => Record<string, Json>;
      }> = [
        {
          says: "an object property getter",
          hostile: (supersede) => {
            const props: Record<string, Json> = {};
            Object.defineProperty(props, "nested", {
              get() {
                supersede();
                return { value: "OLD" };
              },
              enumerable: true,
            });
            return props;
          },
        },
        {
          says: "an ownKeys trap",
          hostile: (supersede) =>
            new Proxy(
              { nested: { value: "OLD" }, items: [] },
              {
                ownKeys(target) {
                  supersede();
                  return Reflect.ownKeys(target);
                },
              },
            ),
        },
        {
          says: "an array's indexed accessor",
          hostile: (supersede) => {
            const items: Json[] = [];
            Object.defineProperty(items, "0", {
              get() {
                supersede();
                return "OLD";
              },
              enumerable: true,
              configurable: true,
            });
            Object.defineProperty(items, "length", { value: 1 });
            return { nested: { value: "OLD" }, items };
          },
        },
      ];

      for (const attack of attacks) {
        const refusals: unknown[] = [];
        const output = yield* scoped(function* () {
          yield* useMutate(() => {});
          yield* Execution.around({
            *document([request], next) {
              let current = request;
              const supersede = (): void => {
                current = current.withProps({
                  nested: { value: "NEW" },
                  items: ["NEW-item"],
                });
              };
              refusals.push(yield* raised(next(request.withProps(attack.hostile(supersede)))));
              // The replacement the attack itself created still settles, once.
              yield* next(current);
            },
          });
          return String(
            yield* collect(
              yield* execute({ ...inlineSource(PROPS_DOC), stream: new InMemoryStream() }),
            ),
          );
        });

        expect(refusals[0]).toBeInstanceOf(DocumentProtocolError);
        expect(String(refusals[0])).toContain("superseded");
        expect(output).toContain("NEW");
        expect(output).not.toContain("OLD");
      }
    });
  });

  describe("canonical outcome versus later policy", () => {
    it("DP15: a canonical outcome and a later policy failure are ranked, not replaced", function* () {
      const durable = new DurablePersistenceError("yield", new Error("planted-canonical"));
      const laterDurable = new DurablePersistenceError("close", new Error("planted-policy"));
      const filesFatal = new FilesInvariantError("protocol");
      const laterFiles = new FilesInvariantError("protocol");

      const cases: Array<{
        says: string;
        /** Raised by authored work, so canonical execution produces it. */
        canonical?: unknown;
        /** Document that fails on its own terms rather than raising. */
        failing?: boolean;
        /** Thrown by the handler after `next()` returned. */
        policy?: unknown;
        /** Caught by the handler instead of propagating. */
        swallow?: boolean;
        expect: (result: Result<Json>) => void;
      }> = [
        {
          says: "an ordinary canonical failure survives an ordinary policy failure",
          failing: true,
          policy: new Error("POST-DELEGATION-POLICY"),
          expect: (result) => {
            expect(result.ok).toBe(false);
            expect(String(result.ok ? "" : result.error)).not.toContain("POST-DELEGATION-POLICY");
          },
        },
        {
          says: "canonical success is converted by an ordinary policy failure",
          policy: new Error("POST-DELEGATION-POLICY"),
          expect: (result) => {
            expect(result.ok).toBe(false);
            expect(String(result.ok ? "" : result.error)).toContain("POST-DELEGATION-POLICY");
          },
        },
        {
          says: "a later durability failure outranks an ordinary canonical failure",
          failing: true,
          policy: laterDurable,
          expect: (result) => {
            expect(result.ok ? undefined : result.error).toBe(laterDurable);
          },
        },
        {
          says: "a later Files infrastructure failure outranks an ordinary canonical failure",
          failing: true,
          policy: laterFiles,
          expect: (result) => {
            expect(result.ok ? undefined : result.error).toBe(laterFiles);
          },
        },
        {
          says: "within one kind the canonical failure is the earlier one",
          canonical: durable,
          policy: laterDurable,
          expect: (result) => {
            expect(result.ok ? undefined : result.error).toBe(durable);
          },
        },
        {
          says: "within one kind a Files failure ranks the same way",
          canonical: filesFatal,
          policy: laterFiles,
          expect: (result) => {
            expect(result.ok ? undefined : result.error).toBe(filesFatal);
          },
        },
        {
          says: "a canonical failure the handler caught is still the final failure",
          canonical: durable,
          swallow: true,
          expect: (result) => {
            expect(result.ok ? undefined : result.error).toBe(durable);
          },
        },
        {
          says: "a canonical failure the handler caught is not replaced by its own",
          canonical: durable,
          swallow: true,
          policy: new Error("POST-DELEGATION-POLICY"),
          expect: (result) => {
            expect(result.ok ? undefined : result.error).toBe(durable);
          },
        },
      ];

      for (const scenario of cases) {
        const result = yield* scoped(function* () {
          if (scenario.canonical !== undefined) {
            yield* useBoom(scenario.canonical);
          }
          yield* Execution.around({
            *document([request], next) {
              if (scenario.swallow) {
                try {
                  yield* next(request);
                } catch {
                  // Middleware may observe a canonical failure. It may not undo it.
                }
              } else {
                yield* next(request);
              }
              if (scenario.policy !== undefined) {
                throw scenario.policy;
              }
            },
          });
          const source =
            scenario.canonical !== undefined ? BOOM_DOC : scenario.failing ? FAILING_DOC : DOC;
          return yield* yield* execute({ ...inlineSource(source), stream: new InMemoryStream() });
        });
        scenario.expect(result);
      }
    });

    it("DP16: cleanup finishes exactly once before a reconciled result is observable", function* () {
      const order: string[] = [];
      const result = yield* scoped(function* () {
        yield* Execution.around({
          *document([request], next) {
            yield* ensure(() => {
              order.push("cleanup");
            });
            yield* next(request);
            order.push("policy-failed");
            throw new Error("POST-DELEGATION-POLICY");
          },
        });
        const execution = yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() });
        const settled = yield* execution;
        order.push("observed");
        return settled;
      });

      expect(result.ok).toBe(false);
      expect(order).toEqual(["policy-failed", "cleanup", "observed"]);
    });

    it("DP17: cancelling during document policy keeps structured teardown", function* () {
      const entered = withResolvers<void>();
      const finalized: string[] = [];

      const settled = yield* scoped(function* () {
        yield* Execution.around({
          *document([,], _next) {
            yield* ensure(() => {
              finalized.push("cleanup");
            });
            entered.resolve();
            yield* suspend();
          },
        });

        const execution = yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream() });
        const consumer = yield* spawn(function* () {
          return yield* execution;
        });
        yield* entered.operation;
        yield* consumer.halt();
        return yield* execution;
      });

      // Cancellation, not an ordinary policy failure.
      expect(settled.ok).toBe(false);
      expect(String(settled.ok ? "" : settled.error)).toContain("cancelled");
      expect(finalized).toEqual(["cleanup"]);
    });
  });

  describe("trusted durable preparation", () => {
    /** A preparation that records that it ran, and nothing durable. */
    function marking(order: string[], name: string): DurablePreparation {
      // deno-lint-ignore require-yield
      return function* () {
        order.push(name);
      };
    }

    /**
     * A preparation that records a real durable effect.
     *
     * `entered` counts how often the preparation itself ran; `executed` counts
     * how often the effect's executor did. On a resumed run the first keeps
     * counting and the second must not, which is the whole difference between
     * durable preparation and a callback that happens to run early.
     */
    function preparing(name: string, entered: string[], executed: string[]): DurablePreparation {
      return function* () {
        entered.push(name);
        yield createDurableOperation<Json>(
          { type: "test_preparation", name },
          // deno-lint-ignore require-yield
          function* (): Operation<Json> {
            executed.push(name);
            return { prepared: name };
          },
        );
      };
    }

    it("DP18: prepare is read once, by value, before any install() runs", function* () {
      const order: string[] = [];
      let reads = 0;
      const installation: ExecutionInstallation = {
        *install(): Operation<void> {
          // Too late: what runs was fixed before this.
          Object.defineProperty(installation, "prepare", {
            value: marking(order, "replaced"),
            configurable: true,
          });
          order.push("installed");
        },
      };
      Object.defineProperty(installation, "prepare", {
        get() {
          reads += 1;
          return marking(order, `captured-${reads}`);
        },
        configurable: true,
      });

      yield* scoped(function* () {
        yield* collect(
          yield* executeInstalled({ ...inlineSource(DOC), stream: new InMemoryStream() }, [
            installation,
          ]),
        );
      });

      expect(reads).toEqual(1);
      expect(order).toEqual(["installed", "captured-1"]);
    });

    it("DP19: preparations run in installation order", function* () {
      const order: string[] = [];
      yield* scoped(function* () {
        yield* collect(
          yield* executeInstalled({ ...inlineSource(DOC), stream: new InMemoryStream() }, [
            { prepare: marking(order, "first") },
            { install: () => marking(order, "installed")() },
            { prepare: marking(order, "second") },
            { prepare: marking(order, "third") },
          ]),
        );
      });
      expect(order).toEqual(["installed", "first", "second", "third"]);
    });

    it("DP20: a refusal keeps what was prepared and stops everything after it", function* () {
      const order: string[] = [];
      const entered: string[] = [];
      const executed: string[] = [];
      const expanded: string[] = [];
      const journal = new InMemoryStream();

      const result = yield* scoped(function* () {
        yield* useMark(expanded);
        yield* Execution.around({
          *document([request], next) {
            order.push("document-policy");
            yield* next(request);
          },
        });
        return yield* yield* executeInstalled({ ...inlineSource("<Mark />\n"), stream: journal }, [
          { prepare: preparing("first", entered, executed) },
          {
            // deno-lint-ignore require-yield
            *prepare(): Workflow<void> {
              order.push("refused");
              throw new Error("PREPARATION-REFUSED");
            },
          },
          { prepare: marking(order, "third") },
        ]);
      });

      expect(result.ok).toBe(false);
      expect(String(result.ok ? "" : result.error)).toContain("PREPARATION-REFUSED");
      expect(entered).toEqual(["first"]);
      expect(executed).toEqual(["first"]);
      expect(order).toEqual(["refused"]);
      expect(expanded).toEqual([]);
      // The complete journal: the first preparation's durable effect is
      // retained, the root records the refusal, and no later phase happened.
      expect(shape(journal)).toEqual(["yield:test_preparation(first)", "close:root"]);

      // Resume that exact history with only the terminal removed. The first
      // preparation is entered again and finds its effect already recorded;
      // the second refuses again, and nothing after it happens.
      const recorded = journal.snapshot();
      const resumeEntered: string[] = [];
      const resumeExecuted: string[] = [];
      const resumeOrder: string[] = [];
      const resumeExpanded: string[] = [];
      const resumeJournal = new InMemoryStream(
        recorded.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
      );

      const resumed = yield* scoped(function* () {
        yield* useMark(resumeExpanded);
        yield* Execution.around({
          *document([request], next) {
            resumeOrder.push("document-policy");
            yield* next(request);
          },
        });
        return yield* yield* executeInstalled(
          { ...inlineSource("<Mark />\n"), stream: resumeJournal },
          [
            { prepare: preparing("first", resumeEntered, resumeExecuted) },
            {
              // deno-lint-ignore require-yield
              *prepare(): Workflow<void> {
                resumeOrder.push("refused");
                throw new Error("PREPARATION-REFUSED");
              },
            },
            { prepare: marking(resumeOrder, "third") },
          ],
        );
      });

      expect(resumed.ok).toBe(false);
      expect(String(resumed.ok ? "" : resumed.error)).toContain("PREPARATION-REFUSED");
      // Re-entered, and restored rather than performed a second time.
      expect(resumeEntered).toEqual(["first"]);
      expect(resumeExecuted).toEqual([]);
      expect(resumeOrder).toEqual(["refused"]);
      expect(resumeExpanded).toEqual([]);
      // The retained Yield is still singular, and a fresh terminal records the
      // refusal the resumed run reached.
      expect(shape(resumeJournal)).toEqual(["yield:test_preparation(first)", "close:root"]);
    });

    it("DP21: admission precedes preparation, which precedes policy and the root import", function* () {
      const order: string[] = [];
      const expanded: string[] = [];
      yield* scoped(function* () {
        yield* useMark(expanded);
        yield* Execution.around({
          *document([request], next) {
            order.push("document-policy");
            yield* next(request);
          },
        });
        yield* collect(
          yield* executeInstalled({ ...inlineSource("<Mark />\n"), stream: new InMemoryStream() }, [
            {
              admissions: [
                // deno-lint-ignore require-yield
                function* () {
                  order.push("admission");
                },
              ],
              prepare: marking(order, "preparation"),
            },
          ]),
        );
      });
      expect(expanded).toEqual(["expanded"]);
      expect(order).toEqual(["admission", "preparation", "document-policy"]);
    });

    it("DP22: a completed replay prepares nothing; a partial one resumes without re-executing", function* () {
      const entered: string[] = [];
      const executed: string[] = [];
      const live = new InMemoryStream();

      yield* scoped(function* () {
        yield* collect(
          yield* executeInstalled({ ...inlineSource(DOC), stream: live }, [
            { prepare: preparing("run", entered, executed) },
          ]),
        );
      });
      const recorded = live.snapshot();
      expect(entered).toEqual(["run"]);
      expect(executed).toEqual(["run"]);
      expect(shape(live)[0]).toEqual("yield:test_preparation(run)");

      // Completed terminal replay: the durable root is already settled, so the
      // body — preparation included — performs nothing.
      const onReplay: string[] = [];
      const replayedExecutions: string[] = [];
      const replayJournal = new InMemoryStream(recorded);
      const replayed = yield* scoped(function* () {
        return yield* collect(
          yield* executeInstalled({ ...inlineSource(DOC), stream: replayJournal }, [
            { prepare: preparing("run", onReplay, replayedExecutions) },
          ]),
        );
      });
      expect(String(replayed)).toContain("Hello");
      expect(onReplay).toEqual([]);
      expect(replayedExecutions).toEqual([]);
      expect(replayJournal.snapshot().length).toEqual(recorded.length);

      // Partial continuation: the root never closed, so the body runs again —
      // and the preparation's effect is restored from its retained Yield
      // instead of being performed a second time.
      const truncated = recorded.filter(
        (event) => !(event.type === "close" && event.coroutineId === "root"),
      );
      expect(truncated.length).toBeLessThan(recorded.length);
      const onResume: string[] = [];
      const resumedExecutions: string[] = [];
      const resumed = yield* scoped(function* () {
        return yield* collect(
          yield* executeInstalled({ ...inlineSource(DOC), stream: new InMemoryStream(truncated) }, [
            { prepare: preparing("run", onResume, resumedExecutions) },
          ]),
        );
      });
      expect(String(resumed)).toContain("Hello");
      expect(onResume).toEqual(["run"]);
      expect(resumedExecutions).toEqual([]);
    });
  });

  describe("terminals recorded before the root import", () => {
    /** Run a document whose policy refuses, and keep the journal it left. */
    function* refusedRun(stream: InMemoryStream, source: RootDocumentSource): Operation<unknown> {
      return yield* scoped(function* () {
        yield* Execution.around({
          // deno-lint-ignore require-yield
          *document() {
            return undefined;
          },
        });
        return yield* raised(collect(yield* execute({ ...source, stream })));
      });
    }

    it("DP23: an identical replay reads back a refusal recorded before any import", function* () {
      const journal = new InMemoryStream();
      const live = yield* refusedRun(journal, inlineSource(DOC));
      expect(live).toBeInstanceOf(DocumentProtocolError);

      const recorded = journal.snapshot();
      const replay = new InMemoryStream(recorded);
      const order: string[] = [];
      const expanded: string[] = [];

      const replayed = yield* scoped(function* () {
        yield* useMark(expanded);
        yield* Execution.around({
          *document([request], next) {
            order.push("document-policy");
            yield* next(request);
          },
        });
        return yield* raised(
          collect(
            yield* executeInstalled({ ...inlineSource(DOC), stream: replay }, [
              {
                // deno-lint-ignore require-yield
                *prepare(): Workflow<void> {
                  order.push("preparation");
                },
              },
            ]),
          ),
        );
      });

      // The same failure, read back rather than re-decided.
      expect(String(replayed)).toContain(String(live));
      // Nothing ran and nothing was written.
      expect(order).toEqual([]);
      expect(expanded).toEqual([]);
      expect(replay.snapshot().length).toEqual(recorded.length);
    });

    it("DP27: a failure that will not be read still records a bound terminal", function* () {
      const planted = new Error("PLANTED-COERCION");
      /** Not an error at all, and hostile to being turned into one. */
      const coercing = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === Symbol.toPrimitive) {
              return () => {
                throw planted;
              };
            }
            return undefined;
          },
        },
      );
      /** An Error whose every description accessor refuses. */
      class Refusing extends Error {
        override get name(): string {
          throw planted;
        }
        override get message(): string {
          throw planted;
        }
        override get stack(): string {
          throw planted;
        }
        override get cause(): unknown {
          throw planted;
        }
      }
      const refusing = new Refusing();
      /** Not an error, and hostile to being asked whether it is one. */
      const unclassifiable = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw planted;
          },
        },
      );
      /** Nominally an error, and hostile to being asked whether it is one. */
      const disguised = new Proxy(new Error("DISGUISED"), {
        getPrototypeOf() {
          throw planted;
        },
      });
      /** Hostile to every property read, including the cause walk. */
      const unreadable = new Proxy(
        {},
        {
          get() {
            throw planted;
          },
        },
      );
      const ordinary = new Error("ORDINARY-PRE-ROOT");
      const durable = new DurablePersistenceError("yield", new Error("planted-durable"));
      const filesFatal = new FilesInvariantError("protocol");

      const cases: Array<{
        says: string;
        thrown: unknown;
        /** Fatal failures keep escaping; they are not this run's outcome. */
        fatal?: boolean;
        /**
         * What the completion may report.
         *
         * `identity` — the exact object, which only a fatal failure gets.
         * `described` — a core-owned error carrying what the failure safely
         * gave up. `opaque` — a core-owned error under the fixed description,
         * because the failure gave up nothing.
         */
        reported: "identity" | "described" | "opaque";
      }> = [
        { says: "a proxy whose coercion throws", thrown: coercing, reported: "opaque" },
        { says: "a proxy whose getPrototypeOf throws", thrown: unclassifiable, reported: "opaque" },
        {
          says: "a proxy whose every property read throws",
          thrown: unreadable,
          reported: "opaque",
        },
        {
          says: "an error behind a proxy whose getPrototypeOf throws",
          thrown: disguised,
          reported: "opaque",
        },
        { says: "an error whose accessors refuse", thrown: refusing, reported: "opaque" },
        // Nothing an ordinary handler threw crosses as itself, however
        // well-behaved it looks while core is looking at it.
        { says: "an ordinary error", thrown: ordinary, reported: "described" },
        { says: "a durability failure", thrown: durable, fatal: true, reported: "identity" },
        {
          says: "a Files infrastructure failure",
          thrown: filesFatal,
          fatal: true,
          reported: "identity",
        },
      ];

      // Both boundaries that can fail before anything is imported.
      const boundaries: Array<{
        says: string;
        run: (thrown: unknown, stream: InMemoryStream) => Operation<Result<Json>>;
      }> = [
        {
          says: "document policy, before delegating",
          run: (thrown, stream) =>
            scoped(function* () {
              yield* Execution.around({
                // deno-lint-ignore require-yield
                *document() {
                  throw thrown;
                },
              });
              return yield* yield* execute({ ...inlineSource(DOC), stream });
            }),
        },
        {
          says: "preparation",
          run: (thrown, stream) =>
            scoped(function* () {
              return yield* yield* executeInstalled({ ...inlineSource(DOC), stream }, [
                {
                  // deno-lint-ignore require-yield
                  *prepare(): Workflow<void> {
                    throw thrown;
                  },
                },
              ]);
            }),
        },
      ];

      for (const boundary of boundaries) {
        for (const scenario of cases) {
          const journal = new InMemoryStream();
          const result = yield* boundary.run(scenario.thrown, journal);
          expect(result.ok).toBe(false);

          if (scenario.reported === "identity") {
            // The object this run was given, not a rebuild of it.
            expect(result.ok ? undefined : result.error).toBe(scenario.thrown);
          } else {
            // Core's own error, safe to read as often as anyone likes.
            const reported = result.ok ? "" : result.error;
            expect(reported).not.toBe(scenario.thrown);
            expect(reported).toBeInstanceOf(Error);
            expect(String(reported)).toContain(
              scenario.reported === "described" ? "ORDINARY-PRE-ROOT" : "could not be described",
            );
            // Read repeatedly: a member that answers once is not the property
            // being asserted here.
            for (const pass of [0, 1, 2]) {
              void pass;
              for (const text of inspect(reported)) {
                expect(text).not.toContain("PLANTED");
                expect(text).not.toContain("DISGUISED");
              }
            }
          }
          // Nothing the failure carried reached the journal.
          const written = JSON.stringify(journal.snapshot());
          expect(written).not.toContain("PLANTED");
          expect(written).not.toContain("DISGUISED");

          if (scenario.fatal) {
            // A fatal failure is not converted into this run's own outcome.
            continue;
          }

          // Everything else left a terminal the identical execution can read.
          const recorded = journal.snapshot();
          const replay = new InMemoryStream(recorded);
          const entered: string[] = [];
          const replayed = yield* scoped(function* () {
            yield* Execution.around({
              *document([request], next) {
                entered.push("policy");
                yield* next(request);
              },
            });
            return yield* yield* executeInstalled({ ...inlineSource(DOC), stream: replay }, [
              {
                // deno-lint-ignore require-yield
                *prepare(): Workflow<void> {
                  entered.push("preparation");
                },
              },
            ]);
          });

          expect(replayed.ok).toBe(false);
          const message = String(replayed.ok ? "" : replayed.error.message);
          expect(message).not.toContain("cannot be read by this version");
          expect(message).not.toContain("PLANTED");
          expect(entered).toEqual([]);
          expect(replay.snapshot().length).toEqual(recorded.length);
        }
      }
    });

    it("DP29: a failure that turns hostile after inspection never reaches the caller", function* () {
      // The defect this closes: passing inspection is not a property a value
      // has, it is something a value did once. Each of these behaves while
      // canonical core is looking at it and throws afterwards — so a boundary
      // that sampled it and published it by identity would move the trap into
      // whoever reads the result.
      for (const boundary of ["document policy", "preparation"]) {
        let hostile = false;
        let reads = 0;
        const planted = new Error("PLANTED-LATE-READ");
        const trap = new Proxy(new Error("SAFE-PHASE"), {
          get(base, property, receiver) {
            if (property === "name" || property === "message") {
              reads += 1;
            }
            if (hostile) {
              throw planted;
            }
            return Reflect.get(base, property, receiver);
          },
        });

        const journal = new InMemoryStream();
        const result = yield* scoped(function* () {
          if (boundary === "document policy") {
            yield* Execution.around({
              // deno-lint-ignore require-yield
              *document() {
                throw trap;
              },
            });
            return yield* yield* execute({ ...inlineSource(DOC), stream: journal });
          }
          return yield* yield* executeInstalled({ ...inlineSource(DOC), stream: journal }, [
            {
              // deno-lint-ignore require-yield
              *prepare(): Workflow<void> {
                throw trap;
              },
            },
          ]);
        });

        // Inspected while it was behaving, then turned hostile before the
        // caller reads anything.
        expect(reads).toBeGreaterThan(0);
        hostile = true;

        expect(result.ok).toBe(false);
        const reported = result.ok ? "" : result.error;
        // Not the object that can still be made to throw.
        expect(reported).not.toBe(trap);
        expect(reported).toBeInstanceOf(Error);
        // Reading it, repeatedly and every way, cannot throw.
        for (const pass of [0, 1, 2]) {
          void pass;
          for (const text of inspect(reported)) {
            expect(text).not.toContain("PLANTED");
          }
        }
        expect(JSON.stringify(journal.snapshot())).not.toContain("PLANTED");

        // The bound terminal was still written, and replays without running
        // anything.
        const recorded = journal.snapshot();
        const replay = new InMemoryStream(recorded);
        const entered: string[] = [];
        const replayed = yield* scoped(function* () {
          yield* Execution.around({
            *document([request], next) {
              entered.push("policy");
              yield* next(request);
            },
          });
          return yield* yield* executeInstalled({ ...inlineSource(DOC), stream: replay }, [
            {
              // deno-lint-ignore require-yield
              *prepare(): Workflow<void> {
                entered.push("preparation");
              },
            },
          ]);
        });
        expect(replayed.ok).toBe(false);
        expect(String(replayed.ok ? "" : replayed.error)).not.toContain(
          "cannot be read by this version",
        );
        expect(entered).toEqual([]);
        expect(replay.snapshot().length).toEqual(recorded.length);
      }
    });

    it("DP30: a canonical refusal middleware mutated is not the one published", function* () {
      // Provenance says where an object came from. It does not say what the
      // object still holds: a handler can catch the very refusal this expansion
      // raised, replace its members with throwing accessors, and rethrow the
      // same object. It is still core's object, and it is no longer core's
      // diagnostic.
      const journal = new InMemoryStream();
      const expanded: string[] = [];
      const caught: unknown[] = [];

      const result = yield* scoped(function* () {
        yield* useMark(expanded);
        yield* loose().around({
          *document([,], next) {
            try {
              // Invalid: the terminal refuses, and this is core's own error.
              yield* next(7);
            } catch (error) {
              caught.push(error);
              if (error instanceof Error) {
                Object.defineProperty(error, "name", {
                  get() {
                    throw new Error("PLANTED-MUTATED-CORE-REFUSAL");
                  },
                  configurable: true,
                });
                Object.defineProperty(error, "message", {
                  value: "PLANTED-MUTATED-CORE-REFUSAL",
                  configurable: true,
                });
                Object.defineProperty(error, "stack", {
                  get() {
                    throw new Error("PLANTED-MUTATED-CORE-REFUSAL");
                  },
                  configurable: true,
                });
                Object.defineProperty(error, "cause", {
                  get() {
                    throw new Error("PLANTED-MUTATED-CORE-REFUSAL");
                  },
                  configurable: true,
                });
              }
              throw error;
            }
          },
        });
        return yield* yield* execute({ ...inlineSource("<Mark />\n"), stream: journal });
      });

      expect(caught.length).toEqual(1);
      expect(result.ok).toBe(false);
      const reported = result.ok ? "" : result.error;
      // Not the object the handler held.
      expect(reported).not.toBe(caught[0]);
      // Still classified as core's refusal, and still carrying core's reason.
      expect(reported).toBeInstanceOf(DocumentProtocolError);
      expect(String(reported)).toContain("canonical execution did not issue");
      for (const pass of [0, 1, 2]) {
        void pass;
        for (const text of inspect(reported)) {
          expect(text).not.toContain("PLANTED");
        }
      }
      // Nothing planted reached the journal, and nothing authored ran.
      expect(JSON.stringify(journal.snapshot())).not.toContain("PLANTED");
      expect(expanded).toEqual([]);
      expect(shape(journal)).toEqual(["close:root"]);

      // The bound terminal still replays, running nothing.
      const recorded = journal.snapshot();
      const replay = new InMemoryStream(recorded);
      const entered: string[] = [];
      const replayed = yield* scoped(function* () {
        yield* useMark(entered);
        yield* Execution.around({
          *document([request], next) {
            entered.push("policy");
            yield* next(request);
          },
        });
        return yield* yield* executeInstalled({ ...inlineSource("<Mark />\n"), stream: replay }, [
          {
            // deno-lint-ignore require-yield
            *prepare(): Workflow<void> {
              entered.push("preparation");
            },
          },
        ]);
      });
      expect(replayed.ok).toBe(false);
      expect(String(replayed.ok ? "" : replayed.error)).toContain(
        "canonical execution did not issue",
      );
      expect(String(replayed.ok ? "" : replayed.error)).not.toContain("PLANTED");
      expect(entered).toEqual([]);
      expect(replay.snapshot().length).toEqual(recorded.length);
    });

    it("DP28: only the complete canonical failed terminal authorizes reuse", function* () {
      const journal = new InMemoryStream();
      yield* refusedRun(journal, inlineSource(DOC));
      const recorded = journal.snapshot();
      expect(recorded.length).toEqual(1);

      /** The recorded terminal, with its settlement replaced wholesale. */
      function settled(edit: (settlement: Record<string, Json>) => void): DurableEvent[] {
        const copy = JSON.parse(JSON.stringify(recorded[0]));
        edit(copy.result);
        return [copy];
      }

      const binding = { path: "<eval>", source: DOC, target: null };
      const forgeries: Array<{ says: string; events: DurableEvent[] }> = [
        {
          // The reason a binding alone cannot authorize anything: core reaches
          // this position only by failing, so a recorded success is a record it
          // could not have written.
          says: "a successful result carrying a valid binding",
          events: settled((settlement) => {
            settlement.value = {
              status: "ok",
              output: "FORGED",
              value: "FORGED",
              root_binding: binding,
            };
          }),
        },
        {
          says: "inner failure data of the wrong shape",
          events: settled((settlement) => {
            settlement.value = {
              status: "err",
              output: "",
              error: { name: "Error", message: "forged" },
              root_binding: binding,
            };
          }),
        },
        {
          says: "inner failure data carrying an extra member",
          events: settled((settlement) => {
            settlement.value = {
              status: "err",
              output: "",
              error: {
                name: "Error",
                message: "forged",
                segment: { message: "forged", source: "PLANTED-SOURCE" },
              },
              root_binding: binding,
            };
          }),
        },
        {
          // Core writes the failure's own message in both places, so a record
          // whose two messages disagree is one it could not have written.
          says: "a segment message that disagrees with the failure's",
          events: settled((settlement) => {
            settlement.value = {
              status: "err",
              output: "",
              error: {
                name: "Error",
                message: "ORIGINAL-MESSAGE",
                segment: { message: "IMPOSSIBLE-SEGMENT" },
              },
              root_binding: binding,
            };
          }),
        },
        {
          says: "rendered output a pre-root terminal never has",
          events: settled((settlement) => {
            settlement.value = {
              status: "err",
              output: "FORGED",
              error: {
                name: "Error",
                message: "forged",
                segment: { message: "forged" },
              },
              root_binding: binding,
            };
          }),
        },
      ];

      for (const forgery of forgeries) {
        const refusal = yield* scoped(function* () {
          return yield* raised(
            collect(
              yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream(forgery.events) }),
            ),
          );
        });
        expect(String(refusal)).toContain("cannot be read by this version");
        expect(String(refusal)).not.toContain("FORGED");
        expect(String(refusal)).not.toContain("PLANTED");
        expect(String(refusal)).not.toContain("ORIGINAL-MESSAGE");
        expect(String(refusal)).not.toContain("IMPOSSIBLE-SEGMENT");
      }
    });

    it("DP24: a pre-root terminal is not reusable by a different root document", function* () {
      const journal = new InMemoryStream();
      yield* refusedRun(journal, inlineSource(DOC));
      const recorded = journal.snapshot();

      const others = [
        { says: "different source", root: inlineSource("# Different\n") },
        { says: "different target", root: inlineSource(DOC, { target: "Hello" }) },
        { says: "a file root at another path", root: fileSource("elsewhere.md") },
      ];

      for (const other of others) {
        const refusal = yield* scoped(function* () {
          return yield* raised(
            collect(yield* execute({ ...other.root, stream: new InMemoryStream(recorded) })),
          );
        });
        expect(String(refusal)).toContain("different root document");
      }
    });

    it("DP25: a terminal without a readable core binding is never reusable", function* () {
      const journal = new InMemoryStream();
      yield* refusedRun(journal, inlineSource(DOC));
      const recorded = journal.snapshot();
      const close = recorded[0];
      expect(recorded.length).toEqual(1);
      expect(close?.type).toEqual("close");

      /** The recorded terminal's value, with its binding replaced. */
      function rebound(binding: unknown): DurableEvent[] {
        const original = JSON.parse(JSON.stringify(close));
        if (binding === undefined) {
          delete original.result.value.root_binding;
        } else {
          original.result.value.root_binding = binding;
        }
        return [original];
      }

      const attempts: Array<{ says: string; events: DurableEvent[] }> = [
        { says: "missing", events: rebound(undefined) },
        { says: "not an object", events: rebound("inline") },
        { says: "null", events: rebound(null) },
        { says: "a missing member", events: rebound({ path: "<eval>", target: null }) },
        {
          says: "an extra member",
          events: rebound({ path: "<eval>", source: DOC, target: null, extra: 1 }),
        },
        {
          says: "a mistyped member",
          events: rebound({ path: "<eval>", source: DOC, target: 7 }),
        },
        // Two terminals, each one core could have written. A history that
        // recorded two completions is not one completed run, and neither of
        // them is the one this run stands behind.
        { says: "duplicated", events: [...recorded, ...recorded] },
      ];

      for (const attempt of attempts) {
        const refusal = yield* scoped(function* () {
          return yield* raised(
            collect(
              yield* execute({ ...inlineSource(DOC), stream: new InMemoryStream(attempt.events) }),
            ),
          );
        });
        expect(String(refusal)).toContain("cannot be read by this version");
      }
    });

    it("DP26: a failed preparation is replayable on the same terms", function* () {
      const journal = new InMemoryStream();
      const entered: string[] = [];

      const live = yield* scoped(function* () {
        return yield* raised(
          collect(
            yield* executeInstalled({ ...inlineSource(DOC), stream: journal }, [
              {
                // deno-lint-ignore require-yield
                *prepare(): Workflow<void> {
                  entered.push("live");
                  throw new Error("PREPARATION-REFUSED");
                },
              },
            ]),
          ),
        );
      });
      expect(String(live)).toContain("PREPARATION-REFUSED");
      expect(entered).toEqual(["live"]);

      const recorded = journal.snapshot();
      const replay = new InMemoryStream(recorded);
      const replayed = yield* scoped(function* () {
        return yield* raised(
          collect(
            yield* executeInstalled({ ...inlineSource(DOC), stream: replay }, [
              {
                // deno-lint-ignore require-yield
                *prepare(): Workflow<void> {
                  entered.push("replay");
                  throw new Error("PREPARATION-REFUSED");
                },
              },
            ]),
          ),
        );
      });

      expect(String(replayed)).toContain("PREPARATION-REFUSED");
      // Read back, not re-decided: the preparation never ran again.
      expect(entered).toEqual(["live"]);
      expect(replay.snapshot().length).toEqual(recorded.length);
    });
  });
});
