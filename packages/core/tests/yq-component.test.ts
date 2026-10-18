/**
 * Tier YQ — selecting out of what a component returned (spec §6.21).
 *
 * `yq` is one shared invocation attribute, so what these cases discriminate is
 * the engine's own route rather than any producer's: when the engine is built,
 * what one answer may be, where the selection sits between acceptance and
 * binding, and what an invocation that wrote a query renders when it captures
 * nothing.
 *
 * Three harnesses, and they answer different questions. The owner is driven
 * directly where the question is about initialization — how many compilations one
 * execution starts, whether two first consumers share one, and what a halted
 * consumer does with an engine that arrives afterwards — because those are
 * facts about that object and a document cannot observe them. Real `execute`
 * with real host files drives everything about the route. And one controlled
 * evaluator appears exactly once, for the non-JSON answer a normal vendor reply
 * never produces.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, ensure, scoped, spawn, until } from "effection";
import type { Operation, Result, Task } from "effection";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, writeTextFile } from "@effectionx/fs";
import { API, useHostFiles } from "@executablemd/runtime";
import { FilesOperationDeniedError, parseFilesFatal } from "@executablemd/runtime/files";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";

import { collect } from "../src/collect.ts";
import { execute, executeInstalled } from "../src/execute.ts";
import { registerComponents } from "../src/components/registration.ts";
import { scanSegments } from "../src/scanner.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { fatalCause } from "../src/errors.ts";
import { createYq } from "yq.rs/loader";
import type { Yq } from "yq.rs/loader";
import { createValueQuery, ONE_VALUE } from "../src/value-query.ts";
import { ComponentResult } from "../api.ts";
import type { EngineFactory } from "../src/value-query.ts";
import { Component } from "../src/component-api.ts";
import type { ComponentRegistration } from "../src/components/registration.ts";
import type { ComponentDefinition, JsonObject } from "../src/types.ts";

/**
 * A directory the contextual cwd points at, removed when the case ends.
 *
 * A plain generator rather than a `resource`, because what it installs has to
 * belong to the *case's* frame: a resource's body is its own scope, so a
 * contextual working directory established there would be invisible to the
 * document the case then runs.
 */
function* useWorkspace(files: Record<string, string>): Operation<string> {
  const made = yield* until(mkdtemp(join(tmpdir(), "yq-component-")));
  yield* ensure(() => rm(made, { recursive: true, force: true }));
  const root = yield* until(realpath(made));
  for (const [name, content] of Object.entries(files)) {
    yield* writeTextFile(join(root, name), content);
  }
  yield* API.Env.around(
    {
      *cwd() {
        return root;
      },
    },
    { at: "min" },
  );
  return root;
}

/** What one run produced, what its journal holds, and what it reached. */
interface Run {
  readonly outcome: Result<Json>;
  readonly stream: InMemoryStream;
  /** Every filesystem operation that crossed the provider boundary, in order. */
  readonly crossed: readonly string[];
}

/** What a case makes resolvable beside core's own components. */
interface Supplied {
  /** Function components, registered the way a package registers one. */
  readonly registered?: readonly ComponentRegistration[];
  /** Markdown definitions, answered through the ordinary import chain. */
  readonly markdown?: readonly ComponentDefinition[];
  /** A log the result seam writes to, for a case about completion order. */
  readonly watching?: string[];
}

/** Run `source` as a document in `root`, with `supplied` resolvable. */
function runDocument(root: string, source: string, supplied: Supplied = {}): Operation<Run> {
  return scoped(function* () {
    const crossed: string[] = [];
    // Counted where the operation actually crosses, because an ordinary `xmd
    // run` journals no file work: what proves a producer ran once is the
    // provider boundary it ran through.
    yield* API.Files.around({
      *readTextFile([input], next) {
        crossed.push(`read:${input.path}`);
        return yield* next(input);
      },
      *globFiles([input], next) {
        crossed.push("glob");
        return yield* next(input);
      },
    });
    yield* useHostFiles();
    if (supplied.watching !== undefined) {
      const order = supplied.watching;
      yield* ComponentResult.around({
        *result([request], next) {
          if (request.query !== undefined) {
            order.push("result middleware");
          }
          return yield* next(request);
        },
      });
    }
    if (supplied.registered !== undefined && supplied.registered.length > 0) {
      yield* registerComponents([...supplied.registered]);
    }
    const definitions = new Map(
      (supplied.markdown ?? []).map((definition) => [definition.name, definition]),
    );
    if (definitions.size > 0) {
      yield* Component.around({
        *importComponent([name, position], next) {
          const held = definitions.get(name);
          return held === undefined ? yield* next(name, position) : held;
        },
      });
    }
    const stream = new InMemoryStream();
    yield* writeTextFile(join(root, "doc.md"), source);
    let outcome: Result<Json>;
    try {
      outcome = Ok(yield* collect(yield* execute({ path: join(root, "doc.md"), stream })));
    } catch (error) {
      outcome = Err(error instanceof Error ? error : new Error(String(error)));
    }
    return { outcome, stream, crossed };
  });
}

/** The rendered text of a successful run, or the failure's own message. */
function text(run: Run): string {
  if (!run.outcome.ok) {
    throw run.outcome.error;
  }
  return typeof run.outcome.value === "string"
    ? run.outcome.value
    : JSON.stringify(run.outcome.value);
}

/** Every durable description one run appended, in order. */
function descriptions(stream: InMemoryStream): string[] {
  return stream
    .snapshot()
    .flatMap((event: DurableEvent) =>
      event.type === "yield" ? [String(event.description.type)] : [],
    );
}

/**
 * How many WebAssembly compilations happen while `body` runs.
 *
 * The loader compiles exactly once per engine, through the platform's own
 * `WebAssembly.compile`, so counting that call is how a document's own
 * execution is asked whether it started an engine at all. Restored in a
 * `finally` rather than an `ensure`, because the replacement is synchronous
 * state that must be back before anything else in this process compiles.
 */
function compilations<T>(body: () => Operation<T>): Operation<{ value: T; started: number }> {
  return {
    *[Symbol.iterator]() {
      const original = WebAssembly.compile;
      let started = 0;
      WebAssembly.compile = (source: BufferSource): Promise<WebAssembly.Module> => {
        started += 1;
        return original(source);
      };
      try {
        return { value: yield* body(), started };
      } finally {
        WebAssembly.compile = original;
      }
    },
  };
}

const FIXTURE = JSON.stringify({
  records: [
    { name: "a", status: "ok" },
    { name: "b", status: "failed" },
  ],
});

/** E3's exact File expression, as the frozen matrix states it. */
const FAILED_RECORDS = 'from_json | [.records[] | select(.status == "failed") | {"name": .name}]';

/** E3's exact Glob expression. */
const INPUT_PATHS = '[.[] | select(. == "input.json") | {"path": .}]';

describe("Tier YQ — one engine per execution, built when it is wanted", () => {
  beforeAll(() => useTempFileCompiler());

  it("YQ1: a document that queries nothing and renders no YAML compiles nothing", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const counted = yield* compilations(() =>
      runDocument(root, '<File path="input.json" as="raw" />\n\n{raw.length}\n'),
    );

    expect(counted.value.outcome.ok).toBe(true);
    // The claim, and the whole reason the engine is lazy: an execution that
    // asked nothing of it paid for nothing.
    expect(counted.started).toBe(0);
  });

  it("YQ1: two queries and one Yaml in one execution compile once", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const counted = yield* compilations(() =>
      runDocument(
        root,
        [
          `<File path="input.json" yq='from_json | .records[0].name' as="first" />`,
          "",
          `<File path="input.json" yq='from_json | .records[1].name' as="second" />`,
          "",
          "<Output>",
          "{first}{second} <Yaml value={first} />",
          "</Output>",
          "",
        ].join("\n"),
      ),
    );

    expect(counted.value.outcome.ok).toBe(true);
    expect(text(counted.value).replace(/\s+/g, " ").trim()).toBe("ab a");
    expect(counted.started).toBe(1);
  });

  it("YQ1: a second independent execution builds a second engine", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const source = `<File path="input.json" yq='from_json | .records[0].name' as="first" />\n\n{first}\n`;
    const counted = yield* compilations(function* () {
      const first = yield* runDocument(root, source);
      const second = yield* runDocument(root, source);
      return [first, second];
    });

    expect(counted.value.map((run) => run.outcome.ok)).toEqual([true, true]);
    // One each. An engine shared across executions would have outlived the one
    // that paid for it, and the second execution would have compiled nothing.
    expect(counted.started).toBe(2);
  });

  it("YQ1: two first consumers share one initialization", function* () {
    const gate = openGate();
    const asked = openGate();
    let factories = 0;
    const held: EngineFactory = function (bytes: Uint8Array) {
      factories += 1;
      asked.open();
      return gate.opened.then(() => realEngine(bytes));
    };
    const owner = createValueQuery(held);

    const answers: Result<Json>[] = [];
    const first = yield* spawn(function* () {
      answers.push(Ok(yield* owner.select(".", [1, 2])));
    });
    // The first consumer has created the pending initialization and suspended
    // on it, which is the state the second one has to arrive into. Waited for
    // rather than assumed: yielding a spawn says nothing about where the child
    // has reached.
    yield* until(asked.opened);
    expect(factories).toBe(1);
    const second = yield* spawn(function* () {
      answers.push(Ok(yield* owner.select(".", [3, 4])));
    });
    gate.open();
    yield* first;
    yield* second;

    // One compilation for two consumers: the pending promise is stored before
    // the first one suspends, so the second finds it rather than starting
    // another.
    expect(factories).toBe(1);
    expect(answers.map((answer) => answer.ok)).toEqual([true, true]);
    owner.close();
  });

  it("YQ1: an engine that arrives after a halt publishes nothing", function* () {
    const gate = openGate();
    const asked = openGate();
    const reached: string[] = [];
    // The factory's own promise, kept: `gate.opened` only *starts* the real
    // engine, and a case that waited on the gate would be asserting before the
    // vendor had produced anything at all.
    let engine: Promise<Yq> | undefined;
    const held: EngineFactory = (bytes: Uint8Array) => {
      asked.open();
      engine = gate.opened.then(() => realEngine(bytes));
      return engine;
    };
    const owner = createValueQuery(held);

    const waiting: Task<void> = yield* spawn(function* () {
      yield* ensure(() => {
        reached.push("torn down");
      });
      yield* owner.select(".", [1, 2]);
      // Never reached: the continuation past `until` is exactly what a halt
      // prevents, however the vendor's own promise settles.
      reached.push("published");
    });
    // Halted while the initialization is genuinely pending, which is the state
    // this is about — not before the consumer started.
    yield* until(asked.opened);
    yield* waiting.halt();
    // Released after the halt, and then *settled*: this waits for the engine
    // the vendor actually built, which is the moment a resumed continuation
    // would have had something to publish.
    gate.open();
    expect(engine).not.toBe(undefined);
    const settled = yield* until(engine ?? Promise.reject(new Error("no engine was started")));
    expect(settled).not.toBe(undefined);

    // The halted task came down — `halt()` returns once its teardown has run,
    // and the marker is that teardown — and its downstream continuation never
    // ran, with the engine now genuinely settled behind it.
    expect(reached).toEqual(["torn down"]);
    owner.close();
  });

  it("YQ1: an owner revoked with its execution refuses", function* () {
    const owner = createValueQuery();
    expect(yield* owner.select(".", 1)).toBe(1);
    owner.close();
    let refusal: string | undefined;
    try {
      yield* owner.select(".", 1);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("no longer available");
  });
});

/** A real engine for the controlled-factory cases above. */
function realEngine(bytes: Uint8Array): Promise<Yq> {
  return createYq(bytes);
}

/**
 * A promise a case opens by hand.
 *
 * The factory this gates returns a promise, so what holds it open has to be one
 * too: an Effection resolver would never be observed by the vendor contract
 * this stands in for.
 */
function openGate(): { readonly opened: Promise<void>; open: () => void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { opened, open: () => open() };
}

describe("Tier YQ — what one answer may be", () => {
  beforeAll(() => useTempFileCompiler());

  /** One selection through the real pinned loader. */
  function* selected(expression: string, value: unknown): Operation<Result<Json>> {
    const owner = createValueQuery();
    try {
      return Ok(yield* owner.select(expression, value));
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    } finally {
      owner.close();
    }
  }

  it("YQ2: a field selection, and the four answers that are values", function* () {
    expect(
      yield* selected("from_json | .scripts", JSON.stringify({ scripts: { a: "b" } })),
    ).toEqual(Ok({ a: "b" }));
    // Each of these is a value a document may legitimately select, and each is
    // the vendor status `evaluate` throws for — which is why selection uses
    // `evaluateWithStatus` and ignores `matched`.
    expect(yield* selected("null", [1, 2])).toEqual(Ok(null));
    expect(yield* selected("false", [1, 2])).toEqual(Ok(false));
    expect(yield* selected("[]", [1, 2])).toEqual(Ok([]));
    expect(yield* selected('"x\\ny"', [1, 2])).toEqual(Ok("x\ny"));
  });

  it("YQ2: no results and several results each refuse with the array guidance", function* () {
    const zero = yield* selected(".[] | select(. == 9)", [1, 2]);
    const several = yield* selected(".[]", [1, 2]);

    expect(zero.ok).toBe(false);
    expect(several.ok).toBe(false);
    // One sentence for both, because an invocation that binds one value has
    // the same thing to say about neither and two.
    expect(zero.ok === false && zero.error.message).toBe(ONE_VALUE);
    expect(several.ok === false && several.error.message).toBe(ONE_VALUE);
  });

  it("YQ2: an invalid expression binds nothing and keeps the vendor's reason", function* () {
    const refused = yield* selected("!!!", [1, 2]);

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error.message).toContain("could not be evaluated");
    // The vendor's own account survives as the cause, for ordinary error
    // handling, without being consumed as an answer.
    expect(refused.ok === false && refused.error.cause).toBeDefined();
  });

  it("YQ2: a string holding JSON stays a string until it is decoded", function* () {
    const held = JSON.stringify({ count: 2 });
    // `.` over a JSON string is that string. Nothing decodes on the way in,
    // which is why an expression that wants the data inside says so.
    expect(yield* selected(".", held)).toEqual(Ok(held));
    expect(yield* selected("from_json | .count", held)).toEqual(Ok(2));
    expect(yield* selected("from_yaml | .count", "count: 2\n")).toEqual(Ok(2));
  });

  it("YQ2: the engine sees no environment, no files and this host's clock never", function* () {
    // The canaries are set for this process; the engine is given an empty
    // environment and an empty file map, so neither is reachable through an
    // expression a document or an agent wrote.
    const canary = yield* selected("env(XMD_YQ_CANARY)", [1]);
    const file = yield* selected('load("/etc/passwd")', [1]);

    expect(canary.ok).toBe(false);
    expect(canary.ok === false && canary.error.message).toContain("not provided");
    expect(file.ok).toBe(false);
    expect(yield* selected("now", [1])).toEqual(Ok("1970-01-01T00:00:00Z"));
  });

  it("YQ2: a non-JSON answer with partial output is refused rather than consumed", function* () {
    // The one controlled evaluator in this file. A real vendor answer under
    // JSON output is always JSON, so the only way to ask what happens to one
    // that is not is to supply it — and what must not happen is a partial
    // reading becoming a bound value.
    const owner = createValueQuery(() =>
      Promise.resolve({
        evaluate: () => "",
        evaluateSequenceWithStatus: () => ({ output: "", matched: false }),
        evaluateWithStatus: () => ({ output: "{ half", matched: true }),
      }),
    );
    let refusal: string | undefined;
    try {
      yield* owner.select(".", [1]);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBe(ONE_VALUE);
    owner.close();
  });

  it("YQ2: an evaluator that throws with partial output keeps its cause", function* () {
    // The other branch, and the one a vendor actually takes when it fails
    // partway: it raises rather than returning. What a document must not get
    // is the text it had produced before it gave up — and what a reader must
    // keep is why it gave up.
    const broke = new Error("the vendor abandoned this evaluation");
    const owner = createValueQuery(() =>
      Promise.resolve({
        evaluate: () => "",
        evaluateSequenceWithStatus: () => ({ output: "", matched: false }),
        evaluateWithStatus: () => {
          // Partial output exists, and it leaves with the failure rather than
          // being returned beside it.
          throw Object.assign(broke, { output: "[1" });
        },
      }),
    );
    let raised: unknown;
    try {
      yield* owner.select(".", [1]);
    } catch (error) {
      raised = error;
    }

    // Reported as the evaluation it was, and the vendor's own failure is
    // reachable underneath rather than replaced by a summary of it.
    expect(raised instanceof Error && raised.name).toBe("ValueQueryError");
    expect(raised instanceof Error && raised.message).toContain("could not be evaluated");
    expect(raised instanceof Error && raised.cause).toBe(broke);
    // And nothing partial came back: the refusal is the whole answer.
    expect(raised instanceof Error && raised.message).not.toContain("[1");
    owner.close();
  });
});

describe("Tier YQ — two real producers select before they bind", () => {
  beforeAll(() => useTempFileCompiler());

  it("YQ3: File and Glob each run once and bind what their expression selected", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const run = yield* runDocument(
      root,
      [
        `<File path="input.json" yq='${FAILED_RECORDS}' as="failed" />`,
        "",
        `<Glob include={["*.json"]} yq='${INPUT_PATHS}' as="paths" />`,
        "",
        "<Output>",
        "<Json value={failed} />",
        "<Json value={paths} />",
        "</Output>",
        "",
      ].join("\n"),
    );

    expect(run.outcome.ok).toBe(true);
    // The selected data, as the frozen matrix states it — and what the document
    // renders is the *binding*, so what reached it is the value rather than the
    // text the producer returned.
    const rendered = text(run);
    expect(JSON.parse(rendered.slice(rendered.indexOf("["), rendered.indexOf("]") + 1))).toEqual([
      { name: "b" },
    ]);
    expect(rendered).toContain('"path": "input.json"');
    // One read and one search, and the raw file text is nowhere in the
    // document: a query is not a second operation and the original return is
    // not what was bound.
    expect(run.crossed).toEqual(["read:input.json", "glob"]);
    expect(rendered).not.toContain("status");
  });

  it("YQ3: a closed props schema accepts a queried invocation without seeing yq", function* () {
    const root = yield* useWorkspace({});
    // `additionalProperties: false`, and the invocation writes `yq`. The engine
    // consumes it before this schema is checked, so the producer never sees it.
    const run = yield* runDocument(
      root,
      `<Closed label="x" yq='.kept' as="picked" />\n\n{picked}\n`,
      { registered: [closedProducer()] },
    );

    expect(run.outcome.ok).toBe(true);
    expect(text(run).trim()).toBe("yes");
  });

  it("YQ3: a non-string yq refuses before the producer runs", function* () {
    const root = yield* useWorkspace({});
    const calls = { count: 0 };
    const run = yield* runDocument(root, `<Counted yq={7} as="picked" />\n\n{picked}\n`, {
      registered: [countedProducer(calls)],
    });

    expect(run.outcome.ok).toBe(false);
    expect(run.outcome.ok === false && run.outcome.error.message).toContain('Prop "yq"');
    expect(calls.count).toBe(0);
  });

  it("YQ3: an invalid as refuses before the producer runs, query or no query", function* () {
    const root = yield* useWorkspace({});
    const calls = { count: 0 };
    const run = yield* runDocument(root, `<Counted yq='.kept' as="not a name" />\n`, {
      registered: [countedProducer(calls)],
    });

    expect(run.outcome.ok).toBe(false);
    expect(calls.count).toBe(0);
  });

  it("YQ3: an uncaptured returns component still refuses required-as with a query", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const calls = { count: 0 };
    const run = yield* runDocument(root, `<Counted yq='.kept' />\n`, {
      registered: [countedProducer(calls)],
    });

    expect(run.outcome.ok).toBe(false);
    expect(run.outcome.ok === false && run.outcome.error.message).toContain("`returns`");
    // Before effects: a query is not a destination, and a component that
    // renders nothing still has nowhere to put what it produced.
    expect(calls.count).toBe(0);
  });

  it("YQ3: an uncaptured Glob with a query keeps its own refusal", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const run = yield* runDocument(root, `<Glob include={["*.json"]} yq='.' />\n`);

    expect(run.outcome.ok).toBe(false);
    expect(descriptions(run.stream)).not.toContain("glob");
  });
});

describe("Tier YQ — acceptance, teardown, then selection", () => {
  beforeAll(() => useTempFileCompiler());

  it("YQ4: a Markdown value body's own schema accepts first, and its cleanup finishes", function* () {
    const root = yield* useWorkspace({});
    const run = yield* runDocument(root, `<Record yq='.name' as="picked" />\n\n{picked}\n`, {
      markdown: [recordComponent()],
    });

    expect(run.outcome.ok).toBe(true);
    // An object under its own `returns`, then a scalar after the query. The
    // selection happens after acceptance, so the schema never saw the scalar.
    expect(text(run).trim()).toBe("widget");
  });

  it("YQ4: a queried Markdown body finishes before the result is selected", function* () {
    // The completion order a reader of the history depends on, with the query
    // in place: everything the component's own body still had to do — a later
    // element and the cleanup that element owns — happens before the result
    // middleware is asked and before anything is captured.
    const root = yield* useWorkspace({});
    const order: string[] = [];
    const run = yield* runDocument(root, `<Finishing yq='.name' as="picked" />\n\n{picked}\n`, {
      markdown: [finishingComponent()],
      registered: [sentinel(order)],
      watching: order,
    });

    expect(run.outcome.ok).toBe(true);
    expect(text(run).trim()).toBe("widget");
    // The sentinel ran after `<Return>`, its own cleanup unwound, and only
    // then was the result composed and bound.
    expect(order).toEqual(["sentinel body", "sentinel teardown", "result middleware"]);
  });

  it("YQ4: no expression repairs a return its own schema rejected", function* () {
    const root = yield* useWorkspace({});
    const run = yield* runDocument(root, `<Wrong yq='1' as="picked" />\n`, {
      markdown: [wrongComponent()],
    });

    expect(run.outcome.ok).toBe(false);
    // The original validation's own refusal, not a query failure: `yq='1'`
    // would have produced a valid answer, and it is never asked.
    expect(run.outcome.ok === false && run.outcome.error.message).not.toContain("yq");
  });

  it("YQ4: a function component's query runs after its invocation joined", function* () {
    const root = yield* useWorkspace({});
    const order: string[] = [];
    const run = yield* runDocument(root, `<Joined yq='.name' as="picked" />\n\n{picked}\n`, {
      registered: [joinedProducer(order)],
    });

    expect(run.outcome.ok).toBe(true);
    expect(text(run).trim()).toBe("widget");
    // Teardown before selection, which is what "the producer's own cleanup
    // finishes first" means where a reader can see it.
    expect(order).toEqual(["body", "teardown"]);
  });

  it("YQ4: a teardown failure prevents the selection and the capture", function* () {
    const root = yield* useWorkspace({});
    const run = yield* runDocument(root, `<Breaking yq='.name' as="picked" />\n\n{picked}\n`, {
      registered: [breakingProducer()],
    });

    expect(run.outcome.ok).toBe(false);
  });

  it("YQ4: a Files infrastructure failure stays fatal through a query", function* () {
    const root = yield* useWorkspace({});
    const run = yield* runDocument(root, `<Denied yq='.name' as="picked" />\n\n{picked}\n`, {
      registered: [deniedProducer()],
    });

    expect(run.outcome.ok).toBe(false);
    const raised = run.outcome.ok ? undefined : run.outcome.error;
    // Still the same infrastructure failure, by identity and by its own fixed
    // diagnostic. The selection route is a place this failure passed through
    // rather than a place it was described: a build that had wrapped it as a
    // query refusal, or printed it and carried on, would answer differently
    // here and would have let the document report it as its own.
    expect(parseFilesFatal(fatalCause(raised))).toEqual({
      type: "executablemd.runtime.files-fatal/v1",
      kind: "operation-denied",
      operation: "temporary-directory",
    });
    expect(raised?.message).not.toContain("yq");
    // Nothing was selected, bound or published: the failure happened in the
    // producer, so there was never a result for an expression to read.
    expect(descriptions(run.stream)).not.toContain("root_binding_publication");
  });

  it("YQ4: a queried rendering emits only its selected string", function* () {
    const root = yield* useWorkspace({});
    // The body renders text that looks like a marker. Queried, only the
    // selected string reaches the document; unqueried, the body's own text
    // does, exactly as it always did.
    const queried = yield* runDocument(root, `<Sentence yq='from_json | .kept' />\n`, {
      markdown: [sentenceComponent()],
    });
    const ordinary = yield* runDocument(root, `<Sentence />\n`, {
      markdown: [sentenceComponent()],
    });

    expect(queried.outcome.ok).toBe(true);
    expect(text(queried).trim()).toBe("kept");
    expect(text(queried)).not.toContain("RAW-MARKER");
    expect(ordinary.outcome.ok).toBe(true);
    expect(text(ordinary)).toContain("RAW-MARKER");
  });
});

describe("Tier YQ — what the ordinary result retains", () => {
  beforeAll(() => useTempFileCompiler());

  it("YQ5: the retained result holds the selected value, not the original", function* () {
    // The selected value is ordinary binding data at the corrected parent:
    // the capture assigns it to the real environment, and the execution's own
    // computed-bindings resource carries current eligible root data onto the
    // ordinary result. There is no per-name publication to look for.
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const stream = new InMemoryStream();
    const crossed: string[] = [];
    const read = yield* scoped(function* () {
      yield* API.Files.around({
        *readTextFile([input], next) {
          crossed.push(`read:${input.path}`);
          return yield* next(input);
        },
      });
      yield* useHostFiles();
      yield* writeTextFile(
        join(root, "doc.md"),
        `<File path="input.json" yq='${FAILED_RECORDS}' as="failed" />\n\n{failed.length}\n`,
      );
      const execution = yield* executeInstalled({ path: join(root, "doc.md"), stream }, []);
      const outcome = yield* execution;
      expect(outcome.ok).toBe(true);
      // Read from the settled execution, which answers from its own accepted
      // result rather than by running anything again.
      const held = yield* execution.bindings();
      if (!held.ok) {
        throw held.error;
      }
      return held.value;
    });

    // The selected data, under the name the capture bound — and nothing of the
    // record the producer actually returned.
    expect(read["failed"]).toEqual([{ name: "b" }]);
    expect(JSON.stringify(read["failed"])).not.toContain("status");
    // One producer, counted where the operation crosses the provider.
    expect(crossed).toEqual(["read:input.json"]);
    // And no per-binding publication record of any kind.
    expect(descriptions(stream)).not.toContain("root_binding");
  });

  it("YQ5: a cold reading of the accepted result repeats no producer", function* () {
    // The same run restored from what it retained: the result is read back
    // without executing the document again, so the producer is not called a
    // second time and nothing is appended.
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      yield* useHostFiles();
      yield* writeTextFile(
        join(root, "doc.md"),
        `<File path="input.json" yq='${FAILED_RECORDS}' as="failed" />\n\n{failed.length}\n`,
      );
      expect((yield* yield* executeInstalled({ path: join(root, "doc.md"), stream }, [])).ok).toBe(
        true,
      );
    });
    const after = stream.snapshot().length;

    const crossed: string[] = [];
    const cold = yield* scoped(function* () {
      yield* API.Files.around({
        *readTextFile([input], next) {
          crossed.push(`read:${input.path}`);
          return yield* next(input);
        },
      });
      yield* useHostFiles();
      const execution = yield* executeInstalled({ path: join(root, "doc.md"), stream }, []);
      yield* execution;
      const held = yield* execution.bindings();
      if (!held.ok) {
        throw held.error;
      }
      return held.value;
    });

    expect(cold["failed"]).toEqual([{ name: "b" }]);
    // The completed run answered from its record: no producer ran again, and
    // the journal did not grow.
    expect(crossed).toEqual([]);
    expect(stream.snapshot().length).toBe(after);
  });
});

/** A producer whose closed schema would reject an extra prop. */
function closedProducer(): ComponentRegistration {
  return {
    name: "Closed",
    origin: "yq-component-test",
    props: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    },
    returns: { type: "object", properties: { kept: { type: "string" } }, required: ["kept"] },
    // deno-lint-ignore require-yield
    *fn(): Operation<unknown> {
      return { kept: "yes" };
    },
  };
}

/** A producer that counts whether it ran at all. */
function countedProducer(calls: { count: number }): ComponentRegistration {
  return {
    name: "Counted",
    origin: "yq-component-test",
    props: { type: "object", properties: {}, additionalProperties: false },
    returns: { type: "object", properties: { kept: { type: "string" } }, required: ["kept"] },
    // deno-lint-ignore require-yield
    *fn(): Operation<unknown> {
      calls.count += 1;
      return { kept: "yes" };
    },
  };
}

/** A Markdown value body whose own `returns` accepts an object. */
function recordComponent(): ComponentDefinition {
  return {
    kind: "markdown",
    name: "Record",
    path: "components/Record.md",
    meta: {},
    props: { type: "object", properties: {}, additionalProperties: false },
    returns: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    bodySegments: scanSegments('<Return value={{ name: "widget" }} />\n'),
  };
}

/**
 * A Markdown value body that keeps working after it has returned.
 *
 * The sentinel is a registered component rather than a code block: a
 * component body is where the ordering question lives, and putting executable
 * JavaScript in the Markdown would be answering a different one.
 */
function finishingComponent(): ComponentDefinition {
  return {
    kind: "markdown",
    name: "Finishing",
    path: "components/Finishing.md",
    meta: {},
    props: { type: "object", properties: {}, additionalProperties: false },
    returns: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    bodySegments: scanSegments('<Return value={{ name: "widget" }} />\n\n<Sentinel />\n'),
  };
}

/** A component that records when it ran and when its own cleanup unwound. */
function sentinel(order: string[]): ComponentRegistration {
  return {
    name: "Sentinel",
    origin: "yq-component-test",
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<unknown> {
      yield* ensure(() => {
        order.push("sentinel teardown");
      });
      order.push("sentinel body");
      return "";
    },
  };
}

/** A Markdown value body whose return its own schema rejects. */
function wrongComponent(): ComponentDefinition {
  return {
    kind: "markdown",
    name: "Wrong",
    path: "components/Wrong.md",
    meta: {},
    props: { type: "object", properties: {}, additionalProperties: false },
    returns: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    bodySegments: scanSegments("<Return value={{ other: 1 }} />\n"),
  };
}

/** A function producer that records when its own cleanup finished. */
function joinedProducer(order: string[]): ComponentRegistration {
  return {
    name: "Joined",
    origin: "yq-component-test",
    props: { type: "object", properties: {}, additionalProperties: false },
    returns: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    *fn(): Operation<unknown> {
      yield* ensure(() => {
        order.push("teardown");
      });
      order.push("body");
      return { name: "widget" };
    },
  };
}

/** A function producer whose cleanup fails after a valid result. */
function breakingProducer(): ComponentRegistration {
  return {
    name: "Breaking",
    origin: "yq-component-test",
    props: { type: "object", properties: {}, additionalProperties: false },
    returns: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    *fn(): Operation<unknown> {
      yield* ensure(function* () {
        throw new Error("this producer's cleanup failed");
      });
      return { name: "widget" };
    },
  };
}

/**
 * A producer whose work is refused by the Files provider.
 *
 * The real refusal object rather than an ordinary Error: what the classification
 * is about is whether the failure that reaches the boundary is still recognized
 * as infrastructure, and recognition is structural.
 */
function deniedProducer(): ComponentRegistration {
  return {
    name: "Denied",
    origin: "yq-component-test",
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    *fn(): Operation<unknown> {
      throw new FilesOperationDeniedError("temporary-directory");
    },
  };
}

/** A Markdown body whose rendering holds text a reader must not see. */
function sentenceComponent(): ComponentDefinition {
  return {
    kind: "markdown",
    name: "Sentence",
    path: "components/Sentence.md",
    meta: {},
    props: { type: "object", properties: {}, additionalProperties: false },
    bodySegments: scanSegments('{"kept":"kept","raw":"RAW-MARKER"}\n'),
  };
}

/**
 * Tier YQ6 — mutation, query refusal and refused retention.
 *
 * A selected capture is ordinary binding data at the corrected parent, so what
 * retains it is the execution's own ordinary result rather than a per-name
 * append. These three cases are what that distinction actually changes: when
 * the snapshot is taken, what a rejected query binds, and what a refused
 * result acknowledges.
 *
 * The cross-entry half — what the next REPL entry inherits — belongs to the
 * REPL's own segmentation and is in `packages/cli/tests/repl-entries.test.ts`.
 */
describe("Tier YQ6 — mutation, refusal and what the result retains", () => {
  beforeAll(() => useTempFileCompiler());

  /** One entry at the end of `physical`, and the data its result retained. */
  function entry(
    root: string,
    source: string,
    physical: InMemoryStream,
  ): Operation<{ outcome: Result<Json>; bindings: Result<JsonObject> }> {
    return scoped(function* () {
      yield* useHostFiles();
      yield* writeTextFile(join(root, "doc.md"), source);
      try {
        const execution = yield* executeInstalled(
          { path: join(root, "doc.md"), stream: physical },
          [],
        );
        const outcome = yield* execution;
        return { outcome, bindings: yield* execution.bindings() };
      } catch (error) {
        const raised = error instanceof Error ? error : new Error(String(error));
        return { outcome: Err(raised), bindings: Err(raised) };
      }
    });
  }

  it("YQ6: a mutation before the result is part of what that entry retains", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const physical = new InMemoryStream();
    const ran = yield* entry(
      root,
      [
        `<File path="input.json" yq='${FAILED_RECORDS}' as="failed" />`,
        "",
        "```js eval",
        'failed.push({ name: "later" });',
        "const count = failed.length;",
        "```",
        "",
        "{count}",
        "",
      ].join("\n"),
      physical,
    );

    expect(ran.outcome.ok).toBe(true);
    expect(String(ran.outcome.ok && ran.outcome.value)).toContain("2");
    if (!ran.bindings.ok) {
      throw ran.bindings.error;
    }
    // The entry's own current root is what its result carries, so the edit it
    // made before settling is in it. There is no capture-time snapshot.
    expect(ran.bindings.value["failed"]).toEqual([{ name: "b" }, { name: "later" }]);
    // An ordinary export beside it stays eligible data.
    expect(ran.bindings.value["count"]).toBe(2);
  });

  it("YQ6: a reader's copy is its own, and editing it moves nothing", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const physical = new InMemoryStream();
    const read = yield* scoped(function* () {
      yield* useHostFiles();
      yield* writeTextFile(
        join(root, "doc.md"),
        `<File path="input.json" yq='${FAILED_RECORDS}' as="failed" />\n\n{failed.length}\n`,
      );
      const execution = yield* executeInstalled(
        { path: join(root, "doc.md"), stream: physical },
        [],
      );
      expect((yield* execution).ok).toBe(true);
      const first = yield* execution.bindings();
      if (!first.ok) {
        throw first.error;
      }
      // Edit the copy this reader was handed.
      const held = first.value["failed"];
      if (Array.isArray(held)) {
        held.push({ name: "intruder" });
      }
      const second = yield* execution.bindings();
      if (!second.ok) {
        throw second.error;
      }
      return second.value;
    });

    // The next read is unaffected: what came back was a copy, and accepted
    // data is not a reader's to edit.
    expect(read["failed"]).toEqual([{ name: "b" }]);
    expect(JSON.stringify(read)).not.toContain("intruder");
  });

  it("YQ6: a rejected query binds no second value and keeps the first", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const physical = new InMemoryStream();
    const ran = yield* entry(
      root,
      [
        `<File path="input.json" yq='from_json | .records[0].name' as="first" />`,
        "",
        `<File path="input.json" yq='!!!' as="second" />`,
        "",
        "sentinel {second}",
        "",
      ].join("\n"),
      physical,
    );

    // `<File>` prints its errors, so the expression's refusal is reported in
    // the document rather than ending the run — and what matters here is what
    // it bound, which is nothing.
    expect(ran.outcome.ok).toBe(true);
    const rendered = String(ran.outcome.ok && ran.outcome.value);
    expect(rendered).toContain("could not be evaluated");

    if (!ran.bindings.ok) {
      throw ran.bindings.error;
    }
    // The first selected value is retained; the rejected query assigned no
    // second binding and no fallback to the producer's own text.
    expect(ran.bindings.value["first"]).toBe("a");
    expect(Object.hasOwn(ran.bindings.value, "second")).toBe(false);
    expect(JSON.stringify(ran.bindings.value)).not.toContain("records");
    // And the body after it read nothing: `{second}` names no binding, so the
    // sentinel line carries the unresolved name rather than a value.
    expect(rendered).toContain("sentinel {second}");
  });

  it("YQ6: a refused result acknowledges no computed map", function* () {
    const root = yield* useWorkspace({ "input.json": FIXTURE });
    const physical = new InMemoryStream();

    // The ordinary result's own append is refused, before the physical
    // backend. The capture itself may well have happened live; what must not
    // happen is an accepted computed map for a result nothing retained.
    physical.onAppend = (event) => {
      if (event.type === "close") {
        throw new Error("this journal cannot accept the result");
      }
    };
    const ran = yield* entry(
      root,
      `<File path="input.json" yq='${FAILED_RECORDS}' as="failed" />\n\n{failed.length}\n`,
      physical,
    );
    physical.onAppend = null;

    expect(ran.outcome.ok).toBe(false);
    // The persistence failure is what the run reports, and the handle refuses
    // rather than answering with data no later run could start from.
    expect(String(ran.outcome.ok === false && ran.outcome.error.message)).toContain(
      "persist durable close",
    );
    expect(ran.bindings.ok).toBe(false);
    // And nothing compensating was written in its place.
    expect(physical.snapshot().some((event) => event.type === "close")).toBe(false);
  });
});
