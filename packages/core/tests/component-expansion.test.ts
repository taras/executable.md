/**
 * Tier CX — canonical expansion observation (spec §5.7).
 *
 * What a `Component.expand` handler is offered, what it may do with it, and
 * what the element's observers are told. These drive `expandSegments` through
 * the real engine, so the phases asserted here are the ones an element
 * actually passed through rather than a report of them.
 *
 * The subject is the boundary, not the body: every case below also checks that
 * observing changed nothing about what the document rendered or how it failed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { each, ensure, scoped, sleep, spawn, useScope, withResolvers } from "effection";
import type { Scope } from "effection";
import type { Operation } from "effection";
import { DurablePersistenceError } from "@executablemd/durable-streams";
import { FilesProviderUnavailableError } from "@executablemd/runtime";
import { Component } from "../src/component-api.ts";
import { printErrors } from "../src/component-failures.ts";
import { durabilityFailure, filesFatalFailure } from "../src/errors.ts";
import type { ComponentExpansionPhase, ComponentExpansionRequest } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import type { EvalEnv, FunctionComponentDefinition, Json, Segment } from "../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

function component(name: string, fn: () => Operation<Json>): FunctionComponentDefinition {
  return { kind: "function", name, props: NO_PROPS, fn };
}

/** Every phase one run published, by the element it belongs to. */
interface Watched {
  readonly seen: Map<string, ComponentExpansionPhase[]>;
  readonly order: string[];
  readonly requests: ComponentExpansionRequest[];
}

/**
 * Expand `source`, watching every element through the public chain.
 *
 * `observe` is the handler under test; the default delegates once, which is
 * what an ordinary observer does. Each element's subscription is spawned as a
 * sibling of the dispatch rather than joined inside it: the terminal phase is
 * published after handlers unwind, so a handler that waited for it in its own
 * destructor would wait for itself.
 */
function watch(
  source: string,
  definitions: Record<string, FunctionComponentDefinition>,
  observe?: (
    request: ComponentExpansionRequest,
    next: (request: ComponentExpansionRequest) => Operation<void>,
    read: (collect: (phase: ComponentExpansionPhase) => void) => void,
    owner: Scope,
  ) => Operation<void>,
): Operation<{
  readonly watched: Watched;
  readonly rendered: string;
  readonly failure?: unknown;
  /** What this run said in the end, however it said it. */
  readonly report: string;
}> {
  return scoped(function* () {
    const watched: Watched = { seen: new Map(), order: [], requests: [] };
    // The owner every subscription runs under. Core publishes the terminal
    // phase after the whole dispatch has unwound, so a subscription spawned on
    // the handler's own frame dies before it is told the element completed —
    // which is the one thing a reader is watching for.
    const owner: Scope = yield* useScope();
    const reading = (
      request: ComponentExpansionRequest,
      collect: (phase: ComponentExpansionPhase) => void,
    ): void => {
      owner.run(function* () {
        for (const phase of yield* each(request.phases)) {
          collect(phase);
          yield* each.next();
        }
      });
    };
    const env: EvalEnv = { values: {} };
    yield* Component.around({ env: () => env }, { at: "min" });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          const definition = definitions[name];
          if (!definition) {
            throw new Error(`no component ${name}`);
          }
          return definition;
        },
      },
      { at: "min" },
    );
    yield* Component.around({
      *expand([request], next) {
        watched.requests.push(request);
        const phases: ComponentExpansionPhase[] = [];
        watched.seen.set(request.expansion.id, phases);
        reading(request, (phase) => {
          phases.push(phase);
          watched.order.push(`${request.expansion.name}:${phase.phase}`);
        });
        if (observe !== undefined) {
          yield* observe(request, next, (collect) => reading(request, collect), owner);
          return;
        }
        yield* next(request);
      },
    });

    let failure: unknown;
    let segments: Segment[] = [];
    try {
      segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
    } catch (error) {
      failure = error;
    }
    // One turn, so the spawned subscriptions drain what was published while
    // the element was unwinding.
    yield* sleep(0);
    const rendered = renderSegments(segments);
    return {
      watched,
      rendered,
      failure,
      report: failure === undefined ? rendered : String(failure),
    };
  });
}

/**
 * The detached report the one element under test completed with.
 *
 * Throws rather than returning undefined: a case that reaches here expects a
 * failed terminal, and a missing one is the case not having happened.
 */
function reportedBy(watched: Watched): Error {
  const phases = [...watched.seen.values()][0] ?? [];
  const terminal = phases[phases.length - 1];
  if (terminal?.phase !== "complete" || terminal.result.ok) {
    throw new Error("the element did not complete with a failure");
  }
  return terminal.result.error;
}

describe("Tier CX — what surrounds one expansion", () => {
  it("CX1: a function component is entered, active, exited and completed, in order", function* () {
    const { watched, rendered } = yield* watch("<Hello />", {
      Hello: component("Hello", function* () {
        return "hi";
      }),
    });

    expect(rendered).toBe("hi");
    expect(watched.order).toEqual(["Hello:enter", "Hello:active", "Hello:exit", "Hello:complete"]);
    const phases = [...watched.seen.values()][0];
    const exit = phases[2];
    expect(exit.phase === "exit" && exit.reason).toBe("returned");
    const complete = phases[3];
    expect(complete.phase === "complete" && complete.result.ok).toBe(true);
  });

  it("CX1: a body that throws exits as failed and completes with a detached report", function* () {
    const { watched, report } = yield* watch("<Boom />", {
      Boom: component("Boom", function* () {
        throw new Error("the body said no");
      }),
    });

    expect(watched.order).toEqual(["Boom:enter", "Boom:active", "Boom:exit", "Boom:complete"]);
    const phases = [...watched.seen.values()][0];
    const exit = phases[2];
    expect(exit.phase === "exit" && exit.reason).toBe("failed");
    const complete = phases[3];
    if (complete.phase !== "complete" || complete.result.ok) {
      throw new Error("the element completed without a failure");
    }
    // What it was called and what it said, and nothing canonical execution is
    // holding: a new Error every time, frozen, reaching no live object.
    expect(complete.result.error.message).toContain("the body said no");
    expect(Object.isFrozen(complete.result.error)).toBe(true);
    // The document still reports the failure the way it always did.
    expect(report).toContain("the body said no");
  });

  it("CX1: an element that resolves to nothing is never active, and still completes", function* () {
    const { watched, report } = yield* watch("<Missing />", {});
    const phases = [...watched.seen.values()][0].map((one) => one.phase);
    // Resolution refused it, so no work was ever accepted — and the element
    // still finished, because an observer is told how every expansion ended.
    expect(phases).not.toContain("active");
    expect(phases[phases.length - 1]).toBe("complete");
    expect(report).toContain("no component Missing");
  });

  it("CX4: two readers of one element each get the whole sequence", function* () {
    const first: string[] = [];
    const second: string[] = [];
    const { rendered } = yield* watch(
      "<Hello />",
      {
        Hello: component("Hello", function* () {
          return "hi";
        }),
      },
      // deno-lint-ignore require-yield
      function* (request, next, read) {
        for (const collected of [first, second]) {
          read((phase) => collected.push(phase.phase));
        }
        return yield* next(request);
      },
    );

    expect(rendered).toBe("hi");
    expect(first).toEqual(["enter", "active", "exit", "complete"]);
    expect(second).toEqual(first);
  });

  it("CX4: a reader that never reads delays nothing", function* () {
    const { rendered, watched } = yield* watch(
      "<Hello />",
      {
        Hello: component("Hello", function* () {
          return "hi";
        }),
      },
      function* (request, next) {
        // Subscribed and then abandoned: the queue fills and nobody drains it.
        yield* request.phases;
        yield* next(request);
      },
    );

    expect(rendered).toBe("hi");
    expect(watched.requests.length).toBe(1);
  });

  it("CX1: a handler that returns without delegating refuses the work", function* () {
    let ran = false;
    const { report } = yield* watch(
      "<Hello />",
      {
        Hello: component("Hello", function* () {
          ran = true;
          return "hi";
        }),
      },
      // deno-lint-ignore require-yield
      function* () {},
    );

    expect(ran).toBe(false);
    expect(report).toContain("without delegating");
  });

  it("CX1: a counterfeit request runs nothing", function* () {
    let ran = false;
    const { report } = yield* watch(
      "<Hello />",
      {
        Hello: component("Hello", function* () {
          ran = true;
          return "hi";
        }),
      },
      function* (request, next) {
        // Every member the real one has, and not the one it was issued as.
        yield* next({ expansion: request.expansion, phases: request.phases });
      },
    );

    expect(ran).toBe(false);
    expect(report).toContain("did not issue");
  });

  it("CX1: an authentic request from another invocation runs neither body", function* () {
    // R1. Not a fabricated object and not a copy — a *real* request belonging
    // to another invocation that is live and has not been delegated yet,
    // offered to this one's `next`. The brand is genuine and the claim is
    // unspent, so nothing about the request itself says no; what says no is
    // that this terminal is one element's continuation and that request was
    // issued for another.
    //
    // It has to be refused before the body runs. Refusing afterwards is too
    // late: the effect has happened, and the other element's one claim has
    // been spent by the wrong invocation.
    //
    // Two spawned siblings, so both expansions really are in flight at once:
    // in a sequential document the first element's request is already spent by
    // the time the second is offered it, which tests the wrong thing.
    const ran: string[] = [];
    const lent = withResolvers<ComponentExpansionRequest>();
    const tried = withResolvers<string>();
    const observed = yield* watch(
      "<All>\n<Spawn><Held /></Spawn>\n<Spawn><Other /></Spawn>\n</All>\n",
      {
        Held: component("Held", function* () {
          ran.push("Held");
          return "held";
        }),
        Other: component("Other", function* () {
          ran.push("Other");
          return "other";
        }),
      },
      function* (request, next) {
        if (request.expansion.name === "Held") {
          // Lent out before it is delegated, so what the other invocation is
          // offered is unconsumed.
          lent.resolve(request);
          yield* tried.operation;
          yield* next(request);
          return;
        }
        if (request.expansion.name !== "Other") {
          yield* next(request);
          return;
        }
        const theirs = yield* lent.operation;
        let refused: unknown;
        try {
          yield* next(theirs);
        } catch (error) {
          refused = error;
        }
        tried.resolve("done");
        expect(String(refused)).toContain("did not issue");
        // Neither body ran on the invalid delegation.
        expect(ran).toEqual([]);
        yield* next(request);
      },
    );
    // Both elements ran, each through its own terminal.
    expect(ran.sort()).toEqual(["Held", "Other"]);
    expect(observed.failure).toBe(undefined);
    expect(observed.rendered).toContain("held");
    expect(observed.rendered).toContain("other");
    // And the lent request was still its own element's to spend.
    const theirs = observed.watched.requests.find((one) => one.expansion.name === "Held");
    const phases = observed.watched.seen.get(theirs?.expansion.id ?? "") ?? [];
    expect(phases[phases.length - 1]?.phase).toBe("complete");
  });

  it("CX3: a published phase and its explanation cannot be edited by a reader", function* () {
    // R3. One phase object reaches every subscriber and is kept as the latest
    // for whoever registers next, so a reader that could write to it would be
    // rewriting what this element did for everybody else.
    const seen: ComponentExpansionPhase[] = [];
    const observed = yield* watch(
      "<Boom />\n",
      {
        Boom: component("Boom", function* () {
          throw new AggregateError([new Error("one"), new Error("two")], "both failed");
        }),
      },
      function* (request, next, read, owner) {
        read((phase) => {
          seen.push(phase);
          // A reader trying to rewrite the observation it was handed.
          try {
            (phase as { phase: string }).phase = "active";
          } catch {
            // Frozen in strict mode, which is the point.
          }
        });
        yield* next(request);
        // A late reader, registered after the terminal phase was published.
        owner.run(function* () {
          for (const phase of yield* each(request.phases)) {
            expect(phase.phase).not.toBe("active");
            yield* each.next();
          }
        });
      },
    );
    expect(observed.failure).not.toBe(undefined);
    expect(seen.length).toBeGreaterThan(0);
    for (const phase of seen) {
      expect(Object.isFrozen(phase)).toBe(true);
    }
    // The terminal observation is still the one Core published.
    const terminal = seen[seen.length - 1];
    expect(terminal.phase).toBe("complete");
    if (terminal.phase === "complete" && !terminal.result.ok) {
      const report = terminal.result.error;
      expect(Object.isFrozen(report)).toBe(true);
      // An AggregateError's members are an array, and freezing the error does
      // not freeze it: one reader could otherwise rewrite the explanation
      // every other reader is holding.
      if (report instanceof AggregateError) {
        expect(Object.isFrozen(report.errors)).toBe(true);
      }
    }
  });

  it("CX1: delegating the same request twice runs the body once", function* () {
    let ran = 0;
    const { report } = yield* watch(
      "<Hello />",
      {
        Hello: component("Hello", function* () {
          ran += 1;
          return "hi";
        }),
      },
      function* (request, next) {
        yield* next(request);
        yield* next(request);
      },
    );

    expect(ran).toBe(1);
    expect(report).toContain("more than once");
  });

  it("CX3: catching a canonical failure does not rescue it", function* () {
    const { report, watched } = yield* watch(
      "<Boom />",
      {
        Boom: component("Boom", function* () {
          throw new Error("the body said no");
        }),
      },
      function* (request, next) {
        try {
          yield* next(request);
        } catch {
          // Swallowed on purpose. The outcome is not middleware's to decide.
        }
      },
    );

    expect(report).toContain("the body said no");
    const phases = [...watched.seen.values()][0];
    const complete = phases[phases.length - 1];
    expect(complete.phase === "complete" && complete.result.ok).toBe(false);
  });

  it("CX3: durability raised while middleware unwinds outranks the body's failure", function* () {
    const persistence = new DurablePersistenceError("yield", new Error("journal unavailable"));
    const { failure, watched } = yield* watch(
      "<Boom />",
      {
        Boom: component("Boom", function* () {
          throw new Error("the body said no");
        }),
      },
      function* (request, next) {
        try {
          yield* next(request);
        } finally {
          // Raised on the way out, after the body has already failed: both
          // halves of this expansion failed, and only one can be the outcome.
          throw persistence;
        }
      },
    );

    // The durability failure, by identity, so a fail-stop records the object
    // that was thrown. An ordinary body error standing in for it would tell
    // enclosing reconciliation the run is merely incorrect rather than unable
    // to persist.
    expect(durabilityFailure(failure)).toBe(persistence);
    const report = reportedBy(watched);
    expect([report.name, report.message]).toEqual([
      "DurablePersistenceError",
      "Failed to persist durable yield event",
    ]);
    // The selected diagnostic and its explanation, and no part of the failure
    // itself: nothing a reader catches here is the durability failure.
    expect(report.cause instanceof Error && report.cause.message).toBe("journal unavailable");
    expect(report).not.toBe(persistence);
    expect(durabilityFailure(report)).toBe(undefined);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("CX3: a Files fatal raised while middleware unwinds outranks the body's failure", function* () {
    const unavailable = new FilesProviderUnavailableError();
    const { failure, watched } = yield* watch(
      "<Boom />",
      {
        Boom: component("Boom", function* () {
          throw new Error("the body said no");
        }),
      },
      function* (request, next) {
        try {
          yield* next(request);
        } finally {
          throw unavailable;
        }
      },
    );

    expect(filesFatalFailure(failure)).toBe(unavailable);
    const report = reportedBy(watched);
    expect([report.name, report.message]).toEqual([
      "FilesProviderUnavailableError",
      "Files provider is not installed",
    ]);
    // Detached of the fatal branding too: the report carries the diagnostic,
    // not the structural data that makes an infrastructure failure one.
    expect(report).not.toBe(unavailable);
    expect(filesFatalFailure(report)).toBe(undefined);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("CX3: a later ordinary middleware failure does not displace the body's", function* () {
    const { report, failure, watched } = yield* watch(
      "<Boom />",
      {
        Boom: component("Boom", function* () {
          throw new Error("the body said no");
        }),
      },
      function* (request, next) {
        try {
          yield* next(request);
        } finally {
          throw new Error("the unwind said no");
        }
      },
    );

    // Neither failure is fatal, so the earlier one stays authoritative:
    // middleware cannot rescue a canonical failure, and it cannot replace one
    // either.
    expect(failure instanceof Error && failure.message).toBe("the body said no");
    expect(report).toContain("the body said no");
    expect(report).not.toContain("the unwind said no");
    expect(reportedBy(watched).message).toBe("the body said no");
  });

  it("CX3: a body that succeeded still fails when middleware's unwind raises", function* () {
    const persistence = new DurablePersistenceError("close", new Error("journal unavailable"));
    const { failure, rendered, watched } = yield* watch(
      "<Hello />",
      {
        Hello: component("Hello", function* () {
          return "hi";
        }),
      },
      function* (request, next) {
        try {
          yield* next(request);
        } finally {
          throw persistence;
        }
      },
    );

    // The control for the two cases above: there is no competition here, and
    // the same failure is the outcome. A body that returned is not an
    // expansion that persisted.
    expect(durabilityFailure(failure)).toBe(persistence);
    expect(rendered).toBe("");
    expect(reportedBy(watched).name).toBe("DurablePersistenceError");
  });

  it("CX3: observing changes neither what rendered nor how it failed", function* () {
    const source = "<Hello />\n\n<Boom />\n";
    const definitions = {
      Hello: component("Hello", function* () {
        return "hi";
      }),
      Boom: component("Boom", function* () {
        throw new Error("the body said no");
      }),
    };
    const unobserved = yield* scoped(function* () {
      const env: EvalEnv = { values: {} };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent([name]) {
            const definition = definitions[name as keyof typeof definitions];
            if (!definition) {
              throw new Error(`no component ${name}`);
            }
            return definition;
          },
        },
        { at: "min" },
      );
      try {
        return renderSegments(yield* expandSegments(scanSegments(source), {}, {}, new Set()));
      } catch (error) {
        return String(error);
      }
    });
    const observed = yield* watch(source, definitions);
    expect(observed.report).toBe(unobserved);
  });

  it("CX2: an import that returned is not an element that finished", function* () {
    // The whole of C2's claim in one shape: the import resolving is not the
    // element settling. While the body is held the element is entered and has
    // no terminal phase at all — a reading that completed it here would say
    // the run was over when its work had not started.
    const holding = withResolvers<void>();
    const started = withResolvers<void>();
    const whileHeld: string[] = [];
    const observed = yield* watch(
      "<Held />\n",
      {
        Held: component("Held", function* () {
          started.resolve();
          yield* holding.operation;
          return "let go";
        }),
      },
      function* (request, next, read, owner) {
        read((phase) => whileHeld.push(phase.phase));
        owner.run(function* () {
          // The body has begun, so the import has already returned.
          yield* started.operation;
          yield* sleep(0);
          holding.resolve();
        });
        yield* next(request);
      },
    );
    expect(observed.rendered.trim()).toBe("let go");
    // Nothing terminal had been published while the body was held.
    const held = whileHeld.slice(0, whileHeld.indexOf("exit"));
    expect(held).toContain("enter");
    expect(held).not.toContain("complete");
    expect(held).not.toContain("cancelled");
    // And the element did finish, once its body did.
    const phases = observed.watched.seen.get(observed.watched.requests[0].expansion.id) ?? [];
    expect(phases[phases.length - 1]?.phase).toBe("complete");
  });

  it("CX2: a printed failure completes the element Ok, and says so in the document", function* () {
    // Two ways a failure is reported as content rather than raised: a return
    // the schema refuses, and a body whose component prints its own errors.
    // Both complete `Ok` — the element did not fail the *run*, it reported a
    // problem as text — and both put the problem in the document.
    //
    // This is the frozen "preserve printed semantic failure", and it is why a
    // reading takes an outcome from the phase and never from the prose: the
    // text here says ERROR and the answer is success, which is exactly the
    // pair a reading that read the words would get backwards.
    const cases: readonly {
      readonly source: string;
      readonly said: string;
      readonly definitions: Record<string, FunctionComponentDefinition>;
    }[] = [
      {
        source: '<Wrong as="n" />\n',
        said: "Return validation failed",
        definitions: {
          Wrong: {
            kind: "function" as const,
            name: "Wrong",
            props: NO_PROPS,
            returns: { type: "number" },
            // deno-lint-ignore require-yield
            *fn() {
              return "not a number";
            },
          },
        },
      },
      {
        source: "<Shown />\n",
        said: "printed, not thrown",
        definitions: {
          Shown: {
            kind: "function" as const,
            name: "Shown",
            props: NO_PROPS,
            fn: printErrors(function* () {
              throw new Error("printed, not thrown");
            }),
          },
        },
      },
    ];
    for (const one of cases) {
      const observed = yield* watch(one.source, one.definitions);
      // Nothing propagated out of the document.
      expect([one.said, observed.failure]).toEqual([one.said, undefined]);
      expect(observed.rendered).toContain(one.said);
      const phases = observed.watched.seen.get(observed.watched.requests[0].expansion.id) ?? [];
      const terminal = phases[phases.length - 1];
      expect([one.said, terminal?.phase]).toEqual([one.said, "complete"]);
      expect([one.said, terminal?.phase === "complete" && terminal.result.ok]).toEqual([
        one.said,
        true,
      ]);
      // And it did pass through EXIT on the way, having returned.
      expect([one.said, phases.map((phase) => phase.phase)]).toEqual([
        one.said,
        ["enter", "active", "exit", "complete"],
      ]);
    }
  });

  it("CX2: recovering a child's failure does not fail the parent", function* () {
    const definitions = {
      Boom: component("Boom", function* () {
        throw new Error("the child said no");
      }),
    };
    const outcome = (
      observed: { readonly watched: Watched },
      name: string,
    ): boolean | undefined => {
      const request = observed.watched.requests.find((one) => one.expansion.name === name);
      const phases = observed.watched.seen.get(request?.expansion.id ?? "") ?? [];
      const terminal = phases[phases.length - 1];
      return terminal?.phase === "complete" ? terminal.result.ok : undefined;
    };

    // Recovered: the region continues past the child's failure, so the parent
    // that encloses it returned and completes Ok.
    const recovered = yield* watch(
      "<If condition={true}>\n<PrintErrors>\n<Boom />\n</PrintErrors>\n</If>\n",
      definitions,
    );
    expect(recovered.failure).toBe(undefined);
    expect(recovered.rendered).toContain("the child said no");
    expect(outcome(recovered, "If")).toBe(true);

    // The control, in the same case: with nothing recovering it, the same
    // child failure does reach the same parent. Without this the assertion
    // above would pass for a parent that can never fail.
    const unrecovered = yield* watch("<If condition={true}>\n<Boom />\n</If>\n", definitions);
    expect(unrecovered.failure).not.toBe(undefined);
    expect(outcome(unrecovered, "If")).toBe(false);
  });

  it("CX2: COMPLETE follows the whole dispatch, so a handler cannot be its reader", function* () {
    // The frozen ordering, stated as the thing it decides. A subscription
    // spawned on the handler's own frame is torn down when that frame unwinds
    // — which happens *before* completion is published, because completion
    // waits for the whole dispatch, this handler's own cleanup included. One
    // on an owner that outlives the dispatch is told.
    //
    // Asserted as the difference between the two readers rather than as a
    // timestamp: both read the same stream, and only the placement differs.
    const onFrame: string[] = [];
    const onOwner: string[] = [];
    const observed = yield* watch(
      "<Plain />\n",
      {
        Plain: component("Plain", function* () {
          return "done";
        }),
      },
      function* (request, next, _read, owner) {
        // This frame's own reader.
        yield* spawn(function* () {
          for (const phase of yield* each(request.phases)) {
            onFrame.push(phase.phase);
            yield* each.next();
          }
        });
        // A reader that outlives the dispatch.
        owner.run(function* () {
          for (const phase of yield* each(request.phases)) {
            onOwner.push(phase.phase);
            yield* each.next();
          }
        });
        yield* next(request);
      },
    );
    expect(observed.rendered.trim()).toBe("done");
    expect(onOwner).toContain("complete");
    expect(onFrame).not.toContain("complete");
    // The frame's reader did run — this is a reader that died, not one that
    // never started.
    expect(onFrame).toContain("enter");
  });

  it("CX3: an observed run writes the same Journal bytes as an unobserved one", function* () {
    // The strongest statement of inertness this tier can make: not that the
    // screen agreed, but that the record did. A run watched through the public
    // chain must serialize byte for byte as the same run watched by nobody —
    // otherwise observation is a participant in what the execution durably
    // said, however carefully it declines to be one everywhere else.
    const source = [
      '<Evaluate as="kept">1 + 1</Evaluate>',
      "",
      "<Hello />",
      "",
      "<Boom />",
      "",
    ].join("\n");
    const definitions = {
      Hello: component("Hello", function* () {
        return "hi";
      }),
      Boom: component("Boom", function* () {
        throw new Error("the body said no");
      }),
    };
    const journal = function* (observe: boolean): Operation<string> {
      const written: string[] = [];
      const run = yield* scoped(function* () {
        const env: EvalEnv = { values: {} };
        yield* Component.around({ env: () => env }, { at: "min" });
        yield* Component.around(
          {
            // deno-lint-ignore require-yield
            *importComponent([name]) {
              const definition = definitions[name as keyof typeof definitions];
              if (!definition) {
                throw new Error(`no component ${name}`);
              }
              return definition;
            },
          },
          { at: "min" },
        );
        // What this run durably said, in the order it said it: every element
        // the public chain carried, with the identity and position the record
        // would have been written under.
        yield* Component.around({
          *expand([request], next) {
            written.push(
              JSON.stringify({
                id: request.expansion.id,
                name: request.expansion.name,
                position: request.expansion.position ?? null,
              }),
            );
            if (!observe) {
              yield* next(request);
              return;
            }
            const owner: Scope = yield* useScope();
            owner.run(function* () {
              for (const _ of yield* each(request.phases)) {
                yield* each.next();
              }
            });
            yield* next(request);
          },
        });
        try {
          return renderSegments(yield* expandSegments(scanSegments(source), {}, {}, new Set()));
        } catch (error) {
          return String(error);
        }
      });
      yield* sleep(0);
      return JSON.stringify({ run, written });
    };
    expect(yield* journal(true)).toBe(yield* journal(false));
  });

  it("CX4: a reader that never finishes reading delays nothing", function* () {
    // A subscriber that takes its first phase and then stops asking. The
    // execution must not be waiting on it: the element completes, the document
    // renders, and the reader is simply behind.
    let taken = 0;
    const observed = yield* watch(
      "<Slow />\n",
      {
        Slow: component("Slow", function* () {
          return "done";
        }),
      },
      function* (request, next, read, owner) {
        read(() => {});
        owner.run(function* () {
          // One phase, then never `each.next()` again.
          for (const _ of yield* each(request.phases)) {
            taken += 1;
            yield* sleep(50_000);
            yield* each.next();
          }
        });
        yield* next(request);
      },
    );
    expect(observed.rendered.trim()).toBe("done");
    expect(observed.failure).toBe(undefined);
    // It really did start reading, so this is a slow reader rather than none.
    expect(taken).toBe(1);
    // And the element finished regardless, which is what the whole sequence a
    // *working* reader saw shows.
    const phases = observed.watched.seen.get(observed.watched.requests[0].expansion.id) ?? [];
    expect(phases[phases.length - 1]?.phase).toBe("complete");
  });

  it("CX4: a reader whose scope is cancelled cancels nothing", function* () {
    // The reader is torn down while the element is still expanding. Nothing
    // about the execution may notice: it renders, it completes, and the
    // registration that went away leaves no gap behind it.
    const observed = yield* watch(
      "<Steady />\n",
      {
        Steady: component("Steady", function* () {
          return "steady";
        }),
      },
      function* (request, next, _read, owner) {
        const reader = owner.run(function* () {
          for (const _ of yield* each(request.phases)) {
            yield* each.next();
          }
        });
        yield* reader.halt();
        yield* next(request);
      },
    );
    expect(observed.rendered.trim()).toBe("steady");
    expect(observed.failure).toBe(undefined);
    const phases = observed.watched.seen.get(observed.watched.requests[0].expansion.id) ?? [];
    expect(phases.map((one) => one.phase)).toContain("complete");
  });

  it("CX1: structural work crosses the seam once, and only where it runs", function* () {
    const source = [
      '<Switch value={"b"}>',
      '<Case value={"a"}><Hello /></Case>',
      '<Case value={"b"}><Hello /></Case>',
      "</Switch>",
      "",
      "<If condition={false}>skipped<Else><Hello /></Else></If>",
      "",
      "<All><Spawn><Hello /></Spawn><Spawn><Hello /></Spawn></All>",
      "",
    ].join("\n");
    const { watched, failure } = yield* watch(source, {
      Hello: component("Hello", function* () {
        return "hi";
      }),
    });
    expect(failure).toBe(undefined);

    const counted = new Map<string, number>();
    for (const [, phases] of watched.seen) {
      const name = watched.requests.find(
        (request) => watched.seen.get(request.expansion.id) === phases,
      )?.expansion.name;
      counted.set(name ?? "?", (counted.get(name ?? "?") ?? 0) + 1);
    }

    // Every construct that actually consumed a region is surrounded once, and
    // each real sibling of the `<All>` is its own element.
    expect(counted.get("Switch")).toBe(1);
    expect(counted.get("If")).toBe(1);
    expect(counted.get("All")).toBe(1);
    expect(counted.get("Spawn")).toBe(2);
    // One `<Case>` was chosen; the other expanded nothing and is told nothing.
    expect(counted.get("Case")).toBe(1);
    // The `<Else>` ran, so it is an element; `skipped` is the arm that did not.
    expect(counted.get("Else")).toBe(1);
    // Four `<Hello />` bodies: one per selected region.
    expect(counted.get("Hello")).toBe(4);

    // Every element that ran reached a terminal observation, exactly one.
    for (const [, phases] of watched.seen) {
      const terminals = phases.filter(
        (one) => one.phase === "complete" || one.phase === "cancelled",
      );
      expect(terminals.length).toBe(1);
    }
  });

  it("CX1: an unselected branch and passive syntax are told nothing", function* () {
    const source =
      '<Switch value={"a"}>\n<Case value={"a"}>taken</Case>\n' +
      '<Case value={"z"}><Boom /></Case>\n</Switch>\n';
    const { watched, failure } = yield* watch(source, {
      Boom: component("Boom", function* () {
        throw new Error("the branch that was not chosen ran");
      }),
    });

    expect(failure).toBe(undefined);
    const names = watched.requests.map((one) => one.expansion.name).sort();
    // The chosen Case, and the Switch around it. The unchosen Case never
    // expanded, so neither it nor the component inside it was ever an element.
    expect(names).toEqual(["Case", "Switch"]);
  });

  it("CX2: a body that has returned stays in EXIT while its cleanup runs", function* () {
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const observedDuringCleanup: string[] = [];
    const { rendered } = yield* watch(
      "<Held />",
      {
        Held: component("Held", function* () {
          // Registered before anything is acquired, and held open after the
          // body returns: this is the stretch EXIT exists to describe.
          yield* ensure(function* () {
            entered.resolve();
            yield* release.operation;
          });
          return "held";
        }),
      },
      function* (request, next, read, owner) {
        owner.run(function* () {
          yield* entered.operation;
          // The body has returned and its destructor is standing.
          read((phase) => observedDuringCleanup.push(phase.phase));
          release.resolve();
        });
        yield* next(request);
      },
    );

    expect(rendered).toBe("held");
    // Where the element was while its cleanup ran, and only then completed.
    expect(observedDuringCleanup[0]).toBe("exit");
    expect(observedDuringCleanup[observedDuringCleanup.length - 1]).toBe("complete");
  });

  it("CX2: cleanup that fails completes the element with a failure", function* () {
    const { watched, report } = yield* watch("<Leaky />", {
      Leaky: component("Leaky", function* () {
        yield* ensure(function* () {
          throw new Error("the destructor said no");
        });
        return "body was fine";
      }),
    });

    const phases = [...watched.seen.values()][0];
    const exit = phases.find((one) => one.phase === "exit");
    // The body itself returned; the failure belongs to the teardown after it.
    expect(exit?.phase === "exit" && exit.reason).toBe("returned");
    const complete = phases[phases.length - 1];
    expect(complete.phase === "complete" && complete.result.ok).toBe(false);
    expect(report).toContain("the destructor said no");
  });

  it("CX4: a late subscriber is told where it is, without earlier replay", function* () {
    const started = withResolvers<void>();
    const release = withResolvers<void>();
    const arrived: string[] = [];
    const { rendered } = yield* watch(
      "<Held />",
      {
        Held: component("Held", function* () {
          started.resolve();
          yield* release.operation;
          return "held";
        }),
      },
      function* (request, next, read, owner) {
        // Arrives while the element is mid-flight, from an owner that outlives
        // the dispatch, and is told where the element is rather than walked
        // through the two phases it missed.
        owner.run(function* () {
          yield* started.operation;
          read((phase) => arrived.push(phase.phase));
          release.resolve();
        });
        yield* next(request);
      },
    );

    expect(rendered).toBe("held");
    expect(arrived[0]).toBe("active");
    expect(arrived).not.toContain("enter");
    expect(arrived[arrived.length - 1]).toBe("complete");
  });
});
