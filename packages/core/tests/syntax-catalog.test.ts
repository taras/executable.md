/**
 * Tier SY — the syntax catalog.
 *
 * What a document may write in a directory, answered without running any of it.
 * The filesystem is stubbed at the contextual `API.Fs` boundary rather than
 * with `useStubFs`, because these rows are about the three operations that
 * disagree — `lstat` on the include root, `readDirectory` over one level of its
 * entries, and `stat` through a symbolic link — and the shared stub answers
 * none of the enumerating ones.
 *
 * The stub reads one level at a time, the way the walk does, so a directory it
 * is told is unreadable is a real trap: reaching it throws, and the recorded
 * reads say exactly which directories were entered.
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
import type { DirectoryEntry, LinkStatResult, StatResult } from "@executablemd/runtime";
import { repositoryComponentName } from "../src/components/candidates.ts";
import {
  AGENT_REGISTRATIONS,
  agentIdentityComponents,
  CORE_COMPONENT_NAMES,
  inspectSyntax,
  PROTECTED_COMPONENT_NAMES,
  registerComponents,
  RESERVED_STRUCTURAL,
  STRUCTURAL_DECLARATIONS,
} from "../mod.ts";
import type {
  CompleteComponentSyntaxEntry,
  OriginOnlyComponentSyntaxEntry,
  StructuralSyntaxEntry,
  SyntaxSymbols,
} from "../mod.ts";
import type { IdentityComponent } from "../host.ts";
import type { InvocationForm } from "../mod.ts";

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

/**
 * The tree is keyed by working-directory-relative paths, so a path is resolved
 * the way a host resolves one before it is looked up: `.` and empty segments
 * carry no meaning, and a leading separator is what makes a path absolute.
 *
 * An absolute path stays absolute — with its leading separators intact, because
 * `//server/share` and `/server/share` are different roots — and so matches
 * nothing a relative key holds. That is what makes a read that escapes the
 * include, or lands one separator away from it, observable here at all.
 */
function resolve(path: string): string {
  const leading = /^\/*/.exec(path)?.[0] ?? "";
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (leading !== "") {
    return `${leading}${segments.join("/")}`;
  }
  return segments.length === 0 ? "." : segments.join("/");
}

function stat(tree: Tree, path: string): StatResult {
  const node = tree[resolve(path)];
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
  const node = tree[resolve(path)];
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
  const node = tree[resolve(path)];
  const content = node?.kind === "file" || node?.kind === "link" ? node.content : undefined;
  if (content === undefined) {
    throw new Error(`ENOENT: no such file: ${path}`);
  }
  return content;
}

/**
 * The entries one directory holds directly, the way `readDirectory` reports
 * them: names rather than paths, one level rather than a subtree, and a link by
 * itself — a linked directory holds no entries in this tree, which is exactly
 * what not following one produces.
 */
function children(tree: Tree, directory: string): DirectoryEntry[] {
  const root = resolve(directory);
  const prefix = root === "." ? "" : `${root}/`;
  const found: DirectoryEntry[] = [];
  for (const [path, node] of Object.entries(tree)) {
    if (!path.startsWith(prefix) || path === root) {
      continue;
    }
    const name = path.slice(prefix.length);
    if (name === "" || name.includes("/")) {
      continue;
    }
    found.push({
      name,
      isFile: node.kind === "file",
      isDirectory: node.kind === "directory",
      isSymbolicLink: node.kind === "link",
    });
  }
  return found;
}

/** What a walk is allowed to reach, and what it actually reached. */
interface Enumeration {
  /** Directories the walk must never enter. Reading one throws. */
  unreadable?: readonly string[];
  /** Every directory read, appended in read order. */
  reads?: string[];
}

function* useTree(tree: Tree, enumeration: Enumeration = {}): Operation<void> {
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
    *readDirectory([path]) {
      enumeration.reads?.push(path);
      if (enumeration.unreadable?.includes(resolve(path)) === true) {
        throw new Error(`EACCES: permission denied, scandir '${path}'`);
      }
      return children(tree, path);
    },
    // deno-lint-ignore require-yield
    *glob([options]) {
      throw new Error(`enumeration globbed ${JSON.stringify(options.root)}`);
    },
  });
}

function markdown(body: string): Node {
  return { kind: "file", content: body };
}

function catalogFor(
  tree: Tree,
  includes: readonly string[],
  enumeration: Enumeration = {},
): Operation<SyntaxSymbols> {
  return scoped(function* () {
    yield* useTree(tree, enumeration);
    return yield* inspectSyntax({ includes });
  });
}

function structural(catalog: SyntaxSymbols): readonly StructuralSyntaxEntry[] {
  return catalog.categories[0].entries;
}

function builtIn(catalog: SyntaxSymbols): readonly CompleteComponentSyntaxEntry[] {
  return catalog.categories[1].entries;
}

function userProvided(
  catalog: SyntaxSymbols,
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
  it("SY1: reports version 2 and the three categories in a fixed order", function* () {
    const catalog = yield* catalogFor({ components: { kind: "directory" } }, ["components"]);

    expect(catalog.version).toBe(2);
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

  it("SY4b: freezes the <Switch> and <Case> entries the catalog publishes", function* () {
    const catalog = yield* catalogFor({}, []);
    const entries = structural(catalog);

    expect(catalog.version).toBe(2);
    expect(find(entries, "Switch")).toEqual({
      kind: "structural",
      name: "Switch",
      origin: { kind: "structural", construct: "Switch" },
      syntax: ["<Switch value={value}>…</Switch>"],
      description:
        "Choose one branch by comparing a value with `===`. " +
        '`<Switch value={status}><Case value="ready">…</Case><Case default>…</Case></Switch>` ' +
        "expands the first matching case, or the final default when none matches.",
      context: "Direct `<Case>` branches considered in source order.",
    });
    expect(find(entries, "Case")).toEqual({
      kind: "structural",
      name: "Case",
      origin: { kind: "structural", construct: "Case" },
      syntax: ["<Case value={value}>…</Case>", "<Case default>…</Case>"],
      description:
        'Define one branch of a `<Switch>`. `<Case value="ready">…</Case>` matches with ' +
        "`===`; `<Case default>…</Case>` is the final fallback.",
      context: "Markdown expanded when this case is selected.",
    });
    // Neither construct binds, so neither carries an `as` sentence at all.
    expect(find(entries, "Switch").as).toBeUndefined();
    expect(find(entries, "Case").as).toBeUndefined();
  });

  it("SY5b: a repository file cannot supply <Switch> or <Case>, and neither can a registration", function* () {
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Switch.md": markdown("a repository switch\n"),
        "components/Case.md": markdown("a repository case\n"),
      },
      ["components"],
    );

    for (const name of ["Switch", "Case"]) {
      expect(names(structural(catalog))).toContain(name);
      expect(names(userProvided(catalog))).not.toContain(name);
      expect(names(builtIn(catalog))).not.toContain(name);
    }

    for (const name of ["Switch", "Case"]) {
      let refused: unknown;
      yield* scoped(function* () {
        try {
          yield* registerComponents([
            {
              name,
              origin: "tier-sy",
              props: {},
              *fn() {
                return "";
              },
            },
          ]);
        } catch (error) {
          refused = error;
        }
      });
      expect(refused instanceof Error ? refused.message : "").toContain(
        `cannot register "${name}": it is structural syntax the engine owns`,
      );
    }
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
        // A dot is a separator, never part of a segment. `File.Delete` is
        // probed at `File/Delete.md`, so neither of these two spellings answers
        // to a name and neither may displace the core default.
        "components/File.Delete.md": markdown("a flat dotted file\n"),
        "components/File.Delete": { kind: "directory" },
        "components/File.Delete/index.md": markdown("a flat dotted directory\n"),
        "components/helpers": { kind: "directory" },
        "components/helpers/Thing.md": markdown("lowercase ancestor\n"),
        "components/Kept.md": markdown("kept\n"),
      },
      ["components"],
    );

    expect(names(userProvided(catalog))).toEqual(["Kept"]);
    expect(find(builtIn(catalog), "File.Delete").origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
  });

  it("SY7c: never reads a subtree no component name can reach", function* () {
    // Every directory named here as unreadable throws when it is read, so the
    // catalog being built at all is the proof that none of them was entered.
    const reads: string[] = [];
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/Direct.md": markdown("direct\n"),
        "components/Ns": { kind: "directory" },
        "components/Ns/Nested.md": markdown("nested\n"),
        "components/Ns/Indexed": { kind: "directory" },
        "components/Ns/Indexed/index.md": markdown("indexed\n"),
        "components/node_modules": { kind: "directory" },
        "components/node_modules/Widget.md": markdown("out of reach\n"),
        "components/.hidden": { kind: "directory" },
        "components/.hidden/Widget.md": markdown("out of reach\n"),
        "components/File.Delete": { kind: "directory" },
        "components/File.Delete/index.md": markdown("out of reach\n"),
        "components/Ns/vendor": { kind: "directory" },
        "components/Ns/vendor/Widget.md": markdown("out of reach\n"),
      },
      ["components"],
      {
        unreadable: [
          "components/node_modules",
          "components/.hidden",
          "components/File.Delete",
          "components/Ns/vendor",
        ],
        reads,
      },
    );

    expect(names(userProvided(catalog))).toEqual(["Direct", "Ns.Indexed", "Ns.Nested"]);
    // Sorted, because which directories were read is the contract and the
    // order they were read in is not.
    expect([...reads].sort()).toEqual(["components", "components/Ns", "components/Ns/Indexed"]);
    // A dotted directory reaches no name even though the name exists: the
    // built-in keeps it.
    expect(find(builtIn(catalog), "File.Delete").origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
  });

  it("SY7b: inverts a path only through single-segment names", function* () {
    for (const path of [
      "File.Delete.md",
      "File.Delete.ts",
      "File.Delete/index.md",
      "Ns/File.Delete.md",
      "notes.md",
      "Widget.txt",
      "index.md",
      ".md",
    ]) {
      expect(repositoryComponentName(path)).toBeUndefined();
    }
    expect(repositoryComponentName("File/Delete.md")).toBe("File.Delete");
    expect(repositoryComponentName("Widget.ts")).toBe("Widget");
    expect(repositoryComponentName("Ns/Widget/index.md")).toBe("Ns.Widget");
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

    // Core's overridable defaults, plus the names canonical core protects: both
    // are built-in to a reader, and the set is pinned exactly so a name arriving
    // in either list has to be written down here.
    expect(names(builtIn(catalog)).sort()).toEqual(
      [...CORE_COMPONENT_NAMES, ...PROTECTED_COMPONENT_NAMES].sort(),
    );
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

  it("SY13b: fails the whole request when a directory a name reaches cannot be read", function* () {
    // Pruning skips what no name reaches; it must not turn a reachable
    // directory that refuses into a quietly shorter catalog.
    const tree: Tree = {
      components: { kind: "directory" },
      "components/Kept.md": markdown("kept\n"),
      "components/Ns": { kind: "directory" },
      "components/Ns/Nested.md": markdown("nested\n"),
    };

    const atRoot = yield* raised(catalogFor(tree, ["components"], { unreadable: ["components"] }));
    expect(atRoot.message).toContain("components");

    const beneath = yield* raised(
      catalogFor(tree, ["components"], { unreadable: ["components/Ns"] }),
    );
    expect(beneath.message).toContain("components/Ns");
  });

  it("SY13c: keeps every read beneath an include however it is spelled", function* () {
    // A `.` segment and an empty one carry no meaning, so `.`, `./` and `.//`
    // all name the working directory. Joining an entry to the include as
    // written turns the last two into the filesystem root's `/Ns`.
    //
    // What each spelling *selects* is `selectComponent()`'s and is untouched:
    // `probeComponentPath()` spells its candidates as it always has, so the
    // spellings that resolve nothing here resolve nothing on `main` too. Each
    // row is the base binary's own answer for that include.
    const tree: Tree = {
      ".": { kind: "directory" },
      Ns: { kind: "directory" },
      "Ns/Widget.md": markdown("nested\n"),
      "Ns/Deep": { kind: "directory" },
      "Ns/Deep/index.md": markdown("deep\n"),
      "Ns/vendor": { kind: "directory" },
      "Ns/vendor/Widget.md": markdown("out of reach\n"),
      "Direct.md": markdown("direct\n"),
      node_modules: { kind: "directory" },
      "node_modules/Widget.md": markdown("out of reach\n"),
    };

    const spellings = [
      { include: ".", reads: [".", "Ns", "Ns/Deep"], selects: ["Direct", "Ns.Deep", "Ns.Widget"] },
      { include: "./", reads: [".", "Ns", "Ns/Deep"], selects: [] },
      { include: ".//", reads: [".", "Ns", "Ns/Deep"], selects: [] },
      { include: "./Ns", reads: ["Ns", "Ns/Deep"], selects: ["Deep", "Widget"] },
      { include: ".//Ns", reads: ["Ns", "Ns/Deep"], selects: [] },
    ];

    for (const spelling of spellings) {
      const reads: string[] = [];
      const catalog = yield* catalogFor(tree, [spelling.include], {
        unreadable: ["node_modules", "Ns/vendor"],
        reads,
      });

      expect(reads.filter((read) => read.startsWith("/"))).toEqual([]);
      expect([...reads].sort()).toEqual([...spelling.reads]);
      expect(names(userProvided(catalog))).toEqual([...spelling.selects]);
    }
  });

  it("SY13d: keeps an absolute include's leading separators, which name its root", function* () {
    // `//server/share` is a UNC share on Windows, and two leading separators are
    // implementation-defined on POSIX. Collapsing them names `/server/share` —
    // a different directory, one separator away — so the share below holds the
    // components and `/server/share` holds a trap that throws if it is read.
    const tree: Tree = {
      "//server/share": { kind: "directory" },
      "//server/share/Direct.md": markdown("direct\n"),
      "//server/share/Ns": { kind: "directory" },
      "//server/share/Ns/Widget.md": markdown("nested\n"),
      "//server/share/node_modules": { kind: "directory" },
      "//server/share/node_modules/Widget.md": markdown("out of reach\n"),
      "/server/share": { kind: "directory" },
      "/server/share/Trap.md": markdown("one separator away\n"),
    };

    for (const include of ["//server/share", "//server/share/"]) {
      const reads: string[] = [];
      const catalog = yield* catalogFor(tree, [include], {
        unreadable: ["/server/share", "//server/share/node_modules"],
        reads,
      });

      expect(reads.every((read) => read.startsWith("//server/share"))).toBe(true);
      expect([...reads].sort()).toEqual(["//server/share", "//server/share/Ns"]);
      expect(names(userProvided(catalog))).toEqual(["Direct", "Ns.Widget"]);
    }
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

  it("SY18: ignores a link behind a prefix no component name reaches", function* () {
    // `probeComponentPath()` walks a candidate path and nothing else, so a link
    // no candidate path runs through cannot hide an implementation execution
    // would have selected. Refusing it would fail every package repository,
    // whose `node_modules` is full of directory links.
    const catalog = yield* catalogFor(
      {
        components: { kind: "directory" },
        "components/node_modules": { kind: "link", to: "directory" },
        "components/.hidden": { kind: "link", to: "directory" },
        "components/File.Delete": { kind: "link", to: "directory" },
        "components/readme.md": { kind: "link", to: "nothing" },
        "components/vendor": { kind: "directory" },
        "components/vendor/Widget": { kind: "link", to: "directory" },
        "components/Kept.md": markdown("kept\n"),
      },
      ["components"],
    );

    expect(names(userProvided(catalog))).toEqual(["Kept"]);
    expect(find(builtIn(catalog), "File.Delete").origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
  });

  it("SY18b: refuses a relevant link even where an ignored one sits beside it", function* () {
    const failure = yield* raised(
      catalogFor(
        {
          components: { kind: "directory" },
          "components/node_modules": { kind: "link", to: "directory" },
          "components/Widget": { kind: "link", to: "directory" },
          "components/Kept.md": markdown("kept\n"),
        },
        ["components"],
      ),
    );

    expect(failure.name).toBe("ComponentIncludeError");
    expect(failure.message).toContain('"Widget"');
    expect(failure.message).not.toContain("node_modules");
  });

  it("SY18c: names the include and the logical entry, never the resolved target", function* () {
    const failure = yield* raised(
      catalogFor(
        {
          components: { kind: "directory" },
          "components/Widget": { kind: "link", to: "directory" },
          elsewhere: { kind: "directory" },
        },
        ["components"],
      ),
    );

    expect(failure.message).toContain('--include "components"');
    expect(failure.message).toContain('"Widget"');
    // The classification asked what the link leads to, never where. A host path
    // in the diagnostic would publish a resolution the walk deliberately did
    // not expose.
    expect(failure.message).not.toContain("elsewhere");
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
    // Form-sensitive without a dispatcher: `<Json>` refuses content in its own
    // body, and `json-component.test.ts` is where that refusal is proved. What
    // this checks is that the catalog reports the form the refusal leaves.
    expect(find(entries, "Json").forms).toEqual(["self-closing"]);
    expect(find(entries, "Json").captures).toEqual(["value"]);
    expect(find(entries, "Json").returnMode).toBe("text");
    expect(find(entries, "Json").returns).toEqual({ type: "string" });
    expect(find(entries, "TempDir").forms).toEqual(["self-closing", "paired"]);
    expect(find(entries, "Glob").returnMode).toBe("value");
    expect(find(entries, "Glob").returns).toEqual({ type: "array", items: { type: "string" } });
  });

  it("SY24b: reports <CodeBlock>'s whole contract, without running it", function* () {
    const catalog = yield* catalogFor({}, []);
    const entry = find(builtIn(catalog), "CodeBlock");

    expect(entry.origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
    expect(entry.sourceKind).toBe("registered");
    expect(entry.forms).toEqual(["self-closing"]);
    expect(entry.props).toEqual({
      type: "object",
      properties: {
        value: { type: "string" },
        language: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._+#-]*$" },
      },
      required: ["value"],
      additionalProperties: false,
    });
    // `value` crosses the ordinary prop boundary, so it is in the schema above
    // rather than in this list — which is what a repository override receives.
    expect(entry.captures).toEqual([]);
    expect(entry.returnMode).toBe("text");
    expect(entry.returns).toEqual({ type: "string" });
    expect(entry.as).toContain("Optional");
    expect(entry.context).toBe(undefined);
  });

  it("SY24b2: reports <Json>'s whole contract, optional `as` and all", function* () {
    const catalog = yield* catalogFor({}, []);
    const entry = find(builtIn(catalog), "Json");

    // The whole row: what an author reads about `<Json>` and what a repository
    // override is measured against are the same fields, so a drift in either
    // is a failure here.
    expect(entry).toEqual({
      kind: "component",
      name: "Json",
      origin: { kind: "registered", origin: "@executablemd/core", reserved: false },
      sourceKind: "registered",
      inspectability: "complete",
      forms: ["self-closing"],
      // Closed and empty: `value` is a capture, and a schema cannot describe a
      // value it never sees.
      props: { type: "object", properties: {}, additionalProperties: false },
      captures: ["value"],
      // Text, and no declared value return: `as` captures what the component
      // rendered rather than a value it validated.
      returnMode: "text",
      returns: { type: "string" },
      description:
        "Render a value as JSON text. `<Json value={config} />` writes the JSON where you " +
        "put it.",
      as: "Optional. Captures the JSON text instead of emitting it.",
    });
    // Contentless, so there is no body to document.
    expect(entry.context).toBe(undefined);
  });

  it("SY24c: describes <Fail> completely enough to copy the invocation", function* () {
    const catalog = yield* catalogFor({}, []);

    // The whole row, so a drift in origin, form, schema, return mode or prose
    // is a failure here rather than a surprise for an author reading it.
    expect(find(builtIn(catalog), "Fail")).toEqual({
      kind: "component",
      name: "Fail",
      origin: { kind: "registered", origin: "@executablemd/core", reserved: false },
      sourceKind: "registered",
      inspectability: "complete",
      forms: ["self-closing"],
      props: {
        type: "object",
        properties: { message: { type: "string", minLength: 1 } },
        required: ["message"],
        additionalProperties: false,
      },
      captures: [],
      returnMode: "text",
      returns: { type: "string" },
      description:
        "Stop authored work with an actionable failure. " +
        '`<Fail message="No acceptable candidate was approved." />` raises the message where ' +
        "it is written.",
    });
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

  it("SY25b: refuses a forms declaration that is not one of the three spellings", function* () {
    for (const forms of [
      [],
      ["paired", "self-closing"],
      ["paired", "paired"],
      ["either"],
      "both",
    ]) {
      const failure = yield* raised(
        scoped(function* () {
          yield* useTree({});
          return yield* inspectSyntax({ includes: [], components: [ledgerDeclaring(forms)] });
        }),
      );

      // The same refusal registration raises, because it is the same check.
      expect(failure.name).toBe("ComponentRegistrationError");
      expect(failure.message).toContain('the declaration for "Ledger"');
      expect(failure.message).toContain("self-closing");
    }
  });

  it("SY25c: accepts each canonical forms declaration, and omission", function* () {
    const canonical: readonly (readonly InvocationForm[] | undefined)[] = [
      undefined,
      ["self-closing"],
      ["paired"],
      ["self-closing", "paired"],
    ];

    for (const forms of canonical) {
      const catalog = yield* scoped(function* () {
        yield* useTree({});
        return yield* inspectSyntax({
          includes: [],
          components: [forms === undefined ? ledger() : { ...ledger(), forms }],
        });
      });

      // Omission means both, which is what a declaration meant before forms
      // could be written at all.
      expect(find(builtIn(catalog), "Ledger").forms).toEqual(forms ?? BOTH);
    }
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

  it("SY26b: refuses two declarations of one name, before either factory", function* () {
    const calls: string[] = [];
    const declaring = (origin: string): IdentityComponent => ({
      ...ledger(),
      origin,
      factory: () => {
        calls.push(origin);
        throw new Error("a refused declaration set never reaches a factory");
      },
    });

    let catalog: SyntaxSymbols | undefined;
    const failure = yield* raised(
      scoped(function* () {
        yield* useTree({});
        catalog = yield* inspectSyntax({
          includes: [],
          components: [declaring("first-host"), declaring("second-host")],
        });
        return catalog;
      }),
    );

    // A `Map` keyed by name would have kept the second and answered as though a
    // host had declared one component. The set is refused instead.
    expect(failure.name).toBe("ComponentInvocationError");
    expect(failure.message).toContain('two identity components called "Ledger"');
    expect(catalog).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("SY26c: admits a declaration on the terms registration admits one", function* () {
    const refused: Partial<IdentityComponent>[] = [
      // Structural syntax the engine owns.
      { name: "Let" },
      // A name a document could not write.
      { name: "widget" },
      // No origin to report.
      { origin: "" },
      // A capture the schema also describes, and one the engine owns.
      { props: { type: "object", properties: { value: { type: "string" } } }, captures: ["value"] },
      { captures: ["as"] },
      // A props schema that cannot be compiled.
      { props: { type: "object", properties: { bad: { type: "nonsense" } } } },
    ];

    for (const change of refused) {
      const declaration = { ...ledger(), ...change };
      const inspected = yield* raised(
        scoped(function* () {
          yield* useTree({});
          return yield* inspectSyntax({ includes: [], components: [declaration] });
        }),
      );
      // The same declaration, offered to the path ordinary execution takes.
      const registered = yield* raised(
        scoped(function* () {
          yield* registerComponents([
            {
              ...declaration,
              fn: function* () {
                return "";
              },
            },
          ]);
        }),
      );

      // Same input, same refusal: the two read one check, so neither can come
      // to accept what the other rejects.
      expect(inspected.name).toBe(registered.name);
      expect(inspected.message).toBe(registered.message);
    }
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

const BOTH: readonly InvocationForm[] = ["self-closing", "paired"];

/** A host-declared identity component with nothing said about its forms. */
function ledger(): IdentityComponent {
  return {
    name: "Ledger",
    origin: "test-host",
    props: { type: "object", properties: {}, additionalProperties: false },
    factory: () => {
      throw new Error("a declaration this refuses never reaches a factory");
    },
  };
}

/**
 * The same declaration with `forms` written to whatever a host wrote.
 *
 * Planted rather than declared, because the values worth refusing are the ones
 * the type already excludes: a host reaches this boundary from JavaScript, and
 * the refusal exists for exactly what the compiler could not have stopped.
 */
function ledgerDeclaring(forms: unknown): IdentityComponent {
  const declaration = ledger();
  Reflect.set(declaration, "forms", forms);
  return declaration;
}

/** The error an operation raised, as a value the row can read. */
function* raised(operation: Operation<unknown>): Operation<Error> {
  try {
    yield* operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the operation to fail");
}
