/**
 * The packaged plan command document, executed as itself.
 *
 * This runs the exact Markdown the CLI ships — read through the packaged
 * loader, not copied into a fixture — so what it proves is what a release does.
 * The seams around it are deterministic: a scriptable ACP runtime for the one
 * Agent turn, a scripted Elicitation answer for the review, and a test-only
 * validator in the place the Plan writer profile declares the production one.
 *
 * The include list is empty on purpose. Repository component search must not be
 * able to supply `Loop`, `If`, `Return`, `Fail`, `CodeBlock` or the validator:
 * the workflow under test is the one the packaged Component owns, resolved against
 * first-party declarations only.
 *
 * Tier PO's authored half lives here — the phases an operator reads, in the
 * order the work happens, with the counters the document's own bounds produce.
 * Progress is drained from `execution.output` exactly as the command drains it,
 * so what a row observes is the channel a person actually watches rather than a
 * transcript assembled afterwards.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { ensureDir, rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentIdentityComponents,
  installAgentComponents,
  retainedSource,
  useNormalizedOutput,
} from "@executablemd/core";
import type {
  DocumentValidation,
  ElicitationRequest,
  Json,
  SyntaxSymbols,
} from "@executablemd/core";
import {
  executeInstalled,
  fileReadEntry,
  globReadEntry,
  syntaxReadEntry,
} from "@executablemd/core/host";
import type {
  ComponentAnswerInstallation,
  FragmentEntry,
  FragmentEvaluationInput,
} from "@executablemd/core/host";
import { ordinaryEvaluationProfile } from "../src/evaluation-profile.ts";
import { recordedFiles } from "../../core/tests/support/fragment-files.ts";
import { answerProvider } from "../../core/tests/support/answer-provider.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { PLAN_COMMAND_DOCUMENT, readPackagedDocument } from "../src/packaged-document.ts";
import { PLAN_COMMAND_IDENTITY } from "../src/plan-writer-profile.ts";
import type { PlanSurface } from "../src/plan-component.ts";
import {
  AGENT,
  CASE_CATALOG,
  planDeclarationHarness,
  useWorkingDirectory,
} from "./support/plan-harness.ts";
import type { ScriptedReview } from "./support/plan-harness.ts";
import type { ScriptedTurn } from "./support/fake-acp.ts";

/**
 * A candidate whose exact bytes are worth preserving.
 *
 * Leading and trailing blank lines, interior indentation, and a five-backtick
 * run: enough that trimming, re-fencing, or reconstructing it through the
 * presentation would all be visible in the assertion.
 *
 * A text Plan rather than a value one, because the leading blank line is the
 * point: frontmatter is only frontmatter when it is the first thing in the
 * file, so a candidate that opens with a blank line and then declares `returns`
 * declares nothing and its `<Return>` has no schema to satisfy. The structural
 * admission inside the Component says so now, where the command's own gate used to
 * be the first thing to see these bytes.
 */
const CANDIDATE = [
  "",
  "# A greeting",
  "",
  "This document explains itself before it does anything.",
  "",
  "`````markdown",
  "  <Return value={`nested fence`} />",
  "`````",
  "",
  "That fence is shown, not run.",
  "",
].join("\n");

/** The answer a case that is not about validation wants: this is a program. */
// deno-lint-ignore require-yield
function* sound(): Operation<DocumentValidation> {
  return { version: 1, outcome: "valid", diagnostics: [], invocations: [] };
}

/** One structural refusal, with a diagnostic a verbose row can look for. */
// deno-lint-ignore require-yield
function* unsound(): Operation<DocumentValidation> {
  return {
    version: 1,
    outcome: "invalid",
    diagnostics: [{ code: "component-unresolved", message: "no component answers <NoSuch>" }],
    invocations: [],
  };
}

/** What the command document asked the structural check about, in order. */
interface CommandRun {
  validated: string[];
  reviews: ElicitationRequest[];
  prompts: string[];
  /** Every progress chunk the drain received, in arrival order. */
  progress: string[];
  /** When the catalog was built, as a marker in {@link phases} order. */
  events: string[];
  value: Json | undefined;
  failure: string | undefined;
}

interface RunOptions {
  /** The turns the agent answers with, in order. One approved draft by default. */
  turns?: readonly ScriptedTurn[];
  /** The review answers, in order. One Approve by default. */
  reviews?: readonly ScriptedReview[];
  /** Whether this command asked for drafts and check diagnostics. */
  verbose?: boolean;
  /** Which surface declares `<Plan>`. The command surface by default. */
  surface?: PlanSurface;
  /** How each candidate is answered, in order; the last answer repeats. */
  validations?: readonly (() => Operation<DocumentValidation>)[];
  /** Run beside the execution, with the progress this drain has so far. */
  observe?(run: { progress: string[]; events: string[]; prompts: string[] }): Operation<void>;
  /**
   * Providers backing this case's `component-answer` entries.
   *
   * Only a row that admits a name core supplies no body for needs one: the
   * profile arm has nowhere to put an implementation, so a provider has to
   * claim it during resolution.
   */
  componentAnswers?: readonly ComponentAnswerInstallation[];
  /**
   * The evaluation ceiling this case's information requests run under.
   *
   * The command's own by default. A case supplies its own when it needs to see
   * which operation a read reached, or to withhold one.
   */
  evaluation?: FragmentEvaluationInput;
  /**
   * The vocabulary this execution describes.
   *
   * {@link CASE_CATALOG} by default, whose single entry is the marker the
   * prompt assertions look for. A case naming components in a `<Syntax>`
   * request states its own, so what a selection did and did not return is
   * decided by entries the case wrote rather than by whichever names the shared
   * catalog happens to carry.
   */
  symbols?: SyntaxSymbols;
}

function* runDocument(options: RunOptions = {}): Operation<CommandRun> {
  const source = yield* readPackagedDocument(PLAN_COMMAND_DOCUMENT);

  let value: Json | undefined;
  let failure: string | undefined;
  const progress: string[] = [];
  const events: string[] = [];
  const validations = [...(options.validations ?? [sound])];

  const harness = yield* scoped(function* () {
    return yield* planDeclarationHarness({
      surface: options.surface ?? "command",
      planWriterRoot: yield* planWriterRoot(),
      session: SESSION,
      explicitSession: true,
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      // The catalog is stated at the execution boundary now, so this records
      // *when* the public `<Syntax />` occurrence observed it — which is what an
      // ordering case about the authored Preparing phase is asking.
      // deno-lint-ignore require-yield
      *symbols(): Operation<SyntaxSymbols> {
        events.push("catalog");
        return options.symbols ?? CASE_CATALOG;
      },
      *validate(): Operation<DocumentValidation> {
        const answer = validations.length > 1 ? validations.shift() : validations[0];
        return yield* (answer ?? sound)();
      },
    });
  });
  for (const turn of options.turns ?? [{ reply: CANDIDATE }]) {
    harness.fake.script(turn);
  }
  for (const review of options.reviews ?? [{ decision: "Approve" }]) {
    harness.script(review);
  }

  yield* scoped(function* () {
    // The agent words and this execution's prompt bookkeeping, as the command
    // installs them. No root provider: the ceiling the Plan is written under is
    // the one the Component installs around its own content.
    yield* installAgentComponents({ defaultAgent: AGENT, permissionMode: "deny-all" });
    // Exactly what the command installs around this execution. A raw capture
    // would show an operator whitespace nobody wrote.
    yield* useNormalizedOutput();
    try {
      const execution = yield* executeInstalled(
        {
          ...retainedSource(PLAN_COMMAND_IDENTITY, source),
          stream: new InMemoryStream(),
          includes: [],
          secretDetection: true,
          props: {
            request: REQUEST,
            session: SESSION,
          },
        },
        [
          {
            components: agentIdentityComponents(),
            declarations: [harness.declaration],
            symbols: harness.symbols,
            // The ceiling the command installs, so an information request this
            // document evaluates reads through exactly what `xmd run` states.
            // A case that supplies its own recorder gets that instead, which is
            // how a row proves which operation a read actually reached.
            evaluation: options.evaluation ?? ordinaryEvaluationProfile(),
            ...(options.componentAnswers === undefined
              ? {}
              : { componentAnswers: [...options.componentAnswers] }),
          },
        ],
      );
      if (options.observe !== undefined) {
        yield* spawn(() => options.observe!({ progress, events, prompts: harness.fake.prompts }));
      }
      // deno-lint-ignore require-yield
      yield* forEach(function* (chunk: string) {
        progress.push(chunk);
        events.push(chunk);
      }, execution.output);
      const completed = yield* execution;
      if (completed.ok) {
        value = completed.value;
      } else {
        failure = completed.error.message;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  });

  return {
    validated: harness.checked,
    reviews: harness.reviews,
    prompts: harness.fake.prompts,
    progress,
    events,
    value,
    failure,
  };
}

/** The request the adapter projects into `<Plan>`, and the session it names. */
const REQUEST = "ask me for my age and write the result to a file";
const SESSION = "plan-command-regression";

/** A profile root this file owns, removed when the case's scope ends. */
function* planWriterRoot(): Operation<string> {
  const root = join(tmpdir(), `xmd-plan-command-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The phase headings an operator read, in the order they arrived. */
function phases(chunks: readonly string[]): string[] {
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
}

/** The same, over a mixed marker/chunk sequence, with the markers kept. */
function timeline(events: readonly string[]): string[] {
  return events.flatMap((event) =>
    event === "catalog" ? ["catalog"] : phases([event]).map((phase) => `phase: ${phase}`),
  );
}

/** Everything the transcript said that no progress phase put there. */
function unattributed(chunks: readonly string[]): string[] {
  const lines = chunks.join("").split("\n");
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      inside = true;
      continue;
    }
    if (!inside && line.trim().length > 0) {
      kept.push(line);
    }
  }
  return kept;
}

describe("the packaged plan command document", () => {
  it("C2: returns the approved candidate's exact bytes and never reaches exhaustion", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument();
    });

    // The root this document ran under is the internal one the host declares:
    // no path selects it, and a position naming it says the source is the
    // CLI's own.
    expect(PLAN_COMMAND_IDENTITY).toBe("<plan-command>");

    // Approving the first valid candidate is one turn and one question. A
    // repair or revision turn here would mean the loops ran when they had
    // nothing to fix.
    expect(run.prompts).toHaveLength(1);
    expect(run.reviews).toHaveLength(1);

    // Both gates inside the Component saw the Agent's complete close value,
    // unaltered: the draft check while the conversation was still standing, and
    // the admission after the whole Plan writer frame had gone. They are the same
    // question asked twice, of the same exact bytes.
    expect(run.validated).toEqual([CANDIDATE, CANDIDATE]);

    // The document settled with a value rather than an authored failure. Before
    // the control-flow correction this was the ten-draft exhaustion message: a
    // `<Return>` selects a value but does not end the body, so the unconditional
    // `<Fail>` after the Session ran and won over every approval.
    expect(run.failure).toBe(undefined);
    expect(run.value).toBe(CANDIDATE);
  });

  /**
   * The review this document asks has to be servable as a browser form, which
   * is how `xmd plan` asks it: `installWebElicitation` compiles the request's
   * schema before a port exists.
   *
   * Compiling for the browser extracts each conditional branch and compiles it
   * as a schema of its own, so a branch that reached `required` through its
   * parent's type is refused there while the server accepts it
   * (`packages/web/tests/compile.test.ts`, and specs/web-form-spec.md
   * §The preflight boundary). Until both branches said `object`, a real
   * `xmd plan` completed its turn and then ended at the review with
   * `<WebForm> schema could not be compiled for the browser`.
   */
  it("C9: every conditional branch of the review schema declares its own type", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument();
    });

    const schema = Object(run.reviews[0]?.schema);
    expect(Reflect.get(Object(Reflect.get(schema, "if")), "type")).toBe("object");
    expect(Reflect.get(Object(Reflect.get(schema, "then")), "type")).toBe("object");
  });

  it("PO1: every phase precedes the work it announces, and arrives while it runs", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument();
    });

    // Each phase stands before the operation it describes. `catalog` is the
    // marker the harness records where `<PlanInputs>` builds the vocabulary, so
    // Preparing being ahead of it is the whole claim: before this was moved
    // behind `<PlanInputs>`, no authored phase could precede that work at all.
    expect(timeline(run.events)).toEqual([
      "phase: Preparing the Plan",
      "catalog",
      "phase: Drafting the Plan",
      "phase: Checking the draft",
      "phase: Waiting for your review",
      "phase: Finalizing the Plan",
    ]);

    // And the adapter contributed nothing of its own: every non-blank line in
    // the transcript belongs to a phase this document authored.
    expect(unattributed(run.progress)).toEqual([]);
  });

  it("PO1: an early phase reaches the operator while the turn is still blocked", function* () {
    // The negative control for buffering. A turn that never settles holds the
    // execution open forever, so anything already delivered was delivered
    // *during* the work rather than summarized after it. A command that
    // buffered its transcript would have delivered nothing here.
    const seen: string[][] = [];
    yield* useWorkingDirectory(function* () {
      yield* scoped(function* () {
        const running = yield* spawn(() =>
          runDocument({
            turns: [{ reply: CANDIDATE, manual: true }],
            reviews: [],
            observe: function* (live) {
              // Nothing here waits on the execution: it watches the same array
              // the drain appends to, and settles as soon as the blocked turn's
              // own phase has arrived.
              while (!phases(live.progress).includes("Drafting the Plan")) {
                yield* sleep(1);
              }
              seen.push(phases(live.progress));
            },
          }),
        );
        // The turn is in flight and will never finish on its own.
        yield* untilObserved(seen);
        yield* running.halt();
      });
    });

    // Preparing and Drafting had both reached the operator, and no phase that
    // depends on the turn finishing had.
    expect(seen[0]).toEqual(["Preparing the Plan", "Drafting the Plan"]);
  });

  it("PO2: repair and attempt counters come from the document's own bounds", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument({
        // One invalid attempt, its three repairs, then a requested change whose
        // replacement passes.
        turns: [
          { reply: "# Broken\n\n<NoSuchComponent />\n" },
          { reply: "# Broken\n\n<NoSuchComponent />\n" },
          { reply: "# Broken\n\n<NoSuchComponent />\n" },
          { reply: "# Broken\n\n<NoSuchComponent />\n" },
          { reply: CANDIDATE },
        ],
        reviews: [{ decision: "Request changes", feedback: "try again" }, { decision: "Approve" }],
        // Four refusals — the base draft and its three repairs — then sound.
        validations: [unsound, unsound, unsound, unsound, sound],
      });
    });

    expect(run.failure).toBe(undefined);
    expect(run.value).toBe(CANDIDATE);

    // A check before every result, a repair between each pair, and the review
    // only once the repair budget is spent.
    expect(phases(run.progress)).toEqual([
      "Preparing the Plan",
      "Drafting the Plan",
      "Checking the draft",
      "Repairing the draft",
      "Checking the draft",
      "Repairing the draft",
      "Checking the draft",
      "Repairing the draft",
      "Checking the draft",
      "Waiting for your review",
      "Revising the Plan",
      "Checking the draft",
      "Waiting for your review",
      "Finalizing the Plan",
    ]);

    const transcript = run.progress.join("");
    // The repair ordinals are the loop's own counter rendered as words, and
    // they stop at the bound rather than at a number written beside it.
    expect(transcript).toContain(
      "This is the 1st of up to 3 repairs for the current Plan attempt.",
    );
    expect(transcript).toContain(
      "This is the 2nd of up to 3 repairs for the current Plan attempt.",
    );
    expect(transcript).toContain(
      "This is the 3rd of up to 3 repairs for the current Plan attempt.",
    );
    expect(transcript).not.toContain("4th of up to 3");
    // Requesting changes announces the next attempt, not another first one.
    expect(transcript).toContain("This is the 1st of up to 10 attempts.");
    expect(transcript).toContain("This is the 2nd of up to 10 attempts.");
    expect(transcript).not.toContain("3rd of up to 10 attempts");
  });

  it("PO2: the attempt counter reaches the tenth and stops there", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument({
        turns: Array.from({ length: 10 }, () => ({ reply: CANDIDATE })),
        reviews: [
          ...Array.from(
            { length: 9 },
            (_unused, round): ScriptedReview => ({
              decision: "Request changes",
              feedback: `round ${round + 1}`,
            }),
          ),
          { decision: "Stop" },
        ],
      });
    });

    const transcript = run.progress.join("");
    for (const ordinal of ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"]) {
      expect(
        `${ordinal}: ${transcript.includes(`This is the ${ordinal} of up to 10 attempts.`)}`,
      ).toBe(`${ordinal}: true`);
    }
    // Ten presentations is the bound: an eleventh attempt would mean the loop
    // and the sentence disagreed about what the bound is.
    expect(transcript).not.toContain("11th");
    expect(run.reviews).toHaveLength(10);
  });

  it("PO3: Stop announces itself before teardown and keeps its exact diagnostic", function* () {
    /** The transcript as it stood when the Plan writer frame began to close. */
    const atTeardown: string[] = [];

    const run = yield* useWorkingDirectory(function* () {
      const source = yield* readPackagedDocument(PLAN_COMMAND_DOCUMENT);
      const progress: string[] = [];
      let failure: string | undefined;

      const harness = yield* scoped(function* () {
        return yield* planDeclarationHarness({
          surface: "command",
          planWriterRoot: yield* planWriterRoot(),
          session: SESSION,
          explicitSession: true,
        });
      });
      harness.fake.script({ reply: CANDIDATE });
      harness.script({ decision: "Stop" });

      // Registered inside the frame's own scope, so it runs as that frame is
      // taken down — which is what tells a phase written before teardown from
      // one written after it.
      const installed = harness.declaration;
      yield* scoped(function* () {
        yield* installAgentComponents({ defaultAgent: AGENT, permissionMode: "deny-all" });
        yield* useNormalizedOutput();
        const execution = yield* executeInstalled(
          {
            ...retainedSource(PLAN_COMMAND_IDENTITY, source),
            stream: new InMemoryStream(),
            includes: [],
            secretDetection: true,
            props: { request: REQUEST, session: SESSION },
          },
          [
            {
              components: agentIdentityComponents(),
              declarations: [installed],
              symbols: harness.symbols,
            },
          ],
        );
        // deno-lint-ignore require-yield
        yield* forEach(function* (chunk: string) {
          progress.push(chunk);
        }, execution.output);
        const completed = yield* execution;
        if (!completed.ok) {
          failure = completed.error.message;
        }
      });
      atTeardown.push(...progress);
      return { progress, failure };
    });

    expect(phases(run.progress)).toEqual([
      "Preparing the Plan",
      "Drafting the Plan",
      "Checking the draft",
      "Waiting for your review",
      "Stopping planning",
    ]);
    expect(run.progress.join("")).toContain(
      "Closing the planning session without producing a Plan.",
    );
    // The ending itself is unchanged, and it is a diagnostic rather than a
    // phase: nothing on the progress channel claims it.
    expect(run.failure).toBe("xmd plan stopped at your request. Nothing was output.");
    expect(run.progress.join("")).not.toContain("Nothing was output");
  });

  it("PO3: exhaustion announces itself, explains once, and asks nobody anything", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument({
        turns: [
          // Ten attempts of four drafts each, then the automatic explanation.
          ...Array.from({ length: 40 }, () => ({ reply: "# Broken\n\n<NoSuchComponent />\n" })),
          { reply: "Every draft named a component nothing offers." },
        ],
        reviews: Array.from(
          { length: 9 },
          (_unused, round): ScriptedReview => ({
            decision: "Request changes",
            feedback: `round ${round + 1}`,
          }),
        ),
        validations: [unsound],
      });
    });

    const rendered = phases(run.progress);
    // The tenth attempt opens no review: nine were asked, and the phase that
    // follows the last check says why there is no tenth question.
    expect(run.reviews).toHaveLength(9);
    expect(rendered.filter((phase) => phase === "Waiting for your review")).toHaveLength(9);
    expect(rendered.at(-1)).toBe("Could not generate a Plan");
    expect(run.progress.join("")).toContain(
      "The draft still has problems after 10 attempts. The coding agent is reviewing why " +
        "planning was unsuccessful and how to improve the outcome of a future attempt.",
    );

    // #722's ending is unchanged, and no source came back.
    expect(run.value).toBe(undefined);
    expect(run.failure).toBe(
      "xmd plan could not generate an approved Plan after 10 attempts.\n\n" +
        "The coding agent explained why planning was unsuccessful and how to improve the " +
        "outcome:\n\nEvery draft named a component nothing offers.\n\nNothing was output.",
    );
  });

  it("PO5: default progress discloses nothing, and verbose adds exactly two blocks", function* () {
    const invalid = "# Broken\n\n<NoSuchComponent />\n";
    const scenario: RunOptions = {
      turns: [{ reply: invalid }, { reply: CANDIDATE }],
      reviews: [{ decision: "Approve" }],
      validations: [unsound, sound],
    };

    const quiet = yield* useWorkingDirectory(function* () {
      return yield* runDocument(scenario);
    });
    const loud = yield* useWorkingDirectory(function* () {
      return yield* runDocument({ ...scenario, verbose: true });
    });

    // Neither run is about failure: both approved the repaired draft.
    expect(quiet.value).toBe(CANDIDATE);
    expect(loud.value).toBe(CANDIDATE);

    // Default progress holds none of the request, the drafts, the structured
    // diagnostics or the approved source.
    const quietText = quiet.progress.join("");
    for (const secret of [REQUEST, invalid, CANDIDATE.trim(), "component-unresolved"]) {
      expect(`quiet: ${quietText.includes(secret)}`).toBe("quiet: false");
    }
    expect(phases(quiet.progress)).toEqual([
      "Preparing the Plan",
      "Drafting the Plan",
      "Checking the draft",
      "Repairing the draft",
      "Checking the draft",
      "Waiting for your review",
      "Finalizing the Plan",
    ]);

    // Verbose adds every cleared draft and each invalid check's structured
    // JSON, in phase order, and nothing else.
    expect(phases(loud.progress)).toEqual([
      "Preparing the Plan",
      "Drafting the Plan",
      "Generated draft",
      "Checking the draft",
      "Problems found in the draft",
      "Repairing the draft",
      "Generated draft",
      "Checking the draft",
      "Waiting for your review",
      "Finalizing the Plan",
    ]);
    const loudText = loud.progress.join("");
    expect(loudText).toContain(invalid);
    expect(loudText).toContain(CANDIDATE.trim());
    expect(loudText).toContain('"code": "component-unresolved"');
    // The second check passed, so exactly one problems block exists.
    expect(
      phases(loud.progress).filter((phase) => phase === "Problems found in the draft"),
    ).toHaveLength(1);
    // The request is still nobody's business: verbose adds drafts and
    // diagnostics, not the Prompt or the review answer.
    expect(loudText).not.toContain(REQUEST);
  });

  it("PO15: the packaged adapter builds the catalog once, and says nothing itself", function* () {
    const run = yield* useWorkingDirectory(function* () {
      return yield* runDocument();
    });

    expect(run.events.filter((event) => event === "catalog")).toHaveLength(1);
    // The adapter's own body is projection and return. Its former explanatory
    // prose would arrive here the moment the transcript is drained.
    const source = yield* readPackagedDocument(PLAN_COMMAND_DOCUMENT);
    const body = source.slice(source.lastIndexOf("---\n") + 4);
    expect(
      body
        .trim()
        .split("\n")
        .filter((line) => !line.startsWith("<")),
    ).toEqual([]);
    expect(unattributed(run.progress)).toEqual([]);
  });
});

/**
 * Tier PI — read-only information requests, through the packaged document.
 *
 * The workflow under test is the shipped `Plan.md`: a scripted agent answers a
 * Plan-producing turn with a read-only XMD program, the document evaluates it
 * under the command's own ceiling, and the findings come back as the next
 * turn's context.
 *
 * The recorder is not a Files provider, so a read that appears in its log went
 * through the captured operation — there is no other way to reach it.
 */
describe("Tier PI — read-only information requests", () => {
  /** One request that binds all three reads and renders a chosen object. */
  const COMPOSED = [
    '<Glob include={["notes.md"]} as="paths" />',
    '<File path="notes.md" as="note" />',
    '<Syntax names={["File"]} as="documented" />',
    "<Json value={{ paths, note, documented }} />",
    "",
  ].join("\n");

  /**
   * Three components to select from, so a selection can be told from a catalog.
   *
   * `<File>` carries both forms, which is what makes "reading about the paired
   * form is not permission to write" observable in what a selection returns.
   */
  const SELECTABLE: SyntaxSymbols = {
    version: 3,
    categories: [
      { kind: "structural", entries: [] },
      {
        kind: "built-in",
        entries: (["File", "Elicit", "Loop"] as const).map((name) => ({
          kind: "component" as const,
          name,
          origin: { kind: "registered" as const, origin: "@executablemd/core", reserved: false },
          sourceKind: "registered" as const,
          inspectability: "complete" as const,
          forms:
            name === "File"
              ? (["self-closing", "paired"] as const)
              : name === "Loop"
                ? (["paired"] as const)
                : (["self-closing"] as const),
          props: { type: "object" as const, properties: {}, additionalProperties: false },
          captures: [],
          returnMode: "text" as const,
          returns: { type: "string" as const },
        })),
      },
      { kind: "user-provided", entries: [] },
    ],
  };

  it("PI2, PI12: findings reach the next turn, and default progress says only how many", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const run = yield* runDocument({
      turns: [{ reply: COMPOSED }, { reply: CANDIDATE }],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
    });

    expect(run.failure).toBe(undefined);
    // The request was evaluated through the captured operations, in order.
    // `<Syntax>` is answered by core itself, so it leaves no mark here — which
    // is the point: there is no filesystem shortcut behind it.
    expect(files.performed).toEqual(["glob notes.md", "read notes.md"]);
    // And exactly what it rendered reached the following turn, as data. All
    // three bindings are in it, gathered by one `<Json>` the candidate chose
    // the shape of rather than by anything collecting observations for it.
    const followUp = run.prompts[1] ?? "";
    expect(followUp).toContain("the retained note");
    expect(followUp).toContain("notes.md");
    expect(followUp).toContain("Available in this evaluation");
    expect(followUp).toContain("They are context for writing the Plan");

    // Default progress announces the phase and the ordinal, and nothing about
    // what was asked for or what came back.
    const progress = run.progress.join("");
    expect(progress).toContain("Inspecting XMD information");
    expect(progress).toContain("Information request 1 of 8");
    expect(progress).not.toContain("the retained note");
    expect(progress).not.toContain("<Glob");
  });

  it("PI12: verbose adds the complete request and findings, after they settle", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const run = yield* runDocument({
      turns: [{ reply: COMPOSED }, { reply: CANDIDATE }],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
      verbose: true,
    });

    const progress = run.progress.join("");
    expect(progress).toContain("XMD information request");
    expect(progress).toContain("XMD information returned");
    expect(progress).toContain("the retained note");
    // The request is shown before its findings, and both after the phase that
    // announced them.
    expect(progress.indexOf("XMD information request")).toBeLessThan(
      progress.indexOf("XMD information returned"),
    );
  });

  it("PI10: a refused request is one safe retry, and names no host detail", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const run = yield* runDocument({
      // A paired `<File>` write under a read-only selection: refused whole,
      // before any read.
      turns: [{ reply: '<File path="notes.md">written</File>\n' }, { reply: CANDIDATE }],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
    });

    expect(run.failure).toBe(undefined);
    expect(files.performed).toEqual([]);
    const followUp = run.prompts[1] ?? "";
    expect(followUp).toContain("That request was refused");
    expect(followUp).toContain("self-closing form");
    expect(followUp).toContain("Correct the request");
  });

  it("PI7: successes and refusals share one budget, and the ninth is not evaluated", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n", "ninth.md": "unreached\n" });
    // Alternating: a request that succeeds, then one refused whole for writing.
    // Eight of them, so the budget is spent by two kinds of outcome rather than
    // by either alone.
    const turns = Array.from({ length: 8 }, (_, index) => ({
      reply:
        index % 2 === 0
          ? '<Glob include={["notes.md"]} as="paths" />\n<Json value={paths} />\n'
          : '<File path="notes.md">written</File>\n',
    }));
    const run = yield* runDocument({
      // The ninth would search a second time if it were evaluated, so the
      // recorder answers "was it?" rather than a count standing in for it.
      turns: [...turns, { reply: '<Glob include={["ninth.md"]} as="paths" />\n' }],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
    });

    expect(String(run.failure)).toContain("asked for information 8 times");
    // Four succeeded and four were refused, and both counted: a ninth request
    // exists precisely because eight were spent.
    expect(files.performed).toEqual(Array.from({ length: 4 }, () => "glob notes.md"));
    // The ninth candidate arrived and was not evaluated, and started no turn.
    expect(files.performed).not.toContain("glob ninth.md");
    // The initial drafting prompt, then one follow-up per answered request:
    // eight were answered, so nine prompts and no tenth.
    expect(run.prompts).toHaveLength(9);
    // The draft budget is untouched: no draft was ever checked, so no review
    // was ever opened.
    expect(run.reviews).toHaveLength(0);
    expect(run.validated).toEqual([]);
  });

  it("PI7: requests interleave with the initial, repair and revision turns", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const ask = { reply: '<Glob include={["notes.md"]} as="paths" />\n<Json value={paths} />\n' };
    const run = yield* runDocument({
      // One request at each of the three turns that can produce a Plan: the
      // initial draft, the repair, and the revision after a requested change.
      turns: [
        ask,
        { reply: "# Broken\n\n<NoSuchComponent />\n" },
        ask,
        { reply: CANDIDATE },
        ask,
        { reply: CANDIDATE },
      ],
      reviews: [{ decision: "Request changes", feedback: "say more" }, { decision: "Approve" }],
      validations: [unsound, sound],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
    });

    expect(run.failure).toBe(undefined);
    expect(run.value).toBe(CANDIDATE);
    // One search per site, so all three sites answered a request.
    expect(files.performed).toEqual(Array.from({ length: 3 }, () => "glob notes.md"));

    const transcript = run.progress.join("");
    // One count across all three sites, rather than a fresh eight at each.
    for (const ordinal of [1, 2, 3]) {
      expect(transcript).toContain(`Information request ${ordinal} of 8`);
    }
    expect(transcript).not.toContain("Information request 4 of 8");

    // And in both directions: the requests spent no draft attempt and no repair
    // attempt, and the two drafting budgets spent no request.
    expect(transcript).toContain("This is the 1st of up to 10 attempts.");
    expect(transcript).toContain("This is the 2nd of up to 10 attempts.");
    expect(transcript).not.toContain("3rd of up to 10 attempts");
    expect(transcript).toContain(
      "This is the 1st of up to 3 repairs for the current Plan attempt.",
    );
    expect(transcript).not.toContain("2nd of up to 3 repairs");
    // A request is announced where it happened, between the turn that asked it
    // and the one that answered — never in place of a draft phase.
    expect(phases(run.progress)).toEqual([
      "Preparing the Plan",
      "Drafting the Plan",
      "Inspecting XMD information",
      "Continuing the Plan",
      "Checking the draft",
      "Repairing the draft",
      "Inspecting XMD information",
      "Continuing the Plan",
      "Checking the draft",
      "Waiting for your review",
      "Revising the Plan",
      "Inspecting XMD information",
      "Continuing the Plan",
      "Checking the draft",
      "Waiting for your review",
      "Finalizing the Plan",
    ]);
    // Three drafts were checked and the approved one admitted — four, not the
    // seven a request that behaved like a draft would have produced.
    expect(run.validated).toHaveLength(4);
    expect(run.reviews).toHaveLength(2);
  });

  it("PI1: named documentation comes back, then an ordinary Plan", function* () {
    const run = yield* runDocument({
      // Two of the three names this case's vocabulary has, asked for together.
      // The third is the control: a selection that returned it would be a
      // catalog injection wearing a selection's clothes.
      turns: [{ reply: '<Syntax names={["File", "Elicit"]} />\n' }, { reply: CANDIDATE }],
      symbols: SELECTABLE,
    });

    expect(run.failure).toBe(undefined);
    const asked = run.prompts[0] ?? "";
    const followUp = run.prompts[1] ?? "";
    // Both selected entries' documentation came back — including the paired
    // form `<File>` also has, which reading about does not confer.
    expect(followUp).toContain("File");
    expect(followUp).toContain("Elicit");
    expect(followUp).toContain("paired");
    // And it is a *selection*: the unnamed third entry is not in it, though the
    // drafting prompt that carried the whole vocabulary did name it.
    expect(asked).toContain("Loop");
    expect(followUp).not.toContain("Loop");
    // The turn after the findings produced a draft that reached review.
    expect(run.reviews).toHaveLength(1);
  });

  it("PI10: an unknown documented name is one retry, not a stopped invocation", function* () {
    const run = yield* runDocument({
      turns: [{ reply: '<Syntax names={["NoSuchComponent"]} />\n' }, { reply: CANDIDATE }],
    });

    // Recoverable: the workflow asked again rather than ending, and the reason
    // quotes only the name the candidate itself wrote.
    expect(run.failure).toBe(undefined);
    const followUp = run.prompts[1] ?? "";
    expect(followUp).toContain("That request was refused");
    expect(followUp).toContain("NoSuchComponent");
    expect(run.reviews).toHaveLength(1);
  });

  it("PI2: an empty match renders as an empty array", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const run = yield* runDocument({
      turns: [
        { reply: '<Glob include={["absent.md"]} as="paths" />\n<Json value={paths} />\n' },
        { reply: CANDIDATE },
      ],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
    });

    expect(run.failure).toBe(undefined);
    // The search ran and found nothing, and nothing is a result rather than a
    // failure: the next turn is handed `[]`.
    expect(files.performed).toEqual(["glob absent.md"]);
    expect(run.prompts[1] ?? "").toContain("[]");
  });

  it("PI4: a prohibited operation anywhere in the request refuses before any read", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const run = yield* runDocument({
      // The admitted read is written first, and the prohibited write sits in
      // the branch the condition never takes. A refusal that happened
      // element-by-element would already have performed the read.
      turns: [
        {
          reply:
            '<File path="notes.md" as="note" />\n<If condition={note}>\n<Json value={note} />\n' +
            '<Else>\n<File path="notes.md">written</File>\n</Else>\n</If>\n',
        },
        { reply: CANDIDATE },
      ],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
    });

    expect(run.failure).toBe(undefined);
    expect(files.performed).toEqual([]);
    expect(files.entries.get("notes.md")).toBe("the retained note\n");
    expect(run.prompts[1] ?? "").toContain("That request was refused");
  });

  it("PI6, PI12: nothing is disclosed or asked until the request has settled", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const run = yield* runDocument({
      turns: [{ reply: COMPOSED }, { reply: CANDIDATE }],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
      verbose: true,
    });

    const progress = run.progress.join("");
    // Both reads completed before the findings were disclosed, and the
    // following turn came after that disclosure — never interleaved with it.
    expect(files.performed).toEqual(["glob notes.md", "read notes.md"]);
    const returned = progress.indexOf("XMD information returned");
    const continuing = progress.indexOf("Continuing the Plan");
    expect(returned).toBeGreaterThan(-1);
    expect(continuing).toBeGreaterThan(returned);
    // The phase announcing the request precedes the findings it announced.
    expect(progress.indexOf("Inspecting XMD information")).toBeLessThan(returned);
  });

  it("PI12: a secret in the findings ends the run before anything is disclosed", function* () {
    // A synthetic credential, built rather than written, so this file is not
    // itself something a scanner objects to.
    const canary = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
    const files = recordedFiles({ "notes.md": `The value is ${canary}.\n` });
    const run = yield* runDocument({
      turns: [
        { reply: '<File path="notes.md" as="note" />\n<Json value={note} />\n' },
        { reply: CANDIDATE },
      ],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
      verbose: true,
    });

    // Terminal, and the run's own ending rather than a retry.
    expect(String(run.failure)).toContain("secret detection rejected content");
    expect(String(run.failure)).not.toContain(canary);
    expect(run.value).toBe(undefined);

    // The text scanned was the whole of it: the read this request wrote had
    // run, so the check saw complete findings rather than a fragment still able
    // to produce more. This says nothing about teardown — a returned read is
    // not a settled projection, and the cleanup ordering is the barrier row's
    // claim and `CE22`'s, not this one's.
    expect(files.performed).toEqual(["read notes.md"]);

    // And nothing downstream of the check ran. The findings reached no
    // disclosure destination and started no turn: the phase announcing them was
    // never written, verbose printed nothing, and the second scripted reply was
    // never asked for.
    const progress = run.progress.join("");
    expect(progress).not.toContain(canary);
    expect(progress).not.toContain("XMD information returned");
    expect(run.prompts).toHaveLength(1);
    for (const prompt of run.prompts) {
      expect(prompt).not.toContain(canary);
    }
    expect(run.reviews).toEqual([]);
  });

  /**
   * PI6 — the disclosure waits for cleanup, not merely for the outcome.
   *
   * A recorder showing a read returned proves the read returned. It does not
   * prove the projection finished tearing down, and the frozen row is about
   * exactly that: findings are published and the next turn begins *after*
   * cleanup, not beside it. So this holds cleanup open and looks.
   *
   * The barrier is an admitted `component-answer` — the same arm canonical
   * protected `<Syntax />` is admitted through — so the protected route is
   * carrying it rather than a capability core supplies the body for. Its body
   * registers cleanup that blocks; while that block is held the case asserts
   * the two things that must not have happened yet, then releases and asserts
   * they did.
   *
   * This holds the successful settlement. The refusal path's ordering is
   * established elsewhere, and between them the two are covered — see the
   * refusal row below for where.
   */
  const HELD_ORIGIN = "test://held-provider";

  /** The admitted entry the barrier is written as. */
  function heldEntry(): FragmentEntry {
    return {
      kind: "component-answer",
      name: "Held",
      identity: { origin: HELD_ORIGIN, key: "Held", revision: "1" },
      forms: ["self-closing"],
    };
  }

  /** One barrier: a body whose cleanup blocks until the case releases it. */
  function barrier(): {
    entered: ReturnType<typeof withResolvers<void>>;
    release: ReturnType<typeof withResolvers<void>>;
    provider: ComponentAnswerInstallation;
  } {
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    return {
      entered,
      release,
      provider: answerProvider(
        "Held",
        {
          kind: "function",
          name: "Held",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn(): Operation<Json> {
            // Registered before anything can fail, so the barrier is reached
            // whichever way this projection ends.
            yield* ensure(function* () {
              entered.resolve();
              yield* release.operation;
            });
            return "held";
          },
        },
        { origin: HELD_ORIGIN, key: "Held", revision: "1" },
      ),
    };
  }

  it("PI6: findings and the following turn wait for cleanup to finish", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const held = barrier();
    /** What the observer saw while cleanup was still held. */
    const whileHeld: { progress: string; prompts: number; performed: string[] } = {
      progress: "",
      prompts: 0,
      performed: [],
    };

    const run = yield* runDocument({
      // `<Held />` last, so its cleanup runs once the fragment has produced its
      // complete output. Cleanup here is per element — a barrier written first
      // would be released before the read even happened, and would prove
      // nothing about the order this row is about.
      turns: [
        { reply: '<File path="notes.md" as="note" />\n<Json value={note} />\n<Held />\n' },
        { reply: CANDIDATE },
      ],
      evaluation: {
        read: [fileReadEntry(), globReadEntry(), syntaxReadEntry(), heldEntry()],
        files,
      },
      componentAnswers: [held.provider],
      verbose: true,
      observe: function* (live) {
        yield* held.entered.operation;
        // The outcome exists — the fragment has run — and cleanup has not
        // finished. Nothing downstream of it may have happened yet.
        whileHeld.progress = live.progress.join("");
        whileHeld.prompts = live.prompts.length;
        whileHeld.performed = [...files.performed];
        held.release.resolve();
      },
    });

    expect(run.failure).toBe(undefined);

    // Held: the phase that announces findings had not been written, and the
    // turn that receives them had not been asked.
    expect(whileHeld.progress).not.toContain("XMD information returned");
    expect(whileHeld.prompts).toBe(1);
    // And the barrier is *after* the outcome, not before it: the read this
    // request performed had already run when cleanup began.
    expect(whileHeld.performed).toEqual(["read notes.md"]);

    // Released: both happened, and the next turn carries the findings.
    expect(run.progress.join("")).toContain("XMD information returned");
    expect(run.prompts).toHaveLength(2);
    expect(run.prompts[1] ?? "").toContain("the retained note");
    expect(run.reviews).toHaveLength(1);
  });

  /**
   * The refusal half of the same ordering, in two pieces.
   *
   * A held-cleanup barrier cannot be built for this settlement, and the reason
   * is structural rather than an oversight. Cleanup inside a fragment is per
   * element: every element before the failure has already torn down, and no
   * element after it runs. A provider handler cannot hold it either — the claim
   * window is deliberately synchronous, so an `ensure` registered there ends the
   * resolution ("this resolution has settled, so a claim stated now identifies
   * nothing"). Nothing else a host supplies to a fragment has projection
   * lifetime.
   *
   * It does not need one, because the ordering is already settled a level down.
   * `CE22` proves the shared projection failure path: work the projection owns
   * is still live where the failure is reported and already torn down by the
   * time the recovery effect runs, with `CE23` as its contrast. That is the
   * teardown-before-recovery half, for every projection rather than this one.
   *
   * This row is the other half: that recovery then reaches the following turn —
   * the refusal is disclosed, and the next Prompt comes after it. And `FE34`
   * closes the pair from the failing side, where a cleanup failure wins over an
   * already-classified refusal and stays terminal.
   */
  it("PI6: a recoverable refusal is disclosed, then the following turn begins", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const run = yield* runDocument({
      turns: [{ reply: '<File path="absent.md" as="gone" />\n' }, { reply: CANDIDATE }],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
      verbose: true,
    });

    expect(run.failure).toBe(undefined);
    const progress = run.progress.join("");
    const refused = progress.indexOf("XMD information request refused");
    const continuing = progress.indexOf("Continuing the Plan");
    expect(refused).toBeGreaterThan(-1);
    expect(continuing).toBeGreaterThan(refused);
    expect(run.prompts).toHaveLength(2);
    expect(run.prompts[1] ?? "").toContain("That request was refused");
    expect(run.reviews).toHaveLength(1);
  });

  it("PI3: a titled draft is never evaluated", function* () {
    const files = recordedFiles({ "notes.md": "the retained note\n" });
    const run = yield* runDocument({
      turns: [{ reply: CANDIDATE }],
      evaluation: { read: [fileReadEntry(), globReadEntry(), syntaxReadEntry()], files },
    });

    expect(run.failure).toBe(undefined);
    // One turn, no evaluation, no information phase at all.
    expect(run.prompts).toHaveLength(1);
    expect(files.performed).toEqual([]);
    expect(run.progress.join("")).not.toContain("Inspecting XMD information");
  });
});

/**
 * The fake agent answers only what a case scripted.
 *
 * It used to answer an unscripted turn with the empty string, which a workflow
 * then treated as a response — so a case whose script and whose expectations
 * disagreed passed anyway, and a document with two `<Plan>` sites silently gave
 * its second site nothing. The failure names the turn and quotes the prompt, so
 * the case that under-scripted is identifiable from the message alone.
 */
describe("the scripted agent", () => {
  it("fails loudly on a turn nobody scripted, naming it", function* () {
    const run = yield* runDocument({
      // One scripted turn, and a first response that asks for another.
      turns: [{ reply: "<Json value={{}} />\n" }],
    });

    expect(String(run.failure)).toContain("asked for turn 2 and only 1 were scripted");
    expect(String(run.failure)).toContain("That request completed");
  });
});

/** Settles once the observer recorded what it was watching for. */
function* untilObserved(seen: readonly string[][]): Operation<void> {
  while (seen.length === 0) {
    yield* sleep(1);
  }
}
