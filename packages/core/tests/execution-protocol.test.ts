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
import { scoped } from "effection";
import type { Operation } from "effection";
import { createApi } from "@effectionx/context-api";
import type { Api } from "@effectionx/context-api";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  collect,
  execute,
  Execution,
  ExecutionProtocolError,
  inlineSource,
  registerComponents,
} from "../mod.ts";
import type { ExecutionRequest } from "../mod.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation, JournalAdmission } from "../host.ts";

const DOC = "# Hello\n";

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
    // Rebuilt by name, cleared before and during the invocation. There is
    // nothing behind the name, so neither has any effect.
    const obsolete = createApi<{ admissions(): Operation<unknown> }>(
      "executablemd.core.journal-admission",
      {
        // deno-lint-ignore require-yield
        *admissions(): Operation<unknown> {
          return [];
        },
      },
    );

    yield* scoped(function* () {
      yield* obsolete.around({
        // deno-lint-ignore require-yield
        *admissions() {
          return [];
        },
      });
      yield* Execution.around({
        *execute([request], next) {
          yield* obsolete.around({
            // deno-lint-ignore require-yield
            *admissions() {
              return [];
            },
          });
          yield* next(request);
        },
      });
      yield* collect(
        yield* executeInstalled({ ...inlineSource(DOC), stream: new InMemoryStream() }, [
          {
            // deno-lint-ignore require-yield
            admissions: [
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
