/**
 * Tier WBA — holding a retained history to the component bundle.
 *
 * `workflowBundleInstallation()` carries two halves of one fact. Live import
 * resolves a declared name to its pinned source, which core owns. Retained
 * history is held to the same components *before* any of it is replayed from,
 * which is what this suite drives.
 *
 * The admission runs inside canonical core's own journal read: ahead of public
 * replay policy, of any retained effect reaching execution, of a retained
 * terminal result being reused, and of every append. So a refusal here leaves
 * the journal exactly as it was and invokes nothing — which is what each case
 * below asserts alongside the refusal itself.
 *
 * Every diagnostic is fixed. What a history recorded is journal data, and a
 * message that quoted a planted name, path, or source would publish the value
 * it exists to reject.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { collect, retainedSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation, WorkflowBundleComponent } from "@executablemd/core/host";
import { workflowBundleInstallation } from "../mod.ts";

const ROOT_PATH = "workflows/loop.md";
const ROOT = "<Discovery />\n";

function blob(nth: number): string {
  return `${nth}`.repeat(2).padEnd(40, "0");
}

const DISCOVERY: WorkflowBundleComponent = {
  name: "Discovery",
  path: "workflows/Discovery.md",
  sourceHash: blob(1),
  content: "Discovery ran.\n",
};

const PLANNING: WorkflowBundleComponent = {
  name: "Planning",
  path: "workflows/Planning.md",
  sourceHash: blob(2),
  content: "Planning ran.\n",
};

const BUNDLE: readonly WorkflowBundleComponent[] = [DISCOVERY, PLANNING];

function* run(
  source: string,
  stream: DurableStream,
  components: readonly WorkflowBundleComponent[] = BUNDLE,
  extra: readonly ExecutionInstallation[] = [],
): Operation<Json> {
  return yield* collect(
    yield* executeInstalled({ ...retainedSource(ROOT_PATH, source), stream, componentDirs: [] }, [
      workflowBundleInstallation(components),
      ...extra,
    ]),
  );
}

function isImport(event: DurableEvent, name?: string): boolean {
  return (
    event.type === "yield" &&
    event.description.type === "import_component" &&
    (name === undefined || event.description.name === name)
  );
}

/**
 * One completed run's history, minus its terminals, so a second execution
 * replays what it recorded instead of reusing a recorded result.
 */
function* continuing(
  source: string,
  rewrite: (event: DurableEvent) => DurableEvent = (event) => event,
): Operation<InMemoryStream> {
  const first = new InMemoryStream();
  yield* run(source, first);
  const partial = new InMemoryStream();
  for (const event of yield* first.readAll()) {
    if (event.type !== "close") {
      yield* partial.append(rewrite(event));
    }
  }
  return partial;
}

/** Replace the recorded Discovery selection with `value`. */
function planting(value: unknown): (event: DurableEvent) => DurableEvent {
  return (event) =>
    isImport(event, "Discovery")
      ? { ...(event as DurableEvent & { type: "yield" }), result: { status: "ok", value } as never }
      : event;
}

/** What a refused execution reported, and what it did to the journal. */
function* refused(
  stream: DurableStream,
  retained?: number,
): Operation<{ message: string; appended: number }> {
  const before = retained ?? (yield* stream.readAll()).length;
  try {
    yield* run(ROOT, stream);
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      appended: (yield* stream.readAll()).length - before,
    };
  }
  throw new Error("expected the retained history to be refused");
}

describe("Tier WBA — a retained history is held to the bundle", () => {
  it("WBA1: a history recording exactly this bundle replays", function* () {
    const partial = yield* continuing(ROOT);
    const before = (yield* partial.readAll()).filter((event) => isImport(event)).length;

    expect(yield* run(ROOT, partial)).toContain("Discovery ran.");
    expect((yield* partial.readAll()).filter((event) => isImport(event)).length).toBe(before);
  });

  it("WBA2: a changed name, path, hash, or content is refused", function* () {
    const cases: Array<{ says: string; value: Record<string, unknown> }> = [
      {
        says: "path",
        value: { ...selection(DISCOVERY), path: "workflows/Elsewhere.md" },
      },
      { says: "hash", value: { ...selection(DISCOVERY), sourceHash: blob(9) } },
      { says: "content", value: { ...selection(DISCOVERY), content: "something else.\n" } },
    ];

    for (const { says, value } of cases) {
      const planted = yield* continuing(ROOT, planting(value));
      const outcome = yield* refused(planted);
      expect({ says, message: outcome.message, appended: outcome.appended }).toEqual({
        says,
        message:
          "A retained component import does not match the component this run's bundle holds.",
        appended: 0,
      });
    }

    // A name change is a name the bundle does not declare at all, which is its
    // own refusal: nothing about the entry it claims to be is even consulted.
    const renamed = yield* continuing(ROOT, (event) =>
      isImport(event, "Discovery")
        ? {
            ...(event as DurableEvent & { type: "yield" }),
            description: { type: "import_component", name: "Unknown" },
          }
        : event,
    );
    expect((yield* refused(renamed)).message).toBe(
      "A retained component import names a component this run's bundle does not declare.",
    );
  });

  it("WBA3: a declared name recorded as anything else is refused", function* () {
    const planted = yield* continuing(
      ROOT,
      planting({ kind: "registered", origin: "@executablemd/core", reserved: false }),
    );
    const outcome = yield* refused(planted);

    expect(outcome.message).toContain(
      "something other than a component this run's bundle supplies",
    );
    expect(outcome.appended).toBe(0);
  });

  it("WBA4: a repository selection that is not the root is refused", function* () {
    const planted = yield* continuing(ROOT, (event) =>
      isImport(event, "Discovery")
        ? {
            ...(event as DurableEvent & { type: "yield" }),
            description: { type: "import_component", name: "Elsewhere" },
            result: {
              status: "ok",
              value: { kind: "repository", path: "Elsewhere.md", content: "read from disk.\n" },
            },
          }
        : event,
    );

    expect((yield* refused(planted)).message).toBe(
      "A retained component import recorded a repository file, which a workflow run resolves " +
        "none of.",
    );
  });

  it("WBA5: a member too many, a member too few, and a value that will not be read", function* () {
    const planted: Array<{ says: string; value: unknown }> = [
      { says: "extra", value: { ...selection(DISCOVERY), origin: "elsewhere" } },
      { says: "missing", value: { kind: "workflow", path: DISCOVERY.path, content: "x" } },
      { says: "not an object", value: "workflow" },
    ];

    for (const { says, value } of planted) {
      const history = yield* continuing(ROOT, planting(value));
      const outcome = yield* refused(history);
      expect({ says, appended: outcome.appended }).toEqual({ says, appended: 0 });
      expect(outcome.message).toContain("cannot be read by this run's component bundle");
    }

    // A member whose accessor refuses to answer is the same fact as a member
    // that is not there: this record does not describe a component import. It
    // is planted at the read rather than at the append, because an append
    // clones what it is given and a clone answers where the original refused.
    const partial = yield* continuing(ROOT);
    const recorded = yield* partial.readAll();
    const hostile: DurableStream = {
      // deno-lint-ignore require-yield
      *readAll(): Operation<DurableEvent[]> {
        return recorded.map((event) => {
          if (!isImport(event, "Discovery")) {
            return event;
          }
          const value: Record<string, unknown> = { kind: "workflow" };
          Object.defineProperty(value, "path", {
            enumerable: true,
            get() {
              throw new Error("the record refuses to be read");
            },
          });
          Object.defineProperty(value, "sourceHash", {
            enumerable: true,
            value: DISCOVERY.sourceHash,
          });
          Object.defineProperty(value, "content", {
            enumerable: true,
            value: DISCOVERY.content,
          });
          return {
            ...(event as DurableEvent & { type: "yield" }),
            result: { status: "ok", value } as never,
          };
        });
      },
      append: (event: DurableEvent) => partial.append(event),
    };

    const outcome = yield* refused(hostile, (yield* partial.readAll()).length);
    expect(outcome.message).toContain("cannot be read by this run's component bundle");
    expect(outcome.appended).toBe(0);
    // The planted words never reach the diagnostic.
    expect(outcome.message).not.toContain("refuses to be read");
  });

  it("WBA6: an unknown workflow entry is refused even when it is well formed", function* () {
    const planted = yield* continuing(ROOT, (event) =>
      isImport(event, "Discovery")
        ? {
            ...(event as DurableEvent & { type: "yield" }),
            description: { type: "import_component", name: "Undeclared" },
            result: {
              status: "ok",
              value: {
                kind: "workflow",
                path: "workflows/Undeclared.md",
                sourceHash: blob(7),
                content: "never declared.\n",
              },
            },
          }
        : event,
    );

    expect((yield* refused(planted)).message).toBe(
      "A retained component import names a component this run's bundle does not declare.",
    );
  });

  it("WBA7: a registered default keeps replaying by its recorded origin", function* () {
    const source = ['<Parse schema=\'{"type":"number"}\' as="n">7</Parse>', "", "n: {n}", ""].join(
      "\n",
    );
    const partial = yield* continuing(source);

    expect(yield* run(source, partial)).toContain("n: 7");
  });

  it("WBA8: the run's own root import is not a bundle member", function* () {
    const partial = yield* continuing(ROOT);
    const roots = (yield* partial.readAll()).filter((event) => isImport(event, "__root__"));

    expect(roots.length).toBe(1);
    expect(yield* run(ROOT, partial)).toContain("Discovery ran.");
  });
});

/** The selection one bundled component records. */
function selection(component: WorkflowBundleComponent): Record<string, unknown> {
  return {
    kind: "workflow",
    path: component.path,
    sourceHash: component.sourceHash,
    content: component.content,
  };
}
