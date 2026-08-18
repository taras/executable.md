/**
 * Tier GX — evaluating XMD an Agent generated
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * A trusted host hands the evaluator candidate source and the ceilings it may
 * run under. Everything here is about one of three claims.
 *
 * **The whole fragment is read before anything happens.** A refusal costs no
 * request, no observation, and no generated-XMD event — whether the construct
 * that caused it was written before the safe element or after it.
 *
 * **A name is not an identity.** Only the pinned definitions the host admitted
 * execute. A repository file with the same name, a synthetic answer from import
 * middleware, and an answer mutated after delegation each fail before the
 * component is invoked.
 *
 * **What ran is retained.** The admitted source, the selected root, the pinned
 * identities and the exact request policy cross the journal's secret filter as
 * one event, and the observations are retained by their own ordinary effects.
 *
 * Every case that involves a request substitutes a provider at `API.Fetch` and
 * counts what that provider was asked to perform, separately from the rendered
 * fragment and from the journal.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, sleep, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import { InMemoryStream, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { retainedSource } from "../src/root-source.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { useSecretScannerFactory } from "../src/secrets/policy.ts";
import { createSecretScanner } from "../src/secrets/scanner.ts";
import type { SecretScanner } from "../src/secrets/scanner.ts";
import { evaluateGeneratedXmd, pinnedComponent, pinnedFetch } from "../host.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation, GeneratedObservation, GeneratedXmdRequest } from "../host.ts";
import type { FunctionComponentDefinition, Json } from "../src/types.ts";

const ROOT_PATH = "workflows/agent.md";
const ROOT_SOURCE = "The host ran a generated fragment.\n";
const URL_ONE = "https://api.example.test/one";
const URL_TWO = "https://api.example.test/two";
const ROOTS = ["workspace://primary", "workspace://secondary"];

/** The one host observation component the tests admit beside `<Fetch>`. */
const PROBE: FunctionComponentDefinition = {
  kind: "function",
  name: "Probe",
  props: { type: "object", properties: {}, additionalProperties: false },
  // deno-lint-ignore require-yield
  *fn(): Operation<Json> {
    return "probed";
  },
};

function probe(): GeneratedObservation {
  return pinnedComponent("Probe", "test://probe", PROBE);
}

function useWorkspace(): Operation<string> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "generated-xmd-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* provide(root);
  });
}

/** What one substituted transport was asked to do. */
interface Transport {
  readonly performed: Array<{ url: string; init: FetchInit | undefined }>;
}

/**
 * Install a transport on the *calling* scope and hand back what it recorded.
 *
 * `at: "min"` is where a trusted host installs — the position an ordinary
 * middleware chain wraps rather than shadows.
 */
function* useTransport(answer: () => Answer): Operation<Transport> {
  const performed: Transport["performed"] = [];
  yield* API.Fetch.around(
    {
      // deno-lint-ignore require-yield
      *fetch([url, init]): Operation<RuntimeFetchResponse> {
        performed.push({ url, init });
        return response(answer());
      },
    },
    { at: "min" },
  );
  return { performed };
}

/** How the transport answers one request. */
interface Answer {
  status?: number;
  headers?: Array<[string, string]>;
  body?: string;
}

function response(answer: Answer): RuntimeFetchResponse {
  const entries = answer.headers ?? [];
  return {
    status: answer.status ?? 200,
    headers: {
      get: (key: string) =>
        entries.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? null,
      entries: () => entries.map(([name, value]): [string, string] => [name, value]),
    },
    *text(): Operation<string> {
      yield* sleep(0);
      return answer.body ?? "";
    },
  };
}

/** One request the host admits, written the way an element writes it. */
const ADMITTED_REQUEST: Record<string, Json> = { url: URL_ONE };

function request(
  source: string,
  observations: readonly GeneratedObservation[],
): GeneratedXmdRequest {
  return {
    id: "turn-1",
    source,
    workspaceRoots: ROOTS,
    selectedRoot: ROOTS[0] ?? "",
    observations,
  };
}

/** What one host-driven evaluation produced. */
interface Attempt {
  /** What the fragment rendered, when it was admitted. */
  output?: string;
  /** What the root document execution settled to, when it settled. */
  rendered?: Json;
  /** Why it was refused, when it was not. */
  failure?: string;
  events: DurableEvent[];
}

/**
 * Evaluate one fragment from the trusted-host seam.
 *
 * The evaluator is reached from a `DurablePreparation`, which is the position a
 * host records durable work from: it runs inside the durable root, after the
 * journal has been admitted and before any document policy or the root import.
 * No Agent provider is installed anywhere — the source is synthetic.
 */
function evaluate(
  candidate: GeneratedXmdRequest,
  options: {
    stream?: InMemoryStream;
    componentDirs?: readonly string[];
    installations?: readonly ExecutionInstallation[];
  } = {},
): Operation<Attempt> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const captured: { output?: string } = {};
    const installation: ExecutionInstallation = {
      *prepare() {
        captured.output = yield* evaluateGeneratedXmd(candidate);
      },
    };
    const execution = yield* executeInstalled(
      {
        ...retainedSource(ROOT_PATH, ROOT_SOURCE),
        stream,
        componentDirs: [...(options.componentDirs ?? [])],
      },
      [installation, ...(options.installations ?? [])],
    );
    const result = yield* execution;
    const events = yield* stream.readAll();
    if (result.ok) {
      return { output: captured.output ?? "", rendered: result.value, events };
    }
    return { failure: result.error.message, events };
  });
}

/** Every generated-XMD admission this run recorded. */
function admissions(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

/** What one generated-XMD record decided, when it decided anything. */
function decisionOf(event: DurableEvent): string | undefined {
  if (event.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  const value = event.result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { decision } = value;
  return typeof decision === "string" ? decision : undefined;
}

/** Every generated-XMD record that admitted its fragment. */
function admittedFragments(events: DurableEvent[]): DurableEvent[] {
  return admissions(events).filter((event) => decisionOf(event) === "admitted");
}

/** Every generated-XMD record that refused its fragment. */
function refusals(events: DurableEvent[]): DurableEvent[] {
  return admissions(events).filter((event) => decisionOf(event) === "refused");
}

/** Every Fetch observation this run committed. */
function observations(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) =>
      event.type === "yield" && event.description.type === "fetch" && event.result.status === "ok",
  );
}

/** Everything a run left behind, as one string. */
function persisted(events: DurableEvent[]): string {
  return events.map(serializeDurableEvent).join("");
}

describe("Tier GX — the trusted-host seam", () => {
  beforeAll(() => useTempFileCompiler());

  it("GX1: admits synthetic source with no Agent anywhere", function* () {
    const attempt = yield* evaluate(request("<Probe />\n", [probe()]));

    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("probed");
  });

  it("GX2: records one admission naming the source, the roots and the identities", function* () {
    const attempt = yield* evaluate(request("<Probe />\n", [probe()]));

    const [admission] = admissions(attempt.events);
    if (admission?.type !== "yield") {
      throw new Error("the run recorded no generated-XMD admission");
    }
    expect(admission.description.name).toBe("generated:turn-1");
    expect(admission.description.input).toMatchObject({
      roots: ROOTS,
      selectedRoot: ROOTS[0],
      allowed: [{ name: "Probe", identity: "test://probe" }],
    });
    expect(admission.result).toMatchObject({
      status: "ok",
      value: {
        decision: "admitted",
        source: "<Probe />\n",
        named: [{ name: "Probe", identity: "test://probe" }],
        // Retained in the result as well as the input, because durable replay
        // matches an effect by type and name and never compares a description.
        policy: {
          roots: ROOTS,
          selectedRoot: ROOTS[0],
          allowed: [{ name: "Probe", identity: "test://probe" }],
          requests: [],
        },
      },
    });
  });
});

describe("Tier GX — the complete fragment is read first", () => {
  beforeAll(() => useTempFileCompiler());

  const UNSAFE = "```bash exec\nprintf ran\n```";

  const MIXED: Array<[string, string]> = [
    ["after the safe element", `<Fetch url="${URL_ONE}" />\n\n${UNSAFE}\n`],
    ["before the safe element", `${UNSAFE}\n\n<Fetch url="${URL_ONE}" />\n`],
  ];

  for (const [where, source] of MIXED) {
    it(`GX3: an unsafe construct ${where} costs no request and no admission`, function* () {
      const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

      const attempt = yield* evaluate(request(source, [pinnedFetch([ADMITTED_REQUEST]), probe()]));

      expect(transport.performed).toHaveLength(0);
      expect(admittedFragments(attempt.events)).toHaveLength(0);
      expect(refusals(attempt.events)).toHaveLength(1);
      expect(observations(attempt.events)).toHaveLength(0);
      expect(attempt.failure).toContain("executable code block");
    });
  }

  const REFUSED: Array<[string, string, string]> = [
    [
      "an eval block that imports",
      '```js eval\nimport x from "node:fs";\n```\n',
      "executable code block",
    ],
    ["a daemon block", "```bash exec daemon\nsleep 1\n```\n", "executable code block"],
    ["a persist block", "```js eval persist\nconst a = 1;\n```\n", "executable code block"],
    ["an expression prop", "<Probe count={1 + 1} />\n", "expression prop"],
    ["a text binding read", "<Probe />\n\nthe answer is {answer}\n", "interpolation"],
    ["a frontmatter read", "value {props.token}\n", "interpolation"],
    ["a result binding", `<Fetch url="${URL_ONE}" as="r" />\n`, "binds a result"],
    ["an unknown component", "<Unknown />\n", "did not admit"],
    ["a structural construct", "<If test={true}>x</If>\n", "did not admit"],
    ["an unadmitted root component", '<Dir path="/etc" />\n', "did not admit"],
    ["an unadmitted repository component", '<Repository name="api" />\n', "did not admit"],
    ["an unadmitted worktree component", '<Worktree name="fix" />\n', "did not admit"],
    ["an unadmitted Agent directory", '<Agent.AddDir path="/etc" />\n', "did not admit"],
    ["a mutation component", '<File path="out.txt">hi</File>\n', "did not admit"],
  ];

  for (const [what, source, diagnostic] of REFUSED) {
    it(`GX4: refuses ${what} before any effect`, function* () {
      const transport = yield* useTransport(() => ({ status: 200 }));

      const attempt = yield* evaluate(request(source, [pinnedFetch([ADMITTED_REQUEST]), probe()]));

      expect(transport.performed).toHaveLength(0);
      expect(admittedFragments(attempt.events)).toHaveLength(0);
      expect(refusals(attempt.events)).toHaveLength(1);
      expect(attempt.failure).toContain(diagnostic);
    });
  }

  it("GX4b: an unsafe construct inside an admitted element's content is refused", function* () {
    const transport = yield* useTransport(() => ({ status: 200 }));

    const attempt = yield* evaluate(
      request("<Probe>\n\n```bash exec\nprintf ran\n```\n\n</Probe>\n", [
        pinnedFetch([ADMITTED_REQUEST]),
        probe(),
      ]),
    );

    expect(transport.performed).toHaveLength(0);
    expect(admittedFragments(attempt.events)).toHaveLength(0);
    expect(refusals(attempt.events)).toHaveLength(1);
    expect(attempt.failure).toContain("executable code block");
  });

  it("GX5: an inert brace is ordinary text rather than a read", function* () {
    const attempt = yield* evaluate(request("a literal { brace } stays.\n", [probe()]));

    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("{ brace }");
  });

  it("GX6: a refusal names the construct class without echoing the source", function* () {
    const attempt = yield* evaluate(
      request("```bash exec\nprintf leaked-fragment-text\n```\n", [probe()]),
    );

    expect(attempt.failure).toContain("executable code block");
    expect(attempt.failure).not.toContain("leaked-fragment-text");
    // The refusal is retained, so what it retains matters as much as what it
    // says: the class, and no part of the fragment that caused it.
    expect(persisted(attempt.events)).not.toContain("leaked-fragment-text");
    expect(persisted(attempt.events)).toContain('"construct":"block"');
  });
});

describe("Tier GX — only pinned identities execute", () => {
  beforeAll(() => useTempFileCompiler());

  it("GX7: an admitted name resolves to the pinned definition, not a repository file", function* () {
    const workspace = yield* useWorkspace();
    yield* writeTextFile(join(workspace, "Probe.md"), "the repository component ran.\n");
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));
    yield* writeTextFile(join(workspace, "Fetch.md"), "the repository Fetch ran.\n");

    const attempt = yield* evaluate(
      request(`<Probe />\n\n<Fetch url="${URL_ONE}" />\n`, [
        pinnedFetch([ADMITTED_REQUEST]),
        probe(),
      ]),
      { componentDirs: [workspace] },
    );

    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("probed");
    expect(attempt.output).not.toContain("the repository component ran");
    expect(attempt.output).not.toContain("the repository Fetch ran");
    expect(transport.performed).toHaveLength(1);
  });

  it("GX8: an unadmitted name is refused even where a repository file supplies it", function* () {
    const workspace = yield* useWorkspace();
    yield* writeTextFile(join(workspace, "Helper.md"), "the repository component ran.\n");

    const attempt = yield* evaluate(request("<Helper />\n", [probe()]), {
      componentDirs: [workspace],
    });

    expect(attempt.failure).toContain("did not admit");
    expect(admittedFragments(attempt.events)).toHaveLength(0);
    expect(refusals(attempt.events)).toHaveLength(1);
  });

  const SUBSTITUTIONS: Array<[string, ExecutionInstallation, string]> = [
    [
      "a synthetic answer",
      {
        *install() {
          yield* Component.around({
            *importComponent([name, position], next) {
              if (name === "__root__") {
                return yield* next(name, position);
              }
              return { kind: "function", name, props: PROBE.props, fn: PROBE.fn };
            },
          });
        },
      },
      "did not produce",
    ],
    [
      "a replacement for what came back",
      {
        *install() {
          yield* Component.around({
            *importComponent([name, position], next) {
              const answered = yield* next(name, position);
              if (name === "__root__") {
                return answered;
              }
              return { kind: "function", name, props: PROBE.props, fn: PROBE.fn };
            },
          });
        },
      },
      "did not produce",
    ],
    [
      "a mutation after delegation",
      {
        *install() {
          yield* Component.around({
            *importComponent([name, position], next) {
              const answered = yield* next(name, position);
              if (name !== "__root__") {
                Object.assign(answered, { name: "Substituted" });
              }
              return answered;
            },
          });
        },
      },
      "changed the definition",
    ],
  ];

  for (const [what, installation, diagnostic] of SUBSTITUTIONS) {
    it(`GX9: import middleware answering with ${what} fails before invocation`, function* () {
      const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

      const attempt = yield* evaluate(
        request(`<Fetch url="${URL_ONE}" />\n\n<Probe />\n`, [
          pinnedFetch([ADMITTED_REQUEST]),
          probe(),
        ]),
        { installations: [installation] },
      );

      expect(transport.performed).toHaveLength(0);
      expect(observations(attempt.events)).toHaveLength(0);
      expect(attempt.failure).toContain(diagnostic);
    });
  }

  it("GX10: middleware may still observe and refuse a generated import", function* () {
    const seen: string[] = [];
    const attempt = yield* evaluate(request("<Probe />\n", [probe()]), {
      installations: [
        {
          *install() {
            yield* Component.around({
              *importComponent([name, position], next) {
                if (name !== "__root__") {
                  seen.push(name);
                }
                return yield* next(name, position);
              },
            });
          },
        },
      ],
    });

    expect(seen).toEqual(["Probe"]);
    expect(attempt.output).toContain("probed");
  });
});

describe("Tier GX — the request a generated fragment may perform", () => {
  beforeAll(() => useTempFileCompiler());

  it("GX11: the exact admitted request performs once", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

    const attempt = yield* evaluate(
      request(`<Fetch url="${URL_ONE}" />\n`, [pinnedFetch([ADMITTED_REQUEST])]),
    );

    expect(attempt.failure).toBe(undefined);
    expect(transport.performed).toEqual([{ url: URL_ONE, init: { method: "GET", headers: {} } }]);
    expect(observations(attempt.events)).toHaveLength(1);
  });

  const CEILING: Record<string, Json> = {
    url: URL_ONE,
    method: "GET",
    headers: { accept: "application/json" },
    timeout: "30s",
  };

  const MISMATCHES: Array<[string, string]> = [
    [
      "a different scheme",
      `<Fetch url="http://api.example.test/one" method="GET" headers={{ accept: "application/json" }} timeout="30s" />`,
    ],
    [
      "a different host",
      `<Fetch url="https://other.example.test/one" method="GET" headers={{ accept: "application/json" }} timeout="30s" />`,
    ],
    [
      "a different path",
      `<Fetch url="${URL_ONE}/deeper" method="GET" headers={{ accept: "application/json" }} timeout="30s" />`,
    ],
    [
      "a different method",
      `<Fetch url="${URL_ONE}" method="HEAD" headers={{ accept: "application/json" }} timeout="30s" />`,
    ],
    [
      "a different header value",
      `<Fetch url="${URL_ONE}" method="GET" headers={{ accept: "text/plain" }} timeout="30s" />`,
    ],
    [
      "an extra header",
      `<Fetch url="${URL_ONE}" method="GET" headers={{ accept: "application/json", "x-extra": "1" }} timeout="30s" />`,
    ],
    ["a missing header", `<Fetch url="${URL_ONE}" method="GET" timeout="30s" />`],
    [
      "a different timeout",
      `<Fetch url="${URL_ONE}" method="GET" headers={{ accept: "application/json" }} timeout="1s" />`,
    ],
    [
      "no timeout at all",
      `<Fetch url="${URL_ONE}" method="GET" headers={{ accept: "application/json" }} />`,
    ],
  ];

  for (const [what, element] of MISMATCHES) {
    it(`GX12: ${what} performs no request`, function* () {
      const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

      const attempt = yield* evaluate(request(`${element}\n`, [pinnedFetch([CEILING])]));

      expect(transport.performed).toHaveLength(0);
      expect(admittedFragments(attempt.events)).toHaveLength(0);
      expect(refusals(attempt.events)).toHaveLength(1);
      expect(attempt.failure).toContain("did not admit");
    });
  }

  it("GX13: the exact ceiling still admits the request it describes", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

    const attempt = yield* evaluate(
      request(
        `<Fetch url="${URL_ONE}" method="GET" headers={{ Accept: "application/json" }} timeout="30s" />\n`,
        [pinnedFetch([CEILING])],
      ),
    );

    expect(attempt.failure).toBe(undefined);
    expect(transport.performed).toEqual([
      {
        url: URL_ONE,
        init: { method: "GET", headers: { accept: "application/json" }, timeout: 30_000 },
      },
    ]);
  });

  it("GX13b: two admitted reads in one fragment are two observations, not one replayed twice", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

    const attempt = yield* evaluate(
      request(`<Fetch url="${URL_ONE}" />\n\n<Fetch url="${URL_TWO}" />\n`, [
        pinnedFetch([{ url: URL_ONE }, { url: URL_TWO }]),
      ]),
    );

    expect(attempt.failure).toBe(undefined);
    expect(transport.performed.map((performed) => performed.url)).toEqual([URL_ONE, URL_TWO]);
    const names = observations(attempt.events).map((event) =>
      event.type === "yield" ? event.description.name : undefined,
    );
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("GX14: admitting Fetch without a ceiling is refused before any evaluation", function* () {
    expect(() => pinnedFetch([])).toThrow();
  });
});

describe("Tier GX — what the run keeps", () => {
  beforeAll(() => useTempFileCompiler());

  const SOURCE = `<Fetch url="${URL_ONE}" />\n`;

  /** The journal without the root's close, which is what makes the next run replay. */
  function partial(events: DurableEvent[]): InMemoryStream {
    return new InMemoryStream(
      events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
    );
  }

  it("GX15: a partial replay restores the admission and performs no second request", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

    const first = yield* evaluate(request(SOURCE, [pinnedFetch([ADMITTED_REQUEST])]));
    expect(transport.performed).toHaveLength(1);

    const again = yield* evaluate(request(SOURCE, [pinnedFetch([ADMITTED_REQUEST])]), {
      stream: partial(first.events),
    });

    expect(transport.performed).toHaveLength(1);
    expect(again.output).toBe(first.output);
    expect(admissions(again.events)).toEqual(admissions(first.events));
    expect(observations(again.events)).toEqual(observations(first.events));
  });

  it("GX16: a completed replay restores the root result and repeats no observation", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

    const first = yield* evaluate(request(SOURCE, [pinnedFetch([ADMITTED_REQUEST])]));
    expect(transport.performed).toHaveLength(1);

    const again = yield* evaluate(request(SOURCE, [pinnedFetch([ADMITTED_REQUEST])]), {
      stream: new InMemoryStream(first.events),
    });

    // A completed terminal never enters the durable body, so the preparation is
    // not run at all: the result is the recorded one, and nothing is performed.
    expect(transport.performed).toHaveLength(1);
    expect(again.failure).toBe(undefined);
    expect(again.rendered).toEqual(first.rendered);
    expect(observations(again.events)).toHaveLength(1);
  });

  it("GX17: an interruption before the commit retains no observation", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "once" }));
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
        const installation: ExecutionInstallation = {
          *prepare() {
            yield* evaluateGeneratedXmd(request(SOURCE, [pinnedFetch([ADMITTED_REQUEST])]));
          },
        };
        yield* collect(
          yield* executeInstalled(
            { ...retainedSource(ROOT_PATH, ROOT_SOURCE), stream: holding, componentDirs: [] },
            [installation],
          ),
        );
      });
      yield* reached.operation;
      yield* running.halt();
    });

    const interrupted = yield* blocked.readAll();
    expect(transport.performed).toHaveLength(1);
    expect(admissions(interrupted)).toHaveLength(1);
    expect(observations(interrupted)).toHaveLength(0);

    const continued = yield* evaluate(request(SOURCE, [pinnedFetch([ADMITTED_REQUEST])]), {
      stream: new InMemoryStream(interrupted),
    });

    expect(transport.performed).toHaveLength(2);
    expect(admissions(continued.events)).toHaveLength(1);
    expect(observations(continued.events)).toHaveLength(1);
  });
});

describe("Tier GX — a malformed generated request reports its class, not itself", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * `prepareFetchRequest()` reports what is wrong with a request by quoting it.
   * Every case below writes a distinct marker into the part it makes malformed,
   * and then asks the same three questions: did anything run, what does the run
   * say, and what did the journal keep. The marker must appear in none of them.
   */
  const MALFORMED: Array<[string, string, string]> = [
    ["an invalid URL", "gx-url-marker", `<Fetch url="gx-url-marker" />`],
    ["a non-HTTP scheme", "gx-scheme-marker", `<Fetch url="file:///gx-scheme-marker" />`],
    ["an unknown method", "GXMETHODMARKER", `<Fetch url="${URL_ONE}" method="GXMETHODMARKER" />`],
    [
      "a malformed timeout",
      "gx-timeout-marker",
      `<Fetch url="${URL_ONE}" timeout="gx-timeout-marker" />`,
    ],
    [
      "a non-string header value",
      "gx-header-marker",
      `<Fetch url="${URL_ONE}" headers={{ "gx-header-marker": 1 }} />`,
    ],
    [
      "one header name written twice",
      "gx-twice-marker",
      `<Fetch url="${URL_ONE}" headers={{ "GX-Twice-Marker": "a", "gx-twice-marker": "b" }} />`,
    ],
  ];

  for (const [what, marker, element] of MALFORMED) {
    it(`GX25: ${what} is refused as a request, carrying nothing of itself`, function* () {
      const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

      const attempt = yield* evaluate(request(`${element}\n`, [pinnedFetch([ADMITTED_REQUEST])]));

      expect(transport.performed).toHaveLength(0);
      expect(admittedFragments(attempt.events)).toHaveLength(0);
      expect(refusals(attempt.events)).toHaveLength(1);
      expect(observations(attempt.events)).toHaveLength(0);
      // The run says the class, and the journal keeps the class.
      expect(attempt.failure).toContain("did not admit");
      expect(persisted(attempt.events)).toContain('"construct":"request"');
      // And neither of them keeps the request that caused it.
      expect(attempt.failure).not.toContain(marker);
      expect(persisted(attempt.events)).not.toContain(marker);
    });
  }

  it("GX26: a malformed host ceiling fails as the host's own error, before anything is appended", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

    const attempt = yield* evaluate(
      request(`<Fetch url="${URL_ONE}" />\n`, [pinnedFetch([{ url: "gx-host-ceiling-marker" }])]),
    );

    // The host's own values are not generated text: a host that states a
    // request it cannot mean is told which one, and nothing is retained.
    expect(transport.performed).toHaveLength(0);
    expect(admissions(attempt.events)).toHaveLength(0);
    expect(attempt.failure).toContain("gx-host-ceiling-marker");
  });
});

describe("Tier GX — a resumed run is held to the ceilings it was admitted under", () => {
  beforeAll(() => useTempFileCompiler());

  /** A second definition under the same name, so a substitution is visible. */
  const OTHER: FunctionComponentDefinition = {
    kind: "function",
    name: "Probe",
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      return "the other implementation ran";
    },
  };

  /**
   * A history left by a run interrupted during preparation: the admission
   * committed, and nothing after it did.
   *
   * That is the shape these cases need, because a refusal raised by a trusted
   * preparation against a history that already holds *later* entries is
   * reported as the engine's early-return divergence rather than as its own
   * diagnostic — see GX21b, and the same masking for any ordinary preparation
   * failure.
   */
  function duringPreparation(events: DurableEvent[]): InMemoryStream {
    const admitted = events.findIndex(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );
    return new InMemoryStream(events.slice(0, admitted + 1));
  }

  /** The journal without the root's close, which is what makes the next run replay. */
  function partial(events: DurableEvent[]): InMemoryStream {
    return new InMemoryStream(
      events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
    );
  }

  /**
   * A history that holds the admission and no observation.
   *
   * The Fetch append never lands, so the run is interrupted between the two —
   * which is the only state in which a resumed fragment still has an
   * observation left to perform, and therefore the only one where a changed
   * ceiling could still widen a request.
   */
  function* interrupted(candidate: GeneratedXmdRequest): Operation<DurableEvent[]> {
    const blocked = new InMemoryStream();
    const reached = withResolvers<void>();
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
        const installation: ExecutionInstallation = {
          *prepare() {
            yield* evaluateGeneratedXmd(candidate);
          },
        };
        yield* collect(
          yield* executeInstalled(
            { ...retainedSource(ROOT_PATH, ROOT_SOURCE), stream: holding, componentDirs: [] },
            [installation],
          ),
        );
      });
      yield* reached.operation;
      yield* running.halt();
    });
    return yield* blocked.readAll();
  }

  it("GX21: a changed identity behind the same name refuses before invoking it", function* () {
    const first = yield* evaluate(request("<Probe />\n", [probe()]));
    expect(first.output).toContain("probed");

    const again = yield* evaluate(
      request("<Probe />\n", [pinnedComponent("Probe", "test://other", OTHER)]),
      { stream: duringPreparation(first.events) },
    );

    expect(again.failure).toContain("admitted under");
    // Fixed: which identity moved is exactly what a refusal must not publish.
    expect(again.failure).not.toContain("test://other");
    expect(again.failure).not.toContain("test://probe");
    expect(String(again.output ?? "")).not.toContain("the other implementation ran");
    expect(persisted(again.events)).not.toContain("the other implementation ran");
  });

  it("GX21b: the same substitution invokes nothing against a full partial history", function* () {
    const first = yield* evaluate(request("<Probe />\n", [probe()]));

    const again = yield* evaluate(
      request("<Probe />\n", [pinnedComponent("Probe", "test://other", OTHER)]),
      { stream: partial(first.events) },
    );

    // The run refuses and the replacement never runs. The message is the
    // engine's early-return divergence rather than the ceiling diagnostic:
    // a trusted preparation that fails against a history holding later entries
    // is reported that way whatever it failed for, generated XMD included.
    expect(again.failure).toBeDefined();
    expect(String(again.output ?? "")).not.toContain("the other implementation ran");
    expect(persisted(again.events)).not.toContain("the other implementation ran");
    expect(admittedFragments(again.events)).toHaveLength(1);
  });

  it("GX22: changed retained roots refuse before expansion", function* () {
    const first = yield* evaluate(request("<Probe />\n", [probe()]));

    const again = yield* evaluate(
      {
        id: "turn-1",
        source: "<Probe />\n",
        workspaceRoots: [...ROOTS, "workspace://added"],
        selectedRoot: ROOTS[0] ?? "",
        observations: [probe()],
      },
      { stream: duringPreparation(first.events) },
    );

    expect(again.failure).toContain("admitted under");
    expect(String(again.output ?? "")).not.toContain("probed");
  });

  it("GX22b: a changed selected root refuses before expansion", function* () {
    const first = yield* evaluate(request("<Probe />\n", [probe()]));

    const again = yield* evaluate(
      {
        id: "turn-1",
        source: "<Probe />\n",
        workspaceRoots: ROOTS,
        selectedRoot: ROOTS[1] ?? "",
        observations: [probe()],
      },
      { stream: duringPreparation(first.events) },
    );

    expect(again.failure).toContain("admitted under");
    expect(String(again.output ?? "")).not.toContain("probed");
  });

  it("GX23: a widened Fetch ceiling refuses before API.Fetch", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));
    const candidate = request(`<Fetch url="${URL_ONE}" />\n`, [pinnedFetch([ADMITTED_REQUEST])]);

    const history = yield* interrupted(candidate);
    expect(transport.performed).toHaveLength(1);
    expect(admissions(history)).toHaveLength(1);
    expect(observations(history)).toHaveLength(0);

    // The widened ceiling still contains the original request, so a run that
    // consulted only the current policy would admit this fragment again.
    const again = yield* evaluate(
      request(`<Fetch url="${URL_ONE}" />\n`, [pinnedFetch([ADMITTED_REQUEST, { url: URL_TWO }])]),
      { stream: new InMemoryStream(history) },
    );

    expect(transport.performed).toHaveLength(1);
    expect(observations(again.events)).toHaveLength(0);
    expect(again.failure).toContain("admitted under");
  });

  it("GX23b: the unchanged ceiling still resumes and commits the observation", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));
    const candidate = request(`<Fetch url="${URL_ONE}" />\n`, [pinnedFetch([ADMITTED_REQUEST])]);

    const history = yield* interrupted(candidate);
    expect(transport.performed).toHaveLength(1);

    const again = yield* evaluate(
      request(`<Fetch url="${URL_ONE}" />\n`, [pinnedFetch([ADMITTED_REQUEST])]),
      { stream: new InMemoryStream(history) },
    );

    expect(again.failure).toBe(undefined);
    expect(transport.performed).toHaveLength(2);
    expect(observations(again.events)).toHaveLength(1);
  });

  it("GX24: a changed current source does not change what replay expands", function* () {
    const first = yield* evaluate(request("<Probe />\n", [probe()]));

    const again = yield* evaluate(
      request("<Probe />\n\nan extra sentence the first run never had.\n", [probe()]),
      { stream: partial(first.events) },
    );

    expect(again.failure).toBe(undefined);
    expect(again.output).toBe(first.output);
    expect(again.output).not.toContain("an extra sentence");
  });

  it("GX24b: an unsafe current source does not stop replay of the retained one", function* () {
    const first = yield* evaluate(request("<Probe />\n", [probe()]));

    const again = yield* evaluate(
      request("<Probe />\n\n```bash exec\nprintf ran\n```\n", [probe()]),
      { stream: partial(first.events) },
    );

    expect(again.failure).toBe(undefined);
    expect(again.output).toBe(first.output);
  });
});

describe("Tier GX — the secret gate covers what is retained", () => {
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

  it("GX18: the gate sees the admission and the observation before either persists", function* () {
    const scanned: string[] = [];

    const attempt = yield* scoped(function* () {
      yield* useProbedScanner(scanned);
      yield* useTransport(() => ({ status: 200, body: "response-body-marker" }));
      return yield* evaluate(
        request(`<Fetch url="${URL_ONE}?query=url-marker" />\n`, [
          pinnedFetch([{ url: `${URL_ONE}?query=url-marker` }]),
        ]),
      );
    });

    expect(attempt.failure).toBe(undefined);
    const admission = scanned.find((text) => text.includes('"type":"generated_xmd"'));
    const observation = scanned.find((text) => text.includes('"type":"fetch"'));
    if (admission === undefined || observation === undefined) {
      throw new Error("the gate was not given both events");
    }
    for (const marker of ["url-marker", "workspace://primary", `${"@executablemd/core"}#Fetch`]) {
      expect(admission).toContain(marker);
    }
    expect(observation).toContain("response-body-marker");
  });

  it("GX19: a canary in the generated source refuses the admission and retains nothing", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));

    const attempt = yield* scoped(function* () {
      return yield* evaluate(
        request(`token ${CANARY}\n\n<Fetch url="${URL_ONE}" />\n`, [
          pinnedFetch([ADMITTED_REQUEST]),
        ]),
      );
    });

    expect(attempt.failure).toContain("secret detection rejected content");
    expect(attempt.failure).not.toContain(CANARY);
    expect(persisted(attempt.events)).not.toContain(CANARY);
    expect(transport.performed).toHaveLength(0);
    expect(observations(attempt.events)).toHaveLength(0);
  });

  it("GX20: a canary in the admitted request refuses the admission and performs nothing", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));
    const element = `<Fetch url="${URL_ONE}" headers={{ authorization: "${CANARY}" }} />`;

    const attempt = yield* evaluate(
      request(`${element}\n`, [
        pinnedFetch([{ url: URL_ONE, headers: { authorization: CANARY } }]),
      ]),
    );

    expect(attempt.failure).toContain("secret detection rejected content");
    expect(persisted(attempt.events)).not.toContain(CANARY);
    expect(transport.performed).toHaveLength(0);
  });
});
