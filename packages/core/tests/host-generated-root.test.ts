/**
 * Tier E — a generated root is evaluated by the execution that owns it.
 *
 * `HostExecution.evaluateGeneratedXmdRoot()` is a method rather than a module
 * export, and every row here is about something that follows from that.
 *
 * **What it reaches is one execution's.** The documentation a root's
 * `<Syntax names={…}>` renders is the documentation *that* execution's packages
 * contributed, collected once before its root import. A free function would have
 * had to assemble something beside it, and the only thing it could assemble
 * without the execution is core's own asset — which reports a bootstrapped
 * package's component as undocumented.
 *
 * **It is live or it is nothing.** A completed document took its captured
 * reference, its guarded route and its runtime services with it, so a handle
 * kept past the run refuses rather than reopening it. Readiness is waited for
 * rather than worked around: an evaluation that ran in the caller's scope would
 * inherit whatever the caller installed and reach none of what the document's
 * own elements reach.
 *
 * **A response is not part of the document's continuation.** Each explicit
 * evaluation owns a durable sequence of its own on the same canonical journal,
 * allocated past every evaluation the history holds. So the document replays
 * its own work and nothing else's, a completed response is never run twice, and
 * an interrupted one is a fact rather than a suffix for the next call to
 * resume.
 *
 * **Cancelling joins.** One evaluation runs at a time; an overlapping call
 * refuses rather than queuing, and a cancelled call does not finish until the
 * work it started has finished unwinding.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, scoped, sleep, spawn, suspend, useScope, withResolvers } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { pinnedComponent } from "../src/generated-xmd.ts";
import type { GeneratedObservation } from "../src/generated-xmd.ts";
import type { FunctionComponentDefinition } from "../src/types.ts";
import { useSelection } from "./support/generated-selection.ts";
import { answerProvider } from "./support/answer-provider.ts";
import type { Operation, Result } from "effection";
import {
  DurableContext,
  DurablePersistenceError,
  InMemoryStream,
} from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import { contributeDocumentation, Documentation } from "../src/documentation-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { durabilityFailure } from "../src/errors.ts";
import { Execution, execute } from "../src/execute.ts";
import { retainedSource } from "../src/root-source.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { HELD_ROOT_PATH, useHeldHost, withHeldHost } from "./support/held-host.ts";
import * as hostModule from "../host.ts";
import { executeInstalled, HostExecutionError } from "../host.ts";
// The request and the class it names are taken from the trusted host
// entrypoint, which is where a host reads them: every row below is an ordinary
// typed consumer of the published boundary rather than of the module the
// evaluator lives in.
import type {
  ExecutionInstallation,
  GeneratedEffectClass,
  GeneratedXmdRequest,
  GeneratedXmdRootResult,
  HostExecution,
} from "../host.ts";
import type { Json } from "../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/**
 * One host definition, with the per-form metadata main's selection reads.
 *
 * Identity and effect are the declaration's own rather than an argument passed
 * beside it, which is what the captured selection reads. Every assertion below
 * is unchanged; only where the identity comes from moved.
 */
function definitionOf(
  name: string,
  effect: "read" | "write",
  body: () => Operation<Json>,
): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    props: NO_PROPS,
    generated: {
      "self-closing": { identity: `https://executable.md/components/${name}`, effect },
    },
    *fn(): Operation<Json> {
      return yield* body();
    },
  };
}

/** One observation a root may name, recording every invocation. */
function probe(invoked: string[] = []): GeneratedObservation {
  return pinnedComponent(
    "Probe",
    definitionOf("Probe", "read", function* (): Operation<Json> {
      invoked.push("probed");
      return "probed";
    }),
    "component-answer",
  );
}

/**
 * The installation that declares and answers for these entries.
 *
 * A root is admitted from the selection its execution captured, so every row
 * states what it names here rather than passing a table with the call.
 */
function selecting(entries: readonly GeneratedObservation[]): ExecutionInstallation {
  return {
    componentAnswers: entries.map((entry) => answerProvider(entry.name, entry.definition)),
    *install(): Operation<void> {
      yield* useSelection(
        Object.fromEntries(entries.map((entry) => [entry.name, ["self-closing"]])),
      );
    },
  };
}

function request(source: string, _invoked: string[] = [], id = "turn-1"): GeneratedXmdRequest {
  // A root carries no tables: its execution captured the selection, which the
  // row declares with `selecting([...])`.
  return { id, source };
}

/** The admissions a journal holds, which is one per evaluation. */
function admissions(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

/** The coroutines a journal holds, which is what names each sequence. */
function sequences(events: readonly DurableEvent[]): string[] {
  return [...new Set(events.map((event) => event.coroutineId))];
}

/**
 * The same call, bounded so that a lost answer fails instead of hanging.
 *
 * Readiness is established by the execution's own completion, which every row
 * using this has already observed — the timer decides nothing about whether
 * the answer was correct, and only bounds how long a missing one is waited for.
 */
function bounded<T>(operation: Operation<T>): Operation<T> {
  return race([
    operation,
    (function* (): Operation<never> {
      yield* sleep(1000);
      throw new Error("a closed evaluator is still waiting for readiness");
    })(),
  ]);
}

/** Whatever this answer rendered, or the refusal that explains why there is none. */
function rendered(answer: Result<GeneratedXmdRootResult>): GeneratedXmdRootResult {
  if (!answer.ok) {
    throw new Error(`the root failed: ${answer.error.message}`);
  }
  return answer.value;
}

describe("Tier E1 — only a live trusted handle evaluates a root", () => {
  beforeAll(() => useTempFileCompiler());

  it("E1a: a handle evaluates from its caller with no conversation and no durable context", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const gate = withResolvers<void>();
    const execution = yield* executeInstalled(
      {
        ...retainedSource(HELD_ROOT_PATH, "<Holding />\n"),
        stream,
      },
      [
        {
          components: [
            {
              name: "Holding",
              origin: "test://holding",
              props: NO_PROPS,
              description: "Hold this execution open.",
              factory: () =>
                function* (): Operation<Json> {
                  yield* gate.operation;
                  return "the document finished";
                },
            },
          ],
        },
        selecting([probe(invoked)]),
      ],
    );
    const watched = yield* spawn(() => execution);
    // The document's own output stream, consumed while the run is live. A late
    // subscriber receives the whole sequence, but subscribing here is what the
    // row is about: a consumer watching the document throughout must never be
    // handed a root's rendering.
    const chunks: string[] = [];
    const observed = yield* spawn(() =>
      forEach(function* (chunk: string) {
        chunks.push(chunk);
      }, execution.output),
    );

    // No conversation, and no journal around this caller either: the caller's
    // own scope carries no durable context, so the evaluation's sequence is the
    // execution's rather than one borrowed from here.
    const scope = yield* useScope();
    expect(scope.get(DurableContext)).toBe(undefined);

    // Asked as soon as the handle exists, which is before the document workflow
    // has activated anything. It waits for canonical readiness rather than
    // choosing another scope.
    const answer = yield* execution.evaluateGeneratedXmdRoot(
      request("<Output>\n<Probe />\n</Output>\n", invoked),
    );

    expect(rendered(answer).output).toContain("probed");
    expect(rendered(answer).hasOutput).toBe(true);
    expect(invoked).toEqual(["probed"]);

    // The main body was held throughout, so this ran beside the document rather
    // than instead of it.
    const beforeRelease = yield* stream.readAll();
    expect(admissions(beforeRelease)).toHaveLength(1);

    gate.resolve();
    const completion = yield* watched;
    const closed = yield* observed;

    // Canonical main completion, after the document's own cleanup.
    expect(completion.ok).toBe(true);
    expect(String(completion.ok === true ? completion.value : "")).toContain(
      "the document finished",
    );
    expect(String(completion.ok === true ? completion.value : "")).not.toContain("probed");

    // And the output stream is the document's rather than the root's — read off
    // the chunks a consumer actually received, not off the completion value.
    // The rendering a root answers with comes back from the method and reaches
    // neither the stream nor its close value: a host showing somebody a reply
    // is not the document printing one.
    expect(chunks.join("")).toContain("the document finished");
    expect(chunks.join("")).not.toContain("probed");
    expect(String(closed)).not.toContain("probed");
  });

  it("E1b: ordinary execute exposes no evaluator, and the host module exports none", function* () {
    const ordinary = yield* execute({
      ...retainedSource("host/plain.md", "plain\n"),
      stream: new InMemoryStream(),
    });

    // The runtime object, not a narrower annotation: `in` walks the prototype
    // chain, so a method hidden on a prototype would be found here.
    expect("evaluateGeneratedXmdRoot" in ordinary).toBe(false);
    expect(Reflect.get(ordinary, "evaluateGeneratedXmdRoot")).toBe(undefined);
    expect(Object.keys(ordinary).sort()).toEqual(["output"]);

    yield* ordinary;

    // And there is no free function to reach instead. Evaluating a root is
    // something an execution does, so the module that used to export one does
    // not.
    expect(Object.keys(hostModule)).not.toContain("evaluateGeneratedXmdRoot");
  });

  it("E1c: a completed handle refuses without component work or reopening", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const held: { execution?: HostExecution } = {};
    const run = yield* withHeldHost(
      { stream, installations: [selecting([probe()])] },
      function* (open) {
        held.execution = open.execution;
      },
    );
    expect(run.completion.ok).toBe(true);

    const execution = held.execution;
    if (execution === undefined) {
      throw new Error("the case never held an execution");
    }
    const after = yield* execution.evaluateGeneratedXmdRoot(
      request("<Output>\n<Probe />\n</Output>\n", invoked),
    );

    expect(after.ok).toBe(false);
    expect(after.ok === false && after.error).toBeInstanceOf(HostExecutionError);
    expect(after.ok === false && after.error.message).toContain("has finished");
    // Nothing ran and nothing was recorded: a refusal of availability is not an
    // evaluation that failed.
    expect(invoked).toEqual([]);
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
  });

  it("E1d: a document that ended before activating its runner refuses as well", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];

    // A public policy that refuses before delegating, so canonical execution
    // publishes its handle and then ends without the document body — and
    // therefore without the runner — ever existing.
    yield* Execution.around({
      // deno-lint-ignore require-yield
      *document(): Operation<void> {
        throw new Error("this policy refused before delegating");
      },
    });
    const execution = yield* executeInstalled(
      { ...retainedSource("host/early.md", "ordinary document\n"), stream },
      [],
    );
    const completed = yield* execution;
    expect(completed.ok).toBe(false);

    // The bound operation escaped on the handle before any of that, so closing
    // it cannot be something activating the runner first made possible. E1c is
    // the other half: a document that *did* activate refuses on the same terms
    // once it has ended.
    const after = yield* bounded(
      execution.evaluateGeneratedXmdRoot(request("<Output>\n<Probe />\n</Output>\n", invoked)),
    );
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.error).toBeInstanceOf(HostExecutionError);
    expect(after.ok === false && after.error.message).toContain("has finished");
    expect(invoked).toEqual([]);
  });
});

/**
 * The package that documents `<Marker>`.
 *
 * Registration and chapter together, through the one mechanism a package's
 * bootstrap uses: the component exists in this execution's vocabulary, and the
 * documentation for it is in the chain the execution collects before its root
 * import. `Marker` is a name core does not ship, so a row about a contributed
 * chapter is not also a row about core's own.
 */
function markerPackage(
  prose: string,
  counted: { reads: number } = { reads: 0 },
  invoked: string[] = [],
): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* registerComponents([
        {
          name: "Marker",
          origin: "@executablemd/test",
          props: NO_PROPS,
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            invoked.push("marked");
            return "marked";
          },
        },
      ]);
      // deno-lint-ignore require-yield
      yield* contributeDocumentation(function* () {
        counted.reads += 1;
        return {
          source: {
            owner: "@executablemd/test",
            asset: "packages/test/src/components.md",
            text: prose,
          },
          supplies: new Set(["Marker"]),
        };
      });
    },
  };
}

const MARKER_PROSE = "## Marker\n\nTHE MARKER CHAPTER.\n";

describe("Tier E3 — the documentation this execution captured", () => {
  beforeAll(() => useTempFileCompiler());

  it("E3a: a named lookup renders a package chapter the root does not admit", function* () {
    const stream = new InMemoryStream();
    const counted = { reads: 0 };
    const marked: string[] = [];
    const invoked: string[] = [];
    const lookup: { answer?: Result<GeneratedXmdRootResult> } = {};
    const attempted: { answer?: Result<GeneratedXmdRootResult> } = {};

    const run = yield* withHeldHost(
      {
        stream,
        installations: [markerPackage(MARKER_PROSE, counted, marked), selecting([probe()])],
      },
      function* (open) {
        lookup.answer = yield* open.execution.evaluateGeneratedXmdRoot(
          request('<Output>\n<Syntax names={["Marker"]} />\n</Output>\n', invoked),
        );
        attempted.answer = yield* open.execution.evaluateGeneratedXmdRoot(
          request("<Output>\n<Marker />\n</Output>\n", invoked, "turn-2"),
        );
      },
    );

    expect(run.completion.ok).toBe(true);
    const described = rendered(lookup.answer ?? { ok: false, error: new Error("none") }).output;

    // The chapter this execution's package contributed, rendered in full.
    // Reading core's own asset instead would answer for core and report this
    // component as undocumented.
    expect(described).toContain("THE MARKER CHAPTER.");
    expect(described).not.toContain("No long-form documentation is available");
    // And the root may not run it. Reading about a component grants nothing, so
    // the entry says it is unavailable here.
    expect(described).toContain("Marker");
    expect(marked).toEqual([]);

    // Writing the name is refused, before anything runs.
    expect(attempted.answer?.ok).toBe(false);
    expect(attempted.answer?.ok === false && attempted.answer.error.message).toContain(
      "did not admit",
    );
    expect(marked).toEqual([]);

    // Collected once, by the execution, before its root import. Evaluating a
    // root reads the captured reference rather than asking the chain again.
    expect(counted.reads).toBe(1);
  });

  it("E3b: late Documentation middleware in the document's own scope changes nothing", function* () {
    const counted = { reads: 0 };
    const invoked: string[] = [];
    const answer: { lookup?: Result<GeneratedXmdRootResult> } = {};

    // Installed in an `Execution.document` wrapper: after canonical capture and
    // before the document workflow, which is the scope the evaluation runner is
    // attached inside. A recollection there *would* encounter this, so the row
    // distinguishes a captured reference from one rebuilt at evaluation time.
    // Middleware installed only in a sibling caller scope could not.
    yield* Execution.around({
      *document([claimed], next) {
        yield* Documentation.around({
          *contributions([read], nextChapter) {
            const held = yield* nextChapter(read);
            return held.map((one) =>
              one.source.owner === "@executablemd/test"
                ? {
                    ...one,
                    source: { ...one.source, text: "## Marker\n\nSUBSTITUTED LATE.\n" },
                  }
                : one,
            );
          },
        });
        yield* next(claimed);
      },
    });

    const run = yield* withHeldHost(
      { installations: [markerPackage(MARKER_PROSE, counted), selecting([probe()])] },
      function* (open) {
        answer.lookup = yield* open.execution.evaluateGeneratedXmdRoot(
          request('<Output>\n<Syntax names={["Marker"]} />\n</Output>\n', invoked),
        );
      },
    );

    expect(run.completion.ok).toBe(true);
    const described = rendered(answer.lookup ?? { ok: false, error: new Error("none") }).output;
    expect(described).toContain("THE MARKER CHAPTER.");
    expect(described).not.toContain("SUBSTITUTED LATE.");
    // No new collection happened, which is the mechanism rather than the
    // symptom: the count is the same before and after the evaluation.
    expect(counted.reads).toBe(1);
  });

  it("E3c: two live executions each keep the capture they made", function* () {
    const mine = { reads: 0 };
    const theirs = { reads: 0 };
    const invoked: string[] = [];
    const answers: { first?: string; second?: string } = {};

    yield* scoped(function* () {
      const one = yield* useHeldHost({
        installations: [
          markerPackage("## Marker\n\nFIRST OWNER'S CHAPTER.\n", mine),
          selecting([probe()]),
        ],
      });
      const two = yield* useHeldHost({
        installations: [
          markerPackage("## Marker\n\nSECOND OWNER'S CHAPTER.\n", theirs),
          selecting([probe()]),
        ],
      });
      const source = '<Output>\n<Syntax names={["Marker"]} />\n</Output>\n';
      answers.first = rendered(
        yield* one.execution.evaluateGeneratedXmdRoot(request(source, invoked)),
      ).output;
      answers.second = rendered(
        yield* two.execution.evaluateGeneratedXmdRoot(request(source, invoked)),
      ).output;
    });

    // Each root read its own execution's capture. A shared index, or one read
    // from a context a descendant can set, would answer the same text twice.
    expect(answers.first).toContain("FIRST OWNER'S CHAPTER.");
    expect(answers.first).not.toContain("SECOND OWNER'S CHAPTER.");
    expect(answers.second).toContain("SECOND OWNER'S CHAPTER.");
    expect(answers.second).not.toContain("FIRST OWNER'S CHAPTER.");
    expect(mine.reads).toBe(1);
    expect(theirs.reads).toBe(1);
  });
});

/** A registered component whose invocation the document's own work is made of. */
function marking(seen: string[]): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* registerComponents([
        {
          name: "Mark",
          origin: "@executablemd/test",
          props: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          // deno-lint-ignore require-yield
          *fn(props: Record<string, Json>): Operation<string> {
            seen.push(String(props.name));
            return `marked ${String(props.name)}`;
          },
        },
      ]);
    },
  };
}

describe("Tier E4 — one journal, separate acknowledged histories", () => {
  beforeAll(() => useTempFileCompiler());

  it("E4a: two evaluations own two sequences, and the document owns its own", function* () {
    const stream = new InMemoryStream();
    const seen: string[] = [];
    const invoked: string[] = [];
    const answers: GeneratedXmdRootResult[] = [];

    const run = yield* withHeldHost(
      {
        stream,
        installations: [marking(seen), selecting([probe()])],
        root: {
          path: "host/marked.md",
          source: '<Mark name="before" />\n\n<Held />\n\n<Mark name="after" />\n',
        },
      },
      function* (open) {
        // Real main work has already happened, and more follows the release.
        expect(seen).toEqual(["before"]);
        answers.push(
          rendered(
            yield* open.execution.evaluateGeneratedXmdRoot(
              request("<Output>\nFIRST GENERATED\n</Output>\n", invoked),
            ),
          ),
        );
        answers.push(
          rendered(
            yield* open.execution.evaluateGeneratedXmdRoot(
              request("<Output>\nSECOND GENERATED\n</Output>\n", invoked, "turn-2"),
            ),
          ),
        );
      },
    );

    expect(run.completion.ok).toBe(true);
    expect(seen).toEqual(["before", "after"]);

    // Each method answered with its own rendering, and neither answered with
    // the other's.
    expect(answers[0]?.output).toContain("FIRST GENERATED");
    expect(answers[0]?.output).not.toContain("SECOND GENERATED");
    expect(answers[1]?.output).toContain("SECOND GENERATED");

    const events = yield* stream.readAll();
    // Two evaluations, two sequences, one admission each.
    expect(sequences(events)).toContain("generated_root:1");
    expect(sequences(events)).toContain("generated_root:2");
    expect(admissions(events)).toHaveLength(2);
    expect(admissions(events).map((event) => event.coroutineId)).toEqual([
      "generated_root:1",
      "generated_root:2",
    ]);
    // And the document's own sequence holds none of their work: the main
    // continuation consumes neither.
    expect(
      events.filter(
        (event) =>
          event.coroutineId === "root" &&
          event.type === "yield" &&
          event.description.type === "generated_xmd",
      ),
    ).toEqual([]);

    // Main output is the document's. A generated rendering reaches it not at
    // all, which is why a host shows a reply by rendering the answer rather
    // than by reading the document's stream.
    const output = String(run.completion.ok === true ? run.completion.value : "");
    expect(output).toContain("marked before");
    expect(output).toContain("marked after");
    expect(output).not.toContain("GENERATED");
  });

  it("E4b: a retained response is not history the document is held to", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];

    // One completed evaluation, retained — and the document left unfinished, so
    // the history is one a later run continues rather than a terminal it
    // replays.
    yield* scoped(function* () {
      const open = yield* useHeldHost({ stream, installations: [selecting(declared(invoked))] });
      expect(
        rendered(
          yield* open.execution.evaluateGeneratedXmdRoot(
            request("<Output>\n<Probe />\n</Output>\n", invoked),
          ),
        ).hasOutput,
      ).toBe(true);
    });

    const retained = yield* stream.readAll();
    expect(sequences(retained)).toContain("generated_root:1");

    // Reopened, with a trusted host admission that records the history it is
    // offered. The admission is the one boundary that is handed the document's
    // retained snapshot whole, so what it sees is what the main continuation is
    // being held to.
    const offered: string[][] = [];
    const admitting: ExecutionInstallation = {
      admissions: [
        // deno-lint-ignore require-yield
        function* (history): Operation<void> {
          offered.push(sequences(history));
        },
      ],
    };
    const second: string[] = [];
    const reopened = yield* withHeldHost(
      { stream: new InMemoryStream(retained), installations: [admitting, selecting([probe()])] },
      function* (open) {
        yield* open.execution.evaluateGeneratedXmdRoot(
          request("<Output>\n<Probe />\n</Output>\n", second, "turn-2"),
        );
      },
    );

    expect(reopened.completion.ok).toBe(true);
    // The document's own continuation, and nothing a response left behind. An
    // admission shown a retained response would be deciding about work it never
    // performed, and the replay beneath it would be aligning against it.
    expect(offered).toHaveLength(1);
    expect(offered[0]).toEqual(["root"]);
  });
});

/**
 * Every component these rows name, declared together.
 *
 * A host states one selection for its execution, so the rows that evaluate a
 * control, a failing control or a failing cleanup all reach their own entry
 * without each arranging a host of its own. A row holding a control states its
 * own, because that entry closes over the resolver the row is waiting on.
 */
function declared(invoked: string[] = []): readonly GeneratedObservation[] {
  return [probe(invoked), failing(invoked), failingCleanup()];
}

/** A control that journals nothing and holds both its body and its cleanup. */
function holding(
  reached: { resolve(): void },
  release: Operation<void>,
  order: string[],
): GeneratedObservation {
  return pinnedComponent(
    "Hold",
    definitionOf("Hold", "read", function* (): Operation<Json> {
      // Registered before the barrier, so cancellation cannot arrive between
      // entering the body and owning the cleanup.
      yield* ensure(function* () {
        yield* release;
        order.push("evaluation cleanup");
      });
      reached.resolve();
      yield* suspend();
      return "held";
    }),
    "component-answer",
  );
}

describe("Tier E5 — cancelling joins before anything else starts", () => {
  beforeAll(() => useTempFileCompiler());

  it("E5a: a cancelled evaluation holds the caller's halt until its cleanup joins", function* () {
    const stream = new InMemoryStream();
    const order: string[] = [];
    const invoked: string[] = [];
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    const overlapping: { answer?: Result<GeneratedXmdRootResult> } = {};
    const fresh: { answer?: Result<GeneratedXmdRootResult> } = {};

    yield* scoped(function* () {
      const open = yield* useHeldHost({
        stream,
        installations: [
          selecting([...declared(invoked), holding(reached, release.operation, order)]),
        ],
      });
      const held = {
        id: "turn-1",
        source: "<Output>\n<Hold />\n</Output>\n",
      };
      const running = yield* spawn(() => open.execution.evaluateGeneratedXmdRoot(held));
      // Entered, so this cancels work in flight rather than work that never
      // started — and the admission is already acknowledged.
      yield* reached.operation;
      expect(admissions(yield* stream.readAll())).toHaveLength(1);

      const halting = yield* spawn(function* () {
        yield* running.halt();
        order.push("halt returned");
      });

      // While the halt is pending, the execution is still busy: a second
      // evaluation is refused rather than queued, and it performs nothing.
      overlapping.answer = yield* open.execution.evaluateGeneratedXmdRoot(
        request("<Output>\n<Probe />\n</Output>\n", invoked, "turn-2"),
      );
      expect(order).toEqual([]);
      expect(invoked).toEqual([]);
      expect(admissions(yield* stream.readAll())).toHaveLength(1);

      release.resolve();
      yield* halting;

      // Only now is the handle free, and the next call is new work rather than
      // the cancelled one resumed.
      fresh.answer = yield* open.execution.evaluateGeneratedXmdRoot(
        request("<Output>\n<Probe />\n</Output>\n", invoked, "turn-3"),
      );
    });

    expect(overlapping.answer?.ok).toBe(false);
    expect(overlapping.answer?.ok === false && overlapping.answer.error).toBeInstanceOf(
      HostExecutionError,
    );
    expect(overlapping.answer?.ok === false && overlapping.answer.error.message).toContain(
      "one at a time",
    );
    // The cleanup joined before the halt returned, which is what a caller whose
    // halt has come back is entitled to assume.
    expect(order).toEqual(["evaluation cleanup", "halt returned"]);
    expect(rendered(fresh.answer ?? { ok: false, error: new Error("none") }).output).toContain(
      "probed",
    );
    expect(invoked).toEqual(["probed"]);

    const events = yield* stream.readAll();
    // The cancelled evaluation left its sequence unfinished, and the fresh call
    // took a new address rather than continuing it.
    expect(sequences(events)).toContain("generated_root:1");
    expect(sequences(events)).toContain("generated_root:2");
    expect(
      events.some((event) => event.type === "close" && event.coroutineId === "generated_root:1"),
    ).toBe(false);
  });

  it("E5b: closing the execution joins a held evaluation before closure completes", function* () {
    const order: string[] = [];
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    const saved: { execution?: HostExecution } = {};
    const interrupted: { answer?: Result<GeneratedXmdRootResult> } = {};
    const invoked: string[] = [];

    yield* scoped(function* () {
      const open = yield* useHeldHost({
        // The latch is resolved by the document element's own cleanup, which
        // unwinds before the evaluation runner does. So the evaluation's
        // cleanup is genuinely held at the moment closure begins, and it is the
        // closing that frees it rather than this case pre-arranging the order.
        *inside(): Operation<void> {
          yield* ensure(() => {
            release.resolve();
          });
        },
        installations: [selecting([...declared(), holding(reached, release.operation, order)])],
      });
      saved.execution = open.execution;
      const running = yield* spawn(() =>
        open.execution.evaluateGeneratedXmdRoot({
          id: "turn-1",
          source: "<Output>\n<Hold />\n</Output>\n",
        }),
      );
      yield* reached.operation;
      // Closing the execution: halting the handle's consumer takes the
      // invocation down with it.
      const closing = yield* spawn(function* () {
        yield* open.watched.halt();
        order.push("closed");
      });
      yield* closing;
      interrupted.answer = yield* running;
    });

    // The held cleanup joined, and only then did closure complete.
    expect(order).toEqual(["evaluation cleanup", "closed"]);
    // The caller was told the execution closed rather than left waiting on an
    // answer nothing was left to produce.
    expect(interrupted.answer?.ok).toBe(false);
    expect(interrupted.answer?.ok === false && interrupted.answer.error).toBeInstanceOf(
      HostExecutionError,
    );
    expect(interrupted.answer?.ok === false && interrupted.answer.error.message).toContain(
      "closed while it was evaluating",
    );

    const execution = saved.execution;
    if (execution === undefined) {
      throw new Error("the case never held an execution");
    }
    const after = yield* execution.evaluateGeneratedXmdRoot(
      request("<Output>\n<Probe />\n</Output>\n", invoked),
    );
    expect(after.ok).toBe(false);
    expect(invoked).toEqual([]);
  });
});

describe("Tier E6 — reopening without replaying a response", () => {
  beforeAll(() => useTempFileCompiler());

  it("E6a: a reopened owner repeats no completed effect and continues no suffix", function* () {
    const stream = new InMemoryStream();
    const first: string[] = [];
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    const order: string[] = [];

    yield* scoped(function* () {
      const open = yield* useHeldHost({
        stream,
        installations: [
          selecting([...declared(first), holding(reached, release.operation, order)]),
        ],
      });
      // One completed evaluation, whose effect is acknowledged.
      expect(
        rendered(
          yield* open.execution.evaluateGeneratedXmdRoot(
            request("<Output>\n<Probe />\n</Output>\n", first),
          ),
        ).output,
      ).toContain("probed");
      // And a second whose first effect is acknowledged and which is then
      // cancelled before its next one.
      const running = yield* spawn(() =>
        open.execution.evaluateGeneratedXmdRoot({
          id: "turn-2",
          source: "<Output>\n<Hold />\n</Output>\n",
        }),
      );
      yield* reached.operation;
      release.resolve();
      yield* running.halt();
    });

    expect(first).toEqual(["probed"]);
    const retained = yield* stream.readAll();
    expect(admissions(retained)).toHaveLength(2);
    // The interrupted sequence left no terminal, which is what makes it a fact
    // rather than a suffix.
    expect(
      retained.some((event) => event.type === "close" && event.coroutineId === "generated_root:2"),
    ).toBe(false);

    // Reopened over exactly that history.
    const reopened = new InMemoryStream(retained);
    const second: string[] = [];
    const answer: { fresh?: Result<GeneratedXmdRootResult> } = {};
    const run = yield* withHeldHost(
      { stream: reopened, installations: [selecting(declared(second))] },
      function* (open) {
        // Opening alone repeats nothing: neither the completed response's effect
        // nor the interrupted one's suffix.
        expect(second).toEqual([]);
        answer.fresh = yield* open.execution.evaluateGeneratedXmdRoot(
          request("<Output>\n<Probe />\n</Output>\n", second, "turn-3"),
        );
      },
    );

    expect(run.completion.ok).toBe(true);
    expect(rendered(answer.fresh ?? { ok: false, error: new Error("none") }).output).toContain(
      "probed",
    );
    // Once, and on an address past every retained evaluation.
    expect(second).toEqual(["probed"]);
    const after = yield* reopened.readAll();
    expect(admissions(after)).toHaveLength(3);
    expect(admissions(after)[2]?.coroutineId).toBe("generated_root:3");
  });

  /**
   * IN4 — an older build's root sequences are history, not authority.
   *
   * The journal offered here is the shape the accepted pre-integration writer
   * wrote (`01abab27`): explicit root evaluations on their own
   * `generated_root:N` sequences, each admission a `version: 2` record carrying
   * the `context: "root"` member that build used to say which kind it was. One
   * sequence completed with an acknowledged effect and a terminal; one was
   * interrupted and left a suffix with no terminal.
   *
   * Hand-built to that writer's record shape rather than produced by this
   * build, which is what keeps it old-format evidence: a marker-5 fixture
   * relabelled would establish nothing.
   *
   * Three things have to hold for such a journal to stay usable. The old
   * sequences are partitioned out of the main continuation, so the document
   * replays its own work and not theirs. Opening repeats neither the completed
   * effect nor the interrupted suffix. And a new explicit root allocates past
   * both and writes this build's marker — rather than resuming a grant whose
   * rules this build does not have.
   */
  it("E6b: an older build's root sequences are skipped, and a new root allocates past them", function* () {
    const invoked: string[] = [];
    const stream = new InMemoryStream([...OLD_ROOT_JOURNAL]);
    const opened: { before?: readonly string[] } = {};
    const answer: { value?: Result<GeneratedXmdRootResult> } = {};

    const run = yield* withHeldHost(
      { stream, installations: [selecting([probe(invoked)])] },
      function* (open) {
        // Read inside the held document, after its own replay and before the
        // first call: opening is the whole of what happened by here.
        opened.before = [...invoked];
        answer.value = yield* open.execution.evaluateGeneratedXmdRoot(
          request("<Output>\n<Probe />\n</Output>\n", invoked, "turn-new"),
        );
      },
    );

    expect(run.completion.ok).toBe(true);
    // Opening repeated nothing: neither the completed sequence's effect nor the
    // interrupted one's suffix.
    expect(opened.before).toEqual([]);
    expect(rendered(answer.value ?? { ok: false, error: new Error("none") }).output).toContain(
      "probed",
    );
    expect(invoked).toEqual(["probed"]);

    const after = yield* stream.readAll();
    // The old bytes are exactly the old bytes, and nothing was appended to
    // either old sequence.
    expect(after.slice(0, OLD_ROOT_JOURNAL.length)).toEqual([...OLD_ROOT_JOURNAL]);
    expect(after.filter((event) => event.coroutineId.startsWith("generated_root:1"))).toHaveLength(
      1 + 1 + 1,
    );
    expect(after.filter((event) => event.coroutineId.startsWith("generated_root:2"))).toHaveLength(
      1,
    );
    // The main continuation never took an admission of its own, so it did not
    // consume theirs.
    expect(admissions(after.filter((event) => event.coroutineId === "root"))).toHaveLength(0);
    // And the new evaluation is past both, in this build's marker.
    const fresh = admissions(after.filter((event) => event.coroutineId === "generated_root:3"));
    expect(fresh).toHaveLength(1);
    expect(markerOf(fresh[0])).toBe(5);
    // The old ones are still the old ones.
    expect(markerOf(after[0])).toBe(2);
    expect(markerOf(after[3])).toBe(2);
  });
});

/** The marker one retained admission carries at the result level. */
function markerOf(event: DurableEvent | undefined): number | undefined {
  if (event?.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  const value = event.result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return typeof value.version === "number" ? value.version : undefined;
}

/**
 * One root admission in the accepted pre-integration writer's shape.
 *
 * `version: 2` at the result and inside the policy, the `context: "root"` member
 * that build wrote to say which kind a record was, `requests` for the
 * per-identity Fetch ceilings it retained, and each identity as the four-member
 * structural record — a kind, an origin, a key and a revision.
 */
function oldRootAdmission(id: string): DurableEvent {
  const identity = {
    kind: "component-answer",
    origin: "test://provider",
    key: "Probe",
    revision: "1",
  };
  const source = "<Output>\n<Probe />\n</Output>\n";
  return {
    type: "yield",
    coroutineId: `generated_root:${id}`,
    description: { type: "generated_xmd", name: `generated:old-${id}` },
    result: {
      status: "ok",
      value: {
        version: 2,
        decision: "admitted",
        source,
        named: [{ name: "Probe", identity: { ...identity }, form: "self-closing" }],
        policy: {
          version: 2,
          allow: ["read"],
          context: "root",
          allowed: [{ name: "Probe", identity: { ...identity }, forms: ["self-closing"] }],
          requests: [],
        },
      },
    },
  };
}

/**
 * A journal that older build left behind: one completed root evaluation with an
 * acknowledged effect, and one interrupted evaluation with no terminal.
 */
const OLD_ROOT_JOURNAL: readonly DurableEvent[] = [
  oldRootAdmission("1"),
  {
    type: "yield",
    coroutineId: "generated_root:1",
    description: {
      type: "fetch",
      name: "fetch:1",
      input: { url: "https://old.example.test/one", method: "GET" },
    },
    result: { status: "ok", value: { status: 200, body: "what the old evaluation read" } },
  },
  { type: "close", coroutineId: "generated_root:1", result: { status: "ok" } },
  oldRootAdmission("2"),
];

/** A control that fails on its own terms, after whatever ran before it. */
function failing(invoked: string[]): GeneratedObservation {
  return pinnedComponent(
    "Boom",
    definitionOf("Boom", "read", function* (): Operation<Json> {
      invoked.push("boomed");
      throw new Error("the control refused this request");
    }),
    "component-answer",
  );
}

/** A control whose own cleanup fails, which is work the root owned not finishing. */
function failingCleanup(): GeneratedObservation {
  return pinnedComponent(
    "Leak",
    definitionOf("Leak", "read", function* (): Operation<Json> {
      // deno-lint-ignore require-yield
      yield* ensure(function* () {
        throw new Error("this control's cleanup failed");
      });
      return "leaked";
    }),
    "component-answer",
  );
}

/** One installed component that fails the main document, after the root ran. */
function failingMain(): NonNullable<ExecutionInstallation["components"]>[number] {
  return {
    name: "Boom",
    origin: "test://main",
    props: NO_PROPS,
    description: "Fail the main document for an ordinary reason of its own.",
    factory: () =>
      // deno-lint-ignore require-yield
      function* (): Operation<Json> {
        throw new Error("the document's own later failure");
      },
  };
}

describe("Tier E7 — which failures stay the run's", () => {
  beforeAll(() => useTempFileCompiler());

  it("E7a: an ordinary control failure is a Result carrying the real partial render", function* () {
    const invoked: string[] = [];
    const answer: { failed?: Result<GeneratedXmdRootResult> } = {};

    const run = yield* withHeldHost(
      { installations: [selecting(declared(invoked))] },
      function* (open) {
        answer.failed = yield* open.execution.evaluateGeneratedXmdRoot({
          id: "turn-1",
          source: "<Output>\nbefore the failure\n\n<Boom />\n</Output>\n",
        });
      },
    );

    // The request's own failure, so the execution is untouched by it.
    expect(run.completion.ok).toBe(true);
    expect(answer.failed?.ok).toBe(false);
    const error: (Error & { partial?: GeneratedXmdRootResult }) | undefined =
      answer.failed?.ok === false ? answer.failed.error : undefined;
    expect(error?.message).toContain("the control refused this request");
    expect(error?.partial?.output).toContain("before the failure");
    expect(invoked).toEqual(["boomed"]);
  });

  it("E7b: a persistence failure stays itself, and the run does not succeed", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const caught: { raised?: unknown; completion?: Result<Json> } = {};

    yield* scoped(function* () {
      const open = yield* useHeldHost({ stream, installations: [selecting(declared(invoked))] });
      // Only the evaluation's own admission is refused, so the failure belongs
      // to this evaluation's append rather than to the document's history
      // becoming unwritable from the start.
      stream.onAppend = (event) => {
        if (event.type === "yield" && event.description.type === "generated_xmd") {
          throw new Error("the journal stopped accepting appends");
        }
      };
      try {
        yield* open.execution.evaluateGeneratedXmdRoot(
          request("<Output>\n<Probe />\n</Output>\n", invoked),
        );
      } catch (error) {
        caught.raised = error;
      }
      stream.onAppend = null;
      open.release();
      caught.completion = yield* open.watched;
    });

    // Raised rather than returned, and still classified as what it is: a host
    // holding this is not holding a reply worth correcting.
    expect(caught.raised).not.toBe(undefined);
    expect(durabilityFailure(caught.raised)).not.toBe(undefined);
    // And the run it came out of cannot report success. The document's own body
    // completed, and the completion is this failure all the same — so catching
    // it on the call does not buy a successful main result.
    expect(caught.completion?.ok).toBe(false);
    expect(
      durabilityFailure(caught.completion?.ok === false ? caught.completion.error : undefined),
    ).not.toBe(undefined);
    expect(invoked).toEqual([]);
  });

  it("E7c: a teardown failure stays itself, and the run does not succeed", function* () {
    const caught: { raised?: unknown; completion?: Result<Json> } = {};

    yield* scoped(function* () {
      const open = yield* useHeldHost({ installations: [selecting(declared())] });
      try {
        yield* open.execution.evaluateGeneratedXmdRoot({
          id: "turn-1",
          source: "<Output>\n<Leak />\n</Output>\n",
        });
      } catch (error) {
        caught.raised = error;
      }
      open.release();
      caught.completion = yield* open.watched;
    });

    // Work the root owned did not finish unwinding, so a rendering reported
    // beside it would describe a root still running.
    expect(caught.raised).not.toBe(undefined);
    expect(String((caught.raised as Error).message)).toContain("cleanup");
    expect(caught.completion?.ok).toBe(false);
  });

  it("E7d: a fatal evaluation outranks the ordinary failure the document went on to have", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const caught: { raised?: unknown } = {};

    // The document fails on its own terms *after* the evaluation did, so the
    // completion has two failures to choose between rather than a success to
    // convert. E7b is the same arrangement with a document that succeeded.
    const run = yield* withHeldHost(
      {
        stream,
        root: { path: "host/main-fails.md", source: "<Held />\n<Boom />\n" },
        installations: [
          {
            components: [
              {
                name: "Boom",
                origin: "test://main",
                props: NO_PROPS,
                description: "Fail the main document for an ordinary reason.",
                factory: () =>
                  // deno-lint-ignore require-yield
                  function* (): Operation<Json> {
                    throw new Error("the document's own later failure");
                  },
              },
            ],
          },
          // Only the probe: this row's document registers its own `<Boom />`,
          // and declaring the generated one as well would be one name with two
          // definitions.
          selecting([probe(invoked)]),
        ],
      },
      function* (open) {
        stream.onAppend = (event) => {
          if (event.type === "yield" && event.description.type === "generated_xmd") {
            throw new Error("the journal stopped accepting appends");
          }
        };
        try {
          yield* open.execution.evaluateGeneratedXmdRoot(
            request("<Output>\n<Probe />\n</Output>\n", invoked),
          );
        } catch (error) {
          caught.raised = error;
        }
        stream.onAppend = null;
      },
    );

    // Ranked by kind rather than by which failure the document happened to
    // report last: a journal that stopped describing this run is fatal, the
    // component's refusal is not, and the fatal one is reported by identity.
    expect(durabilityFailure(caught.raised)).not.toBe(undefined);
    expect(run.completion.ok).toBe(false);
    expect(durabilityFailure(run.completion.ok ? undefined : run.completion.error)).toBe(
      durabilityFailure(caught.raised),
    );
    expect(invoked).toEqual([]);
  });

  it("E7e: a history read that fails reaches the caller as itself, not as a closure", function* () {
    const stream = new InMemoryStream();
    const failure = new DurablePersistenceError("yield", new Error("this history cannot be read"));
    const caught: { raised?: unknown; answered: boolean } = { answered: false };

    // Finding the address an evaluation runs on reads this execution's journal,
    // and that read is the first thing the first evaluation does. A failure
    // there is a different path from E7b's append: it happens before the
    // sequence exists, where there is no answer and no join yet.
    const run = yield* withHeldHost(
      { stream, installations: [selecting([probe()])] },
      function* (open) {
        const reads = stream.readAll.bind(stream);
        // deno-lint-ignore require-yield
        stream.readAll = function* () {
          throw failure;
        };
        try {
          yield* open.execution.evaluateGeneratedXmdRoot(
            request("<Output>\n<Probe />\n</Output>\n"),
          );
          caught.answered = true;
        } catch (error) {
          caught.raised = error;
        }
        stream.readAll = reads;
      },
    );

    // The failure itself, in the caller's own frame. A `Result` here would be
    // an answer about availability — the caller would read "this execution
    // closed" and never learn that its journal had stopped being readable.
    expect(caught.answered).toBe(false);
    expect(caught.raised).toBe(failure);
    expect(run.completion.ok).toBe(false);
  });

  it("E7f: an authoritative evaluation failure of no classified kind is still the run's", function* () {
    const caught: { raised?: unknown } = {};

    // A failed evaluation teardown is neither a durability nor a Files
    // failure, so the classified tiers do not reach it — and the document
    // fails afterwards for an ordinary reason of its own. Which of the two the
    // completion reports is decided by occurrence, and the evaluation's came
    // first.
    const run = yield* withHeldHost(
      {
        root: { path: "host/ranking.md", source: "<Held />\n<Boom />\n" },
        installations: [{ components: [failingMain()] }, selecting([probe(), failingCleanup()])],
      },
      function* (open) {
        try {
          yield* open.execution.evaluateGeneratedXmdRoot({
            id: "turn-1",
            source: "<Output>\n<Leak />\n</Output>\n",
          });
        } catch (error) {
          caught.raised = error;
        }
      },
    );

    // The object the caller was handed, not a rebuilt one carrying its words.
    expect(caught.raised).toBeInstanceOf(Error);
    expect(run.completion.ok).toBe(false);
    expect(run.completion.ok ? undefined : run.completion.error).toBe(caught.raised);
  });

  it("E7g: the same failure is the run's when the document succeeded — by identity", function* () {
    const caught: { raised?: unknown } = {};

    // The control for E7f. E7c already states that such a run does not report
    // success; what this adds is that the completion is the *same* failure, so
    // E7f's row is about ranking rather than about reporting one at all.
    const run = yield* withHeldHost({ installations: [selecting(declared())] }, function* (open) {
      try {
        yield* open.execution.evaluateGeneratedXmdRoot({
          id: "turn-1",
          source: "<Output>\n<Leak />\n</Output>\n",
        });
      } catch (error) {
        caught.raised = error;
      }
    });

    expect(caught.raised).toBeInstanceOf(Error);
    expect(run.completion.ok).toBe(false);
    expect(run.completion.ok ? undefined : run.completion.error).toBe(caught.raised);
  });
});

/**
 * The selection a host states when it also names canonical `<Syntax />`.
 *
 * No answer provider for it: `Syntax` is a protected component, so canonical
 * resolution answers for it from core's own tier and the capture retains *this
 * execution's* minted implementation behind its routed guard. That is the whole
 * point of the rows below — the captured row and core's own copy are the same
 * implementation, reached two ways.
 */
function selectingWithSyntax(entries: readonly GeneratedObservation[]): ExecutionInstallation {
  return {
    componentAnswers: entries.map((entry) => answerProvider(entry.name, entry.definition)),
    *install(): Operation<void> {
      yield* useSelection({
        ...Object.fromEntries(entries.map((entry) => [entry.name, ["self-closing"]])),
        Syntax: ["self-closing"],
      });
    },
  };
}

/** The rows one admission retained, read off the record it wrote. */
function retainedRows(events: readonly DurableEvent[]): { name: string; kind?: string }[] {
  const [admission] = admissions(events);
  if (admission?.type !== "yield" || admission.result.status !== "ok") {
    throw new Error("the run recorded no generated-XMD admission");
  }
  const record = admission.result.value;
  const policy = isObject(record) ? record.policy : undefined;
  const allowed = isObject(policy) ? policy.allowed : undefined;
  if (!Array.isArray(allowed)) {
    throw new Error("the admission record holds no allowed rows");
  }
  return allowed.filter(isObject).map((row) => ({
    name: String(row.name),
    ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
  }));
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many times this exact text occurs, for a listing that must name a thing once. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("Tier E8 — the captured selection holds canonical Syntax once", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * The regression. A host's ordinary selection may name `Syntax` — main's own
   * does — and the capture then holds this execution's protected implementation
   * behind its routed guard. Core adding its copy beside that one offered a
   * root the same name under two definitions, which admission refuses, so every
   * valid root of such a host failed. The row drives the real held host rather
   * than the selection machinery, because the collision was between two things
   * only a real capture produces.
   */
  it("E8a: a host that selected Syntax evaluates, and retains one Syntax row", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const answered: { output?: string } = {};
    const run = yield* withHeldHost(
      { stream, installations: [selectingWithSyntax([probe(invoked)])] },
      function* (open) {
        answered.output = rendered(
          yield* open.execution.evaluateGeneratedXmdRoot(
            request("<Output>\n<Syntax />\n<Probe />\n</Output>\n", invoked),
          ),
        ).output;
      },
    );

    expect(run.completion.ok).toBe(true);
    // Ordinary Syntax evaluation, under the selection that used to collide: the
    // vocabulary rendered and the admitted control ran.
    expect(invoked).toEqual(["probed"]);
    expect(answered.output).toContain("Probe");

    // Once in the recorded policy, which is the admission's own account of what
    // this root may write.
    const rows = retainedRows(yield* stream.readAll());
    expect(rows.filter((row) => row.name === "Syntax")).toHaveLength(1);
    expect(rows.map((row) => row.name)).toEqual(["Json", "Yaml", "Probe", "Syntax"]);
    // And once in the descriptive vocabulary, which is the other reading of the
    // same selection: a second entry would render a second section.
    expect(occurrences(answered.output ?? "", "### `<Syntax>`")).toBe(1);
  });

  it("E8b: a host that selected none of it reaches core's own, also once", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const answered: { output?: string } = {};
    const run = yield* withHeldHost(
      { stream, installations: [selecting([probe(invoked)])] },
      function* (open) {
        answered.output = rendered(
          yield* open.execution.evaluateGeneratedXmdRoot(
            request("<Output>\n<Syntax />\n<Probe />\n</Output>\n", invoked),
          ),
        ).output;
      },
    );

    // The control, and the reason E8a is about *recognizing* a captured row
    // rather than about dropping core's: a host that named nothing of it still
    // gets the one protected answer a root may write.
    expect(run.completion.ok).toBe(true);
    expect(invoked).toEqual(["probed"]);
    const rows = retainedRows(yield* stream.readAll());
    expect(rows.filter((row) => row.name === "Syntax")).toHaveLength(1);
    expect(rows.map((row) => row.name)).toEqual(["Json", "Yaml", "Probe", "Syntax"]);
    expect(occurrences(answered.output ?? "", "### `<Syntax>`")).toBe(1);
  });
});

describe("Tier E9 — an availability refusal is the call's answer", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * What the bound method distinguishes, and why it matters here.
   *
   * A host that asked this execution for something it does not offer has an
   * answer to act on: it catches the refusal, releases the document it was
   * holding, and goes on. Raising instead made the *document's* completion
   * fail — so a host could catch the method's refusal and still be handed a
   * failed canonical run for a question somebody asked it. The run's own
   * failures (E7) keep their authority; these two are not among them.
   */
  it("E9a: a host that selected no generated components refuses, and its document completes", function* () {
    const stream = new InMemoryStream();
    const answer: { value?: Result<GeneratedXmdRootResult> } = {};
    const run = yield* withHeldHost({ stream }, function* (open) {
      answer.value = yield* open.execution.evaluateGeneratedXmdRoot(
        request("<Output>\nReady.\n</Output>\n"),
      );
    });

    expect(answer.value?.ok).toBe(false);
    expect(answer.value?.ok === false && answer.value.error).toBeInstanceOf(HostExecutionError);
    expect(answer.value?.ok === false && answer.value.error.message).toContain(
      "selected no generated components",
    );
    // The document is the host's, and it finished on its own terms.
    expect(run.completion.ok).toBe(true);
    // Nothing was admitted, so nothing performed.
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
  });

  it("E9b: a class this host installed nothing for refuses, and its document completes", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const answer: { value?: Result<GeneratedXmdRootResult> } = {};
    const run = yield* withHeldHost(
      { stream, installations: [selecting([probe(invoked)])] },
      function* (open) {
        answer.value = yield* open.execution.evaluateGeneratedXmdRoot({
          id: "turn-1",
          source: "<Output>\nReady.\n</Output>\n",
          allow: ["write"],
        });
      },
    );

    expect(answer.value?.ok).toBe(false);
    expect(answer.value?.ok === false && answer.value.error.message).toContain(
      "installed no write table",
    );
    expect(run.completion.ok).toBe(true);
    expect(invoked).toEqual([]);
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
  });

  it("E9c: a class this host did install answers, and its document completes", function* () {
    const stream = new InMemoryStream();
    const invoked: string[] = [];
    const answer: { value?: Result<GeneratedXmdRootResult> } = {};
    const run = yield* withHeldHost(
      { stream, installations: [selecting([probe(invoked)])] },
      function* (open) {
        answer.value = yield* open.execution.evaluateGeneratedXmdRoot({
          id: "turn-1",
          source: "<Output>\n<Probe />\n</Output>\n",
          allow: ["read"],
        });
      },
    );

    // The control for both arms above: the same method, the same document, and
    // an available class reaches the work and records it.
    expect(answer.value?.ok).toBe(true);
    expect(run.completion.ok).toBe(true);
    expect(invoked).toEqual(["probed"]);
    expect(admissions(yield* stream.readAll())).toHaveLength(1);
  });

  /**
   * The accepted public request, written the way a trusted host writes it.
   *
   * Typed through `@executablemd/core/host` rather than through the module the
   * evaluator lives in, so the four decided members and the class name the
   * request uses are checked at the published boundary.
   */
  it("E9d: the public request is the four-member shape, typed through core/host", function* () {
    const invoked: string[] = [];
    const classes: readonly GeneratedEffectClass[] = ["read"];
    const asked: GeneratedXmdRequest = {
      id: "turn-1",
      source: "<Output>\n<Probe />\n</Output>\n",
      allow: classes,
      position: { line: 1, column: 1, offset: 0 },
    };
    const answer: { value?: Result<GeneratedXmdRootResult> } = {};
    const run = yield* withHeldHost(
      { installations: [selecting([probe(invoked)])] },
      function* (open) {
        answer.value = yield* open.execution.evaluateGeneratedXmdRoot(asked);
      },
    );

    expect(run.completion.ok).toBe(true);
    expect(rendered(answer.value ?? { ok: false, error: new Error("none") }).output).toContain(
      "probed",
    );
  });
});
