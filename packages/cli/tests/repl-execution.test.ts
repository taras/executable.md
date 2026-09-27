/**
 * Running and reconstructing one entry (#848 P1, X1, X2).
 *
 * Everything here drives the real reference document through real core
 * execution over a real `DurableStream`. Nothing stubs the engine: replay is
 * ordinary replay, the provider is installed at the same seam a host installs
 * one at, and what a cold session reaches it reaches by re-running the document
 * against the history the previous one wrote.
 *
 * The negative controls are the point of most of them. A divergent history must
 * refuse *atomically* — no appended record, no provider call, no session handed
 * back — and a paused expansion must release each held continuation exactly
 * once and never after its owner is gone.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempFileCompiler } from "@executablemd/core";
import { InMemoryStream, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { ensure, race, scoped, sleep, spawn, until } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { randomUUID } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ordinaryEvaluationProfile } from "../src/evaluation-profile.ts";
import {
  COMPONENT_BOUNDARIES,
  EXECUTION_BOUNDARIES,
  HOST_WALK,
  OUTPUT_BOUNDARIES,
} from "../src/repl/expansion.ts";
import type { BoundaryPartition } from "../src/repl/expansion.ts";
import { ReplHost } from "../src/repl/host.ts";
import {
  createExecutionFile,
  openExecutionFile,
  readRecords,
  replRepository,
} from "../src/repl/journal.ts";
import type { ReplExecution } from "../src/repl/journal.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ExpansionController } from "../src/repl/expansion.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplQuestion } from "../src/repl/elicitation.ts";
import { Component, DocumentOutput, Elicitation, Execution } from "@executablemd/core";
import {
  REFERENCE_DIRECTORY,
  referenceEvents,
  referenceSource,
} from "./fixtures/repl/reference.ts";

const INSTALLATIONS = [{ evaluation: ordinaryEvaluationProfile() }];

/**
 * A Node-backed host, installed by the test rather than by the kernel.
 *
 * This is the half a runtime entrypoint owns in Slice D: exclusive creation and
 * append, the two operations `@effectionx/fs` does not offer. It lives here so
 * the kernel under test contains no runtime choice of its own, and so the same
 * corpus runs under Deno, Node and Bun against one implementation.
 */
function useNodeReplHost(name: string): Operation<void> {
  return ReplHost.around(
    {
      // deno-lint-ignore require-yield
      *identify(): Operation<string> {
        return name;
      },
      *createExclusive([path]: [string]): Operation<void> {
        const handle = yield* until(open(path, "wx"));
        yield* until(handle.close());
      },
      *appendRecord([path, record]: [string, string]): Operation<void> {
        yield* until(appendFile(path, record));
      },
    },
    { at: "min" },
  );
}

/** What a run really performed, as opposed to what it restored. */
interface Performed {
  /** Component sources actually read from disk. */
  reads: string[];
  /** Eval blocks actually compiled, which is where a block really runs. */
  compiles: number;
}

/**
 * Count the work a run performs, at the seams where performing it happens.
 *
 * Not at the durable operations: replay enters those and hands back what was
 * recorded, so counting them would count restoration as work. A component's
 * source is read inside the recorded selection, and an eval block is compiled
 * inside the recorded evaluation — so these two counts are zero for anything
 * replay restored, whatever else the run did around it.
 */
function* countAsked(): Operation<{ calls: number }> {
  const counter = { calls: 0 };
  // Outermost, so it sees every elicitation the session's own provider — which
  // installs innermost, at `min` — would be asked to answer.
  yield* Elicitation.around({
    *elicit([request], next) {
      counter.calls++;
      return yield* next(request);
    },
  });
  return counter;
}

function* countPerformed(): Operation<Performed> {
  const performed: Performed = { reads: [], compiles: 0 };
  yield* API.Fs.around({
    *readTextFile([path], next) {
      performed.reads.push(path);
      return yield* next(path);
    },
  });
  yield* API.Env.around({
    *compile([source, options], next) {
      performed.compiles++;
      return yield* next(source, options);
    },
  });
  return performed;
}

function execution(events: readonly DurableEvent[] = []): ReplExecution {
  return { id: "kf39sla2", stream: new InMemoryStream([...events]) };
}

function options(execution: ReplExecution) {
  return { execution, includes: [REFERENCE_DIRECTORY], installations: INSTALLATIONS };
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * This session's Continue capability, or a failure saying it has none.
 *
 * A session that is not expanding offers no controller at all, so a test that
 * wants to pause has to say it expects one rather than calling through a
 * disabled copy.
 */
function controlling(session: ReplSession): ExpansionController {
  const controller = session.controller;
  if (controller === undefined) {
    throw new Error("this session owns no live expansion to control");
  }
  return controller;
}

function refusal(result: Result<ReplSession>): Error {
  if (result.ok) {
    throw new Error("this history was reconstructed, and it must be refused");
  }
  return result.error;
}

/**
 * The question this session is waiting on.
 *
 * Subscribed before the pending one is read, because a signal delivers from
 * subscription time: checking first and subscribing after would lose a question
 * that arrived in between and wait forever for the next one.
 */
function* nextQuestion(session: ReplSession): Operation<ReplQuestion> {
  const changes = yield* session.elicitation.changes;
  if (session.elicitation.pending !== undefined) {
    return session.elicitation.pending;
  }
  let next = yield* changes.next();
  while (!next.done) {
    if (next.value !== undefined) {
      return next.value;
    }
    next = yield* changes.next();
  }
  throw new Error("this execution asked nothing");
}

/** Wait until expansion reports paused, or until nothing is running any more. */
function* pausedOrDone(session: ReplSession): Operation<void> {
  const states = yield* session.expansion.states;
  while (session.live && session.expansion.state !== "paused") {
    if (session.elicitation.pending !== undefined) {
      // A walk suspended on a question is not held: pause takes effect at the
      // walk's next boundary, which it only reaches once the question is over.
      session.elicitation.pending.answer("approve");
    }
    const next = yield* race([
      states.next(),
      (function* () {
        yield* sleep(5);
        return { done: false, value: session.expansion.state };
      })(),
    ]);
    if (next.done === true) {
      return;
    }
  }
}

/** The recorded events of one kind, for a "this did not happen twice" count. */
function counted(events: readonly DurableEvent[], type: string): number {
  return events.filter((event) => event.type === "yield" && event.description.type === type).length;
}

function* readAll(holder: ReplExecution): Operation<DurableEvent[]> {
  return yield* holder.stream.readAll();
}

describe("REPL execution: submitting one entry", () => {
  beforeAll(() => useTempFileCompiler());

  it("X1: admits the exact source, binds, generates, asks, and settles", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));

    const question = yield* nextQuestion(session);
    expect(question.message).toContain("Approve Ship the REPL?");
    expect(question.form).toEqual({ field: "decision", choices: ["approve", "decline"] });
    expect(session.model.entry?.elicitations).toEqual([]);

    expect(question.answer("approve")).toBe(true);
    yield* session.join();

    const entry = session.model.entry;
    if (entry === undefined) {
      throw new Error("the entry was admitted");
    }
    expect(entry.source).toBe(source);
    expect(entry.bindings.map((binding) => binding.name)).toContain("plan");
    expect(entry.scopes.map((scope) => scope.key)).toEqual(["Checklist-1", "generated-1"]);
    expect(entry.elicitations[0].answer).toEqual({ decision: "approve" });
    expect(session.model.settled).toBe(true);
    expect(session.model.terminal?.output).toContain("Decision: approve");
    expect(session.overlay.output).toBe(session.model.terminal?.output);
  });

  it("X1: the overlay reports its output as the document prints it", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));

    // Output is the one thing in the overlay that no record describes: a
    // document that prints and nothing else reprojects nothing, so a reader
    // watching the history would never learn that the overlay had moved.
    const reported: string[] = [];
    yield* spawn(function* (): Operation<void> {
      const outputs = yield* session.outputs;
      let next = yield* outputs.next();
      while (!next.done) {
        reported.push(next.value);
        next = yield* outputs.next();
      }
    });

    const question = yield* nextQuestion(session);

    // Reported while the run is still holding at its question, rather than
    // collected and handed over once it finished.
    expect(reported.length).toBeGreaterThan(0);
    const latest = reported[reported.length - 1];
    expect(latest).toContain("About to evaluate:");
    // What it reported is what the overlay holds: the same text, not a chunk
    // the reader would have to accumulate itself.
    expect(latest).toBe(session.overlay.output);
    expect(session.model.terminal).toBe(undefined);

    question.answer("approve");
    yield* session.join();
  });

  it("X1: the generated fragment is shown before it is admitted, and follows the binding", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));
    (yield* nextQuestion(session)).answer("decline");
    yield* session.join();

    const generated = session.model.entry?.generated[0];
    const fragment = session.model.entry?.scopes.find((scope) => scope.kind === "generated");
    expect(generated?.decision).toBe("admitted");
    // The value the durable evaluation published is what the fragment says,
    // which is what makes it deterministic rather than merely repeatable.
    expect(fragment?.source).toBe('<Json value={{"title":"Ship the REPL","steps":2}} />');
    expect(session.model.terminal?.output).toContain("Decision: decline");
  });

  it("X1: shows the generated source before admitting it, then admits and evaluates it", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));
    const fragment = '<Json value={{"title":"Ship the REPL","steps":2}} />';

    // Stepped rather than inspected at the end: a terminal model shows that
    // both things happened and says nothing about which came first. Pausing at
    // each boundary is what lets the order itself be observed.
    controlling(session).pause();
    let shownBeforeAdmission = false;
    let admitted = false;
    for (let step = 0; step < 500 && session.live && !admitted; step++) {
      yield* pausedOrDone(session);
      if (!session.live) {
        break;
      }
      admitted = counted(yield* readAll(holder), "generated_xmd") > 0;
      if (!admitted && session.overlay.output.includes(fragment)) {
        shownBeforeAdmission = true;
      }
      controlling(session).resume();
      controlling(session).pause();
    }

    expect(shownBeforeAdmission).toBe(true);
    expect(admitted).toBe(true);

    controlling(session).resume();
    (yield* nextQuestion(session)).answer("approve");
    yield* session.join();

    // The admitted fragment then ran where it was written: its rendering
    // follows the source it was rendered from.
    const settled = session.model.terminal?.output ?? "";
    expect(settled.indexOf(fragment)).toBeGreaterThan(-1);
    expect(settled.indexOf('"title": "Ship the REPL"')).toBeGreaterThan(settled.indexOf(fragment));
  });

  it("X1: an entry this environment cannot run leaves the history empty", function* () {
    const holder = execution();
    const refused = refusal(
      yield* submitReplEntry({
        ...options(holder),
        source: "<Missing title={1} />\n",
      }),
    );

    expect(refused.name).toBe("ReplPreflightError");
    expect(yield* holder.stream.readAll()).toEqual([]);
  });

  it("X1: a choice the form does not offer answers nothing and leaves the question open", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));

    const question = yield* nextQuestion(session);
    expect(question.answer("maybe")).toBe(false);
    yield* sleep(10);

    // An incomplete interaction, not a rejected answer. The provider never
    // returned, so there is nothing for core to judge and nothing to record.
    // The other case — a provider that really hands back a value the schema
    // rejects — settles the durable operation `err` with no answer, and E1
    // proves that in `packages/core/tests/elicit-component.test.ts`. This case
    // does not prove that one.
    expect(session.elicitation.pending).toBe(question);
    expect(counted(yield* readAll(holder), "elicit")).toBe(0);
    expect(session.model.settled).toBe(false);

    question.answer("approve");
    yield* session.join();
    expect(counted(yield* readAll(holder), "elicit")).toBe(1);
  });

  it("X1: a second entry is refused against an execution that has one", function* () {
    const holder = execution(yield* referenceEvents());
    const refused = refusal(
      yield* submitReplEntry({ ...options(holder), source: "another entry\n" }),
    );

    expect(refused.message).toContain("already admitted its entry");
  });
});

describe("REPL execution: reopening one history", () => {
  beforeAll(() => useTempFileCompiler());

  it("X2: replays what was recorded and goes live at the first unrecorded step", function* () {
    const settled = yield* referenceEvents();
    const at = settled.findIndex(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );
    const holder = execution(settled.slice(0, at));
    const performed = yield* countPerformed();
    const session = opened(yield* openReplSession(options(holder)));

    (yield* nextQuestion(session)).answer("approve");
    yield* session.join();

    const events = yield* readAll(holder);
    // Each completed effect stayed completed: replay restored it rather than
    // performing it again.
    expect(counted(events, "eval")).toBe(1);
    expect(counted(events, "import_component")).toBe(4);

    // Counted where the work happens rather than where the record is: the
    // component's source was never read again and the evaluation was never
    // compiled again, which is what "restored" has to mean.
    expect(performed.reads.filter((path) => path.endsWith("Checklist.md"))).toEqual([]);
    expect(performed.compiles).toBe(0);
    expect(session.elicitation.asked).toBe(1);

    // And the restored values are what the rest of the run was built from.
    expect(session.model.terminal?.output).toContain("2 steps remain.");
    expect(session.model.terminal?.output).toContain('"title": "Ship the REPL"');
    expect(session.model.terminal?.output).toContain("Decision: approve");
  });

  it("X2: the same counters do register the work a first run really performs", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const performed = yield* countPerformed();
    const asked = yield* countAsked();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));

    (yield* nextQuestion(session)).answer("approve");
    yield* session.join();

    // The positive control for every count the negatives rely on. Without it, a
    // counter that never increments for any reason at all would read as proof
    // of replay, or of a provider that was never reached.
    expect(performed.reads.filter((path) => path.endsWith("Checklist.md")).length).toBeGreaterThan(
      0,
    );
    expect(performed.compiles).toBeGreaterThan(0);
    expect(asked.calls).toBe(1);
    expect(session.elicitation.asked).toBe(1);
  });

  it("X2: a recorded answer is restored without the provider being reached", function* () {
    const settled = yield* referenceEvents();
    const holder = execution(
      settled.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
    );
    const session = opened(yield* openReplSession(options(holder)));
    yield* session.join();

    expect(session.elicitation.asked).toBe(0);
    expect(counted(yield* readAll(holder), "elicit")).toBe(1);
    expect(session.model.settled).toBe(true);
    expect(session.model.terminal?.output).toContain("Decision: approve");
  });

  it("X2: a settled history reconstructs the same terminal model and runs nothing", function* () {
    const settled = yield* referenceEvents();
    const holder = execution(settled);
    const session = opened(yield* openReplSession(options(holder)));
    yield* session.join();

    expect(yield* readAll(holder)).toEqual(settled);
    expect(session.elicitation.asked).toBe(0);
    expect(session.model.settled).toBe(true);
    expect(session.model.entry?.elicitations[0].answer).toEqual({ decision: "approve" });
  });

  it("X2: the append observer lives exactly as long as the session", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const settled = yield* referenceEvents();
    let ended: ReplSession | undefined;

    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ ...options(holder), source }));
      expect(holder.stream.onAppend).not.toBe(null);
      (yield* nextQuestion(session)).answer("approve");
      yield* session.join();
      ended = session;
    });
    if (ended === undefined) {
      throw new Error("the session ran");
    }

    // The stream outlives the session watching it — a repository hands the same
    // one to whoever opens the execution next — so the observer has to go when
    // its owner does.
    expect(holder.stream.onAppend).toBe(null);

    const last = ended.model;
    yield* holder.stream.append(settled[settled.length - 1]);

    // A record arriving afterwards reprojects nothing and signals nobody.
    expect(ended.model).toBe(last);
  });

  it("X2: a session clears only the observer it installed", function* () {
    const holder = execution(yield* referenceEvents());
    const foreign = (): void => {};

    yield* scoped(function* () {
      const session = opened(yield* openReplSession(options(holder)));
      yield* session.join();
      // Somebody else takes the slot while this session is still alive.
      holder.stream.onAppend = foreign;
    });

    // Its teardown removes its own callback or nothing at all; the slot is not
    // this session's to clear once it no longer holds it.
    expect(holder.stream.onAppend).toBe(foreign);
  });

  it("X2: a diverging history refuses atomically", function* () {
    const settled = yield* referenceEvents();
    const partial = settled.filter(
      (event) => !(event.type === "close" && event.coroutineId === "root"),
    );

    for (const corruption of ["identity", "result"] as const) {
      const doctored: DurableEvent[] = partial.map((event): DurableEvent => {
        if (event.type !== "yield" || event.description.type !== "eval") {
          return event;
        }
        return corruption === "identity"
          ? { ...event, description: { ...event.description, name: "eval:eval:root:9" } }
          : {
              ...event,
              result: {
                status: "ok" as const,
                value: { value: { plan: { title: "Other", steps: 9 } } },
              },
            };
      });
      const holder = execution(doctored);
      const asked = yield* countAsked();
      const refused = refusal(yield* openReplSession(options(holder)));

      expect(refused.message).toContain("Divergence");
      // Nothing was written, nobody was asked, and nothing was handed back:
      // the refusal is the whole of what happened. The provider count is
      // measured rather than assumed — replay reaches the question only by
      // getting past the record that diverged.
      expect(yield* holder.stream.readAll()).toEqual(doctored);
      expect(asked.calls).toBe(0);

      // The observer went with the session that was never published.
      expect(holder.stream.onAppend).toBe(null);
    }
  });

  it("X2: a refused reconstruction leaves nothing of itself behind", function* () {
    const settled = yield* referenceEvents();
    const holder = execution([settled[0], settled[0], ...settled.slice(1)]);
    const asked = yield* countAsked();

    expect(refusal(yield* openReplSession(options(holder))).message).toContain("a second entry");

    // No observer, so a later append cannot reproject into a session nobody
    // was given, and nothing it started is still running.
    expect(holder.stream.onAppend).toBe(null);
    expect(asked.calls).toBe(0);
    const before = (yield* readAll(holder)).length;
    yield* holder.stream.append(settled[settled.length - 1]);
    expect((yield* readAll(holder)).length).toBe(before + 1);
  });

  it("X2: a history this version cannot project refuses before anything runs", function* () {
    const settled = yield* referenceEvents();
    const holder = execution([settled[0], settled[0], ...settled.slice(1)]);

    expect(refusal(yield* openReplSession(options(holder))).message).toContain("a second entry");
    expect((yield* holder.stream.readAll()).length).toBe(settled.length + 1);
  });
});

describe("REPL execution: pausing expansion", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1: stops at every boundary it crosses and continues past each one", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));

    // Held for the length of the test. The session stops *offering* the
    // capability once nothing is expanding, which is what the cold control
    // below is about; the controller this run owned is still the thing that
    // released its holds.
    const controller = controlling(session);
    controller.pause();
    let stops = 0;
    while (session.live && stops < 500) {
      yield* pausedOrDone(session);
      if (!session.live) {
        break;
      }
      expect(session.expansion.state).toBe("paused");
      stops++;
      controller.resume();
      // Re-armed in the same turn as the release, so the continuation this
      // released stops at the next boundary rather than running to the end.
      controller.pause();
    }
    controller.resume();
    yield* session.join();

    expect(stops).toBeGreaterThan(5);
    expect(controller.released).toBe(stops);
    expect(session.model.settled).toBe(true);
    expect(session.model.terminal?.output).toContain("Decision: approve");
  });

  it("P1: the Journal advances after pause is requested and before it takes effect", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));
    const controller = controlling(session);

    // A question is work that has already started: the walk is suspended
    // inside the provider, not held by the controller, so requesting a pause
    // here cannot take effect until that operation finishes.
    const question = yield* nextQuestion(session);
    const before = (yield* readAll(holder)).length;

    controller.pause();
    expect(session.expansion.state).toBe("pausing");

    // Answering lets the already-started operation settle. Its record reaches
    // the Journal while the pause request is outstanding, which is the whole
    // point: the expansion position and the Journal head are two positions.
    question.answer("approve");
    yield* pausedOrDone(session);

    const atPause = (yield* readAll(holder)).length;
    expect(session.expansion.state).toBe("paused");
    expect(atPause).toBeGreaterThan(before);

    // And once every walk is satisfied it goes no farther on its own.
    yield* sleep(25);
    expect((yield* readAll(holder)).length).toBe(atPause);
    expect(session.expansion.state).toBe("paused");

    // Only Continue moves it, and then it finishes.
    controller.resume();
    yield* session.join();
    expect(session.model.settled).toBe(true);
    expect((yield* readAll(holder)).length).toBeGreaterThan(atPause);
  });

  it("P1: continuing twice releases nothing the second time", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));

    controlling(session).pause();
    yield* pausedOrDone(session);
    const held = controlling(session).released;
    controlling(session).resume();
    const afterFirst = controlling(session).released;
    controlling(session).resume();

    expect(afterFirst).toBeGreaterThan(held);
    expect(controlling(session).released).toBe(afterFirst);

    (yield* nextQuestion(session)).answer("approve");
    yield* session.join();
  });

  it("P1: a paused expansion is stopped, not cancelled, and the run is still there", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));

    controlling(session).pause();
    yield* pausedOrDone(session);
    const frozen = (yield* readAll(holder)).length;
    yield* sleep(25);

    expect(session.expansion.state).toBe("paused");
    expect(session.live).toBe(true);
    expect((yield* readAll(holder)).length).toBe(frozen);

    controlling(session).resume();
    (yield* nextQuestion(session)).answer("approve");
    yield* session.join();
    expect(session.model.settled).toBe(true);
  });

  it("P1: tearing the owner down releases nothing that was held", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    let released = -1;
    let held = -1;

    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ ...options(holder), source }));
      controlling(session).pause();
      yield* pausedOrDone(session);
      expect(session.expansion.state).toBe("paused");
      released = controlling(session).released;
      held = (yield* readAll(holder)).length;
    });

    // The scope is gone: every hold unwound through its own discard, so nothing
    // was resumed on the way out and the history stopped where it was held.
    expect(released).toBe(0);
    expect((yield* readAll(holder)).length).toBe(held);
  });

  it("P1: a reconstructed session offers no Continue at all", function* () {
    const holder = execution(yield* referenceEvents());
    const session = opened(yield* openReplSession(options(holder)));
    yield* session.join();

    // Absence, not a release count of zero. A settled history was restored
    // whole: there is no held continuation anywhere for Continue to release,
    // so the session offers no such action rather than one that does nothing.
    expect(session.controller).toBe(undefined);
    expect(session.live).toBe(false);
    // What a view still needs — what expansion is doing — stays readable.
    expect(session.expansion.state).toBe("playing");
  });

  it("P1: an execution with no entry yet offers no Continue either", function* () {
    const holder = execution();
    const session = opened(yield* openReplSession(options(holder)));

    expect(session.controller).toBe(undefined);
    expect(session.model.entry).toBe(undefined);
    expect(session.expansion.state).toBe("playing");
  });
});

describe("REPL execution: the boundary inventory", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1: every member of every wrapped Api is a walk, a gate, or declared not to be one", function* () {
    const partitioned = (partition: BoundaryPartition): string[] =>
      [...partition.walks, ...partition.gates, ...partition.unheld].sort();

    expect(partitioned(COMPONENT_BOUNDARIES)).toEqual(Object.keys(Component.operations).sort());
    expect(partitioned(EXECUTION_BOUNDARIES)).toEqual(Object.keys(Execution.operations).sort());
    expect(partitioned(OUTPUT_BOUNDARIES)).toEqual(Object.keys(DocumentOutput.operations).sort());
  });

  it("P1: the reference entry crosses the boundaries this controller accounts for", function* () {
    const holder = execution();
    const source = yield* referenceSource();
    const session = opened(yield* submitReplEntry({ ...options(holder), source }));
    // The controller, not a snapshot of its crossings: `crossings` answers
    // with what has been crossed *so far*, and so far is nothing yet.
    const controller = controlling(session);
    (yield* nextQuestion(session)).answer("approve");
    yield* session.join();
    const crossings = controller.crossings;

    const controlled = [
      ...COMPONENT_BOUNDARIES.walks,
      ...COMPONENT_BOUNDARIES.gates,
      ...EXECUTION_BOUNDARIES.walks,
      ...OUTPUT_BOUNDARIES.gates,
      HOST_WALK,
    ];
    const crossed = [...crossings.keys()].sort();
    for (const boundary of crossed) {
      expect(controlled).toContain(boundary);
    }
    // The ones this document is written to reach. A boundary disappearing
    // from it is what this list is here to notice.
    expect(crossed).toContain("document");
    expect(crossed).toContain("importComponent");
    expect(crossed).toContain("applyModifiers");
    expect(crossed).toContain("output");
    expect(crossings.get("document")).toBe(1);
  });
});

describe("REPL execution: one execution's file", () => {
  beforeAll(() => useTempFileCompiler());

  function* useDirectory(): Operation<string> {
    const root = join(tmpdir(), `xmd-repl-${randomUUID()}`);
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    return root;
  }

  function* raised(body: () => Operation<unknown>): Operation<Error> {
    try {
      yield* body();
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    throw new Error("this was accepted, and it must be refused");
  }

  it("X2: writes each record before acknowledging it, and reads them all back", function* () {
    yield* useNodeReplHost("kf39sla2");
    const root = yield* useDirectory();
    const created = yield* createExecutionFile(root, "kf39sla2");
    const announced: DurableEvent[] = [];
    created.stream.onAppend = (event) => announced.push(event);

    const events = yield* referenceEvents();
    for (const event of events) {
      yield* created.stream.append(event);
    }

    expect(announced).toEqual(events);
    // Read from the file rather than from what the writer remembers: the
    // acknowledgement claims the record reached the file, so that is what is
    // checked.
    expect(yield* readRecords(join(root, "kf39sla2.jsonl"))).toEqual(events);

    const reopened = yield* openExecutionFile(root, "kf39sla2");
    expect(yield* reopened.stream.readAll()).toEqual(events);
  });

  it("X2: creating an execution that already exists is refused, not joined", function* () {
    yield* useNodeReplHost("kf39sla2");
    const root = yield* useDirectory();
    yield* createExecutionFile(root, "kf39sla2");

    const refused = yield* raised(() => createExecutionFile(root, "kf39sla2"));
    expect(refused.message).toContain("already has a history");
  });

  it("X2: refuses a history it cannot read, without quoting what it holds", function* () {
    const root = yield* useDirectory();
    yield* ensureDir(root);
    const events = yield* referenceEvents();
    const records = events.map((event) => serializeDurableEvent(event)).join("");

    yield* writeTextFile(join(root, "damaged.jsonl"), `${records}{"type":"wat"}\n`);
    const malformed = yield* raised(() => openExecutionFile(root, "damaged"));
    expect(malformed.message).toContain("cannot read");
    expect(malformed.message).not.toContain("wat");

    yield* writeTextFile(join(root, "partial.jsonl"), records.slice(0, -20));
    expect((yield* raised(() => openExecutionFile(root, "partial"))).message).toContain(
      "never finished writing",
    );

    yield* ensureDir(join(root, "directory.jsonl"));
    expect((yield* raised(() => openExecutionFile(root, "directory"))).message).toContain(
      "not a file",
    );

    expect((yield* raised(() => openExecutionFile(root, "absent"))).message).toContain(
      "no history here",
    );
  });

  it("X2: an identifier that could address another directory never becomes a path", function* () {
    const root = yield* useDirectory();

    for (const named of ["../escape", ".hidden", "a/b", ""]) {
      expect((yield* raised(() => openExecutionFile(root, named))).message).toContain(
        "opaque identifier",
      );
      expect((yield* raised(() => createExecutionFile(root, named))).message).toContain(
        "opaque identifier",
      );
    }
  });

  it("X2: the kernel reaches the installed host, and refuses when none is installed", function* () {
    const root = yield* useDirectory();
    const uninstalled = replRepository(root);

    // Nothing in `repl/` chooses a runtime, so with no host installed the
    // kernel cannot create a file at all — which is what that boundary being
    // real looks like from the outside.
    expect((yield* raised(() => uninstalled.create())).name).toBe("ReplHostError");

    yield* useNodeReplHost("kf39sla2");
    const repository = replRepository(root);
    const created = yield* repository.create();
    expect(created.id).toBe("kf39sla2");

    yield* created.stream.append((yield* referenceEvents())[0]);
    const reopened = yield* repository.open("kf39sla2");
    expect((yield* reopened.stream.readAll()).length).toBe(1);
  });

  it("X2: an empty file is an execution with no history rather than a refusal", function* () {
    yield* useNodeReplHost("kf39sla2");
    const root = yield* useDirectory();
    yield* createExecutionFile(root, "kf39sla2");

    const opened = yield* openExecutionFile(root, "kf39sla2");
    expect(yield* opened.stream.readAll()).toEqual([]);
  });
});
