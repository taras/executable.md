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
 * Three things are under test here.
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
import { Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { API } from "@executablemd/runtime";
import type { FetchInit, RuntimeFetchResponse } from "@executablemd/runtime";
import { durableRun, InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import { Component, content } from "../src/component-api.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import type { ElicitationRequest } from "../src/elicitation-api.ts";
import { pinnedJson } from "../src/generated-xmd.ts";
import { ComponentResult } from "../api.ts";
import { useSelection } from "./support/generated-selection.ts";
import { answerProvider } from "./support/answer-provider.ts";
import { SYNTAX_COMPONENT, SYNTAX_PROTECTED } from "../src/components/Syntax.ts";
import { installIdentities } from "../src/invocation-identity.ts";
import type { InvocationForm } from "../src/invocation-identity.ts";
import { Documentation } from "../src/documentation-api.ts";
import { Execution } from "../src/execute.ts";
import { retainedSource } from "../src/root-source.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { HELD_ROOT_PATH, withHeldHost } from "./support/held-host.ts";
// Imported from the module rather than the host surface: there is no public
// siteless evaluator, and these pinned factories are core-internal — the same
// import main's own generated-xmd tier uses.
import {
  bindGeneratedRootEvaluator,
  evaluateGeneratedXmd,
  pinnedComponent,
  pinnedFetch,
  pinnedMutation,
} from "../src/generated-xmd.ts";
import { executeInstalled } from "../host.ts";
import type { DurablePreparation, ExecutionInstallation, GeneratedXmdRootResult } from "../host.ts";
import type {
  GeneratedFragmentRequest,
  GeneratedMutation,
  GeneratedObservation,
  GeneratedXmdRequest,
} from "../src/generated-xmd.ts";
import type { FunctionComponent, FunctionComponentDefinition, Json } from "../src/types.ts";

const ROOT_PATH = "repl/sidekick.md";
const ROOT_SOURCE = "The host evaluated a generated root.\n";
const URL_ONE = "https://api.example.test/one";

/** One request the host admits, written the way an element writes it. */

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/**
 * One host definition, with the per-form metadata main's selection reads.
 *
 * Identity and effect are the declaration's own here rather than an argument a
 * host passes beside it, which is what the captured selection reads: the
 * definition that owns the implementation states what each spelling is offered
 * as. These helpers keep every assertion below exactly as it was; only where
 * the identity comes from changed.
 */
function definitionOf(
  name: string,
  identity: string,
  effect: "read" | "write",
  forms: readonly ("self-closing" | "paired")[],
  body: () => Operation<Json>,
): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    props: NO_PROPS,
    generated: Object.fromEntries(forms.map((form) => [form, { identity, effect }])),
    *fn(): Operation<Json> {
      return yield* body();
    },
  };
}

/** The one host observation these cases admit beside `<Fetch>`. */
function countedProbe(performed: string[]): GeneratedObservation {
  return pinnedComponent(
    "Probe",
    definitionOf(
      "Probe",
      "https://executable.md/components/probe",
      "read",
      ["self-closing"],
      // deno-lint-ignore require-yield
      function* (): Operation<Json> {
        performed.push("probed");
        return "probed";
      },
    ),
    "component-answer",
  );
}

/**
 * A component that fails the way a host control fails: on its own terms, after
 * whatever ran before it already ran.
 */
function failing(performed: string[]): GeneratedObservation {
  return pinnedComponent(
    "Boom",
    definitionOf(
      "Boom",
      "https://executable.md/components/boom",
      "read",
      ["self-closing"],
      // deno-lint-ignore require-yield
      function* (): Operation<Json> {
        performed.push("boomed");
        throw new Error("the control refused this request");
      },
    ),
    "component-answer",
  );
}

/** A paired-only entry, so writing it self-closing is a form refusal. */
function paired(): GeneratedMutation {
  return pinnedMutation(
    "Nest",
    definitionOf(
      "Nest",
      "https://executable.md/components/nest",
      "write",
      ["paired"],
      // deno-lint-ignore require-yield
      function* (): Operation<Json> {
        return "nested";
      },
    ),
    "paired",
    "component-answer",
  );
}

/** A self-closing-only entry, so giving it content is a content refusal. */
function selfClosing(): GeneratedMutation {
  return pinnedMutation(
    "Flat",
    definitionOf(
      "Flat",
      "https://executable.md/components/flat",
      "write",
      ["self-closing"],
      // deno-lint-ignore require-yield
      function* (): Operation<Json> {
        return "flat";
      },
    ),
    "self-closing",
    "component-answer",
  );
}

interface Ceilings {
  readonly observations?: readonly GeneratedObservation[];
  readonly mutations?: readonly GeneratedMutation[];
  readonly allow?: readonly ("read" | "write")[];
  /**
   * Further names this host selects without answering for them itself.
   *
   * For a *protected* component, which is the only kind a host selects and does
   * not supply: canonical resolution answers for it from core's own tier, and
   * the capture retains that exact implementation. A provider published beside
   * it would be a second definition for one name.
   */
  readonly protectedNames?: Readonly<Record<string, readonly InvocationForm[]>>;
}

/**
 * One root request, with the execution that admits it.
 *
 * A root is admitted from the selection its execution captured, so the tables
 * these cases state are *declared* here rather than passed with the call: the
 * host installs each component and offers its name and forms, exactly as a
 * trusted host does, and `captureEvaluationProfile` resolves them through the
 * ordinary import chain before any document code runs.
 *
 * A read table is always stated, because a selection that reaches an empty one
 * is the host's own mistake. The probe is the table a case that only cares
 * about structure gets.
 */
interface Candidate {
  readonly root: GeneratedXmdRequest;
  /**
   * The same source as a fragment request.
   *
   * The fragment surface still takes its tables with the call — that is main's
   * authored `<Evaluate>` handoff — so the rows that follow a root with a
   * fragment state the same selection both ways from one place.
   */
  readonly fragment: GeneratedFragmentRequest;
  readonly installation: ExecutionInstallation;
}

/** The two spellings a declaration can offer a generated use of. */
const FORMS: readonly InvocationForm[] = ["self-closing", "paired"];

/** Which spellings one pinned entry offers, as the selection states them. */
function formsOf(entry: GeneratedObservation | GeneratedMutation): readonly InvocationForm[] {
  const offered = entry.definition.generated ?? {};
  return FORMS.filter((form) => form in offered);
}

function request(source: string, ceilings: Ceilings = {}): Candidate {
  const stated = ceilings.observations ?? [];
  const observations = stated.length > 0 ? stated : [countedProbe([])];
  const mutations = ceilings.mutations ?? [];
  const entries = [...observations, ...mutations];
  const selection = {
    ...Object.fromEntries(entries.map((entry) => [entry.name, formsOf(entry)])),
    ...(ceilings.protectedNames ?? {}),
  };
  return {
    root: {
      id: "turn-1",
      source,
      ...(ceilings.allow === undefined ? {} : { allow: ceilings.allow }),
    },
    fragment: {
      id: "turn-1",
      source,
      observations,
      ...(mutations.length === 0 ? {} : { mutations }),
      ...(ceilings.allow === undefined ? {} : { allow: ceilings.allow }),
    },
    installation: {
      // Each selected name is answered by a provider holding the host's own
      // definition, which is how a selected name reaches an implementation on
      // this contract: the profile resolves it once, before the root import,
      // and seals what it retained.
      componentAnswers: entries.map((entry) => answerProvider(entry.name, entry.definition)),
      *install(): Operation<void> {
        // Canonical `<Syntax />` is not selected here by default: the root
        // evaluator already carries the exact implementation its execution
        // minted. A row that wants a protected name in the table states it as
        // `protectedNames`, with no provider of its own.
        yield* useSelection(selection);
      },
    },
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
 * Drive the fragment evaluator from a `DurablePreparation`.
 *
 * A harness choice, not the production path: `<Evaluate>` reaches the fragment
 * evaluator inside its own authored expansion. What a preparation gives these
 * cases is a durable root the fragment's own records belong to, which is the
 * only thing a continuation needs — and it is the document's own sequence,
 * which is where a fragment's records belong.
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

/**
 * Evaluate one root through the live execution that owns it.
 *
 * The production position, and the only one there is: the method belongs to a
 * `HostExecution`, so the case holds a document open and asks it. The body is
 * released afterwards, so each row also observes the main document completing
 * on its own terms rather than being halted mid-flight.
 */
function evaluateRoot(
  candidate: Candidate,
  options: {
    stream?: InMemoryStream;
    /** A document for the case whose subject is the document, not the root. */
    root?: { readonly path: string; readonly source: string };
  } = {},
): Operation<Attempt> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const captured: { answer?: Result<GeneratedXmdRootResult> } = {};
    const run = yield* withHeldHost(
      {
        stream,
        installations: [candidate.installation],
        ...(options.root === undefined ? {} : { root: options.root }),
      },
      function* (held) {
        captured.answer = yield* held.execution.evaluateGeneratedXmdRoot(candidate.root);
      },
    );
    const events = yield* stream.readAll();
    if (run.completion.ok) {
      return { ...(captured.answer === undefined ? {} : { answer: captured.answer }), events };
    }
    return { failure: run.completion.error.message, events };
  });
}

/** The same, through the fragment evaluator, so one context can follow another. */
function evaluateFragment(
  candidate: Candidate,
  options: { stream?: InMemoryStream } = {},
): Operation<{ output?: string; failure?: string; events: DurableEvent[] }> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const captured: { output?: string } = {};
    const installation = driven(function* () {
      captured.output = yield* evaluateGeneratedXmd(candidate.fragment);
    });
    const execution = yield* executeInstalled(
      { ...retainedSource(ROOT_PATH, ROOT_SOURCE), stream },
      [candidate.installation, installation],
    );
    const result = yield* execution;
    const events = yield* stream.readAll();
    if (result.ok) {
      return { output: captured.output ?? "", events };
    }
    return { failure: result.error.message, events };
  });
}

/**
 * The same fragment evaluation, from inside a held execution's own document.
 *
 * `<Evaluate>` reaches the fragment evaluator inside an authored expansion, and
 * a `DurablePreparation` reaches it *before* the root import — so the two leave
 * histories that begin differently. A row comparing a root's history with a
 * fragment's needs them to begin the same way, which is what this gives: the
 * fragment is evaluated from a component's body, where an authored one is.
 */
function evaluateFragmentInside(
  candidate: Candidate,
  options: { stream?: InMemoryStream } = {},
): Operation<{ output?: string; failure?: string; events: DurableEvent[] }> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const captured: { output?: string } = {};
    const run = yield* withHeldHost(
      {
        stream,
        installations: [candidate.installation],
        *inside(): Operation<void> {
          captured.output = yield* evaluateGeneratedXmd(candidate.fragment);
        },
      },
      // deno-lint-ignore require-yield
      function* (): Operation<void> {},
    );
    const events = yield* stream.readAll();
    if (run.completion.ok) {
      return { output: captured.output ?? "", events };
    }
    return { failure: run.completion.error.message, events };
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

/** The coroutines a history holds, which is what names each sequence. */
function sequences(events: DurableEvent[]): string[] {
  return [...new Set(events.map((event) => event.coroutineId))];
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
        observations: [pinnedFetch(), failing(performed)],
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
          observations: [pinnedFetch(), failing(performed), ...(ceilings.observations ?? [])],
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

describe("Tier GR — a root's history is its own, and a document's is the document's", () => {
  beforeAll(() => useTempFileCompiler());

  /** Source whose one effect is retained by its own durable record. */
  const WITH_EFFECT = `<Output>\n<Fetch url="${URL_ONE}" />\n</Output>\n`;
  const FRAGMENT_EFFECT = `<Fetch url="${URL_ONE}" />\n`;

  it("GR11: a root admission is marked as one, and a fragment keeps marker 4", function* () {
    const asRoot = yield* evaluateRoot(request("<Output>\nok\n</Output>\n"));
    expect(rendered(asRoot).hasOutput).toBe(true);
    // The marker carries the distinction, at the policy as well as the result.
    // Adapted from the earlier `context` member: the settled contract states
    // the kind with the marker instead, so a root is marker 5 throughout.
    expect(retainedPolicy(asRoot.events).version).toBe(5);
    expect(Object.hasOwn(retainedPolicy(asRoot.events), "context")).toBe(false);

    const asFragment = yield* evaluateFragment(request("ok\n"));
    expect(asFragment.failure).toBe(undefined);
    // The shape every fragment record before roots existed was written in,
    // unchanged: same marker, same members. A member added here — or a
    // different marker — would make this build's records unreadable to the one
    // that wrote them.
    expect(retainedPolicy(asFragment.events).version).toBe(4);
    expect(Object.hasOwn(retainedPolicy(asFragment.events), "context")).toBe(false);
  });

  /**
   * The amended contract, and the reason the three rows below changed shape.
   *
   * An explicit root evaluation owns a durable sequence of its own, allocated
   * past every evaluation the history already holds. So a reopened execution
   * never re-enters an interrupted evaluation: the suffix it left behind is a
   * fact about what happened, and the next call is new work on a new address.
   * Before the bound methods, a root was evaluated inline in the document's own
   * sequence and a reopening replayed its admission — these rows asserted that,
   * and the partition is what replaced it.
   */
  it("GR12: a reopening starts new work rather than continuing an interrupted evaluation", function* () {
    const first = yield* scoped(function* () {
      yield* useTransport("fetched");
      return yield* evaluateRoot(request(WITH_EFFECT, { observations: [pinnedFetch()] }));
    });
    expect(rendered(first).hasOutput).toBe(true);
    expect(observations(first.events)).toHaveLength(1);

    const again = yield* scoped(function* () {
      const transport = yield* useTransport("fetched again");
      const attempt = yield* evaluateRoot(request(WITH_EFFECT, { observations: [pinnedFetch()] }), {
        stream: duringPreparation(first.events),
      });
      return { attempt, performed: transport.performed.length };
    });

    // Admitted afresh and performed once: a new address rather than the retained
    // one, so the interrupted suffix is neither continued nor performed twice.
    expect(rendered(again.attempt).hasOutput).toBe(true);
    expect(again.performed).toBe(1);
    expect(observations(again.attempt.events)).toHaveLength(1);
    // Two evaluations, two sequences, and the second past the first.
    expect(sequences(again.attempt.events)).toContain("generated_root:1");
    expect(sequences(again.attempt.events)).toContain("generated_root:2");
    expect(admissions(again.attempt.events)).toHaveLength(2);
  });

  it("GR13: a root's retained evaluation is not history a fragment consumes", function* () {
    const first = yield* scoped(function* () {
      yield* useTransport("fetched");
      return yield* evaluateRoot(request(WITH_EFFECT, { observations: [pinnedFetch()] }));
    });
    expect(rendered(first).hasOutput).toBe(true);

    const again = yield* scoped(function* () {
      const transport = yield* useTransport("fetched again");
      const attempt = yield* evaluateFragmentInside(
        request(FRAGMENT_EFFECT, { observations: [pinnedFetch()] }),
        { stream: duringPreparation(first.events) },
      );
      return { attempt, performed: transport.performed.length };
    });

    // The document reads its own continuation, so the root's admission is not
    // an admission this fragment is standing behind — it admits its own and
    // performs its own effect once. The alternative is the thing the partition
    // exists to prevent: one sequence consuming another's record as its own.
    expect(again.attempt.failure).toBe(undefined);
    expect(again.performed).toBe(1);
  });

  it("GR14: one journal carries a fragment and a root under one request id", function* () {
    // Both sequences in one run, which is the arrangement the partition is for:
    // a document that evaluates a fragment while its host evaluates a root, and
    // the same request id in both. Neither consumes the other's admission, so
    // each performs its own effect once — the alternative is one sequence
    // reading the other's record and performing nothing.
    const stream = new InMemoryStream();
    const transport = yield* useTransport("fetched");
    const captured: {
      fragment?: string;
      answer?: Result<GeneratedXmdRootResult>;
    } = {};
    const ceilings = { observations: [pinnedFetch()] };
    const candidate = request(WITH_EFFECT, ceilings);
    const run = yield* withHeldHost(
      {
        stream,
        installations: [candidate.installation],
        *inside(): Operation<void> {
          captured.fragment = yield* evaluateGeneratedXmd(
            request(FRAGMENT_EFFECT, ceilings).fragment,
          );
        },
      },
      function* (held) {
        captured.answer = yield* held.execution.evaluateGeneratedXmdRoot(candidate.root);
      },
    );

    expect(run.completion.ok).toBe(true);
    expect(captured.fragment).not.toBe(undefined);
    expect(captured.answer?.ok).toBe(true);

    const events = yield* stream.readAll();
    // Two admissions, one in each sequence, and two observations performed.
    expect(admissions(events)).toHaveLength(2);
    expect(sequences(events)).toContain("generated_root:1");
    expect(observations(events)).toHaveLength(2);
    expect(transport.performed).toHaveLength(2);
  });

  it("GR15: a released fragment admission still resumes as the fragment it was", function* () {
    const first = yield* scoped(function* () {
      yield* useTransport("fetched");
      return yield* evaluateFragment(request(FRAGMENT_EFFECT, { observations: [pinnedFetch()] }));
    });
    expect(first.failure).toBe(undefined);

    const again = yield* scoped(function* () {
      const transport = yield* useTransport("fetched again");
      const attempt = yield* evaluateFragment(
        request(FRAGMENT_EFFECT, { observations: [pinnedFetch()] }),
        { stream: duringPreparation(first.events) },
      );
      return { attempt, performed: transport.performed.length };
    });

    expect(again.attempt.failure).toBe(undefined);
    expect(again.performed).toBe(1);
  });
});

/** The diagnostic a record whose rules this build does not have is refused with. */
const UNREADABLE_RECORD = "the retained generated-XMD admission record cannot be read as one.";

/**
 * One root admission in the shape the accepted pre-integration writer wrote.
 *
 * Hand-built to `01abab27`'s own `admitSource`/`policyRecord`: `version: 2` at
 * the result and in the policy, the `context: "root"` member that build used to
 * say which kind a record was, `requests` for the per-identity Fetch ceilings it
 * retained, and each identity as the four-member structural record — a kind, an
 * origin, a key and a revision. Nothing in it is this build's output, which is
 * the point: it is the older shape, offered to a build whose rules are the
 * marker's.
 */
function oldRootAdmission(): DurableEvent {
  const identity = {
    kind: "component-answer",
    origin: "test://provider",
    key: "Probe",
    revision: "1",
  };
  return {
    type: "yield",
    coroutineId: "shared",
    description: { type: "generated_xmd", name: "generated:turn-1" },
    result: {
      status: "ok",
      value: {
        version: 2,
        decision: "admitted",
        source: "<Probe />\n",
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
 * Tier GRM — what a record's marker authorizes, in both directions.
 *
 * IN1's requirement, and the one arrangement that can establish it. A fragment and a
 * root record hold the same ordered fields and differ by marker alone, so the
 * case that matters is the one where *nothing else* differs: the same id, the
 * same bytes, and byte-identical selected rows. A refusal there is the marker
 * check and can be nothing else.
 *
 * Which is why these rows drive the Core-private seam rather than the public
 * method. The public owner gives each evaluation a sequence of its own and
 * allocates past every retained one — that is E4/E6/GR12's subject, and it is
 * also what makes the two kinds' records unreachable from one another through
 * it. A record one kind wrote and the other reads has to be in the coroutine
 * the reading evaluation runs in, which is what `durableRun` decides here and
 * what canonical execution decides in production.
 *
 * {@link bindGeneratedRootEvaluator} is the handoff canonical execution makes,
 * so the admission, the record and the comparison below are the production
 * ones. What the fixture supplies is the selection and the route, from the
 * existing minted-identity fixture — and it states the *same* selection for
 * both kinds, which the real owner cannot do, because a root admitted through
 * it also carries the one protected answer a root may write.
 */
describe("Tier GRM — a record's marker is what authorizes the evaluation", () => {
  beforeAll(() => useTempFileCompiler());

  /** Legal in both kinds: a root with no Output renders its body, as a fragment does. */
  const COMMON = "<Probe />\n";
  /** One admission's name, offered to both kinds. */
  const ID = "turn-1";
  /** The coroutine both evaluations run in, so each reads the other's record. */
  const COROUTINE = "shared";

  /**
   * One root evaluator bound the way canonical execution binds it.
   *
   * The selection is stated rather than captured, so a row can offer a root
   * exactly the rows a fragment is offered. The route is the existing minted
   * identity fixture's, which is what a root narrows from; the reference is
   * absent because no row here writes `<Syntax />`.
   */
  function boundRoot(
    observations: readonly GeneratedObservation[],
  ): (request: GeneratedXmdRequest) => Operation<Result<GeneratedXmdRootResult>> {
    const identity = installIdentities([], [], [SYNTAX_PROTECTED]);
    identity.activate();
    return bindGeneratedRootEvaluator({
      select: () => ({ observations, mutations: [], describing: [] }),
      componentRouting: identity.componentRouting,
      reference: undefined,
      live: () => true,
      // No host destinations: this root's results are its own to render.
      destinations: undefined,
    });
  }

  /** Evaluate one root in `COROUTINE`, over this journal. */
  function asRoot(
    stream: InMemoryStream,
    performed: string[],
  ): Operation<Result<GeneratedXmdRootResult>> {
    return scoped(function* () {
      const held: { answer?: Result<GeneratedXmdRootResult> } = {};
      yield* durableRun(
        function* (): Operation<void> {
          held.answer = yield* boundRoot([countedProbe(performed)])({ id: ID, source: COMMON });
        },
        { stream, coroutineId: COROUTINE },
      );
      if (held.answer === undefined) {
        throw new Error("the durable run recorded no root outcome");
      }
      return held.answer;
    });
  }

  /** Evaluate the same source as a fragment in `COROUTINE`, over this journal. */
  function asFragment(stream: InMemoryStream, performed: string[]): Operation<Result<string>> {
    return scoped(function* () {
      const held: { output?: string } = {};
      try {
        yield* durableRun(
          function* (): Operation<void> {
            held.output = yield* evaluateGeneratedXmd({
              id: ID,
              source: COMMON,
              observations: [countedProbe(performed)],
            });
          },
          { stream, coroutineId: COROUTINE },
        );
      } catch (error) {
        return Err(error instanceof Error ? error : new Error(String(error)));
      }
      return Ok(held.output ?? "");
    });
  }

  /** The admission record this journal holds, and the rows it retained. */
  function record(events: readonly DurableEvent[]): { version: number; allowed: Json } {
    const [admission] = admissions([...events]);
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
    return { version: Number(value.version), allowed: policy.allowed ?? null };
  }

  it("GRM1: a fragment's record does not authorize a root, and the root performs nothing", function* () {
    // One real fragment admission, performed once.
    const first: string[] = [];
    const written = new InMemoryStream();
    const fragment = yield* asFragment(written, first);
    expect(fragment.ok).toBe(true);
    expect(first).toEqual(["probed"]);
    const retained = yield* written.readAll();
    expect(record(retained).version).toBe(4);

    // Offered to a root: the admission and nothing after it, the same id, the
    // same bytes, in the coroutine the root reads.
    const reused: string[] = [];
    const held = duringPreparation(retained);
    const answer = yield* asRoot(held, reused);

    // Refused as unreadable history — the marker check, named. Not a language
    // refusal, because this source is legal in both kinds; not a ceiling
    // refusal, because the rows are identical.
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.error.message).toBe(UNREADABLE_RECORD);
    // And before anything was performed.
    expect(reused).toEqual([]);
    // The record it refused is still the fragment's, unchanged.
    expect(record(yield* held.readAll()).version).toBe(4);
  });

  it("GRM2: a root's record does not authorize a fragment, and the fragment performs nothing", function* () {
    const first: string[] = [];
    const written = new InMemoryStream();
    const answer = yield* asRoot(written, first);
    expect(answer.ok).toBe(true);
    expect(first).toEqual(["probed"]);
    const retained = yield* written.readAll();
    expect(record(retained).version).toBe(5);

    const reused: string[] = [];
    const held = duringPreparation(retained);
    const fragment = yield* asFragment(held, reused);

    expect(fragment.ok).toBe(false);
    expect(fragment.ok === false && fragment.error.message).toBe(UNREADABLE_RECORD);
    expect(reused).toEqual([]);
    expect(record(yield* held.readAll()).version).toBe(5);
  });

  it("GRM3: the two records differ by marker alone", function* () {
    // What makes GRM1 and GRM2 about the marker: the same source and the same
    // selection produce records whose retained rows are byte-identical and
    // whose markers are the two this build writes. A row that differed would
    // have given either direction a second reason to refuse.
    const asFragmentStream = new InMemoryStream();
    expect((yield* asFragment(asFragmentStream, [])).ok).toBe(true);
    const asRootStream = new InMemoryStream();
    expect((yield* asRoot(asRootStream, [])).ok).toBe(true);

    const fragment = record(yield* asFragmentStream.readAll());
    const root = record(yield* asRootStream.readAll());
    expect(fragment.version).toBe(4);
    expect(root.version).toBe(5);
    expect(JSON.stringify(root.allowed)).toBe(JSON.stringify(fragment.allowed));
  });

  it("GRM4: a matched marker resumes, and performs the admitted work again", function* () {
    // The control for both directions, measured on both sides: the same
    // fixture, the same histories, read by the kind that wrote them. A
    // refusal here would mean GRM1 and GRM2 were refusing the arrangement
    // rather than the marker.
    const rootWritten = new InMemoryStream();
    expect((yield* asRoot(rootWritten, [])).ok).toBe(true);
    const rootAgain: string[] = [];
    const resumedRoot = yield* asRoot(duringPreparation(yield* rootWritten.readAll()), rootAgain);
    expect(resumedRoot.ok).toBe(true);
    expect(rootAgain).toEqual(["probed"]);

    const fragmentWritten = new InMemoryStream();
    expect((yield* asFragment(fragmentWritten, [])).ok).toBe(true);
    const fragmentAgain: string[] = [];
    const resumedFragment = yield* asFragment(
      duringPreparation(yield* fragmentWritten.readAll()),
      fragmentAgain,
    );
    expect(resumedFragment.ok).toBe(true);
    expect(fragmentAgain).toEqual(["probed"]);
  });

  it("GRM5: an older build's root record authorizes neither kind", function* () {
    // IN4's refusal arm. The marker-2 root record is the shape the accepted
    // pre-integration writer wrote (`01abab27`): tagged `version: 2` at the
    // result and in its policy, carrying the `context: "root"` member this
    // build replaced with the marker, and identities as the four-member
    // structural records that build retained. A build that read it in part, or
    // migrated it, would be resuming a grant whose rules it does not have.
    const asRootPerformed: string[] = [];
    const forRoot = new InMemoryStream([oldRootAdmission()]);
    const root = yield* asRoot(forRoot, asRootPerformed);
    expect(root.ok).toBe(false);
    expect(root.ok === false && root.error.message).toBe(UNREADABLE_RECORD);
    expect(asRootPerformed).toEqual([]);

    const asFragmentPerformed: string[] = [];
    const forFragment = new InMemoryStream([oldRootAdmission()]);
    const fragment = yield* asFragment(forFragment, asFragmentPerformed);
    expect(fragment.ok).toBe(false);
    expect(fragment.ok === false && fragment.error.message).toBe(UNREADABLE_RECORD);
    expect(asFragmentPerformed).toEqual([]);
  });

  it("GRM6: one name under two definitions is still a collision", function* () {
    // The guard the Syntax correction had to preserve. Recognizing a captured
    // canonical row is not accepting any row that shares its name: two
    // definitions under one name is a malformed table, refused before
    // anything is admitted.
    const performed: string[] = [];
    const held: { answer?: Result<GeneratedXmdRootResult> } = {};
    yield* durableRun(
      function* (): Operation<void> {
        held.answer = yield* boundRoot([
          countedProbe(performed),
          // A second, different implementation under the same name.
          countedProbe([]),
        ])({ id: ID, source: COMMON });
      },
      { stream: new InMemoryStream(), coroutineId: COROUTINE },
    );

    expect(held.answer?.ok).toBe(false);
    expect(held.answer?.ok === false && held.answer.error.message).toContain(
      "one name with two definitions",
    );
    expect(performed).toEqual([]);
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

  it("GR17: a root renders a local binding as YAML", function* () {
    // The whole composition table, not one entry of it: the host's read table
    // names neither renderer, and a root reaches both for the same reason.
    const attempt = yield* evaluateRoot(
      request(
        '<Json value={{ names: ["Ada", "Grace"] }} as="held" />\n\n' +
          "<Output>\n<Yaml value={held} />\n</Output>\n",
      ),
    );

    const output = rendered(attempt).output;
    // `<Json as>` binds the text it rendered, so what `<Yaml>` was handed is a
    // JSON string — and a string spanning lines is a YAML block scalar. The
    // indented body is that exact JSON text, unchanged: the renderer described
    // the value it was given rather than reinterpreting it as data.
    expect(output.trimStart().startsWith("|-")).toBe(true);
    const body = output
      .slice(output.indexOf("|-") + 2)
      .split("\n")
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n");
    expect(JSON.parse(body.trim())).toEqual({ names: ["Ada", "Grace"] });
  });
});

/**
 * Tier GR — what an owned destination may be handed (R2, R4).
 *
 * A host that owns a destination relaxes one decision: an invocation that
 * captures nothing is still allowed, because the result has somewhere to go.
 * It does not relax the producer's own contract, and these rows are that
 * difference. The invalid one is written the way the defect was found — a
 * constant expression, which turns anything into a valid-looking answer — so a
 * route that queried before it validated delivers `42` here.
 */
describe("Tier GR — an owned destination, and the contract it does not relax", () => {
  beforeAll(() => useTempFileCompiler());

  /** The host's own definition, and what its body returns. */
  function owned(body: () => unknown): FunctionComponentDefinition {
    return {
      kind: "function",
      name: "Owned",
      props: { type: "object", properties: {}, additionalProperties: false },
      forms: ["self-closing"],
      returns: {
        type: "object",
        properties: { valid: { type: "boolean" } },
        required: ["valid"],
        additionalProperties: false,
      },
      generated: {
        "self-closing": { identity: "https://executable.md/components/owned", effect: "read" },
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        return body();
      },
    };
  }

  /**
   * One root request whose host owns `Owned`'s result.
   *
   * The destination names the exact published definition, which is what
   * canonical capture authenticates it against.
   */
  function owning(
    source: string,
    definition: FunctionComponentDefinition,
    delivered: unknown[],
    extra?: ExecutionInstallation,
    order?: string[],
  ): Candidate {
    const candidate = request(source, {
      observations: [{ name: "Owned", definition }],
      allow: ["read"],
    });
    return {
      ...candidate,
      installation: {
        ...candidate.installation,
        resultDestinations: {
          destinations: [
            {
              definition,
              open: () => ({
                *accept(selected: unknown): Operation<void> {
                  order?.push("delivered");
                  delivered.push(selected);
                },
              }),
            },
          ],
        },
        *install(): Operation<void> {
          const base = candidate.installation.install;
          if (base !== undefined) {
            yield* base();
          }
          const added = extra?.install;
          if (added !== undefined) {
            yield* added();
          }
        },
      },
    };
  }

  it("GR18: an uncaptured owned return its own schema rejects is never delivered", function* () {
    const delivered: unknown[] = [];
    const definition = owned(() => ({ invalid: true }));
    const attempt = yield* evaluateRoot(
      owning(`<Output>\n<Owned yq='42' />\n</Output>\n`, definition, delivered),
    );

    // The producer's own contract decided this, before any expression was
    // asked: a constant query cannot rescue a return its schema rejected, so
    // the root fails and the destination is handed nothing at all.
    const answer = attempt.answer;
    expect(answer?.ok).toBe(false);
    expect(answer !== undefined && !answer.ok && answer.error.message).toContain("Owned");
    expect(delivered).toEqual([]);
  });

  it("GR18: an uncaptured owned return its schema accepts is delivered, selected", function* () {
    const delivered: unknown[] = [];
    const definition = owned(() => ({ valid: true }));
    const attempt = yield* evaluateRoot(
      owning(`<Output>\n<Owned yq='.valid' />\n</Output>\n`, definition, delivered),
    );

    // The positive control: same destination, same uncaptured form, a real
    // expression — an accepted return reaches the destination as what that
    // expression selected. Nothing is rendered, because an uncaptured result
    // that is not a string never was.
    expect(rendered(attempt).output.trim()).toBe("");
    expect(delivered).toEqual([true]);
  });

  it("GR18: a consumer's own middleware sees the accepted result before delivery", function* () {
    // R4's consumer boundary, reached through the published entrypoint rather
    // than core's private module: `ComponentResult` is what a host installs on,
    // and what it is handed is the value the producer's contract accepted.
    // One log for both, so what is read is the order rather than two counts.
    const order: string[] = [];
    const seen: { value: unknown; query: string | undefined }[] = [];
    const delivered: unknown[] = [];
    const definition = owned(() => ({ valid: true }));
    const attempt = yield* evaluateRoot(
      owning(
        `<Output>\n<Owned yq='.valid' />\n</Output>\n`,
        definition,
        delivered,
        {
          *install(): Operation<void> {
            yield* ComponentResult.around({
              *result([requested], next) {
                if (requested.component === "Owned") {
                  order.push("middleware");
                  seen.push({ value: requested.value, query: requested.query });
                }
                return yield* next(requested);
              },
            });
          },
        },
        order,
      ),
    );

    expect(rendered(attempt).output.trim()).toBe("");
    // The accepted original and the query the invocation wrote — the value the
    // producer's contract accepted, not the selected one.
    expect(seen).toEqual([{ value: { valid: true }, query: ".valid" }]);
    expect(delivered).toEqual([true]);
    // And it was observed before anything was delivered, which is the whole
    // point of the seam sitting between acceptance and everything after it.
    expect(order).toEqual(["middleware", "delivered"]);
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
      definitionOf(
        "REPL.EntryInput",
        "https://executable.md/components/repl/entry-input",
        "write",
        ["paired"],
        function* (): Operation<Json> {
          fills.push(String(yield* content()));
          return "Entry input updated.";
        },
      ),
      "paired",
      "component-answer",
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
    // A document that bound something before it held itself open, so there is a
    // live binding of that name in the execution the root is evaluated by.
    const attempt = yield* evaluateRoot(
      request("<Output>[{secret}]</Output>\n<REPL.EntryInput>[{secret}]</REPL.EntryInput>\n", {
        allow: ["read", "write"],
        mutations: [receiver(fills)],
      }),
      {
        root: {
          path: "repl/host.md",
          source: '<Let as="secret" value="LEAKED" />\n<Held />\n',
        },
      },
    );

    expect(answered(attempt).ok).toBe(true);
    // Literal in both places: what renders as chat, and what a draft would
    // carry into an entry.
    expect(rendered(attempt).output).toContain("[{secret}]");
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

/**
 * Tier GR — canonical `<Syntax />` inside a generated root.
 *
 * A reply has to be able to ask what it may write, and the answer has to be
 * core's: a description of a run's vocabulary that anything in the run could
 * answer for is a description of nothing. So the root evaluator installs the
 * canonical declaration for the life of one evaluation and admits it as a read,
 * and the reference it answers from is built from the table that was actually
 * admitted.
 *
 * Driven through the public host operation with no protected caller, because
 * that is the position a trusted host is in: the CLI's conversation owner calls
 * this operation directly and has no site of its own to lend.
 */
describe("Tier GR — a root describes its own vocabulary", () => {
  beforeAll(() => useTempFileCompiler());

  it("GR23: <Syntax /> lists the names this root actually admits", function* () {
    const attempt = yield* evaluateRoot(
      request("<Output>\n<Syntax />\n</Output>\n", {
        allow: ["read", "write"],
        observations: [countedProbe([])],
        mutations: [paired()],
      }),
    );

    const output = rendered(attempt).output;
    // The read table, the write table and the always-on composition entry —
    // the vocabulary of this root, not of the document that evaluated it.
    expect(output).toContain("Probe");
    expect(output).toContain("Nest");
    expect(output).toContain("Json");
    // And itself, because it is admitted here too.
    expect(output).toContain("Syntax");
    // Nothing the host did not admit. `Evaluate` is the other protected name,
    // and admitting one does not admit the other.
    expect(output).not.toContain("Evaluate");
  });

  it("GR24: a named lookup renders the component's long-form documentation", function* () {
    const attempt = yield* evaluateRoot(
      request('<Output>\n<Syntax names={["Json"]} />\n</Output>\n'),
    );

    const output = rendered(attempt).output;
    expect(output).toContain("Json");
    // The documentation, not merely the name. A reference built with symbols
    // and no index can name every admitted component and explain none, and
    // what it renders then is the *absence* notice — which reads as "this
    // component is undocumented" rather than as a reference that was not
    // assembled. Asserting the name alone could not tell those apart, which is
    // how the first version of this row passed while the lookup was broken.
    expect(output).not.toContain("No long-form documentation is available");
    expect(output.length).toBeGreaterThan(200);
  });

  it("GR24b: a named lookup documents the protected component itself", function* () {
    // Canonical Syntax is admitted here, so it is also a component a reply may
    // read about — through the same index, from its owning package.
    const attempt = yield* evaluateRoot(
      request('<Output>\n<Syntax names={["Syntax"]} />\n</Output>\n'),
    );

    const output = rendered(attempt).output;
    expect(output).toContain("Syntax");
    expect(output).not.toContain("No long-form documentation is available");
  });

  it("GR25: ordinary `as` capture keeps the text out of the rendering", function* () {
    const attempt = yield* evaluateRoot(
      request('<Syntax as="vocabulary" />\n\n<Output>\nheld: {vocabulary}\n</Output>\n'),
    );

    const output = rendered(attempt).output;
    // Captured rather than emitted, and then read back by the root — which is
    // canonical Syntax's ordinary behaviour, unchanged by being in a root.
    expect(output).toContain("held: ");
    expect(output).toContain("Probe");
  });

  it("GR26: a root admitted for write alone reaches no <Syntax />", function* () {
    const performed: string[] = [];
    const attempt = yield* evaluateRoot(
      request("<Output>\n<Syntax />\n</Output>\n", {
        allow: ["write"],
        mutations: [paired()],
      }),
    );

    // Describing the vocabulary is an observation, so it is in the read
    // selection and nowhere else — refused at admission, before anything runs.
    expect(failed(attempt).message).toContain("did not admit");
    expect(performed).toEqual([]);
    expect(observations(attempt.events)).toHaveLength(0);
  });

  it("GR27: the root's retained policy holds its Syntax entry", function* () {
    const attempt = yield* evaluateRoot(request("<Output>\nok\n</Output>\n"));
    const policy = retainedPolicy(attempt.events);

    // In the policy, because it is in the table: a continuation whose
    // vocabulary no longer holds it is a different ceiling, and the comparison
    // is what notices.
    expect(JSON.stringify(policy)).toContain("Syntax");
  });

  it("GR28: a fragment's table and policy are untouched", function* () {
    const attempt = yield* evaluateFragment(request("ok\n"));

    // The released contract: a fragment's reference and routing come from the
    // protected site canonical `<Evaluate>` already has, so nothing was added
    // to what a fragment admits or retains.
    expect(attempt.failure).toBe(undefined);
    expect(JSON.stringify(retainedPolicy(attempt.events))).not.toContain("Syntax");
  });

  it("GR28b: document-time middleware cannot replace what a root is told", function* () {
    // Installed in an `Execution.document` wrapper, which is the scope the
    // evaluation runner is attached inside — so this replacement is in the
    // runner's own inherited chain. A replacement installed only in a sibling
    // caller scope would prove nothing: it could not reach a recollection
    // either, so the row would pass whether the reference was captured or
    // rebuilt. Positioned after canonical capture and before the document
    // workflow, so it is exactly the late middleware the capture must outrank.
    yield* Execution.around({
      *document([claimed], next) {
        yield* Documentation.around({
          *contributions([read], nextChapter) {
            const held = yield* nextChapter(read);
            // The sentence a lookup actually renders, replaced in place.
            // Prepending to the chapter would not do: the index renders the
            // looked-up component's own section, so a header nobody reads is a
            // mutation that cannot fail the row — which is how the first
            // version of this regression passed while the hole was open.
            return held.map((one) =>
              one.source.owner === "@executablemd/core"
                ? {
                    ...one,
                    source: {
                      ...one.source,
                      text: one.source.text.replace(
                        "Inspects the components and control-flow constructs",
                        "REPLACED BY A RUNNING COMPONENT",
                      ),
                    },
                  }
                : one,
            );
          },
        });
        yield* next(claimed);
      },
    });

    const attempt = yield* evaluateRoot(
      request('<Output>\n<Syntax names={["Syntax"]} />\n</Output>\n'),
    );
    const output = rendered(attempt).output;

    // What a reply is told about core's components is core's to say. A root
    // presenting a document's replacement under the protected origin would be
    // the product lying about itself.
    expect(output).not.toContain("REPLACED BY A RUNNING COMPONENT");
    // And the real sentence is there, so the row is asserting that core's own
    // text survived rather than that nothing rendered at all.
    expect(output).toContain("Inspects the components and control-flow constructs");
  });

  it("GR29: a narrowed route closes without ending the execution's own", function* () {
    // The lifetime claim, at the seam that now carries it. A root narrows the
    // execution's guarded route to the implementations it admitted and closes
    // that narrowing when its work has joined; the execution's own route stays
    // live, because the next root narrows from it again.
    const identity = installIdentities([], [], [SYNTAX_PROTECTED]);
    identity.activate();
    const syntax = identity.protected.get(SYNTAX_COMPONENT);
    if (syntax === undefined) {
      throw new Error("this execution minted no canonical Syntax");
    }

    const narrowed = identity.componentRouting.narrow([syntax.fn]);
    expect(narrowed.body(syntax.fn)).not.toBe(undefined);

    narrowed.close();

    // The narrowing answers for nothing, and the execution's route still does.
    expect(narrowed.body(syntax.fn)).toBe(undefined);
    expect(identity.componentRouting.body(syntax.fn)).not.toBe(undefined);
    expect(identity.componentRouting.narrow([syntax.fn]).body(syntax.fn)).not.toBe(undefined);

    identity.identities.revoke();

    // And once the execution is gone, so is the route it minted the body in.
    expect(identity.componentRouting.body(syntax.fn)).toBe(undefined);
  });
});

/**
 * Tier GR — the canonical question, admitted into a generated root.
 *
 * A reply that is about to write something a person has to agree to needs one
 * thing a ceiling cannot give it by withholding: a way to ask. A host selects
 * `Elicit` the way it selects any other name, and because `<Elicit>` is
 * protected, what the capture retains is core's own definition — so the
 * question a generated root asks is the same question an authored document
 * asks: same schema preparation, same durable question identity, same
 * validation of the answer. The answer arrives through ordinary `as` capture
 * rather than through anything this boundary invents.
 *
 * What the rows below are about is that it is *core's* `<Elicit>`. The name is
 * ordinary: a repository component, a nested registration or a middleware
 * replacement can take it, and a question answered by whoever last took the
 * name would be a question nobody admitted. The captured entry carries the
 * definition canonical resolution answered with before the root import, and
 * the invocation reaches the installed Elicitation provider through it.
 *
 * It is admitted paired and in the write class. The question is the content, so
 * a self-closing spelling is a request with nothing in it — refused in
 * preflight, before an earlier element has run and before anyone is asked — and
 * `allow={["read"]}` admits source that may look at things without anyone being
 * interrupted, which is a promise source that can ask would break.
 */
describe("Tier GR — a root asks the canonical question", () => {
  beforeAll(() => useTempFileCompiler());

  /** The answer shape these rows ask for, written the way a reply writes one. */
  const DECISION = {
    type: "object",
    properties: { decision: { type: "string", enum: ["approve", "reject"] } },
    required: ["decision"],
    additionalProperties: false,
  } as const;

  /**
   * One question element, with its schema as the declarative data a generated
   * root may write.
   *
   * An object literal and nothing else: §5.3.3 admits JSON literals, arrays,
   * objects and the source's own bindings, so a schema a reply states is a
   * value it wrote rather than one it computed.
   */
  function asking(body: string): string {
    return `<Elicit schema={${JSON.stringify(DECISION)}} as="answer">${body}</Elicit>`;
  }

  /**
   * Install an Elicitation provider on the *calling* scope, and hand back what
   * it was asked.
   *
   * Not a resource: middleware installs on the scope that runs the install, and
   * the held execution these rows evaluate in is a child of this one. `at:
   * "min"` is the position a provider must install at — the default lets an
   * outer install shadow it, which is the opposite of what a provider is.
   */
  function* installProvider(
    answer: (request: ElicitationRequest, index: number) => Operation<unknown>,
  ): Operation<ElicitationRequest[]> {
    const asked: ElicitationRequest[] = [];
    yield* Elicitation.around(
      {
        *elicit([request]) {
          asked.push(request);
          return yield* answer(request, asked.length - 1);
        },
      },
      { at: "min" },
    );
    return asked;
  }

  /** What one asking root produced, and everything it touched on the way. */
  interface Asked {
    readonly attempt: Attempt;
    /** Every question the provider was given, in order. */
    readonly asked: readonly ElicitationRequest[];
    /** Every counted observation that ran, so a refusal can be shown to cost none. */
    readonly performed: readonly string[];
    /** Every name the document's own import chain was asked to answer. */
    readonly imported: readonly string[];
  }

  /**
   * Evaluate one root that admits the canonical question.
   *
   * `replace` installs a same-name component in the *document's* chain, which
   * is the scope the evaluation runner is attached inside — the same position
   * GR28b uses, and the only one where a replacement could reach the root at
   * all. A replacement in a sibling caller scope would prove nothing.
   */
  function ask(
    source: string,
    answer: (request: ElicitationRequest, index: number) => Operation<unknown>,
    options: { readonly replace?: boolean } = {},
  ): Operation<Asked> {
    return scoped(function* () {
      const asked = yield* installProvider(answer);
      const performed: string[] = [];
      const imported: string[] = [];
      if (options.replace === true) {
        /** A second definition under core's name, answering something else. */
        const substitute: FunctionComponentDefinition = {
          kind: "function",
          name: "Elicit",
          props: { type: "object", properties: { schema: {} }, additionalProperties: true },
          // deno-lint-ignore require-yield
          *fn(): Operation<Json> {
            return { decision: "approve", by: "the replacement" };
          },
        };
        yield* Execution.around({
          *document([claimed], next) {
            yield* Component.around(
              {
                *importComponent([name], nextImport) {
                  imported.push(name);
                  if (name === "Elicit") {
                    return substitute;
                  }
                  return yield* nextImport(name);
                },
              },
              { at: "min" },
            );
            yield* next(claimed);
          },
        });
      }
      const attempt = yield* evaluateRoot(
        request(source, {
          observations: [countedProbe(performed)],
          // Selected by name, with no provider beside it. `<Elicit>` is
          // protected, so canonical resolution answers for it from core's own
          // tier and the capture retains that exact definition — which is what
          // makes the question the one an authored document asks. Its
          // declaration offers only the paired spelling, and offers it as a
          // write, so the form and the class are the owner's statement rather
          // than this row's.
          protectedNames: { Elicit: ["paired"] },
          allow: ["read", "write"],
        }),
      );
      return { attempt, asked, performed, imported };
    });
  }

  it("GR30: a paired question asks the installed provider once and binds its answer", function* () {
    const outcome = yield* ask(
      `${asking("Approve the plan?")}\n\n<Output>\n<Json value={answer} />\n</Output>\n`,
      // deno-lint-ignore require-yield
      function* () {
        return { decision: "approve" };
      },
    );

    // Asked once, with the two things a question is: the rendered content as
    // the message, and the normalized schema the answer must satisfy.
    expect(outcome.asked).toHaveLength(1);
    expect(outcome.asked[0].message).toContain("Approve the plan?");
    expect(outcome.asked[0].schema).toEqual(DECISION);

    // And the validated structured value arrived under `as`, through ordinary
    // capture — `<Json>` renders the value it was handed, so what the root
    // rendered is the answer the provider gave rather than text the element
    // wrote. Parsed, so the row is about the value and not about how the
    // rendering spaced it.
    expect(JSON.parse(rendered(outcome.attempt).output)).toEqual({ decision: "approve" });
  });

  it("GR30b: an answer the schema rejects fails the root, and keeps what it rendered", function* () {
    const outcome = yield* ask(
      `<Output>\nasking\n</Output>\n\n${asking("Approve the plan?")}\n`,
      // deno-lint-ignore require-yield
      function* () {
        return { decision: "maybe" };
      },
    );

    // Validation is the canonical component's, unchanged: the provider was
    // reached, and what it answered is held to the schema the source stated.
    expect(outcome.asked).toHaveLength(1);
    const failure = failed(outcome.attempt);
    expect(failure.partial?.hasOutput).toBe(true);
    expect(failure.partial?.output).toContain("asking");
  });

  it("GR31: a self-closing question is refused before anything runs or anyone is asked", function* () {
    const outcome = yield* ask(
      `<Probe />\n\n<Elicit schema={${JSON.stringify(DECISION)}} />\n`,
      // deno-lint-ignore require-yield
      function* () {
        return { decision: "approve" };
      },
    );

    // The form is decided in preflight, so the counted element that was
    // written first has not run and nobody has been interrupted.
    expect(failed(outcome.attempt).message).toContain("paired form");
    expect(outcome.performed).toEqual([]);
    expect(outcome.asked).toEqual([]);
  });

  it("GR32: a same-name replacement cannot answer the admitted question", function* () {
    const outcome = yield* ask(
      `${asking("Approve the plan?")}\n\n<Output>\n<Json value={answer} />\n</Output>\n`,
      // deno-lint-ignore require-yield
      function* () {
        return { decision: "reject" };
      },
      { replace: true },
    );

    // The chain is live and is asked — the document's own holding component
    // resolves through it — so the name the root admitted being absent from
    // that list is a fact about the admission rather than about the wrapper.
    expect(outcome.imported).toContain("Held");
    // The admitted entry carries the registry's own definition, so the root
    // never asks the document's chain for this name at all — and the question
    // reached the installed provider rather than the substitute's return.
    expect(outcome.imported).not.toContain("Elicit");
    expect(outcome.asked).toHaveLength(1);
    // Exactly the provider's answer: the substitute returns a different
    // decision and a field of its own, so neither could survive this.
    expect(JSON.parse(rendered(outcome.attempt).output)).toEqual({ decision: "reject" });
  });
});
