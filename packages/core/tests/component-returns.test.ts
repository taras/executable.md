/**
 * Tier RV — component and root return values (spec §6.10, §5.4).
 *
 * Covers the two return modes, both `returns` declaration forms, the JSON
 * boundary, `<Return>` structure and reservation, capture through `as`, value
 * roots, and deterministic replay.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableStream } from "@executablemd/durable-streams";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { execute } from "../src/execute.ts";
import { inspectDocument } from "../src/inspect.ts";
import {
  compilePropsSchema,
  compileReturnsSchema,
  PropsSchemaError,
  validateReturnValue,
} from "../src/validate.ts";
import type { Json } from "../src/types.ts";
import { asText } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface Run {
  value?: Json;
  /** Rendered body text — the observability channel, never the result. */
  output: string;
  error?: string;
  commands: string[];
}

function* runExecution(options: {
  path: string;
  stream: DurableStream;
  includes?: string[];
  commands: string[];
}): Operation<Run> {
  const { commands } = options;
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec([execOptions], _next) {
      commands.push((execOptions.command[2] ?? "").trim());
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const execution = yield* execute({
    path: options.path,
    stream: options.stream,
    includes: options.includes,
  });
  const result = yield* execution;
  const output = yield* forEach(function* (_chunk: string) {}, execution.output);

  if (!result.ok) {
    return { output, error: result.error.message, commands };
  }
  return { value: result.value, output, commands };
}

/**
 * What one run said about itself: the diagnostic it reported, or its rendered
 * text.
 *
 * An uncaught diagnostic at a text root is the run's own outcome rather than a
 * comment in the body, so a case about what a rejection says reads it here. A
 * successful run's text is unchanged.
 */
function said(run: Run): string {
  return run.error ?? asText(run.value ?? "");
}

function run(files: Record<string, string>, stream?: DurableStream): Operation<Run> {
  return scoped(function* () {
    const commands: string[] = [];
    yield* useStubFs(files);
    return yield* runExecution({
      path: "doc.md",
      stream: stream ?? new InMemoryStream(),
      commands,
    });
  });
}

/**
 * Run `doc.md` from a real fixture project. Function components are imported
 * by file URL, so they need files on disk and a package.json that makes the
 * host resolve them as ES modules with the workspace's dependencies.
 */
function runFixture(files: Record<string, string>): Operation<Run> {
  return scoped(function* () {
    const dir = path.join(os.tmpdir(), `returns-test-${randomUUID()}`);
    yield* ensureDir(dir);
    // Removing the directory removes the symlink with it, and registering the
    // cleanup first means a failure during setup still takes the fixture away.
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    yield* writeTextFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    // The only step @effectionx/fs does not cover.
    yield* until(symlink(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir"));
    for (const [name, content] of Object.entries(files)) {
      yield* writeTextFile(path.join(dir, name), content);
    }

    return yield* runExecution({
      path: path.join(dir, "doc.md"),
      stream: new InMemoryStream(),
      includes: [dir],
      commands: [],
    });
  });
}

const CAPTURING_ROOT = [
  '<Verdict as="verdict" />',
  "",
  "```js eval",
  "const shown = String(JSON.stringify(verdict));",
  "```",
  "",
  "captured: {shown}",
  "",
].join("\n");

function valueComponent(declaration: string, expression: string): string {
  return [
    "---",
    declaration,
    "---",
    "",
    "```js eval",
    `const produced = ${expression};`,
    "```",
    "",
    "<Return value={produced} />",
    "",
  ].join("\n");
}

/** A body effect that must not run when structural validation fails. */
const BODY_EFFECT = "```sh exec\necho BODY_RAN\n```";

/** The failure an operation raised, so an assertion can read it. */
function* raised(operation: () => Operation<unknown>): Operation<unknown> {
  try {
    yield* operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

describe("Tier RV — component return values", () => {
  beforeAll(() => useTempFileCompiler());

  describe("value kinds", () => {
    const kinds: Array<[string, string, string, Json]> = [
      ["a string", "returns:\n  type: string", '"shipped"', "shipped"],
      ["a number", "returns:\n  type: number", "42", 42],
      ["a boolean", "returns:\n  type: boolean", "true", true],
      ["an array", "returns:\n  type: array\n  items: { type: string }", '["a", "b"]', ["a", "b"]],
      [
        "an object",
        "returns:\n  passed: { type: boolean }",
        "({ passed: true })",
        { passed: true },
      ],
      ["null", "returns:\n  type: 'null'", "null", null],
    ];

    for (const [label, declaration, expression, expected] of kinds) {
      it(`binds ${label} through as`, function* () {
        const result = yield* run({
          "doc.md": CAPTURING_ROOT,
          "Verdict.md": valueComponent(declaration, expression),
        });
        expect(result.error).toBeUndefined();
        expect(said(result)).toContain(`captured: ${JSON.stringify(expected)}`);
      });
    }

    it("emits no segments of its own", function* () {
      const result = yield* run({
        "doc.md": 'before\n\n<Verdict as="verdict" />\n\nafter\n',
        "Verdict.md": valueComponent("returns:\n  passed: { type: boolean }", "({ passed: true })"),
      });
      expect(said(result)).not.toContain("passed");
    });

    it("drives caller control flow from the captured value", function* () {
      const result = yield* run({
        "doc.md": [
          '<Verdict as="verdict" />',
          "",
          "<If condition={verdict.passed}>",
          "",
          "REVIEW PASSED",
          "",
          "<Else>",
          "",
          "REVIEW FAILED",
          "",
          "</Else>",
          "</If>",
          "",
        ].join("\n"),
        "Verdict.md": valueComponent("returns:\n  passed: { type: boolean }", "({ passed: true })"),
      });
      expect(said(result)).toContain("REVIEW PASSED");
      expect(said(result)).not.toContain("REVIEW FAILED");
    });
  });

  describe("declaration forms", () => {
    it("requires every property of the object shorthand", function* () {
      const result = yield* run({
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": valueComponent(
          "returns:\n  passed: { type: boolean }\n  summary: { type: string }",
          "({ passed: true })",
        ),
      });
      const output = said(result);
      expect(output).toContain("Return validation failed for <Verdict />");
      expect(output).toContain("summary");
    });

    it("rejects a property the object shorthand does not declare", function* () {
      const result = yield* run({
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": valueComponent(
          "returns:\n  passed: { type: boolean }",
          "({ passed: true, extra: 1 })",
        ),
      });
      expect(said(result)).toContain("Return validation failed for <Verdict />");
    });

    it("accepts a full schema with an optional property", function* () {
      const result = yield* run({
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": valueComponent(
          [
            "returns:",
            "  type: object",
            "  properties:",
            "    passed: { type: boolean }",
            "    summary: { type: string }",
            "  required: [passed]",
            "  additionalProperties: false",
          ].join("\n"),
          "({ passed: true })",
        ),
      });
      expect(said(result)).toContain('captured: {"passed":true}');
    });

    it("rejects a non-object returns declaration", function* () {
      const result = yield* run({
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": "---\nreturns: text\n---\n\nbody\n",
      });
      expect(said(result)).toContain('"returns" must declare a JSON Schema object');
    });

    it("rejects a boolean returns declaration during inspection", function* () {
      yield* useStubFs({ "doc.md": "---\nreturns: true\n---\n\nbody\n" });
      let message = "";
      try {
        yield* inspectDocument({ path: "doc.md" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('"returns" must declare a JSON Schema object');
    });

    it("rejects an invalid return schema in execution and inspection alike", function* () {
      const source = "---\nreturns:\n  type: nonsense\n---\n\n<Return value={1} />\n";
      const result = yield* run({ "doc.md": CAPTURING_ROOT, "Verdict.md": source });
      expect(said(result)).toContain("invalid return schema");

      yield* useStubFs({ "Verdict.md": source });
      let message = "";
      try {
        yield* inspectDocument({ path: "Verdict.md" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("invalid return schema");
    });
  });

  describe("the JSON boundary", () => {
    const rejected: Array<[string, string]> = [
      ["undefined", "(() => undefined)()"],
      ["a non-finite number", "Infinity"],
      ["a class instance", "new (class Verdict { constructor() { this.passed = true; } })()"],
      ["a cyclic object", "(() => { const cycle = {}; cycle.self = cycle; return cycle; })()"],
    ];

    for (const [label, expression] of rejected) {
      it(`rejects ${label} before binding`, function* () {
        const result = yield* run({
          "doc.md": CAPTURING_ROOT,
          // The value is produced in the <Return> expression itself: an eval
          // block cannot even export some of these.
          "Verdict.md": [
            "---",
            "returns:",
            "  type: object",
            "---",
            "",
            `<Return value={${expression}} />`,
            "",
          ].join("\n"),
        });
        const output = said(result);
        expect(output).toContain("Return validation failed for <Verdict />");
        expect(output).toContain("is not JSON");
        // Refused at the invocation, so nothing after it ran: the eval block
        // that would have read the binding never started, and the run ends
        // here rather than carrying an unbound name forward.
        expect(result.error).toBeDefined();
        expect(result.output).not.toContain("captured:");
      });
    }

    it("fills defaults into the returned value without mutating the producer's object", function* () {
      const result = yield* run({
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": [
          "---",
          "returns:",
          "  type: object",
          "  properties:",
          "    passed: { type: boolean }",
          "    severity: { type: string, default: low }",
          "  required: [passed]",
          "  additionalProperties: false",
          "---",
          "",
          "```js eval",
          "const produced = { passed: true };",
          "```",
          "",
          "<Return value={produced} />",
          "",
          "produced stays: {produced}",
          "",
        ].join("\n"),
      });
      const output = said(result);
      expect(output).toContain('"severity":"low"');
      expect(output).not.toContain("produced stays");
    });
  });

  describe("text mode compatibility", () => {
    it("renders and captures a string when no returns is declared", function* () {
      const result = yield* run({
        "doc.md": '<Note as="note" />\n\ncaptured: {note}\n',
        "Note.md": "NOTE BODY\n",
      });
      expect(said(result)).toContain("captured: NOTE BODY");
    });

    it("treats an explicit string schema as value mode", function* () {
      const result = yield* run({
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": valueComponent("returns:\n  type: string", '"shipped"'),
      });
      expect(said(result)).toContain('captured: "shipped"');
    });

    it("keeps <Output> selection working for a text component", function* () {
      const result = yield* run({
        "doc.md": "<Note />\n",
        "Note.md": "DOCUMENTATION\n\n<Output>\n\nSELECTED\n\n</Output>\n",
      });
      const output = said(result);
      expect(output).toContain("SELECTED");
      expect(output).not.toContain("DOCUMENTATION");
    });
  });

  describe("definition-owned return flow", () => {
    /**
     * A value component whose declaration is satisfied from inside `directive`.
     * Each row is the same claim — the directive keeps the body that owns it —
     * written in the four structural forms a document has today.
     */
    const OWNED = [
      { name: "If", body: ["<If condition={true}>", '<Return value="picked" />', "</If>"] },
      {
        name: "Loop",
        body: ['<Loop name="tries" max={3}>', '<Return value="picked" />', "<Break />", "</Loop>"],
      },
      {
        name: "Each",
        body: ['<Each in={["picked"]} let="item">', "<Return value={item} />", "</Each>"],
      },
      { name: "Let", body: ['<Let as="rendered">', '<Return value="picked" />', "</Let>"] },
    ];

    for (const owned of OWNED) {
      it(`RV11a: <${owned.name}> keeps the value body that owns it`, function* () {
        const result = yield* run({
          "doc.md": '<Verdict as="v" />\n\nGot {v}\n',
          "Verdict.md": ["---", "returns:", "  type: string", "---", "", ...owned.body, ""].join(
            "\n",
          ),
        });
        expect(said(result)).toContain("Got picked");
      });
    }

    it("RV11a: an unselected <If> reaches the component's missing-return diagnostic", function* () {
      const result = yield* run({
        "doc.md": '<Verdict as="v" />\n',
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "<If condition={false}>",
          '<Return value="picked" />',
          "</If>",
          "",
        ].join("\n"),
      });
      expect(said(result)).toContain("<Verdict /> declares `returns` but produced no <Return>");
    });

    it("RV11b: a caller's <Return> selects through a Markdown <Content /> wrapper", function* () {
      // The wrapper declares nothing. The return is the caller's text, so it
      // satisfies the caller's declaration wherever the wrapper renders it.
      const result = yield* run({
        "doc.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "<Wrap>",
          '<Return value="through the wrapper" />',
          "</Wrap>",
          "",
        ].join("\n"),
        "Wrap.md": "Wrapping <Content />\n",
      });
      expect(result.value).toBe("through the wrapper");
    });

    it("RV11c: a <Return> an invoked body writes never satisfies its caller", function* () {
      const result = yield* run({
        "doc.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "<Foreign />",
          '<Return value="the caller\'s own" />',
          "",
        ].join("\n"),
        "Foreign.md": '<Return value="not the caller\'s" />\n',
      });
      // The foreign body declares no `returns`, so its own text-body preflight
      // refuses the element — it never reaches the caller's frame.
      expect(said(result)).toContain("<Return> requires a document or component");
      expect(said(result)).toContain("not the caller");
    });

    it("RV11b: a caller's <Return> selects through a function component's content()", function* () {
      const result = yield* runFixture({
        "doc.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "<Wrap>",
          '<Return value="through content()" />',
          "</Wrap>",
          "",
        ].join("\n"),
        "Wrap.ts": [
          'import { content } from "@executablemd/core";',
          "export default function*() {",
          "  const rendered = yield* content();",
          "  return `wrapped ${rendered}`;",
          "}",
          "",
        ].join("\n"),
      });
      expect(result.value).toBe("through content()");
    });

    it("RV11c: a <Return> render() generates stays reserved beneath a value body", function* () {
      // `render()` runs inside <Dynamic />, whose own value frame is active —
      // so this proves dynamic markdown is refused on its own terms rather than
      // for want of an owner to claim.
      const result = yield* run({
        "doc.md": '<Dynamic as="d" />\n',
        "Dynamic.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "```js eval",
          "const generated = yield* render(\'<Return value=\"dynamic\" />\');",
          "```",
          "",
          "{generated}",
          "",
          '<Return value="the component\'s own" />',
          "",
        ].join("\n"),
      });
      // Diagnosed where it was generated, and no component named Return was
      // resolved to answer it.
      expect(said(result)).toContain("<Return> is reserved");
      expect(said(result)).toContain("neither markdown produced at runtime");
      // The generated element selected nothing: the run has no value at all.
      expect(result.value).toBeUndefined();
    });

    it("RV10c: two concurrent projections claim once and evaluate once", function* () {
      // Both projections of one authored <Return> are started before either is
      // awaited, so the second reaches the body while the first is in flight.
      // The claim is taken synchronously, before the claiming return evaluates
      // anything, so exactly one expression is ever evaluated.
      const result = yield* runFixture({
        "doc.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "```js eval",
          "globalThis.__rv10c = 0;",
          "const mark = () => {",
          "  globalThis.__rv10c += 1;",
          '  return "evaluated";',
          "};",
          "```",
          "",
          "<Both>",
          "<Return value={mark()} />",
          "</Both>",
          "",
        ].join("\n"),
        "Both.ts": [
          'import { content } from "@executablemd/core";',
          'import { all, spawn } from "effection";',
          "export default function*() {",
          "  const first = yield* spawn(() => content());",
          "  const second = yield* spawn(() => content());",
          "  yield* all([first, second]);",
          '  return "both";',
          "}",
          "",
        ].join("\n"),
      });

      expect(said(result)).toContain(
        "The root document declares `returns` but executed more than one <Return>.",
      );
      // The second execution evaluated nothing of its own, and the first
      // selected value was discarded rather than published.
      expect((globalThis as Record<string, unknown>).__rv10c).toBe(1);
      expect(result.value).toBeUndefined();
    });

    it("RV12: a teardown failure after selection wins over the selected value", function* () {
      const result = yield* runFixture({
        "doc.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          '<Return value="selected" />',
          "",
          '<Failing as="ignored" />',
          "",
        ].join("\n"),
        // The body completes; teardown is what fails, after the value was
        // already selected.
        "Failing.ts": [
          'import { ensure } from "effection";',
          "export const returns = { type: 'string' };",
          "export default function*() {",
          '  yield* ensure(function* () { throw new Error("TEARDOWN_FAILED"); });',
          '  return "body finished";',
          "}",
          "",
        ].join("\n"),
      });

      expect(said(result)).toContain("TEARDOWN_FAILED");
      expect(result.value).toBeUndefined();
    });

    it("RV12: halting after selection publishes no value and completes teardown", function* () {
      const reached = withResolvers<void>();
      const torn: string[] = [];
      const globals = globalThis as Record<string, unknown>;
      globals.__rv12reached = () => reached.resolve();
      globals.__rv12torn = () => torn.push("torn down");
      yield* ensure(() => {
        delete globals.__rv12reached;
        delete globals.__rv12torn;
      });

      yield* scoped(function* () {
        const dir = path.join(os.tmpdir(), `returns-halt-${randomUUID()}`);
        yield* ensureDir(dir);
        yield* ensure(() => rm(dir, { recursive: true, force: true }));
        yield* writeTextFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
        yield* until(
          symlink(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir"),
        );
        yield* writeTextFile(
          path.join(dir, "doc.md"),
          [
            "---",
            "returns:",
            "  type: string",
            "---",
            "",
            '<Return value="selected" />',
            "",
            // Suspends after the value was selected, so the halt below lands
            // between selection and completion.
            '<Suspends as="never" />',
            "",
          ].join("\n"),
        );
        yield* writeTextFile(
          path.join(dir, "Suspends.ts"),
          [
            'import { ensure, suspend } from "effection";',
            "export const returns = { type: 'string' };",
            "export default function*() {",
            "  yield* ensure(() => { globalThis.__rv12torn(); });",
            "  globalThis.__rv12reached();",
            "  yield* suspend();",
            '  return "unreachable";',
            "}",
            "",
          ].join("\n"),
        );

        const outcome: string[] = [];
        const task = yield* spawn(function* () {
          const execution = yield* execute({
            path: path.join(dir, "doc.md"),
            stream: new InMemoryStream(),
            includes: [dir],
          });
          const result = yield* execution;
          outcome.push(result.ok ? "ok" : "err");
        });

        yield* reached.operation;
        yield* task.halt();

        // Halted rather than completed: the selected value was never published
        // as a result, and the suspended component's teardown still ran.
        expect(outcome).toEqual([]);
        expect(torn).toEqual(["torn down"]);
      });
    });

    it("RV17a: a partial replay reconstructs selection without repeating an effect", function* () {
      const stream = new InMemoryStream();
      const reached = withResolvers<void>();
      const globals = globalThis as Record<string, unknown>;
      globals.__rv17reached = () => reached.resolve();
      globals.__rv17suspend = true;
      yield* ensure(() => {
        delete globals.__rv17reached;
        delete globals.__rv17suspend;
      });

      const dir = path.join(os.tmpdir(), `returns-replay-${randomUUID()}`);
      yield* ensureDir(dir);
      yield* ensure(() => rm(dir, { recursive: true, force: true }));
      yield* writeTextFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
      yield* until(symlink(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir"));
      yield* writeTextFile(
        path.join(dir, "doc.md"),
        [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "```bash exec",
          "echo work",
          "```",
          "",
          '<Return value="selected" />',
          "",
          '<Gate as="gate" />',
          "",
        ].join("\n"),
      );
      // Suspends on the first pass only, so the resume can finish.
      yield* writeTextFile(
        path.join(dir, "Gate.ts"),
        [
          'import { suspend } from "effection";',
          "export const returns = { type: 'string' };",
          "export default function*() {",
          "  if (globalThis.__rv17suspend) {",
          "    globalThis.__rv17reached();",
          "    yield* suspend();",
          "  }",
          '  return "gate";',
          "}",
          "",
        ].join("\n"),
      );

      const first: string[] = [];
      yield* scoped(function* () {
        const task = yield* spawn(() =>
          runExecution({
            path: path.join(dir, "doc.md"),
            stream,
            includes: [dir],
            commands: first,
          }),
        );
        yield* reached.operation;
        yield* task.halt();
      });
      expect(first).toEqual(["echo work"]);

      globals.__rv17suspend = false;
      const second: string[] = [];
      const resumed = yield* scoped(() =>
        runExecution({ path: path.join(dir, "doc.md"), stream, includes: [dir], commands: second }),
      );

      // The completed effect replayed from the journal rather than running.
      expect(second).toEqual([]);
      // Selection was reconstructed by ephemeral expansion, not recovered from
      // a record: the resumed run produces the same value.
      expect(resumed.value).toBe("selected");
      // Nothing about the selection was journaled.
      const descriptions = stream
        .snapshot()
        .flatMap((event) => (event.type === "yield" ? [event.description.type] : []));
      // The journal is not empty, so the absence above is a real absence.
      expect(descriptions).toContain("exec");
      expect(descriptions).not.toContain("return");
    });

    it("RV10e: a component cannot select a value through the named return context", function* () {
      // The same attack the value root faces, run from inside a Markdown value
      // component's own body: read the carrier the engine published, write to
      // it, clear its claim, then replace the context with a fully-formed
      // forgery. The component's one authored <Return> is unselected, so
      // anything it selected would be a value nothing validated.
      const result = yield* run({
        "doc.md": '<Verdict as="v" />\n\nGot {v}\n',
        "Verdict.md": [
          "---",
          "returns:",
          "  type: number",
          "---",
          "",
          "```js eval",
          'import { createContext } from "effection";',
          'const ctx = createContext("expand.return");',
          "const carrier = yield* ctx.get();",
          'try { carrier.selected = { value: "schema-bypassed" }; } catch (error) {}',
          "try { carrier.claimed = false; } catch (error) {}",
          "yield* ctx.set({",
          '  owner: "Verdict",',
          '  returns: { type: "string" },',
          "  claimed: true,",
          '  selected: { value: "schema-bypassed" },',
          "});",
          "```",
          "",
          "<If condition={false}>",
          "<Return value={1} />",
          "</If>",
          "",
        ].join("\n"),
      });

      expect(said(result)).toContain("<Verdict /> declares `returns` but produced no <Return>");
      expect(said(result)).not.toContain("schema-bypassed");
      // Nothing was bound: the caller's capture never resolved.
      expect(said(result)).not.toContain("Got ");
      expect(result.value).toBeUndefined();
    });

    it("RV10e: importing the internal return module selects nothing", function* () {
      // An eval block's imports are hoisted and resolved like any module's, so
      // a document can import the engine's own source by file URL. It gains
      // nothing: the body a value root is settling from is a local of that
      // expansion, handed down as a parameter, and no export takes someone
      // else's. Whatever the document builds here is a body of its own.
      const internal = new URL("../src/return-flow.ts", import.meta.url).href;
      const result = yield* runFixture({
        "doc.md": [
          "---",
          "returns:",
          "  type: number",
          "---",
          "",
          "```js eval",
          'import { createContext } from "effection";',
          `import * as flow from ${JSON.stringify(internal)};`,
          'const surface = Object.keys(flow).sort().join(",");',
          "// Whatever this module still exports, aimed at this run.",
          'const own = flow.createReturnBody("__root__", { type: "string" });',
          "own.claim();",
          'own.select("schema-bypassed");',
          'const stolen = yield* createContext("expand.return").get();',
          'const reached = stolen === undefined ? "nothing" : "something";',
          "```",
          "",
          "surface: {surface} reached: {reached}",
          "",
          "<If condition={false}>",
          "<Return value={1} />",
          "</If>",
          "",
        ].join("\n"),
      });

      // The run fails exactly as a value root that executed no return does.
      expect(said(result)).toContain(
        "The root document declares `returns` but produced no <Return> value.",
      );
      // Nothing forged was published, and the schema-invalid string in
      // particular never reached the caller.
      expect(result.value).toBeUndefined();
      expect(said(result)).not.toContain("schema-bypassed");
      // The context the old design published on holds nothing to steal.
      expect(said(result)).not.toContain("reached: something");
      // No export can claim, select, settle, mutate or read a live body.
      expect(said(result)).not.toContain("claimReturn");
      expect(said(result)).not.toContain("selectReturnValue");
      expect(said(result)).not.toContain("settleReturn");
    });

    it("RV14: a nested value body owns a separate declaration", function* () {
      const result = yield* run({
        "doc.md": '<Outer as="o" />\n\nGot {o}\n',
        "Outer.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          '<Inner as="i" />',
          "<Return value={`outer saw ${i}`} />",
          "",
        ].join("\n"),
        "Inner.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          '<Return value="inner" />',
          "",
        ].join("\n"),
      });
      // Two executions, neither a duplicate: each claimed its own body.
      expect(said(result)).toContain("Got outer saw inner");
    });

    it("RV10d: projecting one authored <Return> twice is a duplicate", function* () {
      const result = yield* run({
        "doc.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "<Twice>",
          '<Return value="once" />',
          "</Twice>",
          "",
        ].join("\n"),
        "Twice.md": "<Content />\n\n<Content />\n",
      });
      expect(said(result)).toContain(
        "The root document declares `returns` but executed more than one <Return>.",
      );
    });
  });

  describe("structure, before body effects", () => {
    it("refuses <Return> in a text component", function* () {
      const result = yield* run({
        "doc.md": "<Note />\n",
        "Note.md": `${BODY_EFFECT}\n\n<Return value={1} />\n`,
      });
      expect(said(result)).toContain("<Return> requires a document or component");
      expect(result.commands).toEqual([]);
    });

    it("RV10a: requires a statically authored <Return> when returns is declared", function* () {
      const result = yield* run({
        "doc.md": '<Verdict as="v" />\n',
        "Verdict.md": `---\nreturns:\n  type: string\n---\n\n${BODY_EFFECT}\n`,
      });
      expect(said(result)).toContain("no <Return>");
      expect(result.commands).toEqual([]);
    });

    it("RV10a: a caller's <Return> does not satisfy the callee's declaration", function* () {
      // Preflight reads the callee's own source, before <Content /> is
      // substituted, so content the caller offers can neither introduce nor
      // satisfy a declaration.
      // The caller is itself a value body, so its <Return> is well placed
      // where it is written. Offering it to the callee still declares nothing:
      // preflight reads the callee's own source, before <Content /> is
      // substituted.
      const result = yield* run({
        "doc.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          '<Verdict as="v">',
          '<Return value="the caller\'s" />',
          "</Verdict>",
          "",
        ].join("\n"),
        "Verdict.md": `---\nreturns:\n  type: string\n---\n\n${BODY_EFFECT}\n<Content />\n`,
      });
      expect(said(result)).toContain("no <Return>");
      expect(result.commands).toEqual([]);
    });

    it("RV10b: a nested <Return> is statically valid and reaches runtime", function* () {
      const result = yield* run({
        "doc.md": '<Verdict as="v" />\n\nGot {v}\n',
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          BODY_EFFECT,
          "",
          "<If condition={true}>",
          '<Return value="one" />',
          "</If>",
          "",
        ].join("\n"),
      });
      expect(said(result)).toContain("Got one");
      // Preflight did not reject the shape, so the body's effect ran.
      expect(result.commands.length).toBe(1);
    });

    it("RV10d: two executed <Return>s fail the body after the first effect", function* () {
      const result = yield* run({
        "doc.md": '<Verdict as="v" />\n\nGot {v}\n',
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          BODY_EFFECT,
          "",
          '<Return value="one" />',
          "",
          // Evaluating this expression at all would throw a different, louder
          // error, so the duplicate diagnostic below is proof it was never
          // evaluated.
          "<Return value={missingBinding.evaluated} />",
          "",
        ].join("\n"),
      });
      expect(said(result)).toContain("<Verdict /> declares `returns` but executed more than one");
      expect(said(result)).not.toContain("missingBinding");
      // The first selected value is discarded rather than bound: the caller's
      // `as` never resolves, so nothing renders it.
      expect(said(result)).not.toContain("Got one");
      // Source multiplicity is no longer a preflight violation, so the body
      // ran up to the second execution — the accepted timing change.
      expect(result.commands.length).toBe(1);
    });

    it("refuses <Output> alongside returns", function* () {
      const result = yield* run({
        "doc.md": '<Verdict as="v" />\n',
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          BODY_EFFECT,
          "",
          "<Output>",
          "text",
          "</Output>",
          "",
          '<Return value="one" />',
          "",
        ].join("\n"),
      });
      expect(said(result)).toContain("<Output> and `returns` are exclusive");
      expect(result.commands).toEqual([]);
    });

    it("refuses <Return> with children, extra props, or no value", function* () {
      const result = yield* run({
        "doc.md": '<Verdict as="v" />\n',
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          BODY_EFFECT,
          "",
          '<Return kind="verdict">body</Return>',
          "",
        ].join("\n"),
      });
      const output = said(result);
      expect(output).toContain('accepts only a "value" prop');
      expect(output).toContain('requires a "value" prop');
      expect(output).toContain("takes no children");
      expect(result.commands).toEqual([]);
    });

    it("refuses a value component invoked without as", function* () {
      const result = yield* run({
        "doc.md": "<Verdict />\n",
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          BODY_EFFECT,
          "",
          '<Return value="one" />',
          "",
        ].join("\n"),
      });
      expect(said(result)).toContain("must be invoked with `as`");
      expect(result.commands).toEqual([]);
    });
  });

  describe("<Return> is reserved", () => {
    it("diagnoses caller content that declares <Return>", function* () {
      const result = yield* run({
        "doc.md": "<Wrapper>\n<Return value={1} />\n</Wrapper>\n",
        "Wrapper.md": "<Content />\n",
        "Return.md": "A COMPONENT NAMED RETURN\n",
      });
      const output = said(result);
      expect(output).toContain("<Return> requires a document or component");
      expect(output).not.toContain("A COMPONENT NAMED RETURN");
    });

    it("diagnoses a <Return> produced by render(markdown)", function* () {
      const result = yield* run({
        "doc.md": "<Dynamic />\n",
        "Dynamic.md": [
          "```js eval",
          'const rendered = yield* render("<Return value={1} />");',
          "```",
          "",
          "{rendered}",
          "",
        ].join("\n"),
        "Return.md": "A COMPONENT NAMED RETURN\n",
      });
      const output = said(result);
      expect(output).toContain("<Return> is reserved");
      expect(output).not.toContain("A COMPONENT NAMED RETURN");
    });
  });

  describe("execution order", () => {
    it("runs documentation after <Return> and evaluates the value in place", function* () {
      const result = yield* run({
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          "```js eval",
          'const before = "early";',
          "```",
          "",
          "<Return value={before} />",
          "",
          "```sh exec",
          "echo AFTER_RETURN",
          "```",
          "",
          "```js eval",
          'const after = "late";',
          "```",
          "",
        ].join("\n"),
      });
      expect(said(result)).toContain('captured: "early"');
      expect(result.commands).toEqual(["echo AFTER_RETURN"]);
    });

    it("fails the caller when documentation after <Return> fails", function* () {
      const result = yield* run({
        "doc.md": '<Verdict as="verdict" />\n',
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          '<Return value="one" />',
          "",
          "<Missing />",
          "",
        ].join("\n"),
      });
      expect(result.error).toContain("Missing");
    });
  });

  describe("function components", () => {
    const valueFunction = [
      "export const returns = { passed: { type: 'boolean' } };",
      "export default function*() {",
      "  return { passed: true };",
      "}",
      "",
    ].join("\n");

    it("validates and captures a declared return value", function* () {
      const result = yield* runFixture({ "doc.md": CAPTURING_ROOT, "Verdict.ts": valueFunction });
      expect(said(result)).toContain('captured: {"passed":true}');
    });

    it("refuses a value function component invoked without as", function* () {
      const result = yield* runFixture({ "doc.md": "<Verdict />\n", "Verdict.ts": valueFunction });
      expect(said(result)).toContain("must be invoked with `as`");
    });

    it("reports a value that fails its schema", function* () {
      const result = yield* runFixture({
        "doc.md": CAPTURING_ROOT,
        "Verdict.ts": [
          "export const returns = { passed: { type: 'boolean' } };",
          "export default function*() {",
          "  return { passed: 'yes' };",
          "}",
          "",
        ].join("\n"),
      });
      expect(said(result)).toContain("Return validation failed for <Verdict />");
    });

    // A return binds by reference, so a non-string is a perfectly ordinary
    // return value — it simply has nowhere to go without `as`, and renders
    // nothing rather than being stringified into the document or diagnosed.
    it("renders nothing for a component that returns a non-string", function* () {
      const result = yield* runFixture({
        "doc.md": "before\n\n<Verdict />\n\nafter\n",
        "Verdict.ts": ["export default function*() {", "  return { passed: true };", "};", ""].join(
          "\n",
        ),
      });
      const rendered = said(result);
      expect(rendered).not.toContain("non-string");
      expect(rendered).not.toContain("passed");
      expect(rendered).toContain("before");
      expect(rendered).toContain("after");
    });
  });

  describe("composition", () => {
    it("captures a value component invoked inside another component's body", function* () {
      const result = yield* run({
        "doc.md": "<Report />\n",
        "Report.md": [
          '<Verdict as="verdict" />',
          "",
          "<If condition={verdict.passed}>",
          "",
          "REPORT PASSED",
          "",
          "</If>",
          "",
        ].join("\n"),
        "Verdict.md": valueComponent("returns:\n  passed: { type: boolean }", "({ passed: true })"),
      });
      expect(said(result)).toContain("REPORT PASSED");
    });

    it("does not leak the value into the component's own environment", function* () {
      const result = yield* run({
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          '<Return value="one" />',
          "",
          "self: {verdict}",
          "",
        ].join("\n"),
      });
      const output = said(result);
      expect(output).toContain('captured: "one"');
      expect(output).not.toContain("self:");
    });
  });

  describe("value roots", () => {
    const valueRoot = [
      "---",
      "returns:",
      "  passed: { type: boolean }",
      "---",
      "",
      "BODY TEXT",
      "",
      "```js eval",
      "const produced = { passed: true };",
      "```",
      "",
      "<Return value={produced} />",
      "",
    ].join("\n");

    it("returns its validated value and keeps body text observable", function* () {
      const result = yield* run({ "doc.md": valueRoot });
      expect(result.value).toEqual({ passed: true });
      expect(result.output).toContain("BODY TEXT");
    });

    it("reports value mode through inspection without executing", function* () {
      yield* useStubFs({ "doc.md": valueRoot });
      const description = yield* inspectDocument({ path: "doc.md" });
      expect(description.returnMode).toBe("value");
      expect(description.returns).toEqual({
        type: "object",
        properties: { passed: { type: "boolean" } },
        required: ["passed"],
        additionalProperties: false,
      });
    });

    it("reports the default text schema for a root without returns", function* () {
      yield* useStubFs({ "doc.md": "# Title\n" });
      const description = yield* inspectDocument({ path: "doc.md" });
      expect(description.returnMode).toBe("text");
      expect(description.returns).toEqual({ type: "string" });
    });

    it("fails as a whole when its structure is invalid", function* () {
      const result = yield* run({
        "doc.md": ["---", "returns:", "  type: string", "---", "", BODY_EFFECT, ""].join("\n"),
      });
      expect(result.value).toBeUndefined();
      expect(result.error).toContain("no <Return>");
      expect(result.commands).toEqual([]);
    });

    it("fails as a whole when its value violates the schema", function* () {
      const result = yield* run({
        "doc.md": [
          "---",
          "returns:",
          "  passed: { type: boolean }",
          "---",
          "",
          '<Return value="yes" />',
          "",
        ].join("\n"),
      });
      expect(result.value).toBeUndefined();
      expect(result.error).toContain("Return validation failed for <__root__ />");
    });

    it("fails as a whole when its body fails after <Return>", function* () {
      const result = yield* run({
        "doc.md": [
          "---",
          "returns:",
          "  type: string",
          "---",
          "",
          '<Return value="one" />',
          "",
          "<Missing />",
          "",
        ].join("\n"),
      });
      expect(result.value).toBeUndefined();
      expect(result.error).toContain("Missing");
    });

    it("keeps a text root's completion and rendering unchanged", function* () {
      const result = yield* run({ "doc.md": "# Title\n" });
      expect(said(result)).toContain("# Title");
      expect(result.output).toContain("# Title");
    });
  });

  describe("replay", () => {
    it("replays a value root's value and body output without re-executing", function* () {
      const stream = new InMemoryStream();
      const document = [
        "---",
        "returns:",
        "  passed: { type: boolean }",
        "---",
        "",
        "BODY TEXT",
        "",
        "```sh exec",
        "echo SIDE_EFFECT",
        "```",
        "",
        "```js eval",
        "const produced = { passed: true };",
        "```",
        "",
        "<Return value={produced} />",
        "",
      ].join("\n");

      const golden = yield* run({ "doc.md": document }, stream);
      expect(golden.value).toEqual({ passed: true });
      expect(golden.commands).toEqual(["echo SIDE_EFFECT"]);

      const replayed = yield* run({ "doc.md": document }, stream);
      expect(replayed.value).toEqual({ passed: true });
      expect(replayed.output).toContain("BODY TEXT");
      expect(replayed.commands).toEqual([]);
    });

    it("replays a captured component value and a text root's output", function* () {
      const stream = new InMemoryStream();
      const files = {
        "doc.md": CAPTURING_ROOT,
        "Verdict.md": valueComponent("returns:\n  passed: { type: boolean }", "({ passed: true })"),
      };

      const golden = yield* run(files, stream);
      const replayed = yield* run(files, stream);
      expect(asText(golden.value ?? "")).toContain('captured: {"passed":true}');
      expect(asText(replayed.value ?? "")).toEqual(asText(golden.value ?? ""));
      expect(replayed.output).toEqual(golden.output);
    });
  });

  describe("schema compilation", () => {
    it("keeps props and return contracts independent for the same schema object", function* () {
      const compiledAsReturnFirst = { type: "string" };
      yield* compileReturnsSchema(compiledAsReturnFirst);
      expect(yield* raised(() => compilePropsSchema(compiledAsReturnFirst))).toBeInstanceOf(
        PropsSchemaError,
      );

      const compiledAsPropsFirst = { type: "string" };
      expect(yield* raised(() => compilePropsSchema(compiledAsPropsFirst))).toBeInstanceOf(
        PropsSchemaError,
      );
      expect(yield* validateReturnValue("Verdict", "shipped", compiledAsPropsFirst)).toBe(
        "shipped",
      );
    });
  });
});
