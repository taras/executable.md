import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { interpolate } from "../src/interpolate.ts";
import { validateProps, PropValidationError } from "../src/validate.ts";
import { renderSegments } from "../src/render.ts";
import type { Operation } from "effection";
import { ephemeral } from "@executablemd/durable-streams";
import { useContent } from "../src/content-context.ts";
import type {
  Segment,
  ComponentDefinition,
  EvalEnv,
  FunctionComponentDefinition,
  Json,
  CodeBlockResult,
} from "../src/types.ts";

function makeComponent(
  name: string,
  body: string,
  opts: {
    meta?: Record<string, unknown>;
    inputs?: Record<string, any>;
  } = {},
): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: opts.meta ?? {},
    inputs: opts.inputs ?? { type: "object", properties: {}, additionalProperties: false },
    bodySegments: scanSegments(body),
  };
}

/** Install test component + modifier providers on the current scope. */
function useTestComponents(
  components: Record<string, ComponentDefinition | FunctionComponentDefinition>,
  codeResult?: CodeBlockResult,
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
      *applyModifiers(_args, _next) {
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
    codeResult?: CodeBlockResult;
  } = {},
): Operation<string> {
  return scoped(function* () {
    yield* useTestComponents(components, opts.codeResult);
    yield* useTestEnv({ values: {} });
    const expanded = yield* expandSegments(segments, opts.meta ?? {}, opts.props ?? {}, new Set());
    return renderSegments(expanded);
  });
}

function expandWithEnv(
  segments: Segment[],
  components: Record<string, ComponentDefinition | FunctionComponentDefinition>,
  codeResult?: CodeBlockResult,
): Operation<{ output: string; env: Record<string, unknown> }> {
  return scoped(function* () {
    const testEnv: EvalEnv = { values: {} };
    yield* useTestComponents(components, codeResult);
    yield* useTestEnv(testEnv);
    const expanded = yield* expandSegments(segments, {}, {}, new Set());
    return { output: renderSegments(expanded), env: testEnv.values };
  });
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
      inputs: {
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
      inputs: {
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

  // C20: No inputs, no props — valid
  it("C20: no inputs, no props — valid", function* () {
    const comp = makeComponent("Badge", "badge");
    const ctx = { Badge: comp };
    const segments = scanSegments("<Badge />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("badge");
  });

  // C22: Optional with no default, not passed → empty string
  it("C22: optional with no default, not passed → empty in interpolation", function* () {
    const comp = makeComponent("Comp", "val:{props.opt}", {
      inputs: {
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
  it("code block with non-zero exit → error", function* () {
    const segments = scanSegments("```bash exec\nfoo\n```\n");
    const output = yield* expand(
      segments,
      {},
      {
        codeResult: { output: "", exitCode: 1, stderr: "not found" },
      },
    );
    expect(output).toContain("ERROR");
    expect(output).toContain("not found");
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
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["saved"]).toBe("Hello world!");
  });

  it("Capture stores children output into env and stays silent", function* () {
    const ctx = {};
    const segments = scanSegments('<Capture as="x">hello\n</Capture>');
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["x"]).toBe("hello");
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
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["data"]).toBe('{"key":"val"}');
  });

  it("Capture with select falls back to full content when no match", function* () {
    const ctx = {};
    const segments = scanSegments(
      '<Capture as="data" select="code[lang=json]">no code here\n</Capture>',
    );
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["data"]).toBe("no code here");
  });

  it("Capture with select extracts paragraph text", function* () {
    const ctx = {};
    const segments = scanSegments('<Capture as="data" select="paragraph">Hello world\n</Capture>');
    const { output, env } = yield* expandWithEnv(segments, ctx);
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

  it("keeps errors inside an <Output> region as comments", function* () {
    const comp = makeComponent("Err", "<Output>\n<Bogus />\n</Output>");
    const ctx = { Err: comp };
    const output = yield* expand(scanSegments("<Err />"), ctx);
    expect(output).toContain("<!-- ERROR");
    expect(output).toContain("Failed to import component Bogus");
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

  it("renders a child's Output error as a comment when consumed inside parent Output", function* () {
    const child = makeComponent("Child", "<Output>\n<Bogus />\n</Output>");
    const parent = makeComponent("P", "<Output>\n<Child />\n</Output>");
    const ctx = { Child: child, P: parent };
    const output = yield* expand(scanSegments("<P />"), ctx);
    expect(output).toContain("<!-- ERROR");
    expect(output).toContain("Failed to import component Bogus");
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

  // --- Structural preflight ---

  it("aggregates a nested <Output> into one diagnostic and runs no side effects", function* () {
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

  it("aggregates every misplaced <Output> into a single diagnostic", function* () {
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

  it("diagnoses a nested <Output> inside <Show when={false}>", function* () {
    const comp = makeComponent("Hidden", "<Show when={false}>\n<Output>hidden</Output>\n</Show>");
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

  it("throws a structural diagnostic when an invalid child is used from documentation", function* () {
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
  const closed = (properties: Record<string, unknown>, required?: string[]) => ({
    type: "object",
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  });

  // C14: Undeclared prop rejected
  it("C14: undeclared prop → PropValidationError", function* () {
    expect(() => validateProps("Comp", { foo: "bar" }, closed({}))).toThrow(
      "must NOT have additional properties",
    );
  });

  // C15: Required prop missing
  it("C15: required prop missing → PropValidationError", function* () {
    expect(() => validateProps("Comp", {}, closed({ name: { type: "string" } }, ["name"]))).toThrow(
      "must have required property",
    );
  });

  // C17: Type mismatch rejected
  it("C17: type mismatch → PropValidationError", function* () {
    expect(() =>
      validateProps("Comp", { count: "abc" }, closed({ count: { type: "number" } })),
    ).toThrow("must be number");
  });

  // C18: Enum validated — invalid value
  it("C18: enum invalid value → PropValidationError", function* () {
    expect(() =>
      validateProps(
        "Comp",
        { model: "bad" },
        closed({ model: { type: "string", enum: ["a", "b"] } }),
      ),
    ).toThrow("must be equal to one of the allowed values");
  });

  // C19: Enum accepted — valid value
  it("C19: enum valid value → accepted", function* () {
    const result = validateProps(
      "Comp",
      { model: "a" },
      closed({ model: { type: "string", enum: ["a", "b"] } }),
    );
    expect(result["model"]).toBe("a");
  });

  // C21: No inputs, some props → error
  it("C21: no inputs, some props → PropValidationError", function* () {
    expect(() => validateProps("Badge", { size: "lg" }, closed({}))).toThrow(PropValidationError);
  });

  it("applies default when prop not provided", function* () {
    const result = validateProps(
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
  it("renders default content and a named slot via useContent", function* () {
    const card: FunctionComponentDefinition = {
      kind: "function",
      name: "Card",
      path: "components/Card.ts",
      inputs: { type: "object", properties: {}, additionalProperties: false },
      *fn(_props) {
        const header = yield* ephemeral(useContent("header"));
        const body = yield* ephemeral(useContent());
        return `[${header.trim()}|${body.trim()}]`;
      },
    };
    const note = makeComponent("Note", "HEADER");
    const segments = scanSegments('<Card>\n<Note slot="header" />\nBODY\n</Card>');
    const output = yield* expand(segments, { Card: card, Note: note });
    expect(output).toBe("[HEADER|BODY]");
  });
});
