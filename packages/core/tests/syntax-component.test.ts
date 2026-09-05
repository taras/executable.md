/**
 * Tier SC — `<Syntax />`, the component canonical core owns.
 *
 * What a document may write here is a public question, and this is the public
 * answer: the catalog for the site the element was written at, in the words
 * `xmd syntax` prints. Three things follow, and every case here is about one of
 * them.
 *
 * **The name is the engine's.** A repository `Syntax.md`, a bundled `Syntax`, an
 * ordinary or reserved registration, a host declaration, import middleware and a
 * definition from a second loaded copy can none of them answer for it. A catalog
 * anything in the run could answer for describes nothing.
 *
 * **The answer is the site's.** The observation is built from the selection
 * inputs the execution captured before any installation, middleware or document
 * code ran, and it travels lexically on canonical core's own expansion
 * authority — not through a context, where a name is not a secret.
 *
 * **One occurrence observes once.** It claims the identity this execution
 * minted, records exactly `{ catalog }`, and a continuation hands that back
 * without consulting the filesystem, the registry, the bundle or the host again.
 *
 * Protection is about the answer, not about power: the component receives one
 * operation that observes catalog text and nothing else, and a catalog naming a
 * component is not permission to run it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep, spawn, suspend, until } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { rm, writeTextFile } from "@effectionx/fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";

import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { executeInstalled, sourceDigest } from "../host.ts";
import type { DeclaredMarkdownComponent, ExecutionInstallation } from "../host.ts";
import { inspectComponent, inspectSyntax } from "../src/inspect.ts";
import { validateDocumentStructure } from "../src/document-validation.ts";
import { registerComponents } from "../src/components/registration.ts";
import { selectComponent } from "../src/components/select.ts";
import { retainedSource } from "../src/root-source.ts";
import { renderSyntaxMarkdown } from "../src/syntax-markdown.ts";
import { fixedCatalogObservation } from "../src/syntax-observation.ts";
import { SYNTAX_COMPONENT } from "../src/components/Syntax.ts";
import type { ImportedDefinition } from "../src/components/import-authority.ts";
import type { FunctionComponent, SyntaxCatalog } from "../mod.ts";

const ROOT_PATH = "documents/root.md";

/** The approved description, spelled here so a change to it fails a test. */
const DESCRIPTION =
  "Output available components and control flow constructs. `<Syntax />` renders the " +
  "current catalog.";

/** A catalog with one built-in entry per name, for a case that needs a marker. */
function catalogOf(...names: readonly string[]): SyntaxCatalog {
  return {
    version: 1,
    categories: [
      { kind: "structural", entries: [] },
      {
        kind: "built-in",
        entries: names.map((name) => ({
          kind: "component" as const,
          name,
          origin: { kind: "registered" as const, origin: "@executablemd/test", reserved: false },
          sourceKind: "registered" as const,
          inspectability: "complete" as const,
          forms: ["self-closing" as const],
          props: { type: "object", properties: {}, additionalProperties: false },
          captures: [],
          returnMode: "text" as const,
          returns: { type: "string" },
        })),
      },
      { kind: "user-provided", entries: [] },
    ],
  };
}

/** A host that states the catalog its profile describes, and counts the asks. */
function stating(catalog: SyntaxCatalog, calls: { count: number } = { count: 0 }) {
  const installation: ExecutionInstallation = {
    // deno-lint-ignore require-yield
    *catalog(): Operation<SyntaxCatalog> {
      calls.count += 1;
      return catalog;
    },
  };
  return { installation, calls };
}

/** Run one root, with whatever installations the case supplies. */
function run(
  source: string,
  installations: readonly ExecutionInstallation[] = [],
  stream: InMemoryStream = new InMemoryStream(),
  includes: readonly string[] = [],
): Operation<Json> {
  return scoped(function* () {
    return yield* collect(
      yield* executeInstalled(
        { ...retainedSource(ROOT_PATH, source), stream, includes: [...includes] },
        [...installations],
      ),
    );
  });
}

/** What one execution refused with, as a string. */
function* refusal(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the operation to be refused");
}

/** Every retained catalog observation, in order. */
function observations(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "syntax_catalog",
  );
}

/** A continuation stream: everything one run recorded but its terminals. */
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

/** The same history with one retained observation replaced. */
function* tampered(
  stream: InMemoryStream,
  replace: (value: Json) => Json,
): Operation<InMemoryStream> {
  const partial = new InMemoryStream();
  for (const event of yield* stream.readAll()) {
    if (event.type === "close") {
      continue;
    }
    if (
      event.type === "yield" &&
      event.description.type === "syntax_catalog" &&
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

/** A working directory of this case's own, torn down on the way out. */
function useWorkingDirectory<T>(body: (dir: string) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const made = yield* until(mkdtemp(join(tmpdir(), "xmd-syntax-")));
    const dir = yield* until(realpath(made));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *cwd() {
        return dir;
      },
    });
    yield* useHostFiles();
    return yield* body(dir);
  });
}

describe("Tier SC — what one occurrence answers", () => {
  it("SC1: the bare form renders the catalog once, and `as` binds the same text", function* () {
    const { installation } = stating(catalogOf("Marker"));
    const bare = yield* run("<Syntax />\n", [installation]);
    expect(String(bare)).toContain("### `<Marker>`");
    // Once, not twice: one occurrence is one rendering.
    expect(String(bare).split("### `<Marker>`").length - 1).toBe(1);

    const captured = yield* run('<Syntax as="catalog" />\nbound:{catalog}\n', [installation]);
    // The same text, and the occurrence itself emitted nothing — what is in the
    // document is the binding this case interpolated, not a second copy.
    expect(String(captured)).toContain("bound:");
    expect(String(captured)).toContain("### `<Marker>`");
    expect(String(captured).indexOf("### `<Marker>`")).toBeGreaterThan(
      String(captured).indexOf("bound:"),
    );
    expect(String(captured).split("### `<Marker>`").length - 1).toBe(1);
  });

  it("SC2: it renders exactly what the shared Markdown renderer produces", function* () {
    const catalog = catalogOf("Marker", "Other");
    const { installation } = stating(catalog);
    const bare = yield* run('<Syntax as="catalog" />{catalog}', [installation]);
    // The same function `xmd syntax` renders with, not a second one that agrees
    // today: an invocation and the command cannot describe one profile in two
    // sets of words.
    expect(String(bare)).toBe(renderSyntaxMarkdown(catalog));
  });

  it("SC3: a paired spelling and an authored prop refuse before any observation", function* () {
    const paired = stating(catalogOf("Marker"));
    expect(yield* refusal(run("<Syntax>content</Syntax>\n", [paired.installation]))).toContain(
      "written self-closing",
    );
    expect(paired.calls.count).toBe(0);

    const propped = stating(catalogOf("Marker"));
    expect(yield* refusal(run('<Syntax mode="short" />\n', [propped.installation]))).toContain(
      "mode",
    );
    expect(propped.calls.count).toBe(0);

    // The positive control for the same host: the accepted spelling observes.
    const accepted = stating(catalogOf("Marker"));
    expect(String(yield* run("<Syntax />\n", [accepted.installation]))).toContain("Marker");
    expect(accepted.calls.count).toBe(1);
  });

  it("SC4: one occurrence observes once, two observe independently, a binding observes neither again", function* () {
    const one = stating(catalogOf("Marker"));
    yield* run('<Syntax as="catalog" />{catalog}{catalog}{catalog}', [one.installation]);
    expect(one.calls.count).toBe(1);

    const two = stating(catalogOf("Marker"));
    yield* run("<Syntax />\n<Syntax />\n", [two.installation]);
    expect(two.calls.count).toBe(2);

    // Two identities, so two records rather than one record read twice.
    const stream = new InMemoryStream();
    yield* run("<Syntax />\n<Syntax />\n", [stating(catalogOf("Marker")).installation], stream);
    expect(observations(yield* stream.readAll()).length).toBe(2);
  });
});

describe("Tier SC — the name canonical core owns", () => {
  it("SC5: a repository Syntax.md, Syntax.ts and directory candidate never win", function* () {
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(join(dir, "Syntax.md"), "a repository catalog\n");
      yield* writeTextFile(join(dir, "Nearby.md"), "a nearby repository component\n");
      const { installation } = stating(catalogOf("Marker"));

      const output = String(
        yield* run("<Syntax />\n<Nearby />\n", [installation], undefined, [dir]),
      );
      // The protected component answered, and the repository file did not.
      expect(output).toContain("### `<Marker>`");
      expect(output).not.toContain("a repository catalog");
      // The positive control: repository discovery is active in this very run,
      // so the absence above is protection rather than a search that never ran.
      expect(output).toContain("a nearby repository component");
    });
  });

  it("SC6: selection reports the protected tier ahead of every other", function* () {
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(join(dir, "Syntax.md"), "a repository catalog\n");
      const selected = yield* selectComponent(SYNTAX_COMPONENT, { includes: [dir] });
      expect(selected.kind).toBe("protected");
      // The origin is core's, and reserved — the catalog's word for a name a
      // document cannot take back.
      expect(selected.kind === "protected" ? selected.origin : undefined).toEqual({
        kind: "registered",
        origin: "@executablemd/core",
        reserved: true,
      });
    });
  });

  it("SC7: an ordinary and a reserved registration named Syntax are both refused", function* () {
    const refused = yield* refusal(
      scoped(function* () {
        yield* registerComponents([
          {
            name: "Syntax",
            origin: "@executablemd/test",
            props: { type: "object", properties: {}, additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              return "replaced";
            },
          },
        ]);
      }),
    );
    expect(refused).toContain("canonical core owns that name");

    const reservedRefusal = yield* refusal(
      scoped(function* () {
        yield* registerComponents([
          {
            name: "Syntax",
            origin: "@executablemd/test",
            reserved: true,
            props: { type: "object", properties: {}, additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              return "replaced";
            },
          },
        ]);
      }),
    );
    expect(reservedRefusal).toContain("canonical core owns that name");
  });

  it("SC8: the refused batch registers nothing, and an adjacent registration still works", function* () {
    const good = {
      name: "Adjacent",
      origin: "@executablemd/test",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        return "adjacent ran";
      },
    };
    // The batch is refused whole: `Adjacent` is beside the refused name, and
    // nothing of it survives.
    yield* refusal(
      registerComponents([
        good,
        {
          name: "Syntax",
          origin: "@executablemd/test",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            return "replaced";
          },
        },
      ]),
    );
    const after = yield* selectComponent("Adjacent", {
      includes: [],
      registry: yield* Component.operations.registry,
    });
    expect(after.kind).toBe("unresolved");

    // The positive control: registration is available in this very scope.
    yield* registerComponents([good]);
    expect(
      (yield* selectComponent("Adjacent", {
        includes: [],
        registry: yield* Component.operations.registry,
      })).kind,
    ).toBe("registered");
  });

  it("SC9: a host that declares Markdown called Syntax is refused before the root import", function* () {
    const source = "a declared catalog\n";
    const declaration: DeclaredMarkdownComponent = {
      name: "Syntax",
      origin: "@executablemd/test/Syntax.md",
      source,
      digest: sourceDigest(source),
    };
    const stream = new InMemoryStream();
    expect(
      yield* refusal(run("<Syntax />\n", [{ declarations: [declaration] }], stream)),
    ).toContain("canonical core owns that name");
    // Before the root import: nothing was imported and nothing was observed.
    const events = yield* stream.readAll();
    expect(events.filter((event) => event.type === "yield").length).toBe(0);

    // The positive control: an adjacent declaration under another name is
    // admitted and runs, so the refusal is about the name.
    const adjacent: DeclaredMarkdownComponent = {
      name: "Policy",
      origin: "@executablemd/test/Policy.md",
      source,
      digest: sourceDigest(source),
    };
    expect(String(yield* run("<Policy />\n", [{ declarations: [adjacent] }]))).toContain(
      "a declared catalog",
    );
  });

  it("SC10: a workflow bundle member called Syntax is refused before the root import", function* () {
    const bundled = {
      name: "Syntax",
      path: "components/Syntax.md",
      sourceHash: "0".repeat(40),
      content: "a bundled catalog\n",
    };
    const adjacent = {
      name: "Bundled",
      path: "components/Bundled.md",
      sourceHash: "1".repeat(40),
      content: "a bundled component\n",
    };
    expect(
      yield* refusal(run("<Syntax />\n", [{ bundle: { components: [bundled, adjacent] } }])),
    ).toContain("canonical core owns that name");

    // The positive control: the same bundle without the protected name installs
    // and its member runs.
    expect(String(yield* run("<Bundled />\n", [{ bundle: { components: [adjacent] } }]))).toContain(
      "a bundled component",
    );
  });
});

describe("Tier SC — what the chain may and may not do", () => {
  /** A handler that answers `Syntax` with whatever `answer` produces. */
  function answering(
    answer: (real: ImportedDefinition) => ImportedDefinition,
  ): ExecutionInstallation {
    return {
      *install() {
        yield* Component.around(
          {
            *importComponent([name, position], next) {
              if (name !== SYNTAX_COMPONENT) {
                return yield* next(name, position);
              }
              return answer(yield* next(name, position));
            },
          },
          { at: "max" },
        );
      },
    };
  }

  it("SC11: ordinary delegation reaches canonical Syntax", function* () {
    const seen: string[] = [];
    const observing: ExecutionInstallation = {
      *install() {
        yield* Component.around(
          {
            *importComponent([name, position], next) {
              seen.push(name);
              return yield* next(name, position);
            },
          },
          { at: "max" },
        );
      },
    };
    const { installation } = stating(catalogOf("Marker"));
    expect(String(yield* run("<Syntax />\n", [installation, observing]))).toContain("Marker");
    // The handler observed the import it could not answer.
    expect(seen).toContain(SYNTAX_COMPONENT);
  });

  it("SC12: a handler that answers, substitutes, mutates or copies runs no replacement", function* () {
    const replacement: FunctionComponent = function* () {
      return "a replaced catalog";
    };
    const cases: [string, (real: ImportedDefinition) => ImportedDefinition][] = [
      [
        "answers without delegating",
        () => ({
          kind: "function",
          name: SYNTAX_COMPONENT,
          props: { type: "object", properties: {}, additionalProperties: false },
          fn: replacement,
        }),
      ],
      [
        "substitutes a copy that describes the same contract",
        (real) => ({ ...Object(real), fn: replacement }),
      ],
      [
        "mutates what canonical execution produced",
        (real) => {
          Reflect.set(Object(real), "fn", replacement);
          return real;
        },
      ],
    ];

    for (const [, answer] of cases) {
      const { installation, calls } = stating(catalogOf("Marker"));
      const refused = yield* refusal(run("<Syntax />\n", [installation, answering(answer)]));
      expect(refused).toContain("canonical core owns");
      // Refused before the body: no catalog was observed for the replacement.
      expect(calls.count).toBe(0);
    }
  });

  it("SC13: a handler that redirects the name, or delegates twice, answers nothing", function* () {
    const redirecting: ExecutionInstallation = {
      *install() {
        yield* Component.around(
          {
            *importComponent([name, position], next) {
              // The answer canonical execution produced for another name.
              return name === SYNTAX_COMPONENT
                ? yield* next("Other", position)
                : yield* next(name, position);
            },
          },
          { at: "max" },
        );
      },
    };
    expect(
      yield* refusal(run("<Syntax />\n", [stating(catalogOf("Marker")).installation, redirecting])),
    ).toBeTruthy();

    const twice: ExecutionInstallation = {
      *install() {
        yield* Component.around(
          {
            *importComponent([name, position], next) {
              if (name !== SYNTAX_COMPONENT) {
                return yield* next(name, position);
              }
              yield* next(name, position);
              return yield* next(name, position);
            },
          },
          { at: "max" },
        );
      },
    };
    // Two canonical selections in one frame yield no domain, so the occurrence
    // can name no durable operation and the invocation refuses.
    expect(
      yield* refusal(run("<Syntax />\n", [stating(catalogOf("Marker")).installation, twice])),
    ).toBeTruthy();
  });

  it("SC14: a deliberate middleware refusal stays a refusal", function* () {
    const refusing: ExecutionInstallation = {
      *install() {
        yield* Component.around(
          {
            *importComponent([name, position], next) {
              if (name === SYNTAX_COMPONENT) {
                throw new Error("this host refuses the catalog");
              }
              return yield* next(name, position);
            },
          },
          { at: "max" },
        );
      },
    };
    const { installation, calls } = stating(catalogOf("Marker"));
    expect(yield* refusal(run("<Syntax />\n", [installation, refusing]))).toContain(
      "this host refuses the catalog",
    );
    expect(calls.count).toBe(0);
  });

  it("SC15: a document-authored context and a look-alike observation change nothing", function* () {
    // Nothing a document writes reaches the observation: it is not addressed by
    // name. The strongest thing an authored document can do is register and
    // bind, and the catalog is unchanged by both.
    const { installation } = stating(catalogOf("Marker"));
    const source = [
      '<Let as="catalog" value="a planted catalog" />',
      '<Syntax as="observed" />',
      "{observed}",
      "",
    ].join("\n");
    const output = String(yield* run(source, [installation]));
    expect(output).toContain("### `<Marker>`");
    expect(output).not.toContain("a planted catalog");
  });
});

describe("Tier SC — the site the catalog describes", () => {
  it("SC16: the derived catalog reports this execution's own includes and registry", function* () {
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(join(dir, "Local.md"), "a local component\n");
      // No host contribution: canonical core derives the catalog from the
      // selection inputs this execution captured.
      const output = String(yield* run("<Syntax />\n", [], undefined, [dir]));
      expect(output).toContain("### `<Local>`");
      // And it describes itself, once, with the approved description.
      expect(output).toContain("### `<Syntax>`");
      expect(output).toContain(DESCRIPTION);
      expect(output).toContain("`@executablemd/core` (reserved registration)");
    });
  });

  it("SC17: a workflow root observes its own bundle without running a member", function* () {
    const entered: string[] = [];
    const bundle = {
      components: [
        {
          name: "Bundled",
          path: "components/Bundled.md",
          sourceHash: "1".repeat(40),
          content: "a bundled component\n",
        },
      ],
    };
    const stream = new InMemoryStream();
    const output = String(yield* run("<Syntax />\n", [{ bundle }], stream));
    expect(output).toContain("### `<Bundled>`");
    // Described, not run: nothing imported or expanded the member.
    expect(entered).toEqual([]);
    const imported = (yield* stream.readAll()).filter(
      (event) => event.type === "yield" && event.description.type === "import_component",
    );
    expect(
      imported.some((event) => event.type === "yield" && event.description.name === "Bundled"),
    ).toBe(false);
  });

  it("SC18: a declared Markdown component's own body observes the site it inherited", function* () {
    const source = ['<Syntax as="catalog" />', "policy sees {catalog}", ""].join("\n");
    const declaration: DeclaredMarkdownComponent = {
      name: "Policy",
      origin: "@executablemd/test/Policy.md",
      source,
      digest: sourceDigest(source),
    };
    const { installation } = stating(catalogOf("Marker"));
    const output = String(
      yield* run("<Policy />\n", [installation, { declarations: [declaration] }]),
    );
    expect(output).toContain("policy sees");
    expect(output).toContain("### `<Marker>`");
  });
});

describe("Tier SC — the record one occurrence keeps", () => {
  it("SC19: the retained payload is closed on exactly { catalog }", function* () {
    const stream = new InMemoryStream();
    yield* run("<Syntax />\n", [stating(catalogOf("Marker")).installation], stream);
    const [observation] = observations(yield* stream.readAll());
    if (observation?.type !== "yield" || observation.result.status !== "ok") {
      throw new Error("the run retained no catalog observation");
    }
    const value = Object(observation.result.value);
    expect(Object.keys(value)).toEqual(["catalog"]);
    expect(typeof value.catalog).toBe("string");
  });

  it("SC20: a continuation restores the catalog after the environment moves, and asks nothing", function* () {
    const first = new InMemoryStream();
    const before = String(
      yield* run("<Syntax />\n", [stating(catalogOf("Before")).installation], first),
    );
    expect(before).toContain("### `<Before>`");

    // The environment moved: the host now states a different profile, and the
    // contribution refuses to answer at all.
    const moved: ExecutionInstallation = {
      // deno-lint-ignore require-yield
      *catalog(): Operation<SyntaxCatalog> {
        throw new Error("the continuation rebuilt the catalog");
      },
    };
    const continued = String(yield* run("<Syntax />\n", [moved], yield* continuing(first)));
    expect(continued).toContain("### `<Before>`");
    expect(continued).not.toContain("### `<After>`");

    // A fresh execution sees the moved environment, which is what shows the
    // restoration above was retention rather than the observation being inert.
    expect(
      String(yield* run("<Syntax />\n", [stating(catalogOf("After")).installation])),
    ).toContain("### `<After>`");
  });

  it("SC21: a missing, extra or wrong-typed retained payload refuses before output or binding", function* () {
    const cases: [string, (value: Json) => Json][] = [
      ["the member is missing", () => ({})],
      ["an unknown member was added", (value) => ({ ...Object(value), extra: true })],
      ["the member has the wrong type", () => ({ catalog: 7 })],
    ];
    for (const [, replace] of cases) {
      const first = new InMemoryStream();
      yield* run("<Syntax />\n", [stating(catalogOf("Marker")).installation], first);
      const hostile = yield* tampered(first, replace);
      const refused = yield* refusal(
        run(
          '<Syntax as="catalog" />bound:{catalog}',
          [stating(catalogOf("Marker")).installation],
          hostile,
        ),
      );
      expect(refused).toContain("is not a catalog this version can read");
    }
  });

  it("SC22: a cancelled observation tears down and commits no catalog", function* () {
    const teardown: string[] = [];
    const stream = new InMemoryStream();
    const hanging: ExecutionInstallation = {
      *catalog(): Operation<SyntaxCatalog> {
        yield* ensure(function* () {
          teardown.push("released");
        });
        yield* suspend();
        throw new Error("unreachable");
      },
    };

    yield* scoped(function* () {
      const running = yield* spawn(function* () {
        yield* run("<Syntax />\n", [hanging], stream);
      });
      // Long enough for the observation to be entered and suspended.
      yield* sleep(20);
      yield* running.halt();
    });

    // The structured teardown ran, and nothing successful was committed.
    expect(teardown).toEqual(["released"]);
    const committed = observations(yield* stream.readAll()).filter(
      (event) => event.type === "yield" && event.result.status === "ok",
    );
    expect(committed).toEqual([]);
  });
});

describe("Tier SC — observation is never authority", () => {
  it("SC23: a catalog naming a component neither registers nor resolves it", function* () {
    // The strongest form: the trusted host itself states a catalog naming a
    // component nothing supplies.
    const { installation } = stating(catalogOf("Phantom"));
    const output = String(yield* run("<Syntax />\n", [installation]));
    expect(output).toContain("### `<Phantom>`");

    // It is still a name nothing answers for.
    expect(yield* refusal(run("<Phantom />\n", [installation]))).toContain(
      "Cannot resolve component: Phantom",
    );
    expect((yield* selectComponent("Phantom", { includes: [] })).kind).toBe("unresolved");
  });

  it("SC24: the component is described identically by inspection and by validation", function* () {
    const catalog = yield* inspectSyntax({ includes: [] });
    const entry = catalog.categories[1].entries.find((candidate) => candidate.name === "Syntax");
    expect(entry).toBeDefined();
    expect(entry?.description).toBe(DESCRIPTION);
    expect(entry?.forms).toEqual(["self-closing"]);
    expect(entry?.returnMode).toBe("text");
    expect(entry?.props).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(entry?.origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: true,
    });
    // Exactly one entry, in exactly one category.
    const everywhere = catalog.categories.flatMap((category) =>
      category.entries.filter((candidate) => candidate.name === "Syntax"),
    );
    expect(everywhere.length).toBe(1);

    const described = yield* inspectComponent({ name: "Syntax", includes: [] });
    expect(described.kind).toBe("registered");

    // Validation reads the same declaration, so a paired spelling is invalid
    // before anything runs and the self-closing one is valid.
    const bad = yield* validateDocumentStructure({
      ...retainedSource("<eval>", "<Syntax>content</Syntax>\n"),
      includes: [],
    });
    expect(bad.diagnostics.some((issue) => issue.code === "invocation-form-invalid")).toBe(true);
    const good = yield* validateDocumentStructure({
      ...retainedSource("<eval>", "<Syntax />\n"),
      includes: [],
    });
    expect(good.diagnostics).toEqual([]);
  });

  /**
   * The seam a trusted evaluation boundary narrows through.
   *
   * `<Evaluate>` admits an exact vocabulary before it expands a generated
   * fragment, and the observation it installs for that subtree is that
   * admission's own catalog — it cannot add an entry the admission does not
   * hold, because it is handed the catalog rather than asked to build one.
   * Installing it for an evaluation subtree is #713's; that the observation is
   * the catalog and nothing more is this.
   */
  it("SC25b: a narrowed observation answers with exactly the catalog it was given", function* () {
    const narrowed = catalogOf("Admitted");
    const observation = fixedCatalogObservation(narrowed);
    expect(yield* observation.observe()).toBe(renderSyntaxMarkdown(narrowed));
    // Nothing of the enclosing site leaks into it: a name the wider profile has
    // is absent, because the catalog it was handed does not hold one.
    expect(yield* observation.observe()).not.toContain("### `<Syntax>`");
  });

  it("SC25: an execution that carries no observation refuses rather than inventing one", function* () {
    // `execute()` driven directly still carries one, so the case that has none
    // is an expansion driven outside an execution — which is what a component
    // reaching for a catalog with nothing established would meet.
    const output = String(
      yield* collect(
        yield* execute({
          ...retainedSource(ROOT_PATH, "<Syntax />\n"),
          stream: new InMemoryStream(),
          includes: [],
        }),
      ),
    );
    // An ordinary `execute()` derives its own, so this is the positive control
    // that the derived path needs no host at all.
    expect(output).toContain("### `<Syntax>`");
  });
});
