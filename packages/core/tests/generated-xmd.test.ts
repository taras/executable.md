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
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { API, useHostFiles } from "@executablemd/runtime";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import {
  createDurableOperation,
  InMemoryStream,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Component, content, hasContent } from "../src/component-api.ts";
import { CORE_REGISTRY } from "../src/components/registry.ts";
import { collect } from "../src/collect.ts";
import { retainedSource } from "../src/root-source.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { useSecretScannerFactory } from "../src/secrets/policy.ts";
import { createSecretScanner } from "../src/secrets/scanner.ts";
import type { SecretScanner } from "../src/secrets/scanner.ts";
import {
  evaluateGeneratedXmd,
  pinnedComponent,
  pinnedFetch,
  pinnedFileDelete,
  pinnedFileRead,
  pinnedFileWrite,
  pinnedMutation,
} from "../host.ts";
import { executeInstalled } from "../host.ts";
import type {
  DurablePreparation,
  ExecutionInstallation,
  GeneratedComponentForm,
  GeneratedEffectClass,
  GeneratedMutation,
  GeneratedObservation,
  GeneratedObservationResult,
  GeneratedObservationValue,
  GeneratedXmdRequest,
} from "../host.ts";
import type { FunctionComponentDefinition, Json } from "../src/types.ts";

const ROOT_PATH = "workflows/agent.md";
const ROOT_SOURCE = "The host ran a generated fragment.\n";
const URL_ONE = "https://api.example.test/one";
const URL_TWO = "https://api.example.test/two";
const ROOTS = ["workspace://primary", "workspace://secondary"];
/** A root the run retains after the admission — its own legitimate progress. */
const ADVANCED = "workspace://advanced";

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
  /** What each admitted observation returned, in invocation order. */
  values?: readonly GeneratedObservationValue[];
  /** What the root document execution settled to, when it settled. */
  rendered?: Json;
  /** Why it was refused, when it was not. */
  failure?: string;
  events: DurableEvent[];
}

/**
 * Drive the evaluator from a `DurablePreparation`.
 *
 * The preparation is a harness choice, not the production path: production
 * reaches the evaluator through the workflow host's declared `<Evaluate>`
 * component inside the owning document expansion. The evaluator is an
 * `Operation` whose durable effects identify themselves against the durable
 * root they run in, so a preparation drives it unchanged — the `Workflow`
 * annotation narrows only the static yield type, which is what the cast
 * widens past.
 */
function driven(work: () => Operation<void>): ExecutionInstallation {
  return { prepare: work as DurablePreparation };
}

/**
 * Evaluate one fragment from the trusted-host seam.
 *
 * The evaluator runs inside the durable root, after the journal has been
 * admitted and before any document policy or the root import. No Agent
 * provider is installed anywhere — the source is synthetic.
 */
function evaluate(
  candidate: GeneratedXmdRequest,
  options: {
    stream?: InMemoryStream;
    componentDirs?: readonly string[];
    installations?: readonly ExecutionInstallation[];
    /** A later parent durable effect, offered by the same owning preparation. */
    after?: () => Operation<void>;
  } = {},
): Operation<Attempt> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const captured: { result?: GeneratedObservationResult } = {};
    const installation = driven(function* () {
      captured.result = yield* evaluateGeneratedXmd(candidate);
      if (options.after) {
        yield* options.after();
      }
    });
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
      return {
        output: captured.result?.output ?? "",
        values: captured.result?.observations ?? [],
        rendered: result.value,
        events,
      };
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
        const installation = driven(function* () {
          yield* evaluateGeneratedXmd(request(SOURCE, [pinnedFetch([ADMITTED_REQUEST])]));
        });
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

/**
 * Tier GX — nested generated effects belong to the owning expansion
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * The admission, every durable effect the admitted fragment performs, and any
 * later durable effect of the owning operation are one offered sequence, in
 * authored order. A partial replay offers the same sequence: completed
 * generated effects restore from their retained records without entering
 * their providers, and the run continues to the later effect rather than
 * diverging at the first retained nested record.
 */
describe("Tier GX — nested generated effects belong to the owning expansion", () => {
  beforeAll(() => useTempFileCompiler());

  /** The journal without the root's close, which is what makes the next run replay. */
  function partial(events: DurableEvent[]): InMemoryStream {
    return new InMemoryStream(
      events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
    );
  }

  /** Every effect one run offered, in journal order, by its durable type. */
  function offered(events: DurableEvent[]): string[] {
    return events.flatMap((event) => (event.type === "yield" ? [event.description.type] : []));
  }

  /** One later parent durable effect, counting how often its executor ran live. */
  function marker(executed: string[]): () => Operation<void> {
    return function* () {
      yield createDurableOperation<Json>(
        { type: "test_preparation", name: "parent-marker" },
        // deno-lint-ignore require-yield
        function* (): Operation<Json> {
          executed.push("parent-marker");
          return "marked";
        },
      );
    };
  }

  /**
   * A paired mutation whose effect is durable, so a continuation must restore
   * it rather than perform it again. The value stays out of the result: a
   * mutation's own durable record is the account of it.
   */
  function durableWrite(executed: string[]): GeneratedMutation {
    return pinnedMutation(
      "Write",
      "test://durable-write",
      {
        kind: "function",
        name: "Write",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn(): Operation<Json> {
          const body = yield* content();
          yield createDurableOperation<Json>(
            { type: "generated_write", name: "write" },
            // deno-lint-ignore require-yield
            function* (): Operation<Json> {
              executed.push(`write:${body}`);
              return null;
            },
          );
          return "";
        },
      },
      "paired",
    );
  }

  it("GX18a: a generated read and a later parent marker replay as one offered sequence", function* () {
    const transport = yield* useTransport(() => ({ status: 200, body: "body" }));
    const executed: string[] = [];
    const candidate = () =>
      request(`<Fetch url="${URL_ONE}" />\n`, [pinnedFetch([ADMITTED_REQUEST])]);

    const first = yield* evaluate(candidate(), { after: marker(executed) });
    expect(first.failure).toBe(undefined);
    expect(transport.performed).toHaveLength(1);
    expect(executed).toEqual(["parent-marker"]);
    expect(offered(first.events)).toEqual([
      "generated_xmd",
      "fetch",
      "test_preparation",
      "import_component",
    ]);

    // The continuation runs after the run's own progress: one more retained
    // root, and the run stands on it. The admission's basis is still retained,
    // so the same sequence is offered and restores.
    const again = yield* evaluate(
      { ...candidate(), workspaceRoots: [...ROOTS, ADVANCED], selectedRoot: ADVANCED },
      {
        after: marker(executed),
        stream: partial(first.events),
      },
    );

    expect(again.failure).toBe(undefined);
    expect(again.output).toBe(first.output);
    // One live call each, across both executions: the completed read and the
    // completed marker restore from their retained records.
    expect(transport.performed).toHaveLength(1);
    expect(executed).toEqual(["parent-marker"]);
    expect(offered(again.events)).toEqual([
      "generated_xmd",
      "fetch",
      "test_preparation",
      "import_component",
    ]);
    expect(admissions(again.events)).toEqual(admissions(first.events));
  });

  it("GX18b: a generated durable write and a later parent marker replay as one offered sequence", function* () {
    const executed: string[] = [];
    const candidate = () =>
      selecting(`<Write>proposed</Write>\n`, [pinnedFileRead()], {
        allow: ["write"],
        mutations: [durableWrite(executed)],
      });

    const first = yield* evaluate(candidate(), { after: marker(executed) });
    expect(first.failure).toBe(undefined);
    // The mutation performed, then the marker — and the mutation contributed
    // no observation and no receipt to the value the host reads back.
    expect(executed).toEqual(["write:proposed", "parent-marker"]);
    expect(first.values).toEqual([]);
    expect(offered(first.events)).toEqual([
      "generated_xmd",
      "generated_write",
      "test_preparation",
      "import_component",
    ]);

    // The continuation runs after the run's own progress — the very progress a
    // committed generated write makes: one more retained root, now current.
    const again = yield* evaluate(
      { ...candidate(), workspaceRoots: [...ROOTS, ADVANCED], selectedRoot: ADVANCED },
      {
        after: marker(executed),
        stream: partial(first.events),
      },
    );

    expect(again.failure).toBe(undefined);
    expect(again.output).toBe(first.output);
    expect(executed).toEqual(["write:proposed", "parent-marker"]);
    expect(offered(again.events)).toEqual([
      "generated_xmd",
      "generated_write",
      "test_preparation",
      "import_component",
    ]);
    expect(admissions(again.events)).toEqual(admissions(first.events));
  });

  it("GX18c: an empty fragment keeps its output and invents no nested effect on replay", function* () {
    const executed: string[] = [];
    const candidate = () => request("", [pinnedFetch([ADMITTED_REQUEST])]);

    const first = yield* evaluate(candidate(), { after: marker(executed) });
    expect(first.failure).toBe(undefined);
    expect(executed).toEqual(["parent-marker"]);
    expect(offered(first.events)).toEqual([
      "generated_xmd",
      "test_preparation",
      "import_component",
    ]);

    const again = yield* evaluate(candidate(), {
      after: marker(executed),
      stream: partial(first.events),
    });

    expect(again.failure).toBe(undefined);
    expect(again.output).toBe(first.output);
    expect(again.values).toEqual(first.values);
    expect(executed).toEqual(["parent-marker"]);
    expect(offered(again.events)).toEqual([
      "generated_xmd",
      "test_preparation",
      "import_component",
    ]);
  });

  it("GX18d: a rendered-only fragment keeps its output and invents no nested effect on replay", function* () {
    const executed: string[] = [];
    const candidate = () => request("The fragment renders and performs nothing.\n", [probe()]);

    const first = yield* evaluate(candidate(), { after: marker(executed) });
    expect(first.failure).toBe(undefined);
    expect(first.output).toContain("The fragment renders and performs nothing.");
    expect(executed).toEqual(["parent-marker"]);
    expect(offered(first.events)).toEqual([
      "generated_xmd",
      "test_preparation",
      "import_component",
    ]);

    const again = yield* evaluate(candidate(), {
      after: marker(executed),
      stream: partial(first.events),
    });

    expect(again.failure).toBe(undefined);
    expect(again.output).toBe(first.output);
    expect(again.values).toEqual(first.values);
    expect(executed).toEqual(["parent-marker"]);
    expect(offered(again.events)).toEqual([
      "generated_xmd",
      "test_preparation",
      "import_component",
    ]);
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
   * The probe under its admitted identity, counting live invocations — so a
   * case proves whether a continuation reached the generated component rather
   * than inferring it from rendered text alone.
   */
  function countedProbe(performed: string[]): GeneratedObservation {
    return pinnedComponent("Probe", "test://probe", {
      kind: "function",
      name: "Probe",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        performed.push("probed");
        return "probed";
      },
    });
  }

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
        const installation = driven(function* () {
          yield* evaluateGeneratedXmd(candidate);
        });
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

  it("GX22: the run's own root progression resumes and reaches the generated component", function* () {
    const performed: string[] = [];
    const first = yield* evaluate(request("<Probe />\n", [countedProbe(performed)]));
    expect(first.failure).toBe(undefined);
    expect(performed).toHaveLength(1);

    // One more retained root, and the run stands on it now. The admission's
    // basis is still retained, so the continuation proceeds — and performs the
    // observation its interrupted history never committed, once more.
    const again = yield* evaluate(
      {
        id: "turn-1",
        source: "<Probe />\n",
        workspaceRoots: [...ROOTS, ADVANCED],
        selectedRoot: ADVANCED,
        observations: [countedProbe(performed)],
      },
      { stream: duringPreparation(first.events) },
    );

    expect(again.failure).toBe(undefined);
    expect(again.output).toContain("probed");
    expect(performed).toHaveLength(2);
  });

  it("GX22b: the run may stand on another root it already retained", function* () {
    const performed: string[] = [];
    const first = yield* evaluate(request("<Probe />\n", [countedProbe(performed)]));
    expect(first.failure).toBe(undefined);
    expect(performed).toHaveLength(1);

    const again = yield* evaluate(
      {
        id: "turn-1",
        source: "<Probe />\n",
        workspaceRoots: ROOTS,
        selectedRoot: ROOTS[1] ?? "",
        observations: [countedProbe(performed)],
      },
      { stream: duringPreparation(first.events) },
    );

    expect(again.failure).toBe(undefined);
    expect(again.output).toContain("probed");
    expect(performed).toHaveLength(2);
  });

  it("GX22c: a lost admission root refuses before the component runs", function* () {
    const performed: string[] = [];
    const first = yield* evaluate(request("<Probe />\n", [countedProbe(performed)]));
    expect(performed).toHaveLength(1);

    // The admission retained both roots; this run kept only the selected one.
    const again = yield* evaluate(
      {
        id: "turn-1",
        source: "<Probe />\n",
        workspaceRoots: [ROOTS[0] ?? ""],
        selectedRoot: ROOTS[0] ?? "",
        observations: [countedProbe(performed)],
      },
      { stream: duringPreparation(first.events) },
    );

    expect(again.failure).toContain("admitted under");
    expect(String(again.output ?? "")).not.toContain("probed");
    expect(performed).toHaveLength(1);
  });

  it("GX22d: losing the admission's selected root refuses before the component runs", function* () {
    const performed: string[] = [];
    const first = yield* evaluate(request("<Probe />\n", [countedProbe(performed)]));
    expect(performed).toHaveLength(1);

    // The run progressed, but the root the admission addressed is gone.
    const again = yield* evaluate(
      {
        id: "turn-1",
        source: "<Probe />\n",
        workspaceRoots: [ROOTS[1] ?? "", ADVANCED],
        selectedRoot: ROOTS[1] ?? "",
        observations: [countedProbe(performed)],
      },
      { stream: duringPreparation(first.events) },
    );

    expect(again.failure).toContain("admitted under");
    expect(String(again.output ?? "")).not.toContain("probed");
    expect(performed).toHaveLength(1);
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

/**
 * Tier WGAC — the pinned read-only `<File>` identity
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * `<File>` reads when it has no content and writes when it has some —
 * `hasContent()` is exactly `!selfClosing`. So the two forms are two identities,
 * and a host admitting the read is not admitting the write. These prove the
 * constraint is part of the pinned identity and of the whole-fragment preflight,
 * rather than a check inside the component after earlier elements have run.
 */

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Files provider over one real directory, and what it was asked to read. */
interface Reads {
  readonly performed: string[];
}

function* useWorkspaceFiles(root: string): Operation<Reads> {
  const performed: string[] = [];
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return root;
      },
    },
    { at: "min" },
  );
  yield* useHostFiles();
  yield* API.Files.around({
    *readTextFile([input], next) {
      performed.push(input.path);
      return yield* next(input);
    },
    *writeTextFile([input], next) {
      // Recorded as a read would be, so a test asserting "zero reads" would also
      // notice a write nobody admitted.
      performed.push(`write:${input.path}`);
      return yield* next(input);
    },
    *deleteFile([input], next) {
      performed.push(`delete:${input.path}`);
      return yield* next(input);
    },
  });
  return { performed };
}

describe("Tier WGAC — the pinned read-only File", () => {
  it("WGAC1: a self-closing File reads through the ordinary Files provider", function* () {
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

    const attempt = yield* scoped(function* () {
      const reads = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(request(`<File path="notes.md" />\n`, [pinnedFileRead()]));
      return { evaluated, reads: [...reads.performed] };
    });

    expect(attempt.evaluated.failure).toBe(undefined);
    expect(attempt.evaluated.output).toContain("the retained note");
    // The ordinary component, and therefore the installed provider — not a
    // second filesystem path of the evaluator's own.
    expect(attempt.reads).toEqual(["notes.md"]);
    expect(admittedFragments(attempt.evaluated.events)).toHaveLength(1);
  });

  it("WGAC1: the read identity is not the unconstrained File identity", function* () {
    // A retained admission resumes only under the identity it was granted with,
    // and the comparison is on this string.
    expect(pinnedFileRead().identity).not.toBe("@executablemd/core#File");
    expect(pinnedFileRead().selfClosing).toBe(true);
  });

  it("WGAC13: the pinned deletion is core's own definition, in its one form", function* () {
    const deletion = pinnedFileDelete();

    expect(deletion.name).toBe("File.Delete");
    // What a retained admission is compared against, and what a continuation
    // that selected the write table is held to.
    expect(deletion.identity).toBe("@executablemd/core#File.Delete");
    // One name, one identity: the component answers the self-closing spelling
    // and refuses the paired one, so this states what the identity is rather
    // than narrowing it — and stating it is what decides a paired spelling in
    // preflight, before the fragment's first effect.
    expect(deletion.form).toBe("self-closing");
    // The exact object core's registry holds, not one shaped like it. Expansion
    // invokes a copy of this, and a same-shaped substitute is a different
    // implementation behind a name the host already granted.
    expect(deletion.definition).toBe(CORE_REGISTRY.get("File.Delete")?.default?.definition);
  });

  it("WGAC8: the result carries each observation's value, in order, beside the rendering", function* () {
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");
    const transport = yield* useTransport(() => ({ status: 200, body: "answered" }));

    // One admitted read that renders its value, one that renders nothing at all:
    // `<Fetch>` returns a record, and a component returning a non-string has
    // nowhere to render. A result taken from the rendering would keep the first
    // and lose the second.
    const source = `<File path="notes.md" />\n\n<Fetch url="${URL_ONE}" />\n`;

    const attempt = yield* scoped(function* () {
      yield* useWorkspaceFiles(root);
      return yield* evaluate(request(source, [pinnedFileRead(), pinnedFetch([ADMITTED_REQUEST])]));
    });

    expect(attempt.failure).toBe(undefined);
    expect(transport.performed.map((call) => call.url)).toEqual([URL_ONE]);

    const values = attempt.values ?? [];
    // Invocation order, and the exact field names a host reads.
    expect(values.map((observation) => observation.name)).toEqual(["File", "Fetch"]);
    // The identities live in the retained admission, which is where a run is
    // held to them — not on the result, which would be a second copy of the
    // same fact.
    const admitted = admittedFragments(attempt.events)[0];
    const named =
      admitted?.type === "yield" && admitted.result.status === "ok"
        ? admitted.result.value
        : undefined;
    expect(JSON.stringify(named)).toContain(pinnedFileRead().identity);
    expect(JSON.stringify(named)).toContain(pinnedFetch([ADMITTED_REQUEST]).identity);
    expect(values[0]?.value).toBe("the retained note\n");
    const response = values[1]?.value;
    expect(isRecord(response)).toBe(true);
    expect(isRecord(response) ? response.status : undefined).toBe(200);
    expect(isRecord(response) ? response.body : undefined).toBe("answered");

    // And the rendering, kept separately rather than standing in for them: the
    // File read renders its text, the Fetch renders nothing.
    expect(attempt.output).toContain("the retained note");
    expect(attempt.output).not.toContain("answered");
  });

  it("WGAC2: a paired File anywhere in a mixed fragment performs no read and no write", function* () {
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

    const source =
      `<File path="notes.md" />\n\n` + `<File path="proposed.md">the agent wrote this</File>\n`;

    const attempt = yield* scoped(function* () {
      const reads = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(request(source, [pinnedFileRead()]));
      return { evaluated, reads: [...reads.performed] };
    });

    expect(attempt.evaluated.failure).toContain("self-closing form");
    // The safe element before it performed nothing either: the whole fragment is
    // read before the first effect.
    expect(attempt.reads).toEqual([]);
    expect(refusals(attempt.evaluated.events)).toHaveLength(1);
    expect(admittedFragments(attempt.evaluated.events)).toHaveLength(0);
    // Nothing of the generated source reaches the record.
    expect(persisted(attempt.evaluated.events)).not.toContain("the agent wrote this");
    expect(persisted(attempt.evaluated.events)).not.toContain("proposed.md");
  });

  it("WGAC2: an empty paired File is refused too — content is the element's shape", function* () {
    const root = yield* useWorkspace();
    const attempt = yield* scoped(function* () {
      const reads = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(
        request(`<File path="truncated.md"></File>\n`, [pinnedFileRead()]),
      );
      return { evaluated, reads: [...reads.performed] };
    });

    // `<File path="x"></File>` renders empty content and would truncate the
    // file. It is not self-closing, which is the only thing that decides this.
    expect(attempt.evaluated.failure).toContain("self-closing form");
    expect(attempt.reads).toEqual([]);
  });

  it("WGAC2: an unadmitted component after an admitted read performs zero reads", function* () {
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

    const source = `<File path="notes.md" />\n\n<Glob pattern="**/*" />\n`;

    const attempt = yield* scoped(function* () {
      const reads = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(request(source, [pinnedFileRead()]));
      return { evaluated, reads: [...reads.performed] };
    });

    expect(attempt.evaluated.failure).toContain("did not admit");
    expect(attempt.reads).toEqual([]);
    expect(admittedFragments(attempt.evaluated.events)).toHaveLength(0);
  });
});

/**
 * Tier GXC — the effect classes a fragment draws on
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * The host states two tables and the caller selects between them. Three claims
 * follow from that, and everything here is one of them.
 *
 * **A selection is not a grant.** `allow` chooses among identities the host
 * already installed. An empty, repeated or unavailable selection is the host's
 * own error, raised before the candidate is parsed and before any record of it
 * exists.
 *
 * **A name is not a form.** `<File />` and `<File>…</File>` are two identities
 * under one name, and which one an element gets is decided from how it was
 * written. Selecting one class never admits the other's form.
 *
 * **A write is not an observation.** An admitted mutation performs its ordinary
 * effect and contributes nothing to the value the host reads back; its own
 * durable record is the account of it.
 */

/** A paired host mutation, so a form domain other than `<File>`'s is exercised. */
const NEST: FunctionComponentDefinition = {
  kind: "function",
  name: "Nest",
  props: { type: "object", properties: {}, additionalProperties: false },
  *fn(): Operation<Json> {
    return yield* content();
  },
};

function nest(form: GeneratedComponentForm = "paired"): GeneratedMutation {
  return pinnedMutation("Nest", "test://nest", NEST, form);
}

/** One candidate, with the classes and the write table a run states for it. */
function selecting(
  source: string,
  observations: readonly GeneratedObservation[],
  options: {
    allow?: readonly GeneratedEffectClass[];
    mutations?: readonly GeneratedMutation[];
  } = {},
): GeneratedXmdRequest {
  return {
    ...request(source, observations),
    ...(options.allow === undefined ? {} : { allow: options.allow }),
    ...(options.mutations === undefined ? {} : { mutations: options.mutations }),
  };
}

/** The normalized policy one admission recorded, as the journal holds it. */
function recordedPolicy(event: DurableEvent | undefined): Json | undefined {
  if (event?.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  const value = event.result.value;
  return isRecord(value) ? value.policy : undefined;
}

/** The identities one admission recorded the fragment naming, in order. */
function recordedNames(event: DurableEvent | undefined): Json | undefined {
  if (event?.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  const value = event.result.value;
  return isRecord(value) ? value.named : undefined;
}

describe("Tier GXC — a selection is not a grant", () => {
  beforeAll(() => useTempFileCompiler());

  it("GXC1: omitting `allow` and asking for `read` are one policy", function* () {
    const omitted = yield* evaluate(request("<Probe />\n", [probe()]));
    const explicit = yield* evaluate(selecting("<Probe />\n", [probe()], { allow: ["read"] }));

    expect(omitted.failure).toBe(undefined);
    expect(explicit.failure).toBe(undefined);
    expect(explicit.output).toBe(omitted.output);
    expect(explicit.values).toEqual(omitted.values);
    // The same retained policy, down to the class it normalized to: a document
    // that says nothing and one that says `read` are held to one grant.
    expect(recordedPolicy(admittedFragments(explicit.events)[0])).toEqual(
      recordedPolicy(admittedFragments(omitted.events)[0]),
    );
    expect(recordedPolicy(admittedFragments(omitted.events)[0])).toMatchObject({
      allow: ["read"],
    });
  });

  it("GXC1b: a mixed selection is retained in canonical order", function* () {
    const attempt = yield* evaluate(
      selecting("<Probe />\n", [probe()], {
        allow: ["write", "read"],
        mutations: [nest()],
      }),
    );

    expect(attempt.failure).toBe(undefined);
    // Authored order is not identity. A continuation compares this, so two
    // hosts asking for the same two classes must compare equal.
    expect(recordedPolicy(admittedFragments(attempt.events)[0])).toMatchObject({
      allow: ["read", "write"],
      // The read table first, the write table second, host order inside each.
      allowed: [
        { name: "Probe", identity: "test://probe", forms: ["self-closing", "paired"] },
        { name: "Nest", identity: "test://nest", forms: ["paired"] },
      ],
    });
  });

  /**
   * Every candidate below would be refused on its own terms if it were read.
   * None of them is: the selection fails first, so the marker never reaches a
   * diagnostic and no `generated_xmd` record exists to hold it.
   */
  const UNSTATEABLE: Array<
    [string, readonly GeneratedObservation[], Parameters<typeof selecting>[2], string]
  > = [
    ["no class at all", [probe()], { allow: [] }, "selected no effect class"],
    ["one class twice", [probe()], { allow: ["read", "read"] }, "one effect class twice"],
    ["`write` of a host with no write table", [probe()], { allow: ["write"] }, "no write table"],
    [
      "`write` of a host with an empty write table",
      [probe()],
      { allow: ["write"], mutations: [] },
      "no write table",
    ],
    ["`read` of a host with no read table", [], { allow: ["read"] }, "no read table"],
  ];

  for (const [what, observations, options, diagnostic] of UNSTATEABLE) {
    it(`GXC2: a selection of ${what} costs no parse and no record`, function* () {
      const transport = yield* useTransport(() => ({ status: 200 }));

      const attempt = yield* evaluate(
        selecting("```bash exec\nprintf gxc-unparsed-marker\n```\n", observations, options),
      );

      expect(attempt.failure).toContain(diagnostic);
      // Not "refused before the effect" — refused before there was a fragment.
      expect(admissions(attempt.events)).toHaveLength(0);
      expect(transport.performed).toHaveLength(0);
      expect(persisted(attempt.events)).not.toContain("gxc-unparsed-marker");
    });
  }

  it("GXC2b: a host table with one name and two overlapping forms is refused", function* () {
    const attempt = yield* evaluate(
      selecting("<Nest>x</Nest>\n", [probe()], {
        allow: ["read", "write"],
        mutations: [nest("paired"), nest("either")],
      }),
    );

    expect(attempt.failure).toContain("one name and form twice");
    expect(admissions(attempt.events)).toHaveLength(0);
  });

  it("GXC2b: a host table with one name and two definitions is refused", function* () {
    const attempt = yield* evaluate(
      selecting("<Probe />\n", [probe()], {
        allow: ["read", "write"],
        mutations: [pinnedMutation("Probe", "test://probe-write", NEST, "paired")],
      }),
    );

    // An import is asked for by name, so a name runs one implementation. Which
    // identity it ran as is the form's decision; which code runs is not.
    expect(attempt.failure).toContain("one name with two definitions");
    expect(admissions(attempt.events)).toHaveLength(0);
  });
});

describe("Tier GXC — a name is not a form", () => {
  beforeAll(() => useTempFileCompiler());

  it("GXC3: each form resolves to its own pinned identity", function* () {
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

    const attempt = yield* scoped(function* () {
      const files = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(
        selecting(
          `<File path="notes.md" />\n\n<File path="proposed.md">the fragment wrote this</File>\n`,
          [pinnedFileRead()],
          { allow: ["read", "write"], mutations: [pinnedFileWrite()] },
        ),
      );
      return { evaluated, files: [...files.performed] };
    });

    expect(attempt.evaluated.failure).toBe(undefined);
    // One name, two identities, chosen by how each element was written.
    expect(recordedNames(admittedFragments(attempt.evaluated.events)[0])).toEqual([
      { name: "File", identity: pinnedFileRead().identity, form: "self-closing" },
      { name: "File", identity: pinnedFileWrite().identity, form: "paired" },
    ]);
    expect(attempt.files).toEqual(["notes.md", "write:proposed.md"]);
    expect(yield* readTextFile(join(root, "proposed.md"))).toBe("the fragment wrote this");
  });

  const FORMS: Array<[string, string, readonly GeneratedEffectClass[], string]> = [
    [
      "a paired File under `read` alone",
      `<File path="notes.md">rewritten</File>\n`,
      ["read"],
      "self-closing form",
    ],
    [
      "a self-closing File under `write` alone",
      `<File path="notes.md" />\n`,
      ["write"],
      "paired form",
    ],
    ["a self-closing Nest under `write`", `<Nest />\n`, ["write"], "paired form"],
  ];

  for (const [what, source, allow, diagnostic] of FORMS) {
    it(`GXC4: ${what} is refused with no effect`, function* () {
      const root = yield* useWorkspace();
      yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

      const attempt = yield* scoped(function* () {
        const files = yield* useWorkspaceFiles(root);
        const evaluated = yield* evaluate(
          selecting(source, [pinnedFileRead()], {
            allow,
            mutations: [pinnedFileWrite(), nest()],
          }),
        );
        return { evaluated, files: [...files.performed] };
      });

      expect(attempt.evaluated.failure).toContain(diagnostic);
      expect(attempt.files).toEqual([]);
      expect(refusals(attempt.evaluated.events)).toHaveLength(1);
      expect(admittedFragments(attempt.evaluated.events)).toHaveLength(0);
      expect(yield* readTextFile(join(root, "notes.md"))).toBe("the retained note\n");
    });
  }

  it("GXC5: no admitted name is answered by a same-name repository component", function* () {
    const workspace = yield* useWorkspace();
    yield* writeTextFile(join(workspace, "File.md"), "the repository File ran.\n");
    yield* writeTextFile(join(workspace, "Nest.md"), "the repository Nest ran.\n");
    // A dotted name is a nested path to selection, so this is where a
    // repository component called `File.Delete` would be found.
    yield* ensureDir(join(workspace, "File"));
    yield* writeTextFile(join(workspace, "File", "Delete.md"), "the repository File.Delete ran.\n");
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");
    yield* writeTextFile(join(root, "stale.md"), "the note an earlier step left\n");

    const attempt = yield* scoped(function* () {
      const files = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(
        selecting(
          `<File path="notes.md" />\n\n<File path="proposed.md">written</File>\n\n` +
            `<Nest>held</Nest>\n\n<File.Delete path="stale.md" />\n`,
          [pinnedFileRead()],
          {
            allow: ["read", "write"],
            mutations: [pinnedFileWrite(), nest(), pinnedFileDelete()],
          },
        ),
        { componentDirs: [workspace] },
      );
      return { evaluated, files: [...files.performed] };
    });

    expect(attempt.evaluated.failure).toBe(undefined);
    expect(attempt.evaluated.output).not.toContain("the repository File ran");
    expect(attempt.evaluated.output).not.toContain("the repository Nest ran");
    expect(attempt.evaluated.output).not.toContain("the repository File.Delete ran");
    expect(attempt.files).toEqual(["notes.md", "write:proposed.md", "delete:stale.md"]);
    // The pinned component removed the file; the repository one would have
    // rendered prose and removed nothing.
    expect(yield* exists(join(root, "stale.md"))).toBe(false);
  });

  const EXCLUDED: Array<[string, string]> = [
    ["a local Git push", `<Git.Push remote="origin" />`],
    ["a Git-host pull request", `<PullRequest title="t" body="b" />`],
    ["an issue upsert", `<Issue title="t" body="b" />`],
    ["a repository", `<Repository name="api" />`],
    ["a glob", `<Glob pattern="**/*" />`],
  ];

  for (const [what, element] of EXCLUDED) {
    it(`GXC6: ${what} is outside the write table`, function* () {
      const root = yield* useWorkspace();
      yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

      const attempt = yield* scoped(function* () {
        const files = yield* useWorkspaceFiles(root);
        const evaluated = yield* evaluate(
          selecting(`${element}\n`, [pinnedFileRead()], {
            allow: ["read", "write"],
            mutations: [pinnedFileWrite(), nest()],
          }),
        );
        return { evaluated, files: [...files.performed] };
      });

      expect(attempt.evaluated.failure).toContain("did not admit");
      expect(attempt.files).toEqual([]);
      expect(admittedFragments(attempt.evaluated.events)).toHaveLength(0);
    });
  }

  it("GXC6: an executable block is refused whatever the selection", function* () {
    const attempt = yield* evaluate(
      selecting("```bash exec\nprintf ran\n```\n", [pinnedFileRead()], {
        allow: ["read", "write"],
        mutations: [pinnedFileWrite(), nest()],
      }),
    );

    expect(attempt.failure).toContain("executable code block");
    expect(admittedFragments(attempt.events)).toHaveLength(0);
  });
});

describe("Tier GXC — a write is not an observation", () => {
  beforeAll(() => useTempFileCompiler());

  it("GXC7: a write-only fragment observes nothing and renders nothing", function* () {
    const root = yield* useWorkspace();

    const attempt = yield* scoped(function* () {
      const files = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(
        selecting(`<Nest><File path="proposed.md">written</File></Nest>\n`, [pinnedFileRead()], {
          allow: ["write"],
          mutations: [pinnedFileWrite(), nest()],
        }),
      );
      return { evaluated, files: [...files.performed] };
    });

    expect(attempt.evaluated.failure).toBe(undefined);
    expect(attempt.files).toEqual(["write:proposed.md"]);
    // The exact shape a document binds: no synthetic receipt for the write, and
    // no text, because neither of these components renders any. What is left is
    // the fragment's own line break, which is what the source had in it.
    expect(attempt.evaluated.values).toEqual([]);
    expect(attempt.evaluated.output?.trim()).toBe("");
  });

  it("GXC7: a mixed fragment collects the read and not the write", function* () {
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

    const attempt = yield* scoped(function* () {
      yield* useWorkspaceFiles(root);
      return yield* evaluate(
        selecting(
          `<File path="notes.md" />\n\n<File path="proposed.md">written</File>\n`,
          [pinnedFileRead()],
          { allow: ["read", "write"], mutations: [pinnedFileWrite()] },
        ),
      );
    });

    expect(attempt.failure).toBe(undefined);
    // One entry, under the read identity's name, holding what the read returned.
    expect(attempt.values).toEqual([{ name: "File", value: "the retained note\n" }]);
  });

  const PARTIAL: Array<[string, string]> = [
    [
      "an unadmitted sibling after an admitted write",
      `<File path="proposed.md">written</File>\n\n<Glob pattern="**/*" />\n`,
    ],
    [
      "an unadmitted child under an admitted parent",
      `<Nest>\n\n<File path="proposed.md">written</File>\n\n<Glob pattern="**/*" />\n\n</Nest>\n`,
    ],
    [
      "an unadmitted form after an admitted write",
      `<File path="proposed.md">written</File>\n\n<Nest />\n`,
    ],
  ];

  for (const [what, source] of PARTIAL) {
    it(`GXC8: ${what} performs no write at all`, function* () {
      const root = yield* useWorkspace();

      const attempt = yield* scoped(function* () {
        const files = yield* useWorkspaceFiles(root);
        const evaluated = yield* evaluate(
          selecting(source, [pinnedFileRead()], {
            allow: ["write"],
            mutations: [pinnedFileWrite(), nest()],
          }),
        );
        return { evaluated, files: [...files.performed] };
      });

      expect(attempt.files).toEqual([]);
      expect(refusals(attempt.evaluated.events)).toHaveLength(1);
      expect(admittedFragments(attempt.evaluated.events)).toHaveLength(0);
      // The whole fragment is decided inside the admission, so what a refusal
      // retains is the class and nothing the candidate carried.
      expect(persisted(attempt.evaluated.events)).not.toContain("proposed.md");
      expect(yield* exists(join(root, "proposed.md"))).toBe(false);
    });
  }
});

describe("Tier GXC — a resumed run is held to its classes and forms", () => {
  beforeAll(() => useTempFileCompiler());

  const WRITE = `<File path="proposed.md">written</File>\n`;

  /** A history holding the admission and nothing after it. */
  function duringPreparation(events: DurableEvent[]): InMemoryStream {
    const admitted = events.findIndex(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );
    return new InMemoryStream(events.slice(0, admitted + 1));
  }

  function admitWrite(root: string): Operation<Attempt> {
    return scoped(function* () {
      yield* useWorkspaceFiles(root);
      return yield* evaluate(
        selecting(WRITE, [pinnedFileRead()], {
          allow: ["write"],
          mutations: [pinnedFileWrite()],
        }),
      );
    });
  }

  const MOVED: Array<[string, Parameters<typeof selecting>[2]]> = [
    ["a widened class selection", { allow: ["read", "write"], mutations: [pinnedFileWrite()] }],
    [
      "a widened admitted form",
      {
        allow: ["write"],
        mutations: [pinnedMutation("File", pinnedFileWrite().identity, NEST, "either")],
      },
    ],
    [
      "a replaced write identity",
      {
        allow: ["write"],
        mutations: [pinnedMutation("File", "test://other-write", NEST, "paired")],
      },
    ],
    ["an added write identity", { allow: ["write"], mutations: [pinnedFileWrite(), nest()] }],
  ];

  for (const [what, options] of MOVED) {
    it(`GXC9: ${what} refuses the continuation and writes nothing`, function* () {
      const root = yield* useWorkspace();
      const first = yield* admitWrite(root);
      expect(first.failure).toBe(undefined);
      yield* rm(join(root, "proposed.md"), { force: true });

      const again = yield* scoped(function* () {
        const files = yield* useWorkspaceFiles(root);
        const evaluated = yield* evaluate(selecting(WRITE, [pinnedFileRead()], options), {
          stream: duringPreparation(first.events),
        });
        return { evaluated, files: [...files.performed] };
      });

      expect(again.evaluated.failure).toContain("admitted under");
      expect(again.files).toEqual([]);
      expect(yield* exists(join(root, "proposed.md"))).toBe(false);
    });
  }

  it("GXC9b: the unchanged write policy resumes and performs the write", function* () {
    const root = yield* useWorkspace();
    const first = yield* admitWrite(root);
    expect(first.failure).toBe(undefined);
    yield* rm(join(root, "proposed.md"), { force: true });

    const again = yield* scoped(function* () {
      const files = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(
        selecting(WRITE, [pinnedFileRead()], {
          allow: ["write"],
          mutations: [pinnedFileWrite()],
        }),
        { stream: duringPreparation(first.events) },
      );
      return { evaluated, files: [...files.performed] };
    });

    expect(again.evaluated.failure).toBe(undefined);
    expect(again.files).toEqual(["write:proposed.md"]);
    expect(yield* readTextFile(join(root, "proposed.md"))).toBe("written");
  });

  it("GXC9c: a read-only admission survives a changed write table it never selected", function* () {
    const first = yield* evaluate(
      selecting("<Probe />\n", [probe()], { allow: ["read"], mutations: [nest()] }),
    );
    expect(first.failure).toBe(undefined);

    // The write table moved and the selection never reached it, so nothing this
    // admission was granted under has changed.
    const again = yield* evaluate(
      selecting("<Probe />\n", [probe()], {
        allow: ["read"],
        mutations: [pinnedMutation("Nest", "test://replaced", NEST, "paired")],
      }),
      { stream: duringPreparation(first.events) },
    );

    expect(again.failure).toBe(undefined);
    expect(again.output).toBe(first.output);
  });
});

describe("Tier GXC — the authored form survives the public content chain", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * A handler outside the generated scope, answering each call from a script.
   *
   * The last entry repeats, so `[true]` lies the same way every time and
   * `[false, true]` is the toggle that defeats any caller which checks the
   * chain and then invokes something that reads it again.
   */
  function scripted(script: readonly boolean[], answered: boolean[]): ExecutionInstallation {
    let call = 0;
    return {
      *install() {
        yield* Component.around({
          // deno-lint-ignore require-yield
          *hasContent(_args, _next) {
            const answer = script[Math.min(call, script.length - 1)] ?? false;
            call += 1;
            answered.push(answer);
            return answer;
          },
        });
      },
    };
  }

  /** A read component that reports what the chain answers, so a lie is visible. */
  function says(): GeneratedObservation {
    return pinnedComponent("Says", "test://says", {
      kind: "function",
      name: "Says",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<Json> {
        return `says:${yield* hasContent()}`;
      },
    });
  }

  const REPORTING: Array<[string, readonly boolean[]]> = [
    ["a handler that always reports content", [true]],
    ["a handler that answers false then true", [false, true]],
  ];

  for (const [what, script] of REPORTING) {
    it(`GXC10: an admitted read still reads under ${what}`, function* () {
      const root = yield* useWorkspace();
      yield* writeTextFile(join(root, "notes.md"), "the retained note\n");
      const answered: boolean[] = [];

      const attempt = yield* scoped(function* () {
        const files = yield* useWorkspaceFiles(root);
        const evaluated = yield* evaluate(
          selecting(`<Says />\n\n<File path="notes.md" />\n`, [pinnedFileRead(), says()], {
            allow: ["read"],
          }),
          { installations: [scripted(script, answered)] },
        );
        return { evaluated, files: [...files.performed] };
      });

      expect(attempt.evaluated.failure).toBe(undefined);
      // Exactly one call, and it is `<Says />`'s: the handler is installed and
      // reporting content, which is what would have sent the self-closing
      // `<File />` down the write branch. A `<File>` that queried the chain
      // would take the second scripted answer and truncate, failing below.
      expect(answered).toEqual([script[0]]);
      expect(String(attempt.evaluated.output)).toContain("says:");
      // One read, no write, and the file it was admitted to read is unchanged.
      expect(attempt.files).toEqual(["notes.md"]);
      expect(yield* readTextFile(join(root, "notes.md"))).toBe("the retained note\n");
      expect(attempt.evaluated.values).toEqual([
        { name: "Says", value: `says:${script[0]}` },
        { name: "File", value: "the retained note\n" },
      ]);
      // And the admission still names the identity and form it was granted for.
      expect(recordedNames(admittedFragments(attempt.evaluated.events)[0])).toEqual([
        { name: "Says", identity: "test://says", form: "self-closing" },
        { name: "File", identity: pinnedFileRead().identity, form: "self-closing" },
      ]);
    });
  }

  const DENYING: Array<[string, readonly boolean[]]> = [
    ["a handler that always denies content", [false]],
    ["a handler that answers true then false", [true, false]],
  ];

  for (const [what, script] of DENYING) {
    it(`GXC10: an admitted write still writes under ${what}`, function* () {
      const root = yield* useWorkspace();
      const answered: boolean[] = [];

      const attempt = yield* scoped(function* () {
        const files = yield* useWorkspaceFiles(root);
        const evaluated = yield* evaluate(
          selecting(
            `<Says />\n\n<File path="proposed.md">the fragment wrote this</File>\n`,
            [pinnedFileRead(), says()],
            { allow: ["read", "write"], mutations: [pinnedFileWrite()] },
          ),
          { installations: [scripted(script, answered)] },
        );
        return { evaluated, files: [...files.performed] };
      });

      expect(attempt.evaluated.failure).toBe(undefined);
      // Exactly one call, and it is `<Says />`'s: the handler is installed and
      // answering, and the paired `<File>` consulted it not at all. A `<File>`
      // that queried the chain would take the second scripted answer — which
      // denies content — and read instead of writing, failing below.
      expect(answered).toEqual([script[0]]);
      expect(attempt.evaluated.values).toEqual([{ name: "Says", value: `says:${script[0]}` }]);
      // One write of the admitted bytes, and no read of a path the fragment
      // never asked to read.
      expect(attempt.files).toEqual(["write:proposed.md"]);
      expect(yield* readTextFile(join(root, "proposed.md"))).toBe("the fragment wrote this");
      expect(recordedNames(admittedFragments(attempt.evaluated.events)[0])).toEqual([
        { name: "Says", identity: "test://says", form: "self-closing" },
        { name: "File", identity: pinnedFileWrite().identity, form: "paired" },
      ]);
    });
  }

  it("GXC10: an invocation the evaluator did not receive is refused", function* () {
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

    const attempt = yield* scoped(function* () {
      const files = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(
        selecting(`<File path="notes.md" />\n`, [pinnedFileRead()], { allow: ["read"] }),
        {
          installations: [
            {
              *install() {
                yield* Component.around({
                  *importComponent([name, position], next) {
                    const definition = yield* next(name, position);
                    if (name !== "File" || definition.kind !== "function") {
                      return definition;
                    }
                    const original = definition.fn;
                    if (typeof original !== "function") {
                      return definition;
                    }
                    // A stand-in the wrapper built, reported as content-bearing.
                    // The witness refuses the substituted definition first; the
                    // form check is what would refuse it if one ever got past.
                    return {
                      ...definition,
                      *fn(props: Record<string, Json>) {
                        return yield* original(props, { hasContent: () => true });
                      },
                    };
                  },
                });
              },
            },
          ],
        },
      );
      return { evaluated, files: [...files.performed] };
    });

    expect(attempt.evaluated.failure).toBeDefined();
    expect(attempt.files).toEqual([]);
    expect(yield* readTextFile(join(root, "notes.md"))).toBe("the retained note\n");
  });

  it("GXC10: an honest chain still runs both forms through ordinary providers", function* () {
    const root = yield* useWorkspace();
    yield* writeTextFile(join(root, "notes.md"), "the retained note\n");

    const attempt = yield* scoped(function* () {
      const files = yield* useWorkspaceFiles(root);
      const evaluated = yield* evaluate(
        selecting(
          `<File path="notes.md" />\n\n<File path="proposed.md">the fragment wrote this</File>\n`,
          [pinnedFileRead()],
          { allow: ["read", "write"], mutations: [pinnedFileWrite()] },
        ),
        { installations: [observing()] },
      );
      return { evaluated, files: [...files.performed] };
    });

    expect(attempt.evaluated.failure).toBe(undefined);
    expect(attempt.files).toEqual(["notes.md", "write:proposed.md"]);
    expect(yield* readTextFile(join(root, "proposed.md"))).toBe("the fragment wrote this");
  });

  /** A handler outside the generated scope that observes and delegates. */
  function observing(): ExecutionInstallation {
    return {
      *install() {
        yield* Component.around({
          *hasContent(_args, next) {
            return yield* next();
          },
        });
      },
    };
  }
});
