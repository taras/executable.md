/**
 * Tier DC — the one declaration catalog a trusted host installs (spec §5.3).
 *
 * An `ExecutionInstallation` is the atomic owner of the structural syntax it
 * contributes and of the implementation that expands it. These rows are about
 * that ownership: what one installation may declare, what two installations may
 * declare beside each other, and which catalogs are refused before any
 * installation hook, middleware or document code runs.
 *
 * Refusal timing is asserted rather than assumed. Every installation here
 * counts its own `install()` and its own `expand()`, and a row that claims a
 * catalog was refused "before anything ran" reads those counters back.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";

import { collect } from "../src/collect.ts";
import { executeInstalled, sourceDigest } from "../host.ts";
import type { ExecutionInstallation } from "../host.ts";
import { admitStructuralDeclarations } from "../src/execution-declarations.ts";
import type {
  ExecutionDeclaration,
  MarkdownDeclaration,
  StructuralDeclaration,
} from "../src/execution-declarations.ts";
import { inspectComponent, inspectSyntax } from "../src/inspect.ts";
import { retainedSource } from "../src/root-source.ts";
import type { IdentityClaimant, IdentityComponent } from "../src/invocation-identity.ts";

const ORIGIN = "@test/panels";
const ROOT = "root.md";

/** A controlled structural parent: it holds slots and arranges nothing else. */
function panel(overrides: Partial<StructuralDeclaration> = {}): StructuralDeclaration {
  return {
    kind: "structural",
    name: "Panel",
    origin: ORIGIN,
    forms: ["paired"],
    props: {
      type: "object",
      properties: { columns: { type: "number", multipleOf: 1, minimum: 1 } },
      required: ["columns"],
      additionalProperties: false,
    },
    syntax: ["<Panel columns={2}>…</Panel>"],
    description: "Arrange slots.",
    context: "The `<Slot>` children the panel arranges.",
    placement: { kind: "parent", minimumChildren: 1, nested: "forbidden" },
    ...overrides,
  };
}

/** Its one child form. */
function slot(overrides: Partial<StructuralDeclaration> = {}): StructuralDeclaration {
  return {
    kind: "structural",
    name: "Slot",
    origin: ORIGIN,
    forms: ["self-closing", "paired"],
    props: {
      type: "object",
      properties: { title: { type: "string", minLength: 1 } },
      required: ["title"],
      additionalProperties: false,
    },
    syntax: ['<Slot title="One" />'],
    description: "One slot.",
    context: "Markdown the slot renders.",
    placement: { kind: "child", parent: "Panel" },
    ...overrides,
  };
}

/** One private component a declaration keeps to itself. */
function hidden(name = "Hidden"): IdentityComponent {
  return {
    name,
    origin: `${ORIGIN}#${name}`,
    props: { type: "object" },
    returns: { type: "string" },
    forms: ["self-closing"],
    // deno-lint-ignore require-yield
    factory: (_claim: IdentityClaimant) =>
      function* Hidden(): Operation<string> {
        return "hidden";
      },
  };
}

const MARKDOWN_SOURCE = "A declared policy.\n";

function markdownDeclaration(overrides: Partial<MarkdownDeclaration> = {}): MarkdownDeclaration {
  return {
    kind: "markdown",
    name: "Policy",
    origin: ORIGIN,
    source: MARKDOWN_SOURCE,
    digest: sourceDigest(MARKDOWN_SOURCE),
    ...overrides,
  };
}

/** What one installation was actually asked to do. */
interface Counters {
  installs: number;
  expansions: number;
  /** Every occurrence the implementation was handed, by name. */
  expanded: string[];
}

function installed(
  declarations: readonly ExecutionDeclaration[],
  options: { readonly expand?: boolean } = {},
): { installation: ExecutionInstallation; counters: Counters } {
  const counters: Counters = { installs: 0, expansions: 0, expanded: [] };
  const supplies =
    options.expand ?? declarations.some((declaration) => declaration.kind === "structural");
  const installation: ExecutionInstallation = {
    declarations,
    // deno-lint-ignore require-yield
    *install(): Operation<void> {
      counters.installs++;
    },
    ...(supplies
      ? {
          // deno-lint-ignore require-yield
          *expand(request): Operation<void> {
            counters.expansions++;
            counters.expanded.push(request.name);
          },
        }
      : {}),
  };
  return { installation, counters };
}

function run(source: string, installations: readonly ExecutionInstallation[]): Operation<Json> {
  return scoped(function* () {
    return yield* collect(
      yield* executeInstalled(
        {
          ...retainedSource(ROOT, source),
          stream: new InMemoryStream(),
          includes: [],
        },
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

const PANEL_DOC = '<Panel columns={2}><Slot title="One" /></Panel>\n';

describe("Tier DC — one installation owns a form and its implementation", () => {
  it("DC1: a paired parent and its child install together and expand through their owner", function* () {
    const { installation, counters } = installed([panel(), slot()]);

    yield* run(PANEL_DOC, [installation]);

    expect(counters.installs).toBe(1);
    expect(counters.expanded).toEqual(["Panel"]);
  });

  it("DC1: selection reports the installed forms with their origin and placement", function* () {
    const declarations = [panel(), slot()];

    const parent = yield* inspectComponent({ name: "Panel", declarations });
    const child = yield* inspectComponent({ name: "Slot", declarations });

    if (parent.kind !== "declared-structural" || child.kind !== "declared-structural") {
      throw new Error("expected both names to select as installed structural syntax");
    }
    expect(parent.origin).toEqual({ kind: "declared-structural", origin: ORIGIN });
    expect(child.origin).toEqual({ kind: "declared-structural", origin: ORIGIN });
    expect(parent.placement).toEqual({
      kind: "parent",
      minimumChildren: 1,
      nested: "forbidden",
    });
    expect(child.placement).toEqual({ kind: "child", parent: "Panel" });
    expect(parent.forms).toEqual(["paired"]);
    expect(child.forms).toEqual(["self-closing", "paired"]);
  });

  it("DC1: a parent and child split across two installations refuse before either runs", function* () {
    const first = installed([panel()]);
    const second = installed([slot()]);

    const refused = yield* refusal(run(PANEL_DOC, [first.installation, second.installation]));

    expect(refused).toContain("declares no child form");
    expect(first.counters.installs).toBe(0);
    expect(second.counters.installs).toBe(0);
    expect(first.counters.expansions).toBe(0);
  });

  it("DC1: an orphan child naming a parent nobody declares refuses before anything runs", function* () {
    const { installation, counters } = installed([slot()]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain('names the parent "Panel"');
    expect(counters.installs).toBe(0);
  });

  it("DC1: structural declarations without expand() refuse before anything runs", function* () {
    const { installation, counters } = installed([panel(), slot()], { expand: false });

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain("supplies no structural expand()");
    expect(counters.installs).toBe(0);
  });

  it("DC1: expand() without a structural declaration refuses before anything runs", function* () {
    const { installation, counters } = installed([markdownDeclaration()], { expand: true });

    const refused = yield* refusal(run("<Policy />\n", [installation]));

    expect(refused).toContain("without declaring a structural form");
    expect(counters.installs).toBe(0);
  });

  it("DC1: a parent that declares no child form at all refuses", function* () {
    const { installation } = installed([panel()]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain("declares no child form");
  });
});

describe("Tier DC — two installations, and the names they may not share", () => {
  it("DC2: disjoint installations coexist, and each occurrence reaches its own owner", function* () {
    const panels = installed([panel(), slot()]);
    const boards = installed([
      panel({ name: "Board", syntax: ["<Board columns={1}>…</Board>"] }),
      slot({ name: "Cell", placement: { kind: "child", parent: "Board" } }),
    ]);

    yield* run(
      [
        '<Panel columns={2}><Slot title="One" /></Panel>',
        '<Board columns={1}><Cell title="Two" /></Board>',
        "",
      ].join("\n"),
      [panels.installation, boards.installation],
    );

    expect(panels.counters.expanded).toEqual(["Panel"]);
    expect(boards.counters.expanded).toEqual(["Board"]);
  });

  it("DC2: a duplicate structural name refuses atomically, installing neither catalog", function* () {
    const first = installed([panel(), slot()]);
    const second = installed([
      panel(),
      slot({ name: "Cell", placement: { kind: "child", parent: "Panel" } }),
    ]);

    const refused = yield* refusal(run(PANEL_DOC, [first.installation, second.installation]));

    expect(refused).toContain("was declared twice");
    expect(first.counters.installs).toBe(0);
    expect(second.counters.installs).toBe(0);
  });

  it("DC2: a name declared in both arms refuses before install()", function* () {
    const { installation, counters } = installed([
      panel({ name: "Policy" }),
      slot({ placement: { kind: "child", parent: "Policy" } }),
      markdownDeclaration(),
    ]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain("declared Markdown component");
    // Intrinsic: two arms of one catalog claiming a name is wrong however the
    // execution is assembled, so it is decided before anything is installed
    // rather than at the prepared-execution boundary with the registration and
    // bundle conflicts.
    expect(counters.installs).toBe(0);
  });

  it("DC2: a structural name that a private closure also claims refuses before install()", function* () {
    const { installation, counters } = installed([
      panel({ name: "Hidden" }),
      slot({ placement: { kind: "child", parent: "Hidden" } }),
      markdownDeclaration({ privates: [hidden()] }),
    ]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain("private declaration");
    expect(counters.installs).toBe(0);
  });

  it("DC2: a declaration of an unknown kind refuses before install() and the root import", function* () {
    const unknown: ExecutionDeclaration = panel();
    // A host crosses this boundary from JavaScript, so the discriminant is a
    // value core reads rather than a type it can rely on.
    Reflect.set(unknown, "kind", "widget");
    const { installation, counters } = installed([unknown, slot()], { expand: true });

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain('neither "markdown" nor "structural"');
    expect(counters.installs).toBe(0);
    // And no root was imported: the refusal precedes the document entirely.
    expect(counters.expansions).toBe(0);
  });

  it("DC2: a structural name that is a protected component refuses", function* () {
    const { installation, counters } = installed([
      panel({ name: "Syntax" }),
      slot({ placement: { kind: "child", parent: "Syntax" } }),
    ]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain("canonical core owns that name");
    expect(counters.installs).toBe(0);
  });

  it("DC2: a structural name that is a protected engine construct refuses", function* () {
    const { installation, counters } = installed([
      panel({ name: "If" }),
      slot({ placement: { kind: "child", parent: "If" } }),
    ]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain("protected engine syntax");
    expect(counters.installs).toBe(0);
  });
});

describe("Tier DC — a malformed declaration is refused where it is made", () => {
  it("DC1: a non-negative safe integer is what minimumChildren has to be", function* () {
    for (const minimum of [-1, 1.5, Number.NaN]) {
      const { installation } = installed([
        panel({ placement: { kind: "parent", minimumChildren: minimum, nested: "allowed" } }),
        slot(),
      ]);
      const refused = yield* refusal(run(PANEL_DOC, [installation]));
      expect(`${minimum}: ${refused}`).toContain("non-negative");
    }
  });

  it("DC1: a diagnostic template core has no substitution for refuses", function* () {
    const { installation } = installed([
      panel({ diagnostics: { minimumChildren: "needs {count} children" } }),
      slot(),
    ]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain('carries "{count}"');
  });

  it("DC1: an unexpectedChild template without exactly one {found} refuses", function* () {
    const { installation } = installed([
      panel({ diagnostics: { unexpectedChild: "not a slot" } }),
      slot(),
    ]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain("placeholders rather than exactly one");
  });

  it("DC1: a template may quote the syntax it is about", function* () {
    // `columns={2}` is what an author writes, not a substitution, so a
    // declaration that shows it is admitted rather than refused.
    const { installation, counters } = installed([
      panel({
        diagnostics: {
          selfClosingParent: "<Panel> is written paired: <Panel columns={2}>…</Panel>.",
        },
      }),
      slot(),
    ]);

    yield* run(PANEL_DOC, [installation]);

    expect(counters.expanded).toEqual(["Panel"]);
  });

  it("DC1: a structural declaration with no syntax or no description refuses", function* () {
    const empty = installed([panel({ syntax: [] }), slot()]);
    expect(yield* refusal(run(PANEL_DOC, [empty.installation]))).toContain("states no syntax");

    const silent = installed([panel({ description: "" }), slot()]);
    expect(yield* refusal(run(PANEL_DOC, [silent.installation]))).toContain(
      "states no description",
    );
  });

  it("DC1: an invalid props schema refuses where the declaration is made", function* () {
    const { installation, counters } = installed([panel({ props: { type: "string" } }), slot()]);

    const refused = yield* refusal(run(PANEL_DOC, [installation]));

    expect(refused).toContain('root props schema must declare type: "object"');
    expect(counters.installs).toBe(0);
  });
});

describe("Tier DC — the capture is by value", () => {
  it("DC1: a mutation during install() changes neither execution nor the catalog", function* () {
    // The caller keeps its own objects. Everything below is done to *those*,
    // from inside the installation's own hook — the one moment a host is
    // running while the execution already exists.
    const parent = panel();
    const child = slot();
    const seen: string[] = [];
    const installation: ExecutionInstallation = {
      declarations: [parent, child],
      // deno-lint-ignore require-yield
      *install(): Operation<void> {
        Reflect.set(parent, "name", "Renamed");
        Reflect.set(parent, "origin", "@attacker/elsewhere");
        Reflect.set(parent, "syntax", ["<Renamed />"]);
        Reflect.set(parent.props, "additionalProperties", true);
        Reflect.set(parent.placement, "minimumChildren", 99);
        Reflect.set(child, "name", "Slotted");
      },
      // deno-lint-ignore require-yield
      *expand(request): Operation<void> {
        seen.push(`${request.name}@${request.origin}`);
      },
    };

    // The document still writes what was declared, and the occurrence still
    // reaches the owner under the captured name and origin.
    yield* run(PANEL_DOC, [installation]);

    expect(seen).toEqual([`Panel@${ORIGIN}`]);
  });

  it("DC1: the captured declaration is frozen, and the caller's object is not it", function* () {
    const parent = panel();
    const admitted = yield* admitStructuralDeclarations([
      { owner: 0, declarations: [parent, slot()], expands: true },
    ]);

    const captured = admitted[0]?.declaration;
    if (captured === undefined) {
      throw new Error("nothing was admitted");
    }
    expect(captured).not.toBe(parent);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.props)).toBe(true);
    expect(Object.isFrozen(captured.placement)).toBe(true);
    expect(Object.isFrozen(captured.syntax)).toBe(true);

    // And writing through the caller's object reaches none of it.
    Reflect.set(parent.props, "additionalProperties", true);
    expect(captured.props["additionalProperties"]).toBe(false);
  });

  it("DC1: `<Syntax>` describes the captured contract, not a mutated one", function* () {
    const parent = panel();
    const child = slot();
    const installation: ExecutionInstallation = {
      declarations: [parent, child],
      // deno-lint-ignore require-yield
      *install(): Operation<void> {
        Reflect.set(parent, "description", "replaced after capture");
        Reflect.set(parent, "syntax", ["<Replaced />"]);
      },
      // deno-lint-ignore require-yield
      *expand(): Operation<void> {},
    };

    const rendered = String(yield* run("<Syntax />\n", [installation]));

    expect(rendered).toContain("Arrange slots.");
    expect(rendered).not.toContain("replaced after capture");
    expect(rendered).not.toContain("<Replaced />");
  });
});

describe("Tier DC — the order the catalog is listed in", () => {
  it("DC1: engine constructs come first, then installed forms in capture order", function* () {
    // Three declarations whose capture order is distinct from both of the
    // orders a listing might fall back to. Written as `Mid, Zeta, Alpha`:
    // sorting by name gives `Alpha, Mid, Zeta`, and grouping parents ahead of
    // their children gives `Zeta, Mid, Alpha`. Only the captured order is
    // `Mid, Zeta, Alpha`, so each wrong answer is a different list.
    const zeta = panel({ name: "Zeta", syntax: ["<Zeta columns={1}>…</Zeta>"] });
    const mid = slot({ name: "Mid", placement: { kind: "child", parent: "Zeta" } });
    const alpha = slot({ name: "Alpha", placement: { kind: "child", parent: "Zeta" } });

    const symbols = yield* inspectSyntax({
      includes: [],
      declarations: [mid, zeta, alpha],
    });
    const entries = symbols.categories[0].entries;
    const installedNames = entries
      .filter((entry) => entry.kind === "declared-structural")
      .map((entry) => entry.name);
    const engineNames = entries
      .filter((entry) => entry.kind === "structural")
      .map((entry) => entry.name);

    // Capture order: not alphabetical, and not parents-before-children.
    expect(installedNames).toEqual(["Mid", "Zeta", "Alpha"]);
    // And every engine construct precedes every installed one.
    const firstInstalled = entries.findIndex((entry) => entry.kind === "declared-structural");
    const lastEngine = entries.map((entry) => entry.kind).lastIndexOf("structural");
    expect(engineNames.length).toBeGreaterThan(0);
    expect(lastEngine).toBeLessThan(firstInstalled);
    // A global name sort over the whole category would have put `Alpha` ahead
    // of `Each`, `If` and `Let`; it does not.
    expect(entries[0]?.name).not.toBe("Alpha");
  });
});

describe("Tier DC — inspection reads the catalog and never runs it", () => {
  it("DC1: inspectSyntax lists the installed forms without invoking a hook", function* () {
    const { installation, counters } = installed([panel(), slot()]);

    const symbols = yield* inspectSyntax({
      includes: [],
      declarations: [...(installation.declarations ?? [])],
    });

    const structural = symbols.categories[0].entries.map((entry) => entry.name);
    expect(structural).toContain("Panel");
    expect(structural).toContain("Slot");
    expect(symbols.version).toBe(3);
    expect(counters.installs).toBe(0);
    expect(counters.expansions).toBe(0);
  });

  it("DC1: without the installation, the names select as nothing at all", function* () {
    const absent = yield* inspectComponent({ name: "Panel", includes: [] });

    expect(absent.kind).toBe("unresolved");
  });
});
