/**
 * Tier R3 — the words a reply may use, through the real evaluator (#883, J2/J3/J6).
 *
 * Every row here evaluates generated source as a root through the real method
 * on a live `HostExecution`, under the ceiling `sidekick/profile.ts` builds.
 * Nothing is simulated: if a control is admitted, it is admitted because Core
 * resolved its pinned identity and its authored form, and if one is refused it
 * is Core's refusal.
 *
 * The execution is **held open** while the reply is evaluated, which is the
 * production shape and the only one there is: the method belongs to a live
 * execution, because what it reaches — this execution's captured package
 * documentation, the guarded route its canonical `<Syntax />` is entered
 * through, the services its own document installed — exists nowhere else. The
 * earlier harness called a module-level evaluator from inside a host
 * component's invocation, which borrowed that component's durable sequence; a
 * reply's work now owns a sequence of its own.
 *
 * What these rows are about is the seam between a reply and the root. A control
 * performs no REPL work of its own — it turns an element into a semantic
 * request and renders the answer — so what can be proved here is that the
 * request is made exactly once, with exactly what the element said, recorded
 * before it runs and settled after, and that a refusal is this operation's
 * outcome rather than the end of the response.
 *
 * The rest of R3 needs the root itself: holding a preflight and editing the
 * draft underneath it, Stop revoking a pending admission, a History selection
 * refusing a Submit, and an admitted entry's own completion. Those arrive with
 * the shared admission gate, and this file grows into them. They are not
 * covered here.
 */

import { CORE_REGISTRY } from "../../core/src/components/registry.ts";
import { isJsonObject } from "../../core/src/json.ts";
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readFile } from "node:fs/promises";
import { Err, Ok, scoped, spawn, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { Component, Execution, retainedSource, useTempFileCompiler } from "@executablemd/core";
import type { FunctionComponentDefinition } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation, GeneratedXmdRootResult } from "@executablemd/core/host";

import { cwd, platform } from "@executablemd/runtime";

import { GUIDE_CHAPTERS } from "../src/repl/sidekick/controls.ts";
import { openReplSession } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import { rootReads, sidekickRequests } from "../src/repl/sidekick/requests.ts";
import type { RootReading } from "../src/repl/sidekick/requests.ts";
import { ReplHost } from "../src/repl/host.ts";
import type { ReplHostFact } from "../src/repl/host.ts";
import { assembleReplProfile, entryVocabulary } from "../src/repl-profile.ts";
import { installPlugins, NO_PLUGINS } from "../src/plugin-host.ts";
import { ADAPTERS, AGENT } from "./support/plan-harness.ts";
import { entryInitialBindings } from "../src/repl/model.ts";
import type {
  ControlJournal,
  ControlOccurrence,
  GuideChapter,
  SidekickRequests,
  SubmitReceipt,
} from "../src/repl/sidekick/controls.ts";
import {
  sidekickCeilingInstallation,
  describeSurface,
  responseSurface,
  sidekickResponseCeiling,
} from "../src/repl/sidekick/profile.ts";
import type { ResponseCeiling } from "../src/repl/sidekick/profile.ts";
import type { OutputRead, OutputReadRequest } from "../src/repl/sidekick/output.ts";
import {
  fillable,
  initialRevisions,
  reserve,
  resolved,
  submittable,
} from "../src/repl/sidekick/gate.ts";
import {
  describeGuideIndex,
  readGuideChapter,
  readSidekickBootstrap,
  sidekickAssetUrl,
  sidekickGuideIndex,
} from "../src/repl/sidekick/guide.ts";
import type { EntryHistory, Reserved } from "../src/repl/sidekick/gate.ts";
import {
  admitted,
  filled,
  initialState,
  instructed,
  NO_AGENT,
  reduceRepl,
} from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type { ReplLive } from "../src/repl/application.ts";
import type { ReplModel } from "../src/repl/model.ts";

/** A history with nothing in it, which is what a fresh execution reduces over. */
const EMPTY: ReplModel = Object.freeze({
  head: true,
  entries: Object.freeze([]),
  settled: false,
  terminal: undefined,
  checkpoints: Object.freeze([]),
  transcript: Object.freeze([]),
  turns: Object.freeze([]),
  sessions: Object.freeze([]),
  selection: undefined,
});

/** A quiet execution: nothing running, nothing waiting, nothing to read. */
const QUIET: ReplLive = Object.freeze({
  output: "",
  question: undefined,
  expansion: "playing",
  pausable: false,
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
});

/** What the root was asked for, in order, and what it answered. */
interface Asked {
  /** Every semantic request, in the order the response made them. */
  readonly requests: string[];
  /** Every control intent recorded, in order. */
  readonly began: ControlOccurrence[];
  /** Every outcome recorded, by the order it settled. */
  readonly settled: { order: number; ok: boolean; observed?: Json }[];
  /** Whatever the draft now holds. */
  draft: string | undefined;
}

interface StubOptions {
  /** Refuse this request, as an unavailable root does. */
  readonly refuse?: string;
  readonly receipt?: SubmitReceipt;
  readonly read?: OutputRead;
}

function fresh(): Asked {
  return { requests: [], began: [], settled: [], draft: undefined };
}

/**
 * A root that records what it was asked and answers plainly.
 *
 * It is a stand-in for the owner, not for Core: everything about admission,
 * resolution and form is the real evaluator's above. What this replaces is the
 * REPL state the owner reaches, which the gate rows will supply for real.
 */
function requests(
  asked: Asked,
  /**
   * The journal, because this stub records Submit's pair the way the root does.
   *
   * Submit's intent binds the reservation the root took, so the control wrapper
   * cannot write it — the work that takes the slot does. A stand-in that left
   * that out would be a root whose Submit went unrecorded, and the ordering
   * rows below would be measuring a response the real one does not have.
   */
  journal: ControlJournal,
  options: StubOptions = {},
): SidekickRequests {
  function* answer<T>(name: string, value: T): Operation<Result<T>> {
    asked.requests.push(name);
    if (options.refuse === name) {
      return Err(new Error(`the REPL cannot ${name} right now`));
    }
    return Ok(value);
  }
  return {
    bindings: () => answer<Json>("bindings", { names: ["Ada", "Grace"] }),
    entrySyntax: (names) =>
      answer(
        "entrySyntax",
        names === undefined ? "<Each>, <If>, <Let>" : `looked up ${names.join("+")}`,
      ),
    guide: (chapter) => answer("guide", `# ${chapter}\n\nTeaching for ${chapter}.`),
    environment: () => answer("environment", "cwd: /work\nagent: unknown"),
    *fillDraft(source): Operation<Result<void>> {
      asked.requests.push("fillDraft");
      if (options.refuse === "fillDraft") {
        return Err(new Error("the REPL cannot fillDraft right now"));
      }
      asked.draft = source;
      return Ok(undefined);
    },
    *submit(): Operation<Result<SubmitReceipt>> {
      asked.requests.push("submit");
      const order = yield* journal.began({ component: "REPL.Submit", arguments: {} });
      if (options.refuse === "submit") {
        const refusal = new Error("the REPL cannot submit right now");
        yield* journal.settled(order, Err(refusal));
        return Err(refusal);
      }
      const receipt: SubmitReceipt = options.receipt ?? {
        entry: "entry-1",
        status: "completed",
        failure: undefined,
        read: { entry: "entry-1", limit: 4096 },
      };
      yield* journal.settled(order, Ok(undefined), receipt.status);
      return Ok(receipt);
    },
    entryOutput: (request: OutputReadRequest) =>
      answer(
        "entryOutput",
        options.read ?? {
          entry: "entry-1",
          status: "completed" as const,
          length: 12,
          offset: request.offset ?? 0,
          limit: request.limit ?? 4096,
          text: "printed text",
          previous: undefined,
          next: undefined,
        },
      ),
  };
}

/**
 * The ceiling one response is admitted under, over one journal.
 *
 * One journal for both halves: the controls record through it and the stub root
 * records Submit's own pair through it, which is the arrangement the real owner
 * has.
 */
function ceilingFor(asked: Asked, options: StubOptions = {}): ResponseCeiling {
  const journal = journalOf(asked);
  return sidekickResponseCeiling(requests(asked, journal, options), journal);
}

/** The journal the owner keeps, in the order a response admitted its controls. */
function journalOf(asked: Asked): ControlJournal {
  return {
    // deno-lint-ignore require-yield
    *began(occurrence): Operation<number> {
      asked.began.push(occurrence);
      return asked.began.length - 1;
    },
    // deno-lint-ignore require-yield
    *settled(order, outcome, observed): Operation<void> {
      asked.settled.push({
        order,
        ok: outcome.ok,
        ...(observed === undefined ? {} : { observed }),
      });
    },
  };
}

/**
 * Evaluate one reply under the real ceiling, through a held host execution.
 *
 * The document holds itself open on one element, the caller asks the live
 * handle to evaluate the reply, and the element is released afterwards so the
 * run also completes on its own terms. Nothing here supplies a durable
 * sequence: the reply's admission and every control it performs belong to the
 * sequence the execution allocates for that evaluation.
 */
function reply(
  source: string,
  asked: Asked,
  options: StubOptions = {},
): Operation<Result<GeneratedXmdRootResult>> {
  return scoped(function* () {
    const ceiling = ceilingFor(asked, options);
    const gate = withResolvers<void>();
    const entered = withResolvers<void>();
    const execution = yield* executeInstalled(
      {
        ...retainedSource("repl/sidekick.md", "<SidekickHost />\n"),
        stream: new InMemoryStream(),
      },
      [
        sidekickCeilingInstallation(ceiling),
        {
          components: [
            {
              name: "SidekickHost",
              origin: "test://sidekick-host",
              props: { type: "object", properties: {}, additionalProperties: false },
              description: "Hold this execution open while its caller evaluates one reply.",
              factory: () =>
                function* (): Operation<string> {
                  entered.resolve();
                  yield* gate.operation;
                  return "";
                },
            },
          ],
        },
      ],
    );
    // Observed in a task of its own, so a failure of the run reaches this scope
    // rather than waiting behind a caller that is not watching the handle.
    const watched = yield* spawn(() => execution);
    yield* entered.operation;
    // No table with the call: what this reply may write is the selection the
    // execution captured from the installation above, which is how the owner's
    // conversation admits one too.
    const answer = yield* execution.evaluateGeneratedXmdRoot({
      id: "turn-1",
      source,
      allow: [...ceiling.allow],
    });
    gate.resolve();
    const ran = yield* watched;
    if (!ran.ok) {
      throw ran.error;
    }
    return answer;
  });
}

/**
 * The prop names core's own declaration of one component admits.
 *
 * Read from the registry every execution and every inspection resolves
 * through, which is the definition a selected protected name is captured as.
 */
function canonicalProps(name: string): readonly string[] {
  const definition = CORE_REGISTRY.get(name)?.default?.definition;
  // `props` is a `PropsSchema`, which is a JSON object, so its members are
  // ordinary JSON and `isJsonObject` is the narrowing core itself uses. A
  // schema that is not an object, or whose `properties` is not one, describes
  // no individual props — which is an answer rather than a failure here.
  const schema = definition?.props;
  if (!isJsonObject(schema) || !isJsonObject(schema.properties)) {
    return [];
  }
  return Object.keys(schema.properties);
}

/**
 * The same reply, with whatever else a row needs installed beside the ceiling.
 *
 * The extra installations go *after* the ceiling's, which is where a host's own
 * later setup goes — and a row about interception needs its interception to be
 * in the document's own chain rather than in a sibling of it.
 */
function replyWith(
  source: string,
  asked: Asked,
  beside: readonly ExecutionInstallation[],
  options: StubOptions = {},
): Operation<Result<GeneratedXmdRootResult>> {
  return scoped(function* () {
    const ceiling = ceilingFor(asked, options);
    const gate = withResolvers<void>();
    const entered = withResolvers<void>();
    const execution = yield* executeInstalled(
      {
        ...retainedSource("repl/sidekick.md", "<SidekickHost />\n"),
        stream: new InMemoryStream(),
      },
      [
        sidekickCeilingInstallation(ceiling),
        ...beside,
        {
          components: [
            {
              name: "SidekickHost",
              origin: "test://sidekick-host",
              props: { type: "object", properties: {}, additionalProperties: false },
              description: "Hold this execution open while its caller evaluates one reply.",
              factory: () =>
                function* (): Operation<string> {
                  entered.resolve();
                  yield* gate.operation;
                  return "";
                },
            },
          ],
        },
      ],
    );
    const watched = yield* spawn(() => execution);
    yield* entered.operation;
    const answer = yield* execution.evaluateGeneratedXmdRoot({
      id: "turn-1",
      source,
      allow: [...ceiling.allow],
    });
    gate.resolve();
    const ran = yield* watched;
    if (!ran.ok) {
      throw ran.error;
    }
    return answer;
  });
}

/**
 * One installation that tries to answer a control's name after the capture.
 *
 * Installed inside `Execution.document`, which is the scope the evaluation
 * runner is attached in and the only position a replacement could reach a
 * response from at all — a sibling of the caller could not, so a row using one
 * would pass whether the capture held or not. `at: "min"` is where a provider
 * installs, so this is the most an interception can be.
 */
function intercepting(name: string, reached: string[], invoked: string[]): ExecutionInstallation {
  const substitute: FunctionComponentDefinition = {
    kind: "function",
    name,
    props: { type: "object", properties: {}, additionalProperties: true },
    generated: {
      "self-closing": {
        identity: "https://executable.md/components/substitute/read",
        effect: "read",
      },
      paired: {
        identity: "https://executable.md/components/substitute/write",
        effect: "write",
      },
    },
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      invoked.push(name);
      return "the replacement answered";
    },
  };
  return {
    *install(): Operation<void> {
      yield* Execution.around({
        *document([claimed], next) {
          yield* Component.around(
            {
              *importComponent([asked], nextImport) {
                reached.push(asked);
                if (asked === name) {
                  return substitute;
                }
                return yield* nextImport(asked);
              },
            },
            { at: "min" },
          );
          // A later selection as well, offering a wider vocabulary than the
          // capture sealed: a host that composes one after setup must not widen
          // what a response may write. `File` is the name to try it with — an
          // ordinary component an *entry* may be given and this ceiling omits,
          // so only the selection decides. A structural construct like `<Each>`
          // would prove nothing here: the language refuses one wherever it is
          // written, whatever any table says.
          yield* Component.around({
            generated: () => ({ "REPL.Bindings": ["self-closing"], File: ["self-closing"] }),
          });
          yield* next(claimed);
        },
      });
    },
  };
}

function rendered(answer: Result<GeneratedXmdRootResult>): string {
  if (!answer.ok) {
    throw answer.error;
  }
  return answer.value.output;
}

function refusal(answer: Result<GeneratedXmdRootResult>): string {
  if (answer.ok) {
    throw new Error("this reply was admitted rather than refused");
  }
  return answer.error.message;
}

describe("Tier R3 — what the ceiling admits, and what it does not", () => {
  beforeAll(() => useTempFileCompiler());

  it("R3a: the compact surface describes exactly what is admitted", function* () {
    const asked = fresh();
    const ceiling = ceilingFor(asked);
    const surface = responseSurface(ceiling);

    // Derived from the same entries that admit, so the two cannot drift: every
    // admitted name appears once, and nothing else does.
    expect(surface.map((entry) => entry.name).sort()).toEqual(
      [
        // Core's own, installed by the root evaluator rather than by this
        // ceiling, and described here because a reply has to know it may ask.
        "Syntax",
        // Core's own too, admitted by this ceiling rather than installed
        // beside it: the canonical question, under its own name.
        "Elicit",
        ...GUIDE_CHAPTERS.map((chapter) => `Guide.${chapter}`),
        "REPL.Bindings",
        "REPL.EntryInput",
        "REPL.EntryOutput",
        "REPL.Environment",
        "REPL.Submit",
        "REPL.Syntax",
      ].sort(),
    );

    // The two classes, and the forms each name is admitted for. The question is
    // a write because asking is not reading: a reply admitted to read alone
    // promises nobody will be interrupted.
    expect(
      surface
        .filter((entry) => entry.effect === "write")
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["Elicit", "REPL.EntryInput", "REPL.Submit"]);
    expect(surface.find((entry) => entry.name === "REPL.EntryInput")?.form).toBe("paired");
    expect(surface.find((entry) => entry.name === "REPL.Submit")?.form).toBe("self-closing");
    // Paired, because the question is the content.
    expect(surface.find((entry) => entry.name === "Elicit")?.form).toBe("paired");
    // And its props are the canonical component's own, compared against the
    // declaration rather than restated here. `Elicit` is selected rather than
    // answered for, so the surface states the authored contract it was selected
    // under — and this is what fails if core's `<Elicit>` ever took another
    // prop, instead of leaving a reply under-told about a control it may write.
    expect(surface.find((entry) => entry.name === "Elicit")?.props).toEqual(
      canonicalProps("Elicit"),
    );

    // The props come from each definition's own schema.
    expect(surface.find((entry) => entry.name === "REPL.EntryOutput")?.props).toEqual([
      "entry",
      "offset",
      "limit",
    ]);
    expect(surface.find((entry) => entry.name === "REPL.Bindings")?.props).toEqual([]);

    // A reply reads the description, so it has to say the spellings.
    const described = describeSurface(surface);
    expect(described).toContain("<REPL.EntryInput>…</REPL.EntryInput>");
    expect(described).toContain("<REPL.Submit />");
    expect(described).toContain("<Elicit>…</Elicit>");
  });

  it("R3b: every control this CLI supplies is designated, and <Syntax /> is not", function* () {
    const asked = fresh();
    const surface = responseSurface(ceilingFor(asked));
    const designated = surface.filter((entry) => entry.designated).map((entry) => entry.name);

    // Every control, reads and writes alike. A write is designated for the same
    // reason a read is: the reply asked the root to do something, and the answer
    // is what it needs to continue — a Submit that admitted an entry has to be
    // told which one, or its next response is written against a guess.
    expect(designated.sort()).toEqual(
      [
        // The question included, and it is the one whose answer the reply
        // cannot possibly have: a person typed it.
        "Elicit",
        ...GUIDE_CHAPTERS.map((chapter) => `Guide.${chapter}`),
        "REPL.Bindings",
        "REPL.EntryInput",
        "REPL.EntryOutput",
        "REPL.Environment",
        "REPL.Submit",
        "REPL.Syntax",
      ].sort(),
    );
    // Core's own self-description is deliberately not designated: its ordinary
    // return is the reply's to render rather than an operation result. That is
    // a separate decision from whether it is admitted, and this row makes no
    // claim about admission — an earlier version of it asserted that `<Syntax
    // />` was absent from the ceiling, which mistook one for the other.
    // Admitted — Core's root evaluator installs it — and deliberately not
    // designated: its ordinary return is the reply's to render or capture.
    expect(surface.some((entry) => entry.name === "Syntax")).toBe(true);
    expect(designated).not.toContain("Syntax");
  });

  it("R3c: a name this ceiling does not admit refuses the whole reply", function* () {
    const asked = fresh();

    expect(refusal(yield* reply("<REPL.Delete />\n", asked))).toContain("did not admit");
    // Refused before anything ran, so no request was made.
    expect(asked.requests).toEqual([]);
    expect(asked.began).toEqual([]);
  });

  it("R3d: a control written in the wrong form refuses", function* () {
    const asked = fresh();

    // Submit is admitted self-closing. Paired is a different spelling, and a
    // body nobody reads is not what it means.
    expect(refusal(yield* reply("<REPL.Submit>go</REPL.Submit>\n", asked))).toContain(
      "self-closing",
    );
    // EntryInput is admitted paired, so self-closing would fill nothing.
    expect(refusal(yield* reply("<REPL.EntryInput />\n", asked))).toContain("self-closing");
    expect(asked.requests).toEqual([]);
  });
});

describe("Tier R3 — each control asks once, and records before and after", () => {
  beforeAll(() => useTempFileCompiler());

  it("R3e: a read asks for exactly what the element said, and renders the answer", function* () {
    const asked = fresh();

    const answer = yield* reply("<Output>\n<REPL.Bindings />\n</Output>\n", asked);

    expect(asked.requests).toEqual(["bindings"]);
    expect(rendered(answer)).toContain('"Ada"');
    // One intent, one outcome, in that order, with the observation retained.
    expect(asked.began).toEqual([{ component: "REPL.Bindings", arguments: {} }]);
    expect(asked.settled).toEqual([{ order: 0, ok: true, observed: { names: ["Ada", "Grace"] } }]);
  });

  it("R3f: a lookup carries its names, and a bare read carries none", function* () {
    const asked = fresh();

    // The spelling the accepted amendment teaches: a list, which is canonical
    // `<Syntax />`'s own schema rather than a third way of asking.
    yield* reply('<Output>\n<REPL.Syntax names={["Elicit"]} />\n</Output>\n', asked);
    expect(asked.began[0]).toEqual({
      component: "REPL.Syntax",
      arguments: { names: ["Elicit"] },
    });

    const bare = fresh();
    yield* reply("<Output>\n<REPL.Syntax />\n</Output>\n", bare);
    expect(bare.began[0]).toEqual({ component: "REPL.Syntax", arguments: {} });
  });

  it("R3g: all six guide chapters are readable, and return literal Markdown", function* () {
    const asked = fresh();
    const source = GUIDE_CHAPTERS.map((chapter) => `<Guide.${chapter} />`).join("\n");

    const answer = yield* reply(`<Output>\n${source}\n</Output>\n`, asked);

    expect(asked.requests).toEqual(GUIDE_CHAPTERS.map(() => "guide"));
    expect(asked.began.map((occurrence) => occurrence.component)).toEqual(
      GUIDE_CHAPTERS.map((chapter) => `Guide.${chapter}`),
    );
    // The chapter's own text, as written. Nothing in it is interpolated or run.
    for (const chapter of GUIDE_CHAPTERS) {
      expect(rendered(answer)).toContain(`Teaching for ${chapter}.`);
    }
  });

  it("R3h: the draft is filled with literal captured source, exactly once", function* () {
    const asked = fresh();
    const entry = '<Each in={names} let="name">\nHello, {name}!\n</Each>';

    // The accepted program: capture entry source passively, hand the captured
    // string to the paired control. `names` and `name` belong to the entry and
    // are not response bindings.
    yield* reply(
      '<Let as="code" select="code">\n```xmd\n' +
        entry +
        "\n```\n</Let>\n<REPL.EntryInput>{code}</REPL.EntryInput>\n",
      asked,
    );

    expect(asked.requests).toEqual(["fillDraft"]);
    expect(asked.draft).toBe(entry);
    // The source is retained as the intent's own argument, so an interrupted
    // fill can be read back as what it was asked to do.
    expect(asked.began).toEqual([{ component: "REPL.EntryInput", arguments: { source: entry } }]);
  });

  it("R3i: Submit renders its receipt and names the read to follow", function* () {
    const asked = fresh();

    const answer = yield* reply("<Output>\n<REPL.Submit />\n</Output>\n", asked, {
      receipt: {
        entry: "entry-4",
        status: "failed",
        failure: "the entry raised",
        read: { entry: "entry-4", limit: 4096 },
      },
    });

    const text = rendered(answer);
    expect(text).toContain("Entry entry-4 failed.");
    expect(text).toContain("the entry raised");
    // The read is an instruction, pinned to that entry. No output body here.
    expect(text).toContain('<REPL.EntryOutput entry="entry-4"');
    expect(text).not.toContain("printed text");
  });

  it("R3j: an output read states its range and fences the output it returns", function* () {
    const asked = fresh();

    const answer = yield* reply(
      '<Output>\n<REPL.EntryOutput entry="entry-1" offset={0} limit={6} />\n</Output>\n',
      asked,
      {
        read: {
          entry: "entry-1",
          status: "running",
          length: 40,
          offset: 0,
          limit: 6,
          // Output containing a fence of its own, which is the ordinary case
          // for entry output and the reason the fence is measured.
          text: "```xmd\ninside\n```",
          previous: undefined,
          next: { entry: "entry-1", offset: 6, limit: 6 },
        },
      },
    );

    const text = rendered(answer);
    expect(text).toContain("Entry entry-1 (running)");
    expect(text).toContain("of 40");
    // A longer fence than the output holds, so the output survives being quoted.
    expect(text).toContain("````");
    expect(text).toContain("```xmd\ninside\n```");
    // More to read, and the instruction says where from.
    expect(text).toContain("offset={6}");
  });

  it("R3k: a refused request is this operation's outcome, not the end of the reply", function* () {
    const asked = fresh();

    const answer = yield* reply("<Output>\n<REPL.Bindings />\n</Output>\n", asked, {
      refuse: "bindings",
    });

    // The reply still rendered, with the reason in the place the control was
    // written — a reply that asked for something unavailable may well ask for
    // something else next.
    expect(rendered(answer)).toContain("cannot bindings right now");
    expect(asked.settled).toEqual([{ order: 0, ok: false }]);
  });

  it("R3l: controls are recorded in the order the reply admitted them", function* () {
    const asked = fresh();

    yield* reply(
      "<Output>\n<REPL.Bindings />\n<REPL.Environment />\n</Output>\n" +
        "<REPL.EntryInput>done</REPL.EntryInput>\n<REPL.Submit />\n",
      asked,
    );

    expect(asked.began.map((occurrence) => occurrence.component)).toEqual([
      "REPL.Bindings",
      "REPL.Environment",
      "REPL.EntryInput",
      "REPL.Submit",
    ]);
    // Each one settled under the order it began with, so an interrupted
    // response's unanswered intent is identifiable by position.
    expect(asked.settled.map((held) => held.order)).toEqual([0, 1, 2, 3]);
  });
});

/**
 * Tier R3 — one gate, two submitters, and revisions that name what was taken.
 *
 * These rows are the half of the gate a reduction settles: who may submit a
 * draft at all, what an edit does to the revision that names it, and which
 * revision an admission clears. The session-owned half — holding a preflight,
 * revoking a pending admission, waiting on the exact admitted entry — belongs
 * to the root and is not covered here.
 *
 * `reduceRepl` is driven directly, because what is being proved is the
 * decision rather than a journey through it. The gate is the same module the
 * root calls: these rows pass through `submittable` over the facts a reduction
 * can see, which is the point of splitting the facts instead of the decision.
 */
describe("Tier R3 — one gate decides who may take the next entry", () => {
  it("R3: a person's edit raises the draft revision and takes the draft over", function* () {
    const fresh = initialState("exec-1");
    expect(fresh.revisions).toEqual({ draft: 0, message: 0 });
    expect(fresh.takenOver).toBe(false);

    const typed = reduceRepl(
      fresh,
      { kind: "type", text: "<Output>hi</Output>" },
      EMPTY,
      QUIET,
    ).state;

    expect(typed.draft).toBe("<Output>hi</Output>");
    expect(typed.revisions.draft).toBe(1);
    // The message box is a different text with a different owner, so typing
    // into the draft says nothing about it.
    expect(typed.revisions.message).toBe(0);
    expect(typed.takenOver).toBe(true);
  });

  it("R3: a Sidekick fill raises the same revision and takes nothing over", function* () {
    const filled_ = filled(initialState("exec-1"), "<Output>from the reply</Output>");

    expect(filled_.draft).toBe("<Output>from the reply</Output>");
    // Raised, because it is a new text and an admission has to be able to name
    // which one it took — but the draft is not a person's, so it is not theirs.
    expect(filled_.revisions.draft).toBe(1);
    expect(filled_.takenOver).toBe(false);
  });

  it("R3: a takeover pauses the Sidekick's submission and a person's goes through", function* () {
    const held = reduceRepl(
      initialState("exec-1"),
      { kind: "type", text: "mine" },
      EMPTY,
      QUIET,
    ).state;
    const facts = {
      live: true,
      revisions: held.revisions,
      takenOver: held.takenOver,
      draft: held.draft,
    };

    const reply = submittable("sidekick", facts);
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.error.message).toContain("edited by hand");
    // Paused, not refused forever, and only for the Sidekick: the person whose
    // draft it is submits it.
    expect(submittable("person", facts).ok).toBe(true);
  });

  it("R3: an explicit instruction clears the takeover and raises its own revision", function* () {
    const held = reduceRepl(
      initialState("exec-1"),
      { kind: "type", text: "mine" },
      EMPTY,
      QUIET,
    ).state;
    // At the revisions the instruction was asked at, which is what an
    // acknowledgement names: the message that was sent and the draft as it
    // stood when it was.
    const asked = instructed(held, {
      message: held.revisions.message,
      draft: held.revisions.draft,
      // This box's own text, which is what a Send acknowledges.
      from: "composer",
    });

    expect(asked.takenOver).toBe(false);
    expect(asked.revisions.message).toBe(1);
    // The draft and its revision are untouched: unpausing the Sidekick is not
    // an edit to the text it may now submit.
    expect(asked.draft).toBe("mine");
    expect(asked.revisions.draft).toBe(held.revisions.draft);
    expect(
      submittable("sidekick", {
        live: true,
        revisions: asked.revisions,
        takenOver: asked.takenOver,
        draft: asked.draft,
      }).ok,
    ).toBe(true);
  });

  it("R3: admission clears the revision it admitted, and an edit after it survives", function* () {
    const typed = reduceRepl(
      initialState("exec-1"),
      { kind: "type", text: "first" },
      EMPTY,
      QUIET,
    ).state;
    const held = reserve(
      "person",
      { live: true, revisions: typed.revisions, takenOver: typed.takenOver, draft: typed.draft },
      { entry: "entry-1", ordinal: 0 },
    );
    expect(held.source).toBe("first");
    expect(held.revision).toBe(typed.revisions.draft);

    // Admitting the reservation alone clears the draft it took.
    expect(admitted(typed, held).draft).toBe("");

    // But somebody typed while the preflight was still running. That text is a
    // newer revision, so the admission is not about it and it stays.
    const later = reduceRepl(typed, { kind: "type", text: "-second" }, EMPTY, QUIET).state;
    expect(later.revisions.draft).toBe(held.revision + 1);
    expect(admitted(later, held).draft).toBe("first-second");
  });

  it("R3: a frozen position and an empty draft refuse, for both submitters alike", function* () {
    const empty = { live: true, revisions: initialRevisions(), takenOver: false, draft: "" };
    for (const by of ["person", "sidekick"] as const) {
      const nothing = submittable(by, empty);
      expect(nothing.ok).toBe(false);
      expect(nothing.ok === false && nothing.error.message).toContain("nothing to submit yet");

      const frozen = submittable(by, { ...empty, live: false, draft: "something" });
      expect(frozen.ok).toBe(false);
      expect(frozen.ok === false && frozen.error.message).toContain("frozen at an earlier history");
    }
  });
});

/**
 * Tier R3 — what became of a reservation nobody answered (#883).
 *
 * The refusal half of the cold reconciliation. R2i/R2j in
 * `repl-sidekick-recovery.test.ts` drive the two states a real process leaves
 * across a real boundary, and those are the cases that happen; these are the
 * ones that must never be *guessed*. A chat naming a slot the entry history
 * filled with something else is two files disagreeing, and the only safe
 * reading of a disagreement is to say so — so each row here is a reading that
 * looks correct from two of the three facts and is wrong on the third.
 */
describe("Tier R3 — a reservation is found by all three of its facts", () => {
  /**
   * The reservation every row below starts from.
   *
   * Two entries preceded it, written across seven journal records — which is
   * the distinction this tier is about: the ordinal counts entries and the
   * binding counts records, and only the binding says *which* records.
   */
  const HELD: Reserved = {
    ordinal: 2,
    entry: "entry-3",
    source: "Body.\n",
    retained: { records: 7, bytes: 512, sha256: "a".repeat(64) },
  };

  function entry(key: string, source: string): { key: string; source: string } {
    return { key, source };
  }

  const BEFORE = [entry("entry-1", "one"), entry("entry-2", "two")];

  /** The journal as the reader measured it, with the binding satisfied. */
  function history(
    entries: readonly { key: string; source: string }[],
    over: { records?: number; measured?: { bytes: number; sha256: string } | undefined } = {},
  ): EntryHistory {
    return {
      entries,
      records: over.records ?? 9,
      measured: Object.hasOwn(over, "measured")
        ? over.measured
        : { bytes: HELD.retained.bytes, sha256: HELD.retained.sha256 },
    };
  }

  it("R3: the slot its prefix named, holding the entry it named, under its bytes", function* () {
    const found = resolved(HELD, history([...BEFORE, entry("entry-3", "Body.\n")]));
    if (!found.ok) {
      throw found.error;
    }
    expect(found.value).toEqual({ kind: "admitted", entry: "entry-3" });
  });

  it("R3: an empty slot is absent, not a missing entry", function* () {
    const found = resolved(HELD, history(BEFORE));
    if (!found.ok) {
      throw found.error;
    }
    // Nothing took it. That is an answer — the process stopped before the entry
    // existed — and not a history that is wrong about anything.
    expect(found.value).toEqual({ kind: "absent" });
  });

  it("R3: a slot taken by another entry refuses rather than choosing", function* () {
    // The prefix is right and the slot is occupied; the id is not the one that
    // was reserved. Matching on position alone would call this admitted and
    // hand a reply a receipt for an entry it never asked for.
    const found = resolved(HELD, history([...BEFORE, entry("entry-9", "Body.\n")]));
    expect(found.ok).toBe(false);
    if (found.ok) {
      throw new Error("a slot holding another entry is not this reservation's");
    }
    expect(found.error.message).toContain("`entry-9` is the entry there");
  });

  it("R3: the reserved id under other bytes refuses", function* () {
    // Position and identity both agree, which is exactly what makes this the
    // dangerous one: the only thing saying the entry that ran is not the entry
    // that was reserved is the source.
    const found = resolved(HELD, history([...BEFORE, entry("entry-3", "Something else.\n")]));
    expect(found.ok).toBe(false);
    if (found.ok) {
      throw new Error("the reserved id under other bytes is not what was reserved");
    }
    expect(found.error.message).toContain("under a source the entry history does not hold");
  });

  it("R3: a history shorter than the bound prefix refuses", function* () {
    // Fewer records than the reservation was taken against. A history shorter
    // than the one it counted is not a later state of that history, and nothing
    // here can say which of the two files is wrong.
    const found = resolved(HELD, history(BEFORE, { records: 4, measured: undefined }));
    expect(found.ok).toBe(false);
    if (found.ok) {
      throw new Error("a history shorter than the bound prefix establishes nothing");
    }
    expect(found.error.message).toContain("holds only 4");
  });

  it("R3: the same number of records, differing, refuses before any finding", function* () {
    // The reading an ordinal alone cannot tell apart, and the whole reason the
    // binding exists: the slot is where it was counted, the entry sitting there
    // *is* the one that was reserved under the bytes that were reserved, and
    // the history it followed is not the history it was reserved after.
    const changed = history([...BEFORE, entry("entry-3", "Body.\n")], {
      measured: { bytes: HELD.retained.bytes, sha256: "b".repeat(64) },
    });
    const found = resolved(HELD, changed);
    expect(found.ok).toBe(false);
    if (found.ok) {
      throw new Error("a changed prefix is not the history this reservation was taken against");
    }
    expect(found.error.message).toContain("no longer begins with the records");
  });

  it("R3: a changed prefix refuses rather than reporting an absent entry", function* () {
    // Checked before *either* answer. Reporting `absent` here would be a claim
    // about a history nobody has — that nothing took a slot this reading cannot
    // even locate — and a caller would then retain that as the resolution.
    const changed = history(BEFORE, {
      measured: { bytes: HELD.retained.bytes + 1, sha256: HELD.retained.sha256 },
    });
    const found = resolved(HELD, changed);
    expect(found.ok).toBe(false);
    if (found.ok) {
      throw new Error("an unlocatable slot is not an absent entry");
    }
    expect(found.error.message).toContain("no longer begins with the records");
  });
});

/**
 * Tier R3 — the teaching this CLI ships, and the index that advertises it (#883).
 *
 * Three assertions, and the third is the one that decays if nothing holds it. The
 * assets are present in this build and readable; what a chapter returns is the
 * file's own bytes rather than a rendering of them; and the index is *derived*
 * from what the ceiling actually admits, so a chapter nothing registers cannot
 * be advertised and a chapter that is registered cannot be left out.
 *
 * Read through the production loader against the real files. A fixture holding
 * expected chapter text would be a second copy of the teaching, which is the
 * thing the derivation exists to avoid.
 */
describe("Tier R3 — the guide index describes what is admitted", () => {
  /** The names this ceiling registers, which is what may be advertised. */
  function admittedNames(): ReadonlySet<string> {
    const asked: Asked = { requests: [], began: [], settled: [], draft: undefined };
    const ceiling = ceilingFor(asked);
    return new Set(ceiling.controls.filter((one) => one.effect === "read").map((one) => one.name));
  }

  it("R3: every shipped chapter reads back as exactly the file it is", function* () {
    for (const chapter of GUIDE_CHAPTERS) {
      const read = yield* readGuideChapter(chapter);
      if (!read.ok) {
        throw read.error;
      }
      // The asset's own bytes. Not a rendering, not an interpolation, not a
      // reformatting — the text a person reviews is the text a reply is taught.
      const file = yield* until(readFile(sidekickAssetUrl(`${chapter.toLowerCase()}.md`), "utf8"));
      expect(read.value).toBe(file);
      // And it is a chapter in the approved shape rather than a stub: its own
      // title, and the two sections the format requires of every one of them.
      expect(read.value.startsWith(`# ${chapter}\n`)).toBe(true);
      expect(read.value).toContain("## Applies to");
      expect(read.value).toContain("## Instructions");
    }
  });

  it("R3: the bootstrap ships too, and says what a reply may not assume", function* () {
    const read = yield* readSidekickBootstrap();
    if (!read.ok) {
      throw read.error;
    }
    // The three things a first turn cannot discover for itself and must not
    // guess: that its response is itself evaluated, that it starts with no
    // bindings, and that it has no tools of its own.
    expect(read.value).toContain("Write each response as an XMD program");
    expect(read.value).toContain("starts\nwith no bindings");
    expect(read.value).toContain("no native shell, file-editing or MCP tools");
  });

  it("R3: the index is the admitted chapters, with their own stated purpose", function* () {
    const admitted = admittedNames();
    const index = yield* sidekickGuideIndex(admitted);

    // Every chapter the ceiling admits, and nothing else.
    expect(index.map((entry) => entry.name)).toEqual(
      GUIDE_CHAPTERS.map((chapter) => `Guide.${chapter}`),
    );
    for (const entry of index) {
      expect(admitted.has(entry.name)).toBe(true);
      expect(entry.invocation).toBe(`<${entry.name} />`);
      // The purpose is the chapter's own opening sentence, on one line, so the
      // index and the chapter cannot disagree about what the chapter is for.
      expect(entry.purpose.startsWith("Read this")).toBe(true);
      expect(entry.purpose).not.toContain("\n");
    }
    // And it is written out as the exact invocations, so a first turn does not
    // have to work out how to ask.
    const described = describeGuideIndex(index);
    for (const chapter of GUIDE_CHAPTERS) {
      expect(described).toContain(`<Guide.${chapter} />`);
    }
  });

  it("R3: a chapter the ceiling does not admit is not advertised", function* () {
    // The discriminating case for "derived": the chapter asset is right there
    // and readable, and the index still leaves it out, because what the index
    // describes is what a reply may actually write.
    const narrowed = new Set([...admittedNames()].filter((name) => name !== "Guide.Recovery"));
    const index = yield* sidekickGuideIndex(narrowed);

    expect(index.map((entry) => entry.name)).not.toContain("Guide.Recovery");
    expect(index.length).toBe(GUIDE_CHAPTERS.length - 1);
    // Still readable, which is what makes this a statement about the index
    // rather than about the asset.
    expect((yield* readGuideChapter("Recovery")).ok).toBe(true);
  });
});

/**
 * Tier R3 — the shipped examples do what they say (#883).
 *
 * A guide's example is the part an agent copies, so an example that is refused
 * is worse than no example: it teaches a pattern that cannot work, and it does
 * it in the voice of the host. These rows take each example out of the shipped
 * file and put it through the two boundaries it is said to cross — the real
 * response ceiling and root evaluator, then the ordinary entry path — and
 * compare the result against the outcome the chapter states.
 *
 * Extracted from the assets rather than restated here. A fixture holding the
 * expected response would be a second copy of the teaching, and the row would
 * then pass while the shipped file was wrong.
 */
describe("Tier R3 — a shipped example prepares a draft and runs", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * The complete response a chapter displays.
   *
   * The fence length is captured and back-referenced rather than fixed, because
   * these examples nest three fence layers and each needs more backticks than
   * the one inside it: the chapter that shows a passive block holding an
   * executable one opens with five, the one that shows only a passive block
   * opens with four, and a pattern hard-coded to either would silently match
   * the wrong layer.
   */
  function exampleOf(chapter: string, text: string): string {
    const match = /^(`{4,})xmd\n([\s\S]*?)^\1$/m.exec(text);
    const source = match?.[2];
    if (source === undefined) {
      throw new Error(`Guide.${chapter} displays no complete response example`);
    }
    return source;
  }

  /** Read one chapter and hand back the response it displays. */
  function* displayed(chapter: GuideChapter): Operation<string> {
    const read = yield* readGuideChapter(chapter);
    if (!read.ok) {
      throw read.error;
    }
    return exampleOf(chapter, read.value);
  }

  /** Run one prepared draft the way an ordinary submission runs it. */
  function* ranAsEntry(source: string): Operation<string> {
    const opened = yield* openReplSession({
      execution: { id: "guide-example", stream: new InMemoryStream() },
    });
    if (!opened.ok) {
      throw opened.error;
    }
    const session = opened.value;
    const submitted = yield* session.submit(source);
    if (!submitted.ok) {
      throw submitted.error;
    }
    const outcome = yield* submitted.value.join();
    if (!outcome.ok) {
      throw outcome.error;
    }
    return session.overlay.output;
  }

  /**
   * Evaluate a chapter's example as a reply, and hand back what it drafted.
   *
   * Through the same ceiling and the same evaluator a real reply crosses, so a
   * construct this execution refuses is refused here too — which is the whole
   * point of the row.
   */
  function* prepared(chapter: GuideChapter): Operation<{ draft: string; fills: number }> {
    const asked: Asked = { requests: [], began: [], settled: [], draft: undefined };
    const answer = yield* reply(yield* displayed(chapter), asked);
    if (!answer.ok) {
      throw new Error(`Guide.${chapter}'s example was refused: ${answer.error.message}`);
    }
    const draft = asked.draft;
    if (draft === undefined) {
      throw new Error(`Guide.${chapter}'s example filled no draft`);
    }
    return { draft, fills: asked.requests.filter((one) => one === "fillDraft").length };
  }

  it("R3: Entries fills the draft once, and the drafted program runs", function* () {
    const { draft, fills } = yield* prepared("Entries");
    expect(fills).toBe(1);
    // Literal: the captured source reached the draft as source, not as output.
    expect(draft).toContain('<Let as="names" value={["Ada", "Lin"]} />');
    expect(yield* ranAsEntry(draft)).toContain("Hello, Ada!");
  });

  it("R3: Effection drafts an executable fence, and the entry suspends and resumes", function* () {
    const { draft, fills } = yield* prepared("Effection");
    expect(fills).toBe(1);
    // The executable fence belongs to the entry and survived as text: the reply
    // was admitted *because* that fence was inside a passive one, and the draft
    // holds it still executable.
    expect(draft).toContain("```js eval");
    expect(draft).toContain("yield* sleep(1)");
    // And the outcome the chapter states, from the entry that actually ran it.
    expect(yield* ranAsEntry(draft)).toContain("started then resumed");
  });

  it("R3: Lifetimes drafts a resource, and its release is observed before the end", function* () {
    const { draft, fills } = yield* prepared("Lifetimes");
    expect(fills).toBe(1);
    expect(draft).toContain("```js eval");
    expect(draft).toContain("yield* resource(function* (provide)");
    // The order the chapter states, which is the claim worth proving: the
    // release is in the output, so it happened while the entry was still
    // running rather than during its teardown.
    const output = yield* ranAsEntry(draft);
    expect(output).toContain("acquired, used handle, released");
  });
});

/**
 * Tier R3 — what a reply reads, over the history rather than the screen.
 *
 * These rows are the other side of the seam the tiers above prove. There the
 * control was real and the root was a stand-in; here the root's own reads are
 * real — one open session, one profile, the acknowledged projection and the
 * entry vocabulary this command would actually validate an entry against — and
 * what stands in is only the conversation that would have asked.
 *
 * What is worth proving is that a read answers about the *history*. A person
 * standing at an earlier position, inside a nested scope or on either tab has
 * changed nothing about what the file says, and a reply handed the prefix they
 * navigated to would write an entry against bindings that were replaced several
 * entries ago — with nothing in the response saying so. The read half takes no
 * route at all, which is how that is kept true rather than remembered.
 */
describe("Tier R3 — a reply reads the history, not the screen", () => {
  beforeAll(() => useTempFileCompiler());

  /** One entry that publishes a root value and prints it. */
  function publishes(name: string, value: string, label: string): string {
    return ["```js eval", `const ${name} = "${value}";`, "```", "", `${label}: {${name}}`, ""].join(
      "\n",
    );
  }

  /** A block that keeps the entry open, so it is still running when read. */
  const RUNS_ON = ["```js eval", "yield* suspend();", "```", ""].join("\n");

  /**
   * One entry that publishes and then stops, so it is still running when read.
   *
   * Two blocks on purpose. A binding is published when its block completes, so
   * the first block's value is in the file while the second block holds the
   * entry open — which is the state "a running export" names and the only one
   * that can distinguish it.
   */
  const PUBLISHES_THEN_WAITS = ["```js eval", 'const live = "running";', "```", "", RUNS_ON].join(
    "\n",
  );

  /**
   * The profile these rows read the entry vocabulary from.
   *
   * A command that installed no Plugin, which is a fact about it rather than a
   * missing one — so the snapshot below says `none` rather than leaving the line
   * out.
   */
  const PROFILE = {
    includes: ["components", "."],
    permissionMode: "deny-all",
    plugins: NO_PLUGINS.plugins.map((plugin) => plugin.name),
    vocabulary: entryVocabulary(["components", "."], NO_PLUGINS),
  } as const;

  /**
   * The reads, with the writes wired to fail the row if a read performs one.
   *
   * A safety net rather than a stand-in: these rows are about what a reply is
   * told, and a read that filled the draft or admitted an entry would be a read
   * that changed what somebody is looking at.
   */
  function reading(session: ReplSession): RootReading {
    return {
      ...rootReads(session, PROFILE),
      // deno-lint-ignore require-yield
      *fill(): Operation<Result<void>> {
        throw new Error("a read filled the shared draft");
      },
    };
  }

  /** A submit nobody is supposed to reach, so a read that admits one is caught. */
  function noSubmission(): Operation<Result<SubmitReceipt>> {
    // deno-lint-ignore require-yield
    return (function* (): Operation<Result<SubmitReceipt>> {
      throw new Error("a read admitted an entry");
    })();
  }

  /** Open one session over this stream, failing the row if it cannot be read. */
  function* opened(id: string, stream: InMemoryStream, at?: string): Operation<ReplSession> {
    const answer = yield* openReplSession({
      execution: { id, stream },
      ...(at === undefined ? {} : { selection: at }),
    });
    if (!answer.ok) {
      throw answer.error;
    }
    return answer.value;
  }

  /** Run one entry to its outcome, failing the row if it did not succeed. */
  function* ran(session: ReplSession, source: string): Operation<void> {
    const submitted = yield* session.submit(source);
    if (!submitted.ok) {
      throw submitted.error;
    }
    const outcome = yield* submitted.value.join();
    if (!outcome.ok) {
      throw outcome.error;
    }
  }

  /**
   * Wait for the first reprojection this is true of.
   *
   * The history itself is the readiness signal: a reprojection happens when a
   * record lands, so waiting for the projection to hold the published name
   * waits for exactly the thing being asserted. Nothing is slept on.
   */
  function* reprojected(
    session: ReplSession,
    satisfied: (model: ReplModel) => boolean,
  ): Operation<void> {
    if (satisfied(session.model)) {
      return;
    }
    const changes = yield* session.changes;
    while (true) {
      const next = yield* changes.next();
      if (next.done === true) {
        throw new Error("the session stopped reprojecting before the record arrived");
      }
      if (satisfied(next.value)) {
        return;
      }
    }
  }

  /**
   * Wait until the running entry has printed this text.
   *
   * The entry's own output stream is the readiness signal: a flush happens when
   * a segment ends, so waiting for the text waits for exactly the thing being
   * asserted and nothing is slept on.
   */
  function* printed(session: ReplSession, text: string): Operation<void> {
    if (session.printing?.output.includes(text) === true) {
      return;
    }
    const outputs = yield* session.outputs;
    while (true) {
      const next = yield* outputs.next();
      if (next.done === true) {
        throw new Error("the entry stopped printing before that text arrived");
      }
      if (session.printing?.output.includes(text) === true) {
        return;
      }
    }
  }

  it("R3: the latest acknowledged root, read from an earlier selected position", function* () {
    const stream = new InMemoryStream();
    // Two settled entries, each publishing the same name with a different
    // value, so the two readings cannot agree by accident. In a scope of its
    // own, so this session is over before the next one opens over the file.
    const marker = yield* scoped(function* (): Operation<string> {
      const session = yield* opened("reads", stream);
      yield* ran(session, publishes("token", "alpha", "One"));
      yield* ran(session, publishes("token", "beta", "Two"));
      const first = session.navigation.checkpoints[0]?.marker;
      if (first === undefined) {
        throw new Error("this history retained no position to stand at");
      }
      return first;
    });

    // Opened *at* that position, which is what a person walking back through
    // the History band is looking at.
    const session = yield* opened("reads", stream, marker);

    // Both sides measured. The selected prefix is Entry 1's admission, before
    // anything was published, so the two readings are `{}` and `beta` — and a
    // read that answered from the screen would return the empty one.
    expect(session.model.selection).toBe(marker);
    expect(entryInitialBindings(session.model)).toEqual({});

    const reads = reading(session);
    const head = reads.acknowledged();
    if (!head.ok) {
      throw head.error;
    }
    expect(head.value.entries).toHaveLength(2);

    const answer = yield* sidekickRequests(reads, noSubmission).bindings();
    if (!answer.ok) {
      throw answer.error;
    }
    expect(answer.value).toEqual({ token: "beta" });
  });

  it("R3: a value the running entry has already published is in that reading", function* () {
    const session = yield* opened("running", new InMemoryStream());
    const submitted = yield* session.submit(PUBLISHES_THEN_WAITS);
    if (!submitted.ok) {
      throw submitted.error;
    }
    // The entry is still open — it is suspended in its second block — and the
    // first block's publication has reached the file.
    yield* reprojected(session, (model) => Object.hasOwn(entryInitialBindings(model), "live"));
    expect(session.live).toBe(true);

    const requested = sidekickRequests(reading(session), noSubmission);
    const answer = yield* requested.bindings();
    if (!answer.ok) {
      throw answer.error;
    }
    expect(answer.value).toEqual({ live: "running" });

    // And the entry it belongs to reads as what it is, rather than as an entry
    // that finished with whatever it had printed by then.
    const read = yield* requested.entryOutput({});
    if (!read.ok) {
      throw read.error;
    }
    expect(read.value.entry).toBe("entry-1");
    expect(read.value.status).toBe("running");
  });

  it("R3: the running entry's output, from a session opened at an earlier position", function* () {
    const stream = new InMemoryStream();
    const marker = yield* scoped(function* (): Operation<string> {
      const session = yield* opened("pinned", stream);
      yield* ran(session, publishes("token", "alpha", "One"));
      // The position *after* Entry 1 closed, so the prefix the next session is
      // pinned at carries a recorded outcome of its own. That outcome is what
      // the screen's overlay answers with, and it is the wrong answer about an
      // entry running now.
      const closed = session.navigation.checkpoints.filter((point) => point.kind === "terminal");
      const last = closed[closed.length - 1]?.marker;
      if (last === undefined) {
        throw new Error("this history retained no settled position to stand at");
      }
      return last;
    });

    const session = yield* opened("pinned", stream, marker);
    const submitted = yield* session.submit(
      ["```js eval", 'const live = "second";', "```", "", "Two: {live}", "", RUNS_ON].join("\n"),
    );
    if (!submitted.ok) {
      throw submitted.error;
    }
    yield* printed(session, "Two: second");

    // The control, measured rather than asserted about: the overlay answers at
    // the position this session was opened at, so it is reporting Entry 1's
    // retained text while Entry 2 is the entry that is running.
    expect(session.overlay.output).toContain("One: alpha");
    expect(session.overlay.output).not.toContain("Two: second");

    const requested = sidekickRequests(reading(session), noSubmission);
    const read = yield* requested.entryOutput({});
    if (!read.ok) {
      throw read.error;
    }
    expect(read.value.entry).toBe("entry-2");
    expect(read.value.status).toBe("running");
    expect(read.value.text).toContain("Two: second");
    // And Entry 1 is still its own recorded text, not the running entry's.
    expect(read.value.text).not.toContain("One: alpha");
    const first = yield* requested.entryOutput({ entry: "entry-1" });
    if (!first.ok) {
      throw first.error;
    }
    expect(first.value.text).toContain("One: alpha");
    expect(first.value.status).toBe("completed");
  });

  it("R3: an output read answers about the entry it named", function* () {
    const session = yield* opened("outputs", new InMemoryStream());
    yield* ran(session, publishes("token", "alpha", "One"));
    yield* ran(session, publishes("token", "beta", "Two"));

    const requested = sidekickRequests(reading(session), noSubmission);

    // The exact id, the relative position, and the default — which is the
    // latest. The earlier entry's window is its own text and not the later
    // one's, which is the thing a per-entry read has to get right.
    const first = yield* requested.entryOutput({ entry: "entry-1" });
    if (!first.ok) {
      throw first.error;
    }
    expect(first.value.text).toContain("One: alpha");
    expect(first.value.text).not.toContain("Two: beta");
    expect(first.value.status).toBe("completed");

    const back = yield* requested.entryOutput({ entry: -1 });
    if (!back.ok) {
      throw back.error;
    }
    expect(back.value.entry).toBe("entry-2");
    expect(back.value.text).toContain("Two: beta");

    // An entry nobody can name refuses this operation and substitutes no
    // neighbour. The response is not over: a reply may ask about another.
    const missing = yield* requested.entryOutput({ entry: "entry-9" });
    expect(missing.ok).toBe(false);
    expect(missing.ok ? "" : missing.error.message).toContain('no entry "entry-9"');
  });

  it("R3: the vocabulary a reply is told about is the entry's, not its own", function* () {
    const session = yield* opened("vocabulary", new InMemoryStream());
    const requested = sidekickRequests(reading(session), noSubmission);

    const symbols = yield* requested.entrySyntax();
    if (!symbols.ok) {
      throw symbols.error;
    }
    // `<Each>` and `<File>` are both ordinary in an entry and in no response
    // ceiling — which is why the two vocabularies are described separately, and
    // why this read exists at all.
    expect(symbols.value).toContain("Each");
    expect(symbols.value).toContain("File");
    const asked = fresh();
    const admits = responseSurface(ceilingFor(asked)).map((entry) => entry.name);
    expect(admits).not.toContain("Each");
    expect(admits).not.toContain("File");
    // `<Elicit>` is the one name both hold, and holding it twice is not one
    // permission: a reply writes the canonical question under the response
    // ceiling, and an entry writes the same component under its own.
    expect(symbols.value).toContain("Elicit");
    expect(admits).toContain("Elicit");

    // The named lookup is Syntax semantics over the same catalog, so a reply
    // that has learned one spelling has learned both. A component's long-form
    // documentation is what comes back, for a component this profile has.
    const documented = yield* requested.entrySyntax(["Elicit"]);
    if (!documented.ok) {
      throw documented.error;
    }
    expect(documented.value).toContain("`<Elicit>`");
    expect(documented.value).toContain("Ask a person a structured question");

    // A name this profile has no words for refuses the operation and renders
    // the reason where the reply asked for it.
    const unknown = yield* requested.entrySyntax(["NotAComponent"]);
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.error.message).toContain("NotAComponent");
  });

  it("R3: the environment states what this host knows and what it does not", function* () {
    // A host that states a fact it cannot determine, which is the case the read
    // exists to report honestly: the label is present and the value is not, and
    // nothing fills it in.
    yield* ReplHost.around(
      {
        // deno-lint-ignore require-yield
        *environment(): Operation<readonly ReplHostFact[]> {
          return Object.freeze([
            Object.freeze({ label: "runtime", value: "deno 9.9.9 from source" }),
            Object.freeze({ label: "release target", value: undefined }),
          ]);
        },
      },
      { at: "min" },
    );
    const session = yield* opened("environment", new InMemoryStream());
    const answer = yield* sidekickRequests(reading(session), noSubmission).environment();
    if (!answer.ok) {
      throw answer.error;
    }

    // Contextual, at the ask: the working directory and the platform are read
    // through the host APIs rather than carried from startup.
    const machine = yield* platform();
    expect(answer.value).toContain(`- working directory: ${yield* cwd()}`);
    expect(answer.value).toContain(`- platform: ${machine.os} ${machine.arch}`);
    // Stated by the host, in the order it stated them.
    expect(answer.value).toContain("- runtime: deno 9.9.9 from source");
    expect(answer.value).toContain("- release target: not known to this host");
    // And this command's own, last. An empty Plugin selection is reported as
    // what it is: a command that installed none has said something about what
    // an entry may write, and an omitted line would be indistinguishable from a
    // host that could not tell.
    expect(answer.value).toContain("- component includes: components, .");
    expect(answer.value).toContain("- active plugins: none");
    expect(answer.value).toContain("- agent permission requests: deny-all");
    // The rule is in the snapshot, because the snapshot is what comes back as
    // feedback whether or not the chapter was read.
    expect(answer.value).toContain("stop rather than assume a value for it");
  });

  it("R3: the Plugins this command installed are reported, by name and in order", function* () {
    // The production path: a real Plugin installation, and the real profile
    // assembler reading the admitted assembly. Nothing restates the selection.
    const plugins = yield* installPlugins([{ name: "ReadingPlugin" }], {
      command: "repl",
      args: [],
    });
    const profile = yield* assembleReplProfile(
      { provider: "acpx", defaultAgent: AGENT, adapters: ADAPTERS, permissionMode: "deny-all" },
      plugins,
    );
    // Names only. What the Plugin contributes travels on `installations` and
    // `declarations`, and neither is reachable through the read surface.
    expect(profile.plugins).toEqual(["ReadingPlugin"]);

    yield* ReplHost.around(
      {
        // deno-lint-ignore require-yield
        *environment(): Operation<readonly ReplHostFact[]> {
          return Object.freeze([Object.freeze({ label: "runtime", value: "a controlled host" })]);
        },
      },
      { at: "min" },
    );
    const session = yield* opened("plugins", new InMemoryStream());
    const answer = yield* sidekickRequests(
      {
        ...rootReads(session, profile),
        // deno-lint-ignore require-yield
        *fill(): Operation<Result<void>> {
          throw new Error("a read filled the shared draft");
        },
      },
      noSubmission,
    ).environment();
    if (!answer.ok) {
      throw answer.error;
    }
    expect(answer.value).toContain("- active plugins: ReadingPlugin");
    // The control the selection sits beside, so a row that passed by reporting
    // something else entirely would still be caught.
    expect(answer.value).toContain("- component includes: components, .");
    expect(answer.value).toContain("- agent permission requests: deny-all");
    expect(answer.value).toContain("- runtime: a controlled host");
  });

  it("R3: a host that cannot describe itself refuses the read", function* () {
    const session = yield* opened("undescribed", new InMemoryStream());
    // No host description installed. The snapshot is refused rather than
    // returned with a hole in it: a reply is told it may rely on what this read
    // reports, so a partial snapshot would be the one unsafe answer.
    const answer = yield* sidekickRequests(reading(session), noSubmission).environment();
    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.error.message).toContain("none of them are reported");
  });

  it("R3: a fill replaces the draft, takes nothing over, and starts nothing", function* () {
    const session = yield* opened("filling", new InMemoryStream());

    // The root's own end of the one write a read class does not hold: the
    // decision from the gate, the transition from the reduction.
    let state = initialState("filling");
    const applied: string[] = [];
    const requested = sidekickRequests(
      {
        ...rootReads(session, PROFILE),
        // deno-lint-ignore require-yield
        *fill(source: string): Operation<Result<void>> {
          const allowed = fillable(state);
          if (!allowed.ok) {
            return allowed;
          }
          state = filled(state, source);
          applied.push(source);
          return Ok(undefined);
        },
      },
      noSubmission,
    );

    const filling = yield* requested.fillDraft("One: {token}\n");
    expect(filling.ok).toBe(true);
    expect(state.draft).toBe("One: {token}\n");
    // A Sidekick fill raises the revision — so a submission prepared against
    // the old one is caught — and takes nothing over, because the person has
    // not typed anything.
    expect(state.revisions.draft).toBeGreaterThan(initialRevisions().draft);
    expect(state.takenOver).toBe(false);
    // And it started nothing. The history is where it was: one write that
    // admitted an entry would have been an entry nobody asked for.
    expect(session.model.entries).toHaveLength(0);
    expect(session.live).toBe(false);
    expect(applied).toEqual(["One: {token}\n"]);

    // Taken over, and the same request refuses rather than overwriting what
    // somebody is in the middle of typing.
    state = Object.freeze({ ...state, takenOver: true });
    const refused = yield* requested.fillDraft("something else\n");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.message).toContain("taken the shared draft over");
    expect(state.draft).toBe("One: {token}\n");
    expect(applied).toHaveLength(1);
  });
});

/**
 * Tier R3 — IN6: two captures, and what cannot reach across them.
 *
 * The integration moved control construction from per-response definitions to
 * definitions installed and sealed once per conversation. Two things follow that
 * nothing else in this suite observes, and they are the rows below.
 *
 * **Two owners are two captures.** Each conversation's controls close over the
 * request handle its own root answers, so a reply in one conversation cannot
 * reach the other one's. With setup-time capture that is a property of *where
 * the definition was sealed* rather than of what was passed with a call, which
 * is why it needs saying here.
 *
 * **What is sealed is sealed.** A definition answer or a wider selection
 * composed after setup reaches a response not at all: canonical capture
 * resolved each selected name before the conversation's root import and an
 * admitted control runs that snapshot. An interception may well refuse under
 * Core's own contract — what it must never do is run.
 */
describe("Tier R3 — two captures, and what cannot reach across them", () => {
  beforeAll(() => useTempFileCompiler());

  it("R3m: two owners' controls answer their own request handles", function* () {
    const one = fresh();
    const other = fresh();

    // Two executions, each capturing its own ceiling over its own stub. The
    // same source in both, so what tells the two apart is the handle each
    // control closed over and nothing about the reply.
    const first = yield* reply("<Output>\n<REPL.Bindings />\n</Output>\n", one);
    const second = yield* reply("<Output>\n<REPL.Bindings />\n</Output>\n", other);

    expect(rendered(first)).toContain("Ada");
    expect(rendered(second)).toContain("Ada");
    // Each owner was asked once, by its own reply. A control that had closed
    // over a shared handle would show both reads against one of them.
    expect(one.requests).toEqual(["bindings"]);
    expect(other.requests).toEqual(["bindings"]);
    expect(one.began).toHaveLength(1);
    expect(other.began).toHaveLength(1);
  });

  it("R3n: a definition answered after setup reaches no response, and runs nothing", function* () {
    const asked = fresh();
    const reached: string[] = [];
    const invoked: string[] = [];

    // The interception is installed inside `Execution.document`, which is the
    // scope the evaluation runner is attached in, and it answers `REPL.Bindings`
    // with a definition of its own. The capture already sealed that name.
    const answer = yield* replyWith("<Output>\n<REPL.Bindings />\n</Output>\n", asked, [
      intercepting("REPL.Bindings", reached, invoked),
    ]);

    // The interception is genuinely in the document's own chain — it was asked
    // for the root and for the holding element — and it was never asked for the
    // control's name at all. A generated admission resolves an admitted name
    // from the definition the capture sealed and does not consult the
    // document's chain for it, so there is no point at which a later answer
    // could substitute.
    expect(reached).toContain("SidekickHost");
    expect(reached).not.toContain("REPL.Bindings");
    expect(invoked).toEqual([]);

    // And the response ran, from the sealed snapshot, against this owner's own
    // handle: the row is about what the interception could not do rather than
    // about the reply failing.
    expect(rendered(answer)).toContain("Ada");
    expect(asked.requests).toEqual(["bindings"]);
  });

  it("R3o: a selection composed after setup widens nothing", function* () {
    const asked = fresh();
    const reached: string[] = [];
    const invoked: string[] = [];

    // The same installation also composes a *later* selection naming `File` —
    // an ordinary component an entry may be given and this ceiling omits. A
    // reply writing it is refused by the sealed table, and the refusal arrives
    // before any control runs.
    const answer = yield* replyWith('<Output>\n<File path="notes.md" />\n</Output>\n', asked, [
      intercepting("File", reached, invoked),
    ]);

    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.error.message).toContain("did not admit");
    expect(invoked).toEqual([]);
    expect(asked.requests).toEqual([]);
    expect(asked.began).toEqual([]);
  });

  it("R3p: control — with nothing intercepting, the same reply answers its own handle", function* () {
    const asked = fresh();

    // The control for R3n and R3o: the same source, the same ceiling, no
    // interception — so a row above refusing or performing nothing is about the
    // interception rather than about the arrangement.
    const answer = yield* replyWith("<Output>\n<REPL.Bindings />\n</Output>\n", asked, []);

    expect(rendered(answer)).toContain("Ada");
    expect(asked.requests).toEqual(["bindings"]);
  });
});
