/**
 * Tier WB — the component bundle a workflow execution is closed over.
 *
 * A trusted host may hand one execution a fixed set of authored Markdown
 * components read from one pinned Git tree. Two things follow, and everything
 * here is about one of them.
 *
 * **Resolution is closed.** A declared name resolves to its pinned source with
 * no component search path at all, so no file beside the checkout can answer
 * for it and no undeclared name resolves to anything. Core's own components
 * stay available underneath, and nothing the engine or a host already owns can
 * be taken back by a declaration.
 *
 * **Invocation is canonical.** `Component.importComponent` middleware still
 * composes around every import — observing, delegating, and refusing — but the
 * definition a document expands is the one canonical execution produced. A
 * handler that answers without delegating, replaces the answer, or changes it
 * afterwards fails the import before the component runs.
 *
 * The bundle is a value on an `ExecutionInstallation`, so an ordinary
 * `execute()` has none and behaves exactly as it always did.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation, WorkflowBundleComponent } from "../host.ts";
import { registerComponents } from "../src/components/registration.ts";
import { retainedSource } from "../src/root-source.ts";
import type { ComponentDefinition, FunctionComponentDefinition } from "../src/types.ts";

const ROOT_PATH = "workflows/loop.md";

/** A blob object id per component, distinct so a substitution is visible. */
function blob(nth: number): string {
  return `${nth}`.repeat(2).padEnd(40, "0");
}

function component(
  name: string,
  content: string,
  nth: number,
  path = `workflows/${name}.md`,
): WorkflowBundleComponent {
  return { name, path, sourceHash: blob(nth), content };
}

/** The five names the representative authored workflow declares. */
const BUNDLE: readonly WorkflowBundleComponent[] = [
  component("Discovery", "Discovery ran.\n", 1),
  component("Implementation", "Implementation ran.\n", 2),
  component("InstructionFiles", "Instruction files listed.\n", 3),
  component("Planning", "Planning after <Discovery />", 4),
  component("UserCheckpoint", "Checkpoint reached.\n", 5),
];

function installation(components: readonly WorkflowBundleComponent[]): ExecutionInstallation {
  return { bundle: { components } };
}

/** Run one root under a bundle, with no component search path at all. */
function* run(
  source: string,
  components: readonly WorkflowBundleComponent[] = BUNDLE,
  extra: readonly ExecutionInstallation[] = [],
  stream: InMemoryStream = new InMemoryStream(),
): Operation<Json> {
  return yield* collect(
    yield* executeInstalled({ ...retainedSource(ROOT_PATH, source), stream, componentDirs: [] }, [
      installation(components),
      ...extra,
    ]),
  );
}

/** Whether one retained event is a component import. */
function isImport(event: DurableEvent): boolean {
  return event.type === "yield" && event.description.type === "import_component";
}

/**
 * One run's history as a *partial* continuation: every event it recorded except
 * the terminals.
 *
 * A completed journal never enters the durable body at all — its recorded
 * result is returned whole — so a test that replayed one would prove nothing
 * about how a recorded import is read.
 */
function* continuing(
  stream: InMemoryStream,
  rewrite: (event: DurableEvent) => DurableEvent = (event) => event,
): Operation<InMemoryStream> {
  const partial = new InMemoryStream();
  for (const event of yield* stream.readAll()) {
    if (event.type === "close") {
      continue;
    }
    yield* partial.append(rewrite(event));
  }
  return partial;
}

/** What one execution refused with, as a string, or the value it produced. */
function* refusal(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the execution to be refused");
}

describe("Tier WB — a bundled name resolves to its pinned source", () => {
  it("WB1: a declared name resolves with no component search path", function* () {
    expect(yield* run("<Discovery />\n")).toContain("Discovery ran.");
  });

  it("WB2: a bundled component may import another bundled component", function* () {
    const output = yield* run("<Planning />\n");

    expect(output).toContain("Planning after");
    expect(output).toContain("Discovery ran.");
  });

  it("WB3: core's own components stay available underneath the bundle", function* () {
    const output = yield* run(
      ['<Parse schema=\'{"type":"number"}\' as="parsed">7</Parse>', "", "ok: {parsed}", ""].join(
        "\n",
      ),
    );

    expect(output).toContain("ok: 7");
  });

  it("WB4: an undeclared name resolves to nothing at all", function* () {
    // The search path is empty, so the refusal names no directory it could
    // have looked in — which is the point: a workflow reads no checkout.
    expect(yield* refusal(run("<Undeclared />\n"))).toContain(
      "Cannot resolve component: Undeclared",
    );
  });

  it("WB5: a same-named file beside the run is never consulted", function* () {
    // The bundle's source is what renders, and the fixture directory this test
    // runs in holds no `Discovery.md` for it to have preferred instead.
    const output = yield* run("<Discovery />\n", [
      component("Discovery", "the pinned one ran.\n", 1),
    ]);

    expect(output).toContain("the pinned one ran.");
  });

  it("WB6: a declaration cannot take back a name the engine or a host owns", function* () {
    const structural = yield* refusal(run("ok\n", [component("If", "no\n", 1)]));
    expect(structural).toContain("structural syntax");

    const core = yield* refusal(run("ok\n", [component("Parse", "no\n", 1)]));
    expect(core).toContain("a component the engine supplies");

    // The reservation is in place before the execution starts, which is what
    // the refusal is decided against — and it is decided before the root import.
    const host = yield* refusal(
      scoped(function* () {
        yield* registerComponents([
          {
            name: "Guarded",
            origin: "test-host",
            reserved: true,
            props: { type: "object", properties: {}, additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<Json> {
              return "reserved";
            },
          },
        ]);
        return yield* run("ok\n", [component("Guarded", "no\n", 1)]);
      }),
    );
    expect(host).toContain("this host reserved");
  });

  it("WB7: one execution runs under one bundle", function* () {
    const message = yield* refusal(
      run("ok\n", BUNDLE, [installation([component("Other", "other\n", 9)])]),
    );

    expect(message).toContain("two installations supplied a workflow component bundle");
  });

  it("WB8: a refusal reaches the caller before the root document is imported", function* () {
    const stream = new InMemoryStream();
    yield* refusal(run("<Discovery />\n", [component("If", "no\n", 1)], [], stream));

    expect(yield* stream.readAll()).toEqual([]);
  });
});

describe("Tier WB — public import middleware cannot widen a bundle", () => {
  /** A document that renders a marker after the invocation under test. */
  const AFTER = "<Discovery />\n\nafter\n";

  it("WB9: middleware observes and delegates exactly as it always did", function* () {
    const seen: string[] = [];
    const output = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name, position], next) {
          seen.push(name);
          return yield* next(name, position);
        },
      });
      return yield* run(AFTER);
    });

    expect(seen).toEqual(["__root__", "Discovery"]);
    expect(output).toContain("Discovery ran.");
    expect(output).toContain("after");
  });

  it("WB10: a middleware refusal is still a refusal", function* () {
    const output = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name, position], next) {
          if (name === "Discovery") {
            throw new Error("the host refused this import");
          }
          return yield* next(name, position);
        },
      });
      return yield* refusal(run(AFTER));
    });

    expect(output).toContain("the host refused this import");
    expect(output).not.toContain("Discovery ran.");
  });

  it("WB11: a synthetic answer, a replacement, and a mutation each fail", function* () {
    const synthetic: ComponentDefinition = {
      kind: "markdown",
      name: "Discovery",
      path: "workflows/Discovery.md",
      meta: {},
      props: { type: "object", properties: {}, additionalProperties: false },
      bodySegments: [{ type: "text", content: "the handler's own body.\n" }],
    };

    const shortCircuit = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name, position], next) {
          return name === "Discovery" ? synthetic : yield* next(name, position);
        },
      });
      return yield* refusal(run(AFTER));
    });
    expect(shortCircuit).toContain("canonical execution did not produce");
    expect(shortCircuit).not.toContain("the handler's own body.");

    const replaced = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name, position], next) {
          const answer = yield* next(name, position);
          return name === "Discovery" ? synthetic : answer;
        },
      });
      return yield* refusal(run(AFTER));
    });
    expect(replaced).toContain("canonical execution did not produce");

    const mutated = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name, position], next) {
          const answer = yield* next(name, position);
          if (name === "Discovery" && answer.kind === "markdown") {
            answer.bodySegments = synthetic.bodySegments;
          }
          return answer;
        },
      });
      return yield* refusal(run(AFTER));
    });
    expect(mutated).toContain("changed the definition canonical execution produced");
    expect(mutated).not.toContain("the handler's own body.");

    // Every one of them still stopped at the import: the rest of the document
    // is work the failed invocation did not authorize.
    for (const output of [shortCircuit, replaced, mutated]) {
      expect(output).not.toContain("Discovery ran.");
    }
  });

  it("WB12: an answer produced for another component is not this component's", function* () {
    const output = yield* scoped(function* () {
      const held: { definition?: ComponentDefinition | FunctionComponentDefinition } = {};
      yield* Component.around({
        *importComponent([name, position], next) {
          const answer = yield* next(name, position);
          if (name === "Discovery") {
            held.definition = answer;
            return answer;
          }
          if (name === "UserCheckpoint" && held.definition !== undefined) {
            return held.definition;
          }
          return answer;
        },
      });
      return yield* refusal(run("<Discovery />\n\n<UserCheckpoint />\n"));
    });

    expect(output).toContain("produced for another component");
    expect(output).not.toContain("Checkpoint reached.");
  });

  it("WB13: an undeclared name cannot be answered by a handler either", function* () {
    const output = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name, position], next) {
          if (name !== "Undeclared") {
            return yield* next(name, position);
          }
          return {
            kind: "markdown",
            name,
            path: "Undeclared.md",
            meta: {},
            props: { type: "object", properties: {}, additionalProperties: false },
            bodySegments: [{ type: "text", content: "the handler's own body.\n" }],
          };
        },
      });
      return yield* refusal(run("<Undeclared />\n"));
    });

    expect(output).toContain("canonical execution did not produce");
    expect(output).not.toContain("the handler's own body.");
  });

  it("WB14: two concurrent bundles declaring one name stay each other's strangers", function* () {
    const first = [component("Stage", "first source.\n", 1, "workflows/a/Stage.md")];
    const second = [component("Stage", "second source.\n", 2, "workflows/b/Stage.md")];
    const outputs: string[] = [];

    yield* scoped(function* () {
      const left = yield* spawn(() => run("<Stage />\n", first));
      const right = yield* spawn(() => run("<Stage />\n", second));
      outputs.push(String(yield* left), String(yield* right));
    });

    expect(outputs[0]).toContain("first source.");
    expect(outputs[0]).not.toContain("second source.");
    expect(outputs[1]).toContain("second source.");
    expect(outputs[1]).not.toContain("first source.");
  });

  it("WB15: an ordinary execution installs no authority at all", function* () {
    const output = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name, position], next) {
          if (name !== "Anything") {
            return yield* next(name, position);
          }
          return {
            kind: "markdown",
            name,
            path: "Anything.md",
            meta: {},
            props: { type: "object", properties: {}, additionalProperties: false },
            bodySegments: [{ type: "text", content: "the handler answered.\n" }],
          };
        },
      });
      return yield* collect(
        yield* execute({
          ...retainedSource(ROOT_PATH, "<Anything />\n"),
          stream: new InMemoryStream(),
          componentDirs: [],
        }),
      );
    });

    expect(output).toContain("the handler answered.");
  });
});

describe("Tier WB — what a bundled import records", () => {
  it("WB16: one selection per import, holding exactly four members", function* () {
    const stream = new InMemoryStream();
    yield* run("<Discovery />\n", BUNDLE, [], stream);

    const events = yield* stream.readAll();
    const selection = events.find(
      (event) =>
        event.type === "yield" &&
        event.description.type === "import_component" &&
        event.description.name === "Discovery",
    );

    expect(selection?.type).toBe("yield");
    expect(selection?.type === "yield" && selection.result).toEqual({
      status: "ok",
      value: {
        kind: "workflow",
        path: "workflows/Discovery.md",
        sourceHash: blob(1),
        content: "Discovery ran.\n",
      },
    });
  });

  it("WB17: an exact replay reconstructs the component from its own record", function* () {
    const stream = new InMemoryStream();
    yield* run("<Discovery />\n", BUNDLE, [], stream);

    // The run's own history without its terminals, so the resumed execution
    // replays the recorded import rather than reusing a recorded result.
    const partial = yield* continuing(stream);
    const before = (yield* partial.readAll()).filter(isImport).length;

    // The bundle now holds different source under the same name. What renders
    // is the recorded source, because an exact replay reconstructs the
    // component from its own record and resolves nothing.
    const output = yield* run(
      "<Discovery />\n",
      [component("Discovery", "a later source.\n", 1)],
      [],
      partial,
    );

    expect(output).toContain("Discovery ran.");
    expect(output).not.toContain("a later source.");
    expect((yield* partial.readAll()).filter(isImport).length).toBe(before);
  });

  it("WB18: a recorded selection this version cannot read is a fixed diagnostic", function* () {
    const stream = new InMemoryStream();
    yield* run("<Discovery />\n", BUNDLE, [], stream);

    const planted = yield* continuing(stream, (event) =>
      isImport(event) && event.type === "yield" && event.description.name === "Discovery"
        ? {
            ...event,
            result: {
              status: "ok",
              value: { kind: "workflow", path: "workflows/Discovery.md", sourceHash: blob(1) },
            },
          }
        : event,
    );

    const output = yield* refusal(run("<Discovery />\n", BUNDLE, [], planted));
    expect(output).toContain("A recorded component import cannot be read by this version.");
    expect(output).not.toContain("Discovery ran.");
  });
});
