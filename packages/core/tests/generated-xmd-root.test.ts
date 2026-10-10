/**
 * Tier GR — evaluating generated source as a root.
 *
 * A trusted host that means to show somebody what an Agent's reply *says* needs
 * the one construct a fragment has no context for: a top-level `<Output>`, which
 * selects what the reply renders and leaves everything around it as work. So
 * `evaluateGeneratedXmdRoot()` admits the same source the fragment evaluator
 * does, through the same walk, the same durable record and the same pinned
 * resolution, and differs over exactly that.
 *
 * Three claims are under test here.
 *
 * **A root selects what it renders, and says whether it selected.** `hasOutput`
 * is the root's own declaration rather than a measurement of the text, so an
 * `<Output>` region that renders nothing is a different answer from a root that
 * declared no region at all — which is what lets a host suppress the ordinary
 * whole-body fallback without reading the source itself.
 *
 * **An ordinary failure is the request's, and keeps what the root rendered.**
 * Source core refused, and work the root's own elements failed at, come back as
 * `Err`. A root that began rendering carries the rendering it had produced; one
 * refused at admission performed nothing and carries none, because an empty
 * rendering for work that never started would not be true.
 *
 * **Context is a ceiling.** A root admission does not resume as a fragment and a
 * fragment admission does not resume as a root, so neither can expand source the
 * other was admitted for. Every fragment record written before roots existed
 * stays readable and resumable as what it is.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import { API } from "@executablemd/runtime";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import { content } from "../src/component-api.ts";
import { pinnedJson } from "../src/generated-xmd.ts";
import { retainedSource } from "../src/root-source.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import {
  evaluateGeneratedXmd,
  evaluateGeneratedXmdRoot,
  pinnedComponent,
  pinnedFetch,
  pinnedMutation,
} from "../host.ts";
import { executeInstalled } from "../host.ts";
import type {
  DurablePreparation,
  ExecutionInstallation,
  GeneratedMutation,
  GeneratedObservation,
  GeneratedXmdRequest,
  GeneratedXmdRootResult,
  RetainedFragmentIdentity,
} from "../host.ts";
import type { Json } from "../src/types.ts";

const ROOT_PATH = "repl/sidekick.md";
const ROOT_SOURCE = "The host evaluated a generated root.\n";
const URL_ONE = "https://api.example.test/one";

/** One request the host admits, written the way an element writes it. */
const ADMITTED_REQUEST: Record<string, Json> = { url: URL_ONE };

function hostIdentity(origin: string, key: string, revision = "1"): RetainedFragmentIdentity {
  return { kind: "component-answer", origin, key, revision };
}

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/** The one host observation these cases admit beside `<Fetch>`. */
function countedProbe(performed: string[]): GeneratedObservation {
  return pinnedComponent("Probe", hostIdentity("test://probe", "Probe"), {
    kind: "function",
    name: "Probe",
    props: NO_PROPS,
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      performed.push("probed");
      return "probed";
    },
  });
}

/**
 * A component that fails the way a host control fails: on its own terms, after
 * whatever ran before it already ran.
 */
function failing(performed: string[]): GeneratedObservation {
  return pinnedComponent("Boom", hostIdentity("test://boom", "Boom"), {
    kind: "function",
    name: "Boom",
    props: NO_PROPS,
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      performed.push("boomed");
      throw new Error("the control refused this request");
    },
  });
}

/** A paired-only entry, so writing it self-closing is a form refusal. */
function paired(): GeneratedMutation {
  return pinnedMutation(
    "Nest",
    hostIdentity("test://nest", "Nest"),
    {
      kind: "function",
      name: "Nest",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return "nested";
      },
    },
    "paired",
  );
}

/** A self-closing-only entry, so giving it content is a content refusal. */
function selfClosing(): GeneratedMutation {
  return pinnedMutation(
    "Flat",
    hostIdentity("test://flat", "Flat"),
    {
      kind: "function",
      name: "Flat",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return "flat";
      },
    },
    "self-closing",
  );
}

interface Ceilings {
  readonly observations?: readonly GeneratedObservation[];
  readonly mutations?: readonly GeneratedMutation[];
  readonly allow?: readonly ("read" | "write")[];
}

/**
 * One generated request, with no Workspace basis.
 *
 * A Sidekick host evaluates against none — its admitted effects address the
 * providers its own execution installed — so these cases state none either.
 *
 * A read table is always stated, because a selection that reaches an empty one
 * is the host's own mistake and the evaluator says so before it has anything to
 * say about the source. The probe is the table a case that only cares about
 * structure gets.
 */
function request(source: string, ceilings: Ceilings = {}): GeneratedXmdRequest {
  const stated = ceilings.observations ?? [];
  return {
    id: "turn-1",
    source,
    observations: stated.length > 0 ? stated : [countedProbe([])],
    ...(ceilings.mutations === undefined ? {} : { mutations: ceilings.mutations }),
    ...(ceilings.allow === undefined ? {} : { allow: ceilings.allow }),
  };
}

/** What one substituted transport was asked to do. */
interface Transport {
  readonly performed: Array<{ url: string; init: FetchInit | undefined }>;
}

function* useTransport(body: string): Operation<Transport> {
  const performed: Transport["performed"] = [];
  yield* API.Fetch.around(
    {
      // deno-lint-ignore require-yield
      *fetch([url, init]): Operation<RuntimeFetchResponse> {
        performed.push({ url, init });
        return {
          status: 200,
          headers: { get: () => null, entries: () => [] },
          // deno-lint-ignore require-yield
          *text(): Operation<string> {
            return body;
          },
        };
      },
    },
    { at: "min" },
  );
  return { performed };
}

/**
 * Drive an evaluator from a `DurablePreparation`.
 *
 * A harness choice, not the production path: the CLI reaches the root evaluator
 * from its own Sidekick owner. What a preparation gives these cases is a durable
 * root the evaluator's own records belong to, which is the only thing a
 * continuation needs.
 */
function driven(work: () => Operation<void>): ExecutionInstallation {
  return { prepare: work as DurablePreparation };
}

/** What one host-driven root evaluation produced. */
interface Attempt {
  /** What the evaluator answered, when the run reached it. */
  readonly answer?: Result<GeneratedXmdRootResult>;
  /** Why the run itself failed, when it did. */
  readonly failure?: string;
  readonly events: DurableEvent[];
}

function evaluateRoot(
  candidate: GeneratedXmdRequest,
  options: { stream?: InMemoryStream } = {},
): Operation<Attempt> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const captured: { answer?: Result<GeneratedXmdRootResult> } = {};
    const installation = driven(function* () {
      captured.answer = yield* evaluateGeneratedXmdRoot(candidate);
    });
    const execution = yield* executeInstalled(
      { ...retainedSource(ROOT_PATH, ROOT_SOURCE), stream },
      [installation],
    );
    const result = yield* execution;
    const events = yield* stream.readAll();
    if (result.ok) {
      return { ...(captured.answer === undefined ? {} : { answer: captured.answer }), events };
    }
    return { failure: result.error.message, events };
  });
}

/** The same, through the fragment evaluator, so one context can follow another. */
function evaluateFragment(
  candidate: GeneratedXmdRequest,
  options: { stream?: InMemoryStream } = {},
): Operation<{ output?: string; failure?: string; events: DurableEvent[] }> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const captured: { output?: string } = {};
    const installation = driven(function* () {
      captured.output = yield* evaluateGeneratedXmd(candidate);
    });
    const execution = yield* executeInstalled(
      { ...retainedSource(ROOT_PATH, ROOT_SOURCE), stream },
      [installation],
    );
    const result = yield* execution;
    const events = yield* stream.readAll();
    if (result.ok) {
      return { output: captured.output ?? "", events };
    }
    return { failure: result.error.message, events };
  });
}

function admissions(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

function observations(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) =>
      event.type === "yield" && event.description.type === "fetch" && event.result.status === "ok",
  );
}

/** A history holding the admission and nothing after it. */
function duringPreparation(events: DurableEvent[]): InMemoryStream {
  const admitted = events.findIndex(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
  return new InMemoryStream(events.slice(0, admitted + 1));
}

/** The policy one admission retained, for a case that reads the record. */
function retainedPolicy(events: DurableEvent[]): Record<string, Json> {
  const [admission] = admissions(events);
  if (admission?.type !== "yield" || admission.result.status !== "ok") {
    throw new Error("the run recorded no generated-XMD admission");
  }
  const value = admission.result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the admission record is not an object");
  }
  const { policy } = value;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error("the admission record holds no policy");
  }
  return policy;
}

/** What the evaluator answered, or a failure naming why there is nothing to read. */
function answered(attempt: Attempt): Result<GeneratedXmdRootResult> {
  expect(attempt.failure).toBe(undefined);
  if (attempt.answer === undefined) {
    throw new Error("the run never reached the root evaluator");
  }
  return attempt.answer;
}

function rendered(attempt: Attempt): GeneratedXmdRootResult {
  const answer = answered(attempt);
  if (!answer.ok) {
    throw new Error(`the root failed: ${answer.error.message}`);
  }
  return answer.value;
}

function failed(attempt: Attempt): Error & { partial?: GeneratedXmdRootResult } {
  const answer = answered(attempt);
  if (answer.ok) {
    throw new Error(`the root succeeded, rendering ${JSON.stringify(answer.value)}`);
  }
  return answer.error;
}

describe("Tier GR — a root selects what it renders", () => {
  beforeAll(() => useTempFileCompiler());

  it("GR1: an explicit Output region is the whole rendering, and the root says it declared one", function* () {
    const performed: string[] = [];
    const attempt = yield* evaluateRoot(
      request("documentation\n\n<Output>\nHello there.\n</Output>\n\nmore documentation\n", {
        observations: [countedProbe(performed)],
      }),
    );

    const result = rendered(attempt);
    expect(result.hasOutput).toBe(true);
    expect(result.output).toContain("Hello there.");
    expect(result.output).not.toContain("documentation");
  });

  it("GR2: an Output region that renders nothing still declares one", function* () {
    const attempt = yield* evaluateRoot(request("<Output></Output>\n"));

    expect(rendered(attempt)).toEqual({ output: "", hasOutput: true });
  });

  it("GR3: a root with no Output renders its whole body and declares none", function* () {
    const performed: string[] = [];
    const attempt = yield* evaluateRoot(
      request("Hello there.\n\n<Probe />\n", { observations: [countedProbe(performed)] }),
    );

    const result = rendered(attempt);
    expect(result.hasOutput).toBe(false);
    expect(result.output).toContain("Hello there.");
    expect(result.output).toContain("probed");
    expect(performed).toEqual(["probed"]);
  });

  it("GR4: documentation beside a region runs for its effects and renders nothing", function* () {
    const performed: string[] = [];
    const attempt = yield* evaluateRoot(
      request("<Probe />\n\n<Output>\nselected\n</Output>\n", {
        observations: [countedProbe(performed)],
      }),
    );

    const result = rendered(attempt);
    expect(result.output).toContain("selected");
    expect(result.output).not.toContain("probed");
    // It ran — rendering nothing is a decision about what the root shows, not
    // about what its documentation does.
    expect(performed).toEqual(["probed"]);
  });

  it("GR5: several regions render in source order as one rendering", function* () {
    const performed: string[] = [];
    const attempt = yield* evaluateRoot(
      request("<Output>\nfirst\n</Output>\n\n<Probe />\n\n<Output>\nsecond\n</Output>\n", {
        observations: [countedProbe(performed)],
      }),
    );

    const result = rendered(attempt);
    expect(result.hasOutput).toBe(true);
    expect(result.output.indexOf("first")).toBeGreaterThanOrEqual(0);
    expect(result.output.indexOf("second")).toBeGreaterThan(result.output.indexOf("first"));
    expect(result.output).not.toContain("probed");
    expect(performed).toEqual(["probed"]);
  });
});

describe("Tier GR — an ordinary failure keeps what the root rendered", () => {
  beforeAll(() => useTempFileCompiler());

  it("GR6: a runtime failure after a committed effect answers Err with the rendering so far", function* () {
    const performed: string[] = [];
    const transport = yield* useTransport("fetched");
    const attempt = yield* evaluateRoot(
      request(`<Output>\nbefore\n\n<Fetch url="${URL_ONE}" />\n\n<Boom />\n\nafter\n</Output>\n`, {
        observations: [pinnedFetch([ADMITTED_REQUEST]), failing(performed)],
      }),
    );

    const error = failed(attempt);
    // The control's own sentence, and nothing around it.
    expect(error.message).toContain("the control refused this request");
    expect(error.message).not.toContain("generated-xmd-root.test.ts");
    // The effect before it happened and is retained: a failure is not a
    // rollback.
    expect(transport.performed).toHaveLength(1);
    expect(observations(attempt.events)).toHaveLength(1);
    // And the rendering the root had produced when it failed, carrying the same
    // declaration the success would have carried.
    expect(error.partial?.hasOutput).toBe(true);
    expect(error.partial?.output).toContain("before");
    expect(error.partial?.output).not.toContain("after");
    expect(performed).toEqual(["boomed"]);
  });

  it("GR7: a root with no Output that fails partway keeps what it rendered", function* () {
    const performed: string[] = [];
    const attempt = yield* evaluateRoot(
      request("before\n\n<Boom />\n\nafter\n", { observations: [failing(performed)] }),
    );

    const error = failed(attempt);
    expect(error.partial?.hasOutput).toBe(false);
    expect(error.partial?.output).toContain("before");
    expect(error.partial?.output).not.toContain("after");
  });

  it("GR8: an admission refusal carries no rendering, because nothing was rendered", function* () {
    const attempt = yield* evaluateRoot(request("<Unknown />\n"));

    const error = failed(attempt);
    expect(error.message).toContain("did not admit");
    expect(error.partial).toBe(undefined);
    expect(observations(attempt.events)).toHaveLength(0);
  });
});

describe("Tier GR — the root context admits one construct more, and no others", () => {
  beforeAll(() => useTempFileCompiler());

  const REFUSED: Array<[string, string, string, Ceilings]> = [
    ["a name this host did not admit", "<Unknown />\n", "did not admit", {}],
    [
      "an executable code block",
      "<Output>\nok\n</Output>\n\n```bash exec\nprintf ran\n```\n",
      "executable code block",
      {},
    ],
    [
      "a computed expression prop",
      "<Output>\n<Probe value={1 + 1} />\n</Output>\n",
      "declarative data",
      { observations: [countedProbe([])] },
    ],
    ["<Content />", "<Output>\n<Content />\n</Output>\n", "structural construct", {}],
    ["<Return />", '<Output>\nok\n</Output>\n\n<Return value="x" />\n', "structural construct", {}],
    [
      "an <Output> written below the top level",
      "<If condition={true}>\n<Output>\nok\n</Output>\n</If>\n",
      "structural construct",
      {},
    ],
    [
      "an <Output> carrying a prop",
      '<Output name="chat">\nok\n</Output>\n',
      "structural construct",
      {},
    ],
    [
      "a paired-only identity written self-closing",
      "<Output>\n<Nest />\n</Output>\n",
      "self-closing a component",
      { allow: ["write"], mutations: [paired()] },
    ],
    [
      "a self-closing-only identity given content",
      "<Output>\n<Flat>x</Flat>\n</Output>\n",
      "only in its self-closing form",
      { allow: ["write"], mutations: [selfClosing()] },
    ],
    [
      "an unadmitted name in a branch this run would not take",
      "<Output>\n<If condition={false}>\nok\n<Else>\n<Unknown />\n</Else>\n</If>\n</Output>\n",
      "did not admit",
      {},
    ],
  ];

  for (const [what, source, reason, ceilings] of REFUSED) {
    it(`GR9: ${what} refuses the root before any effect`, function* () {
      const performed: string[] = [];
      const transport = yield* useTransport("fetched");
      const attempt = yield* evaluateRoot(
        request(source, {
          ...ceilings,
          observations: [
            pinnedFetch([ADMITTED_REQUEST]),
            failing(performed),
            ...(ceilings.observations ?? []),
          ],
        }),
      );

      const error = failed(attempt);
      expect(error.message).toContain(reason);
      expect(error.partial).toBe(undefined);
      expect(transport.performed).toHaveLength(0);
      expect(observations(attempt.events)).toHaveLength(0);
      expect(performed).toEqual([]);
      // The source is untrusted text, and a refusal of it does not republish it.
      expect(error.message).not.toContain("Unknown");
      expect(error.message).not.toContain("printf");
    });
  }

  it("GR10: a fragment still has no context for a top-level Output", function* () {
    const attempt = yield* evaluateFragment(request("<Output>\nok\n</Output>\n"));

    expect(attempt.failure).toContain("structural construct");
  });
});

describe("Tier GR — a retained admission resumes only in its own context", () => {
  beforeAll(() => useTempFileCompiler());

  /** Source whose one effect is retained by its own durable record. */
  const WITH_EFFECT = `<Output>\n<Fetch url="${URL_ONE}" />\n</Output>\n`;
  const FRAGMENT_EFFECT = `<Fetch url="${URL_ONE}" />\n`;

  it("GR11: a root admission records its context, and a fragment admission records none", function* () {
    const asRoot = yield* evaluateRoot(request("<Output>\nok\n</Output>\n"));
    expect(rendered(asRoot).hasOutput).toBe(true);
    expect(retainedPolicy(asRoot.events).context).toBe("root");

    const asFragment = yield* evaluateFragment(request("ok\n"));
    expect(asFragment.failure).toBe(undefined);
    // The shape every fragment record before roots existed was written in. A
    // member added here would make this build's records unreadable to the one
    // that wrote them.
    expect(Object.hasOwn(retainedPolicy(asFragment.events), "context")).toBe(false);
  });

  it("GR12: the same context resumes and performs the effect it had not reached", function* () {
    const first = yield* scoped(function* () {
      yield* useTransport("fetched");
      return yield* evaluateRoot(
        request(WITH_EFFECT, { observations: [pinnedFetch([ADMITTED_REQUEST])] }),
      );
    });
    expect(rendered(first).hasOutput).toBe(true);
    expect(observations(first.events)).toHaveLength(1);

    const again = yield* scoped(function* () {
      const transport = yield* useTransport("fetched again");
      const attempt = yield* evaluateRoot(
        request(WITH_EFFECT, { observations: [pinnedFetch([ADMITTED_REQUEST])] }),
        { stream: duringPreparation(first.events) },
      );
      return { attempt, performed: transport.performed.length };
    });

    // The admission restored, and the effect it had not reached performed once.
    expect(rendered(again.attempt).hasOutput).toBe(true);
    expect(again.performed).toBe(1);
    expect(observations(again.attempt.events)).toHaveLength(1);
  });

  it("GR13: a root admission resumed as a fragment refuses and performs nothing", function* () {
    const first = yield* scoped(function* () {
      yield* useTransport("fetched");
      return yield* evaluateRoot(
        request(WITH_EFFECT, { observations: [pinnedFetch([ADMITTED_REQUEST])] }),
      );
    });
    expect(rendered(first).hasOutput).toBe(true);

    const again = yield* scoped(function* () {
      const transport = yield* useTransport("fetched again");
      const attempt = yield* evaluateFragment(
        request(WITH_EFFECT, { observations: [pinnedFetch([ADMITTED_REQUEST])] }),
        { stream: duringPreparation(first.events) },
      );
      return { attempt, performed: transport.performed.length };
    });

    expect(again.attempt.failure).toContain("admitted under");
    expect(again.performed).toBe(0);
  });

  it("GR14: a fragment admission resumed as a root refuses and performs nothing", function* () {
    const first = yield* scoped(function* () {
      yield* useTransport("fetched");
      return yield* evaluateFragment(
        request(FRAGMENT_EFFECT, { observations: [pinnedFetch([ADMITTED_REQUEST])] }),
      );
    });
    expect(first.failure).toBe(undefined);

    const again = yield* scoped(function* () {
      const transport = yield* useTransport("fetched again");
      const attempt = yield* evaluateRoot(
        request(FRAGMENT_EFFECT, { observations: [pinnedFetch([ADMITTED_REQUEST])] }),
        { stream: duringPreparation(first.events) },
      );
      return { attempt, performed: transport.performed.length };
    });

    const error = failed(again.attempt);
    expect(error.message).toContain("admitted under");
    // A ceiling refusal is this run's history rather than the request's own
    // text, so there is no rendering to report and nothing ran.
    expect(error.partial).toBe(undefined);
    expect(again.performed).toBe(0);
  });

  it("GR15: a released fragment admission still resumes as the fragment it was", function* () {
    const first = yield* scoped(function* () {
      yield* useTransport("fetched");
      return yield* evaluateFragment(
        request(FRAGMENT_EFFECT, { observations: [pinnedFetch([ADMITTED_REQUEST])] }),
      );
    });
    expect(first.failure).toBe(undefined);

    const again = yield* scoped(function* () {
      const transport = yield* useTransport("fetched again");
      const attempt = yield* evaluateFragment(
        request(FRAGMENT_EFFECT, { observations: [pinnedFetch([ADMITTED_REQUEST])] }),
        { stream: duringPreparation(first.events) },
      );
      return { attempt, performed: transport.performed.length };
    });

    expect(again.attempt.failure).toBe(undefined);
    expect(again.performed).toBe(1);
  });
});

/** Core's own composition table, which every admission retains. */
const COMPOSITION_NAME = pinnedJson().name;

describe("Tier GR — the trusted composition table reaches a root too", () => {
  beforeAll(() => useTempFileCompiler());

  it("GR16: a root writes the composition table without the host naming it", function* () {
    // The host's read table admits the probe and says nothing about `<Json>`.
    const attempt = yield* evaluateRoot(request('<Output>\n<Json value="Ada" />\n</Output>\n'));

    expect(rendered(attempt).output).toContain('"Ada"');
    expect(COMPOSITION_NAME).toBe("Json");
  });

  it("GR17: a root reads a binding it bound itself", function* () {
    const attempt = yield* evaluateRoot(
      request('<Json value="Ada" as="who" />\n\n<Output>\nHello, {who}!\n</Output>\n'),
    );

    // A fragment may not read a binding through interpolation, because it
    // expands against the environment of the document that admitted it. A root
    // has an environment of its own, so the only thing it can reach by naming
    // is what it bound — and that is the whole of why this differs.
    // Quoted because `<Json>` binds the JSON value, which is what the same
    // source renders to in an ordinary document.
    expect(rendered(attempt).output).toContain('Hello, "Ada"!');
  });
});

/**
 * Tier GR — writing the entry draft from captured passive source.
 *
 * This is the one program the following CLI consumer is built around, and it is
 * the reason a root's interpolation rule cannot be the fragment's. A response
 * captures entry source with `<Let select="code">`, which renders its body and
 * selects the code node out of it, then hands that literal string to the
 * paired control that fills the shared draft.
 *
 * Everything load-bearing about it is a *literal*: the captured text is entry
 * source, not response syntax, so the entry's own braces and fences have to
 * arrive at the receiver exactly as the Agent wrote them, nothing inside the
 * fence may be executed, and the receiver must be handed that string once.
 */
describe("Tier GR — a root fills an entry draft with literal captured source", () => {
  beforeAll(() => useTempFileCompiler());

  /** The paired receiver, recording exactly what each invocation was handed. */
  function receiver(fills: string[]): GeneratedMutation {
    return pinnedMutation(
      "REPL.EntryInput",
      hostIdentity("test://sidekick", "EntryInput"),
      {
        kind: "function",
        name: "REPL.EntryInput",
        props: NO_PROPS,
        *fn(): Operation<Json> {
          fills.push(String(yield* content()));
          return "Entry input updated.";
        },
      },
      "paired",
    );
  }

  function fill(source: string): Operation<{ attempt: Attempt; fills: string[] }> {
    return scoped(function* () {
      const fills: string[] = [];
      const attempt = yield* evaluateRoot(
        request(source, { allow: ["read", "write"], mutations: [receiver(fills)] }),
      );
      return { attempt, fills };
    });
  }

  it("GR18: a literal body reaches the receiver exactly once", function* () {
    const { attempt, fills } = yield* fill("<REPL.EntryInput>Hello</REPL.EntryInput>\n");

    expect(answered(attempt).ok).toBe(true);
    expect(fills).toEqual(["Hello"]);
  });

  it("GR19: a captured passive fence fills the draft with its own text", function* () {
    const { attempt, fills } = yield* fill(
      '<Let as="code" select="code">\n```xmd\nHello\n```\n</Let>\n' +
        "<REPL.EntryInput>{code}</REPL.EntryInput>\n",
    );

    expect(answered(attempt).ok).toBe(true);
    expect(fills).toEqual(["Hello"]);
  });

  it("GR20: the entry's own braces survive the capture, and none of it runs", function* () {
    const entry = '<Each in={names} let="name">\nHello, {name}!\n</Each>';
    const { attempt, fills } = yield* fill(
      '<Let as="code" select="code">\n```xmd\n' +
        entry +
        "\n```\n</Let>\n<REPL.EntryInput>{code}</REPL.EntryInput>\n",
    );

    expect(answered(attempt).ok).toBe(true);
    // `names` and `name` belong to the entry this draft will run as. They are
    // not response bindings and do not need to be: a root resolves only what it
    // bound, so an entry-only reference arrives as the text it is. An `<Each>`
    // the response had actually expanded would have rendered its body instead
    // of handing the element over.
    expect(fills).toEqual([entry]);
  });

  /**
   * What the root's own environment is *for*.
   *
   * A root that resolved the admitting document's bindings would let a response
   * read one by naming it, and would let a captured draft carry one out — so
   * the rule that a root may interpolate at all depends on this being true.
   * Driven through a host component rather than a preparation, because a
   * preparation has no document bindings to be isolated from.
   */
  it("GR22: a root does not read the bindings of the document that evaluated it", function* () {
    const fills: string[] = [];
    let answer: Result<GeneratedXmdRootResult> | undefined;
    const execution = yield* executeInstalled(
      {
        ...retainedSource("repl/host.md", '<Let as="secret" value="LEAKED" />\n<SidekickHost />\n'),
        stream: new InMemoryStream(),
      },
      [
        {
          components: [
            {
              name: "SidekickHost",
              origin: "test://sidekick-host",
              props: NO_PROPS,
              factory: () =>
                function* (): Operation<Json> {
                  answer = yield* evaluateGeneratedXmdRoot(
                    request(
                      "<Output>[{secret}]</Output>\n" +
                        "<REPL.EntryInput>[{secret}]</REPL.EntryInput>\n",
                      { allow: ["read", "write"], mutations: [receiver(fills)] },
                    ),
                  );
                  return "";
                },
            },
          ],
        },
      ],
    );
    const result = yield* execution;

    expect(result.ok).toBe(true);
    expect(answer?.ok).toBe(true);
    // Literal in both places: what renders as chat, and what a draft would
    // carry into an entry.
    expect(answer?.ok === true && answer.value.output).toContain("[{secret}]");
    expect(fills).toEqual(["[{secret}]"]);
  });

  it("GR21: a nested passive fence survives the capture", function* () {
    // The outer fence has to be longer than the one it contains, which is the
    // ordinary Markdown rule and the one the accepted instructions state.
    const entry = "Run this:\n\n```sh\nxmd run greeting.md\n```";
    const { attempt, fills } = yield* fill(
      '<Let as="code" select="code">\n````xmd\n' +
        entry +
        "\n````\n</Let>\n<REPL.EntryInput>{code}</REPL.EntryInput>\n",
    );

    expect(answered(attempt).ok).toBe(true);
    expect(fills).toEqual([entry]);
  });
});
