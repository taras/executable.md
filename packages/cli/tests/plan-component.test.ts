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
import { ensure, scoped, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEach } from "@effectionx/stream-helpers";
import {
  agentIdentityComponents,
  collect,
  installAgentComponents,
  retainedSource,
  useNormalizedOutput,
} from "@executablemd/core";
import type { Json, SyntaxCatalog } from "@executablemd/core";
import { validateDocument } from "@executablemd/core";
import { executeInstalled, sourceDigest } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import {
  AGENT,
  ADAPTERS,
  planDeclarationHarness,
  useWorkingDirectory,
} from "./support/plan-harness.ts";
import type { PlanDeclarationHarness } from "./support/plan-harness.ts";
import {
  PLAN_ORIGIN,
  planComponentDescription,
  structuralValidation,
} from "../src/plan-component.ts";
import type { StructuralValidation } from "../src/plan-component.ts";
import { syntaxCatalog } from "../src/syntax.ts";
import { PLAN_DOCUMENT, readPackagedDocument } from "../src/packaged-document.ts";

const ROOT = "document.md";

/** A Plan the coding agent replies with, and that admission accepts. */
const PLAN = ["# Say hello", "", "This document greets you.", "", "Hello.", ""].join("\n");

/** What one document run produced, and every phase that was reached. */
interface Run {
  output: string;
  /** What the Output Api actually emitted, through whatever middleware ran. */
  emitted: string;
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
  validate?: StructuralValidation;
  session?: string;
  props?: Record<string, Json>;
  /**
   * Install the output middleware an ordinary `xmd run` installs.
   *
   * Off by default, because most cases are about what a document rendered
   * rather than about how it was presented. A case about exact bytes turns it
   * on, so the normalizer that would rewrite them is actually in the way. The
   * Markdown suite cannot do this: its host installs no presentation
   * middleware, so an exactness assertion there would hold whether the bypass
   * existed or not.
   */
  normalized?: boolean;
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
      ...(options.validate === undefined ? {} : { validate: options.validate }),
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
  const chunks: string[] = [];
  yield* scoped(function* () {
    yield* installAgentComponents({ defaultAgent: AGENT, permissionMode: "deny-all" });
    if (options.normalized === true) {
      yield* useNormalizedOutput();
    }
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
            // Where the profile a document observes is settled now: the
            // `<Syntax />` the packaged Plan writes is canonical core's public
            // component, and what it answers with is this execution's.
            catalog: harness.catalog,
          },
        ],
      );
      // Subscribed before the completion is awaited, so what is collected is
      // what went out through the middleware — the close value is the
      // document's own rendering and would show none of the presentation.
      const draining = yield* spawn(function* () {
        yield* forEach(function* (chunk: string) {
          chunks.push(chunk);
        }, execution.output);
      });
      value = yield* collect(execution);
      output = String(value);
      yield* draining;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  });

  const leftover = yield* until(readdir(root));
  return {
    output,
    emitted: chunks.join(""),
    value,
    failure,
    harness,
    stream,
    leftover: leftover.sort(),
  };
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

  it("PC1b: the packaged Plan writes the public <Syntax />, and its catalog reaches the first turn once", function* () {
    yield* useWorkingDirectory(function* () {
      const source = yield* readPackagedDocument(PLAN_DOCUMENT);
      // The public component, written the way any document writes it.
      expect(source).toContain('<Syntax as="syntax" />');
      // And nothing declares a second one: the private closure is the five
      // phases, and `Syntax` is not among them.
      const declaration = yield* planComponentDescription();
      expect((declaration.privates ?? []).map((component) => component.name)).toEqual([
        "PlanInputs",
        "PlanAuthorship",
        "PlanProgress",
        "CheckDraft",
        "AdmitPlan",
      ]);

      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join(
          "\n",
        ),
        reply: PLAN,
      });

      expect(run.failure).toBe(undefined);
      // The retained catalog is what the first turn was built from, and it is
      // there exactly once — a second copy would mean the Component both bound
      // it and emitted it.
      const first = run.harness.fake.prompts[0] ?? "";
      expect(first).toContain("### `<File>`");
      expect(first.split("### `<File>`").length - 1).toBe(1);
      expect(run.harness.catalogCalls).toBe(1);
    });
  });

  it("PC1c: a catalog observation that fails reaches no session, turn, review or Plan", function* () {
    yield* useWorkingDirectory(function* (dir) {
      const harness = yield* planDeclarationHarness({
        surface: "component",
        authorshipRoot: `${dir}-profile`,
        // deno-lint-ignore require-yield
        *catalog(): Operation<SyntaxCatalog> {
          throw new Error("the profile could not be described");
        },
      });
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join(
          "\n",
        ),
        reply: PLAN,
        reviews: [],
        harness,
      });

      expect(run.failure).toContain("the profile could not be described");
      // Nothing downstream of the observation happened: no turn was taken, no
      // review was asked, no draft was checked, and no Plan was bound.
      expect(run.harness.fake.prompts).toEqual([]);
      expect(run.harness.reviews).toEqual([]);
      expect(run.harness.checked).toEqual([]);
      expect(run.output).not.toContain("# Say hello");
      expect(run.emitted).not.toContain("# Say hello");
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
      for (const name of [
        "PlanInputs",
        "PlanAuthorship",
        "PlanProgress",
        "CheckDraft",
        "AdmitPlan",
      ]) {
        const run = yield* runDocument({
          source: [`<${name} as="x" />`, ""].join("\n"),
          reviews: [],
        });
        expect(run.failure).toContain(`Cannot resolve component: ${name}`);
      }
      // The positive control for the same document shape: `<Syntax />` is not one
      // of Plan's private names, it is the public component canonical core owns,
      // so the identical invocation resolves and binds the catalog.
      const open = yield* runDocument({
        source: ['<Syntax as="x" />', "{x}", ""].join("\n"),
        reviews: [],
      });
      expect(open.failure).toBeUndefined();
      expect(open.output).toContain("### `<File>`");
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
      // A text component: the approved source is what it renders, and `as` is
      // ordinary text capture rather than a declared return.
      expect(plan?.returnMode).toBe("text");
      expect(Reflect.get(Object(plan?.origin), "origin")).toBe(PLAN_ORIGIN);
      // The description a document author reads is the packaged Component's own
      // frontmatter, so the asset and the entry describing it are one text.
      expect(plan?.description).toContain("Create an XMD program from a prompt.");
      expect(plan?.description).toContain("emits the approved program source.");

      for (const category of catalog.categories) {
        const names = category.entries.map((entry) => entry.name);
        for (const priv of [
          "PlanInputs",
          "PlanAuthorship",
          "PlanProgress",
          "CheckDraft",
          "AdmitPlan",
        ]) {
          expect(names).not.toContain(priv);
        }
      }
      // `<Syntax />` is not one of them any more. It is public, canonical core
      // owns it, and the catalog an author reads says so — which is what stops
      // the absence check above passing because the whole set went missing.
      expect(builtIn.map((entry) => entry.name)).toContain("Syntax");
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
      let catalogs = 0;
      const two = yield* runDocument({
        source,
        reply: "# A different Plan\n\nnot this one.\n",
        reviews: [],
        stream: partial,
        harness: yield* planDeclarationHarness({
          surface: "component",
          authorshipRoot: yield* authorshipRoot(),
          *catalog() {
            catalogs += 1;
            throw new Error("a restored syntax snapshot was rebuilt");
          },
        }),
      });

      expect(two.failure).toBe(undefined);
      expect(two.output).toContain(`got: ${PLAN}`);
      expect(two.harness.fake.prompts).toEqual([]);
      expect(two.harness.reviews).toEqual([]);
      expect(two.harness.checked).toEqual([]);
      expect(catalogs).toBe(0);
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
      // The draft check and the admission are one question asked twice, of a
      // tree that may have moved between them: the draft resolved everything it
      // names while the conversation was standing, and by the time the
      // authorship frame had gone it did not. Only the second answer decides
      // what may be returned.
      const canonical = structuralValidation([], [yield* planComponentDescription()]);
      let answered = 0;
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join(
          "\n",
        ),
        reply: "<Nonexistent />\n",
        *validate(candidate) {
          answered += 1;
          return answered === 1
            ? { version: 1, outcome: "valid", diagnostics: [], invocations: [] }
            : yield* canonical(candidate);
        },
      });

      // Two answers, and the second is the one that refused.
      expect(answered).toBe(2);
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

  /**
   * The Plan artifact a run retained, or nothing when it retained none.
   *
   * Read from the journal rather than from the binding, because retention is what
   * a continuation reads and an ending that produced no Plan must leave nothing
   * there for one to find.
   */
  function* retainedArtifact(stream: InMemoryStream): Operation<Json | undefined> {
    for (const event of yield* stream.readAll()) {
      if (event.type !== "yield" || !event.description.name.startsWith("plan:artifact:")) {
        continue;
      }
      if (event.result.status === "ok") {
        return event.result.value ?? null;
      }
    }
    return undefined;
  }

  /**
   * The same history, with one Plan record's retained value replaced.
   *
   * A continuation reads what the journal holds, and what it holds is not
   * guaranteed to be what this version wrote — a record can be truncated, edited,
   * or written by a build that knew a different protocol. Rewriting it here is how
   * a case asks what the reader does with one it cannot account for.
   */
  function* tampered(
    stream: InMemoryStream,
    prefix: string,
    replace: (value: Json) => Json,
  ): Operation<InMemoryStream> {
    const partial = new InMemoryStream();
    for (const event of yield* stream.readAll()) {
      if (event.type === "close") {
        continue;
      }
      if (
        event.type === "yield" &&
        event.description.name.startsWith(prefix) &&
        event.result.status === "ok"
      ) {
        yield* partial.append({
          ...event,
          result: { status: "ok", value: replace(event.result.value ?? null) },
        });
        continue;
      }
      yield* partial.append(event);
    }
    return partial;
  }

  /** One approved run, whose journal a hostile continuation then reads. */
  function* approvedRun(): Operation<InMemoryStream> {
    const stream = new InMemoryStream();
    const run = yield* runDocument({
      source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join("\n"),
      reply: PLAN,
      stream,
    });
    expect(run.failure).toBe(undefined);
    return stream;
  }

  /** What a continuation reading that history produced. */
  function* continued(stream: InMemoryStream): Operation<Run> {
    return yield* runDocument({
      source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join("\n"),
      reply: PLAN,
      reviews: [],
      stream,
    });
  }

  it("PC19: the emitted source survives the CLI's own output normalization", function* () {
    yield* useWorkingDirectory(function* (dir) {
      // Whitespace the normalizer rewrites in prose: a line ending in spaces,
      // and a run of four newlines. This case owns the presentation path
      // because only a host can install that middleware — the Markdown suite's
      // host installs none, so the same assertion there would hold whether the
      // bypass existed or not.
      const exact = [
        "# Approved program",
        "",
        "This program writes a file when something runs it.   ",
        "",
        "",
        "",
        '<File path="planned.txt">the approved Plan ran</File>',
        "",
      ].join("\n");

      const run = yield* runDocument({
        source: ["<Plan>", "Write a program.", "</Plan>", ""].join("\n"),
        reply: exact,
        normalized: true,
      });

      expect(run.failure).toBe(undefined);
      expect(run.emitted).toContain(exact);
      // And nothing ran it.
      expect((yield* until(readdir(dir))).sort()).toEqual([]);
    });
  });

  it("PO4: neither ordinary form emits a planning phase, whatever verbosity says", function* () {
    /** Every phase heading a run put on the Output Api. */
    const announced = (emitted: string): string[] =>
      emitted.split("\n").filter((line) => line.startsWith("## "));

    yield* useWorkingDirectory(function* (dir) {
      // Bare: the approved source is emitted where the element stands, and it
      // is the whole of what the document said.
      const bare = yield* runDocument({
        source: ["<Plan>", "Write a program.", "</Plan>", ""].join("\n"),
        reply: PLAN,
        normalized: true,
      });

      expect(bare.failure).toBe(undefined);
      expect(bare.emitted).toContain(PLAN);
      expect(announced(bare.emitted)).toEqual([]);
      for (const phase of ["Preparing the Plan", "Drafting the Plan", "Checking the draft"]) {
        expect(`bare: ${bare.emitted.includes(phase)}`).toBe("bare: false");
      }

      // Captured: the same bytes arrive under `as` and the element emits
      // nothing — so a phase written into the capture would be the approved
      // program's first line.
      const captured = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join(
          "\n",
        ),
        reply: PLAN,
        normalized: true,
      });

      expect(captured.failure).toBe(undefined);
      expect(captured.output).toContain(`got: ${PLAN}`);
      expect(announced(captured.emitted)).toEqual([]);
      expect(captured.emitted).not.toContain("Preparing the Plan");

      // Verbosity is the command's sealed fact and reaches neither form: a
      // declaration that carries it still announces nothing here.
      const loud = yield* runDocument({
        source: ["<Plan>", "Write a program.", "</Plan>", ""].join("\n"),
        reply: PLAN,
        normalized: true,
        harness: yield* planDeclarationHarness({
          surface: "component",
          authorshipRoot: yield* authorshipRoot(),
          verbose: true,
        }),
      });

      expect(loud.failure).toBe(undefined);
      expect(announced(loud.emitted)).toEqual([]);

      // The negative control: this exact scenario does announce its phases when
      // the surface is the command's. Absence above is the surface's doing, not
      // a scenario that never reached a phase.
      const command = yield* runDocument({
        source: ["<Plan>", "Write a program.", "</Plan>", ""].join("\n"),
        reply: PLAN,
        normalized: true,
        harness: yield* planDeclarationHarness({
          surface: "command",
          authorshipRoot: yield* authorshipRoot(),
        }),
      });

      expect(command.failure).toBe(undefined);
      expect(announced(command.emitted)).toEqual([
        "## Preparing the Plan",
        "## Drafting the Plan",
        "## Checking the draft",
        "## Waiting for your review",
        "## Finalizing the Plan",
      ]);

      // And nothing any of them produced was ever run.
      expect((yield* until(readdir(dir))).sort()).toEqual([]);
    });
  });

  it("PC20: the retained artifact carries the approved bytes and their digest", function* () {
    yield* useWorkingDirectory(function* () {
      const stream = new InMemoryStream();
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join(
          "\n",
        ),
        reply: PLAN,
        stream,
      });

      expect(run.failure).toBe(undefined);
      // Retained before either form could publish the bytes: all five members,
      // and exactly those five. A sixth would be something a later reader has
      // to account for, and a missing one is a record that cannot be read.
      const artifact = Object(yield* retainedArtifact(stream));
      expect(Object.keys(artifact).sort()).toEqual([
        "admission",
        "digest",
        "instruction",
        "invocation",
        "source",
      ]);
      expect(Reflect.get(artifact, "source")).toBe(PLAN);
      expect(Reflect.get(artifact, "digest")).toBe(sourceDigest(PLAN));
      expect(Reflect.get(artifact, "admission")).toBe("valid");
      expect(typeof Reflect.get(artifact, "invocation")).toBe("string");
      expect(typeof Reflect.get(artifact, "instruction")).toBe("string");
    });
  });

  it("PC21: a stopped Plan leaves no artifact for a later evaluation to begin from", function* () {
    yield* useWorkingDirectory(function* () {
      const stream = new InMemoryStream();
      const run = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join(
          "\n",
        ),
        reply: PLAN,
        reviews: ["Stop"],
        stream,
      });

      expect(run.failure).toBe("Plan authorship stopped at your request. No Plan was returned.");
      expect(run.output).not.toContain("got:");
      expect(run.emitted).not.toContain("# Say hello");
      // Nothing retained, so nothing a later evaluation could restore.
      expect(yield* retainedArtifact(stream)).toBe(undefined);
    });
  });

  it("PC22: a completed Plan restores without authoring or admitting it again", function* () {
    yield* useWorkingDirectory(function* (dir) {
      // A component the first run can resolve and the second cannot. The
      // approved Plan names it, so an admission that ran a second time would
      // refuse these bytes instead of restoring them — which is how this tells
      // restoration apart from a repeat.
      yield* writeTextFile(join(dir, "Widget.md"), "a widget.\n");
      const withWidget = ["# Use the widget", "", "<Widget />", ""].join("\n");
      const source = [
        '<Plan as="approved">Write a program.</Plan>',
        "",
        "got: {approved}",
        "",
      ].join("\n");

      const first = new InMemoryStream();
      const one = yield* runDocument({ source, reply: withWidget, includes: [dir], stream: first });
      expect(one.failure).toBe(undefined);
      expect(one.output).toContain(`got: ${withWidget}`);

      const two = yield* runDocument({
        source,
        reply: "# A different Plan\n\nnot this one.\n",
        reviews: [],
        includes: [],
        stream: yield* continuing(first),
      });

      expect(two.failure).toBe(undefined);
      expect(two.output).toContain(`got: ${withWidget}`);
      expect(two.harness.fake.prompts).toEqual([]);
      expect(two.harness.reviews).toEqual([]);
      expect(two.harness.checked).toEqual([]);
    });
  });

  it("PC23: a continuation replays the retained root, so a changed body never runs", function* () {
    yield* useWorkingDirectory(function* () {
      // The retained-root negative control the story names. A continuation runs
      // the root the journal kept, so a changed authored body is never expanded
      // and is not the changed-instruction case below.
      const first = new InMemoryStream();
      const one = yield* runDocument({
        source: ['<Plan as="approved">Write a program.</Plan>', "", "got: {approved}", ""].join(
          "\n",
        ),
        reply: PLAN,
        stream: first,
      });
      expect(one.failure).toBe(undefined);

      const two = yield* runDocument({
        source: [
          '<Plan as="approved">Write a different program.</Plan>',
          "",
          "second run: {approved}",
          "",
        ].join("\n"),
        reply: PLAN,
        reviews: [],
        stream: yield* continuing(first),
      });

      expect(two.failure).toBe(undefined);
      expect(two.output).not.toContain("second run:");
      expect(two.output).toContain(`got: ${PLAN}`);
    });
  });

  it("PC24: instructions that render differently refuse in the frozen inputs", function* () {
    yield* useWorkingDirectory(function* () {
      // The prompt arrives through props, which is what can actually differ on
      // a continuation: the authored body cannot, per PC23.
      const source = [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    request: { type: string }",
        "  required: [request]",
        "---",
        "",
        '<Plan as="approved">{props.request}</Plan>',
        "",
        "got: {approved}",
        "",
      ].join("\n");

      const root = yield* authorshipRoot();
      const first = new InMemoryStream();
      const one = yield* runDocument({
        source,
        props: { request: "Write a program." },
        root,
        reply: PLAN,
        stream: first,
      });
      expect(one.failure).toBe(undefined);

      const two = yield* runDocument({
        source,
        props: { request: "Write a different program." },
        root,
        reply: PLAN,
        reviews: [],
        stream: yield* continuing(first),
      });

      expect(two.failure).toContain("stale input");
      expect(two.failure).toContain("none was written for the new instructions");
      // Neither the retained Plan nor a newly authored one.
      expect(two.output).not.toContain("# Say hello");
      expect(two.output).not.toContain("got:");
      // Refused in the frozen inputs: before a turn, a review, a check or a
      // session directory existed.
      expect(two.harness.fake.prompts).toEqual([]);
      expect(two.harness.reviews).toEqual([]);
      expect(two.harness.checked).toEqual([]);
      expect(two.leftover).toEqual([]);
    });
  });

  it("PC25: a retained inputs record this version cannot read produces nothing", function* () {
    yield* useWorkingDirectory(function* () {
      // Three ways a record stops being one: a member gone, a member added, and
      // a member of the wrong type. Each is refused with the same fixed
      // sentence, and none of them produces source or a binding.
      const cases: [string, (value: Json) => Json][] = [
        ["the member is missing", () => ({})],
        [
          "a member this version does not know was added",
          (value) => ({ ...Object(value), extra: "surprise" }),
        ],
        ["a member has the wrong type", (value) => ({ ...Object(value), instruction: 7 })],
      ];

      for (const [, replace] of cases) {
        const run = yield* continued(
          yield* tampered(yield* approvedRun(), "plan:inputs:", replace),
        );

        expect(run.failure).toContain("cannot be read as Plan inputs");
        expect(run.output).not.toContain("got:");
        expect(run.output).not.toContain("# Say hello");
        expect(run.emitted).not.toContain("# Say hello");
      }
    });
  });

  it("PC27: the Plan's catalog observation is core's closed record, and a hostile one produces nothing", function* () {
    yield* useWorkingDirectory(function* () {
      const approved = yield* approvedRun();
      // The record is canonical core's, not Plan's: the packaged Component
      // writes the same public `<Syntax />` any document writes, so what a
      // continuation restores is a `syntax_catalog` observation rather than
      // anything this host retained.
      const observation = (yield* approved.readAll()).find(
        (event) => event.type === "yield" && event.description.type === "syntax_catalog",
      );
      expect(observation?.type).toBe("yield");
      if (observation?.type !== "yield" || observation.result.status !== "ok") {
        throw new Error("the approved run retained no catalog observation");
      }
      const value = Object(observation.result.value);
      expect(Object.keys(value)).toEqual(["catalog"]);
      expect(typeof value.catalog).toBe("string");

      const cases: [string, (value: Json) => Json][] = [
        ["the member is missing", () => ({})],
        ["an unknown member was added", (record) => ({ ...Object(record), extra: true })],
        ["the member has the wrong type", () => ({ catalog: 7 })],
      ];

      for (const [, replace] of cases) {
        const run = yield* continued(yield* tampered(approved, "syntax_catalog:", replace));
        expect(run.failure).toContain("retained <Syntax /> catalog is not a catalog");
        expect(run.output).not.toContain("got:");
        expect(run.output).not.toContain("# Say hello");
        expect(run.harness.fake.prompts).toEqual([]);
        expect(run.harness.reviews).toEqual([]);
      }
    });
  });

  it("PC26: a retained artifact this version cannot read produces nothing", function* () {
    yield* useWorkingDirectory(function* () {
      const cases: [string, (value: Json) => Json][] = [
        [
          "a member is missing",
          (value) => {
            const { digest: _digest, ...rest } = Object(value);
            return rest;
          },
        ],
        [
          "a member this version does not know was added",
          (value) => ({ ...Object(value), extra: "surprise" }),
        ],
        ["a member has the wrong type", (value) => ({ ...Object(value), source: 7 })],
        [
          "the admission is not the one this version accepts",
          (value) => ({ ...Object(value), admission: "invalid" }),
        ],
        [
          "the digest does not describe the source it sits beside",
          (value) => ({ ...Object(value), digest: sourceDigest("something else") }),
        ],
        [
          "the record belongs to another invocation",
          (value) => ({ ...Object(value), invocation: "somebody-else" }),
        ],
      ];

      for (const [, replace] of cases) {
        const run = yield* continued(
          yield* tampered(yield* approvedRun(), "plan:artifact:", replace),
        );

        expect(run.failure).toContain("cannot be read as one");
        // No source reached the document either way it could have.
        expect(run.output).not.toContain("got:");
        expect(run.output).not.toContain("# Say hello");
        expect(run.emitted).not.toContain("# Say hello");
      }
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
