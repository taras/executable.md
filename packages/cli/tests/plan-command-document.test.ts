/**
 * The packaged plan command document, executed as itself.
 *
 * This runs the exact Markdown the CLI ships — read through the packaged
 * loader, not copied into a fixture — so what it proves is what a release does.
 * The seams around it are deterministic: a scriptable ACP runtime for the one
 * Agent turn, a scripted Elicitation answer for the review, and a test-only
 * validator in the place the authorship profile declares the production one.
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
import { ensure, scoped, sleep, spawn } from "effection";
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
import type { DocumentValidation, ElicitationRequest, Json } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { PLAN_COMMAND_DOCUMENT, readPackagedDocument } from "../src/packaged-document.ts";
import { PLAN_COMMAND_IDENTITY } from "../src/authorship-profile.ts";
import type { PlanSurface } from "../src/plan-component.ts";
import { AGENT, planDeclarationHarness, useWorkingDirectory } from "./support/plan-harness.ts";
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
  observe?(run: { progress: string[]; events: string[] }): Operation<void>;
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
      authorshipRoot: yield* authorshipRoot(),
      session: SESSION,
      explicitSession: true,
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      // deno-lint-ignore require-yield
      *catalog() {
        events.push("catalog");
        return "## Built-in components\n\n### `<File>`\n";
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
          },
        ],
      );
      if (options.observe !== undefined) {
        yield* spawn(() => options.observe!({ progress, events }));
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
function* authorshipRoot(): Operation<string> {
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
    // the admission after the whole authorship frame had gone. They are the same
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
          { reply: "<NoSuchComponent />\n" },
          { reply: "<NoSuchComponent />\n" },
          { reply: "<NoSuchComponent />\n" },
          { reply: "<NoSuchComponent />\n" },
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
    /** The transcript as it stood when the authorship frame began to close. */
    const atTeardown: string[] = [];

    const run = yield* useWorkingDirectory(function* () {
      const source = yield* readPackagedDocument(PLAN_COMMAND_DOCUMENT);
      const progress: string[] = [];
      let failure: string | undefined;

      const harness = yield* scoped(function* () {
        return yield* planDeclarationHarness({
          surface: "command",
          authorshipRoot: yield* authorshipRoot(),
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
          [{ components: agentIdentityComponents(), declarations: [installed] }],
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
          ...Array.from({ length: 40 }, () => ({ reply: "<NoSuchComponent />\n" })),
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
    const invalid = "<NoSuchComponent />\n";
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

/** Settles once the observer recorded what it was watching for. */
function* untilObserved(seen: readonly string[][]): Operation<void> {
  while (seen.length === 0) {
    yield* sleep(1);
  }
}
