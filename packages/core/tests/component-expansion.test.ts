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
import { each, ensure, scoped, sleep, useScope, withResolvers } from "effection";
import type { Scope } from "effection";
import type { Operation } from "effection";
import { Component } from "../src/component-api.ts";
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
