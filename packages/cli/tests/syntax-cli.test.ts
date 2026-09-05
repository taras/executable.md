/**
 * Tier SX — the `xmd syntax` command.
 *
 * Two halves, matching the command's own. The profile rows run in process,
 * because what they check is which declarations `xmd run` installs — a claim
 * about assembly, not about argv. The grammar, failure and delivery rows shell
 * out, so exit status, stdout and stderr are the ones an operator sees.
 *
 * Catalog behavior itself is Tier SY's; nothing here re-proves selection.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliShellCommand, runCli, runShell, shellQuote } from "@executablemd/test-support/launch";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
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

/** The thirteen names #643 settled, exactly as a document writes them. */
const COMPOSITION_NAMES = [
  "Repository",
  "Worktree",
  "Dir",
  "Git.Switch",
  "Git.Add",
  "Git.Commit",
  "Git.Push",
  "PullRequest",
  "PullRequest.Reviews",
  "PullRequest.Comments",
  "PullRequest.Checks",
  "IssueTracker",
  "Issue",
] as const;

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

  it("SX1b: describes <Syntax> once, as the component canonical core owns", function* () {
    const catalog = yield* syntaxCatalog([]);
    const everywhere = catalog.categories.flatMap((category) =>
      category.entries.filter((entry) => entry.name === "Syntax"),
    );
    // Once, and in the built-in category: a name a document cannot take back is
    // not user-provided, and two entries would mean two tiers answered.
    expect(everywhere).toHaveLength(1);
    expect(names(catalog.categories[1].entries)).toContain("Syntax");

    const [entry] = everywhere;
    if (entry === undefined || entry.kind !== "component" || entry.inspectability !== "complete") {
      throw new Error("the catalog describes <Syntax> without a contract");
    }
    expect(entry.origin).toEqual({
      kind: "registered",
      origin: "@executablemd/core",
      reserved: true,
    });
    expect(entry.forms).toEqual(["self-closing"]);
    expect(entry.props).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(entry.captures).toEqual([]);
    expect(entry.returnMode).toBe("text");
    expect(entry.description).toBe(
      "Output available components and control flow constructs. `<Syntax />` renders the " +
        "current catalog.",
    );
    expect(entry.as).toBe("Optional. Captures the rendered catalog instead of emitting it.");
  });

  it("ORC1: names all thirteen repository-composition components, with contracts", function* () {
    const catalog = yield* syntaxCatalog([]);
    const entries = catalog.categories[1].entries;
    const builtIn = names(entries);

    for (const name of COMPOSITION_NAMES) {
      expect(builtIn).toContain(name);
    }

    // A complete contract, not a bare name: every one of them says what it is
    // for, which forms it takes, and what its props are.
    for (const name of COMPOSITION_NAMES) {
      const entry = entries.find((candidate) => candidate.name === name);
      expect(entry?.description ?? "").not.toBe("");
      expect(entry?.forms?.length ?? 0).toBeGreaterThan(0);
      // Registered rather than reserved, which is what makes a repository
      // component of the same name win.
      expect(entry?.origin).toEqual({
        kind: "registered",
        origin: "@executablemd/workflow/composition",
        reserved: false,
      });
    }

    // The ones that produce a value say what `as` binds; the ones that render
    // nothing and produce nothing do not pretend to.
    expect(entries.find((entry) => entry.name === "Git.Commit")?.as).toContain("object id");
    expect(entries.find((entry) => entry.name === "PullRequest.Reviews")?.as).toContain("Required");
    expect(entries.find((entry) => entry.name === "Git.Push")?.as).toBe(undefined);
  });

  it("ORC1: a repository component of the same name shadows the default", function* () {
    yield* useWorkspace(
      {
        "Worktree.md": [
          "---",
          "description: the repository's own Worktree",
          "---",
          "",
          "shadowed",
          "",
        ].join("\n"),
      },
      function* (dir) {
        const catalog = yield* syntaxCatalog([dir]);
        const provided = catalog.categories[2].entries.find((entry) => entry.name === "Worktree");
        expect(provided).toBeDefined();
        expect(names(catalog.categories[1].entries)).not.toContain("Worktree");
      },
    );
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

  it("SX8b: an ordinary run observes its own profile and includes, and agrees with the command", function* () {
    yield* useWorkspace(
      {
        "components/Local.md": "---\ndescription: the first description.\n---\n\nlocal\n",
        "catalog.md": "<Syntax />\n",
      },
      function* (cwd) {
        // The same site, asked two ways: the command that describes an
        // environment, and a document running in it. A run that derived its
        // catalog from anything but its own captured inputs would disagree.
        const described = yield* runCli(["syntax"], { cwd }).expect();
        const observed = yield* runCli(["run", "catalog.md"], { cwd }).expect();
        expect(observed.stdout.trim()).toBe(described.stdout.trim());
        expect(observed.stdout).toContain("### `<Local>`");
        expect(observed.stdout).toContain("the first description.");
        // And the run really is describing the run profile it has, not a
        // reduced one: `<Plan>` is declared to every ordinary run.
        expect(observed.stdout).toContain("### `<Plan>`");

        // A fresh occurrence sees a moved environment. Nothing is cached across
        // executions, and the catalog is the working tree's rather than the
        // build's.
        yield* writeTextFile(
          join(cwd, "components/Local.md"),
          "---\ndescription: the second description.\n---\n\nlocal\n",
        );
        const again = yield* runCli(["run", "catalog.md"], { cwd }).expect();
        expect(again.stdout).toContain("the second description.");
        expect(again.stdout).not.toContain("the first description.");
      },
    );
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

  it("SX11: the catalog is inspection, and plan is the command that writes with it", function* () {
    const { stdout } = yield* runCli(["--help"]).expect();

    expect(stdout).toContain("syntax");
    // `xmd plan` is the other reader of this catalog: it feeds the same
    // structured value to a generator rather than spawning this command and
    // parsing what it printed.
    expect(stdout).toMatch(/^\s+plan\s/m);
  });
});

/**
 * Tier SX — what a pipe receives.
 *
 * These rows shell out to a real pipeline rather than capturing a stream this
 * process owns, because the subject is the boundary itself: an operating-system
 * pipe holds about 64 KiB, and a catalog handed to a fire-and-forget
 * `process.stdout.write()` ends mid-token there while the same invocation
 * redirected to a file is whole. Nothing smaller than an oversize catalog
 * through an actual pipe tells the two apart.
 *
 * The two completeness rows are answered by Node and Bun, where that write
 * truncates at 80 and 64 KiB. Deno's own `process.stdout` flushes a pipe on the
 * way out, so it cannot distinguish them — a change verified under Deno alone
 * has not been verified. The closing-consumer row fails under all three.
 */
describe(
  "Tier SX — the catalog a pipe receives",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("SX13: the Markdown form arrives whole, and equals a file redirect", function* () {
      yield* useWorkspace(OVERSIZE, function* (cwd) {
        const { redirected, piped } = yield* deliveries([], cwd);

        expect(piped).toBe(redirected);
        expect(piped.lastIndexOf("### `<ZBeyondTheBuffer>`")).toBeGreaterThan(PIPE_BUFFER);
      });
    });

    it("SX14: the JSON form arrives whole, parses, and equals a file redirect", function* () {
      yield* useWorkspace(OVERSIZE, function* (cwd) {
        const { redirected, piped } = yield* deliveries(["--json"], cwd);

        expect(piped).toBe(redirected);
        const catalog = parseCatalog(piped);
        expect(catalog.version).toBe(1);
        expect(names(catalog.categories[2].entries)).toContain("ZBeyondTheBuffer");
        expect(piped.lastIndexOf(`"ZBeyondTheBuffer"`)).toBeGreaterThan(PIPE_BUFFER);
      });
    });

    it("SX15: a consumer that closes early fails the command", function* () {
      yield* useWorkspace(OVERSIZE, function* (cwd) {
        // A pipeline reports its last stage's status, so the command's own
        // travels on stderr, which the closing consumer never held.
        const { stdout, stderr } = yield* runShell(
          `{ ${cliShellCommand(["syntax", "--json"])}; echo "xmd-exit=$?" >&2; } | head -c 100`,
          { cwd },
        ).join();

        expect(stdout.length).toBe(100);
        expect(stderr).toContain("xmd-exit=1");
        expect(stderr).toContain("stdout did not accept the whole catalog");
        // The broken pipe is reported, not raised: an unhandled write failure
        // ends the process with one of these instead.
        expect(stderr).not.toContain("Unhandled 'error' event");
        expect(stderr).not.toContain("Uncaught");
      });
    });
  },
);

/** What an operating-system pipe holds before a writer has to wait. */
const PIPE_BUFFER = 64 * 1024;

/**
 * A workspace whose catalog is past that buffer in both forms.
 *
 * The built-ins alone render about 89 KiB of JSON but only about 63 KiB of
 * Markdown, so the padding is what puts the *default* form past the boundary
 * too. `ZBeyondTheBuffer` sorts after every filler, which is how a row names
 * bytes that a truncated delivery could not contain.
 */
const OVERSIZE: Record<string, string> = {
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_unused, index) => [
      `components/Filler${index}.md`,
      described(`filler ${index} ${"padding ".repeat(220)}`),
    ]),
  ),
  "components/ZBeyondTheBuffer.md": described("the entry past the pipe buffer."),
};

function described(description: string): string {
  return `---\ndescription: ${description}\n---\n\nbody\n`;
}

/**
 * A reader that takes one line at a time, so the writer blocks on a full pipe
 * long before the catalog ends. It reproduces its input byte for byte: both
 * renderers end every line, `IFS=` keeps the surrounding whitespace, and `-r`
 * keeps the backslashes.
 */
const SLOW_READER = `while IFS= read -r line; do printf '%s\\n' "$line"; done`;

/** The same invocation delivered twice: to a regular file, and through a pipe. */
function* deliveries(
  form: string[],
  cwd: string,
): Operation<{ redirected: string; piped: string }> {
  const command = cliShellCommand(["syntax", ...form]);
  const direct = join(cwd, "direct.out");
  const through = join(cwd, "piped.out");

  yield* runShell(`${command} > ${shellQuote(direct)}`, { cwd }).expect();
  const redirected = yield* readTextFile(direct);
  // Without this the comparison proves nothing: a catalog that fits in one
  // pipe buffer arrives whole however it was written.
  expect(redirected.length).toBeGreaterThan(PIPE_BUFFER);

  yield* runShell(`${command} | (${SLOW_READER}) > ${shellQuote(through)}`, { cwd }).expect();
  return { redirected, piped: yield* readTextFile(through) };
}
