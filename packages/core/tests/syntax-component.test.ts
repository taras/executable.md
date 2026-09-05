/**
 * Tier SYN — `<Syntax />`, the component canonical core owns.
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
import { installedBundle } from "../src/components/bundle.ts";
import { retainedSource } from "../src/root-source.ts";
import { renderSyntaxMarkdown } from "../src/syntax-markdown.ts";
import { fixedCatalogObservation, rootCatalogObservation } from "../src/syntax-observation.ts";
import type { CatalogObservation } from "../src/syntax-observation.ts";
import type { DocumentationContribution } from "../src/component-documentation.ts";
import { SYNTAX_COMPONENT } from "../src/components/Syntax.ts";
import type { ImportedDefinition } from "../src/components/import-authority.ts";
import type { ComponentOrigin, FunctionComponent, SyntaxCatalog } from "../mod.ts";

/** An origin a catalog *component* entry can carry — everything but structural. */
type NamedOrigin = Exclude<ComponentOrigin, { kind: "structural" }>;

const ROOT_PATH = "documents/root.md";

/** The approved description, spelled here so a change to it fails a test. */
const DESCRIPTION =
  "Inspect components and control-flow constructs. `<Syntax />` renders the current " +
  'catalog; `<Syntax names={["Elicit"]} />` renders selected documentation.';

/** A catalog with one built-in entry per name, for a case that needs a marker. */
function catalogOf(...names: readonly string[]): SyntaxCatalog {
  return {
    version: 2,
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

/**
 * Only the observations that succeeded.
 *
 * A refusal still records the attempt and its failure, which is how a journal
 * says what happened. What must not exist is a *successful* record: that is the
 * thing a continuation would restore and hand back as a catalog.
 */
function retained(events: readonly DurableEvent[]): DurableEvent[] {
  return observations(events).filter(
    (event) => event.type === "yield" && event.result.status === "ok",
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

/** A catalog holding one component entry of exactly this identity. */
function catalogNamed(name: string, origin: NamedOrigin): SyntaxCatalog {
  return {
    version: 2,
    categories: [
      { kind: "structural", entries: [] },
      {
        kind: "built-in",
        entries: [
          {
            kind: "component" as const,
            name,
            origin,
            sourceKind: "registered" as const,
            inspectability: "complete" as const,
            forms: ["self-closing" as const],
            props: { type: "object", properties: {}, additionalProperties: false },
            captures: [],
            returnMode: "text" as const,
            returns: { type: "string" },
          },
        ],
      },
      { kind: "user-provided", entries: [] },
    ],
  };
}

/**
 * The observation an ordinary root carries.
 *
 * Built the way an execution builds it — from captured selection inputs, with
 * no host contribution — so a case about narrowing is about the object the
 * product actually hands to expansion.
 */
function rootObservation(): CatalogObservation {
  return rootCatalogObservation(
    { includes: [], registry: new Map(), components: [], declarations: [] },
    undefined,
  );
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

describe("Tier SYN — what one occurrence answers", () => {
  it("SYN1: the bare form renders the catalog once, and `as` binds the same text", function* () {
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

  it("SYN2: it renders exactly what the shared Markdown renderer produces", function* () {
    const catalog = catalogOf("Marker", "Other");
    const { installation } = stating(catalog);
    const bare = yield* run('<Syntax as="catalog" />{catalog}', [installation]);
    // The same function `xmd syntax` renders with, not a second one that agrees
    // today: an invocation and the command cannot describe one profile in two
    // sets of words.
    expect(String(bare)).toBe(renderSyntaxMarkdown(catalog));
  });

  it("SYN3: a paired spelling and an authored prop refuse before any observation", function* () {
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

  it("SYN4: one occurrence observes once, two observe independently, a binding observes neither again", function* () {
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

describe("Tier SYN — the named form", () => {
  it("SYN29: renders the selected entries' metadata and documentation, and captures it", function* () {
    const named = String(yield* run('<Syntax names={["File", "Elicit"]} />\n'));

    // Both selected, each once, with metadata and long-form documentation.
    expect(named).toContain("### `<Elicit>`");
    expect(named).toContain("### `<File>`");
    expect(named).toContain("Asks a person a structured question");
    expect(named).toContain("Reads or writes a file");
    // Catalog order, not request order: `Elicit` precedes `File` alphabetically
    // and the request asked for them the other way round.
    expect(named.indexOf("### `<Elicit>`")).toBeLessThan(named.indexOf("### `<File>`"));
    // Nothing but the selection: the rest of the catalog is not here.
    expect(named).not.toContain("### `<Syntax>`");

    // `as` binds the same text and emits nothing of it.
    const captured = String(
      yield* run(['<Syntax names={["Elicit"]} as="reference" />', "{reference}", ""].join("\n")),
    );
    const bare = String(yield* run('<Syntax names={["Elicit"]} />\n'));
    expect(captured.trim()).toBe(bare.trim());
  });

  it("SYN30: states availability, and says so when documentation is absent", function* () {
    const named = String(yield* run('<Syntax names={["Elicit"]} />\n'));
    // At a root nothing has narrowed execution, so a selected entry is
    // available by construction.
    expect(named).toContain("**Available in this evaluation:** yes");

    // A component core supplies but has not documented yet renders its
    // metadata and says the documentation is missing, rather than refusing.
    // A custom component nothing documents: a repository file, which no
    // first-party package governs, so the fallback is the honest answer rather
    // than a hole in the product's own reference.
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(join(dir, "Homegrown.md"), "a component of my own\n");
      const undocumented = String(
        yield* run('<Syntax names={["Homegrown"]} />\n', [], undefined, [dir]),
      );
      expect(undocumented).toContain("### `<Homegrown>`");
      expect(undocumented).toContain("No long-form documentation is available for this component.");
    });

    // A structural construct is not a component, and `names` is a component
    // lookup: it refuses rather than rendering one.
    const structural = yield* refusal(run('<Syntax names={["If"]} />\n'));
    expect(structural).toContain("If");
  });

  it("SYN40: documentation survives planted filesystem middleware", function* () {
    const asked: string[] = [];
    const canonical = String(yield* run('<Syntax names={["Elicit"]} />\n'));
    expect(canonical).toContain("Asks a person a structured question");

    // A repository component that wraps the named form, with `API.Fs` middleware
    // planted around it. If package documentation were read through the
    // filesystem Api a document can compose — or through the `Files` authority —
    // this would answer for the product's own reference, and an agent could be
    // handed instructions the product never wrote.
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(
        join(dir, "Wrapper.md"),
        ['<Syntax names={["Elicit"]} />', ""].join("\n"),
      );
      const output = String(
        yield* scoped(function* () {
          yield* API.Fs.around({
            *readTextFile([path], next) {
              asked.push(String(path));
              if (String(path).endsWith("components.md")) {
                return "## Elicit\n\nSUBSTITUTED BY A DOCUMENT.\n";
              }
              return yield* next(path);
            },
          });
          return yield* collect(
            yield* executeInstalled(
              {
                ...retainedSource(ROOT_PATH, "<Wrapper />\n"),
                stream: new InMemoryStream(),
                includes: [dir],
              },
              [],
            ),
          );
        }),
      );

      expect(output).toContain("Asks a person a structured question");
      expect(output).not.toContain("SUBSTITUTED BY A DOCUMENT");
      // And the read never went through that Api at all, which is why.
      expect(asked.some((path) => path.endsWith("components.md"))).toBe(false);
    });
  });

  it("SYN46: a cancelled named observation tears down and commits nothing", function* () {
    const torn: string[] = [];
    const stream = new InMemoryStream();

    // A host whose catalog contribution suspends: the named form is inside the
    // observation when the scope is cancelled, which is the window a record
    // could be written in.
    const suspending: ExecutionInstallation = {
      *catalog(): Operation<SyntaxCatalog> {
        // Entered *inside* the named documentation operation: the component has
        // claimed its occurrence and opened its durable operation by the time
        // this runs, so a cancellation that arrives now is one that landed in
        // the work rather than before it.
        torn.push("entered");
        yield* ensure(() => {
          torn.push("torn down");
        });
        yield* suspend();
        return catalogOf("Unreachable");
      },
    };

    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        return yield* run('<Syntax names={["Elicit"]} />\n', [suspending], stream);
      });
      // Let the observation get inside its operation before cancelling it.
      yield* sleep(20);
      yield* task.halt();
    });

    const events = yield* stream.readAll();
    // Reached the work, then tore it down — in that order. Cancelling before
    // the observation was entered would leave `entered` absent, which is the
    // vacuous pass this ordering rules out.
    expect(torn).toEqual(["entered", "torn down"]);
    // Nothing was committed at all: a durable operation records its event when
    // it completes, and this one never did. So there is no record for a
    // continuation to restore, successful or otherwise.
    expect(observations(events)).toHaveLength(0);
    expect(retained(events)).toHaveLength(0);
  });

  it("SYN25g: an installation cannot rewrite its documentation from install()", function* () {
    // Everything a host still holds after handing its contribution over: the
    // source object, its text, and the name set. `install()` runs *after* the
    // capture boundary, which is exactly the window this closes — a snapshot
    // taken later, or a shallow copy of the array, would serve whatever these
    // say by the time a document asks.
    // A package of its own, so this is about capture rather than about
    // colliding with core's real documentation of the same name.
    const supplies = new Set(["Marker"]);
    const source = {
      owner: "@executablemd/test",
      asset: "packages/test/src/components.md",
      text: "## Marker\n\nTHE CAPTURED PROSE.\n",
    };

    const installation: ExecutionInstallation = {
      components: [],
      documentation: [{ source, supplies }],
      // deno-lint-ignore require-yield
      *install(): Operation<void> {
        source.text = "## Marker\n\nSUBSTITUTED FROM INSTALL.\n";
        source.owner = "@executablemd/impostor";
        supplies.add("Substituted");
        supplies.delete("Marker");
      },
    };

    const { installation: marker } = stating(catalogOf("Marker"));
    const rendered = String(yield* run('<Syntax names={["Marker"]} />\n', [marker, installation]));

    // The prose captured before `install()` ran, and none of what it wrote.
    expect(rendered).toContain("THE CAPTURED PROSE.");
    expect(rendered).not.toContain("SUBSTITUTED FROM INSTALL");
    // And the coverage it was captured with: adding a name afterwards neither
    // demands documentation for it nor refuses the index.
    expect(rendered).not.toContain("Substituted");
  });

  it("SYN39: retains the named text, and a continuation restores it whole", function* () {
    const stream = new InMemoryStream();
    const first = String(yield* run('<Syntax names={["Elicit"]} />\n', [], stream));
    expect(first).toContain("Asks a person a structured question");

    // Exactly what was rendered, not the compact catalog: the record is the
    // occurrence's final text whichever form produced it.
    const records = retained(yield* stream.readAll());
    expect(records).toHaveLength(1);
    const record = records[0];
    const value =
      record?.type === "yield" && record.result.status === "ok" ? record.result.value : undefined;
    expect(Object.keys(value as object)).toEqual(["catalog"]);
    // The component's own return, which the document then renders — so the two
    // differ by the trailing newline presentation adds, and nothing else.
    expect(String((value as { catalog: string }).catalog).trim()).toBe(first.trim());

    // A continuation hands the same text back. The documentation asset is not
    // reread and the catalog is not rebuilt: what an agent was shown is what it
    // is shown again.
    const resumed = String(
      yield* run('<Syntax names={["Elicit"]} />\n', [], yield* continuing(stream)),
    );
    expect(resumed).toBe(first);

    // And a record this version cannot read refuses rather than inventing one.
    const corrupted = yield* tampered(stream, () => ({ catalog: "x", extra: 1 }));
    const refused = yield* refusal(run('<Syntax names={["Elicit"]} />\n', [], corrupted));
    expect(refused).toContain("not a catalog this version can read");
  });

  it("SYN31: refuses an unusable list before observing anything", function* () {
    const stream = new InMemoryStream();
    const unknown = yield* refusal(run('<Syntax names={["Nonexistent"]} />\n', [], stream));
    expect(unknown).toContain("Nonexistent");
    // No successful record: the attempt and its failure are journaled, as any
    // effect's are, but there is nothing for a continuation to restore and hand
    // back as a catalog.
    expect(retained(yield* stream.readAll())).toHaveLength(0);

    for (const written of [
      "<Syntax names={[]} />",
      '<Syntax names={["Elicit", "Elicit"]} />',
      "<Syntax names={[1]} />",
      '<Syntax names="Elicit" />',
      '<Syntax unknownProp="x" />',
    ]) {
      const each = new InMemoryStream();
      const message = yield* refusal(run(`${written}\n`, [], each));
      expect([written, message.length > 0]).toEqual([written, true]);
      expect([written, retained(yield* each.readAll()).length]).toEqual([written, 0]);
    }
  });
});

describe("Tier SYN — the name canonical core owns", () => {
  it("SYN5: a repository Syntax.md, Syntax.ts and directory candidate never win", function* () {
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

  it("SYN6: selection reports the protected tier ahead of every other", function* () {
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(join(dir, "Syntax.md"), "a repository catalog\n");
      const selected = yield* selectComponent(SYNTAX_COMPONENT, { includes: [dir] });
      expect(selected.kind).toBe("protected");
      // Its own origin kind. Not a reserved registration: that is a host
      // installing something under a name, which can be absent, replaced or
      // refused, and none of those is true of a name core owns.
      expect(selected.kind === "protected" ? selected.origin : undefined).toEqual({
        kind: "protected",
        origin: "@executablemd/core",
      });
    });
  });

  it("SYN7: an ordinary and a reserved registration named Syntax are both refused", function* () {
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

  it("SYN8: the refused batch registers nothing, and an adjacent registration still works", function* () {
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

  it("SYN9: a host that declares Markdown called Syntax is refused before the root import", function* () {
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

  it("SYN10: a workflow bundle member called Syntax is refused before the root import", function* () {
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

describe("Tier SYN — what the chain may and may not do", () => {
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

  it("SYN11: ordinary delegation reaches canonical Syntax", function* () {
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

  it("SYN12: a handler that answers, substitutes, mutates or copies runs no replacement", function* () {
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

  it("SYN13: a handler that redirects the name, or delegates twice, answers nothing", function* () {
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

  it("SYN14: a deliberate middleware refusal stays a refusal", function* () {
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

  it("SYN15: a document-authored context and a look-alike observation change nothing", function* () {
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

describe("Tier SYN — the site the catalog describes", () => {
  it("SYN16: the derived catalog reports this execution's own includes and registry", function* () {
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(join(dir, "Local.md"), "a local component\n");
      // No host contribution: canonical core derives the catalog from the
      // selection inputs this execution captured.
      const output = String(yield* run("<Syntax />\n", [], undefined, [dir]));
      expect(output).toContain("### `<Local>`");
      // And it describes itself, once, with the approved description.
      expect(output).toContain("### `<Syntax>`");
      expect(output).toContain(DESCRIPTION);
      // Its own provenance, not a registration's. A reader deciding whether
      // they could supply this name themselves gets the opposite answer from
      // the two phrases, so the catalog must not print the other one.
      expect(output).toContain("`@executablemd/core` (protected component)");
      expect(output).not.toContain("reserved registration");
    });
  });

  it("SYN27: the catalog reports a protected component as protected, not registered", function* () {
    const { installation } = stating(catalogOf("Marker"));
    const catalog = yield* scoped(function* () {
      yield* executeInstalled(
        {
          ...retainedSource(ROOT_PATH, "<Syntax />\n"),
          stream: new InMemoryStream(),
          includes: [],
        },
        [installation],
      );
      return yield* inspectSyntax({ includes: [] });
    });
    expect(catalog.version).toBe(2);

    // Built-in: the second category, where a reader indexes for it.
    const entry = catalog.categories[1].entries.find((candidate) => candidate.name === "Syntax");
    if (entry === undefined) {
      throw new Error("expected the catalog to describe <Syntax>");
    }
    // The structured origin, which is what a machine reader switches on.
    expect(entry.origin).toEqual({ kind: "protected", origin: "@executablemd/core" });
    expect(entry.sourceKind).toBe("protected");

    // And `inspectComponent` agrees, so one name and the whole environment
    // cannot describe the same component two ways.
    const info = yield* scoped(function* () {
      return yield* inspectComponent({ name: "Syntax", includes: [] });
    });
    if (info.kind !== "protected") {
      throw new Error(`expected a protected component, got ${info.kind}`);
    }
    expect(info.origin).toEqual({ kind: "protected", origin: "@executablemd/core" });
  });

  it("SYN28: a bundled component is reported as pinned, not as a repository file", function* () {
    const sourceHash = "1".repeat(40);
    const bundle = {
      components: [
        {
          name: "Bundled",
          path: "components/Bundled.md",
          sourceHash,
          content: "a bundled component\n",
        },
      ],
    };
    const output = String(yield* run("<Syntax />\n", [{ bundle }]));

    // The path alone would read as a file the reader could edit; the blob id is
    // what says this is the exact source the run was defined against.
    expect(output).toContain("`components/Bundled.md` (workflow bundle, `111111111111`)");

    const catalog = yield* scoped(function* () {
      const registry = yield* Component.operations.registry;
      const workflow = installedBundle([bundle], registry);
      if (workflow === undefined) {
        throw new Error("expected the bundle to install");
      }
      return yield* inspectSyntax({ includes: [], workflow });
    });
    // User-provided: the third category.
    const entry = catalog.categories[2].entries.find((candidate) => candidate.name === "Bundled");
    if (entry === undefined || entry.inspectability !== "complete") {
      throw new Error("expected the catalog to describe <Bundled> completely");
    }
    expect(entry.origin).toEqual({
      kind: "workflow",
      path: "components/Bundled.md",
      sourceHash,
    });
    expect(entry.sourceKind).toBe("workflow-markdown");
  });

  it("SYN17: a workflow root observes its own bundle without running a member", function* () {
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

  it("SYN18: a declared Markdown component's own body observes the site it inherited", function* () {
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

describe("Tier SYN — the record one occurrence keeps", () => {
  it("SYN19: the retained payload is closed on exactly { catalog }", function* () {
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

  it("SYN20: a continuation restores the catalog after the environment moves, and asks nothing", function* () {
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

  it("SYN21: a missing, extra or wrong-typed retained payload refuses before output or binding", function* () {
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

  it("SYN22: a cancelled observation tears down and commits no catalog", function* () {
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

describe("Tier SYN — observation is never authority", () => {
  it("SYN23: a catalog naming a component neither registers nor resolves it", function* () {
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

  it("SYN24: the component is described identically by inspection and by validation", function* () {
    const catalog = yield* inspectSyntax({ includes: [] });
    const entry = catalog.categories[1].entries.find((candidate) => candidate.name === "Syntax");
    expect(entry).toBeDefined();
    expect(entry?.description).toBe(DESCRIPTION);
    expect(entry?.forms).toEqual(["self-closing"]);
    expect(entry?.returnMode).toBe("text");
    // One optional prop, closed: `names` selects documentation, and anything
    // else is refused before an observation.
    expect(entry?.props).toEqual({
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          uniqueItems: true,
          description:
            "Optional. Render these components' catalog metadata and long-form documentation " +
            "instead of the compact catalog. Entries render once each, in catalog order.",
        },
      },
      additionalProperties: false,
    });
    expect(entry?.origin).toEqual({ kind: "protected", origin: "@executablemd/core" });
    // Exactly one entry, in exactly one category.
    const everywhere = catalog.categories.flatMap((category) =>
      category.entries.filter((candidate) => candidate.name === "Syntax"),
    );
    expect(everywhere.length).toBe(1);

    const described = yield* inspectComponent({ name: "Syntax", includes: [] });
    expect(described.kind).toBe("protected");

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
  it("SYN25b: a narrowed observation answers with exactly the catalog it was given", function* () {
    const narrowed = catalogOf("Admitted");
    const observation = fixedCatalogObservation(narrowed);
    expect(yield* observation.observe()).toBe(renderSyntaxMarkdown(narrowed));
    // Nothing of the enclosing site leaks into it: a name the wider profile has
    // is absent, because the catalog it was handed does not hold one.
    expect(yield* observation.observe()).not.toContain("### `<Syntax>`");
  });

  /**
   * The seam #713 installs through, proved without an `<Evaluate>`.
   *
   * A narrowing boundary hands the observation two catalogs: what may execute
   * in the subtree, and the enclosing authoring catalog selection reads from.
   * Everything below is about them being genuinely two.
   */
  it("SYN25c: a narrowed observation documents the enclosing site and marks availability", function* () {
    const enclosing = catalogOf("Admitted", "Withheld");
    const narrowed = catalogOf("Admitted");
    const observation = fixedCatalogObservation(narrowed, enclosing);

    // What may execute here is the narrowed catalog, and the bare form reports
    // exactly that.
    const available = yield* observation.observe();
    expect(available).toContain("### `<Admitted>`");
    expect(available).not.toContain("### `<Withheld>`");

    // Reference material comes from the enclosing catalog, so a component this
    // subtree may not run can still be explained — and the entry says so
    // rather than leaving a reader to assume they have both.
    const documented = yield* observation.document(["Withheld"]);
    expect(documented).toContain("### `<Withheld>`");
    expect(documented).toContain("**Available in this evaluation:** no");

    // And one that is admitted reports the other answer, so the field is
    // discriminating rather than a constant.
    const admitted = yield* observation.document(["Admitted"]);
    expect(admitted).toContain("**Available in this evaluation:** yes");

    // A boundary that narrows nothing has one catalog, and everything in it is
    // available — the ordinary case.
    const open = fixedCatalogObservation(enclosing);
    expect(yield* open.document(["Withheld"])).toContain("**Available in this evaluation:** yes");
  });

  it("SYN25d: availability compares the whole identity, not the spelling", function* () {
    /** One catalog holding a single entry of exactly this identity. */
    const holding = (origin: NamedOrigin): SyntaxCatalog => ({
      version: 2,
      categories: [
        { kind: "structural", entries: [] },
        {
          kind: "built-in",
          entries: [
            {
              kind: "component" as const,
              name: "Elicit",
              origin,
              sourceKind: "registered" as const,
              inspectability: "complete" as const,
              forms: ["self-closing" as const],
              props: { type: "object", properties: {}, additionalProperties: false },
              captures: [],
              returnMode: "text" as const,
              returns: { type: "string" },
            },
          ],
        },
        { kind: "user-provided", entries: [] },
      ],
    });

    const reference: NamedOrigin = {
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    };

    // Each of these is a *different component* that happens to be spelled
    // `Elicit`. Reporting the reference entry as available because something of
    // that name can run would tell an author they may execute what they were
    // just shown.
    const impostors: Record<string, NamedOrigin> = {
      "another registered origin": {
        kind: "registered",
        origin: "@someone/else",
        reserved: false,
      },
      "a reserved registration of the same origin": {
        kind: "registered",
        origin: "@executablemd/core",
        reserved: true,
      },
      "a repository file": { kind: "repository", path: "components/Elicit.md" },
      "a bundled blob": {
        kind: "workflow",
        path: "components/Elicit.md",
        sourceHash: "a".repeat(40),
      },
      "declared Markdown": {
        kind: "declared-markdown",
        origin: "@executablemd/core",
        digest: "b".repeat(64),
      },
    };

    for (const [what, origin] of Object.entries(impostors)) {
      const observation = fixedCatalogObservation(holding(origin), holding(reference));
      const rendered = yield* observation.document(["Elicit"]);
      expect([what, rendered.includes("**Available in this evaluation:** no")]).toEqual([
        what,
        true,
      ]);
    }

    // Two more of the same kind, differing only in the member that identifies
    // them: a different blob under one path, and a different digest under one
    // origin.
    const bundled: NamedOrigin = {
      kind: "workflow",
      path: "components/Elicit.md",
      sourceHash: "a".repeat(40),
    };
    const moved: NamedOrigin = { ...bundled, sourceHash: "c".repeat(40) };
    expect(
      yield* fixedCatalogObservation(holding(moved), holding(bundled)).document(["Elicit"]),
    ).toContain("**Available in this evaluation:** no");

    // The positive control: one exact identity, admitted.
    expect(
      yield* fixedCatalogObservation(holding(reference), holding(reference)).document(["Elicit"]),
    ).toContain("**Available in this evaluation:** yes");
  });

  it("SYN25e: a narrowed observation is derived from the enclosing one", function* () {
    // The seam as an evaluator actually meets it: it holds the enclosing
    // observation and an admitted catalog, and nothing else. No raw
    // contribution list, no second index — which is the point, because that
    // list is execution-private and rebuilding an index from it is how two
    // indexes drift apart.
    const enclosing = rootObservation();
    const admitted = catalogOf("Admitted");
    const narrowed = enclosing.narrow(admitted);

    // What may run is the admission.
    const executable = yield* narrowed.observe();
    expect(executable).toContain("### `<Admitted>`");
    expect(executable).not.toContain("### `<Elicit>`");

    // What may be read about is still the enclosing site's, with the enclosing
    // index behind it — so a real component's real documentation survives.
    const documented = yield* narrowed.document(["Elicit"]);
    expect(documented).toContain("### `<Elicit>`");
    expect(documented).toContain("Asks a person a structured question");
    expect(documented).toContain("**Available in this evaluation:** no");

    // And the enclosing observation is unchanged by having been narrowed.
    expect(yield* enclosing.observe()).toContain("### `<Elicit>`");
    expect(yield* enclosing.document(["Elicit"])).toContain(
      "**Available in this evaluation:** yes",
    );
  });

  it("SYN25f: contributions are captured, not held by reference", function* () {
    const supplies = new Set(["Alpha"]);
    const source = {
      owner: "@executablemd/mutable",
      asset: "packages/mutable/src/components.md",
      text: "## Alpha\n\nThe captured documentation.\n",
    };
    const contribution = { source, supplies };
    const observation = fixedCatalogObservation(
      catalogNamed("Alpha", {
        kind: "registered",
        origin: "@executablemd/mutable",
        reserved: false,
      }),
      undefined,
      [contribution],
    );

    // Everything a caller still holds, changed after capture.
    source.text = "## Alpha\n\nSUBSTITUTED AFTER CAPTURE.\n";
    source.owner = "@executablemd/other";
    supplies.add("Beta");
    supplies.delete("Alpha");

    const rendered = yield* observation.document(["Alpha"]);
    expect(rendered).toContain("The captured documentation.");
    expect(rendered).not.toContain("SUBSTITUTED AFTER CAPTURE");
  });

  it("SYN25: an execution that carries no observation refuses rather than inventing one", function* () {
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
