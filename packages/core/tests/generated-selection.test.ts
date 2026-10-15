/**
 * Tier GS — the component forms a host offers generated XMD (spec §5.3.2).
 *
 * `Component.generated` is the whole of what a trusted host contributes to
 * generated evaluation: component names and authored forms. Everything else —
 * the identity each spelling runs under, what its props are validated against,
 * whether it observes or mutates, what documents it — comes from the
 * declaration that owns the implementation.
 *
 * So the rows here are about the three things only canonical execution can do
 * with that answer: read it once and validate all of it, resolve each selected
 * name once before public execution policy can replace anything, and retain the
 * implementation and its metadata together.
 *
 * Every row drives a real execution through the public `<Evaluate>`. Where a
 * refusal is expected the row also asks what did *not* happen — no policy, no
 * root import, no producer, no effect — because a selection core could not
 * capture must leave no partial allowance anywhere in the execution.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createApi } from "@effectionx/context-api";
import { ensure, resource, scoped, until, useScope } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";

import { collect } from "../src/collect.ts";
import { Component } from "../src/component-api.ts";
import type { GeneratedSelection } from "../src/component-api.ts";
import { Execution } from "../api.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation } from "../host.ts";
import { registerComponents } from "../src/components/registration.ts";
import { retainedSource } from "../src/root-source.ts";
import { recordedFiles, useRecordedFiles } from "./support/fragment-files.ts";
import type { RecordedFiles } from "./support/fragment-files.ts";
import { answerProvider, implementation } from "./support/answer-provider.ts";
import { useSelection } from "./support/generated-selection.ts";
import type { ComponentDefinition, FunctionComponentDefinition } from "../src/types.ts";

const ROOT_PATH = "selection.md";
const NOTE = "the retained note\n";

/** One document, run under one selection. */
interface Attempt {
  output?: string;
  failure?: string;
  events: DurableEvent[];
}

/**
 * Run one document with this selection offered in the executing scope.
 *
 * `offered` is passed as the contextual answer rather than through an
 * installation, because that is what a host composes: there is no installation
 * member for it, and core reads the final answer of the chain once.
 */
function run(
  source: string,
  options: {
    offered?: unknown;
    installations?: readonly ExecutionInstallation[];
    files?: RecordedFiles;
    events?: DurableEvent[];
    around?: () => Operation<void>;
    /** What the *host* supplies, before any policy has seen the request. */
    includes?: readonly string[];
  } = {},
): Operation<Attempt> {
  return scoped(function* () {
    const stream = new InMemoryStream(options.events ?? []);
    if (options.files !== undefined) {
      yield* useRecordedFiles(options.files);
    }
    if (options.offered !== undefined) {
      // Deliberately untyped at the seam: a host crosses this boundary from
      // JavaScript, so the rows that state a malformed selection state one.
      const stated = options.offered;
      yield* Component.around({ generated: () => stated as GeneratedSelection });
    }
    if (options.around !== undefined) {
      yield* options.around();
    }
    try {
      const output = yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(ROOT_PATH, source),
            stream,
            includes: [...(options.includes ?? [])],
          },
          [...(options.installations ?? [])],
        ),
      );
      return { output: String(output), events: yield* stream.readAll() };
    } catch (error) {
      return {
        failure: error instanceof Error ? error.message : String(error),
        events: yield* stream.readAll(),
      };
    }
  });
}

/** One fragment, as the authored element that evaluates it. */
function evaluating(fragment: string, allow: readonly string[] = ["read"]): string {
  return (
    `<Evaluate text={${JSON.stringify(fragment)}} allow={${JSON.stringify(allow)}} ` +
    `as="answer" />\n\n<Json value={answer} />\n`
  );
}

/** The paired producer form, which renders the program it then runs. */
function producing(fragment: string): string {
  return (
    `<Evaluate allow={["read"]} as="answer">\n<Produce text={${JSON.stringify(fragment)}} />\n` +
    `</Evaluate>\n\n<Json value={answer} />\n`
  );
}

/** A component that renders the program a producer form supplies. */
function useProducer(produced: string[]): Operation<void> {
  return registerComponents([
    {
      name: "Produce",
      origin: "test://produce",
      props: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        produced.push(String(props.text));
        return String(props.text);
      },
    },
  ]);
}

/** A directory holding one Markdown component, reachable only by search path. */
function useComponentDirectory(): Operation<string> {
  return resource<string>(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "xmd-u5-includes-")));
    yield* ensure(function* () {
      yield* rm(dir, { recursive: true, force: true });
    });
    yield* writeTextFile(join(dir, "Replaced.md"), "REPLACED-COMPONENT\n");
    yield* provide(dir);
  });
}

function admissions(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

function rootImports(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) =>
      event.type === "yield" &&
      event.description.type === "import_component" &&
      event.description.name === "__root__",
  );
}

describe("Tier GS — the property and its default", () => {
  it("U5-1: the default is absent, and a document that writes no `<Evaluate>` runs", function* () {
    const read = yield* scoped(function* () {
      return yield* Component.operations.generated;
    });
    expect(read).toBe(undefined);

    const attempt = yield* run("The document wrote no fragment.\n");
    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("The document wrote no fragment.");
    expect(admissions(attempt.events)).toHaveLength(0);
  });

  it("U5-1: a same-name Component descriptor answers the same default", function* () {
    // The property is a value member of the stable `Component` Api, so a second
    // descriptor built with the same name shares every installed handler and
    // owns its own default. With nothing installed, both answer absence.
    const other = createApi<{ generated: GeneratedSelection | undefined }>("Component", {
      generated: undefined,
    });
    expect(yield* other.operations.generated).toBe(undefined);
    expect(yield* Component.operations.generated).toBe(undefined);
  });

  it("U5-1: an absent selection refuses a paired `<Evaluate>` before its producer runs", function* () {
    const produced: string[] = [];

    const attempt = yield* run(producing(`<File path="notes.md" />\n`), {
      around: () => useProducer(produced),
    });

    expect(attempt.failure).toContain("no generated components here");
    // The producer renders the program, so a refusal that happened after it
    // would have run an Agent turn for a fragment nothing could admit.
    expect(produced).toEqual([]);
    expect(admissions(attempt.events)).toHaveLength(0);
  });
});

describe("Tier GS — a selection core cannot capture refuses setup", () => {
  /** Every malformed selection a host can offer, and the word it refuses with. */
  const MALFORMED: readonly (readonly [string, unknown, string])[] = [
    ["an empty selection", {}, "selected no component"],
    ["a selection that is not a map", ["File"], "other than a map"],
    ["a name that is not a component name", { "not a name": ["self-closing"] }, "component name"],
    ["a form list that is not a list", { File: "self-closing" }, "other than a list"],
    ["an empty form list", { File: [] }, "the accepted declarations are"],
    ["a form this engine does not have", { File: ["either"] }, "not an authored form"],
    ["one form written twice", { File: ["paired", "paired"] }, "the accepted declarations are"],
    [
      "a reversed pair",
      { File: ["paired", "self-closing"] },
      "a pair is written self-closing first",
    ],
    ["a name nothing resolves", { Absent: ["self-closing"] }, "Cannot resolve component"],
    [
      "a spelling its owner offers no generated use of",
      { "File.Delete": ["paired"] },
      "offers no generated use of it",
    ],
    ["a name core's own composition holds", { Json: ["self-closing"] }, "trusted composition"],
  ];

  for (const [what, offered, diagnostic] of MALFORMED) {
    it(`U5-1: ${what} refuses before policy, the root import and any effect`, function* () {
      const files = recordedFiles({ "notes.md": NOTE });
      const policy: string[] = [];
      const produced: string[] = [];

      const attempt = yield* run(producing(`<File path="notes.md" />\n`), {
        offered,
        files,
        *around(): Operation<void> {
          yield* useProducer(produced);
          yield* Execution.around({
            *execute([request], next) {
              policy.push("execute");
              yield* next(request);
            },
          });
        },
      });

      expect([what, attempt.failure ?? ""]).toEqual([what, expect.stringContaining(diagnostic)]);
      // Nothing after setup happened: no public execution policy, no root
      // import, no producer, no effect and no admission.
      expect([what, policy]).toEqual([what, []]);
      expect([what, rootImports(attempt.events)]).toEqual([what, []]);
      expect([what, produced]).toEqual([what, []]);
      expect([what, files.performed]).toEqual([what, []]);
      expect([what, admissions(attempt.events)]).toEqual([what, []]);
    });
  }

  it("U5-1: a valid selection is the control every refusal above is measured against", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const policy: string[] = [];
    const produced: string[] = [];

    const attempt = yield* run(producing(`<File path="notes.md" />\n`), {
      offered: { File: ["self-closing"] },
      files,
      *around(): Operation<void> {
        yield* useProducer(produced);
        yield* Execution.around({
          *execute([request], next) {
            policy.push("execute");
            yield* next(request);
          },
        });
      },
    });

    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("the retained note");
    expect(policy).toEqual(["execute"]);
    expect(rootImports(attempt.events)).toHaveLength(1);
    expect(produced).toHaveLength(1);
    expect(files.performed).toEqual(["read notes.md"]);
    expect(admissions(attempt.events)).toHaveLength(1);
  });

  it("U5-1: a mixed valid and invalid selection installs no partial allowance", function* () {
    const files = recordedFiles({ "notes.md": NOTE });

    // One name this host could legitimately offer, and one it could not. The
    // batch is validated whole, so the valid member is not installed on its
    // own: nothing is filtered, repaired, or kept.
    const attempt = yield* run(evaluating(`<File path="notes.md" />\n`), {
      offered: { File: ["self-closing"], "not a name": ["self-closing"] },
      files,
    });

    expect(attempt.failure).toContain("component name");
    expect(files.performed).toEqual([]);
    expect(admissions(attempt.events)).toHaveLength(0);
  });
});

describe("Tier GS — the selection is read once, before public policy", () => {
  it("U5-2: init and the installation callbacks settle the selection before it is read", function* () {
    const order: string[] = [];
    const files = recordedFiles({ "notes.md": NOTE });

    const attempt = yield* run(evaluating(`<File path="notes.md" />\n`), {
      installations: [
        {
          *install(): Operation<void> {
            order.push("install");
            // Offered here, and observed where core reads it: the handler
            // records the read so the row can state *when* it happened rather
            // than only what it answered.
            yield* Component.around({
              generated: (_args, next) => {
                order.push("read");
                return next();
              },
            });
            yield* useSelection({ File: ["self-closing"] });
          },
        },
      ],
      files,
      *around(): Operation<void> {
        yield* Execution.around({
          *init(_args, next) {
            order.push("init");
            yield* next();
          },
          *execute([request], next) {
            order.push("policy");
            // The selection is already captured. A policy that offers a broader
            // one changes nothing: it is composing into a chain core has
            // already read its one answer from.
            yield* Component.around({
              generated: () => ({ File: ["self-closing", "paired"], Glob: ["self-closing"] }),
            });
            yield* next(request);
          },
        });
      },
    });

    expect(attempt.failure).toBe(undefined);
    // The order is the contract: initialization and the captured installation
    // callbacks assemble the host, then core reads the selection once, and only
    // then does public execution policy run. A read that happened after the
    // policy would be reading a chain the policy had already composed into.
    expect(order).toEqual(["init", "install", "read", "policy"]);
    // The fragment reached the read it was offered.
    expect(files.performed).toEqual(["read notes.md"]);
    // And not the vocabulary the policy tried to add: a widened selection after
    // capture is a selection nothing reads.
    const widened = yield* run(evaluating(`<Glob include={["*.md"]} as="paths" />\n`), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ File: ["self-closing"] });
          },
        },
      ],
      *around(): Operation<void> {
        yield* Execution.around({
          *execute([request], next) {
            yield* Component.around({ generated: () => ({ Glob: ["self-closing"] }) });
            yield* next(request);
          },
        });
      },
    });
    expect(widened.failure).toContain("did not admit");
  });

  it("U5-2: one property read and one import per selected name", function* () {
    const reads: string[] = [];
    const lookups: string[] = [];
    const files = recordedFiles({ "notes.md": NOTE });

    const attempt = yield* run(evaluating(`<File path="notes.md" />\n<File path="notes.md" />\n`), {
      files,
      installations: [
        {
          *install(): Operation<void> {
            yield* Component.around({
              generated: (_args, next) => {
                reads.push("generated");
                return next();
              },
              *importComponent([name, position], next) {
                lookups.push(name);
                return yield* next(name, position);
              },
            });
            yield* useSelection({ File: ["self-closing", "paired"] });
          },
        },
      ],
    });

    expect(attempt.failure).toBe(undefined);
    // One read of the property for the whole execution.
    expect(reads).toEqual(["generated"]);
    // And one *resolution* for `File`, however many spellings were selected:
    // capture resolves the name once, before the root import, and one name is
    // one component. The generated imports the fragment then makes are observed
    // through the same chain and answered by canonical execution, so they are
    // not resolutions — which is why the count is taken at the boundary rather
    // than over the whole run.
    const resolved = lookups.slice(0, lookups.indexOf("__root__"));
    expect(resolved).toEqual(["File"]);
    // The fragment wrote the name twice and performed both reads, so the single
    // resolution is not a fragment that ran nothing.
    expect(lookups.filter((name) => name === "File")).toHaveLength(3);
    expect(files.performed).toEqual(["read notes.md", "read notes.md"]);
  });

  it("U5-2: a policy's search-path replacement reaches authored imports, not the capture", function* () {
    // The one search path a document here can import a component from, and the
    // host supplies none of it: everything authored resolves through whatever
    // the accepted request names.
    const dir = yield* useComponentDirectory();
    const files = recordedFiles({ "notes.md": NOTE });

    const attempt = yield* run(`<Replaced />\n\n${evaluating(`<File path="notes.md" />\n`)}`, {
      files,
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ File: ["self-closing"] });
          },
        },
      ],
      *around(): Operation<void> {
        yield* Execution.around({
          *execute([request], next) {
            // A supported policy change, made before delegating. The options
            // the terminal accepts are the ones the document is executed
            // under, so this is where its authored imports resolve from.
            yield* next(request.withOptions({ ...request.options, includes: [dir] }));
          },
        });
      },
    });

    expect(attempt.failure).toBe(undefined);
    // The authored import resolved through the replaced path. Without the
    // accepted options reaching ordinary resolution there is nowhere for
    // `<Replaced />` to come from.
    expect(attempt.output).toContain("REPLACED-COMPONENT");
    // And the capture is untouched by it: the fragment wrote the one spelling
    // the host selected, resolved before the policy ran.
    expect(files.performed).toEqual(["read notes.md"]);

    // The other half: a path a policy added is not a vocabulary a fragment
    // gained. `<Replaced />` is importable by the *document* and admitted for
    // nothing.
    const widened = yield* run(evaluating(`<Replaced />\n`), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ File: ["self-closing"] });
          },
        },
      ],
      *around(): Operation<void> {
        yield* Execution.around({
          *execute([request], next) {
            yield* next(request.withOptions({ ...request.options, includes: [dir] }));
          },
        });
      },
    });
    expect(widened.failure).toContain("did not admit");
  });

  it("U5-2: a later ordinary authored registration still behaves contextually", function* () {
    const told: string[] = [];

    // The selection is captured; an ordinary registration a document policy
    // makes afterwards is an ordinary registration, visible to the authored
    // document exactly as it always was.
    const attempt = yield* run("<Later />\n", {
      offered: { File: ["self-closing"] },
      *around(): Operation<void> {
        yield* Execution.around({
          *execute([request], next) {
            yield* registerComponents([
              {
                name: "Later",
                origin: "test://later",
                props: { type: "object", properties: {}, additionalProperties: false },
                // deno-lint-ignore require-yield
                *fn(): Operation<string> {
                  told.push("later ran");
                  return "the later registration ran";
                },
              },
            ]);
            yield* next(request);
          },
        });
      },
    });

    expect(attempt.failure).toBe(undefined);
    expect(told).toEqual(["later ran"]);
    expect(attempt.output).toContain("the later registration ran");
  });
});

describe("Tier GS — what a selected name resolves to", () => {
  it("U5-3: a registered function and a published provider answer both run", function* () {
    const ran: string[] = [];
    const A = implementation("Open", "the provider's answer ran");

    const attempt = yield* run(evaluating("<Local />\n<Open />\n"), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ Local: ["self-closing"], Open: ["self-closing"] });
            yield* registerComponents([localComponent(ran)]);
          },
          componentAnswers: [answerProvider("Open", A.definition)],
        },
      ],
    });

    expect(attempt.failure).toBe(undefined);
    expect(ran).toEqual(["local ran"]);
    expect(attempt.output).toContain("the local registration ran");
    expect(attempt.output).toContain("the provider's answer ran");
  });

  it("U5-3: an unpublished replacement refuses", function* () {
    const ran: string[] = [];
    const replacement: FunctionComponentDefinition = {
      kind: "function",
      name: "Local",
      props: { type: "object", properties: {}, additionalProperties: false },
      forms: ["self-closing"],
      generated: {
        "self-closing": {
          identity: "https://executable.md/components/local/read",
          effect: "read",
        },
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        ran.push("replacement ran");
        return "the replacement ran";
      },
    };

    // Ordinary import middleware answering with its own definition, publishing
    // nothing. It is a valid ordinary answer and it is not an implementation
    // this execution may retain for a selected name.
    const attempt = yield* run(evaluating("<Local />\n"), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ Local: ["self-closing"] });
            yield* registerComponents([localComponent(ran)]);
            yield* Component.around({
              *importComponent([name, position], next) {
                return name === "Local" ? replacement : yield* next(name, position);
              },
            });
          },
        },
      ],
    });

    expect(attempt.failure).toContain("neither canonical resolution's own answer");
    expect(ran).toEqual([]);
  });

  it("U5-3: a replacement offering no generated use of the selected spelling refuses", function* () {
    const ran: string[] = [];

    const attempt = yield* run(evaluating("<Open />\n"), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ Open: ["self-closing"] });
          },
          componentAnswers: [
            answerProvider("Open", {
              kind: "function",
              name: "Open",
              props: { type: "object", properties: {}, additionalProperties: false },
              forms: ["self-closing"],
              // deno-lint-ignore require-yield
              *fn(): Operation<string> {
                ran.push("unoffered ran");
                return "the unoffered answer ran";
              },
            }),
          ],
        },
      ],
    });

    expect(attempt.failure).toContain("offers no generated use of it");
    expect(ran).toEqual([]);
  });

  it("U5-3: an unsupported answer refuses", function* () {
    // A repository Markdown component is a legitimate answer for an authored
    // import and is not something a generated fragment can be given: there is
    // no implementation to invoke and no declaration to read an identity off.
    const attempt = yield* run(evaluating("<Markdowny />\n"), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ Markdowny: ["self-closing"] });
            yield* Component.around({
              *importComponent([name, position], next) {
                if (name !== "Markdowny") {
                  return yield* next(name, position);
                }
                return markdownAnswer();
              },
            });
          },
        },
      ],
    });

    expect(attempt.failure).toBeDefined();
    expect(attempt.failure).not.toContain("rendered");
  });

  it("U5-3: a definition edited after publication cannot be rebaselined", function* () {
    const ran: string[] = [];
    const definition: FunctionComponentDefinition = {
      kind: "function",
      name: "Edited",
      props: { type: "object", properties: {}, additionalProperties: false },
      forms: ["self-closing"],
      generated: {
        "self-closing": {
          identity: "https://executable.md/components/edited/read",
          effect: "read",
        },
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        ran.push("edited ran");
        return "the edited answer ran";
      },
    };

    const attempt = yield* run(evaluating("<Edited />\n"), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ Edited: ["self-closing"] });
          },
          componentAnswers: [
            {
              origin: "test://edited",
              *install(registrar): Operation<void> {
                yield* registrar.around(function* (request, next) {
                  if (request.name !== "Edited") {
                    return yield* next();
                  }
                  const published = request.answer(definition);
                  // Published, and then edited in place. What the execution
                  // retained is the copy taken at publication, so this reaches
                  // nothing — and the answer the chain is now holding no longer
                  // describes what was published, which refuses.
                  Object.assign(definition, {
                    generated: {
                      "self-closing": {
                        identity: "https://executable.md/components/edited/write",
                        effect: "write",
                      },
                    },
                  });
                  return published;
                });
              },
            },
          ],
        },
      ],
    });

    expect(attempt.failure).toBeDefined();
    expect(ran).toEqual([]);
    expect(admissions(attempt.events)).toHaveLength(0);
  });

  it("U5-3: accessor-backed metadata is refused before it can answer twice", function* () {
    const readings: string[] = [];
    // A declaration whose metadata would answer one thing while it is validated
    // and another when it is read again. The reading that was validated is the
    // reading that is retained, so a value that behaved once is not a value
    // this execution may retain — and it never gets a second turn to prove it.
    const definition = {
      kind: "function" as const,
      name: "Shifty",
      props: { type: "object", properties: {}, additionalProperties: false },
      forms: ["self-closing"] as const,
      get generated() {
        readings.push("read");
        return readings.length === 1
          ? {
              "self-closing": {
                identity: "https://executable.md/components/shifty/read",
                effect: "read" as const,
              },
            }
          : {
              "self-closing": {
                identity: "https://executable.md/components/shifty/write",
                effect: "write" as const,
              },
            };
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        return "the shifty answer ran";
      },
    };

    const attempt = yield* run(evaluating("<Shifty />\n"), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ Shifty: ["self-closing"] });
          },
          componentAnswers: [answerProvider("Shifty", definition)],
        },
      ],
    });

    expect(attempt.failure).toBeDefined();
    expect(attempt.output ?? "").not.toContain("the shifty answer ran");
    expect(admissions(attempt.events)).toHaveLength(0);
    // At most one reading, which is the whole of the protection: what the check
    // was made about is what would have been retained, and the second answer
    // this accessor was waiting to give is never asked for.
    expect(readings.length).toBeLessThanOrEqual(1);
  });

  it("U5-3: the retained admission holds the identity the owner declared", function* () {
    const ran: string[] = [];

    // The positive control for the two refusals above: an ordinary declaration
    // is retained with the URL its own metadata states, and that is the row the
    // admission records.
    const attempt = yield* run(evaluating("<Local />\n"), {
      installations: [
        {
          *install(): Operation<void> {
            yield* useSelection({ Local: ["self-closing"] });
            yield* registerComponents([localComponent(ran)]);
          },
        },
      ],
    });

    expect(attempt.failure).toBe(undefined);
    expect(ran).toEqual(["local ran"]);
    const admission = admissions(attempt.events)[0];
    expect(JSON.stringify(admission)).toContain("https://executable.md/components/local/read");
    yield* useScope();
  });
});

/** A Markdown definition, which is a legitimate answer and not an invocable one. */
function markdownAnswer(): ComponentDefinition {
  return {
    kind: "markdown",
    name: "Markdowny",
    path: "Markdowny.md",
    meta: {},
    props: { type: "object", properties: {}, additionalProperties: false },
    bodySegments: [],
  };
}

/** One ordinary registration a selection may name. */
function localComponent(ran: string[]): FunctionComponentDefinition & { origin: string } {
  return {
    kind: "function",
    name: "Local",
    origin: "test://local",
    props: { type: "object", properties: {}, additionalProperties: false },
    forms: ["self-closing"],
    generated: {
      "self-closing": { identity: "https://executable.md/components/local/read", effect: "read" },
    },
    // deno-lint-ignore require-yield
    *fn(): Operation<string> {
      ran.push("local ran");
      return "the local registration ran";
    },
  };
}
