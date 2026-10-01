/**
 * The REPL's source boundaries (#848 S1).
 *
 * Read from the source rather than from behaviour, because these are claims about
 * what a module *can* reach. A component that never happens to touch the Journal
 * in one test is not a component that cannot; an import is.
 *
 * Scoped deliberately. Vendored Freedom is somebody else's code under a recorded
 * provenance, fixtures model bad input on purpose, and generated output is not
 * authored — none of them is a production violation, and a scan broad enough to
 * catch them would be a scan nobody could keep green.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, ensure, type Operation, scoped, until } from "effection";

import { useHostFiles } from "@executablemd/runtime";
import { runXmd } from "../src/cli.ts";
import { unsupportedRepositories } from "../src/run-repositories.ts";
import { unsupportedWorkflowHost } from "../src/workflow.ts";
import type { UpgradeAssembly } from "../src/upgrade.ts";
import { refusedStandardInput } from "./support/standard-input.ts";
import { refusedPluginModules } from "./support/plugin-modules.ts";

import { replGrammarError } from "../src/cli.ts";
import { readQuestionForm } from "../src/repl/elicitation.ts";
import { decodeLocation, encodeLocation } from "../src/repl/route.ts";
import { entryKey } from "../src/repl/entries.ts";

const CLI = fileURLToPath(new URL("../", import.meta.url));
const REPL = join(CLI, "src", "repl");

/** Every authored production source under the REPL, by path. */
function* authored(): Operation<string[]> {
  const found: string[] = [];
  const walk = function* (directory: string): Operation<void> {
    for (const entry of yield* until(readdir(directory, { withFileTypes: true }))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Vendored code is not authored here, and its provenance is recorded in
        // its own manifest rather than asserted by this checker.
        if (entry.name === "vendor") {
          continue;
        }
        yield* walk(path);
        continue;
      }
      if (entry.name.endsWith(".ts")) {
        found.push(path);
      }
    }
  };
  yield* walk(REPL);
  return found.sort();
}

/** One file's text. */
function read(path: string): Operation<string> {
  return readTextFile(path);
}

/**
 * One file's code, without its prose.
 *
 * A module that *says* it holds no `DurableEvent` contains the word, and a
 * checker reading the comment would fail the file for documenting the rule it
 * follows. Classification has to be about what the source does.
 */
function* code(path: string): Operation<string> {
  const text = yield* read(path);
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
}

/** The runtime globals and environment reads no shared module may reach. */
const RUNTIME_ACCESS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "the Deno global", pattern: /(^|[^.\w])Deno\s*\./ },
  { name: "the Bun global", pattern: /(^|[^.\w])Bun\s*\./ },
  { name: "node:process", pattern: /from "node:process"/ },
  { name: "process.env", pattern: /process\s*\.\s*env/ },
  { name: "process.platform", pattern: /process\s*\.\s*platform/ },
  { name: "node:os", pattern: /from "node:os"/ },
  { name: "a synchronous filesystem call", pattern: /from "node:fs"/ },
];

/** Dependencies this slice's production code may not have acquired. */
const REJECTED: readonly string[] = [
  "starfx",
  "@bomb.sh/input",
  "path-to-regexp",
  "crank",
  "revolution",
];

describe("REPL boundaries: what production code cannot reach", () => {
  it("S1: no shared REPL module reaches a runtime global or the environment", function* () {
    const offences: string[] = [];
    for (const path of yield* authored()) {
      const text = yield* code(path);
      for (const { name, pattern } of RUNTIME_ACCESS) {
        if (pattern.test(text)) {
          offences.push(`${path.slice(CLI.length)} reaches ${name}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("S1: the checker reads code and not prose", function* () {
    // A module documenting the rule it follows names the thing it does not hold.
    const prose =
      "/** No component holds a DurableEvent or a ReplSession. */\nexport const x = 1;\n";
    expect(prose.includes("DurableEvent")).toBe(true);
    const stripped = prose
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");
    expect(stripped.includes("DurableEvent")).toBe(false);
    // And it still sees the import it is there to catch.
    const real =
      '// a comment\nimport type { DurableEvent } from "@executablemd/durable-streams";\n';
    const keeps = real
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");
    expect(keeps.includes("DurableEvent")).toBe(true);
  });

  it("S1: the checker rejects a module that reaches one", function* () {
    // The same patterns against text that deliberately contains them, so a
    // checker that matched nothing could not pass by being vacuous.
    const seeded = [
      "const size = Deno.consoleSize();",
      'import process from "node:process";',
      'const home = process.env["HOME"];',
      'if (process.platform === "darwin") {}',
      'import { homedir } from "node:os";',
      'import { readFileSync } from "node:fs";',
      'const there = Bun.file("x");',
    ];
    for (const line of seeded) {
      const matched = RUNTIME_ACCESS.some(({ pattern }) => pattern.test(line));
      expect(matched).toBe(true);
    }
    // And it does not reject the forms that are fine.
    for (const line of [
      'import { readTextFile } from "@effectionx/fs";',
      'import { appendFile } from "node:fs/promises";',
      "const processed = { env: 1 };",
    ]) {
      expect(RUNTIME_ACCESS.some(({ pattern }) => pattern.test(line))).toBe(false);
    }
  });

  it("S1: application components import no journal, session or host authority", function* () {
    const forbidden = [
      "durable-streams",
      "./journal.ts",
      "./session.ts",
      "./storage.ts",
      "./host.ts",
      "./program.ts",
      "@effectionx/fs",
    ];
    const directory = join(REPL, "components");
    for (const entry of yield* until(readdir(directory))) {
      if (!entry.endsWith(".ts")) {
        continue;
      }
      const text = yield* code(join(directory, entry));
      for (const name of forbidden) {
        expect(text.includes(`from "${name}"`)).toBe(false);
      }
      // A component receives view data and answers with an action. Nothing else.
      expect(text.includes("DurableEvent")).toBe(false);
      expect(text.includes("ReplSession")).toBe(false);
    }
  });

  it("S1: the terminal, decoder and renderer know no application action name", function* () {
    // The host says what happened and where. What it means is decided above it,
    // so the names of this product's actions cannot appear down here.
    const actions = [
      "select-surface",
      "select-scope",
      "open-drawer",
      "select-marker",
      "go-live",
      "insert",
    ];
    for (const module of [
      "terminal.ts",
      "terminal-host.ts",
      "input.ts",
      "renderer.ts",
      "layout.ts",
    ]) {
      const text = yield* code(join(REPL, module));
      for (const action of actions) {
        expect(text.includes(`"${action}"`)).toBe(false);
      }
    }
  });

  it("S1: runtime-specific access lives only in runtime-named modules", function* () {
    // The four adapters are the only files that may name a runtime, and each one
    // names its own.
    for (const [file, mentions] of [
      ["deno-repl.ts", ["node:os", "node:process"]],
      ["node-repl.ts", ["node:os", "node:process"]],
      ["bun-repl.ts", ["node:os", "node:process"]],
      ["compiled-repl.ts", ["node:os", "node:process"]],
    ] as const) {
      const text = yield* code(join(CLI, "src", file));
      for (const mention of mentions) {
        expect(text.includes(mention)).toBe(true);
      }
    }
    // And the portable installer names none of them.
    const portable = yield* code(join(CLI, "src", "repl-assembly.ts"));
    for (const { pattern } of RUNTIME_ACCESS) {
      expect(pattern.test(portable)).toBe(false);
    }
  });

  it("S1: no rejected dependency entered production", function* () {
    const manifest = yield* read(join(CLI, "deno.json"));
    const packaged = yield* read(join(CLI, "package.json"));
    for (const rejected of REJECTED) {
      expect(manifest.includes(rejected)).toBe(false);
      expect(packaged.includes(rejected)).toBe(false);
    }
    // The one dependency this stack did add, at the exact version it pinned.
    expect(manifest).toContain('"@bomb.sh/tty": "npm:@bomb.sh/tty@0.9.0"');
    expect(packaged).toContain('"@bomb.sh/tty": "0.9.0"');
  });

  it("S1: no production REPL module retains a provider's raw request", function* () {
    // `rawInput` is whatever an agent handed the adapter. The surface shows a
    // request's title and the options it offered; keeping the raw payload would
    // put an agent's own text into this process's state and into a frame.
    for (const path of yield* authored()) {
      const text = yield* code(path);
      expect([path.slice(CLI.length), text.includes("rawInput")]).toEqual([
        path.slice(CLI.length),
        false,
      ]);
    }
  });

  it("S1: the profile installs no readline policy, no launcher and no browser form", function* () {
    const text = yield* code(join(CLI, "src", "repl-profile.ts"));
    // The REPL's policy is the session's own, and it owns the terminal it is
    // drawing on. Each of these is the `xmd run` half this command must not
    // inherit, and the check is the source rather than a behaviour, because what
    // is claimed is that it cannot reach them.
    for (const forbidden of [
      "installRunAgentStack",
      "installPermissionMode",
      "installForegroundLauncher",
      "installWebElicitation",
      "readline",
    ]) {
      expect([forbidden, text.includes(forbidden)]).toEqual([forbidden, false]);
    }
    // And it does install the two halves it owns.
    expect(text).toContain("installAgentProviderStack");
    expect(text).toContain("planComponentDeclaration");
  });

  it("S1: the profile check rejects a profile that installed one", function* () {
    // The same scan against text that deliberately reaches for the launcher, so
    // a green row above cannot be green by matching nothing.
    const seeded = [
      "// a comment mentioning installForegroundLauncher, which is prose",
      'import { installForegroundLauncher } from "@executablemd/runtime";',
      "export function* assemble() {",
      "  yield* installForegroundLauncher();",
      "}",
    ].join("\n");
    const stripped = seeded
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");
    expect(stripped.includes("installForegroundLauncher")).toBe(true);
  });

  it("S1: no REPL record type exists in production", function* () {
    // Every retained line is an ordinary durable event. A record shape of this
    // slice's own would be a second protocol nobody else can read.
    for (const path of yield* authored()) {
      const text = yield* code(path);
      expect(text.includes('type: "repl')).toBe(false);
      expect(text.includes("REPL_RECORD")).toBe(false);
    }
  });
});

describe("REPL documentation: what it says is what the code does", () => {
  it("D1: every command example in the spec is one the parser accepts", function* () {
    const spec = yield* read(join(CLI, "..", "..", "specs", "repl-spec.md"));
    const commands = [...spec.matchAll(/^xmd repl(.*)$/gm)].map((match) => match[1].trim());
    expect(commands.length).toBeGreaterThan(0);

    for (const rest of commands) {
      // Stripped of the shell's quoting and of the comment beside it, which is
      // prose rather than argv. What is left is read the way the command line
      // is: option tokens are options, and at most one other token is the
      // location.
      const tokens = rest
        .replace(/#.*$/, "")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .map((token) => token.replace(/^'(.*)'$/, "$1"));
      const positional = tokens.filter((token) => !token.startsWith("-"));
      expect([rest, positional.length]).toEqual([rest, Math.min(positional.length, 1)]);
      // A placeholder is not a location; what is being checked is the shape.
      const concrete = positional[0]?.replace("<execution>", "kf39sla2");
      const args = ["repl", ...tokens.map((token) => token.replace("<execution>", "kf39sla2"))];
      expect([rest, replGrammarError(args, concrete)]).toEqual([rest, undefined]);
    }
  });

  it("D1: the five options the spec names are the five the parser accepts", function* () {
    const spec = yield* read(join(CLI, "..", "..", "specs", "repl-spec.md"));
    // Every option the specification names, from its own prose.
    const named = [...spec.matchAll(/`(--[a-z-]+)`/g)].map((match) => match[1]);
    expect([...new Set(named)].sort()).toEqual([
      "--agent-provider",
      "--approve-all",
      "--approve-reads",
      "--default-agent",
      "--deny-all",
    ]);

    // Each is one the parser accepts, in both spellings a value option has.
    for (const option of ["--approve-all", "--approve-reads", "--deny-all"]) {
      expect([option, replGrammarError(["repl", option], undefined)]).toEqual([option, undefined]);
      expect(replGrammarError(["repl", `${option}=yes`], undefined)).toContain("takes no value");
    }
    for (const option of ["--agent-provider", "--default-agent"]) {
      expect([option, replGrammarError(["repl", option, "acpx"], undefined)]).toEqual([
        option,
        undefined,
      ]);
      expect([option, replGrammarError(["repl", `${option}=acpx`], undefined)]).toEqual([
        option,
        undefined,
      ]);
      expect(replGrammarError(["repl", option], undefined)).toContain("requires a value");
    }

    // And there is no sixth: an option the specification does not name is
    // refused by the name it was written as.
    expect(replGrammarError(["repl", "--include", "x"], undefined)).toContain(
      "unrecognized option for xmd repl: --include",
    );
  });

  it("D1: the spec's route grammar is the one the codec implements", function* () {
    const spec = yield* read(join(CLI, "..", "..", "specs", "repl-spec.md"));
    const written = /xmd:\/\/repl\/<execution>\/repl/;
    expect(written.test(spec)).toBe(true);

    // The same shape, through the real codec.
    const encoded = encodeLocation({
      execution: "kf39sla2",
      surface: "repl",
      scopes: [],
      drawers: [],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
    });
    expect(encoded).toBe("xmd://repl/kf39sla2/repl");
    const decoded = decodeLocation(encoded);
    expect(decoded.ok).toBe(true);
  });

  it("D1: the spec's sequential-entry claims are the ones the code makes", function* () {
    const spec = yield* read(join(CLI, "..", "..", "specs", "repl-spec.md"));

    // The one-entry ceiling is gone from the product, so it must be gone from
    // the document that describes the product.
    expect(spec).not.toContain("this execution admits one");
    expect(spec).not.toContain("zero or one entry");
    expect(spec).not.toContain("There is no second entry");

    // The keys the spec numbers entries by are the ones the code assigns.
    expect(spec).toContain("`entry-1`, `entry-2`");
    expect([entryKey(1), entryKey(2), entryKey(3)]).toEqual(["entry-1", "entry-2", "entry-3"]);

    // The spec says a location names a selected entry on either surface, and
    // the codec spells exactly that.
    expect(spec).toContain("a location names a selected entry on either surface");
    for (const surface of ["repl", "sessions"] as const) {
      const location = encodeLocation({
        execution: "kf39sla2",
        surface,
        scopes: [entryKey(2)],
        drawers: [],
        at: undefined,
        inspect: false,
        draft: "the next one",
        session: undefined,
      });
      expect(location).toBe(`xmd://repl/kf39sla2/${surface}/entry-2?draft=the%20next%20one`);
      const read = decodeLocation(location);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.value.scopes).toEqual(["entry-2"]);
        expect(read.value.draft).toBe("the next one");
      }
    }

    // And the four outcomes the catalog promises are the four words it writes.
    for (const outcome of ["[unfinished]", "[ok]", "[err]", "[cancelled]"]) {
      expect([outcome, spec.includes(outcome)]).toEqual([outcome, true]);
    }
  });

  it("D1: a drifted example is caught", function* () {
    // The same two checks against text that is wrong on purpose, so a checker
    // that matched nothing could not pass by being vacuous.
    expect(replGrammarError(["repl", "one", "two"], undefined)).toBeDefined();
    expect(replGrammarError(["repl", "--json"], undefined)).toBeDefined();
    expect(replGrammarError(["repl", "xmd://repl/"], "xmd://repl/")).toBeDefined();
    // And a grammar the codec does not produce.
    expect(
      encodeLocation({
        execution: "kf39sla2",
        surface: "repl",
        scopes: [],
        drawers: [],
        at: undefined,
        inspect: false,
        draft: undefined,
        session: undefined,
      }),
    ).not.toBe("xmd://repl/kf39sla2/entries");
  });

  it("D1: the spec's Elicit metadata statement matches the real reader", function* () {
    const spec = yield* read(join(CLI, "..", "..", "specs", "repl-spec.md"));
    // The spec says the drawer shows every field the schema declares, with its
    // annotations, whether it is required, and the values it will accept. The
    // reader is what decides all of that.
    expect(spec).toContain("every field the schema declares");
    const form = readQuestionForm({
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["approve", "decline"],
          title: "Decision",
          description: "What to do with the draft",
        },
      },
      required: ["decision"],
      additionalProperties: false,
    });
    // The complete reading, member for member: a form that dropped an
    // annotation, a required marker or the condition would be a drawer showing
    // less than the spec says it shows.
    expect(form).toEqual({
      title: undefined,
      description: undefined,
      condition: undefined,
      fields: [
        {
          name: "decision",
          title: "Decision",
          description: "What to do with the draft",
          choices: ["approve", "decline"],
          minLength: undefined,
          required: true,
        },
      ],
    });
    // And a schema this language does not model is refused by name and path
    // before anything is published, which is why the spec describes the fields
    // a schema declares rather than any schema at all.
    let refused: unknown;
    try {
      readQuestionForm({ type: "string" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.name : "").toBe("ElicitationProviderError");
    expect(refused instanceof Error ? refused.message : "").toContain("$.type");
  });

  it("D1: Freedom's recorded provenance still matches its manifest", function* () {
    const manifest: unknown = JSON.parse(
      yield* read(join(REPL, "vendor", "freedom", "MANIFEST.json")),
    );
    const provenance = yield* read(join(REPL, "vendor", "freedom", "PROVENANCE.md"));
    expect(typeof manifest).toBe("object");
    if (typeof manifest !== "object" || manifest === null || !("commit" in manifest)) {
      throw new Error("the vendor manifest records the commit it was taken from");
    }
    const commit = manifest.commit;
    expect(typeof commit).toBe("string");
    // The provenance document names the same revision the manifest pins.
    expect(provenance).toContain(String(commit));

    // A drifted hash is caught: the same comparison against a revision the
    // manifest does not name.
    expect(provenance.includes("0000000000000000000000000000000000000000")).toBe(false);
  });
});

/**
 * The exit continuation `exit()` reaches for.
 *
 * `main()` installs one under this name; a suite driving `runXmd` directly
 * installs its own, so a command's status is a value rather than this process
 * ending.
 */
const ExitContext = createContext<(result: { status: number }) => Operation<void>>("exit");

/** What one in-process `xmd` invocation did, and whether it reached the REPL. */
interface Invocation {
  readonly status: number;
  /** How many times the host's REPL assembly was entered. */
  readonly installed: number;
}

/**
 * Drive `runXmd` in this process with a REPL installer that counts.
 *
 * The lifecycle claim is not about what the output says: it is that describing a
 * command and refusing one never reach the host at all — no per-user directory,
 * no history file, no terminal mode. An installer that is never entered is the
 * only way to see that from outside.
 */
function* invoke(args: readonly string[]): Operation<Invocation> {
  let status = 0;
  let installed = 0;
  const wrote = console.log;
  const warned = console.error;
  return yield* scoped(function* (): Operation<Invocation> {
    yield* ensure(() => {
      console.log = wrote;
      console.error = warned;
    });
    console.log = () => {};
    console.error = () => {};
    yield* ExitContext.set(function* (result) {
      status = result.status;
    });
    yield* useHostFiles();
    try {
      yield* runXmd(
        [...args],
        function* () {},
        UPGRADE,
        unsupportedRepositories,
        refusedStandardInput,
        refusedPluginModules,
        unsupportedWorkflowHost,
        undefined,
        function* (): Operation<void> {
          installed += 1;
        },
      );
    } catch {
      // This host assembles no terminal and no data directory, so a command line
      // that really runs fails once it asks for one. What is being counted is
      // whether it got that far, so the failure is an outcome rather than an end.
      status = 1;
    }
    return { status, installed };
  });
}

/** What this host says it is. Nothing here upgrades anything. */
const UPGRADE: UpgradeAssembly = {
  provenance: "deno-source",
  currentVersion: "0.0.0-test",
  executablePath: "/nonexistent",
  platform: "darwin",
  architecture: "arm64",
};

describe("REPL command: what runs before the host is reached", () => {
  it("S1: help describes the command without assembling a REPL", function* () {
    for (const args of [["--help"], ["repl", "--help"]]) {
      const ran = yield* invoke(args);
      expect(ran.status).toBe(0);
      // Describing a command is not running one.
      expect(ran.installed).toBe(0);
    }
  });

  it("S1: every refusal is decided before the host is asked for anything", function* () {
    for (const args of [
      ["repl", "one", "two"],
      ["repl", "--json"],
      ["repl", "xmd://nope"],
    ]) {
      const ran = yield* invoke(args);
      expect(ran.status).toBe(1);
      // No data directory, no history file, no terminal: the command line was
      // answered before any of them could be reached for.
      expect(ran.installed).toBe(0);
    }
  });

  it("S1: the counter is entered when the command really runs", function* () {
    // The same harness against a command line that is *not* refused, so a counter
    // that could never increment cannot pass the two rows above. This host
    // assembles nothing, so the command fails once it asks for a data directory —
    // which is the point: it got that far.
    const ran = yield* invoke(["repl"]);
    expect(ran.installed).toBe(1);
  });
});
