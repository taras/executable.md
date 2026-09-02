/**
 * Tier PC — `<Plan>` written in an ordinary document.
 *
 * The same packaged Component `xmd plan` runs, reached the other way: a document
 * writes `<Plan>`, its body renders the Prompt, and the approved source arrives
 * under `as`. What this tier is about is everything that differs from the
 * command — the caller's Prompt, the caller's journal, the caller's authority —
 * and everything that must not: the ceiling the Agent writes under, the order
 * the phases run in, and the exact bytes that come back.
 *
 * Every seam is deterministic and in process: the scriptable ACPX runtime, a
 * scripted review, a recorded draft answer, and an authorship root the case
 * created. No live agent, browser, or network belongs in this evidence.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
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
  reviews?: readonly ("Approve" | "Stop")[];
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
  for (const decision of options.reviews ?? ["Approve"]) {
    harness.script({ decision });
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

  it("PC5: a host whose provider gives no Agent context refuses before placement", function* () {
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

      // Named, so the person reads which provider had nothing to give rather
      // than that something unspecified went wrong.
      expect(run.failure).toBe(
        "The not-acpx provider did not provide an Agent context for <Plan>. No Plan was returned.",
      );
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
      expect(plan?.description).toContain("Create an XMD program from a Prompt.");

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
