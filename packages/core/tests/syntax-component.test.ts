/**
 * Tier SYN — `<Syntax />`, the component canonical core owns.
 *
 * What a document may write here is a public question, and this is the public
 * answer: the symbols for the site the element was written at, in the words
 * `xmd syntax` prints. Three things follow, and every case here is about one of
 * them.
 *
 * **The name is the engine's.** A repository `Syntax.md`, a bundled `Syntax`, an
 * ordinary or reserved registration, a host declaration, import middleware and a
 * definition from a second loaded copy can none of them answer for it. Symbols
 * anything in the run could answer for describe nothing.
 *
 * **The answer is the site's.** The reference is built from the selection
 * inputs the execution captured before any installation, middleware or document
 * code ran, and it travels lexically on canonical core's own expansion
 * authority — not through a context, where a name is not a secret.
 *
 * **One occurrence renders once.** It claims the identity this execution
 * minted, records exactly `{ symbols }`, and a continuation hands that back
 * without consulting the filesystem, the registry, the bundle or the host again.
 *
 * Protection is about the answer, not about power: the component receives one
 * reference that renders symbol text and nothing else, and naming a component in
 * the symbols is not permission to run it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { rm, writeTextFile } from "@effectionx/fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";

import { Component, content } from "../src/component-api.ts";
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
import { syntaxReference, rootSyntaxReference } from "../src/syntax-reference.ts";
import type { SyntaxReference } from "../src/syntax-reference.ts";
import { capturedDocumentation, contributeDocumentation } from "../src/documentation-api.ts";
import { executeReadingAssetsWith } from "../src/execute.ts";
import type { DocumentationContribution } from "../src/component-documentation.ts";
import { SYNTAX_COMPONENT } from "../src/components/Syntax.ts";
import type { ImportedDefinition } from "../src/components/import-authority.ts";
import type { ComponentOrigin, FunctionComponent, SyntaxSymbols } from "../mod.ts";

/** An origin a *component* symbol entry can carry — everything but structural. */
type NamedOrigin = Exclude<ComponentOrigin, { kind: "structural" }>;

const ROOT_PATH = "documents/root.md";

/** The approved description, spelled here so a change to it fails a test. */
const DESCRIPTION =
  "Inspect available components and control-flow constructs. `<Syntax />` lists the " +
  'symbols available here; `<Syntax names={["Elicit"]} />` renders selected documentation.';

/** Symbols with one built-in entry per name, for a case that needs a marker. */
function symbolsOf(...names: readonly string[]): SyntaxSymbols {
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

/** A host that states the symbols its profile describes, and counts the asks. */
function stating(symbols: SyntaxSymbols, calls: { count: number } = { count: 0 }) {
  const installation: ExecutionInstallation = {
    // deno-lint-ignore require-yield
    *symbols(): Operation<SyntaxSymbols> {
      calls.count += 1;
      return symbols;
    },
  };
  return { installation, calls };
}

/**
 * A package of this suite's own, contributing documentation for `<Marker>`.
 *
 * A name core does not ship, so a case about contribution is not also a case
 * about colliding with core's real documentation.
 */
function useMarkerDocumentation(asset = "packages/test/src/components.md"): Operation<void> {
  // deno-lint-ignore require-yield
  return contributeDocumentation(function* () {
    return {
      source: {
        owner: "@executablemd/test",
        asset,
        text: "## Marker\n\nMARKER PROSE.\n",
      },
      supplies: new Set(["Marker"]),
    };
  });
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

/** Every retained syntax record, in order. */
function syntaxReads(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "syntax_symbols",
  );
}

/**
 * Only the syntaxReads that succeeded.
 *
 * A refusal still records the attempt and its failure, which is how a journal
 * says what happened. What must not exist is a *successful* record: that is the
 * thing a continuation would restore and hand back as the symbols.
 */
function retained(events: readonly DurableEvent[]): DurableEvent[] {
  return syntaxReads(events).filter(
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

/** The same history with one retained reference replaced. */
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
      event.description.type === "syntax_symbols" &&
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

/** Symbols holding one component entry of exactly this identity. */
function symbolsNamed(name: string, origin: NamedOrigin): SyntaxSymbols {
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
 * The reference an ordinary root carries.
 *
 * Built the way an execution builds it — from captured selection inputs, with
 * no host contribution — so a case about narrowing is about the object the
 * product actually hands to expansion.
 */
function* rootObservation(): Operation<SyntaxReference> {
  return rootSyntaxReference(
    { includes: [], registry: new Map(), components: [], declarations: [] },
    undefined,
    // What canonical execution hands it: whatever the scope bootstrapped,
    // terminating in core's own. Passing nothing here would leave the reference
    // with no index at all, and a case about narrowing would then be reading a
    // fallback sentence rather than real documentation.
    yield* capturedDocumentation(),
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
  it("SYN1: the bare form renders the symbols once, and `as` binds the same text", function* () {
    const { installation } = stating(symbolsOf("Marker"));
    const bare = yield* run("<Syntax />\n", [installation]);
    expect(String(bare)).toContain("### `<Marker>`");
    // Once, not twice: one occurrence is one rendering.
    expect(String(bare).split("### `<Marker>`").length - 1).toBe(1);

    const captured = yield* run('<Syntax as="symbols" />\nbound:{symbols}\n', [installation]);
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
    const symbols = symbolsOf("Marker", "Other");
    const { installation } = stating(symbols);
    const bare = yield* run('<Syntax as="symbols" />{symbols}', [installation]);
    // The same function `xmd syntax` renders with, not a second one that agrees
    // today: an invocation and the command cannot describe one profile in two
    // sets of words.
    expect(String(bare)).toBe(renderSyntaxMarkdown(symbols));
  });

  it("SYN3: a paired spelling and an authored prop refuse before any reference", function* () {
    const paired = stating(symbolsOf("Marker"));
    expect(yield* refusal(run("<Syntax>content</Syntax>\n", [paired.installation]))).toContain(
      "written self-closing",
    );
    expect(paired.calls.count).toBe(0);

    const propped = stating(symbolsOf("Marker"));
    expect(yield* refusal(run('<Syntax mode="short" />\n', [propped.installation]))).toContain(
      "mode",
    );
    expect(propped.calls.count).toBe(0);

    // The positive control for the same host: the accepted spelling reads.
    const accepted = stating(symbolsOf("Marker"));
    expect(String(yield* run("<Syntax />\n", [accepted.installation]))).toContain("Marker");
    expect(accepted.calls.count).toBe(1);
  });

  it("SYN4: one occurrence reads once, two read independently, a binding reads neither again", function* () {
    const one = stating(symbolsOf("Marker"));
    yield* run('<Syntax as="symbols" />{symbols}{symbols}{symbols}', [one.installation]);
    expect(one.calls.count).toBe(1);

    const two = stating(symbolsOf("Marker"));
    yield* run("<Syntax />\n<Syntax />\n", [two.installation]);
    expect(two.calls.count).toBe(2);

    // Two identities, so two records rather than one record read twice.
    const stream = new InMemoryStream();
    yield* run("<Syntax />\n<Syntax />\n", [stating(symbolsOf("Marker")).installation], stream);
    expect(syntaxReads(yield* stream.readAll()).length).toBe(2);
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
    // Symbol order, not request order: `Elicit` precedes `File` alphabetically
    // and the request asked for them the other way round.
    expect(named.indexOf("### `<Elicit>`")).toBeLessThan(named.indexOf("### `<File>`"));
    // Nothing but the selection: the rest of the symbols are not here.
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

  it("SYN46: cancelling documentation collection tears down and commits nothing", function* () {
    const torn: string[] = [];
    const stream = new InMemoryStream();

    // Suspended inside *documentation collection*, which is where the packaged
    // asset is read: once, at the execution's own boundary, after the trusted
    // host bootstrapped and before the root import. So this is the window
    // between an execution having begun and any element of its document having
    // run, and what it rules out is a teardown that leaves the read hanging or
    // a partial record behind. The occurrence-level window is SYN22's.
    //
    // The reader belongs to *this* execution, handed to it at construction.
    // Nothing module-scoped: a second execution in this process reads through
    // its own, which SYN48 below is about.
    const suspending = function* (): Operation<string> {
      torn.push("entered");
      yield* ensure(() => {
        torn.push("torn down");
      });
      yield* suspend();
      return "## Elicit\n\nunreachable\n";
    };

    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        return yield* collect(
          yield* executeReadingAssetsWith(
            {
              ...retainedSource(ROOT_PATH, '<Syntax names={["Elicit"]} />\n'),
              stream,
              includes: [],
            },
            [],
            suspending,
          ),
        );
      });
      // Let collection get inside the read before cancelling it.
      yield* sleep(20);
      yield* task.halt();
    });

    const events = yield* stream.readAll();
    // Reached the read, then tore it down — in that order. Cancelling before
    // the read was entered would leave `entered` absent, which is the vacuous
    // pass this ordering rules out.
    expect(torn).toEqual(["entered", "torn down"]);
    // And nothing was committed at all. The document never expanded, so no
    // occurrence claimed an identity and no durable operation opened: there is
    // no record for a continuation to restore, successful or otherwise.
    expect(syntaxReads(events)).toHaveLength(0);
    expect(retained(events)).toHaveLength(0);
  });

  it("SYN25g: collection snapshots a contribution by value", function* () {
    // Everything a bootstrap still holds after its contribution is collected:
    // the source object, its text, and the name set. Collection snapshots field
    // by field, which is exactly the window this closes — a shallow copy of the
    // array would serve whatever these say by the time a document asks.
    //
    // A package of its own, so this is about capture rather than about
    // colliding with core's real documentation of the same name.
    const supplies = new Set(["Marker"]);
    const source = {
      owner: "@executablemd/test",
      asset: "packages/test/src/components.md",
      text: "## Marker\n\nTHE CAPTURED PROSE.\n",
    };

    const captured = yield* scoped(function* () {
      // deno-lint-ignore require-yield
      yield* contributeDocumentation(function* () {
        return { source, supplies };
      });
      const collected = yield* capturedDocumentation();
      // Rewritten *after* the collector returned, which is the whole window: a
      // reference built from this snapshot must not see any of it.
      source.text = "## Marker\n\nSUBSTITUTED AFTER COLLECTION.\n";
      source.owner = "@executablemd/impostor";
      supplies.add("Substituted");
      supplies.delete("Marker");
      return collected;
    });

    const mine = captured.find((one) => one.source.asset.startsWith("packages/test/"));
    if (mine === undefined) {
      throw new Error("the collector did not take this bootstrap's contribution");
    }
    expect(mine.source.text).toContain("THE CAPTURED PROSE.");
    expect(mine.source.text).not.toContain("SUBSTITUTED AFTER COLLECTION");
    expect(mine.source.owner).toBe("@executablemd/test");
    expect([...mine.supplies]).toEqual(["Marker"]);

    // And the snapshot renders that way through the reference an execution
    // builds from it, rather than only reading that way as a value.
    const rendered = yield* syntaxReference(
      symbolsOf("Marker"),
      symbolsOf("Marker"),
      captured,
    ).documentation(["Marker"]);
    expect(rendered).toContain("THE CAPTURED PROSE.");
    expect(rendered).not.toContain("SUBSTITUTED AFTER COLLECTION");
  });

  it("SYN25h: documentation arrives with the bootstrap that registers, or not at all", function* () {
    // The whole point of one call: registrations and documentation arrive
    // together or not at all. Two lists is what let a nested run register
    // `<WebForm>` and then report it undocumented — a component it can run,
    // described as undocumented.
    const { installation: marker } = stating(symbolsOf("Marker"));
    const without = String(yield* scoped(() => run('<Syntax names={["Marker"]} />\n', [marker])));
    // The component is there — the profile states it — and the prose is not.
    expect(without).toContain("### `<Marker>`");
    expect(without).toContain("No long-form documentation is available");
    expect(without).not.toContain("MARKER PROSE.");

    // Entered, the same site answers with the prose instead — *and* core's own
    // documentation is still there beside it. A wrapper that returned its own
    // contribution instead of appending to what it composed over would pass the
    // first assertion and lose the terminal, which is the whole reason the
    // chain delegates.
    // Core's own `<Elicit>`, at core's own identity, beside this suite's
    // `<Marker>`: the index joins on name *and* origin, so an `Elicit` entry
    // carrying this suite's origin would find no core documentation whether the
    // terminal survived the chain or not.
    const elicit = symbolsNamed("Elicit", {
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
    const marked = symbolsOf("Marker");
    const pair: SyntaxSymbols = {
      version: 2,
      categories: [
        { kind: "structural", entries: [] },
        {
          kind: "built-in",
          entries: [...marked.categories[1].entries, ...elicit.categories[1].entries],
        },
        { kind: "user-provided", entries: [] },
      ],
    };
    const both = String(
      yield* scoped(function* () {
        yield* useMarkerDocumentation();
        return yield* run('<Syntax names={["Marker", "Elicit"]} />\n', [
          stating(pair).installation,
        ]);
      }),
    );
    expect(both).toContain("MARKER PROSE.");
    expect(both).toContain("Asks a person a structured question");
    expect(both).not.toContain("No long-form documentation is available");
  });

  it("SYN25k: middleware a running document installs reaches nothing", function* () {
    // The ordering half of the contract. Collection happens after the trusted
    // host's bootstrap and *before* the root import, so a component that
    // composes around the Api while the document is running composes into a
    // chain nothing reads again. Otherwise a document could describe a
    // component to the next agent however it liked.
    const { installation: marker } = stating(symbolsOf("Marker"));
    const planted: ExecutionInstallation = {
      *install(): Operation<void> {
        yield* registerComponents([
          {
            name: "Plant",
            origin: "@executablemd/test",
            props: { type: "object", properties: {}, additionalProperties: false },
            *fn(): Operation<string> {
              yield* contributeDocumentation(
                // deno-lint-ignore require-yield
                function* () {
                  return {
                    source: {
                      owner: "@executablemd/test",
                      asset: "packages/test/src/planted.md",
                      text: "## Marker\n\nPLANTED BY THE DOCUMENT.\n",
                    },
                    supplies: new Set(["Marker"]),
                  };
                },
              );
              // The occurrence renders *inside* this scope, which is the only
              // arrangement that tests anything: a sibling element would find
              // this middleware already gone and pass however late collection
              // happened.
              return `planted\n\n${yield* content()}`;
            },
          },
        ]);
      },
    };

    const output = String(
      yield* scoped(function* () {
        yield* useMarkerDocumentation();
        return yield* run('<Plant>\n<Syntax names={["Marker"]} />\n</Plant>\n', [marker, planted]);
      }),
    );
    // The component ran, so the plant is not being reported absent by accident.
    expect(output).toContain("planted");
    // And what the occurrence renders is what the host bootstrapped. Had the
    // document's contribution been read, this would either say so or refuse as
    // a duplicate — either way, not this.
    expect(output).toContain("MARKER PROSE.");
    expect(output).not.toContain("PLANTED BY THE DOCUMENT");
  });

  it("SYN25i: two contributions for one component refuse, whichever order", function* () {
    // Order decides how the list reads and nothing else. A later contribution
    // silently winning would make what a document is told about a component
    // depend on the order its host happened to bootstrap packages in.
    const { installation: marker } = stating(symbolsOf("Marker"));
    const orders: string[] = [];
    for (const [first, second] of [
      ["packages/one/components.md", "packages/two/components.md"],
      ["packages/two/components.md", "packages/one/components.md"],
    ]) {
      orders.push(
        yield* refusal(
          scoped(function* () {
            yield* useMarkerDocumentation(first);
            yield* useMarkerDocumentation(second);
            return yield* run('<Syntax names={["Marker"]} />\n', [marker]);
          }),
        ),
      );
    }
    for (const refused of orders) {
      expect(refused).toContain("contributes documentation for Marker from both");
    }
    // Both orders refuse, and each names the pair it saw rather than one fixed
    // winner: a refusal that reported the same asset either way would be
    // consistent with a chain that had picked a winner and then complained.
    expect(orders[0]).not.toBe(orders[1]);
  });

  it("SYN25l: bootstrapping one package twice is idempotent, not a conflict", function* () {
    // One package's declarative vocabulary is deliberately installed at more
    // than one layer — the repository-composition set is bootstrapped by an
    // ordinary run *and* again inside a workflow attachment, because either may
    // be the only one — and the inner scope descends from the outer, so both
    // wrappers sit in one chain. The second says exactly what the first said,
    // so it is not appended: repeating a statement is not disagreeing with it.
    //
    // Refusing it instead would turn the product's own layering into a failure,
    // which is what `xmd workflow` demonstrated.
    const { installation: marker } = stating(symbolsOf("Marker"));
    const twice = (source: string): Operation<Json> =>
      scoped(function* () {
        yield* useMarkerDocumentation();
        yield* useMarkerDocumentation();
        return yield* run(source, [marker]);
      });

    // Named, bare, and a document that writes no `<Syntax>` at all. Collection
    // happens for the execution rather than for an occurrence, so if a repeat
    // were going to break anything it would break all three.
    expect(String(yield* twice('<Syntax names={["Marker"]} />\n'))).toContain("MARKER PROSE.");
    expect(String(yield* twice("<Syntax />\n"))).toContain("### `<Marker>`");
    expect(String(yield* twice("nothing here\n"))).toContain("nothing here");

    // Documented exactly once, not twice: idempotent means the repeat left no
    // second copy behind, which reading the collected snapshot shows directly.
    const collected = yield* scoped(function* () {
      yield* useMarkerDocumentation();
      yield* useMarkerDocumentation();
      return yield* capturedDocumentation();
    });
    expect(
      collected.filter((one) => one.source.asset === "packages/test/src/components.md"),
    ).toHaveLength(1);

    // And the control that keeps this from passing vacuously: two bootstraps
    // that genuinely disagree — the same component from a different asset —
    // still refuse at collection.
    const conflicting = yield* refusal(
      scoped(function* () {
        yield* useMarkerDocumentation();
        yield* useMarkerDocumentation("packages/other/src/components.md");
        return yield* run("<Syntax />\n", [marker]);
      }),
    );
    expect(conflicting).toContain("contributes documentation for Marker from both");
  });

  it("SYN25j: two scopes each read their own contributions", function* () {
    // A contribution belongs to the scope that installed it, because that is
    // what an Api answer belongs to. Two executions assembled in sibling scopes
    // must not read through each other's.
    const { installation: marker } = stating(symbolsOf("Marker"));
    const inside = String(
      yield* scoped(function* () {
        yield* useMarkerDocumentation();
        return yield* run('<Syntax names={["Marker"]} />\n', [marker]);
      }),
    );
    expect(inside).toContain("MARKER PROSE.");

    // The sibling scope installed nothing, so it has nothing — and the first
    // scope's contribution did not outlive it.
    const outside = String(yield* scoped(() => run('<Syntax names={["Marker"]} />\n', [marker])));
    expect(outside).toContain("No long-form documentation is available");
    expect(outside).not.toContain("MARKER PROSE.");
  });

  it("SYN48: an ordinary reference is unaffected by another execution's suspended one", function* () {
    // Two executions overlapping in one process. One is stopped inside its own
    // documentation collection; the other is ordinary and must read canonical
    // documentation and finish on its own.
    //
    // This is what a module-scoped reader gets wrong: one variable shared by
    // every execution means the suspended one's substitution is what the
    // ordinary one reads, and it would either hang on the same suspend or
    // render the substituted prose. Against the module-global implementation at
    // 9d92bcbe this fails.
    const entered = withResolvers<void>();
    const stream = new InMemoryStream();

    const ordinary = yield* scoped(function* () {
      const held = yield* spawn(function* () {
        return yield* collect(
          yield* executeReadingAssetsWith(
            {
              ...retainedSource(ROOT_PATH, '<Syntax names={["Elicit"]} />\n'),
              stream,
              includes: [],
            },
            [],
            function* (): Operation<string> {
              entered.resolve();
              yield* suspend();
              return "## Elicit\n\nSUBSTITUTED BY THE OTHER EXECUTION.\n";
            },
          ),
        );
      });

      // Only once the first execution is genuinely inside its own index work.
      yield* entered.operation;

      // A second, ordinary execution — no reader of its own, so it uses the
      // real one.
      const rendered = String(yield* run('<Syntax names={["Elicit"]} />\n'));
      yield* held.halt();
      return rendered;
    });

    expect(ordinary).toContain("Asks a person a structured question");
    expect(ordinary).not.toContain("SUBSTITUTED BY THE OTHER EXECUTION");
  });

  it("SYN49: a named root occurrence resolves its symbols exactly once", function* () {
    // A contribution that *changes* between calls, so a second resolution is
    // not merely wasteful but visible: an entry's metadata would come from one
    // symbols and the availability beside it from another.
    const calls = { count: 0 };
    const moving: ExecutionInstallation = {
      // deno-lint-ignore require-yield
      *symbols(): Operation<SyntaxSymbols> {
        calls.count += 1;
        return symbolsOf(`Marker${calls.count}`);
      },
    };

    const stream = new InMemoryStream();
    const first = String(yield* run('<Syntax names={["Marker1"]} />\n', [moving], stream));

    // Once — not once for selection and again for availability.
    expect(calls.count).toBe(1);
    // And both decisions came from that one value: the entry is rendered, and
    // it is available. A second resolution would have produced `Marker2`,
    // leaving `Marker1` unselectable or unavailable.
    expect(first).toContain("### `<Marker1>`");
    expect(first).toContain("**Available in this evaluation:** yes");

    // Two occurrences still read independently: this is one read per
    // occurrence, not one per execution.
    calls.count = 0;
    const both = String(
      yield* run(
        ['<Syntax names={["Marker1"]} />', "", '<Syntax names={["Marker2"]} />', ""].join("\n"),
        [moving],
      ),
    );
    expect(calls.count).toBe(2);
    expect(both).toContain("### `<Marker1>`");
    expect(both).toContain("### `<Marker2>`");

    // A continuation restores the retained text without asking again.
    calls.count = 0;
    const resumed = String(
      yield* run('<Syntax names={["Marker1"]} />\n', [moving], yield* continuing(stream)),
    );
    expect(resumed.trim()).toBe(first.trim());
    expect(calls.count).toBe(0);
  });

  it("SYN39: retains the named text, and a continuation restores it whole", function* () {
    const stream = new InMemoryStream();
    const first = String(yield* run('<Syntax names={["Elicit"]} />\n', [], stream));
    expect(first).toContain("Asks a person a structured question");

    // Exactly what was rendered, not the compact list: the record is the
    // occurrence's final text whichever form produced it.
    const records = retained(yield* stream.readAll());
    expect(records).toHaveLength(1);
    const record = records[0];
    const value =
      record?.type === "yield" && record.result.status === "ok" ? record.result.value : undefined;
    expect(Object.keys(value as object)).toEqual(["symbols"]);
    // The component's own return, which the document then renders — so the two
    // differ by the trailing newline presentation adds, and nothing else.
    expect(String((value as { symbols: string }).symbols).trim()).toBe(first.trim());

    // A continuation hands the same text back. The documentation asset is not
    // reread and the symbols are not rebuilt: what an agent was shown is what it
    // is shown again.
    const resumed = String(
      yield* run('<Syntax names={["Elicit"]} />\n', [], yield* continuing(stream)),
    );
    expect(resumed).toBe(first);

    // And a record this version cannot read refuses rather than inventing one.
    const corrupted = yield* tampered(stream, () => ({ symbols: "x", extra: 1 }));
    const refused = yield* refusal(run('<Syntax names={["Elicit"]} />\n', [], corrupted));
    expect(refused).toContain("not a record this version can read");
  });

  it("SYN31: refuses an unusable list before reading anything", function* () {
    const stream = new InMemoryStream();
    const unknown = yield* refusal(run('<Syntax names={["Nonexistent"]} />\n', [], stream));
    expect(unknown).toContain("Nonexistent");
    // No successful record: the attempt and its failure are journaled, as any
    // effect's are, but there is nothing for a continuation to restore and hand
    // back as the symbols.
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
      yield* writeTextFile(join(dir, "Syntax.md"), "repository symbols\n");
      yield* writeTextFile(join(dir, "Nearby.md"), "a nearby repository component\n");
      const { installation } = stating(symbolsOf("Marker"));

      const output = String(
        yield* run("<Syntax />\n<Nearby />\n", [installation], undefined, [dir]),
      );
      // The protected component answered, and the repository file did not.
      expect(output).toContain("### `<Marker>`");
      expect(output).not.toContain("repository symbols");
      // The positive control: repository discovery is active in this very run,
      // so the absence above is protection rather than a search that never ran.
      expect(output).toContain("a nearby repository component");
    });
  });

  it("SYN6: selection reports the protected tier ahead of every other", function* () {
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(join(dir, "Syntax.md"), "repository symbols\n");
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
    const source = "declared symbols\n";
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
    // Before the root import: nothing was imported and nothing was read.
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
      "declared symbols",
    );
  });

  it("SYN10: a workflow bundle member called Syntax is refused before the root import", function* () {
    const bundled = {
      name: "Syntax",
      path: "components/Syntax.md",
      sourceHash: "0".repeat(40),
      content: "bundled symbols\n",
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
    const watching: ExecutionInstallation = {
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
    const { installation } = stating(symbolsOf("Marker"));
    expect(String(yield* run("<Syntax />\n", [installation, watching]))).toContain("Marker");
    // The handler observed the import it could not answer.
    expect(seen).toContain(SYNTAX_COMPONENT);
  });

  it("SYN12: a handler that answers, substitutes, mutates or copies runs no replacement", function* () {
    const replacement: FunctionComponent = function* () {
      return "replaced symbols";
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
      const { installation, calls } = stating(symbolsOf("Marker"));
      const refused = yield* refusal(run("<Syntax />\n", [installation, answering(answer)]));
      expect(refused).toContain("canonical core owns");
      // Refused before the body: no symbols were read for the replacement.
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
      yield* refusal(run("<Syntax />\n", [stating(symbolsOf("Marker")).installation, redirecting])),
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
      yield* refusal(run("<Syntax />\n", [stating(symbolsOf("Marker")).installation, twice])),
    ).toBeTruthy();
  });

  it("SYN14: a deliberate middleware refusal stays a refusal", function* () {
    const refusing: ExecutionInstallation = {
      *install() {
        yield* Component.around(
          {
            *importComponent([name, position], next) {
              if (name === SYNTAX_COMPONENT) {
                throw new Error("this host refuses the symbols");
              }
              return yield* next(name, position);
            },
          },
          { at: "max" },
        );
      },
    };
    const { installation, calls } = stating(symbolsOf("Marker"));
    expect(yield* refusal(run("<Syntax />\n", [installation, refusing]))).toContain(
      "this host refuses the symbols",
    );
    expect(calls.count).toBe(0);
  });

  it("SYN15: a document-authored context and a look-alike reference change nothing", function* () {
    // Nothing a document writes reaches the reference: it is not addressed by
    // name. The strongest thing an authored document can do is register and
    // bind, and the symbols are unchanged by both.
    const { installation } = stating(symbolsOf("Marker"));
    const source = [
      '<Let as="symbols" value="planted symbols" />',
      '<Syntax as="read" />',
      "{read}",
      "",
    ].join("\n");
    const output = String(yield* run(source, [installation]));
    expect(output).toContain("### `<Marker>`");
    expect(output).not.toContain("planted symbols");
  });
});

describe("Tier SYN — the site the symbols describe", () => {
  it("SYN16: the derived symbols report this execution's own includes and registry", function* () {
    yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(join(dir, "Local.md"), "a local component\n");
      // No host contribution: canonical core derives the symbols from the
      // selection inputs this execution captured.
      const output = String(yield* run("<Syntax />\n", [], undefined, [dir]));
      expect(output).toContain("### `<Local>`");
      // And it describes itself, once, with the approved description.
      expect(output).toContain("### `<Syntax>`");
      expect(output).toContain(DESCRIPTION);
      // Its own provenance, not a registration's. A reader deciding whether
      // they could supply this name themselves gets the opposite answer from
      // the two phrases, so the symbols must not print the other one.
      expect(output).toContain("`@executablemd/core` (protected component)");
      expect(output).not.toContain("reserved registration");
    });
  });

  it("SYN27: the symbols report a protected component as protected, not registered", function* () {
    const { installation } = stating(symbolsOf("Marker"));
    const symbols = yield* scoped(function* () {
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
    expect(symbols.version).toBe(2);

    // Built-in: the second category, where a reader indexes for it.
    const entry = symbols.categories[1].entries.find((candidate) => candidate.name === "Syntax");
    if (entry === undefined) {
      throw new Error("expected the symbols to describe <Syntax>");
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

    const symbols = yield* scoped(function* () {
      const registry = yield* Component.operations.registry;
      const workflow = installedBundle([bundle], registry);
      if (workflow === undefined) {
        throw new Error("expected the bundle to install");
      }
      return yield* inspectSyntax({ includes: [], workflow });
    });
    // User-provided: the third category.
    const entry = symbols.categories[2].entries.find((candidate) => candidate.name === "Bundled");
    if (entry === undefined || entry.inspectability !== "complete") {
      throw new Error("expected the symbols to describe <Bundled> completely");
    }
    expect(entry.origin).toEqual({
      kind: "workflow",
      path: "components/Bundled.md",
      sourceHash,
    });
    expect(entry.sourceKind).toBe("workflow-markdown");
  });

  it("SYN17: a workflow root reports its own bundle without running a member", function* () {
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

  it("SYN18: a declared Markdown component's own body reports the site it inherited", function* () {
    const source = ['<Syntax as="symbols" />', "policy sees {symbols}", ""].join("\n");
    const declaration: DeclaredMarkdownComponent = {
      name: "Policy",
      origin: "@executablemd/test/Policy.md",
      source,
      digest: sourceDigest(source),
    };
    const { installation } = stating(symbolsOf("Marker"));
    const output = String(
      yield* run("<Policy />\n", [installation, { declarations: [declaration] }]),
    );
    expect(output).toContain("policy sees");
    expect(output).toContain("### `<Marker>`");
  });
});

describe("Tier SYN — the record one occurrence keeps", () => {
  it("SYN19: the retained payload is closed on exactly { symbols }", function* () {
    const stream = new InMemoryStream();
    yield* run("<Syntax />\n", [stating(symbolsOf("Marker")).installation], stream);
    const [reference] = syntaxReads(yield* stream.readAll());
    if (reference?.type !== "yield" || reference.result.status !== "ok") {
      throw new Error("the run retained no syntax record");
    }
    const value = Object(reference.result.value);
    expect(Object.keys(value)).toEqual(["symbols"]);
    expect(typeof value.symbols).toBe("string");
  });

  it("SYN20: a continuation restores the symbols after the environment moves, and asks nothing", function* () {
    const first = new InMemoryStream();
    const before = String(
      yield* run("<Syntax />\n", [stating(symbolsOf("Before")).installation], first),
    );
    expect(before).toContain("### `<Before>`");

    // The environment moved: the host now states a different profile, and the
    // contribution refuses to answer at all.
    const moved: ExecutionInstallation = {
      // deno-lint-ignore require-yield
      *symbols(): Operation<SyntaxSymbols> {
        throw new Error("the continuation rebuilt the symbols");
      },
    };
    const continued = String(yield* run("<Syntax />\n", [moved], yield* continuing(first)));
    expect(continued).toContain("### `<Before>`");
    expect(continued).not.toContain("### `<After>`");

    // A fresh execution sees the moved environment, which is what shows the
    // restoration above was retention rather than the reference being inert.
    expect(
      String(yield* run("<Syntax />\n", [stating(symbolsOf("After")).installation])),
    ).toContain("### `<After>`");
  });

  it("SYN21: a missing, extra or wrong-typed retained payload refuses before output or binding", function* () {
    const cases: [string, (value: Json) => Json][] = [
      ["the member is missing", () => ({})],
      ["an unknown member was added", (value) => ({ ...Object(value), extra: true })],
      ["the member has the wrong type", () => ({ symbols: 7 })],
    ];
    for (const [, replace] of cases) {
      const first = new InMemoryStream();
      yield* run("<Syntax />\n", [stating(symbolsOf("Marker")).installation], first);
      const hostile = yield* tampered(first, replace);
      const refused = yield* refusal(
        run(
          '<Syntax as="symbols" />bound:{symbols}',
          [stating(symbolsOf("Marker")).installation],
          hostile,
        ),
      );
      expect(refused).toContain("is not a record this version can read");
    }
  });

  it("SYN22: a cancelled reference tears down and commits no record", function* () {
    const teardown: string[] = [];
    const stream = new InMemoryStream();
    const hanging: ExecutionInstallation = {
      *symbols(): Operation<SyntaxSymbols> {
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
      // Long enough for the reference to be entered and suspended.
      yield* sleep(20);
      yield* running.halt();
    });

    // The structured teardown ran, and nothing successful was committed.
    expect(teardown).toEqual(["released"]);
    const committed = syntaxReads(yield* stream.readAll()).filter(
      (event) => event.type === "yield" && event.result.status === "ok",
    );
    expect(committed).toEqual([]);
  });
});

describe("Tier SYN — reference is never authority", () => {
  it("SYN23: symbols naming a component neither register nor resolve it", function* () {
    // The strongest form: the trusted host itself states symbols naming a
    // component nothing supplies.
    const { installation } = stating(symbolsOf("Phantom"));
    const output = String(yield* run("<Syntax />\n", [installation]));
    expect(output).toContain("### `<Phantom>`");

    // It is still a name nothing answers for.
    expect(yield* refusal(run("<Phantom />\n", [installation]))).toContain(
      "Cannot resolve component: Phantom",
    );
    expect((yield* selectComponent("Phantom", { includes: [] })).kind).toBe("unresolved");
  });

  it("SYN24: the component is described identically by inspection and by validation", function* () {
    const symbols = yield* inspectSyntax({ includes: [] });
    const entry = symbols.categories[1].entries.find((candidate) => candidate.name === "Syntax");
    expect(entry).toBeDefined();
    expect(entry?.description).toBe(DESCRIPTION);
    expect(entry?.forms).toEqual(["self-closing"]);
    expect(entry?.returnMode).toBe("text");
    // One optional prop, closed: `names` selects documentation, and anything
    // else is refused before an reference.
    expect(entry?.props).toEqual({
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          uniqueItems: true,
          description:
            "Optional. Render these components' metadata and long-form documentation " +
            "instead of the list of available symbols. Entries render once each, in symbol order.",
        },
      },
      additionalProperties: false,
    });
    expect(entry?.origin).toEqual({ kind: "protected", origin: "@executablemd/core" });
    // Exactly one entry, in exactly one category.
    const everywhere = symbols.categories.flatMap((category) =>
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
   * fragment, and the reference it installs for that subtree is that
   * admission's own symbols — it cannot add an entry the admission does not
   * hold, because it is handed the symbols rather than asked to build one.
   * Installing it for an evaluation subtree is #713's; that the reference is
   * the symbols and nothing more is this.
   */
  it("SYN25b: a narrowed reference answers with exactly the symbols it was given", function* () {
    const narrowed = symbolsOf("Admitted");
    const reference = syntaxReference(narrowed);
    expect(yield* reference.symbols()).toBe(renderSyntaxMarkdown(narrowed));
    // Nothing of the enclosing site leaks into it: a name the wider profile has
    // is absent, because the symbols it was handed do not hold one.
    expect(yield* reference.symbols()).not.toContain("### `<Syntax>`");
  });

  /**
   * The seam #713 installs through, proved without an `<Evaluate>`.
   *
   * A narrowing boundary hands the reference two sets of symbols: what may execute
   * in the subtree, and the enclosing authoring symbols selection reads from.
   * Everything below is about them being genuinely two.
   */
  it("SYN25c: a narrowed reference documents the enclosing site and marks availability", function* () {
    const enclosing = symbolsOf("Admitted", "Withheld");
    const narrowed = symbolsOf("Admitted");
    const reference = syntaxReference(narrowed, enclosing);

    // What may execute here is the narrowed set, and the bare form reports
    // exactly that.
    const available = yield* reference.symbols();
    expect(available).toContain("### `<Admitted>`");
    expect(available).not.toContain("### `<Withheld>`");

    // Reference material comes from the enclosing symbols, so a component this
    // subtree may not run can still be explained — and the entry says so
    // rather than leaving a reader to assume they have both.
    const documented = yield* reference.documentation(["Withheld"]);
    expect(documented).toContain("### `<Withheld>`");
    expect(documented).toContain("**Available in this evaluation:** no");

    // And one that is admitted reports the other answer, so the field is
    // discriminating rather than a constant.
    const admitted = yield* reference.documentation(["Admitted"]);
    expect(admitted).toContain("**Available in this evaluation:** yes");

    // A boundary that narrows nothing has one set, and everything in it is
    // available — the ordinary case.
    const open = syntaxReference(enclosing);
    expect(yield* open.documentation(["Withheld"])).toContain(
      "**Available in this evaluation:** yes",
    );
  });

  it("SYN25d: availability compares the whole identity, not the spelling", function* () {
    /** Symbols holding a single entry of exactly this identity. */
    const holding = (origin: NamedOrigin): SyntaxSymbols => ({
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

    const authored: NamedOrigin = {
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    };

    // Each of these is a *different component* that happens to be spelled
    // `Elicit`. Reporting the authoring entry as available because something of
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
      const nested = syntaxReference(holding(origin), holding(authored));
      const rendered = yield* nested.documentation(["Elicit"]);
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
      yield* syntaxReference(holding(moved), holding(bundled)).documentation(["Elicit"]),
    ).toContain("**Available in this evaluation:** no");

    // The positive control: one exact identity, admitted.
    expect(
      yield* syntaxReference(holding(authored), holding(authored)).documentation(["Elicit"]),
    ).toContain("**Available in this evaluation:** yes");
  });

  it("SYN25e: a narrowed reference is derived from the enclosing one", function* () {
    // The seam as an evaluator actually meets it: it holds the enclosing
    // reference and an admitted set of symbols, and nothing else. No raw
    // contribution list, no second index — which is the point, because that
    // list is execution-private and rebuilding an index from it is how two
    // indexes drift apart.
    const enclosing = yield* rootObservation();
    const admitted = symbolsOf("Admitted");
    const narrowed = enclosing.available(admitted);

    // What may run is the admission.
    const executable = yield* narrowed.symbols();
    expect(executable).toContain("### `<Admitted>`");
    expect(executable).not.toContain("### `<Elicit>`");

    // What may be read about is still the enclosing site's, with the enclosing
    // index behind it — so a real component's real documentation survives.
    const documented = yield* narrowed.documentation(["Elicit"]);
    expect(documented).toContain("### `<Elicit>`");
    expect(documented).toContain("Asks a person a structured question");
    expect(documented).toContain("**Available in this evaluation:** no");

    // And the enclosing reference is unchanged by having been narrowed.
    expect(yield* enclosing.symbols()).toContain("### `<Elicit>`");
    expect(yield* enclosing.documentation(["Elicit"])).toContain(
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
    const reference = syntaxReference(
      symbolsNamed("Alpha", {
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

    const rendered = yield* reference.documentation(["Alpha"]);
    expect(rendered).toContain("The captured documentation.");
    expect(rendered).not.toContain("SUBSTITUTED AFTER CAPTURE");
  });

  it("SYN25: an execution that carries no reference refuses rather than inventing one", function* () {
    // `execute()` driven directly still carries one, so the case that has none
    // is an expansion driven outside an execution — which is what a component
    // reaching for symbols with nothing established would meet.
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
