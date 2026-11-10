/**
 * Tier PH — installing the Plugins one command runs with.
 *
 * Order, admission and lifetime, and what each of them decides. Order fixes
 * composition and nothing else: two Plugins using one name are refused
 * before either installs, rather than the later one winning. Admission happens
 * before the first `install()`, so a refused selection installs nothing and
 * reads no document. And the whole list has the command's lifetime, so a
 * failure part-way through unwinds what came before it.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { activePlugins, Plugin } from "@executablemd/core/api";
import type { PluginInstallation } from "@executablemd/core/api";
import { Markdown, sourceDigest, Structural } from "@executablemd/core/host";
import { Config, verbose } from "@executablemd/runtime/api";
import { admitPlugins, installPlugins, NO_PLUGINS } from "../src/plugin-host.ts";
import { syntaxSymbols } from "../src/syntax.ts";
import { structuralValidation } from "../src/plan-component.ts";

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

describe("PH3b — cancellation unwinds what was installed", () => {
  it("releases the Plugins already installed when the command is halted", function* () {
    const events: string[] = [];
    const reached = withResolvers<void>();
    const command = yield* spawn(() =>
      scoped(function* () {
        yield* installPlugins(
          [
            Plugin({
              name: "holds-a-resource",
              *install(): Operation<PluginInstallation | undefined> {
                yield* ensure(function* () {
                  events.push("released");
                });
                events.push("installed");
                return undefined;
              },
            }),
            Plugin({
              name: "still-installing",
              *install(): Operation<PluginInstallation | undefined> {
                reached.resolve();
                // A Plugin that is still working when the command is cancelled:
                // a provider waiting on a socket, a lock, an answer.
                yield* suspend();
                return undefined;
              },
            }),
            recording("never-reached", events),
          ],
          RUN,
        );
      }),
    );
    yield* reached.operation;
    yield* command.halt();
    // The resource the first Plugin acquired is released, the third never
    // installed, and halting stays halting: nothing turned it into a failure.
    expect(events).toEqual(["installed", "released"]);
  });

  it("leaves the established teardown-failure precedence exactly as it was", function* () {
    // The rule this must not move: in a scope where the body failed *and* a
    // teardown failed, Effection reports the teardown failure. Installing
    // Plugins is an ordinary scope doing ordinary work, so the same command
    // line reports the same thing it would with no Plugin in it at all.
    const events: string[] = [];
    const throughPlugins = yield* refusal(() =>
      scoped(function* () {
        yield* installPlugins(
          [
            Plugin({
              name: "fails-to-release",
              *install(): Operation<PluginInstallation | undefined> {
                yield* ensure(function* (): Operation<void> {
                  events.push("release attempted");
                  throw new Error("this Plugin could not release its resource");
                });
                return undefined;
              },
            }),
            Plugin({
              name: "refuses",
              // deno-lint-ignore require-yield
              *install(): Operation<PluginInstallation | undefined> {
                throw new Error("this Plugin refuses to install");
              },
            }),
          ],
          RUN,
        );
      }),
    );

    // The same two failures, with no Plugin anywhere: the comparison is what
    // makes this a claim about precedence rather than a restatement of one
    // observation.
    const withoutPlugins = yield* refusal(() =>
      scoped(function* () {
        yield* ensure(function* (): Operation<void> {
          throw new Error("this Plugin could not release its resource");
        });
        throw new Error("this Plugin refuses to install");
      }),
    );

    expect(events).toEqual(["release attempted"]);
    expect(throughPlugins).toBe(withoutPlugins);
    expect(throughPlugins).toContain("could not release its resource");
  });
});

describe("PH4 — what an installation contributes crosses as one execution installation", () => {
  const SOURCE = "declared by a Plugin\n";

  /** Everything one installation can carry, on one value. */
  function everything(seen: string[]): Plugin {
    const installation = {
      components: [
        Markdown({
          name: "PluginDeclared",
          origin: "tier-ph/PluginDeclared.md",
          source: SOURCE,
          digest: sourceDigest(SOURCE),
        }),
      ],
      structural: [
        Structural({
          name: "PluginConstruct",
          origin: "tier-ph",
          forms: ["paired"],
          props: { type: "object", properties: {}, additionalProperties: false },
          syntax: ["<PluginConstruct>…</PluginConstruct>"],
          description: "A construct this Plugin declared.",
          context: "What the construct renders.",
          parent: null,
        }),
      ],
      admissions: [
        // deno-lint-ignore require-yield
        function* (): Operation<void> {},
      ],
      label: "the installation it came from",
      // deno-lint-ignore require-yield
      *expand(): Operation<void> {
        // Read off `this`, because what the host binds is the installation the
        // handler was returned on — not a copy, and not whatever object the
        // conversion happened to build.
        seen.push(String(Reflect.get(this, "label")));
      },
    };
    return Plugin({
      name: "everything",
      // deno-lint-ignore require-yield
      *install(): Operation<PluginInstallation | undefined> {
        return installation;
      },
    });
  }

  it("carries components, structural syntax, its bound expand and admissions on one", function* () {
    const seen: string[] = [];
    const assembly = yield* scoped(function* () {
      return yield* installPlugins([everything(seen)], RUN);
    });

    // One installation, not one per kind: what a Plugin returned is what
    // canonical execution captures, and a declaration and the handler that
    // expands it have to arrive together or the pair is refused.
    expect(assembly.installations).toHaveLength(1);
    const installed = assembly.installations[0];
    expect(installed?.declarations?.map((declaration) => declaration.name)).toEqual([
      "PluginDeclared",
      "PluginConstruct",
    ]);
    // Markdown first, then structural — one list, both arms, in that order.
    expect(installed?.declarations?.map((declaration) => declaration.kind)).toEqual([
      "component",
      "structural",
    ]);
    expect(installed?.admissions).toHaveLength(1);
    expect(assembly.declarations.map((declaration) => declaration.name)).toEqual([
      "PluginDeclared",
      "PluginConstruct",
    ]);

    // And the handler runs against the installation it was returned on.
    const expand = installed?.expand;
    if (expand === undefined) {
      throw new Error("the installation carried no expansion handler");
    }
    yield* expand({
      name: "PluginConstruct",
      origin: "tier-ph",
      form: "paired",
      props: {},
      regions: [],
    });
    expect(seen).toEqual(["the installation it came from"]);
  });

  it("contributes no installation for a Plugin that returned nothing", function* () {
    const assembly = yield* scoped(function* () {
      return yield* installPlugins([recording("inert", [])], RUN);
    });
    expect(assembly.installations).toEqual([]);
    expect(assembly.declarations).toEqual([]);
    expect(assembly.plugins.map((plugin) => plugin.name)).toEqual(["inert"]);
  });

  // deno-lint-ignore require-yield
  it("contributes nothing at all where no Plugin was selected", function* () {
    expect(NO_PLUGINS.plugins).toEqual([]);
    expect(NO_PLUGINS.installations).toEqual([]);
    expect(NO_PLUGINS.declarations).toEqual([]);
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

describe("PH6 — an empty selection contributes nothing", () => {
  it("contributes nothing at all when it is not in the list", function* () {
    // A claim about this primitive, not about the product. `installPlugins()`
    // installs the list it is handed and nothing else, so an empty list
    // contributes nothing whichever command it is for. Which Plugins a command
    // actually runs with — XMD's bundled prefix among them — is assembled by
    // the caller, in `assembleRunProfile()`, and is not this function's to
    // decide.
    for (const command of ["run", "syntax", "plan", "workflow"]) {
      const assembly = yield* scoped(function* () {
        return yield* installPlugins([], { command, args: [command] });
      });
      expect(`${command}: ${assembly.declarations.length}`).toBe(`${command}: 0`);
      expect(`${command}: ${assembly.installations.length}`).toBe(`${command}: 0`);
    }
  });
});

describe("PH7 — a structural-only Plugin reaches every consumer of the catalog", () => {
  const ORIGIN = "tier-ph/structural";
  const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

  /** A Plugin that declares structural syntax and no Markdown component at all. */
  const structural: Plugin = Plugin({
    name: "structural-only",
    // deno-lint-ignore require-yield
    *install(): Operation<PluginInstallation | undefined> {
      return {
        structural: [
          Structural({
            name: "Banner",
            origin: ORIGIN,
            forms: ["paired"],
            props: NO_PROPS,
            syntax: ["<Banner><BannerLine>…</BannerLine></Banner>"],
            description: "Frame the lines written inside it.",
            context: "The lines this banner frames.",
            parent: null,
          }),
          Structural({
            name: "BannerLine",
            origin: ORIGIN,
            forms: ["paired"],
            props: NO_PROPS,
            syntax: ["<BannerLine>…</BannerLine>"],
            description: "One line of a banner.",
            context: "The line's own content.",
            parent: "Banner",
          }),
        ],
        // deno-lint-ignore require-yield
        *expand(): Operation<void> {},
      };
    },
  });

  it("retains both arms of what it declared, not the Markdown half", function* () {
    const assembly = yield* scoped(function* () {
      return yield* installPlugins([structural], RUN);
    });
    expect(assembly.declarations.map((declaration) => declaration.name)).toEqual([
      "Banner",
      "BannerLine",
    ]);
    // One installation carries them, with the handler that expands them.
    expect(assembly.installations).toHaveLength(1);
    expect(assembly.installations[0]?.expand).toBeDefined();
  });

  it("describes the construct in the symbols xmd syntax renders", function* () {
    const catalog = yield* scoped(function* () {
      const assembly = yield* installPlugins([structural], RUN);
      return yield* syntaxSymbols([], assembly);
    });
    const named: string[] = [];
    const described = new Map<string, unknown>();
    for (const category of catalog.categories) {
      for (const entry of category.entries) {
        named.push(entry.name);
        described.set(entry.name, {
          origin: entry.origin,
          ...("parent" in entry ? { parent: entry.parent } : {}),
        });
      }
    }
    expect(named).toContain("Banner");
    expect(named).toContain("BannerLine");
    // Described as declared syntax from the origin the Plugin stated, with the
    // pair reported: `null` for the construct, the construct for its region.
    expect(described.get("Banner")).toEqual({
      origin: { kind: "structural", origin: ORIGIN },
      parent: null,
    });
    expect(described.get("BannerLine")).toEqual({
      origin: { kind: "structural", origin: ORIGIN },
      parent: "Banner",
    });
  });

  it("accepts a candidate that writes the construct, under Plan validation", function* () {
    const outcome = yield* scoped(function* () {
      const assembly = yield* installPlugins([structural], RUN);
      const validate = structuralValidation([], [], assembly);
      return yield* validate("<Banner>\n  <BannerLine>framed</BannerLine>\n</Banner>\n");
    });
    // The whole point: a construct the run expands is syntax the check knows.
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([]);
    expect(outcome.outcome).toBe("valid");
  });

  it("refuses the same candidate when nothing declared the construct", function* () {
    const outcome = yield* scoped(function* () {
      const validate = structuralValidation([], [], NO_PLUGINS);
      return yield* validate("<Banner>\n  <BannerLine>framed</BannerLine>\n</Banner>\n");
    });
    // Which is what makes the row above a claim rather than a restatement.
    expect(outcome.outcome).toBe("invalid");
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "component-unresolved",
    );
  });
});

describe("PH8 — an incomplete structural half never reaches a command", () => {
  const ORIGIN = "tier-ph/incomplete";
  const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

  const CONSTRUCT = Structural({
    name: "Orphan",
    origin: ORIGIN,
    forms: ["paired"],
    props: NO_PROPS,
    syntax: ["<Orphan><OrphanLine>…</OrphanLine></Orphan>"],
    description: "A construct whose Plugin supplied no handler.",
    context: "What it would have framed.",
    parent: null,
  });

  const REGION = Structural({
    name: "OrphanLine",
    origin: ORIGIN,
    forms: ["paired"],
    props: NO_PROPS,
    syntax: ["<OrphanLine>…</OrphanLine>"],
    description: "One line of an orphan.",
    context: "The line's own content.",
    parent: "Orphan",
  });

  /** Declares structural syntax and supplies no handler for it. */
  const declarationsOnly: Plugin = Plugin({
    name: "declarations-only",
    // deno-lint-ignore require-yield
    *install(): Operation<PluginInstallation | undefined> {
      return { structural: [CONSTRUCT, REGION] };
    },
  });

  /** Supplies a handler and declares no structural syntax for it to expand. */
  const handlerOnly: Plugin = Plugin({
    name: "handler-only",
    // deno-lint-ignore require-yield
    *install(): Operation<PluginInstallation | undefined> {
      return {
        // deno-lint-ignore require-yield
        *expand(): Operation<void> {},
      };
    },
  });

  it("refuses structural declarations with no handler, at installation", function* () {
    const message = yield* refusal(() =>
      scoped(function* () {
        yield* installPlugins([declarationsOnly], RUN);
      }),
    );
    expect(message).toContain("declarations-only");
    expect(message).toContain("supplied no expansion handler");
  });

  it("refuses a handler with no structural declarations, at installation", function* () {
    const message = yield* refusal(() =>
      scoped(function* () {
        yield* installPlugins([handlerOnly], RUN);
      }),
    );
    expect(message).toContain("handler-only");
    expect(message).toContain("declared no structural syntax");
  });

  it("stops before xmd syntax can advertise the construct", function* () {
    // The defect this closes: the assembly retained a flattened declaration
    // list, `inspectSyntax` reads declarations without handlers by design, and
    // the construct was therefore described to a writer — and refused only when
    // a run finally tried to expand it.
    const described = yield* refusal(() =>
      scoped(function* () {
        const assembly = yield* installPlugins([declarationsOnly], RUN);
        return yield* syntaxSymbols([], assembly);
      }),
    );
    expect(described).toContain("supplied no expansion handler");

    // And with no Plugin installed at all, nothing describes it either — so the
    // row above is about the refusal rather than about an empty catalog.
    const catalog = yield* scoped(function* () {
      return yield* syntaxSymbols([], NO_PLUGINS);
    });
    const named = catalog.categories.flatMap((category) =>
      category.entries.map((entry) => entry.name),
    );
    expect(named).not.toContain("Orphan");
  });

  it("stops before Plan validation can accept the construct", function* () {
    const validated = yield* refusal(() =>
      scoped(function* () {
        const assembly = yield* installPlugins([declarationsOnly], RUN);
        const validate = structuralValidation([], [], assembly);
        return yield* validate("<Orphan>\n  <OrphanLine>x</OrphanLine>\n</Orphan>\n");
      }),
    );
    expect(validated).toContain("supplied no expansion handler");
  });

  it("unwinds the Plugins installed before the incomplete one", function* () {
    const events: string[] = [];
    const message = yield* refusal(() =>
      scoped(function* () {
        yield* installPlugins(
          [
            Plugin({
              name: "first",
              *install(): Operation<PluginInstallation | undefined> {
                yield* ensure(function* () {
                  events.push("released");
                });
                events.push("installed");
                return undefined;
              },
            }),
            declarationsOnly,
            recording("never-reached", events),
          ],
          RUN,
        );
      }),
    );
    expect(message).toContain("supplied no expansion handler");
    // Installation order and first-failure behaviour are unchanged: the Plugin
    // after the incomplete one never installed, and the one before it released
    // what it held.
    expect(events).toEqual(["installed", "released"]);
  });
});
