/**
 * Tier PC — `<Plan>` written in an ordinary document.
 *
 * The same packaged Component `xmd plan` runs, reached the other way: a document
 * writes `<Plan>`, its body renders the Prompt, and the approved program is
 * carried out where the element was written — or, with `as`, bound and left
 * alone. What this tier is about is everything that differs from the command —
 * the caller's Prompt, the caller's journal, the caller's authority — and
 * everything that must not: the ceiling the Agent writes under, the order the
 * phases run in, and the exact bytes that come back.
 *
 * Every seam is deterministic and in process: the scriptable ACPX runtime, a
 * scripted review, a recorded draft answer, and an authorship root the case
 * created. No live agent, browser, or network belongs in this evidence.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentIdentityComponents,
  collect,
  installAgentComponents,
  retainedSource,
} from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { validateDocument } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import {
  AGENT,
  ADAPTERS,
  planDeclarationHarness,
  useWorkingDirectory,
} from "./support/plan-harness.ts";
import type { PlanDeclarationHarness } from "./support/plan-harness.ts";
import { PLAN_ORIGIN, planComponentDescription } from "../src/plan-component.ts";
import { syntaxCatalog } from "../src/syntax.ts";

const ROOT = "document.md";

/** A Plan the coding agent replies with, and that admission accepts. */
const PLAN = ["# Say hello", "", "This document greets you.", "", "Hello.", ""].join("\n");

/**
 * The same Plan with one observable, durable effect: a line appended to a log.
 *
 * A line rather than a file, because the question every case here asks is *how
 * many times* — once when the program expanded, never when it was captured or
 * refused, and not again when a partial journal resumed inside it.
 */
function programAppending(log: string): string {
  return [
    "# Say hello",
    "",
    "the program ran.",
    "",
    "```bash exec silent",
    `echo ran >> ${log}`,
    "```",
    "",
  ].join("\n");
}

/** How many times the program's effect happened, from the log it appends to. */
function* timesRun(log: string): Operation<number> {
  try {
    const text = String(yield* until(readFile(log, "utf8")));
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** What one document run produced, and every phase that was reached. */
interface Run {
  output: string;
  value: Json | undefined;
  failure: string | undefined;
  harness: PlanDeclarationHarness;
  stream: InMemoryStream;
  /** What is in the authorship root when the run is over. */
  leftover: string[];
}

function* authorshipRoot(): Operation<string> {
  const root = join(tmpdir(), `xmd-plan-component-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * One ordinary document, run against the declared Component.
 *
 * The assembly is `xmd run`'s: the agent words and this execution's prompt
 * bookkeeping, and the `<Plan>` declaration. What it deliberately does not
 * install is a constrained anything — the ceiling under which a Plan is written
 * is the Component's own, and a case that installed one here would be proving its
 * own arrangement rather than the product's.
 */
function* runDocument(options: {
  source: string;
  reply?: string;
  /** Turns scripted whole, for a case about how one of them settles. */
  turns?: readonly { reply: string; stopReason?: string }[];
  reviews?: readonly ("Approve" | "Stop" | "Request changes")[];
  /** The properties the enclosing document is run with. */
  props?: Record<string, Json>;
  root?: string;
  includes?: readonly string[];
  stream?: InMemoryStream;
  harness?: PlanDeclarationHarness;
  stack?: {
    provider: string;
    defaultAgent: string;
    permissionMode: "deny-all";
    adapters: typeof ADAPTERS;
  } | null;
  assess?: (source: string) => Operation<{ valid: boolean; diagnostics: Json }>;
  session?: string;
}): Operation<Run> {
  const root = options.root ?? (yield* authorshipRoot());
  const stream = options.stream ?? new InMemoryStream();
  const harness =
    options.harness ??
    (yield* planDeclarationHarness({
      surface: "component",
      authorshipRoot: root,
      ...(options.includes === undefined ? {} : { includes: options.includes }),
      ...(options.stack === undefined ? {} : { stack: options.stack }),
      ...(options.assess === undefined ? {} : { assess: options.assess }),
    }));
  if (options.reply !== undefined) {
    harness.fake.script({ reply: options.reply });
  }
  for (const turn of options.turns ?? []) {
    harness.fake.script(turn);
  }
  for (const decision of options.reviews ?? ["Approve"]) {
    harness.script(
      decision === "Request changes" ? { decision, feedback: "change it" } : { decision },
    );
  }

  let value: Json | undefined;
  let failure: string | undefined;
  let output = "";
  yield* scoped(function* () {
    yield* installAgentComponents({ defaultAgent: AGENT, permissionMode: "deny-all" });
    try {
      const execution = yield* executeInstalled(
        {
          ...retainedSource(ROOT, options.source),
          stream,
          includes: [...(options.includes ?? [])],
          ...(options.props === undefined ? {} : { props: options.props }),
        },
        [
          {
            components: agentIdentityComponents(),
            declarations: [harness.declaration],
          },
        ],
      );
      value = yield* collect(execution);
      output = String(value);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  });

  const leftover = yield* until(readdir(root));
  return { output, value, failure, harness, stream, leftover: leftover.sort() };
}

/** A partial continuation of one run: everything it recorded but the terminals. */
function* continuing(stream: InMemoryStream): Operation<InMemoryStream> {
  const partial = new InMemoryStream();
  for (const event of yield* stream.readAll()) {
    if (event.type === "close") {
      continue;
    }
    yield* partial.append(event);
  }
  return partial;
}

function isPrompt(event: DurableEvent): boolean {
  return event.type === "yield" && event.description.type === "agent_prompt";
}

describe("Tier PC — <Plan> in an ordinary document", () => {
  it("PC1: the body is the Prompt, and the approved bytes arrive under `as`", function* () {
    yield* useWorkingDirectory(function* (dir) {
      // A file only the caller's authority can read, written into the Prompt.
      // The body is ordinary XMD with the document's own capabilities: if it
      // ran under the authorship ceiling instead, this read would be refused.
      yield* writeTextFile(join(dir, "notes.md"), "the project notes");

      const run = yield* runDocument({
        source: [
          '<Plan as="approved">',
          'Write a program. Notes: <File path="notes.md" />',
          "</Plan>",
          "",
          "got: {approved}",
          "",
        ].join("\n"),
        reply: PLAN,
      });

      expect(run.failure).toBe(undefined);
      // The complete untrimmed rendering reached the agent, notes and all.
      expect(run.harness.fake.prompts[0]).toContain("Write a program. Notes: the project notes");
      // And the approved source came back byte for byte, under `as`.
      expect(run.output).toContain(`got: ${PLAN}`);
    });
  });

  it("PC2: the Prompt is not emitted, and no Plan source is printed", function* () {
    yield* useWorkingDirectory(function* () {
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', "", "done", ""].join("\n"),
        reply: PLAN,
      });

      expect(run.failure).toBe(undefined);
      // The body rendered into the Prompt and nowhere else, and the Component's own
      // presentation is interaction rather than output.
      expect(run.output).not.toContain("Write a program.");
      expect(run.output).not.toContain("# Say hello");
      expect(run.output).not.toContain("Create one complete XMD Plan");
      expect(run.output.trim()).toBe("done");
    });
  });

  it("PC3: an empty Prompt reaches no catalog, session, turn or review", function* () {
    yield* useWorkingDirectory(function* () {
      const root = yield* authorshipRoot();
      const run = yield* runDocument({
        source: ['<Plan as="approved">   </Plan>', ""].join("\n"),
        root,
        reviews: [],
      });

      expect(run.failure).toContain("<Plan> requires its body to render a non-empty Prompt.");
      // Every later phase stayed at zero. A refusal proven by empty output would
      // pass for a run that opened a session and then printed nothing.
      expect(run.harness.fake.prompts).toEqual([]);
      expect(run.harness.reviews).toEqual([]);
      expect(run.harness.checked).toEqual([]);
      expect(run.leftover).toEqual([]);
    });
  });

  it("PC4: a body that fails reaches no preparation at all", function* () {
    yield* useWorkingDirectory(function* () {
      const run = yield* runDocument({
        // No such component: the projection fails, and `<Plan>` neither catches
        // it nor reinterprets it.
        source: ['<Plan as="approved">Write <Nonexistent /></Plan>', ""].join("\n"),
        reviews: [],
      });

      expect(run.failure).toContain("Nonexistent");
      expect(run.harness.fake.prompts).toEqual([]);
      expect(run.harness.reviews).toEqual([]);
      expect(run.leftover).toEqual([]);
    });
  });

  it("PC5: a host that cannot establish the ceiling refuses before placement", function* () {
    yield* useWorkingDirectory(function* () {
      const root = yield* authorshipRoot();
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', ""].join("\n"),
        root,
        reviews: [],
        stack: {
          provider: "not-acpx",
          defaultAgent: AGENT,
          permissionMode: "deny-all",
          adapters: ADAPTERS,
        },
      });

      expect(run.failure).toContain("cannot establish the Plan authorship ceiling");
      // Before placement: no directory was made, and no turn was taken.
      expect(run.leftover).toEqual([]);
      expect(run.harness.fake.prompts).toEqual([]);
    });
  });

  it("PC6: the private capabilities resolve nowhere a document can write", function* () {
    yield* useWorkingDirectory(function* () {
      for (const name of ["PlanInputs", "PlanAuthorship", "CheckDraft", "AdmitPlan"]) {
        const run = yield* runDocument({
          source: [`<${name} as="x" />`, ""].join("\n"),
          reviews: [],
        });
        expect(run.failure).toContain(`Cannot resolve component: ${name}`);
      }
    });
  });

  it("PC7: the catalog advertises <Plan> and none of its private names", function* () {
    yield* useWorkingDirectory(function* () {
      const catalog = yield* syntaxCatalog([]);
      const builtIn = catalog.categories[1].entries;
      const plan = builtIn.find((entry) => entry.name === "Plan");

      expect(plan).toBeDefined();
      expect(plan?.sourceKind).toBe("declared-markdown");
      expect(plan?.forms).toEqual(["paired"]);
      expect(plan?.returnMode).toBe("value");
      expect(Reflect.get(Object(plan?.origin), "origin")).toBe(PLAN_ORIGIN);
      // The description a document author reads is the packaged Component's own
      // frontmatter, so the asset and the entry describing it are one text.
      expect(plan?.description).toContain("Create an XMD program from a prompt.");

      for (const category of catalog.categories) {
        const names = category.entries.map((entry) => entry.name);
        for (const priv of ["PlanInputs", "PlanAuthorship", "CheckDraft", "AdmitPlan"]) {
          expect(names).not.toContain(priv);
        }
      }
    });
  });

  it("PC7b: a repository file under a private name answers for nothing anywhere", function* () {
    yield* useWorkingDirectory(function* (dir) {
      // The name a document might reach for, sitting right beside the caller.
      // Selection refuses a name the declaration keeps to itself before any tier
      // can answer, so this file is described by nothing, validates as
      // unresolved, and never runs.
      yield* writeTextFile(join(dir, "CheckDraft.md"), "the repository file ran.\n");

      const catalog = yield* syntaxCatalog([dir]);
      for (const category of catalog.categories) {
        expect(category.entries.map((entry) => entry.name)).not.toContain("CheckDraft");
      }

      const validation = yield* validateDocument({
        ...retainedSource(ROOT, '<CheckDraft source="x" as="check" />\n'),
        includes: [dir],
        declarations: [yield* planComponentDescription()],
      });
      expect(validation.outcome).toBe("invalid");
      expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "component-unresolved",
      );

      const run = yield* runDocument({
        source: ['<CheckDraft source="x" as="check" />', ""].join("\n"),
        includes: [dir],
        reviews: [],
      });
      expect(run.failure).toContain("Cannot resolve component: CheckDraft");
      expect(run.output).not.toContain("the repository file ran.");
    });
  });

  it("PC8: two sites are two conversations, and a default directory is handed back", function* () {
    yield* useWorkingDirectory(function* () {
      const root = yield* authorshipRoot();
      const run = yield* runDocument({
        source: [
          '<Plan as="first">Write the first program.</Plan>',
          '<Plan as="second">Write the second program.</Plan>',
          "",
          "{first === second}",
          "",
        ].join("\n"),
        root,
        reply: PLAN,
        reviews: ["Approve", "Approve"],
      });

      expect(run.failure).toBe(undefined);
      // Two invocations, two turns, two reviews — one site did not answer for
      // the other.
      expect(run.harness.fake.prompts).toHaveLength(2);
      expect(run.harness.reviews).toHaveLength(2);
      // And each derived placement was handed back after its own teardown.
      expect(run.leftover).toEqual([]);
    });
  });

  it("PC9: a completed authorship restores from the enclosing journal", function* () {
    yield* useWorkingDirectory(function* () {
      const first = new InMemoryStream();
      const source = [
        '<Plan as="approved">Write a program.</Plan>',
        "",
        "got: {approved}",
        "",
      ].join("\n");
      const one = yield* runDocument({ source, reply: PLAN, stream: first });
      expect(one.failure).toBe(undefined);
      expect(one.harness.fake.prompts).toHaveLength(1);

      // A second run, continuing that history with a provider that would answer
      // differently and a review nobody scripted. Neither is reached: the turn,
      // the check, the approval and the admission are all restored.
      const partial = yield* continuing(first);
      const two = yield* runDocument({
        source,
        reply: "# A different Plan\n\nnot this one.\n",
        reviews: [],
        stream: partial,
      });

      expect(two.failure).toBe(undefined);
      expect(two.output).toContain(`got: ${PLAN}`);
      expect(two.harness.fake.prompts).toEqual([]);
      expect(two.harness.reviews).toEqual([]);
      expect(two.harness.checked).toEqual([]);
    });
  });

  it("PC10: the turns belong to the enclosing journal, and no private one exists", function* () {
    yield* useWorkingDirectory(function* () {
      const stream = new InMemoryStream();
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', ""].join("\n"),
        reply: PLAN,
        stream,
      });

      expect(run.failure).toBe(undefined);
      // The Agent turn is in the caller's own history. `xmd plan` throws its
      // authorship stream away; a document keeps its own.
      expect((yield* stream.readAll()).filter(isPrompt)).toHaveLength(1);
    });
  });

  it("PC11: a Plan declaring required properties is admitted and returned", function* () {
    yield* useWorkingDirectory(function* () {
      const withProps = [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    who: { type: string }",
        "  required: [who]",
        "---",
        "",
        "# Greet somebody",
        "",
        "Hello {props.who}.",
        "",
      ].join("\n");

      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a greeter.</Plan>', "", "got:{approved}", ""].join(
          "\n",
        ),
        reply: withProps,
      });

      // Nobody has offered this Plan its properties yet, and refusing it for
      // that would refuse a program for being one. What runs it resolves them.
      expect(run.failure).toBe(undefined);
      expect(run.output).toContain(withProps);
    });
  });

  it("PC12: a Plan that is not structurally a program binds nothing", function* () {
    yield* useWorkingDirectory(function* () {
      const run = yield* runDocument({
        // Approved by the check this case scripts, and refused by the admission
        // that follows teardown: the two are different questions, and only the
        // second decides what may be returned.
        source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join(
          "\n",
        ),
        reply: "<Nonexistent />\n",
      });

      expect(run.failure).toContain("the approved Plan does not validate");
      expect(run.failure).toContain("component-unresolved");
      expect(run.output).not.toContain("got:");
    });
  });

  it("PC13: stopping is the Component's own ending, in its component words", function* () {
    yield* useWorkingDirectory(function* () {
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', ""].join("\n"),
        reply: PLAN,
        reviews: ["Stop"],
      });

      expect(run.failure).toBe("Plan authorship stopped at your request. No Plan was returned.");
      // Nothing was bound, and the conversation's directory went back.
      expect(run.output).not.toContain("# Say hello");
      expect(run.leftover).toEqual([]);
    });
  });

  it("PC15: an omitted session's directory is handed back after teardown", function* () {
    yield* useWorkingDirectory(function* () {
      const root = yield* authorshipRoot();
      const run = yield* runDocument({
        // No `session` prop: the placement is this expansion's own, and belongs
        // to it.
        source: ['<Plan as="approved">Write a program.</Plan>', ""].join("\n"),
        root,
        reply: PLAN,
      });

      expect(run.failure).toBe(undefined);
      // Handed back non-recursively after the whole authorship frame went, which
      // is the only reason the root is empty rather than holding one leaf.
      expect(run.leftover).toEqual([]);
    });
  });

  it("PC16: an authored session's directory is still there afterwards", function* () {
    yield* useWorkingDirectory(function* () {
      const root = yield* authorshipRoot();
      const run = yield* runDocument({
        source: ['<Plan session="review" as="approved">Write a program.</Plan>', ""].join("\n"),
        root,
        reply: PLAN,
      });

      expect(run.failure).toBe(undefined);
      // A name a caller can write again needs a directory that is still there
      // next time, so nothing removes it. One leaf, and its name is a digest —
      // the authored name never becomes a path.
      expect(run.leftover).toHaveLength(1);
      expect(run.leftover[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(run.leftover[0]).not.toContain("review");
    });
  });

  it("PC17: the same site and name continue the same placement", function* () {
    yield* useWorkingDirectory(function* () {
      const root = yield* authorshipRoot();
      const source = ['<Plan session="review" as="approved">Write a program.</Plan>', ""].join(
        "\n",
      );

      const one = yield* runDocument({ source, root, reply: PLAN });
      expect(one.failure).toBe(undefined);
      expect(one.leftover).toHaveLength(1);

      // A second run of the same document, against the same root. The
      // continuation contract is that the same site writing the same name
      // reaches the same placement — so the root still holds exactly the one
      // directory, and it is the same one. A placement derived per run would
      // leave a second beside it, because both are durable.
      const two = yield* runDocument({ source, root, reply: PLAN });

      expect(two.failure).toBe(undefined);
      expect(two.leftover).toEqual(one.leftover);
    });
  });

  it("PC18: two sites writing one name are two conversations", function* () {
    yield* useWorkingDirectory(function* () {
      const root = yield* authorshipRoot();
      const run = yield* runDocument({
        // The same authored name at two sites. Sibling placements stay distinct,
        // exactly as sibling `<Session>` elements do, so neither answers for the
        // other and neither refuses the other's directory as occupied.
        source: [
          '<Plan session="review" as="first">Write the first program.</Plan>',
          '<Plan session="review" as="second">Write the second program.</Plan>',
          "",
        ].join("\n"),
        root,
        reply: PLAN,
        reviews: ["Approve", "Approve"],
      });

      expect(run.failure).toBe(undefined);
      expect(run.harness.fake.prompts).toHaveLength(2);
      // Two durable placements, not one shared and not one refused.
      expect(run.leftover).toHaveLength(2);
      expect(new Set(run.leftover).size).toBe(2);
    });
  });

  it("PC19: an approved Plan expands where the element is written", function* () {
    yield* useWorkingDirectory(function* (dir) {
      const log = join(dir, "log.txt");
      const run = yield* runDocument({
        source: ["before", "", "<Plan>Write a program.</Plan>", "", "after", ""].join("\n"),
        reply: programAppending(log),
      });

      expect(run.failure).toBe(undefined);
      // One program, carried out once, between the two markers the author wrote
      // around the element.
      expect(yield* timesRun(log)).toBe(1);
      const before = run.output.indexOf("before");
      const ran = run.output.indexOf("the program ran.");
      const after = run.output.indexOf("after");
      expect(before).toBeGreaterThanOrEqual(0);
      expect(ran).toBeGreaterThan(before);
      expect(after).toBeGreaterThan(ran);
      // What the reader sees is the program's output, not its source.
      expect(run.output).not.toContain("```bash exec");
      expect(run.output).not.toContain("echo ran");
    });
  });

  it("PC20: the same Plan under `as` binds the bytes and carries out none of them", function* () {
    yield* useWorkingDirectory(function* (dir) {
      const log = join(dir, "log.txt");
      const approved = programAppending(log);
      const run = yield* runDocument({
        source: ['<Plan as="program">Write a program.</Plan>', "", "got:{program}", ""].join("\n"),
        reply: approved,
      });

      expect(run.failure).toBe(undefined);
      // Byte for byte, and the effect in those bytes is the negative control.
      expect(run.output).toContain(`got:${approved}`);
      expect(yield* timesRun(log)).toBe(0);
    });
  });

  it("PC21: the program runs in the calling document's own environment", function* () {
    yield* useWorkingDirectory(function* (dir) {
      // A component on the caller's own include path. The program reaches it
      // because the component selection, the includes and the registry are the
      // enclosing execution's rather than a second run's.
      yield* writeTextFile(join(dir, "Greeting.md"), "a greeting\n");

      const approved = [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    who: { type: string }",
        "  required: [who]",
        "  additionalProperties: false",
        "release: 1.2.3",
        "---",
        "",
        "# Greet somebody",
        "",
        "<Output>",
        "for {props.who} at {meta.release}, greeting {greeting} via <Greeting />",
        "</Output>",
        "",
        "this line is documentation and is not selected.",
        "",
      ].join("\n");

      const run = yield* runDocument({
        source: [
          "---",
          "props:",
          "  type: object",
          "  properties:",
          "    who: { type: string }",
          "  required: [who]",
          "  additionalProperties: false",
          "---",
          "",
          '<Let as="greeting" value="hello" />',
          "<Plan>Write a greeter.</Plan>",
          "",
        ].join("\n"),
        reply: approved,
        includes: [dir],
        props: { who: "ada" },
      });

      expect(run.failure).toBe(undefined);
      expect(run.output).toContain("for ada at 1.2.3, greeting hello via a greeting");
      // Its own top-level `<Output>` selected what renders, exactly as a root's does.
      expect(run.output).not.toContain("this line is documentation");
    });
  });

  it("PC22: every unsuccessful ending leaves no program effect and no binding", function* () {
    const endings: readonly {
      name: string;
      reviews: readonly ("Approve" | "Stop" | "Request changes")[];
      reply?: string;
      turns?: readonly { reply: string; stopReason?: string }[];
      expect: string;
    }[] = [
      { name: "stopping", reviews: ["Stop"], expect: "stopped at your request" },
      {
        name: "a failed turn",
        reviews: [],
        turns: [{ reply: "", stopReason: "refusal" }],
        expect: 'stop reason "refusal"',
      },
      {
        name: "a structural refusal",
        reviews: ["Approve"],
        reply: "<Nonexistent />\n",
        expect: "does not validate",
      },
      {
        // The program a `<Plan>` produces expands under the authority the
        // authored site carried, not the declaration's, so the phases only
        // those exact bytes may write are not names it can reach.
        name: "a private name in the approved source",
        reviews: ["Approve"],
        reply: '<AdmitPlan source="x" as="admitted" />\n',
        expect: "does not validate",
      },
    ];

    for (const ending of endings) {
      yield* useWorkingDirectory(function* (dir) {
        const log = join(dir, "log.txt");
        // A row scripts turns or a reply, never both; the rest approve the
        // program whose one effect this case counts.
        const scripted =
          ending.turns === undefined
            ? { reply: ending.reply ?? programAppending(log) }
            : { turns: ending.turns };

        const run = yield* runDocument({
          source: ["<Plan>Write a program.</Plan>", "", "after", ""].join("\n"),
          ...scripted,
          reviews: ending.reviews,
        });

        expect(run.failure).toContain(ending.expect);
        // Nothing was carried out and nothing of the program was rendered in its
        // place. The ending's name travels into the assertion so a failure says
        // which of them produced it.
        expect([ending.name, yield* timesRun(log)]).toEqual([ending.name, 0]);
        expect(run.output).not.toContain("the program ran.");
      });
    }
  });

  it("PC22b: ten drafts nobody could approve end in exhaustion, having run nothing", function* () {
    yield* useWorkingDirectory(function* (dir) {
      const log = join(dir, "log.txt");
      // Every draft and every repair attempt answers with the same candidate,
      // and the host finds each of them unsound. That is what drives the
      // Component through its three repairs a round and its ten rounds, and
      // what makes the tenth round the one with nothing left to revise into.
      const candidate = programAppending(log);
      const run = yield* runDocument({
        source: ["<Plan>Write a program.</Plan>", "", "after", ""].join("\n"),
        turns: Array.from({ length: 60 }, () => ({ reply: candidate })),
        // deno-lint-ignore require-yield
        assess: function* () {
          return { valid: false, diagnostics: { problem: "the draft is unsound" } };
        },
        reviews: [...Array.from({ length: 9 }, () => "Request changes" as const), "Stop" as const],
      });

      // The exhaustion ending, not the ordinary one a person choosing Stop
      // earlier would have reached.
      expect(run.failure).toBe(
        "Plan authorship reviewed ten drafts without an approved Plan. No Plan was returned.",
      );
      // Ten drafts is what the workflow reviewed, and each was checked once and
      // then repaired three times.
      expect(run.harness.reviews).toHaveLength(10);
      expect(run.harness.checked).toHaveLength(40);
      // The candidate carried a program effect through every round of this and
      // never performed it.
      expect(yield* timesRun(log)).toBe(0);
      expect(run.output).not.toContain("the program ran.");
      expect(run.leftover).toEqual([]);
    });
  });

  it("PC23: cancelling authorship leaves no program effect", function* () {
    yield* useWorkingDirectory(function* (dir) {
      const log = join(dir, "log.txt");
      const root = yield* authorshipRoot();
      const harness = yield* planDeclarationHarness({
        surface: "component",
        authorshipRoot: root,
      });
      // The turn never settles, so the run is interrupted while the agent is
      // still writing — the one ending no review answer can produce.
      harness.fake.script({ reply: programAppending(log), manual: true });

      yield* scoped(function* () {
        yield* installAgentComponents({ defaultAgent: AGENT, permissionMode: "deny-all" });
        const running = yield* spawn(function* () {
          return yield* collect(
            yield* executeInstalled(
              {
                ...retainedSource(ROOT, "<Plan>Write a program.</Plan>\n"),
                stream: new InMemoryStream(),
                includes: [],
              },
              [
                {
                  components: agentIdentityComponents(),
                  declarations: [harness.declaration],
                },
              ],
            ),
          );
        });
        yield* harness.fake.startedTurns(1);
        yield* running.halt();
      });

      expect(harness.reviews).toEqual([]);
      expect(yield* timesRun(log)).toBe(0);
      expect(yield* until(readdir(root))).toEqual([]);
    });
  });

  it("PC24: a root contract the caller cannot meet refuses before the program runs", function* () {
    yield* useWorkingDirectory(function* (dir) {
      const log = join(dir, "log.txt");
      const effect = ["```bash exec silent", `echo ran >> ${log}`, "```"].join("\n");

      // A Plan whose root declares required properties nothing here offers.
      // Admission accepts it — a Plan declaring properties is a Plan — and the
      // expansion refuses it against the properties this site actually has.
      const demanding = yield* runDocument({
        source: ["<Plan>Write a greeter.</Plan>", ""].join("\n"),
        reply: [
          "---",
          "props:",
          "  type: object",
          "  properties:",
          "    who: { type: string }",
          "  required: [who]",
          "  additionalProperties: false",
          "---",
          "",
          "# Greet somebody",
          "",
          effect,
          "",
        ].join("\n"),
      });

      expect(demanding.failure).toContain("who");
      expect(yield* timesRun(log)).toBe(0);

      // And a Plan declaring a root return, which expanded source has nowhere
      // to hand a value back to.
      const valued = yield* runDocument({
        source: ["<Plan>Write a program.</Plan>", ""].join("\n"),
        reply: [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "# Produce a value",
          "",
          effect,
          "",
          '<Return value="x" />',
          "",
        ].join("\n"),
      });

      expect(valued.failure).toContain("declares `returns`");
      expect(yield* timesRun(log)).toBe(0);
    });
  });

  it("PC25: a partial journal resumes inside the program without repeating it", function* () {
    yield* useWorkingDirectory(function* (dir) {
      const log = join(dir, "log.txt");
      const first = new InMemoryStream();
      const source = ["before", "", "<Plan>Write a program.</Plan>", "", "after", ""].join("\n");

      const one = yield* runDocument({
        source,
        reply: programAppending(log),
        stream: first,
      });
      expect(one.failure).toBe(undefined);
      expect(yield* timesRun(log)).toBe(1);

      // A second run continuing that history, with a provider that would answer
      // differently and a review nobody scripted. Authorship, the check, the
      // approval and the admission are all restored — and so is the effect the
      // program had already performed.
      const two = yield* runDocument({
        source,
        reply: "# A different Plan\n\nnot this one.\n",
        reviews: [],
        stream: yield* continuing(first),
      });

      expect(two.failure).toBe(undefined);
      expect(two.harness.fake.prompts).toEqual([]);
      expect(two.harness.reviews).toEqual([]);
      expect(two.harness.checked).toEqual([]);
      expect(yield* timesRun(log)).toBe(1);
      expect(two.output).toBe(one.output);
    });
  });

  it("PC26: the catalog says the approved plan expands, and validation agrees", function* () {
    yield* useWorkingDirectory(function* () {
      const catalog = yield* syntaxCatalog([]);
      const plan = catalog.categories[1].entries.find((entry) => entry.name === "Plan");

      expect(plan?.returnDisposition).toEqual({
        kind: "executable-source",
        sourceIdentity: "<plan>",
      });
      expect(plan?.description).toContain("expands the approved plan");

      // A site without `as` is what the common path writes, so validation has to
      // accept it — and it asks the same question expansion does.
      const validation = yield* validateDocument({
        ...retainedSource(ROOT, "<Plan>Write a program.</Plan>\n"),
        declarations: [yield* planComponentDescription()],
      });
      expect(validation.outcome).toBe("valid");
    });
  });

  it("PC14: nothing the Component does reaches the caller's filesystem", function* () {
    yield* useWorkingDirectory(function* (dir) {
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', ""].join("\n"),
        reply: PLAN,
      });

      expect(run.failure).toBe(undefined);
      // No output file, no journal, no scratch: the durable work belongs to the
      // enclosing document and the approved source exists only as the binding.
      expect((yield* until(readdir(dir))).sort()).toEqual([]);
    });
  });
});
