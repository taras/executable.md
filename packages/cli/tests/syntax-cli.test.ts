/**
 * Tier SX — the `xmd syntax` command.
 *
 * Two halves, matching the command's own. The profile rows run in process,
 * because what they check is which declarations `xmd run` installs — a claim
 * about assembly, not about argv. The grammar and failure rows shell out, so
 * exit status, stdout and stderr are the ones an operator sees.
 *
 * Catalog behavior itself is Tier SY's; nothing here re-proves selection.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { API } from "@executablemd/runtime";
import { CORE_COMPONENT_NAMES } from "@executablemd/core";
import type { PropsSchema, SyntaxCatalog } from "@executablemd/core";
import { renderSyntaxJson, renderSyntaxMarkdown, syntaxCatalog } from "../src/syntax.ts";

function* useWorkspace<T>(
  files: Record<string, string>,
  body: (dir: string) => Operation<T>,
): Operation<T> {
  const dir = join(tmpdir(), `xmd-sx-${randomUUID()}`);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      yield* ensureDir(dirname(path));
      yield* writeTextFile(path, content);
    }
    return yield* body(dir);
  });
}

/**
 * A directory symlink, spelled the way the running platform accepts one. A
 * junction is what Windows gives an unprivileged process; everywhere else it is
 * an ordinary directory symlink.
 */
const DIRECTORY_LINK = platform() === "win32" ? "junction" : "dir";

function linkDirectory(target: string, path: string): Operation<void> {
  return until(symlink(target, path, DIRECTORY_LINK));
}

/** A workspace whose default include path holds a component of its own. */
const WORKSPACE: Record<string, string> = {
  "components/Default.md": "the default include path\n",
  "first/Shared.md": "---\ndescription: from the first include.\n---\n\nfirst\n",
  "second/Shared.md": "---\ndescription: from the second include.\n---\n\nsecond\n",
  "second/Only.md": "only in the second include\n",
};

function parseCatalog(text: string): SyntaxCatalog {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the catalog is not an object");
  }
  const version = Reflect.get(parsed, "version");
  const categories = Reflect.get(parsed, "categories");
  if (version !== 1 || !Array.isArray(categories) || categories.length !== 3) {
    throw new Error("the catalog is not the version-1 shape");
  }
  return { version, categories: readCategories(categories) };
}

function readCategories(categories: unknown[]): SyntaxCatalog["categories"] {
  const [structural, builtIn, userProvided] = categories.map(readCategory);
  if (
    structural?.kind !== "structural" ||
    builtIn?.kind !== "built-in" ||
    userProvided?.kind !== "user-provided"
  ) {
    throw new Error("the catalog categories are not the fixed tuple");
  }
  return [
    { kind: "structural", entries: structural.entries },
    { kind: "built-in", entries: builtIn.entries },
    { kind: "user-provided", entries: userProvided.entries },
  ];
}

// deno-lint-ignore no-explicit-any
function readCategory(category: unknown): { kind: unknown; entries: any[] } {
  if (typeof category !== "object" || category === null) {
    throw new Error("a catalog category is not an object");
  }
  const entries = Reflect.get(category, "entries");
  if (!Array.isArray(entries)) {
    throw new Error("a catalog category has no entries");
  }
  return { kind: Reflect.get(category, "kind"), entries };
}

function names(entries: readonly { name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

/** One built-in entry carrying `props`, for a renderer row that supplies its own. */
function catalogWith(props: PropsSchema): SyntaxCatalog {
  return {
    version: 1,
    categories: [
      { kind: "structural", entries: [] },
      {
        kind: "built-in",
        entries: [
          {
            kind: "component",
            name: "Awkward",
            origin: { kind: "registered", origin: "test", reserved: false },
            sourceKind: "registered",
            inspectability: "complete",
            forms: ["self-closing"],
            props,
            captures: [],
            returnMode: "text",
            returns: { type: "string" },
          },
        ],
      },
      { kind: "user-provided", entries: [] },
    ],
  };
}

describe("Tier SX — the run profile the command describes", () => {
  it("SX1: names core, Agent, testing and web defaults, and <Session>", function* () {
    const catalog = yield* syntaxCatalog([]);
    const builtIn = names(catalog.categories[1].entries);

    for (const name of CORE_COMPONENT_NAMES) {
      expect(builtIn).toContain(name);
    }
    for (const name of [
      "Agent",
      "AgentProvider",
      "Prompt",
      "Session",
      "Session.Launch",
      "Testing",
      "AssertEquals",
      "AssertThrows",
      "Execution",
      "CollectOutput",
      "WebForm",
    ]) {
      expect(builtIn).toContain(name);
    }
    expect(catalog.categories[2].entries).toEqual([]);
  });

  it("SX2: documents every complete built-in in the profile", function* () {
    const catalog = yield* syntaxCatalog([]);
    const undocumented = catalog.categories[1].entries.filter(
      (entry) => entry.description === undefined || entry.description.trim().length === 0,
    );

    expect(names(undocumented)).toEqual([]);
  });

  it("SX2b: reports the testing contracts as they actually are", function* () {
    const catalog = yield* syntaxCatalog([]);
    const entries = catalog.categories[1].entries;

    const throws = entries.find((entry) => entry.name === "AssertThrows");
    // `message` is a capture, so it is deliberately absent from the schema —
    // which is exactly why the prose has to say it is required.
    expect(throws?.captures).toEqual(["message"]);
    expect(throws?.props.properties).toEqual({});
    expect(throws?.description).toContain("required");
    // The return binds by reference, so `as` receives the segment itself.
    expect(throws?.as).toContain("caught error segment");

    // An ordinary assertion returns its report, so `as` binds text — not the
    // outcome, which a failing assertion never returns at all.
    const equals = entries.find((entry) => entry.name === "AssertEquals");
    expect(equals?.as).toContain("diagnostic report");
    expect(equals?.returnMode).toBe("text");

    // A kind that reads expected children accepts both forms; one that refuses
    // them accepts one, and `assertions.test.ts` proves the refusal.
    expect(equals?.forms).toEqual(["self-closing", "paired"]);
    expect(entries.find((entry) => entry.name === "Assert")?.forms).toEqual(["self-closing"]);
    expect(entries.find((entry) => entry.name === "AssertMatch")?.forms).toEqual(["self-closing"]);
    expect(entries.find((entry) => entry.name === "AssertStringIncludes")?.forms).toEqual([
      "self-closing",
      "paired",
    ]);
  });

  it("SX3: describes <Session> without minting an execution claimant", function* () {
    const catalog = yield* syntaxCatalog([]);
    const session = catalog.categories[1].entries.find((entry) => entry.name === "Session");

    // A registered default, described from the declaration a host makes: had
    // anything built the implementation it would have needed a claimant, and
    // there is no execution here to mint one.
    expect(session?.origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: false,
    });
    expect(session?.description).toBeDefined();
  });
});

describe("Tier SX — the renderers take a value", () => {
  it("SX4: renders both formats without reaching the filesystem", function* () {
    const catalog = yield* syntaxCatalog([]);

    const rendered = yield* scoped(function* () {
      yield* API.Fs.around({
        // deno-lint-ignore require-yield
        *readTextFile([path]) {
          throw new Error(`a renderer read ${path}`);
        },
        // deno-lint-ignore require-yield
        *stat([path]) {
          throw new Error(`a renderer stat'd ${path}`);
        },
        // deno-lint-ignore require-yield
        *lstat([path]) {
          throw new Error(`a renderer lstat'd ${path}`);
        },
        // deno-lint-ignore require-yield
        *glob([options]) {
          throw new Error(`a renderer walked ${options.root}`);
        },
      });
      return {
        markdown: renderSyntaxMarkdown(catalog),
        json: renderSyntaxJson(catalog),
      };
    });

    expect(rendered.markdown).toContain("## Built-in components");
    expect(rendered.json.endsWith("\n")).toBe(true);
  });

  it("SX4b: escapes a table cell that would otherwise shift the columns", function* () {
    const markdown = renderSyntaxMarkdown(
      catalogWith({
        type: "object",
        properties: {
          "left|right": { type: "string", description: "a | in the description, and\na break" },
          plain: { type: ["string", "number"] },
        },
        required: ["left|right"],
        additionalProperties: false,
      }),
    );

    const rows = markdown.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows).toEqual([
      "| `left\\|right` | `string` | yes | a \\| in the description, and a break |",
      "| `plain` | `string` \\| `number` | no |  |",
    ]);
    // Every row still has the four columns the header declares.
    for (const line of rows) {
      expect(line.split(/(?<!\\)\|/).length).toBe(6);
    }
  });

  it("SX5: renders the same bytes twice from the same catalog", function* () {
    const catalog = yield* syntaxCatalog([]);

    expect(renderSyntaxMarkdown(catalog)).toBe(renderSyntaxMarkdown(catalog));
    expect(renderSyntaxJson(catalog)).toBe(renderSyntaxJson(catalog));
  });

  it("SX6: renders the fixed category headings in order", function* () {
    const markdown = renderSyntaxMarkdown(yield* syntaxCatalog([]));
    const headings = [
      "## Built-in structural syntax",
      "## Built-in components",
      "## User-provided components",
    ];
    const positions = headings.map((heading) => markdown.indexOf(heading));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("Tier SX — the command line", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("SX7: explicit includes replace the defaults, in caller order", function* () {
    yield* useWorkspace(WORKSPACE, function* (cwd) {
      const forward = yield* runCli(
        ["syntax", "--json", "--include", "first", "--include", "second"],
        { cwd },
      ).expect();
      const forwardCatalog = parseCatalog(forward.stdout);
      expect(names(forwardCatalog.categories[2].entries)).toEqual(["Only", "Shared"]);
      const shared = forwardCatalog.categories[2].entries.find((one) => one.name === "Shared");
      expect(shared?.origin).toEqual({ kind: "repository", path: "first/Shared.md" });
      // The default include path holds a component, and an explicit include
      // replaces the defaults rather than adding to them.
      expect(names(forwardCatalog.categories[2].entries)).not.toContain("Default");

      const reversed = yield* runCli(
        ["syntax", "--json", "--include", "second", "--include", "first"],
        { cwd },
      ).expect();
      const reversedShared = parseCatalog(reversed.stdout).categories[2].entries.find(
        (one) => one.name === "Shared",
      );
      expect(reversedShared?.origin).toEqual({ kind: "repository", path: "second/Shared.md" });
    });
  });

  it("SX8: falls back to components and . when no include is written", function* () {
    yield* useWorkspace(WORKSPACE, function* (cwd) {
      const { stdout } = yield* runCli(["syntax", "--json"], { cwd }).expect();
      const catalog = parseCatalog(stdout);

      expect(names(catalog.categories[2].entries)).toContain("Default");
    });
  });

  it("SX9: reports an unusable include on stderr, exits 1, and prints no catalog", function* () {
    yield* useWorkspace({ components: "not a directory\n" }, function* (cwd) {
      const { code, stdout, stderr } = yield* runCli(["syntax", "--include", "components"], {
        cwd,
      }).join();

      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("components");
      expect(stderr).toContain("not a directory");
    });
  });

  it("SX10: writes markdown by default and version-1 JSON with --json", function* () {
    yield* useWorkspace(WORKSPACE, function* (cwd) {
      const markdown = yield* runCli(["syntax", "--include", "first"], { cwd }).expect();
      expect(markdown.stdout).toContain("## Built-in structural syntax");
      expect(markdown.stdout).toContain("### `<Shared>`");
      expect(markdown.stdout).toContain("from the first include.");

      const json = yield* runCli(["syntax", "--json", "--include", "first"], { cwd }).expect();
      const catalog = parseCatalog(json.stdout);
      expect(catalog.version).toBe(1);
      expect(names(catalog.categories[2].entries)).toEqual(["Shared"]);
    });
  });

  it("SX12: succeeds with the defaults in a package tree full of directory links", function* () {
    yield* useWorkspace(
      {
        "components/Widget.md": "---\ndescription: a repository widget.\n---\n\nwidget\n",
        // A pnpm-shaped tree: real packages under a store, and the links into
        // it that every install creates.
        "node_modules/.pnpm/effection@4.0.0/node_modules/effection/mod.js": "export {};\n",
        "node_modules/.pnpm/zod@3.0.0/node_modules/zod/mod.js": "export {};\n",
      },
      function* (cwd) {
        yield* linkDirectory(
          join(cwd, "node_modules/.pnpm/effection@4.0.0/node_modules/effection"),
          join(cwd, "node_modules/effection"),
        );
        yield* linkDirectory(
          join(cwd, "node_modules/.pnpm/zod@3.0.0/node_modules/zod"),
          join(cwd, "node_modules/zod"),
        );

        // No `--include`: the defaults are `["components", "."]`, so `.` walks
        // the whole tree and reaches both links.
        const { code, stdout, stderr } = yield* runCli(["syntax", "--json"], { cwd }).join();

        expect(stderr).toBe("");
        expect(code).toBe(0);
        const catalog = parseCatalog(stdout);
        expect(names(catalog.categories[2].entries)).toEqual(["Widget"]);
      },
    );
  });

  it("SX11: the catalog is inspection, and prompt is the command that writes with it", function* () {
    const { stdout } = yield* runCli(["--help"]).expect();

    expect(stdout).toContain("syntax");
    // `xmd prompt` is the other reader of this catalog: it feeds the same
    // structured value to a generator rather than spawning this command and
    // parsing what it printed.
    expect(stdout).toMatch(/^\s+prompt\s/m);
  });
});
