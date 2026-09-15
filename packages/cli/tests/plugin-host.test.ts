/**
 * Tier PH — installing the Plugins one command runs with.
 *
 * Order, admission and lifetime, and what each of them decides. Order fixes
 * composition and nothing else: two Plugins claiming one name are refused
 * before either installs, rather than the later one winning. Admission happens
 * before the first `install()`, so a refused selection installs nothing and
 * reads no document. And the whole list has the command's lifetime, so a
 * failure part-way through unwinds what came before it.
 *
 * The bundled review Plugin's own rows are here too, because which commands
 * claim its forty-one names is a property of this assembly rather than of the
 * package: the graph itself is `scripts/tests/review-infrastructure.test.ts`.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { activePlugins, Plugin } from "@executablemd/core/api";
import type { PluginInstallation } from "@executablemd/core/api";
import { inspectComponent } from "@executablemd/core";
import { Config, verbose } from "@executablemd/runtime/api";
import { BUNDLED_PLUGINS } from "../src/bundled-plugins.ts";
import { admitPlugins, installPlugins, NO_PLUGINS } from "../src/plugin-host.ts";

/** The message an operation failed with, or `undefined` when it did not. */
function* refusal(body: () => Operation<unknown>): Operation<string | undefined> {
  try {
    yield* body();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A Plugin that records when it installs and contributes nothing. */
function recording(name: string, events: string[]): Plugin {
  return Plugin({
    // deno-lint-ignore require-yield
    *install(): Operation<PluginInstallation | undefined> {
      events.push(name);
      return undefined;
    },
    name,
  });
}

const RUN = { command: "run", args: [] } as const;

describe("PH1 — the list installs once, in order", () => {
  it("calls each install in selection order", function* () {
    const events: string[] = [];
    yield* scoped(function* () {
      yield* installPlugins(
        [recording("first", events), recording("second", events), recording("third", events)],
        RUN,
      );
    });
    expect(events).toEqual(["first", "second", "third"]);
  });

  it("skips a Plugin that installs nothing without disturbing the order", function* () {
    const events: string[] = [];
    yield* scoped(function* () {
      yield* installPlugins([Plugin({ name: "inert" }), recording("after", events)], RUN);
    });
    expect(events).toEqual(["after"]);
  });

  it("shows every Plugin the complete list, including the first one", function* () {
    const seen: string[][] = [];
    function watcher(name: string): Plugin {
      return Plugin({
        name,
        *install(): Operation<PluginInstallation | undefined> {
          seen.push((yield* activePlugins).map((plugin) => plugin.name));
          return undefined;
        },
      });
    }
    yield* scoped(function* () {
      yield* installPlugins([watcher("first"), watcher("second")], RUN);
    });
    expect(seen).toEqual([
      ["first", "second"],
      ["first", "second"],
    ]);
  });

  it("carries the command and the original argv into every request", function* () {
    const requests: string[] = [];
    function reader(name: string): Plugin {
      return Plugin({
        name,
        // deno-lint-ignore require-yield
        *install(request): Operation<PluginInstallation | undefined> {
          requests.push(`${request.command} ${request.args.join(" ")}`);
          return undefined;
        },
      });
    }
    yield* scoped(function* () {
      yield* installPlugins([reader("a"), reader("b")], {
        command: "plan",
        args: ["plan", "--plugin", "./a.mjs", "write it"],
      });
    });
    expect(requests).toEqual([
      "plan plan --plugin ./a.mjs write it",
      "plan plan --plugin ./a.mjs write it",
    ]);
  });
});

describe("PH2 — one name, one Plugin", () => {
  // deno-lint-ignore require-yield
  it("refuses two selections claiming one name", function* () {
    const first = Plugin({ name: "shared" });
    const second = Plugin({ name: "shared" });
    let refused = "";
    try {
      admitPlugins([first, second]);
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused).toContain("two selected Plugins are named shared");
  });

  it("refuses before the first install rather than after the second", function* () {
    const events: string[] = [];
    const message = yield* refusal(() =>
      scoped(function* () {
        yield* installPlugins([recording("shared", events), recording("shared", events)], RUN);
      }),
    );
    expect(message).toContain("two selected Plugins are named shared");
    expect(events).toEqual([]);
  });

  // deno-lint-ignore require-yield
  it("admits distinct names loaded from anywhere", function* () {
    const admitted = admitPlugins([Plugin({ name: "one" }), Plugin({ name: "two" })]);
    expect(admitted.map((plugin) => plugin.name)).toEqual(["one", "two"]);
    expect(Object.isFrozen(admitted)).toBe(true);
  });
});

describe("PH3 — an installation has the command's lifetime", () => {
  it("unwinds the Plugins installed before one that failed", function* () {
    const events: string[] = [];
    const message = yield* refusal(() =>
      scoped(function* () {
        yield* installPlugins(
          [
            Plugin({
              name: "first",
              *install(): Operation<PluginInstallation | undefined> {
                yield* ensure(function* () {
                  events.push("first released");
                });
                events.push("first installed");
                return undefined;
              },
            }),
            Plugin({
              name: "second",
              // deno-lint-ignore require-yield
              *install(): Operation<PluginInstallation | undefined> {
                throw new Error("this Plugin refuses to install");
              },
            }),
            recording("third", events),
          ],
          RUN,
        );
      }),
    );
    expect(message).toContain("this Plugin refuses to install");
    expect(events).toEqual(["first installed", "first released"]);
  });
});

describe("PH4 — what an installation contributes crosses as one execution installation", () => {
  it("carries components, structural syntax and admissions on one installation", function* () {
    const assembly = yield* scoped(function* () {
      return yield* installPlugins(
        [
          Plugin({
            name: "declaring",
            // deno-lint-ignore require-yield
            *install(): Operation<PluginInstallation | undefined> {
              return {
                admissions: [
                  // deno-lint-ignore require-yield
                  function* () {},
                ],
              };
            },
          }),
        ],
        RUN,
      );
    });
    expect(assembly.installations).toHaveLength(1);
    expect(assembly.installations[0]?.admissions).toHaveLength(1);
    expect(assembly.installations[0]?.declarations).toBe(undefined);
  });

  it("contributes no installation for a Plugin that returned nothing", function* () {
    const assembly = yield* scoped(function* () {
      return yield* installPlugins([recording("inert", [])], RUN);
    });
    expect(assembly.installations).toEqual([]);
    expect(assembly.components).toEqual([]);
    expect(assembly.plugins.map((plugin) => plugin.name)).toEqual(["inert"]);
  });

  // deno-lint-ignore require-yield
  it("contributes nothing at all where no Plugin was selected", function* () {
    expect(NO_PLUGINS.plugins).toEqual([]);
    expect(NO_PLUGINS.installations).toEqual([]);
    expect(NO_PLUGINS.components).toEqual([]);
    expect(NO_PLUGINS.args).toEqual([]);
  });
});

describe("PH5 — a Plugin reads the command's typed configuration", () => {
  it("sees the parsed verbosity the command installed, through runtime's /api", function* () {
    const seen: boolean[] = [];
    yield* scoped(function* () {
      // What `installDocumentComponents` and the run boundary install, from the
      // command line this invocation already read.
      yield* Config.around({ verbose: () => true }, { at: "min" });
      yield* installPlugins(
        [
          Plugin({
            name: "reads-config",
            *install(): Operation<PluginInstallation | undefined> {
              seen.push(yield* verbose);
              return undefined;
            },
          }),
        ],
        RUN,
      );
    });
    expect(seen).toEqual([true]);
  });
});

describe("PH6 — the bundled review Plugin claims the commands that run a review", () => {
  /** The declared component names this command's bundled Plugins contribute. */
  function* declaredFor(command: string, args: readonly string[]): Operation<string[]> {
    return yield* scoped(function* () {
      const assembly = yield* installPlugins(BUNDLED_PLUGINS, { command, args });
      return assembly.components.map((component) => component.name);
    });
  }

  it("declares the thirty-five Markdown components for run, syntax and plan", function* () {
    for (const command of ["run", "syntax", "plan"]) {
      const declared = yield* declaredFor(command, [command]);
      expect(`${command}: ${declared.length}`).toBe(`${command}: 35`);
      expect(declared).toContain("Finding");
    }
  });

  it("declares them for a workflow action that executes a document", function* () {
    for (const action of ["start", "resume", "fork"]) {
      const declared = yield* declaredFor("workflow", ["workflow", action, "flow.md"]);
      expect(`${action}: ${declared.length}`).toBe(`${action}: 35`);
    }
  });

  it("declares none for the test root, upgrade, or a workflow management action", function* () {
    expect(yield* declaredFor("test", ["test"])).toEqual([]);
    expect(yield* declaredFor("upgrade", ["upgrade"])).toEqual([]);
    for (const action of ["list", "status", "history", "cancel", "delete", "export", "answer"]) {
      expect(`${action}: ${(yield* declaredFor("workflow", ["workflow", action])).length}`).toBe(
        `${action}: 0`,
      );
    }
  });

  it("reads the action by name, so a --plugin value is never mistaken for one", function* () {
    const declared = yield* declaredFor("workflow", ["workflow", "--plugin", "./start", "list"]);
    expect(declared).toEqual([]);
  });

  it("registers the six reserved names where it claims the graph", function* () {
    const reserved = [
      "CommentReviewData",
      "CommentReviewState",
      "Doctor",
      "OxlintDiagnostics",
      "RepositoryInventory",
      "ReviewContext",
    ];
    const described = yield* scoped(function* () {
      yield* installPlugins(BUNDLED_PLUGINS, { command: "run", args: ["run"] });
      const found: string[] = [];
      for (const name of reserved) {
        const info = yield* inspectComponent({ name, includes: [] });
        if (
          info.kind === "registered" &&
          info.origin.kind === "registered" &&
          info.origin.origin === "@executablemd/code-review-agent" &&
          info.origin.reserved
        ) {
          found.push(name);
        }
      }
      return found;
    });
    expect(described).toEqual(reserved);
  });

  it("registers none of them for the test root", function* () {
    const kind = yield* scoped(function* () {
      yield* installPlugins(BUNDLED_PLUGINS, { command: "test", args: ["test"] });
      return (yield* inspectComponent({ name: "ReviewContext", includes: [] })).kind;
    });
    expect(kind).not.toBe("registered");
  });
});
