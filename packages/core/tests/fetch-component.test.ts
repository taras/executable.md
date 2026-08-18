/**
 * Tier FE — `<Fetch>` (spec §6.18).
 *
 * The component is a boundary between three things that must not blur: what a
 * document is allowed to ask for, who performs the request, and what is kept
 * afterwards. Each section here holds one of them.
 *
 * Every case substitutes a provider on `API.Fetch` — the same seam a host uses
 * — and counts what that provider was actually asked to perform. Request count
 * is asserted separately from the binding, from rendered output, and from the
 * journal, because those three can agree while the number of requests is wrong.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, sleep, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { API, Config } from "@executablemd/runtime";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import { InMemoryStream, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collect } from "../src/collect.ts";
import { hasBinding, hasContent, content } from "../src/component-api.ts";
import { execute } from "../src/execute.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { useSecretScannerFactory } from "../src/secrets/policy.ts";
import type { SecretScanner } from "../src/secrets/scanner.ts";
import { createSecretScanner } from "../src/secrets/scanner.ts";
import { expandAll } from "./invocation-harness.ts";
import type { Definition } from "./invocation-harness.ts";
import type { FunctionComponentDefinition, Segment } from "../src/types.ts";

const URL_ONE = "https://api.example.test/one";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

function useWorkspace(): Operation<string> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "fetch-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* provide(root);
  });
}

/** What one substituted provider was asked to do. */
interface Probe {
  /** The requests the trusted transport actually performed, in order. */
  readonly performed: Array<{ url: string; init: FetchInit | undefined }>;
  /** How many times a response body was read. */
  bodyReads(): number;
}

/** How a provider answers one request. */
interface Answer {
  status?: number;
  /** Header entries as the provider reports them, in provider order. */
  headers?: Array<[string, string]>;
  body?: string;
  /** Fail the body read rather than answering it. */
  bodyFails?: boolean;
  /** Report headers this provider cannot enumerate. */
  opaqueHeaders?: boolean;
  /** Rewrite the reported header entries once the body has been read. */
  mutatesAfterRead?: boolean;
}

/**
 * Install a provider on the *calling* scope and hand back what it recorded.
 *
 * Not a resource: middleware installs on the scope that runs the install, and a
 * provider installed inside a resource body would be invisible to the execution
 * the test is about to start.
 *
 * `at: "min"` is where a trusted host installs — the position an ordinary
 * middleware chain wraps rather than shadows.
 */
function* useProvider(
  answer: (index: number) => Answer | undefined,
  performed: Probe["performed"] = [],
): Operation<Probe> {
  let bodyReads = 0;
  yield* API.Fetch.around(
    {
      // deno-lint-ignore require-yield
      *fetch([url, init]): Operation<RuntimeFetchResponse> {
        const index = performed.length;
        performed.push({ url, init });
        const answered = answer(index);
        if (answered === undefined) {
          throw new Error(`the provider has no answer for request ${index}`);
        }
        return response(answered, () => {
          bodyReads += 1;
        });
      },
    },
    { at: "min" },
  );
  return { performed, bodyReads: () => bodyReads };
}

/** A provider that answers every request the same way. */
function useAnswer(answer: Answer): Operation<Probe> {
  return useProvider(() => answer);
}

/** One response, as a provider reports it. */
function response(answer: Answer, onRead: () => void): RuntimeFetchResponse {
  const entries: Array<[string, string]> = (answer.headers ?? []).map(([name, value]) => [
    name,
    value,
  ]);
  const headers = {
    get(key: string): string | null {
      const found = entries.filter(([name]) => name.toLowerCase() === key.toLowerCase());
      return found.length === 0 ? null : found.map(([, value]) => value).join(", ");
    },
    ...(answer.opaqueHeaders === true ? {} : { entries: () => entries.map(pair) }),
  };
  return {
    status: answer.status ?? 200,
    headers,
    *text(): Operation<string> {
      onRead();
      if (answer.bodyFails === true) {
        throw new Error("the response body could not be read");
      }
      if (answer.mutatesAfterRead === true) {
        entries.length = 0;
        entries.push(["x-rewritten", "after the fact"]);
      }
      yield* sleep(0);
      return answer.body ?? "";
    },
  };
}

function pair([name, value]: [string, string]): [string, string] {
  return [name, value];
}

/** A document with the eval environment `as` writes bindings into. */
function doc(...lines: string[]): string {
  return ["```js eval", "const ready = true;", "```", "", ...lines, ""].join("\n");
}

/** What one run produced. */
interface Run {
  output: string;
  failure?: Error;
  events: DurableEvent[];
}

/** Execute `source` in `workspace`, keeping whatever it failed with. */
function run(
  workspace: string,
  source: string,
  options: {
    stream?: InMemoryStream;
    componentDirs?: string[];
    props?: Record<string, string>;
  } = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(workspace, "doc.md");
    yield* writeTextFile(path, source);
    const stream = options.stream ?? new InMemoryStream();
    try {
      const output = yield* collect(
        yield* execute({
          path,
          stream,
          ...(options.componentDirs === undefined ? {} : { componentDirs: options.componentDirs }),
          ...(options.props === undefined ? {} : { props: options.props }),
        }),
      );
      return { output: String(output), events: yield* stream.readAll() };
    } catch (error) {
      return {
        output: "",
        failure: error instanceof Error ? error : new Error(String(error)),
        events: yield* stream.readAll(),
      };
    }
  });
}

/** Every Fetch effect a run journaled, whether it succeeded or failed. */
function fetchEvents(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield" && event.description.type === "fetch");
}

/**
 * Every Fetch *observation* a run committed.
 *
 * A durable operation that fails is journaled too, carrying the failure — so
 * "no response was recorded" is a question about successful results, not about
 * whether the effect appears in the history at all.
 */
function committed(events: DurableEvent[]): DurableEvent[] {
  return fetchEvents(events).filter(
    (event) => event.type === "yield" && event.result.status === "ok",
  );
}

/** The journal without the root's close, which is what makes the next run replay. */
function partial(events: DurableEvent[]): InMemoryStream {
  return new InMemoryStream(
    events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
  );
}

describe("Tier FE — what a request has to be before it is sent", () => {
  beforeAll(() => useTempFileCompiler());

  const REFUSED: Array<[string, string]> = [
    ["a mutating method", `<Fetch url="${URL_ONE}" method="POST" as="r" />`],
    ["another mutating method", `<Fetch url="${URL_ONE}" method="PUT" as="r" />`],
    ["a patch", `<Fetch url="${URL_ONE}" method="PATCH" as="r" />`],
    ["a delete", `<Fetch url="${URL_ONE}" method="DELETE" as="r" />`],
    ["a lowercase method", `<Fetch url="${URL_ONE}" method="get" as="r" />`],
    ["an unknown method", `<Fetch url="${URL_ONE}" method="FETCH" as="r" />`],
    ["a relative URL", `<Fetch url="/relative" as="r" />`],
    ["a scheme that is not HTTP", `<Fetch url="file:///etc/hosts" as="r" />`],
    ["a data URL", `<Fetch url="data:text/plain,hello" as="r" />`],
    ["a request body", `<Fetch url="${URL_ONE}" body="payload" as="r" />`],
    ["an unknown prop", `<Fetch url="${URL_ONE}" redirect="follow" as="r" />`],
    ["a missing URL", `<Fetch as="r" />`],
    ["a non-string header value", `<Fetch url="${URL_ONE}" headers={{ accept: 1 }} as="r" />`],
    [
      "two spellings of one header",
      `<Fetch url="${URL_ONE}" headers={{ Accept: "a", accept: "b" }} as="r" />`,
    ],
  ];

  for (const [what, element] of REFUSED) {
    it(`FE1: refuses ${what} before any request`, function* () {
      const workspace = yield* useWorkspace();
      const probe = yield* useAnswer({ status: 200 });

      const result = yield* run(workspace, doc(element));

      expect(probe.performed).toHaveLength(0);
      expect(fetchEvents(result.events)).toHaveLength(0);
      expect(result.failure).toBeDefined();
    });
  }

  it("FE2: defaults to GET and sends exactly the normalized request", function* () {
    const workspace = yield* useWorkspace();
    const probe = yield* useAnswer({ status: 200, body: "ok" });

    yield* run(
      workspace,
      doc(`<Fetch url="${URL_ONE}" headers={{ Accept: "text/plain" }} timeout="30s" as="r" />`),
    );

    expect(probe.performed).toEqual([
      {
        url: URL_ONE,
        init: { method: "GET", headers: { accept: "text/plain" }, timeout: 30_000 },
      },
    ]);
  });

  it("FE3: accepts HEAD and sends it verbatim", function* () {
    const workspace = yield* useWorkspace();
    const probe = yield* useAnswer({ status: 200 });

    yield* run(workspace, doc(`<Fetch url="${URL_ONE}" method="HEAD" as="r" />`));

    expect(probe.performed[0]?.init?.method).toBe("HEAD");
  });

  it("FE4: orders header names lexicographically and leaves values alone", function* () {
    const workspace = yield* useWorkspace();
    const probe = yield* useAnswer({ status: 200 });

    yield* run(
      workspace,
      doc(
        `<Fetch url="${URL_ONE}" headers={{ "X-Zed": " Spaced Value ", ` +
          `Accept: "application/vnd.github+json", "if-None-Match": "W/\\"abc\\"" }} as="r" />`,
      ),
    );

    const headers = probe.performed[0]?.init?.headers ?? {};
    expect(Object.keys(headers)).toEqual(["accept", "if-none-match", "x-zed"]);
    expect(headers["x-zed"]).toBe(" Spaced Value ");
    expect(headers["if-none-match"]).toBe('W/"abc"');
  });
});

describe("Tier FE — what bounds the request", () => {
  beforeAll(() => useTempFileCompiler());

  const ACCEPTED: Array<[string, number]> = [
    ["500ms", 500],
    ["30s", 30_000],
    ["5min", 300_000],
    ["500", 500],
  ];

  for (const [spelling, ms] of ACCEPTED) {
    it(`FE5: sends ${spelling} as ${ms}ms`, function* () {
      const workspace = yield* useWorkspace();
      const probe = yield* useAnswer({ status: 200 });

      yield* run(workspace, doc(`<Fetch url="${URL_ONE}" timeout="${spelling}" as="r" />`));

      expect(probe.performed[0]?.init?.timeout).toBe(ms);
    });
  }

  // The complete grammar has its own table (Tier DU); these are the classes it
  // rejects, checked here for the one thing that table cannot show — that a
  // rejected duration costs no request.
  const REJECTED = ["", "   ", "0", "0s", "-1", "1.5s", "Infinity", "NaN", "abc", "5x", "1e3"];

  for (const spelling of REJECTED) {
    it(`FE6: refuses the timeout ${JSON.stringify(spelling)} before any request`, function* () {
      const workspace = yield* useWorkspace();
      const probe = yield* useAnswer({ status: 200 });

      const result = yield* run(
        workspace,
        doc(`<Fetch url="${URL_ONE}" timeout="${spelling}" as="r" />`),
      );

      expect(probe.performed).toHaveLength(0);
      expect(result.failure).toBeDefined();
    });
  }

  it("FE7: an explicit timeout outranks the contextual Fetch default", function* () {
    const workspace = yield* useWorkspace();

    const probe = yield* scoped(function* () {
      yield* Config.around({ timeoutFetch: () => 9_000 }, { at: "min" });
      const probe = yield* useAnswer({ status: 200 });
      yield* run(workspace, doc(`<Fetch url="${URL_ONE}" timeout="1s" as="r" />`));
      return probe;
    });

    expect(probe.performed[0]?.init?.timeout).toBe(1_000);
  });

  it("FE8: the contextual Fetch default is what an unbounded element carries", function* () {
    const workspace = yield* useWorkspace();

    const probe = yield* scoped(function* () {
      yield* Config.around({ timeoutFetch: () => 9_000 }, { at: "min" });
      const probe = yield* useAnswer({ status: 200 });
      yield* run(workspace, doc(`<Fetch url="${URL_ONE}" as="r" />`));
      return probe;
    });

    expect(probe.performed[0]?.init?.timeout).toBe(9_000);
  });

  it("FE9: no bound at all is an absent field rather than a number", function* () {
    const workspace = yield* useWorkspace();
    const probe = yield* useAnswer({ status: 200 });

    const result = yield* run(workspace, doc(`<Fetch url="${URL_ONE}" as="r" />`));

    expect(probe.performed[0]?.init).toEqual({ method: "GET", headers: {} });
    const [event] = fetchEvents(result.events);
    expect(event?.type === "yield" && event.description.input).toEqual({
      url: URL_ONE,
      method: "GET",
      headers: {},
    });
  });
});

describe("Tier FE — the response a document keeps", () => {
  beforeAll(() => useTempFileCompiler());

  const MIXED: Answer = {
    status: 201,
    headers: [
      ["X-Trace", "first"],
      ["content-type", "application/json"],
      ["x-trace", "second"],
      ["Age", "3"],
    ],
    body: "grüße, 世界",
  };

  const BINDING = doc(
    `<Fetch url="${URL_ONE}" as="r" />`,
    "",
    "```js eval",
    "const shape = JSON.stringify(r);",
    "```",
    "",
    "BINDING {shape}",
  );

  it("FE10: binds one canonical JSON value", function* () {
    const workspace = yield* useWorkspace();
    yield* useAnswer(MIXED);

    const result = yield* run(workspace, BINDING);

    expect(result.output).toContain(
      'BINDING {"status":201,"headers":{"age":"3","content-type":"application/json",' +
        '"x-trace":"first, second"},"body":"grüße, 世界"}',
    );
  });

  it("FE11: retains the same value it bound", function* () {
    const workspace = yield* useWorkspace();
    yield* useAnswer(MIXED);

    const result = yield* run(workspace, BINDING);

    const [event] = fetchEvents(result.events);
    expect(event?.type === "yield" && event.result.status).toBe("ok");
    expect(event?.type === "yield" && event.result.status === "ok" && event.result.value).toEqual({
      status: 201,
      headers: { age: "3", "content-type": "application/json", "x-trace": "first, second" },
      body: "grüße, 世界",
    });
  });

  it("FE12: a provider that rewrites its headers afterwards changes nothing", function* () {
    const workspace = yield* useWorkspace();
    yield* useAnswer({ ...MIXED, mutatesAfterRead: true });

    const result = yield* run(workspace, BINDING);

    expect(result.output).toContain('"x-trace":"first, second"');
    expect(result.output).not.toContain("x-rewritten");
    expect(JSON.stringify(result.events)).not.toContain("x-rewritten");
  });

  it("FE13: refuses a provider that cannot enumerate its headers", function* () {
    const workspace = yield* useWorkspace();
    yield* useAnswer({ status: 200, opaqueHeaders: true, body: "ignored" });

    const result = yield* run(workspace, doc(`<Fetch url="${URL_ONE}" as="r" />`));

    expect(result.failure?.message).toContain("cannot enumerate response headers");
    expect(committed(result.events)).toHaveLength(0);
  });

  it("FE14: GET reads the body exactly once; HEAD does not read it at all", function* () {
    const workspace = yield* useWorkspace();

    const reading = yield* scoped(function* () {
      const probe = yield* useAnswer({ status: 200, body: "payload" });
      const result = yield* run(workspace, BINDING);
      return { probe, result };
    });
    expect(reading.probe.bodyReads()).toBe(1);
    expect(reading.result.output).toContain('"body":"payload"');

    const heading = yield* scoped(function* () {
      // A body read would fail, so a HEAD that read one could not succeed.
      const probe = yield* useAnswer({ status: 200, bodyFails: true });
      const result = yield* run(
        workspace,
        doc(
          `<Fetch url="${URL_ONE}" method="HEAD" as="r" />`,
          "",
          "```js eval",
          "const shape = JSON.stringify(r);",
          "```",
          "",
          "BINDING {shape}",
        ),
      );
      return { probe, result };
    });
    expect(heading.probe.bodyReads()).toBe(0);
    expect(heading.result.output).toContain('"body":""');
  });
});

describe("Tier FE — what a status means", () => {
  beforeAll(() => useTempFileCompiler());

  it("FE15: a captured non-2xx binds the same shape as a captured 2xx", function* () {
    const workspace = yield* useWorkspace();
    yield* useAnswer({ status: 404, headers: [["content-type", "text/plain"]], body: "missing" });

    const result = yield* run(
      workspace,
      doc(
        `<Fetch url="${URL_ONE}" as="r" />`,
        "",
        "```js eval",
        "const shape = JSON.stringify(r);",
        "```",
        "",
        "BINDING {shape}",
        "AFTER",
      ),
    );

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain(
      'BINDING {"status":404,"headers":{"content-type":"text/plain"},"body":"missing"}',
    );
    expect(result.output).toContain("AFTER");
  });

  it("FE16: an uncaptured 2xx succeeds and renders nothing of its own", function* () {
    const workspace = yield* useWorkspace();
    yield* useAnswer({ status: 204, headers: [["x-marker", "hidden"]], body: "not rendered" });

    const result = yield* run(workspace, doc(`<Fetch url="${URL_ONE}" />`, "", "AFTER"));

    expect(result.failure).toBe(undefined);
    expect(result.output).toContain("AFTER");
    expect(result.output).not.toContain("not rendered");
    expect(result.output).not.toContain("hidden");
    expect(result.output).not.toContain("204");
  });

  it("FE17: an uncaptured non-2xx records the response and stops the document", function* () {
    const workspace = yield* useWorkspace();
    const marker = join(workspace, "ran.txt");
    yield* useAnswer({ status: 500, headers: [["x-mark", "kept"]], body: "server error" });

    const result = yield* run(
      workspace,
      doc(
        `<Fetch url="${URL_ONE}" />`,
        "",
        "```bash exec",
        `printf ran > ${JSON.stringify(marker)}`,
        "```",
      ),
    );

    expect(result.failure).toBeDefined();
    expect(yield* exists(marker)).toBe(false);
    const [event] = fetchEvents(result.events);
    expect(event?.type === "yield" && event.result.status === "ok" && event.result.value).toEqual({
      status: 500,
      headers: { "x-mark": "kept" },
      body: "server error",
    });
  });
});

describe("Tier FE — the binding-mode seam", () => {
  /**
   * The engine's answer to "will what I return be captured?" and nothing else.
   * Driven through `expandSegments` rather than a document, because what is
   * under test is one invocation's isolation from another's — including two
   * that are live at the same moment, which a document cannot arrange.
   */
  function reporter(
    reported: string[],
    label: string,
    gate?: { arrive: () => Operation<void> },
  ): FunctionComponentDefinition {
    return {
      kind: "function",
      name: "Report",
      props: NO_PROPS,
      *fn(): Operation<string> {
        const inner = (yield* hasContent()) ? yield* content() : "";
        if (gate !== undefined) {
          yield* gate.arrive();
        }
        const bound = yield* hasBinding();
        reported.push(`${label}:${bound}`);
        return `[${label}:${bound}${inner}]`;
      },
    };
  }

  function definitions(definition: FunctionComponentDefinition): Record<string, Definition> {
    return { Report: definition };
  }

  it("FE18: reports true only where `as` was written", function* () {
    const reported: string[] = [];
    const segments: Segment[] = yield* expandAll(
      '<Report />\n<Report as="kept" />\n',
      definitions(reporter(reported, "sibling")),
      [],
    );

    expect(reported).toEqual(["sibling:false", "sibling:true"]);
    const rendered = segments
      .map((segment) => (segment.type === "text" ? segment.content : ""))
      .join("");
    expect(rendered).toContain("[sibling:false]");
    expect(rendered).not.toContain("[sibling:true]");
  });

  it("FE19: a nested invocation answers for itself, not for its caller", function* () {
    const reported: string[] = [];
    yield* expandAll(
      '<Report as="outer"><Report /></Report>\n',
      definitions(reporter(reported, "nested")),
      [],
    );

    // The inner invocation is expanded inside the outer one's scope, and
    // answers first: it is uncaptured while its caller is captured.
    expect(reported).toEqual(["nested:false", "nested:true"]);
  });

  it("FE20: two invocations that are live at once answer independently", function* () {
    const reported: string[] = [];
    const arrived: string[] = [];
    const both = withResolvers<void>();

    function gate(label: string) {
      return {
        *arrive(): Operation<void> {
          arrived.push(label);
          if (arrived.length === 2) {
            both.resolve();
          }
          yield* both.operation;
        },
      };
    }

    yield* scoped(function* () {
      const captured = yield* spawn(() =>
        expandAll(
          '<Report as="kept" />',
          definitions(reporter(reported, "captured", gate("captured"))),
          [],
        ),
      );
      const plain = yield* spawn(() =>
        expandAll("<Report />", definitions(reporter(reported, "plain", gate("plain"))), []),
      );
      yield* captured;
      yield* plain;
    });

    expect(reported.slice().sort()).toEqual(["captured:true", "plain:false"]);
  });
});

describe("Tier FE — a failure never becomes data", () => {
  beforeAll(() => useTempFileCompiler());

  it("FE21: a transport failure binds nothing and records no result", function* () {
    const workspace = yield* useWorkspace();
    yield* API.Fetch.around(
      {
        // deno-lint-ignore require-yield
        *fetch() {
          throw new Error("connection refused");
        },
      },
      { at: "min" },
    );

    const result = yield* run(workspace, doc(`<Fetch url="${URL_ONE}" as="r" />`, "", "BOUND {r}"));

    expect(result.failure?.message).toContain("connection refused");
    expect(result.output).not.toContain("BOUND");
    expect(committed(result.events)).toHaveLength(0);
  });

  it("FE22: a body-read failure binds nothing, even though a status arrived", function* () {
    const workspace = yield* useWorkspace();
    yield* useAnswer({ status: 200, headers: [["x-mark", "seen"]], bodyFails: true });

    const result = yield* run(workspace, doc(`<Fetch url="${URL_ONE}" as="r" />`, "", "BOUND {r}"));

    expect(result.failure?.message).toContain("could not be read");
    expect(result.output).not.toContain("BOUND");
    // No partial response: a status and headers without the body they came with
    // is not an observation this component publishes.
    expect(committed(result.events)).toHaveLength(0);
  });

  it("FE23: a timeout binds nothing", function* () {
    const workspace = yield* useWorkspace();
    yield* API.Fetch.around(
      {
        *fetch([, init]): Operation<RuntimeFetchResponse> {
          yield* sleep(init?.timeout ?? 0);
          throw new Error(`fetch timed out after ${init?.timeout}ms`);
        },
      },
      { at: "min" },
    );

    const result = yield* run(
      workspace,
      doc(`<Fetch url="${URL_ONE}" timeout="20ms" as="r" />`, "", "BOUND {r}"),
    );

    expect(result.failure?.message).toContain("timed out after 20ms");
    expect(result.output).not.toContain("BOUND");
    expect(committed(result.events)).toHaveLength(0);
  });

  it("FE24: cancelling the owner tears the provider down in both phases", function* () {
    for (const phase of ["request", "body"]) {
      const workspace = yield* useWorkspace();
      const timeline: string[] = [];
      const started = withResolvers<void>();

      yield* scoped(function* () {
        yield* API.Fetch.around(
          {
            *fetch(): Operation<RuntimeFetchResponse> {
              yield* ensure(() => {
                timeline.push("request torn down");
              });
              if (phase === "request") {
                started.resolve();
                yield* suspend();
              }
              return {
                status: 200,
                headers: { get: () => null, entries: () => [] },
                *text(): Operation<string> {
                  yield* ensure(() => {
                    timeline.push("body torn down");
                  });
                  started.resolve();
                  yield* suspend();
                  return "";
                },
              };
            },
          },
          { at: "min" },
        );

        const finished = yield* spawn(() =>
          run(workspace, doc(`<Fetch url="${URL_ONE}" as="r" />`, "", "BOUND {r}")),
        );
        yield* started.operation;
        yield* finished.halt();
      });

      // The provider's own teardown ran, innermost first, and nothing arrived
      // after it.
      const expected =
        phase === "request" ? ["request torn down"] : ["body torn down", "request torn down"];
      expect(timeline).toEqual(expected);
      yield* sleep(20);
      expect(timeline).toEqual(expected);
    }
  });
});

describe("Tier FE — who is allowed to perform the request", () => {
  beforeAll(() => useTempFileCompiler());

  /** A trusted host that refuses one destination and performs nothing. */
  function* useCeiling(performed: string[]): Operation<void> {
    yield* API.Fetch.around(
      {
        // deno-lint-ignore require-yield
        *fetch([url]): Operation<RuntimeFetchResponse> {
          performed.push(url);
          throw new Error("this host does not reach that destination");
        },
      },
      { at: "min" },
    );
  }

  it("FE25: ordinary middleware may observe and delegate, and still cannot widen", function* () {
    const workspace = yield* useWorkspace();
    const performed: string[] = [];
    const observed: string[] = [];

    const result = yield* scoped(function* () {
      yield* useCeiling(performed);
      yield* API.Fetch.around({
        *fetch([url, init], next): Operation<RuntimeFetchResponse> {
          observed.push(url);
          return yield* next(url, init);
        },
      });
      return yield* run(workspace, doc(`<Fetch url="${URL_ONE}" as="r" />`));
    });

    expect(observed).toEqual([URL_ONE]);
    expect(result.failure?.message).toContain("does not reach that destination");
    expect(committed(result.events)).toHaveLength(0);
  });

  it("FE26: a synthetic answer is substitution, not a request the host performed", function* () {
    const workspace = yield* useWorkspace();
    const performed: string[] = [];

    const result = yield* scoped(function* () {
      yield* useCeiling(performed);
      yield* API.Fetch.around({
        // deno-lint-ignore require-yield
        *fetch(): Operation<RuntimeFetchResponse> {
          return response(
            { status: 200, headers: [["x-source", "synthetic"]], body: "canned" },
            () => {},
          );
        },
      });
      return yield* run(
        workspace,
        doc(
          `<Fetch url="${URL_ONE}" as="r" />`,
          "",
          "```js eval",
          "const shape = JSON.stringify(r);",
          "```",
          "",
          "BINDING {shape}",
        ),
      );
    });

    expect(result.output).toContain('"x-source":"synthetic"');
    // The trusted transport was never reached, so nothing went out.
    expect(performed).toEqual([]);
  });

  it("FE27: eval's own fetch crosses the same ceiling", function* () {
    const workspace = yield* useWorkspace();
    const performed: string[] = [];

    const result = yield* scoped(function* () {
      yield* useCeiling(performed);
      return yield* run(
        workspace,
        [
          "```js eval",
          `const answer = yield* fetch(${JSON.stringify(URL_ONE)}).text();`,
          "```",
          "",
        ].join("\n"),
      );
    });

    expect(performed).toEqual([URL_ONE]);
    expect(result.failure?.message).toContain("does not reach that destination");
  });

  it("FE28: a repository Fetch shadows core and acquires no authority from the name", function* () {
    const workspace = yield* useWorkspace();
    const components = join(workspace, "components");
    yield* ensureDir(components);
    yield* writeTextFile(
      join(components, "Fetch.md"),
      [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    url:",
        "      type: string",
        "  required: [url]",
        "  additionalProperties: false",
        "---",
        "",
        "```js eval",
        "const answer = yield* fetch(`${props.url}/via-shadow`).text();",
        "```",
        "",
        "SHADOW",
        "",
      ].join("\n"),
    );

    const performed: string[] = [];
    const shadowed = yield* scoped(function* () {
      yield* useCeiling(performed);
      return yield* run(workspace, doc(`<Fetch url="${URL_ONE}" />`), {
        componentDirs: [components],
      });
    });

    // The repository component ran — its own request is the one the host saw —
    // and the ceiling refused it, which the name it took gave it no way around.
    expect(performed).toEqual([`${URL_ONE}/via-shadow`]);
    expect(shadowed.failure?.message).toContain("does not reach that destination");

    // With the file gone, the same document resolves core's own component.
    yield* rm(join(components, "Fetch.md"));
    const probe = yield* useAnswer({ status: 200, body: "core" });
    const core = yield* run(workspace, doc(`<Fetch url="${URL_ONE}" />`), {
      componentDirs: [components],
    });
    expect(core.failure).toBe(undefined);
    expect(probe.performed).toEqual([{ url: URL_ONE, init: { method: "GET", headers: {} } }]);
    expect(fetchEvents(core.events)).toHaveLength(1);
  });
});

describe("Tier FE — what a later run finds", () => {
  beforeAll(() => useTempFileCompiler());

  const REPLAYED = doc(
    `<Fetch url="${URL_ONE}" as="r" />`,
    "",
    "```js eval",
    "const shape = JSON.stringify(r);",
    "```",
    "",
    "BINDING {shape}",
  );

  it("FE29: a partial replay restores the response and performs no second request", function* () {
    const workspace = yield* useWorkspace();
    const probe = yield* useAnswer({
      status: 200,
      headers: [["content-type", "application/json"]],
      body: '{"ok":true}',
    });

    const first = yield* run(workspace, REPLAYED);
    expect(probe.performed).toHaveLength(1);

    const [committed] = fetchEvents(first.events);
    const again = yield* run(workspace, REPLAYED, { stream: partial(first.events) });

    expect(probe.performed).toHaveLength(1);
    expect(again.output).toContain('BINDING {"status":200,');
    expect(again.output).toBe(first.output);

    const [restored] = fetchEvents(again.events);
    expect(restored).toEqual(committed);
  });

  it("FE30: the committed event names the expansion and where it was written", function* () {
    const workspace = yield* useWorkspace();
    yield* useAnswer({ status: 200, body: "" });

    const result = yield* run(workspace, doc(`<Fetch url="${URL_ONE}" as="r" />`));

    const [event] = fetchEvents(result.events);
    if (event?.type !== "yield") {
      throw new Error("the run committed no Fetch event");
    }
    expect(event.description.type).toBe("fetch");
    expect(String(event.description.name).startsWith("fetch:")).toBe(true);
    expect(event.description["executablemd.source-position"]).toMatchObject({
      path: join(workspace, "doc.md"),
    });
  });

  it("FE31: an interruption before the commit leaves no record, and one retry commits one", function* () {
    const workspace = yield* useWorkspace();
    const probe = yield* useAnswer({ status: 200, body: "once" });
    const blocked = new InMemoryStream();
    const reached = withResolvers<void>();

    /** Persist everything except the Fetch event, which never lands. */
    const holding: DurableStream = {
      readAll: () => blocked.readAll(),
      *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === "fetch") {
          reached.resolve();
          yield* suspend();
        }
        yield* blocked.append(event);
      },
    };

    yield* scoped(function* () {
      const running = yield* spawn(function* () {
        const path = join(workspace, "doc.md");
        yield* writeTextFile(path, REPLAYED);
        yield* collect(yield* execute({ path, stream: holding }));
      });
      yield* reached.operation;
      yield* running.halt();
    });

    // The request happened; the record did not.
    expect(probe.performed).toHaveLength(1);
    expect(fetchEvents(yield* blocked.readAll())).toHaveLength(0);

    const continued = yield* run(workspace, REPLAYED, {
      stream: new InMemoryStream(yield* blocked.readAll()),
    });

    expect(probe.performed).toHaveLength(2);
    expect(fetchEvents(continued.events)).toHaveLength(1);
    expect(continued.output).toContain('"body":"once"');
  });
});

describe("Tier FE — the secret gate covers the whole event", () => {
  beforeAll(() => useTempFileCompiler());

  const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
  /** A synthetic GitHub token, assembled here so no literal is committed. */
  const CANARY = ["ghp", "_", ALPHABET.slice(0, 36)].join("");

  function useProbedScanner(scanned: string[]): Operation<void> {
    return useSecretScannerFactory(() => {
      const inner = createSecretScanner();
      const scanner: SecretScanner = {
        scan(text: string) {
          scanned.push(text);
          return inner.scan(text);
        },
      };
      return scanner;
    });
  }

  it("FE32: the scanner sees the request and the response in one event", function* () {
    const workspace = yield* useWorkspace();
    const scanned: string[] = [];

    const result = yield* scoped(function* () {
      yield* useProbedScanner(scanned);
      yield* useAnswer({
        status: 418,
        headers: [["x-response-header", "response-marker"]],
        body: "response-body-marker",
      });
      return yield* run(
        workspace,
        doc(
          `<Fetch url="${URL_ONE}?query=url-marker" headers={{ "x-request": "request-marker" }} as="r" />`,
        ),
      );
    });

    expect(result.failure).toBe(undefined);
    const event = scanned.find((text) => text.includes('"type":"fetch"'));
    if (event === undefined) {
      throw new Error("the gate was never given the Fetch event");
    }
    for (const marker of [
      "url-marker",
      "request-marker",
      "418",
      "response-marker",
      "response-body-marker",
    ]) {
      expect(event).toContain(marker);
    }
  });

  /**
   * A run whose Fetch event carries the canary, and the marker a later block
   * would write if the document had carried on.
   *
   * The marker is what says "nothing was bound": a refused append fails the
   * component, and under ordinary root policy no later executable work starts.
   *
   * A request-side canary arrives as a root document prop, because everything a
   * document could write it into is persisted first: its own source reaches the
   * root import event, and an eval binding reaches that block's result. A host
   * that hands a document a token is also the realistic shape of the case.
   */
  function* refused(
    element: string,
    answer: Answer,
    props?: Record<string, string>,
  ): Operation<{ run: Run; ran: boolean }> {
    const workspace = yield* useWorkspace();
    const marker = join(workspace, "ran.txt");
    const stream = new InMemoryStream();
    yield* useAnswer(answer);

    const result = yield* run(
      workspace,
      [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    token:",
        "      type: string",
        "  additionalProperties: false",
        "---",
        "",
        "```js eval",
        "const ready = true;",
        "```",
        "",
        element,
        "",
        "```bash exec",
        `printf ran > ${JSON.stringify(marker)}`,
        "```",
        "",
      ].join("\n"),
      { stream, ...(props === undefined ? {} : { props }) },
    );

    // The run reached the Fetch: the block before it persisted.
    expect(persisted(stream)).toContain('"type":"eval"');
    expect(committed(result.events)).toHaveLength(0);
    expect(persisted(stream)).not.toContain(CANARY);
    return { run: result, ran: yield* exists(marker) };
  }

  /** What the gate says when it refuses, wherever the run reports it. */
  function refusal(outcome: { run: Run }): string {
    return `${outcome.run.output}${outcome.run.failure?.message ?? ""}`;
  }

  it("FE33: a credential in the request refuses the append and binds nothing", function* () {
    const outcome = yield* refused(
      `<Fetch url="${URL_ONE}" headers={{ authorization: props.token }} as="r" />`,
      { status: 200, body: "" },
      { token: CANARY },
    );

    expect(refusal(outcome)).toContain("secret detection rejected content");
    expect(outcome.ran).toBe(false);
    expect(outcome.run.output).not.toContain(CANARY);
  });

  it("FE34: a credential in the response refuses the append and binds nothing", function* () {
    const outcome = yield* refused(`<Fetch url="${URL_ONE}" as="r" />`, {
      status: 200,
      body: `token ${CANARY}`,
    });

    expect(refusal(outcome)).toContain("secret detection rejected content");
    expect(outcome.ran).toBe(false);
    expect(outcome.run.output).not.toContain(CANARY);
  });

  /** Everything a run left behind, as one string, for a canary sweep. */
  function persisted(stream: InMemoryStream): string {
    return stream.snapshot().map(serializeDurableEvent).join("");
  }
});

describe("Tier FE — invocations stay independent", () => {
  beforeAll(() => useTempFileCompiler());

  it("FE35: cancelling one request leaves the other's response untouched", function* () {
    const first = yield* useWorkspace();
    const second = yield* useWorkspace();
    const timeline: string[] = [];
    const held = withResolvers<void>();
    const other = withResolvers<void>();

    yield* scoped(function* () {
      yield* API.Fetch.around(
        {
          *fetch([url]): Operation<RuntimeFetchResponse> {
            if (url.endsWith("/held")) {
              yield* ensure(() => {
                timeline.push("held torn down");
              });
              held.resolve();
              yield* suspend();
            }
            timeline.push("other answered");
            other.resolve();
            return response(
              { status: 200, headers: [["x-which", "other"]], body: "other" },
              () => {},
            );
          },
        },
        { at: "min" },
      );

      const holding = yield* spawn(() => run(first, doc(`<Fetch url="${URL_ONE}/held" as="a" />`)));
      yield* held.operation;

      const answered = yield* spawn(() =>
        run(
          second,
          doc(
            `<Fetch url="${URL_ONE}/other" as="b" />`,
            "",
            "```js eval",
            "const shape = JSON.stringify(b);",
            "```",
            "",
            "BINDING {shape}",
          ),
        ),
      );
      yield* other.operation;
      yield* holding.halt();

      const result = yield* answered;
      expect(result.failure).toBe(undefined);
      expect(result.output).toContain('"x-which":"other"');
      expect(result.output).toContain('"body":"other"');
    });

    // The held request was torn down, and only it: the other invocation's
    // provider answered and its response was never consumed by the cancellation.
    expect(timeline).toEqual(["other answered", "held torn down"]);
  });
});
