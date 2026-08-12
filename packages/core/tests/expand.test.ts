import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component, content } from "../src/component-api.ts";
import { printErrors } from "../src/component-failures.ts";
import { scanSegments } from "../src/scanner.ts";
import { interpolate } from "../src/interpolate.ts";
import { validateProps, PropValidationError } from "../src/validate.ts";
import { renderSegments } from "../src/render.ts";
import type { Operation } from "effection";
import { DocumentationError } from "../src/errors.ts";
import type {
  Segment,
  ComponentDefinition,
  CodeBlockContext,
  EvalEnv,
  FunctionComponentDefinition,
  Json,
  CodeBlockResult,
} from "../src/types.ts";

/**
 * What the `applyModifiers` stub answers a block with: one result for every
 * block, or a function that answers each block from its own content — which is
 * how a test observes whether a later block ran at all.
 */
type CodeResultStub = CodeBlockResult | ((block: CodeBlockContext) => CodeBlockResult);

function makeComponent(
  name: string,
  body: string,
  opts: {
    meta?: Record<string, unknown>;
    props?: Record<string, any>;
  } = {},
): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: opts.meta ?? {},
    props: opts.props ?? { type: "object", properties: {}, additionalProperties: false },
    bodySegments: scanSegments(body),
  };
}

/** Install test component + modifier providers on the current scope. */
function useTestComponents(
  components: Record<string, ComponentDefinition | FunctionComponentDefinition>,
  codeResult?: CodeResultStub,
): Operation<void> {
  return Component.around(
    {
      // deno-lint-ignore require-yield
      *importComponent([name], _next) {
        const comp = components[name];
        if (!comp) {
          throw new Error(`Component not found: ${name}`);
        }
        return comp;
      },
      // deno-lint-ignore require-yield
      *applyModifiers([_modifiers, block], _next) {
        if (typeof codeResult === "function") {
          return codeResult(block);
        }
        return (
          codeResult ?? {
            output: "mock output\n",
            exitCode: 0,
            stderr: "",
          }
        );
      },
    },
    { at: "min" },
  );
}

/**
 * `<Broken />` — a component that fails, which plants an ErrorSegment inside a
 * region so the region's error mode is what settles it. It prints, so the failure
 * becomes one reported printed error rather than stopping the expansion the
 * assertion is about.
 */
const BROKEN: FunctionComponentDefinition = {
  kind: "function",
  name: "Broken",
  props: { type: "object", properties: {}, additionalProperties: false },
  // deno-lint-ignore require-yield
  fn: printErrors(function* () {
    throw new Error("broken thing");
  }),
};

/**
 * A function component that renders its invocation content through the
 * canonical `content()` operation, so its content failures cross the
 * component-consumer boundary the way any TypeScript component's do.
 */
const echoComponent: FunctionComponentDefinition = {
  kind: "function",
  name: "Echo",
  props: { type: "object", properties: {}, additionalProperties: false },
  fn: () => content(),
};

/** Install a binding environment on the current scope. */
function useTestEnv(testEnv: EvalEnv): Operation<void> {
  return Component.around({ env: () => testEnv }, { at: "min" });
}

function expand(
  segments: Segment[],
  components: Record<string, ComponentDefinition | FunctionComponentDefinition>,
  opts: {
    meta?: Record<string, unknown>;
    props?: Record<string, Json>;
    codeResult?: CodeResultStub;
  } = {},
): Operation<string> {
  return scoped(function* () {
    yield* useTestComponents(components, opts.codeResult);
    yield* useTestEnv({ values: {} });
    const expanded = yield* expandSegments(segments, opts.meta ?? {}, opts.props ?? {}, new Set());
    return renderSegments(expanded);
  });
}

/** The message an expansion failed with, for a document the contract fails. */
function failed(body: () => Operation<unknown>): Operation<string> {
  return scoped(function* () {
    try {
      yield* body();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the expansion to fail");
  });
}

/**
 * The same expansion, stopping at the segments rather than their rendering, so
 * a test can assert the shape and the order the engine produced rather than the
 * string it flattens to.
 */
function expandToSegments(
  segments: Segment[],
  components: Record<string, ComponentDefinition | FunctionComponentDefinition>,
  codeResult?: CodeResultStub,
): Operation<Segment[]> {
  return scoped(function* () {
    yield* useTestComponents(components, codeResult);
    yield* useTestEnv({ values: {} });
    return yield* expandSegments(segments, {}, {}, new Set());
  });
}

function expandWithEnv(
  segments: Segment[],
  components: Record<string, ComponentDefinition | FunctionComponentDefinition>,
  codeResult?: CodeResultStub,
): Operation<{ output: string; env: Record<string, unknown>; failure: string | undefined }> {
  return scoped(function* () {
    const testEnv: EvalEnv = { values: {} };
    yield* useTestComponents(components, codeResult);
    yield* useTestEnv(testEnv);
    // A checked command failure ends the expansion (#441). The environment is
    // still this frame's, so what the run did or did not bind stays readable.
    try {
      const expanded = yield* expandSegments(segments, {}, {}, new Set());
      return { output: renderSegments(expanded), env: testEnv.values, failure: undefined };
    } catch (error) {
      return {
        output: "",
        env: testEnv.values,
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** The failure an operation raised, so an assertion can read it. */
function* raised(operation: () => Operation<unknown>): Operation<unknown> {
  try {
    yield* operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

describe("expansion", () => {
  // C1: Basic expansion
  it("C1: basic expansion — component body in output", function* () {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = { Greeting: comp };
    const segments = scanSegments("<Greeting />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello world!");
  });

  // C2: Content slot
  it("C2: content slot — children at <Content /> position", function* () {
    const comp = makeComponent("Wrap", "Before <Content /> After");
    const ctx = { Wrap: comp };
    const segments = scanSegments("<Wrap>middle</Wrap>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Before middle After");
  });

  // C3: Nested expansion
  it("C3: nested expansion — A contains B", function* () {
    const compB = makeComponent("B", "inner");
    const compA = makeComponent("A", "outer <B /> end");
    const ctx = { A: compA, B: compB };
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("outer inner end");
  });

  // C4: Transitive expansion — A→B→C
  it("C4: transitive expansion — A references B references C", function* () {
    const compC = makeComponent("C", "leaf");
    const compB = makeComponent("B", "mid(<C />)");
    const compA = makeComponent("A", "top(<B />)");
    const ctx = { A: compA, B: compB, C: compC };
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("top(mid(leaf))");
  });

  // C5: Direct cycle
  it("C5: direct cycle — A contains A → ErrorSegment", function* () {
    const compA = makeComponent("A", "start <A /> end");
    const ctx = { A: compA };
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("Cycle detected");
  });

  // C6: Mutual cycle — A→B→A
  it("C6: mutual cycle — A→B→A → ErrorSegment", function* () {
    const compA = makeComponent("A", "a(<B />)");
    const compB = makeComponent("B", "b(<A />)");
    const ctx = { A: compA, B: compB };
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("Cycle detected");
  });

  // C8: Frontmatter interpolation
  it("C8: frontmatter interpolation — {meta.title}", function* () {
    const comp = makeComponent("Page", "Title: {meta.title}", {
      meta: { title: "My Page" },
    });
    const ctx = { Page: comp };
    const segments = scanSegments("<Page />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Title: My Page");
  });

  // C9: Props interpolation
  it("C9: props interpolation — {props.name}", function* () {
    const comp = makeComponent("Greeting", "Hello, {props.name}!", {
      props: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    });
    const ctx = { Greeting: comp };
    const segments = scanSegments('<Greeting name="world" />');
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello, world!");
  });

  // C10: Missing interpolation key → empty string
  it("C10: missing interpolation key → empty string", function* () {
    const comp = makeComponent("Comp", "value: {meta.nonexistent}");
    const ctx = { Comp: comp };
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("value: ");
  });

  // C11: Nested key access
  it("C11: nested key access — {meta.config.db.host}", function* () {
    const comp = makeComponent("Comp", "host: {meta.config.db.host}", {
      meta: { config: { db: { host: "localhost" } } },
    });
    const ctx = { Comp: comp };
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("host: localhost");
  });

  // C12: No Content slot — children silently discarded
  it("C12: no Content slot — children silently discarded", function* () {
    const comp = makeComponent("NoSlot", "fixed content");
    const ctx = { NoSlot: comp };
    const segments = scanSegments("<NoSlot>ignored</NoSlot>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("fixed content");
  });

  // C13: Multiple Content slots
  it("C13: multiple Content slots — each replaced with same children", function* () {
    const comp = makeComponent("Multi", "first: <Content /> second: <Content />");
    const ctx = { Multi: comp };
    const segments = scanSegments("<Multi>stuff</Multi>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("first: stuff second: stuff");
  });

  // C16: Default applied
  it("C16: default applied — props.greeting resolves to default", function* () {
    const comp = makeComponent("Greeting", "{props.greeting}, world!", {
      props: {
        type: "object",
        properties: { greeting: { type: "string", default: "Hello" } },
        additionalProperties: false,
      },
    });
    const ctx = { Greeting: comp };
    const segments = scanSegments("<Greeting />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello, world!");
  });

  // C20: No props, no props — valid
  it("C20: no props, no props — valid", function* () {
    const comp = makeComponent("Badge", "badge");
    const ctx = { Badge: comp };
    const segments = scanSegments("<Badge />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("badge");
  });

  // C22: Optional with no default, not passed → empty string
  it("C22: optional with no default, not passed → empty in interpolation", function* () {
    const comp = makeComponent("Comp", "val:{props.opt}", {
      props: {
        type: "object",
        properties: { opt: { type: "string" } },
        additionalProperties: false,
      },
    });
    const ctx = { Comp: comp };
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("val:");
  });

  // Code block expansion
  it("code block expansion via modifier chain", function* () {
    const segments = scanSegments("```bash exec\necho hello\n```\n");
    const output = yield* expand(
      segments,
      {},
      {
        codeResult: { output: "hello\n", exitCode: 0, stderr: "" },
      },
    );
    expect(output).toBe("hello\n");
  });

  // Code block with non-zero exit
  // A nonzero exit is checked: it ends the expansion rather than rendering a
  // diagnostic and continuing (#441).
  it("code block with non-zero exit → the expansion fails", function* () {
    const segments = scanSegments("```bash exec\nfoo\n```\n");
    const message = yield* failed(() =>
      expand(segments, {}, { codeResult: { output: "", exitCode: 1, stderr: "not found" } }),
    );
    expect(message).toContain("not found");
  });

  // The command's stdout reached the reader before it failed; the expansion
  // then fails rather than rendering the pair (#441).
  it("code block with non-zero exit and stdout → the expansion fails", function* () {
    const segments = scanSegments("```bash exec\nfoo\n```\n");
    const message = yield* failed(() =>
      expand(segments, {}, { codeResult: { output: "partial\n", exitCode: 1, stderr: "boom" } }),
    );
    expect(message).toContain("boom");
  });

  it("produces no rendered pair for a failed foreground block", function* () {
    const message = yield* failed(() =>
      expandToSegments(
        scanSegments("```bash exec\nfoo\n```\n"),
        {},
        {
          output: "partial\n",
          exitCode: 1,
          stderr: "boom",
        },
      ),
    );
    expect(message).toContain("boom");
  });

  // Silent code block → no output
  it("silent code block produces no output", function* () {
    const segments = scanSegments("```bash silent exec\necho hello\n```\n");
    const output = yield* expand(
      segments,
      {},
      {
        codeResult: { output: "", exitCode: 0, stderr: "" },
      },
    );
    expect(output).toBe("");
  });

  it("captures component output with as", function* () {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = { Greeting: comp };
    const segments = scanSegments('<Greeting as="saved" />');
    const { output, env, failure } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["saved"]).toBe("Hello world!");
  });

  it("Capture stores children output into env and stays silent", function* () {
    const ctx = {};
    const segments = scanSegments('<Capture as="x">hello\n</Capture>');
    const { output, env, failure } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["x"]).toBe("hello");
  });

  // A capture never swallows an error, and a block that printed before it
  // failed is still a failure (#307) — so what it printed must not reach the
  // binding as though it were a value. This pins the existing contract against
  // the new segment shape; #309 owns failed-capture output visibility.
  it("Capture leaves the binding unset when a block failed after printing", function* () {
    const segments = scanSegments('<Capture as="x">\n```bash exec\nfoo\n```\n</Capture>');
    const { output, env, failure } = yield* expandWithEnv(
      segments,
      {},
      {
        output: "partial\n",
        exitCode: 1,
        stderr: "boom",
      },
    );
    expect(env["x"]).toBeUndefined();
    expect(failure).toContain("Command failed (exit 1): boom");
    expect(output).toBe("");
  });

  it("component as= leaves the binding unset when a block failed after printing", function* () {
    const comp = makeComponent("Preview", "```bash exec\nfoo\n```\n");
    const segments = scanSegments('<Preview as="saved" />');
    const { output, env, failure } = yield* expandWithEnv(
      segments,
      { Preview: comp },
      {
        output: "partial\n",
        exitCode: 1,
        stderr: "boom",
      },
    );
    expect(env["saved"]).toBeUndefined();
    expect(failure).toContain("Command failed (exit 1): boom");
    expect(output).toBe("");
  });

  it("Capture rejects expression as prop", function* () {
    const ctx = {};
    const segments = scanSegments("<Capture as={name}>text</Capture>");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must be a string literal");
  });

  it("Capture rejects self-closing usage", function* () {
    const ctx = {};
    const segments = scanSegments('<Capture as="x" />');
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must have content");
  });

  it("Capture rejects extra props", function* () {
    const ctx = {};
    const segments = scanSegments('<Capture as="x" slot="y">text</Capture>');
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain('only accepts "as" and "select" props');
  });

  it("Capture with select extracts code block by CSS selector", function* () {
    const ctx = {};
    const segments = scanSegments(
      '<Capture as="data" select="code[lang=json]">prose text\n\n```json\n{"key":"val"}\n```\n\nmore prose\n</Capture>',
    );
    const { output, env, failure } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["data"]).toBe('{"key":"val"}');
  });

  it("Capture with select falls back to full content when no match", function* () {
    const ctx = {};
    const segments = scanSegments(
      '<Capture as="data" select="code[lang=json]">no code here\n</Capture>',
    );
    const { output, env, failure } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["data"]).toBe("no code here");
  });

  it("Capture with select extracts paragraph text", function* () {
    const ctx = {};
    const segments = scanSegments('<Capture as="data" select="paragraph">Hello world\n</Capture>');
    const { output, env, failure } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["data"]).toBe("Hello world");
  });

  it("Capture accepts select alongside as without error", function* () {
    const ctx = {};
    const segments = scanSegments('<Capture as="x" select="paragraph">text\n</Capture>');
    const output = yield* expand(segments, ctx);
    expect(output).not.toContain("ERROR");
  });

  it("component as rejects expression prop", function* () {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = { Greeting: comp };
    const segments = scanSegments("<Greeting as={name} />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must be a string literal");
  });
});

/**
 * Install a recording applyModifiers provider and return the captured
 * code-block contents. Installed after useTestComponents in the same scope,
 * so it wins (later-installed min middleware runs first).
 */
function* useRecordingModifiers(codeResult?: CodeBlockResult): Operation<string[]> {
  const execCalls: string[] = [];
  yield* Component.around(
    {
      // deno-lint-ignore require-yield
      *applyModifiers([_modifiers, block], _next) {
        execCalls.push(block.content);
        return codeResult ?? { output: "ran\n", exitCode: 0, stderr: "" };
      },
    },
    { at: "min" },
  );
  return execCalls;
}

function recordingExpand(
  segments: Segment[],
  components: Record<string, ComponentDefinition | FunctionComponentDefinition>,
  codeResult?: CodeBlockResult,
): Operation<{ output: string; execCalls: string[] }> {
  return scoped(function* () {
    yield* useTestComponents(components);
    const execCalls = yield* useRecordingModifiers(codeResult);
    yield* useTestEnv({ values: {} });
    const expanded = yield* expandSegments(segments, {}, {}, new Set());
    return { output: renderSegments(expanded), execCalls };
  });
}

describe("component-declared output", () => {
  it("renders only the <Output> region, suppressing documentation", function* () {
    const comp = makeComponent(
      "Warn",
      "Docs heading.\n\n<Output>\nSHOWN\n</Output>\n\nMore docs.\n",
    );
    const ctx = { Warn: comp };
    const output = yield* expand(scanSegments("<Warn />"), ctx);
    expect(output).toContain("SHOWN");
    expect(output).not.toContain("Docs heading");
    expect(output).not.toContain("More docs");
  });

  it("without <Output> renders the complete body", function* () {
    const comp = makeComponent("Doc", "Alpha then Beta.");
    const ctx = { Doc: comp };
    const output = yield* expand(scanSegments("<Doc />"), ctx);
    expect(output).toContain("Alpha then Beta.");
  });

  it("concatenates multiple <Output> regions in document order", function* () {
    const comp = makeComponent(
      "Multi",
      "<Output>ONE</Output>\n\nmiddle docs\n\n<Output>TWO</Output>\n",
    );
    const ctx = { Multi: comp };
    const output = yield* expand(scanSegments("<Multi />"), ctx);
    expect(output).not.toContain("middle docs");
    expect(output.indexOf("ONE")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("ONE")).toBeLessThan(output.indexOf("TWO"));
  });

  it("preserves markdown source inside <Output>, including a GitHub admonition", function* () {
    const comp = makeComponent(
      "Adm",
      "docs\n\n<Output>\n> [!WARNING]\n> Careful now.\n</Output>\n",
    );
    const ctx = { Adm: comp };
    const output = yield* expand(scanSegments("<Adm />"), ctx);
    expect(output).toContain("> [!WARNING]");
    expect(output).toContain("> Careful now.");
    expect(output).not.toContain("docs");
  });

  it("treats <Output /> and <Output></Output> as equivalent empty output", function* () {
    const selfClosing = makeComponent("A", "before\n\n<Output />\n\nafter");
    const paired = makeComponent("B", "before\n\n<Output></Output>\n\nafter");
    const ctx = { A: selfClosing, B: paired };
    const a = yield* expand(scanSegments("<A />"), ctx);
    const b = yield* expand(scanSegments("<B />"), ctx);
    expect(a.trim()).toBe("");
    expect(b.trim()).toBe("");
  });

  it("rejects props on <Output>", function* () {
    const comp = makeComponent("Bad", '<Output foo="bar">x</Output>');
    const ctx = { Bad: comp };
    const output = yield* expand(scanSegments("<Bad />"), ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("accepts no props");
  });

  it("rejects expression props on <Output>", function* () {
    const comp = makeComponent("Bad", "<Output when={x}>y</Output>");
    const ctx = { Bad: comp };
    const output = yield* expand(scanSegments("<Bad />"), ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("accepts no props");
  });

  it("projects caller content through <Content /> inside <Output>", function* () {
    const comp = makeComponent("Wrap", "docs\n\n<Output>\n<Content />\n</Output>\n");
    const ctx = { Wrap: comp };
    const output = yield* expand(scanSegments("<Wrap>PROJECTED</Wrap>"), ctx);
    expect(output).toContain("PROJECTED");
    expect(output).not.toContain("docs");
  });

  it("lets an <Output> region read a binding recorded by preceding documentation", function* () {
    const comp = makeComponent(
      "Dep",
      '<Capture as="msg">HELLO</Capture>\n\n<Output>msg={msg}</Output>',
    );
    const ctx = { Dep: comp };
    const output = yield* expand(scanSegments("<Dep />"), ctx);
    expect(output).toContain("msg=HELLO");
  });

  it("executes exec blocks outside <Output> but suppresses their output", function* () {
    const comp = makeComponent("Ex", "```bash exec\nDOCRUN\n```\n\n<Output>ok</Output>\n");
    const { output, execCalls } = yield* recordingExpand(scanSegments("<Ex />"), { Ex: comp });
    expect(execCalls.some((c) => c.includes("DOCRUN"))).toBe(true);
    expect(output).toContain("ok");
    expect(output).not.toContain("ran");
  });

  it("executes documentation after an <Output> region", function* () {
    const comp = makeComponent("Post", "<Output>ok</Output>\n\n```bash exec\nAFTER\n```\n");
    const { output, execCalls } = yield* recordingExpand(scanSegments("<Post />"), { Post: comp });
    expect(execCalls.some((c) => c.includes("AFTER"))).toBe(true);
    expect(output).toContain("ok");
  });

  it("fails on an error inside an <Output> region", function* () {
    const comp = makeComponent("Err", "<Output>\nbefore\n<Bogus />\nafter\n</Output>");
    const ctx = { Err: comp };
    let threw = false;
    try {
      yield* expand(scanSegments("<Err />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("keeps an error inside an <Output> region as a comment under <PrintErrors>", function* () {
    const comp = makeComponent(
      "Err",
      "<Output>\n<PrintErrors>\n<Bogus />\n</PrintErrors>\nafter\n</Output>",
    );
    const ctx = { Err: comp };
    const output = yield* expand(scanSegments("<Err />"), ctx);
    expect(output).toContain("<!-- ERROR");
    expect(output).toContain("Failed to import component Bogus");
    // The region carried on: printing decided the error, so nothing stopped.
    expect(output).toContain("after");
  });

  it("keeps errors as comments when no <Output> is declared", function* () {
    const comp = makeComponent("NoOut", "<Bogus />");
    const ctx = { NoOut: comp };
    const output = yield* expand(scanSegments("<NoOut />"), ctx);
    expect(output).toContain("<!-- ERROR");
  });

  // --- Fail-fast in documentation ---

  it("throws on a failing exec block in documentation", function* () {
    const comp = makeComponent("Fail", "```bash exec\nboom\n```\n\n<Output>ok</Output>\n");
    let threw = false;
    try {
      yield* expand(
        scanSegments("<Fail />"),
        { Fail: comp },
        {
          codeResult: { output: "", exitCode: 1, stderr: "nope" },
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // The same fail-fast, for a command that printed before it failed (#307).
  // What the printing costs is the whole point: without it, a failed preview
  // reaches the step after it.
  it("throws on a failing exec block that printed in documentation", function* () {
    const comp = makeComponent(
      "Fail",
      "```bash exec\npreview\n```\n\n```bash exec\nlater\n```\n\n<Output>ok</Output>\n",
    );
    const ran: string[] = [];
    let output: string | undefined;
    let caught: unknown;
    try {
      output = yield* expand(
        scanSegments("<Fail />"),
        { Fail: comp },
        {
          codeResult: (block) => {
            ran.push(block.content.trim());
            return block.content.includes("preview")
              ? { output: "partial\n", exitCode: 1, stderr: "boom" }
              : { output: "later ran\n", exitCode: 0, stderr: "" };
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    // The ambient error mode decided this execution fails, so what surfaces is the
    // documentation failure and not a printed error.
    if (!(caught instanceof DocumentationError)) {
      throw new Error(`expected DocumentationError, received ${String(caught)}`);
    }
    expect(caught.message).toContain("Command failed (exit 1)");
    // The later sibling never ran.
    expect(ran).toEqual(["preview"]);
    // And nothing came back as a successful document result.
    expect(output).toBeUndefined();
  });

  it("continues when a modifier handles the failure in documentation", function* () {
    const comp = makeComponent("Handled", "```bash exec\nrecover\n```\n\n<Output>ok</Output>\n");
    const output = yield* expand(
      scanSegments("<Handled />"),
      { Handled: comp },
      {
        codeResult: { output: "recovered\n", exitCode: 0, stderr: "" },
      },
    );
    expect(output).toContain("ok");
  });

  it("renders a failing component's error inside <Output> under the printing error mode", function* () {
    const comp = makeComponent("Region", "<Output>\n<Broken />\n</Output>");
    const output = yield* expand(scanSegments("<Region />"), { Region: comp, Broken: BROKEN });
    expect(output).toContain("broken thing");
  });

  it("throws a failing component's error from documentation, where errors are fatal", function* () {
    const comp = makeComponent("Doc", "<Broken />\n\n<Output>ok</Output>");
    let threw = false;
    try {
      yield* expand(scanSegments("<Doc />"), { Doc: comp, Broken: BROKEN });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("throws on a failure inside <Capture> documentation", function* () {
    const comp = makeComponent(
      "CapFail",
      '<Capture as="x">\n<Bogus />\n</Capture>\n\n<Output>ok</Output>',
    );
    const ctx = { CapFail: comp };
    let threw = false;
    try {
      yield* expand(scanSegments("<CapFail />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // --- Consumer boundary: transported errors ---

  it("throws when a child's Output error is consumed from parent documentation", function* () {
    const child = makeComponent("Child", "<Output>\n<Bogus />\n</Output>");
    const parent = makeComponent("P", "<Child />\n\n<Output>tail</Output>");
    const ctx = { Child: child, P: parent };
    let threw = false;
    try {
      yield* expand(scanSegments("<P />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("stops a parent's region when a child's own region fails inside it", function* () {
    const child = makeComponent("Child", "<Output>\n<Bogus />\n</Output>");
    const parent = makeComponent("P", "<Output>\n<Child />\ntail\n</Output>");
    const ctx = { Child: child, P: parent };
    let threw = false;
    try {
      yield* expand(scanSegments("<P />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("renders a child's printed error as a comment when consumed inside parent Output", function* () {
    const child = makeComponent(
      "Child",
      "<Output>\n<PrintErrors>\n<Bogus />\n</PrintErrors>\n</Output>",
    );
    const parent = makeComponent("P", "<Output>\n<Child />\ntail\n</Output>");
    const ctx = { Child: child, P: parent };
    const output = yield* expand(scanSegments("<P />"), ctx);
    expect(output).toContain("<!-- ERROR");
    expect(output).toContain("Failed to import component Bogus");
    // The child decided this error once, where it was raised. The parent reads
    // data, so its own region is unaffected.
    expect(output).toContain("tail");
  });

  it("throws before storing an as= binding that captured a child's Output error", function* () {
    const child = makeComponent("Child", "<Output>\n<Bogus />\n</Output>");
    const parent = makeComponent("P", '<Child as="captured" />\n\n<Output>tail</Output>');
    const ctx = { Child: child, P: parent };
    let threw = false;
    try {
      yield* expand(scanSegments("<P />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("throws when a function component's content error is consumed from parent documentation", function* () {
    const child = makeComponent("Child", "<Output>\n<Echo>\n<Bogus />\n</Echo>\n</Output>");
    const parent = makeComponent("P", "<Child />\n\n<Output>tail</Output>");
    const ctx = { Child: child, Echo: echoComponent, P: parent };
    let threw = false;
    try {
      yield* expand(scanSegments("<P />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("renders a function component's printed content error once inside parent Output", function* () {
    const child = makeComponent(
      "Child",
      "<Output>\n<PrintErrors>\n<Echo>\n<Bogus />\n</Echo>\n</PrintErrors>\n</Output>",
    );
    const parent = makeComponent("P2", "<Output>\n<Child />\n</Output>");
    const ctx = { Child: child, Echo: echoComponent, P2: parent };
    const output = yield* expand(scanSegments("<P2 />"), ctx);
    expect(output).toContain("<!-- ERROR");
    expect(output.match(/Failed to import component Bogus/g) ?? []).toHaveLength(1);
  });

  it("fails a region on a function component's uncaptured content error", function* () {
    const child = makeComponent("Child", "<Output>\n<Echo>\n<Bogus />\n</Echo>\n</Output>");
    const parent = makeComponent("P3", "<Output>\n<Child />\ntail\n</Output>");
    const ctx = { Child: child, Echo: echoComponent, P3: parent };
    let threw = false;
    try {
      yield* expand(scanSegments("<P3 />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // --- Structural preflight ---

  it("aggregates a nested <Output> into one printed error and runs no side effects", function* () {
    const comp = makeComponent(
      "Struct",
      "```bash exec\nSIDE\n```\n\n<Wrapper>\n<Output>x</Output>\n</Wrapper>\n",
    );
    const { output, execCalls } = yield* recordingExpand(scanSegments("<Struct />"), {
      Struct: comp,
    });
    expect(output).toContain("must be a direct top-level");
    expect(execCalls).toHaveLength(0);
  });

  it("aggregates every misplaced <Output> into a single printed error", function* () {
    const comp = makeComponent(
      "Many",
      "<A>\n<Output>one</Output>\n</A>\n\n<B>\n<Output>two</Output>\n</B>\n",
    );
    const ctx = { Many: comp };
    const output = yield* expand(scanSegments("<Many />"), ctx);
    const errorComments = output.match(/<!-- ERROR/g) ?? [];
    expect(errorComments).toHaveLength(1);
    expect(output).toContain("one");
    expect(output).toContain("two");
  });

  it("diagnoses a nested <Output> inside <If condition={false}>", function* () {
    const comp = makeComponent("Hidden", "<If condition={false}>\n<Output>hidden</Output>\n</If>");
    const ctx = { Hidden: comp };
    const output = yield* expand(scanSegments("<Hidden />"), ctx);
    expect(output).toContain("must be a direct top-level");
  });

  it("diagnoses a nested <Output> passed to a component that discards content", function* () {
    const comp = makeComponent("Discard", "<NoContent>\n<Output>x</Output>\n</NoContent>");
    const ctx = { Discard: comp };
    const output = yield* expand(scanSegments("<Discard />"), ctx);
    expect(output).toContain("must be a direct top-level");
  });

  it("throws a structural printed error when an invalid child is used from documentation", function* () {
    const child = makeComponent("BadChild", "<Wrapper>\n<Output>x</Output>\n</Wrapper>");
    const parent = makeComponent("P", "<BadChild />\n\n<Output>tail</Output>");
    const ctx = { BadChild: child, P: parent };
    let threw = false;
    try {
      yield* expand(scanSegments("<P />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("validateProps", () => {
  const closed = (properties: Record<string, Json>, required?: string[]): Record<string, Json> => ({
    type: "object",
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  });

  // C14: Undeclared prop rejected
  it("C14: undeclared prop → PropValidationError", function* () {
    expect(
      String(yield* raised(() => validateProps("Comp", { foo: "bar" }, closed({})))),
    ).toContain("must NOT have additional properties");
  });

  // C15: Required prop missing
  it("C15: required prop missing → PropValidationError", function* () {
    expect(
      String(
        yield* raised(() =>
          validateProps("Comp", {}, closed({ name: { type: "string" } }, ["name"])),
        ),
      ),
    ).toContain("must have required property");
  });

  // C17: Type mismatch rejected
  it("C17: type mismatch → PropValidationError", function* () {
    expect(
      String(
        yield* raised(() =>
          validateProps("Comp", { count: "abc" }, closed({ count: { type: "number" } })),
        ),
      ),
    ).toContain("must be number");
  });

  // C18: Enum validated — invalid value
  it("C18: enum invalid value → PropValidationError", function* () {
    expect(
      String(
        yield* raised(() =>
          validateProps(
            "Comp",
            { model: "bad" },
            closed({ model: { type: "string", enum: ["a", "b"] } }),
          ),
        ),
      ),
    ).toContain("must be equal to one of the allowed values");
  });

  // C19: Enum accepted — valid value
  it("C19: enum valid value → accepted", function* () {
    const result = yield* validateProps(
      "Comp",
      { model: "a" },
      closed({ model: { type: "string", enum: ["a", "b"] } }),
    );
    expect(result["model"]).toBe("a");
  });

  // C21: No props, some props → error
  it("C21: no props, some props → PropValidationError", function* () {
    expect(yield* raised(() => validateProps("Badge", { size: "lg" }, closed({})))).toBeInstanceOf(
      PropValidationError,
    );
  });

  it("applies default when prop not provided", function* () {
    const result = yield* validateProps(
      "Comp",
      {},
      closed({ greeting: { type: "string", default: "Hello" } }),
    );
    expect(result["greeting"]).toBe("Hello");
  });
});

describe("interpolate", () => {
  it("replaces meta references", function* () {
    expect(interpolate("{meta.title}", { title: "Hello" }, {})).toBe("Hello");
  });

  it("replaces props references", function* () {
    expect(interpolate("{props.name}", {}, { name: "world" })).toBe("world");
  });

  it("missing key → empty string", function* () {
    expect(interpolate("{meta.nope}", {}, {})).toBe("");
  });

  it("array → comma-joined", function* () {
    expect(interpolate("{meta.tags}", { tags: ["a", "b", "c"] }, {})).toBe("a, b, c");
  });

  it("nested access", function* () {
    expect(interpolate("{meta.a.b.c}", { a: { b: { c: "deep" } } }, {})).toBe("deep");
  });

  it("escaped braces → literal", function* () {
    expect(interpolate("\\{meta.title}", { title: "Hello" }, {})).toBe("{meta.title}");
  });
});

describe("function component content", () => {
  it("renders default content and a named slot via content", function* () {
    const card: FunctionComponentDefinition = {
      kind: "function",
      name: "Card",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(_props) {
        const header = yield* content("header");
        const body = yield* content();
        return `[${header.trim()}|${body.trim()}]`;
      },
    };
    const note = makeComponent("Note", "HEADER");
    const segments = scanSegments('<Card>\n<Note slot="header" />\nBODY\n</Card>');
    const output = yield* expand(segments, { Card: card, Note: note });
    expect(output).toBe("[HEADER|BODY]");
  });
});
