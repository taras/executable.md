import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createApi } from "@effectionx/context-api";
import { readTextFile } from "@effectionx/fs";
import { glob } from "@executablemd/runtime";
import ts from "typescript";
import { type Operation, scoped } from "effection";
import {
  establishJournalProvenance,
  durableCall,
  durableRun,
  InMemoryStream,
  type DurableEvent,
  type Json,
  type Result,
  type Workflow,
} from "@executablemd/durable-streams";
import { createDurableWorkspaceOperation, WorkspaceCoordinationProviderError } from "../mod.ts";
import {
  type WorkspaceCoordinationAuthority,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationProvider,
} from "../src/workspace/effect.ts";

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

function yieldEvents(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield");
}

function* workspaceStep(name: string, execute: () => Operation<Json>): Workflow<void> {
  yield createDurableWorkspaceOperation({ type: "workspace", name }, execute);
}

interface InvocationCollisionApi {
  coordinate(request: unknown): Operation<unknown>;
}

const WorkspaceInvocationCollision = createApi<InvocationCollisionApi>(
  "executablemd.workflow.workspace.coordination.invocation",
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<unknown> {
      throw new Error("the collision handler did not delegate");
    },
  },
);

function successfulProvider(observe?: (authority: WorkspaceCoordinationAuthority) => void): {
  provider: WorkspaceCoordinationProvider;
  counts: { providers: number; executions: number; publications: number };
} {
  const counts = { providers: 0, executions: 0, publications: 0 };
  return {
    counts,
    provider: {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        counts.providers += 1;
        observe?.(authority);
        const value = yield* authority.execute();
        counts.executions += 1;
        const result: Result = { status: "ok", value };
        yield* authority.publish(result);
        counts.publications += 1;
        return result;
      },
    },
  };
}

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Storage and adapter type names that mean a host reached this surface.
 *
 * Distinctive enough to be read as text. Runtime globals are not here — `Bun`
 * is inside `Bundle` and `Deno` inside `Denominator`, so those are recognized
 * as identifiers instead.
 */
const FORBIDDEN = [
  "DatabaseSync",
  "SQLite",
  "sqlite",
  "Cloudflare",
  "DOFS",
  "dofs",
  "savepoint",
  "Savepoint",
  "SAVEPOINT",
  "RunConnection",
  "WorkflowRunConnections",
  "WorkflowRunTransactionToken",
  "ConnectionGeneration",
  "TransactionIdentity",
];

/**
 * The names this repository gives a runtime-specific entry point.
 *
 * Code Rule 12 puts host behavior behind runtime-named modules —
 * `packages/cli/src/{deno,node,bun,compiled}.ts` are the CLI's — so the name of
 * the module is what says a host owns it. `deno` is not the only one, and an
 * adapter rule that knows only `deno` is a rule about the adapter someone
 * happened to write first.
 */
const RUNTIMES = ["deno", "node", "bun", "compiled", "cloudflare", "workerd"];

/**
 * Globals only one host provides.
 *
 * `crypto`, `TextEncoder` and the rest of the cross-runtime Web surface are
 * not here: naming a standard is not naming a host.
 */
const HOST_GLOBALS = [
  "process",
  "Deno",
  "Bun",
  "Buffer",
  "globalThis",
  "navigator",
  "__dirname",
  "__filename",
];

/**
 * A module specifier only one host can resolve.
 *
 * Named by shape rather than one at a time: a list of the host modules anyone
 * thought of is a list of the ones that had already been noticed, and the
 * import that crosses this boundary next is the one nobody wrote down.
 *
 * Segments are compared whole. `nodes/`, `bundle.ts` and `vendors/` contain a
 * runtime's name without being one, and rejecting them would make the rule
 * about spelling rather than about hosts.
 */
function hostModule(specifier: string): boolean {
  if (/^(node|bun|deno|cloudflare|workerd):/.test(specifier)) {
    return true;
  }
  if (specifier === "@effectionx/process") {
    return true;
  }
  const segments = specifier.split("/");
  const last = segments[segments.length - 1].replace(/\.[cm]?[jt]sx?$/, "");
  return (
    segments.includes("vendor") ||
    segments.some((segment) => RUNTIMES.includes(segment)) ||
    RUNTIMES.includes(last)
  );
}

/**
 * Source with its comments removed.
 *
 * These modules describe in prose that they name no host, and a search of the
 * whole file would find that description rather than a boundary crossing.
 */
function code(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const following = source[index + 1];
    if (character === "/" && following === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && following === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      output += character;
      index += 1;
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") {
          output += source[index];
          index += 1;
        }
        output += source[index];
        index += 1;
      }
      output += character;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * What a module this file loads cannot be shown to be.
 *
 * A specifier the file computes names whatever it is handed, so no inspection
 * of this surface can say it is not a host module. It is refused rather than
 * skipped: a boundary that admits what it cannot read is not a boundary.
 */
const COMPUTED = "a computed module specifier";

/**
 * Every module this source loads, read from the syntax rather than the text.
 *
 * Parsed, because module loading is not a pattern: a specifier can be a
 * template literal, can escape its own characters, can be an expression, and
 * the same characters can appear in a string that loads nothing. Each of those
 * is a different answer, and only a parse tells them apart.
 */
function moduleSpecifiers(file: ts.SourceFile): string[] {
  const found: string[] = [];

  function record(node: ts.Node | undefined): void {
    if (
      node !== undefined &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      // The parser has already decoded escapes, so `node:crypto` and
      // `node:crypto` arrive here as the same specifier.
      found.push(node.text);
      return;
    }
    found.push(COMPUTED);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        record(node.moduleSpecifier);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      record(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return found;
}

/**
 * The scanned source, and a checker that knows what its names mean.
 *
 * `noLib` and `noResolve` are the point rather than an economy: nothing
 * outside this file is loaded, so a name resolves only to what the file itself
 * declares. Anything left unresolved is ambient — supplied by a host at
 * runtime — which is exactly the question being asked.
 */
function parse(source: string): { file: ts.SourceFile; checker: ts.TypeChecker } {
  const path = "/scanned.ts";
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const program = ts.createProgram({
    rootNames: [path],
    options: { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest },
    host: {
      getSourceFile: (name) => (name === path ? file : undefined),
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => "/",
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name) => name === path,
      readFile: (name) => (name === path ? source : undefined),
    },
  });
  return { file, checker: program.getTypeChecker() };
}

/**
 * The slots in which the grammar writes a name rather than a reference.
 *
 * TypeScript spells the distinction structurally: an `IdentifierName` fills a
 * `name`, `propertyName` or `label` slot of the node that owns it, and a
 * qualified name's `right` is the same thing in type position. Everywhere else
 * an identifier is an `IdentifierReference`.
 */
const LABEL_SLOTS = ["name", "propertyName", "label"];

/**
 * Whether this identifier refers to a binding at all.
 *
 * Not a scope question — the checker answers those. This asks the grammar
 * instead of listing the node kinds someone remembered: the member in
 * `x.process`, the label in `break process`, the imported member in
 * `{ Deno as portable }`, the key in `{ process: local }`, a named tuple
 * element, an import attribute and every declaration's own name all fill a
 * name slot, and none of them reads the name it spells.
 *
 * A shorthand property is the one name slot that is also a read, because
 * `{ process }` declares a property and reads a binding with one identifier.
 */
function refers(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) {
    return true;
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return false;
  }
  return !LABEL_SLOTS.some((slot) => Reflect.get(parent, slot) === node);
}

/**
 * Host globals this source actually reads.
 *
 * A name is the host's only when nothing in this file declares it, and the
 * checker is what knows that. Value scopes and type scopes, `var` hoisting,
 * `import =`, `namespace`, mapped-type and `infer` type parameters, accessors
 * and shadowing are the language's rules, not a list kept here — every one of
 * them was a false positive while this was a list.
 */
function hostGlobals(parsed: { file: ts.SourceFile; checker: ts.TypeChecker }): string[] {
  const found: string[] = [];

  /**
   * The binding this identifier reads.
   *
   * `{ process }` writes one name in two roles: the property the literal
   * declares and the value it reads. The ordinary symbol is the property — it
   * is declared right there, so asking for it would answer that every host
   * global is locally declared the moment it is put in an object. The value
   * symbol is the one the shorthand refers to.
   */
  function binding(node: ts.Identifier): ts.Symbol | undefined {
    const parent = node.parent;
    if (parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      return parsed.checker.getShorthandAssignmentValueSymbol(parent);
    }
    return parsed.checker.getSymbolAtLocation(node);
  }

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && HOST_GLOBALS.includes(node.text) && refers(node)) {
      const declared = (binding(node)?.declarations ?? []).some(
        (declaration) => declaration.getSourceFile() === parsed.file,
      );
      if (!declared && !found.includes(node.text)) {
        found.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed.file);
  return found;
}

function forbiddenNames(source: string): string[] {
  const parsed = parse(source);
  const scanned = code(source);
  const crossings = FORBIDDEN.filter((name) => scanned.includes(name));
  for (const global of hostGlobals(parsed)) {
    if (!crossings.includes(global)) {
      crossings.push(global);
    }
  }
  for (const specifier of moduleSpecifiers(parsed.file)) {
    const refused = specifier === COMPUTED || hostModule(specifier);
    if (refused && !crossings.includes(specifier)) {
      crossings.push(specifier);
    }
  }
  return crossings;
}

describe("Tier DLC — Workspace coordination selection", () => {
  it("DLC10: a missing Workspace provider fails before execution or publication", function* () {
    const stream = new InMemoryStream();
    let executions = 0;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("missing", function* () {
        executions += 1;
        return "not reached";
      });
    }

    const failure = yield* raised(durableRun(workflow, { stream }));
    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(executions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC11: explicit Workspace selection leaves unrelated durable operations ordinary", function* () {
    const stream = new InMemoryStream();
    const journalProvenance = establishJournalProvenance(stream);
    const coordinated: string[] = [];
    const ordinary: string[] = [];
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        expect(authority.journalProvenance).toBe(journalProvenance);
        expect(Reflect.get(authority.journalProvenance ?? {}, "append")).toBe(undefined);
        expect(Reflect.get(authority.journalProvenance ?? {}, "readAll")).toBe(undefined);
        coordinated.push("workspace");
        const result: Result = { status: "ok", value: yield* authority.execute() };
        yield* authority.publish(result);
        return result;
      },
    };

    function* workflow(): Workflow<string> {
      yield* workspaceStep("selected", function* () {
        return "workspace";
      });
      yield* durableCall("ordinary", function* () {
        ordinary.push("ordinary");
        return "ordinary";
      });
      return "done";
    }

    expect(
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
    ).toBe("done");
    expect(coordinated).toEqual(["workspace"]);
    expect(ordinary).toEqual(["ordinary"]);
    expect(yieldEvents(stream.snapshot())).toHaveLength(2);
  });

  it("DLC12: replayed Workspace operations never require a live provider", function* () {
    const stream = new InMemoryStream([
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "workspace", name: "replayed" },
        result: { status: "ok", value: "stored" },
      },
    ]);
    let executions = 0;
    function* workflow(): Workflow<string> {
      yield* workspaceStep("replayed", function* () {
        executions += 1;
        return "live";
      });
      return "done";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("done");
    expect(executions).toBe(0);
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC13: the whole shared coordination surface stays runtime-neutral", function* () {
    // The scanner has to be able to fail, and it has to read code rather than
    // prose: these modules explain in their own comments that they name no
    // host, and a substring search would find the explanation.
    expect(code(`const value = "DOFS"; // Cloudflare\n/* SQLite */`)).toBe(
      `const value = "DOFS"; \n`,
    );
    expect(forbiddenNames(`import { DatabaseSync } from "node:sqlite";`)).toEqual([
      "DatabaseSync",
      "sqlite",
      "node:sqlite",
    ]);
    expect(forbiddenNames("// the Deno adapter owns DOFS and its savepoints")).toEqual([]);

    // A host module is a crossing by its shape, not because someone listed it.
    // `node:crypto` names nothing else on this list, and shared source did
    // import it while an earlier version of this test reported a clean
    // boundary.
    expect(forbiddenNames(`import { randomUUID } from "node:crypto";`)).toEqual(["node:crypto"]);
    expect(forbiddenNames(`export { x } from "node:os";`)).toEqual(["node:os"]);
    expect(forbiddenNames(`import "../deno.ts";`)).toEqual(["../deno.ts"]);
    expect(forbiddenNames(`import type { X } from "node:fs";`)).toEqual(["node:fs"]);
    expect(forbiddenNames(`type X = import("node:fs").Stats;`)).toEqual(["node:fs"]);
    expect(forbiddenNames(`import fs = require("node:fs");`)).toEqual(["node:fs"]);
    expect(forbiddenNames(`const m = await import("bun:sqlite");`)).toEqual([
      "sqlite",
      "bun:sqlite",
    ]);

    // How the specifier is spelled is not how it is found: a template literal
    // and an escaped character load the same module as the plain string.
    expect(forbiddenNames("const m = await import(`node:crypto`);")).toEqual(["node:crypto"]);
    expect(forbiddenNames(`const m = await import("node\\u003acrypto");`)).toEqual(["node:crypto"]);

    // A destination this surface computes cannot be shown not to be a host
    // module, so it is refused rather than skipped.
    expect(forbiddenNames(`const target = "node:crypto";\nawait import(target);`)).toEqual([
      COMPUTED,
    ]);
    expect(forbiddenNames("await import(`${scheme}:crypto`);")).toEqual([COMPUTED]);

    // And text that only looks like module loading loads nothing.
    expect(forbiddenNames("// run ids used to come from node:crypto")).toEqual([]);
    expect(forbiddenNames(`const note = "node:crypto";`)).toEqual([]);
    expect(forbiddenNames('const note = `import "node:crypto"`;')).toEqual([]);
    expect(forbiddenNames(`const note = 'export { x } from "node:os"';`)).toEqual([]);
    expect(forbiddenNames(`const hint = 'import from "@executablemd/workflow/deno"';`)).toEqual([]);

    // A host global is a crossing wherever the module came from.
    expect(forbiddenNames("const pid = process.pid;")).toEqual(["process"]);
    expect(forbiddenNames("export const p = process;")).toEqual(["process"]);
    expect(forbiddenNames("const { env } = process;")).toEqual(["process"]);
    expect(forbiddenNames("const home = Deno.cwd();")).toEqual(["Deno"]);
    expect(forbiddenNames("const v = Bun.version;")).toEqual(["Bun"]);
    expect(forbiddenNames("const b = Buffer.from([]);")).toEqual(["Buffer"]);
    expect(forbiddenNames("const here = __dirname;")).toEqual(["__dirname"]);
    expect(forbiddenNames("type F = Deno.FsFile;")).toEqual(["Deno"]);

    // A name is the host's only when nothing declared it. A parameter, an
    // import and a local are all something else that happens to be spelled
    // the same way.
    expect(
      forbiddenNames("function inspect(process: { pid: number }) { return process.pid; }"),
    ).toEqual([]);
    expect(forbiddenNames("const Buffer = 1;\nconst b = Buffer;")).toEqual([]);
    expect(forbiddenNames(`import { Deno } from "./host.ts";\nconst c = Deno.cwd();`)).toEqual([]);
    expect(forbiddenNames(`import Buffer from "./bytes.ts";\nconst b = Buffer.from([]);`)).toEqual(
      [],
    );
    expect(forbiddenNames("const { process } = deps;\nconst pid = process.pid;")).toEqual([]);
    expect(forbiddenNames("try { run(); } catch (process) { report(process); }")).toEqual([]);
    expect(forbiddenNames("[1].forEach((process) => report(process));")).toEqual([]);

    // Binding semantics, not a list of node shapes. An aliased member is a
    // label on both sides, a type parameter binds its own scope, and `var`
    // belongs to the function however deeply it is nested.
    expect(forbiddenNames("const { process: local } = deps;")).toEqual([]);
    expect(forbiddenNames(`import { Deno as portable } from "./host.ts";`)).toEqual([]);
    expect(forbiddenNames(`export { process as runner } from "./host.ts";`)).toEqual([]);
    expect(forbiddenNames("function read<Deno>(value: Deno): Deno { return value; }")).toEqual([]);
    expect(forbiddenNames("interface Holder<Buffer> { value: Buffer }")).toEqual([]);
    expect(
      forbiddenNames(
        "function read() {\n  if (ready) var process = portable;\n  return process.pid;\n}",
      ),
    ).toEqual([]);
    expect(
      forbiddenNames(
        "function read() {\n  for (var Buffer of list) use(Buffer);\n  return Buffer;\n}",
      ),
    ).toEqual([]);

    // The language's own resolution, not a catalogue of declaration shapes:
    // `import =`, a namespace, a mapped-type parameter, an `infer` parameter,
    // a statement label and an accessor member each bind or label the name
    // without any rule about them being written here.
    expect(forbiddenNames(`import Deno = require("./portable.ts");\nDeno.cwd();`)).toEqual([]);
    expect(
      forbiddenNames('namespace Deno {\n  export const cwd = () => "";\n}\nDeno.cwd();'),
    ).toEqual([]);
    expect(forbiddenNames("type Rename<T> = { [process in keyof T]: T[process] };")).toEqual([]);
    expect(forbiddenNames("type Value<T> = T extends infer Buffer ? Buffer : never;")).toEqual([]);
    expect(forbiddenNames("process: for (;;) {\n  break process;\n}")).toEqual([]);
    expect(forbiddenNames("class Queue {\n  get process() {\n    return 1;\n  }\n}")).toEqual([]);

    // A shorthand property writes one name in two roles. The property it
    // declares is not the binding it reads, and reading an ambient global is
    // a crossing however briefly the value is held.
    expect(forbiddenNames("const environment = { process };")).toEqual(["process"]);
    expect(forbiddenNames("const runtimes = { Deno, Bun };")).toEqual(["Deno", "Bun"]);
    expect(forbiddenNames("const process = 1;\nconst environment = { process };")).toEqual([]);
    expect(forbiddenNames("function hold(Buffer: number) {\n  return { Buffer };\n}")).toEqual([]);
    expect(forbiddenNames("const environment = { process: local };")).toEqual([]);

    // A name slot is a name slot wherever the grammar puts one: a named tuple
    // element and an import attribute key are labels, and the specifier beside
    // the attribute is still read as a module.
    expect(forbiddenNames("type Pair = [process: string, Deno?: number];")).toEqual([]);
    expect(
      forbiddenNames('import data from "./portable.json" with {\n  process: "portable",\n};'),
    ).toEqual([]);
    expect(forbiddenNames("type Pair = [value: typeof process];")).toEqual(["process"]);
    expect(forbiddenNames('import data from "node:fs" with {\n  process: "portable",\n};')).toEqual(
      ["node:fs"],
    );
    expect(forbiddenNames("enum Kind {\n  process,\n}")).toEqual([]);
    expect(forbiddenNames("interface Host {\n  process: number;\n}")).toEqual([]);

    // The same forms still end at their own boundary.
    expect(
      forbiddenNames("function read<Deno>(value: Deno): Deno { return value; }\nDeno.cwd();"),
    ).toEqual(["Deno"]);
    expect(
      forbiddenNames("function read() {\n  var process = portable;\n}\nconst pid = process.pid;"),
    ).toEqual(["process"]);

    // Shadowing is lexical, so it ends where its scope does.
    expect(
      forbiddenNames(
        "function inner(process: unknown) { return process; }\nconst pid = process.pid;",
      ),
    ).toEqual(["process"]);
    expect(
      forbiddenNames("{\n  const Deno = 1;\n  use(Deno);\n}\nconst home = Deno.cwd();"),
    ).toEqual(["Deno"]);

    // Every runtime this repository names an entry point after, not only the
    // one whose adapter exists today.
    expect(forbiddenNames(`import "./node.ts";`)).toEqual(["./node.ts"]);
    expect(forbiddenNames(`import "./bun.ts";`)).toEqual(["./bun.ts"]);
    expect(forbiddenNames(`import "./compiled.ts";`)).toEqual(["./compiled.ts"]);
    expect(forbiddenNames(`import "../src/node/journal.ts";`)).toEqual(["../src/node/journal.ts"]);
    expect(forbiddenNames(`import "../src/cloudflare/storage.ts";`)).toEqual([
      "../src/cloudflare/storage.ts",
    ]);
    expect(forbiddenNames(`import "../../vendor/store/mod.ts";`)).toEqual([
      "../../vendor/store/mod.ts",
    ]);

    // Positive controls: a word is not a host because a host's name is inside
    // it, and neither is a path segment.
    expect(forbiddenNames("const preprocessor = 1;")).toEqual([]);
    expect(forbiddenNames("const bundle = 1;\nclass Denominator {}")).toEqual([]);
    expect(forbiddenNames("const x = { process: 1 };\nconst y = x.process;")).toEqual([]);
    expect(forbiddenNames("queue.process(job);")).toEqual([]);
    expect(forbiddenNames(`import "./nodes.ts";`)).toEqual([]);
    expect(forbiddenNames(`import "./bundle.ts";`)).toEqual([]);
    expect(forbiddenNames(`import "../vendors/helper.ts";`)).toEqual([]);
    expect(forbiddenNames(`import "@executablemd/runtime";`)).toEqual([]);
    expect(forbiddenNames("const id = crypto.randomUUID();")).toEqual([]);

    const found = (yield* glob({
      root: REPOSITORY,
      patterns: [
        "packages/workflow/mod.ts",
        "packages/workflow/src/**/*.ts",
        "packages/durable-streams/*.ts",
      ],
      // Whole packages rather than named modules, so a coordination module
      // added later is covered without this list being remembered. The single
      // exception carries its reason: the HTTP stream is a client for a remote
      // durable stream and reaches the platform's own `fetch`.
      exclude: ["packages/workflow/src/deno/**", "packages/durable-streams/http-stream.ts"],
    }))
      .map((entry) => entry.path)
      .sort();

    // A pattern that matched nothing would report a clean boundary, so the
    // surface every Workspace effect actually crosses is named here.
    expect(found).toEqual(
      expect.arrayContaining([
        "packages/durable-streams/durability.ts",
        "packages/durable-streams/effect.ts",
        "packages/durable-streams/guard.ts",
        "packages/durable-streams/live-coordinator.ts",
        "packages/durable-streams/types.ts",
        "packages/workflow/mod.ts",
        "packages/workflow/src/storage/api.ts",
        "packages/workflow/src/workspace/api.ts",
        "packages/workflow/src/workspace/effect.ts",
      ]),
    );
    expect(found.some((path) => path.includes("/src/deno/"))).toBe(false);

    const crossings: Record<string, string[]> = {};
    const unread: string[] = [];
    for (const path of found) {
      const source = yield* readTextFile(join(REPOSITORY, path));
      // A parse that failed would report every file as clean. A module whose
      // text imports something must yield a specifier, or this scan is reading
      // nothing and saying so approvingly.
      if (/^import\s/m.test(source) && moduleSpecifiers(parse(source).file).length === 0) {
        unread.push(path);
      }
      const names = forbiddenNames(source);
      if (names.length > 0) {
        crossings[path] = names;
      }
    }
    expect(unread).toEqual([]);
    expect(crossings).toEqual({});
  });

  it("DLC15: live Workspace invocation authority is one-shot", function* () {
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    let capturedAuthority: WorkspaceCoordinationAuthority | undefined;
    let executions = 0;
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        capturedAuthority = authority;
        const result: Result = { status: "ok", value: yield* authority.execute() };
        yield* authority.publish(result);
        return result;
      },
    };
    function* workflow(): Workflow<void> {
      yield* workspaceStep("one-shot", function* () {
        executions += 1;
        return null;
      });
    }

    yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    if (capturedAuthority === undefined) {
      throw new Error("the provider did not receive its live invocation authority");
    }
    expect(yield* raised(capturedAuthority.execute())).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(
      yield* raised(capturedAuthority.publish({ status: "ok", value: "late" })),
    ).toBeInstanceOf(WorkspaceCoordinationProviderError);
    const activationFailure = yield* raised(
      capturedAuthority.activateFailure(new Error("late activation")),
    );
    expect(activationFailure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(executions).toBe(1);
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC17: a forged contextual result cannot complete or resume a live invocation", function* () {
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    const { provider, counts } = successfulProvider();
    let laterExecutions = 0;
    function* workflow(): Workflow<void> {
      try {
        yield* workspaceStep("forged-result", function* () {
          return "not reached";
        });
      } catch {
        // The durable fail-stop boundary, rather than workflow recovery, decides termination.
      }
      yield* durableCall("after-forgery", function* () {
        laterExecutions += 1;
        return null;
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        // deno-lint-ignore require-yield
        *coordinate(): Operation<unknown> {
          return { type: "result", result: { status: "ok", value: "forged" } };
        },
      });
      return yield* raised(
        withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
      );
    });

    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(counts).toEqual({ providers: 0, executions: 0, publications: 0 });
    expect(laterExecutions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC18: invocation phases are unreachable without a selected provider", function* () {
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    let collisionCalls = 0;
    let executions = 0;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("direct-phases", function* () {
        executions += 1;
        return "not reached";
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          collisionCalls += 1;
          return yield* next(...args);
        },
      });
      return yield* raised(durableRun(workflow, { stream }));
    });

    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(collisionCalls).toBe(0);
    expect(executions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC19: contextual middleware cannot replace the authoritative published Result", function* () {
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    const { provider, counts } = successfulProvider();
    function* workflow(): Workflow<string> {
      const result = yield createDurableWorkspaceOperation(
        { type: "workspace", name: "replace-result" },
        function* () {
          return "authoritative";
        },
      );
      if (typeof result !== "string") {
        throw new Error("the Workspace operation did not return its string result");
      }
      return result;
    }

    const value = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          yield* next(...args);
          return { type: "result", result: { status: "ok", value: "forged" } };
        },
      });
      return yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });

    expect(value).toBe("authoritative");
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toEqual([
      expect.objectContaining({ result: { status: "ok", value: "authoritative" } }),
    ]);
  });

  it("DLC20: post-completion middleware cannot suppress, throw, or duplicate work", function* () {
    for (const behavior of ["suppress", "throw", "duplicate"]) {
      const stream = new InMemoryStream();
      establishJournalProvenance(stream);
      const { provider, counts } = successfulProvider();
      function* workflow(): Workflow<string> {
        const result = yield createDurableWorkspaceOperation(
          { type: "workspace", name: behavior },
          function* () {
            return behavior;
          },
        );
        if (typeof result !== "string") {
          throw new Error("the Workspace operation did not return its string result");
        }
        return result;
      }

      const value = yield* scoped(function* () {
        yield* WorkspaceInvocationCollision.around({
          *coordinate(args, next): Operation<unknown> {
            const response = yield* next(...args);
            if (behavior === "throw") {
              throw new Error("post-completion middleware failure");
            }
            if (behavior === "duplicate") {
              yield* next(...args);
            }
            return behavior === "suppress" ? { type: "published" } : response;
          },
        });
        return yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
      });

      expect(value).toBe(behavior);
      expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
      expect(yieldEvents(stream.snapshot())).toHaveLength(1);
    }
  });

  it("DLC21: retained contextual continuation cannot reuse a completed invocation", function* () {
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    const { provider, counts } = successfulProvider();
    let retained: ((request: unknown) => Operation<unknown>) | undefined;
    let retainedRequest: unknown;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("retained-continuation", function* () {
        return null;
      });
    }

    yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          retained = (request) => next(request);
          retainedRequest = args[0];
          return yield* next(...args);
        },
      });
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });
    if (retained === undefined) {
      throw new Error("the collision middleware did not retain its continuation");
    }

    expect(yield* raised(retained(retainedRequest))).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC22: minimum-priority collision middleware receives no invocation capability", function* () {
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    const { provider, counts } = successfulProvider();
    const observed: unknown[] = [];
    function* workflow(): Workflow<void> {
      yield* workspaceStep("minimum-priority", function* () {
        return "published";
      });
    }

    yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around(
        {
          // deno-lint-ignore require-yield
          *coordinate(args): Operation<unknown> {
            observed.push(args[0]);
            return { type: "published" };
          },
        },
        { at: "min" },
      );
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });

    expect(observed).toEqual([]);
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC23: minimum-priority middleware cannot replace first-failure activation", function* () {
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    const first = new Error("authoritative infrastructure failure");
    let activated: Error | undefined;
    let collisions = 0;
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        activated = yield* authority.activateFailure(first);
        throw activated;
      },
    };
    function* workflow(): Workflow<void> {
      yield* workspaceStep("minimum-failure", function* () {
        return "not reached";
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around(
        {
          // deno-lint-ignore require-yield
          *coordinate(): Operation<unknown> {
            collisions += 1;
            return { type: "failure", failure: new Error("replacement") };
          },
        },
        { at: "min" },
      );
      return yield* raised(
        withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
      );
    });

    expect(collisions).toBe(0);
    expect(activated).toBe(first);
    expect(failure).toBe(first);
    expect(stream.snapshot()).toEqual([]);
  });
});
