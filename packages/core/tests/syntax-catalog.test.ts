/**
 * Tier SY — the syntax catalog.
 *
 * What a document may write in a directory, answered without running any of it.
 * The filesystem is stubbed at the contextual `API.Fs` boundary rather than
 * with `useStubFs`, because these rows are about the three operations that
 * disagree — `lstat` on the include root, `glob` over its logical entries, and
 * `stat` through a symbolic link — and the shared stub answers only two of
 * them.
 *
 * Selection is deliberately not re-proved here. Every name enumerated goes back
 * through `selectComponent()`, so what these rows check is that enumeration
 * offers the right names and that the entry built from a decision says what the
 * decision was.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { API } from "@executablemd/runtime";
import type { LinkStatResult, StatResult } from "@executablemd/runtime";
import {
  AGENT_REGISTRATIONS,
  agentIdentityComponents,
  CORE_COMPONENT_NAMES,
  inspectSyntax,
  registerComponents,
  RESERVED_STRUCTURAL,
  STRUCTURAL_DECLARATIONS,
} from "../mod.ts";
import type {
  CompleteComponentSyntaxEntry,
  OriginOnlyComponentSyntaxEntry,
  StructuralSyntaxEntry,
  SyntaxCatalog,
} from "../mod.ts";
import type { IdentityComponent } from "../host.ts";

/**
 * One entry in a stubbed tree.
 *
 * A link carries what it leads to rather than where, because that is all the
 * enumeration is allowed to learn: `stat` follows it and reports a kind, and no
 * resolved host path is ever exposed.
 */
type Node =
  | { kind: "file"; content: string }
  | { kind: "directory" }
  | { kind: "link"; to: "file" | "directory" | "nothing"; content?: string };

type Tree = Record<string, Node>;

const MISSING: StatResult = { exists: false, isFile: false, isDirectory: false };

function stat(tree: Tree, path: string): StatResult {
  const node = tree[path];
  if (node === undefined) {
    return MISSING;
  }
  if (node.kind === "link") {
    if (node.to === "nothing") {
      return MISSING;
    }
    return { exists: true, isFile: node.to === "file", isDirectory: node.to === "directory" };
  }
  return { exists: true, isFile: node.kind === "file", isDirectory: node.kind === "directory" };
}

function lstat(tree: Tree, path: string): LinkStatResult {
  const node = tree[path];
  if (node === undefined) {
    return { ...MISSING, isSymbolicLink: false };
  }
  return {
    exists: true,
    isFile: node.kind === "file",
    isDirectory: node.kind === "directory",
    isSymbolicLink: node.kind === "link",
  };
}

function read(tree: Tree, path: string): string {
  const node = tree[path];
  const content = node?.kind === "file" || node?.kind === "link" ? node.content : undefined;
  if (content === undefined) {
    throw new Error(`ENOENT: no such file: ${path}`);
  }
  return content;
}

/**
 * The entries beneath one root, the way `glob` reports them: files and symbolic
 * links by their own relative path, directories never, and nothing beneath a
 * link — a linked directory holds no entries in this tree, which is exactly
 * what not following one produces.
 */
function walk(tree: Tree, root: string): Array<{ path: string; isFile: boolean }> {
  const prefix = root === "." ? "" : `${root}/`;
  const found: Array<{ path: string; isFile: boolean }> = [];
  for (const [path, node] of Object.entries(tree)) {
    if (!path.startsWith(prefix) || path === root || node.kind === "directory") {
      continue;
    }
    found.push({ path: path.slice(prefix.length), isFile: node.kind === "file" });
  }
  return found;
}

function* useTree(tree: Tree): Operation<void> {
  yield* API.Fs.around({
    // deno-lint-ignore require-yield
    *readTextFile([path]) {
      return read(tree, path);
    },
    // deno-lint-ignore require-yield
    *stat([path]) {
      return stat(tree, path);
    },
    // deno-lint-ignore require-yield
    *lstat([path]) {
      return lstat(tree, path);
    },
    // deno-lint-ignore require-yield
    *glob([options]) {
      return walk(tree, options.root);
    },
  });
}

function markdown(body: string): Node {
  return { kind: "file", content: body };
}

function catalogFor(tree: Tree, includes: readonly string[]): Operation<SyntaxCatalog> {
  return scoped(function* () {
    yield* useTree(tree);
    return yield* inspectSyntax({ includes });
  });
}

function structural(catalog: SyntaxCatalog): readonly StructuralSyntaxEntry[] {
  return catalog.categories[0].entries;
}

function builtIn(catalog: SyntaxCatalog): readonly CompleteComponentSyntaxEntry[] {
  return catalog.categories[1].entries;
}

function userProvided(
  catalog: SyntaxCatalog,
): readonly (CompleteComponentSyntaxEntry | OriginOnlyComponentSyntaxEntry)[] {
  return catalog.categories[2].entries;
}

function names(entries: readonly { name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

function find<T extends { name: string }>(entries: readonly T[], name: string): T {
  const found = entries.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`no entry named ${name} in [${names(entries).join(", ")}]`);
  }
  return found;
}

const DOCUMENTED = [
  "---",
  "description: Renders a widget.",
  "as: The rendered widget.",
  "context: Markdown shown inside the widget.",
  "props:",
  "  label:",
  "    type: string",
  "required: [label]",
  "---",
  "",
  "Widget {props.label}",
  "",
].join("\n");

describe("Tier SY: the versioned shape", () => {
  it("SY1: reports version 1 and the three categories in a fixed order", function* () {
    const catalog = yield* catalogFor({ components: { kind: "directory" } }, ["components"]);

    expect(catalog.version).toBe(1);
    expect(catalog.categories.map((category) => category.kind)).toEqual([
      "structural",
      "built-in",
      "user-provided",
    ]);
  });

  it("SY2: carries a structural, a registered and a repository entry at once", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Widget.md": markdown(DOCUMENTED),
      },
      ["components"],
    );

    expect(find(structural(catalog), "If").origin).toEqual({
      kind: "structural",
      construct: "If",
    });
    expect(find(builtIn(catalog), "Glob").origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
    expect(find(userProvided(catalog), "Widget").origin).toEqual({
      kind: "repository",
      path: "components/Widget.md",
    });
  });
});

describe("Tier SY: structural vocabulary", () => {
  it("SY3: declares exactly the reserved names, each with syntax and a description", function* () {
    const catalog = yield* catalogFor({}, []);
    const declared = names(structural(catalog));

    expect(new Set(declared)).toEqual(new Set(RESERVED_STRUCTURAL));
    expect(declared.length).toBe(RESERVED_STRUCTURAL.size);
    expect(STRUCTURAL_DECLARATIONS.map((one) => one.name).sort()).toEqual([...declared].sort());
    for (const entry of structural(catalog)) {
      expect(entry.syntax.length).toBeGreaterThan(0);
      for (const form of entry.syntax) {
        expect(form.startsWith(`<${entry.name}`)).toBe(true);
      }
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("SY4: states the authored forms and applicability the representatives have", function* () {
    const catalog = yield* catalogFor({}, []);
    const entries = structural(catalog);

    expect(find(entries, "Let").syntax).toEqual([
      '<Let as="name">…</Let>',
      '<Let as="name" value={value} />',
    ]);
    expect(find(entries, "Content").syntax).toEqual(["<Content />", '<Content slot="name" />']);
    expect(find(entries, "Answer").syntax).toEqual([
      '<Answer template="text" value={value} />',
      "<Answer value={value}>…</Answer>",
    ]);
    expect(find(entries, "Answers").syntax).toEqual(["<Answers>…</Answers>"]);
    expect(find(entries, "Else").syntax).toEqual(["<Else>…</Else>"]);
    expect(find(entries, "Break").syntax).toEqual(["<Break />"]);

    // `as` applies to the two constructs that bind, and to no other.
    const binding = entries.filter((entry) => entry.as !== undefined).map((entry) => entry.name);
    expect(binding.sort()).toEqual(["Each", "Let"]);
    // `Break` and `Content` read no content; `Else` and `Answers` do.
    expect(find(entries, "Break").context).toBeUndefined();
    expect(find(entries, "Content").context).toBeUndefined();
    expect(find(entries, "Else").context).toBeDefined();
    expect(find(entries, "Answers").context).toBeDefined();
  });

  it("SY5: keeps a structural name structural even when a file claims it", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/If.md": markdown("always\n"),
      },
      ["components"],
    );

    expect(names(structural(catalog))).toContain("If");
    expect(names(userProvided(catalog))).not.toContain("If");
    expect(names(builtIn(catalog))).not.toContain("If");
  });
});

describe("Tier SY: repository mapping", () => {
  it("SY6: inverts the four suffixes, nesting dotted names", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Direct.md": markdown("direct\n"),
        "components/Function.ts": { kind: "file", content: "export default 1;\n" },
        "components/Indexed": { kind: "directory" },
        "components/Indexed/index.md": markdown("indexed\n"),
        "components/Ns": { kind: "directory" },
        "components/Ns/Nested.md": markdown("nested\n"),
        "components/Ns/Deep": { kind: "directory" },
        "components/Ns/Deep/index.ts": { kind: "file", content: "export default 1;\n" },
      },
      ["components"],
    );

    expect(names(userProvided(catalog))).toEqual([
      "Direct",
      "Function",
      "Indexed",
      "Ns.Deep",
      "Ns.Nested",
    ]);
  });

  it("SY7: ignores a path that describes no name the grammar accepts", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/notes.md": markdown("lowercase\n"),
        "components/.md": markdown("empty stem\n"),
        "components/File.Delete.md": markdown("a dot is a separator, not a stem\n"),
        "components/helpers": { kind: "directory" },
        "components/helpers/Thing.md": markdown("lowercase ancestor\n"),
        "components/Kept.md": markdown("kept\n"),
      },
      ["components"],
    );

    expect(names(userProvided(catalog))).toEqual(["Kept"]);
    // `File.Delete` is probed at `File/Delete.md`, so the flat spelling answers
    // to no name and must not displace the core default.
    expect(find(builtIn(catalog), "File.Delete").origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
  });
});

describe("Tier SY: selection decides", () => {
  it("SY8: reports the one implementation selection chose, in include order", function* () {
    const catalog = yield* catalogFor(
      {
        first: { kind: "directory" },
        "first/Shared.md": markdown("first\n"),
        second: { kind: "directory" },
        "second/Shared.md": markdown("second\n"),
      },
      ["first", "second"],
    );

    expect(names(userProvided(catalog))).toEqual(["Shared"]);
    expect(find(userProvided(catalog), "Shared").origin).toEqual({
      kind: "repository",
      path: "first/Shared.md",
    });
  });

  it("SY9: prefers .md over .ts, and a direct file over an index", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Both.md": markdown("markdown\n"),
        "components/Both.ts": { kind: "file", content: "export default 1;\n" },
        "components/Both": { kind: "directory" },
        "components/Both/index.md": markdown("index\n"),
      },
      ["components"],
    );

    expect(names(userProvided(catalog))).toEqual(["Both"]);
    expect(find(userProvided(catalog), "Both").origin).toEqual({
      kind: "repository",
      path: "components/Both.md",
    });
  });

  it("SY10: falls back to a registration when no repository file supplies a name", function* () {
    const catalog = yield* catalogFor({ components: { kind: "directory" } }, ["components"]);

    expect(names(builtIn(catalog)).sort()).toEqual([...CORE_COMPONENT_NAMES].sort());
    expect(userProvided(catalog)).toEqual([]);
  });

  it("SY11: moves an overridden built-in into user-provided exactly once", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/TempDir.md": markdown("a repository temporary directory\n"),
      },
      ["components"],
    );

    expect(names(builtIn(catalog))).not.toContain("TempDir");
    expect(names(userProvided(catalog))).toEqual(["TempDir"]);
    expect(find(userProvided(catalog), "TempDir").origin).toEqual({
      kind: "repository",
      path: "components/TempDir.md",
    });
  });
});

describe("Tier SY: include boundaries", () => {
  it("SY12: contributes nothing for an include that is not there", function* () {
    const catalog = yield* catalogFor({ components: { kind: "directory" } }, [
      "components",
      "absent",
    ]);

    expect(userProvided(catalog)).toEqual([]);
  });

  it("SY13: fails the whole request when an include is not a directory", function* () {
    const failure = yield* raised(
      catalogFor({ components: { kind: "file", content: "" } }, ["components"]),
    );

    expect(failure.message).toContain('--include "components"');
    expect(failure.message).toContain("not a directory");
  });

  it("SY14: fails the whole request when an include root is a symbolic link", function* () {
    const failure = yield* raised(
      catalogFor({ components: { kind: "link", to: "directory" } }, ["components"]),
    );

    expect(failure.message).toContain('--include "components"');
    expect(failure.message).toContain("symbolic link");
  });

  it("SY15: selects through a symbolic link to a file", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Linked.md": { kind: "link", to: "file", content: DOCUMENTED },
      },
      ["components"],
    );

    expect(find(userProvided(catalog), "Linked").origin).toEqual({
      kind: "repository",
      path: "components/Linked.md",
    });
  });

  it("SY16: refuses a linked directory, naming the include and the logical entry", function* () {
    const failure = yield* raised(
      catalogFor(
        {
          components: { kind: "directory" },
          "components/Widget": { kind: "link", to: "directory" },
        },
        ["components"],
      ),
    );

    expect(failure.message).toContain('--include "components"');
    expect(failure.message).toContain('"Widget"');
    expect(failure.message).toContain("a directory");
  });

  it("SY17: refuses a link that leads nowhere, and prints no partial catalog", function* () {
    const failure = yield* raised(
      catalogFor(
        {
          components: { kind: "directory" },
          "components/Healthy.md": markdown("healthy\n"),
          "components/Broken.md": { kind: "link", to: "nothing" },
        },
        ["components"],
      ),
    );

    expect(failure.message).toContain('"Broken.md"');
    expect(failure.message).toContain("nothing");
  });

  it("SY18: ignores a link that could not have contributed a name at all", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/node_modules": { kind: "link", to: "directory" },
        "components/readme.md": { kind: "link", to: "nothing" },
        "components/Kept.md": markdown("kept\n"),
      },
      ["components"],
    );

    expect(names(userProvided(catalog))).toEqual(["Kept"]);
  });
});

describe("Tier SY: Markdown documentation is ordinary metadata", () => {
  it("SY19: carries string description, as and context into the catalog", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Widget.md": markdown(DOCUMENTED),
      },
      ["components"],
    );
    const entry = find(userProvided(catalog), "Widget");

    expect(entry).toEqual({
      kind: "component",
      name: "Widget",
      origin: { kind: "repository", path: "components/Widget.md" },
      sourceKind: "markdown",
      inspectability: "complete",
      forms: ["self-closing", "paired"],
      props: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      },
      captures: [],
      returnMode: "text",
      returns: { type: "string" },
      description: "Renders a widget.",
      as: "The rendered widget.",
      context: "Markdown shown inside the widget.",
    });
  });

  it("SY20: leaves a non-string value as metadata and contributes no field", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Odd.md": markdown(
          ["---", "description:", "  - a list", "as: still a string", "---", "", "odd", ""].join(
            "\n",
          ),
        ),
      },
      ["components"],
    );
    const entry = find(userProvided(catalog), "Odd");
    if (entry.inspectability !== "complete") {
      throw new Error("expected a complete entry");
    }

    expect(entry.description).toBeUndefined();
    expect(entry.as).toBe("still a string");
  });

  it("SY21: keeps an undocumented Markdown component complete and discoverable", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Plain.md": markdown("just a body\n"),
      },
      ["components"],
    );
    const entry = find(userProvided(catalog), "Plain");
    if (entry.inspectability !== "complete") {
      throw new Error("expected a complete entry");
    }

    expect(entry.description).toBeUndefined();
    expect(entry.as).toBeUndefined();
    expect(entry.context).toBeUndefined();
    expect(entry.forms).toEqual(["self-closing", "paired"]);
    expect(entry.returnMode).toBe("text");
  });

  it("SY22: reports a declared return as a value, with the declared schema", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Valued.md": markdown(
          ["---", "returns:", "  type: number", "---", "", "<Return value={1} />", ""].join("\n"),
        ),
      },
      ["components"],
    );
    const entry = find(userProvided(catalog), "Valued");
    if (entry.inspectability !== "complete") {
      throw new Error("expected a complete entry");
    }

    expect(entry.returnMode).toBe("value");
    expect(entry.returns).toEqual({ type: "number" });
  });
});

describe("Tier SY: opaque TypeScript", () => {
  it("SY23: reports a repository .ts by origin alone, with no contract fields", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Opaque.ts": {
          kind: "file",
          content: "throw new Error('never imported');\n",
        },
      },
      ["components"],
    );

    expect(find(userProvided(catalog), "Opaque")).toEqual({
      kind: "component",
      name: "Opaque",
      origin: { kind: "repository", path: "components/Opaque.ts" },
      sourceKind: "typescript",
      inspectability: "origin-only",
    });
  });
});

describe("Tier SY: complete component contracts", () => {
  it("SY24: keeps core's form declarations, captures and return modes", function* () {
    const catalog = yield* catalogFor({}, []);
    const entries = builtIn(catalog);

    expect(find(entries, "File").forms).toEqual(["self-closing", "paired"]);
    expect(find(entries, "File.Delete").forms).toEqual(["self-closing"]);
    expect(find(entries, "Json").captures).toEqual(["value"]);
    expect(find(entries, "Json").returnMode).toBe("text");
    expect(find(entries, "Json").returns).toEqual({ type: "string" });
    expect(find(entries, "Glob").returnMode).toBe("value");
    expect(find(entries, "Glob").returns).toEqual({ type: "array", items: { type: "string" } });
  });

  it("SY25: preserves the declaration order of captures and forms", function* () {
    const catalog = yield* scoped(function* () {
      yield* useTree({});
      yield* registerComponents([
        {
          name: "Ordered",
          origin: "test",
          props: { type: "object", properties: {}, additionalProperties: false },
          captures: ["second", "first"],
          forms: ["paired"],
          description: "Declares its captures out of alphabetical order on purpose.",
          fn: function* () {
            return "";
          },
        },
      ]);
      return yield* inspectSyntax({ includes: [] });
    });

    expect(find(builtIn(catalog), "Ordered").captures).toEqual(["second", "first"]);
    expect(find(builtIn(catalog), "Ordered").forms).toEqual(["paired"]);
  });
});

describe("Tier SY: inspection is observation, never authority", () => {
  it("SY26: describes a declared identity component without calling its factory", function* () {
    const calls: string[] = [];
    const ledger: IdentityComponent = {
      name: "Ledger",
      origin: "test-host",
      props: { type: "object", properties: {}, additionalProperties: false },
      description: "Names durable work after its own invocation.",
      context: "Markdown whose durable work this names.",
      factory: () => {
        calls.push("factory");
        throw new Error("an identity factory needs an execution, and inspection mints none");
      },
    };

    const catalog = yield* scoped(function* () {
      yield* useTree({});
      return yield* inspectSyntax({ includes: [], components: [ledger] });
    });

    expect(calls).toEqual([]);
    const entry = find(builtIn(catalog), "Ledger");
    expect(entry.origin).toEqual({ kind: "registered", origin: "test-host", reserved: false });
    expect(entry.description).toBe("Names durable work after its own invocation.");
    expect(entry.context).toBe("Markdown whose durable work this names.");
    expect(entry.as).toBeUndefined();
  });

  it("SY27: lets a repository file override a declared identity component", function* () {
    const catalog = yield* scoped(function* () {
      yield* useTree({
        components: { kind: "directory" },
        "components/Session.md": markdown("a repository session\n"),
      });
      return yield* inspectSyntax({
        includes: ["components"],
        components: agentIdentityComponents(),
      });
    });

    expect(names(builtIn(catalog))).not.toContain("Session");
    expect(find(userProvided(catalog), "Session").origin).toEqual({
      kind: "repository",
      path: "components/Session.md",
    });
  });
});

describe("Tier SY: first-party documentation", () => {
  it("SY28: gives every core and Agent default a description", function* () {
    const catalog = yield* scoped(function* () {
      yield* useTree({});
      yield* registerComponents(AGENT_REGISTRATIONS);
      return yield* inspectSyntax({ includes: [], components: agentIdentityComponents() });
    });

    const undocumented = builtIn(catalog).filter(
      (entry) => entry.description === undefined || entry.description.length === 0,
    );
    expect(names(undocumented)).toEqual([]);
    for (const name of [...CORE_COMPONENT_NAMES, "Agent", "Prompt", "Session"]) {
      expect(names(builtIn(catalog))).toContain(name);
    }
  });
});

describe("Tier SY: determinism", () => {
  it("SY29: answers the same twice, sorted by name within each category", function* () {
    const tree: Tree = {
      components: { kind: "directory" },
      "components/Zebra.md": markdown("zebra\n"),
      "components/Alpha.md": markdown("alpha\n"),
      "components/Ns": { kind: "directory" },
      "components/Ns/Mid.md": markdown("mid\n"),
    };

    const first = yield* catalogFor(tree, ["components"]);
    const second = yield* catalogFor(tree, ["components"]);

    expect(first).toEqual(second);
    for (const category of first.categories) {
      const listed = names(category.entries);
      expect(listed).toEqual([...listed].sort());
    }
    expect(names(userProvided(first))).toEqual(["Alpha", "Ns.Mid", "Zebra"]);
  });
});

/** The error an operation raised, as a value the row can read. */
function* raised(operation: Operation<unknown>): Operation<Error> {
  try {
    yield* operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the operation to fail");
}
