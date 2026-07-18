import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { expandSegments } from "../src/expand.ts";
import type { ExpansionContext } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import { interpolate } from "../src/interpolate.ts";
import { validateProps, PropValidationError } from "../src/validate.ts";
import { renderSegments } from "../src/render.ts";
import type { Operation } from "effection";
import { EvalEnvCtx } from "../src/eval-env.ts";
import type {
  Segment,
  ComponentDefinition,
  Json,
  CodeBlockResult,
  Modifier,
  CodeBlockContext,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    inputs: opts.inputs ?? {},
    bodySegments: scanSegments(body),
  };
}

function makeCtx(
  components: Record<string, ComponentDefinition>,
  codeResult?: CodeBlockResult,
): ExpansionContext {
  return {
    importComponent: function* (name: string) {
      const comp = components[name];
      if (!comp) throw new Error(`Component not found: ${name}`);
      return comp;
    },
    runModifierChain: function* (_modifiers: Modifier[], _context: CodeBlockContext) {
      return (
        codeResult ?? {
          output: "mock output\n",
          exitCode: 0,
          stderr: "",
        }
      );
    },
  };
}

function expand(
  segments: Segment[],
  ctx: ExpansionContext,
  meta: Record<string, unknown> = {},
  props: Record<string, Json> = {},
): Operation<string> {
  function* op() {
    return yield* EvalEnvCtx.with({ values: {} }, function* () {
      const expanded = yield* expandSegments(segments, meta, props, new Set(), ctx);
      return renderSegments(expanded);
    });
  }
  return op() as unknown as Operation<string>;
}

function expandWithEnv(
  segments: Segment[],
  ctx: ExpansionContext,
): Operation<{ output: string; env: Record<string, unknown> }> {
  function* op() {
    const env = { values: {} as Record<string, unknown> };
    const output = yield* EvalEnvCtx.with(env, function* () {
      const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
      return renderSegments(expanded);
    });
    return { output, env: env.values };
  }
  return op() as unknown as Operation<{ output: string; env: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// Tier C — Expansion and prop validation (spec §11)
// ---------------------------------------------------------------------------

describe("expansion", () => {
  // C1: Basic expansion
  it("C1: basic expansion — component body in output", function* () {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello world!");
  });

  // C2: Content slot
  it("C2: content slot — children at <Content /> position", function* () {
    const comp = makeComponent("Wrap", "Before <Content /> After");
    const ctx = makeCtx({ Wrap: comp });
    const segments = scanSegments("<Wrap>middle</Wrap>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Before middle After");
  });

  // C3: Nested expansion
  it("C3: nested expansion — A contains B", function* () {
    const compB = makeComponent("B", "inner");
    const compA = makeComponent("A", "outer <B /> end");
    const ctx = makeCtx({ A: compA, B: compB });
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("outer inner end");
  });

  // C4: Transitive expansion — A→B→C
  it("C4: transitive expansion — A references B references C", function* () {
    const compC = makeComponent("C", "leaf");
    const compB = makeComponent("B", "mid(<C />)");
    const compA = makeComponent("A", "top(<B />)");
    const ctx = makeCtx({ A: compA, B: compB, C: compC });
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("top(mid(leaf))");
  });

  // C5: Direct cycle
  it("C5: direct cycle — A contains A → ErrorSegment", function* () {
    const compA = makeComponent("A", "start <A /> end");
    const ctx = makeCtx({ A: compA });
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("Cycle detected");
  });

  // C6: Mutual cycle — A→B→A
  it("C6: mutual cycle — A→B→A → ErrorSegment", function* () {
    const compA = makeComponent("A", "a(<B />)");
    const compB = makeComponent("B", "b(<A />)");
    const ctx = makeCtx({ A: compA, B: compB });
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
    const ctx = makeCtx({ Page: comp });
    const segments = scanSegments("<Page />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Title: My Page");
  });

  // C9: Props interpolation
  it("C9: props interpolation — {props.name}", function* () {
    const comp = makeComponent("Greeting", "Hello, {props.name}!", {
      inputs: { name: { type: "string", required: true } },
    });
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments('<Greeting name="world" />');
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello, world!");
  });

  // C10: Missing interpolation key → empty string
  it("C10: missing interpolation key → empty string", function* () {
    const comp = makeComponent("Comp", "value: {meta.nonexistent}");
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("value: ");
  });

  // C11: Nested key access
  it("C11: nested key access — {meta.config.db.host}", function* () {
    const comp = makeComponent("Comp", "host: {meta.config.db.host}", {
      meta: { config: { db: { host: "localhost" } } },
    });
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("host: localhost");
  });

  // C12: No Content slot — children silently discarded
  it("C12: no Content slot — children silently discarded", function* () {
    const comp = makeComponent("NoSlot", "fixed content");
    const ctx = makeCtx({ NoSlot: comp });
    const segments = scanSegments("<NoSlot>ignored</NoSlot>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("fixed content");
  });

  // C13: Multiple Content slots
  it("C13: multiple Content slots — each replaced with same children", function* () {
    const comp = makeComponent("Multi", "first: <Content /> second: <Content />");
    const ctx = makeCtx({ Multi: comp });
    const segments = scanSegments("<Multi>stuff</Multi>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("first: stuff second: stuff");
  });

  // C16: Default applied
  it("C16: default applied — props.greeting resolves to default", function* () {
    const comp = makeComponent("Greeting", "{props.greeting}, world!", {
      inputs: { greeting: { type: "string", default: "Hello" } },
    });
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello, world!");
  });

  // C20: No inputs, no props — valid
  it("C20: no inputs, no props — valid", function* () {
    const comp = makeComponent("Badge", "badge");
    const ctx = makeCtx({ Badge: comp });
    const segments = scanSegments("<Badge />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("badge");
  });

  // C22: Optional with no default, not passed → empty string
  it("C22: optional with no default, not passed → empty in interpolation", function* () {
    const comp = makeComponent("Comp", "val:{props.opt}", {
      inputs: { opt: { type: "string", required: false } },
    });
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("val:");
  });

  // Code block expansion
  it("code block expansion via modifier chain", function* () {
    const ctx = makeCtx({}, { output: "hello\n", exitCode: 0, stderr: "" });
    const segments = scanSegments("```bash exec\necho hello\n```\n");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("hello\n");
  });

  // Code block with non-zero exit
  it("code block with non-zero exit → error", function* () {
    const ctx = makeCtx({}, { output: "", exitCode: 1, stderr: "not found" });
    const segments = scanSegments("```bash exec\nfoo\n```\n");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("not found");
  });

  // Silent code block → no output
  it("silent code block produces no output", function* () {
    const ctx = makeCtx({}, { output: "", exitCode: 0, stderr: "" });
    const segments = scanSegments("```bash silent exec\necho hello\n```\n");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("");
  });

  it("captures component output with as", function* () {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments('<Greeting as="saved" />');
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["saved"]).toBe("Hello world!");
  });

  it("Capture stores children output into env and stays silent", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments('<Capture as="x">hello\n</Capture>');
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["x"]).toBe("hello");
  });

  it("Capture rejects expression as prop", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("<Capture as={name}>text</Capture>");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must be a string literal");
  });

  it("Capture rejects self-closing usage", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments('<Capture as="x" />');
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must have content");
  });

  it("Capture rejects extra props", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments('<Capture as="x" slot="y">text</Capture>');
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain('only accepts "as" and "select" props');
  });

  it("Capture with select extracts code block by CSS selector", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments(
      '<Capture as="data" select="code[lang=json]">prose text\n\n```json\n{"key":"val"}\n```\n\nmore prose\n</Capture>',
    );
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["data"]).toBe('{"key":"val"}');
  });

  it("Capture with select falls back to full content when no match", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments(
      '<Capture as="data" select="code[lang=json]">no code here\n</Capture>',
    );
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["data"]).toBe("no code here");
  });

  it("Capture with select extracts paragraph text", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments('<Capture as="data" select="paragraph">Hello world\n</Capture>');
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["data"]).toBe("Hello world");
  });

  it("Capture accepts select alongside as without error", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments('<Capture as="x" select="paragraph">text\n</Capture>');
    const output = yield* expand(segments, ctx);
    expect(output).not.toContain("ERROR");
  });

  it("component as rejects expression prop", function* () {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting as={name} />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must be a string literal");
  });
});

// ---------------------------------------------------------------------------
// Component-declared output — <Output> (spec §6.9)
// ---------------------------------------------------------------------------

/** ExpansionContext that records executed code-block contents. */
function recordingCtx(
  components: Record<string, ComponentDefinition>,
  codeResult?: CodeBlockResult,
): { ctx: ExpansionContext; execCalls: string[] } {
  const execCalls: string[] = [];
  const ctx: ExpansionContext = {
    importComponent: function* (name: string) {
      const comp = components[name];
      if (!comp) throw new Error(`Component not found: ${name}`);
      return comp;
    },
    runModifierChain: function* (_modifiers: Modifier[], context: CodeBlockContext) {
      execCalls.push(context.content);
      return codeResult ?? { output: "ran\n", exitCode: 0, stderr: "" };
    },
  };
  return { ctx, execCalls };
}

describe("component-declared output", () => {
  it("renders only the <Output> region, suppressing documentation", function* () {
    const comp = makeComponent(
      "Warn",
      "Docs heading.\n\n<Output>\nSHOWN\n</Output>\n\nMore docs.\n",
    );
    const ctx = makeCtx({ Warn: comp });
    const output = yield* expand(scanSegments("<Warn />"), ctx);
    expect(output).toContain("SHOWN");
    expect(output).not.toContain("Docs heading");
    expect(output).not.toContain("More docs");
  });

  it("without <Output> renders the complete body", function* () {
    const comp = makeComponent("Doc", "Alpha then Beta.");
    const ctx = makeCtx({ Doc: comp });
    const output = yield* expand(scanSegments("<Doc />"), ctx);
    expect(output).toContain("Alpha then Beta.");
  });

  it("concatenates multiple <Output> regions in document order", function* () {
    const comp = makeComponent(
      "Multi",
      "<Output>ONE</Output>\n\nmiddle docs\n\n<Output>TWO</Output>\n",
    );
    const ctx = makeCtx({ Multi: comp });
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
    const ctx = makeCtx({ Adm: comp });
    const output = yield* expand(scanSegments("<Adm />"), ctx);
    expect(output).toContain("> [!WARNING]");
    expect(output).toContain("> Careful now.");
    expect(output).not.toContain("docs");
  });

  it("treats <Output /> and <Output></Output> as equivalent empty output", function* () {
    const selfClosing = makeComponent("A", "before\n\n<Output />\n\nafter");
    const paired = makeComponent("B", "before\n\n<Output></Output>\n\nafter");
    const ctx = makeCtx({ A: selfClosing, B: paired });
    const a = yield* expand(scanSegments("<A />"), ctx);
    const b = yield* expand(scanSegments("<B />"), ctx);
    expect(a.trim()).toBe("");
    expect(b.trim()).toBe("");
  });

  it("rejects props on <Output>", function* () {
    const comp = makeComponent("Bad", '<Output foo="bar">x</Output>');
    const ctx = makeCtx({ Bad: comp });
    const output = yield* expand(scanSegments("<Bad />"), ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("accepts no props");
  });

  it("rejects expression props on <Output>", function* () {
    const comp = makeComponent("Bad", "<Output when={x}>y</Output>");
    const ctx = makeCtx({ Bad: comp });
    const output = yield* expand(scanSegments("<Bad />"), ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("accepts no props");
  });

  it("projects caller content through <Content /> inside <Output>", function* () {
    const comp = makeComponent("Wrap", "docs\n\n<Output>\n<Content />\n</Output>\n");
    const ctx = makeCtx({ Wrap: comp });
    const output = yield* expand(scanSegments("<Wrap>PROJECTED</Wrap>"), ctx);
    expect(output).toContain("PROJECTED");
    expect(output).not.toContain("docs");
  });

  it("lets an <Output> region read a binding recorded by preceding documentation", function* () {
    const comp = makeComponent(
      "Dep",
      '<Capture as="msg">HELLO</Capture>\n\n<Output>msg={msg}</Output>',
    );
    const ctx = makeCtx({ Dep: comp });
    const output = yield* expand(scanSegments("<Dep />"), ctx);
    expect(output).toContain("msg=HELLO");
  });

  it("executes exec blocks outside <Output> but suppresses their output", function* () {
    const comp = makeComponent("Ex", "```bash exec\nDOCRUN\n```\n\n<Output>ok</Output>\n");
    const { ctx, execCalls } = recordingCtx({ Ex: comp });
    const output = yield* expand(scanSegments("<Ex />"), ctx);
    expect(execCalls.some((c) => c.includes("DOCRUN"))).toBe(true);
    expect(output).toContain("ok");
    expect(output).not.toContain("ran");
  });

  it("executes documentation after an <Output> region", function* () {
    const comp = makeComponent("Post", "<Output>ok</Output>\n\n```bash exec\nAFTER\n```\n");
    const { ctx, execCalls } = recordingCtx({ Post: comp });
    const output = yield* expand(scanSegments("<Post />"), ctx);
    expect(execCalls.some((c) => c.includes("AFTER"))).toBe(true);
    expect(output).toContain("ok");
  });

  it("keeps errors inside an <Output> region as comments", function* () {
    const comp = makeComponent("Err", "<Output>\n<Bogus />\n</Output>");
    const ctx = makeCtx({ Err: comp });
    const output = yield* expand(scanSegments("<Err />"), ctx);
    expect(output).toContain("<!-- ERROR");
    expect(output).toContain("Failed to import component Bogus");
  });

  it("keeps errors as comments when no <Output> is declared", function* () {
    const comp = makeComponent("NoOut", "<Bogus />");
    const ctx = makeCtx({ NoOut: comp });
    const output = yield* expand(scanSegments("<NoOut />"), ctx);
    expect(output).toContain("<!-- ERROR");
  });

  // --- Fail-fast in documentation ---

  it("throws on a failing exec block in documentation", function* () {
    const comp = makeComponent("Fail", "```bash exec\nboom\n```\n\n<Output>ok</Output>\n");
    const ctx = makeCtx({ Fail: comp }, { output: "", exitCode: 1, stderr: "nope" });
    let threw = false;
    try {
      yield* expand(scanSegments("<Fail />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("continues when a modifier handles the failure in documentation", function* () {
    const comp = makeComponent("Handled", "```bash exec\nrecover\n```\n\n<Output>ok</Output>\n");
    const ctx = makeCtx({ Handled: comp }, { output: "recovered\n", exitCode: 0, stderr: "" });
    const output = yield* expand(scanSegments("<Handled />"), ctx);
    expect(output).toContain("ok");
  });

  it("throws on a failure inside <Capture> documentation", function* () {
    const comp = makeComponent(
      "CapFail",
      '<Capture as="x">\n<Bogus />\n</Capture>\n\n<Output>ok</Output>',
    );
    const ctx = makeCtx({ CapFail: comp });
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
    const ctx = makeCtx({ Child: child, P: parent });
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
    const ctx = makeCtx({ Child: child, P: parent });
    const output = yield* expand(scanSegments("<P />"), ctx);
    expect(output).toContain("<!-- ERROR");
    expect(output).toContain("Failed to import component Bogus");
  });

  it("throws before storing an as= binding that captured a child's Output error", function* () {
    const child = makeComponent("Child", "<Output>\n<Bogus />\n</Output>");
    const parent = makeComponent("P", '<Child as="captured" />\n\n<Output>tail</Output>');
    const ctx = makeCtx({ Child: child, P: parent });
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
    const { ctx, execCalls } = recordingCtx({ Struct: comp });
    const output = yield* expand(scanSegments("<Struct />"), ctx);
    expect(output).toContain("must be a direct top-level");
    expect(execCalls).toHaveLength(0);
  });

  it("aggregates every misplaced <Output> into a single diagnostic", function* () {
    const comp = makeComponent(
      "Many",
      "<A>\n<Output>one</Output>\n</A>\n\n<B>\n<Output>two</Output>\n</B>\n",
    );
    const ctx = makeCtx({ Many: comp });
    const output = yield* expand(scanSegments("<Many />"), ctx);
    const errorComments = output.match(/<!-- ERROR/g) ?? [];
    expect(errorComments).toHaveLength(1);
    expect(output).toContain("one");
    expect(output).toContain("two");
  });

  it("diagnoses a nested <Output> inside <Show when={false}>", function* () {
    const comp = makeComponent("Hidden", "<Show when={false}>\n<Output>hidden</Output>\n</Show>");
    const ctx = makeCtx({ Hidden: comp });
    const output = yield* expand(scanSegments("<Hidden />"), ctx);
    expect(output).toContain("must be a direct top-level");
  });

  it("diagnoses a nested <Output> passed to a component that discards content", function* () {
    const comp = makeComponent("Discard", "<NoContent>\n<Output>x</Output>\n</NoContent>");
    const ctx = makeCtx({ Discard: comp });
    const output = yield* expand(scanSegments("<Discard />"), ctx);
    expect(output).toContain("must be a direct top-level");
  });

  it("throws a structural diagnostic when an invalid child is used from documentation", function* () {
    const child = makeComponent("BadChild", "<Wrapper>\n<Output>x</Output>\n</Wrapper>");
    const parent = makeComponent("P", "<BadChild />\n\n<Output>tail</Output>");
    const ctx = makeCtx({ BadChild: child, P: parent });
    let threw = false;
    try {
      yield* expand(scanSegments("<P />"), ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prop validation (spec §5.5)
// ---------------------------------------------------------------------------

describe("validateProps", () => {
  // C14: Undeclared prop rejected
  it("C14: undeclared prop → PropValidationError", function* () {
    expect(() => validateProps("Comp", { foo: "bar" }, {})).toThrow('Unknown prop "foo"');
  });

  // C15: Required prop missing
  it("C15: required prop missing → PropValidationError", function* () {
    expect(() =>
      validateProps(
        "Comp",
        {},
        {
          name: { type: "string", required: true },
        },
      ),
    ).toThrow('Required prop "name"');
  });

  // C17: Type mismatch rejected
  it("C17: type mismatch → PropValidationError", function* () {
    expect(() =>
      validateProps(
        "Comp",
        { count: "abc" },
        {
          count: { type: "number" },
        },
      ),
    ).toThrow("expected number");
  });

  // C18: Enum validated — invalid value
  it("C18: enum invalid value → PropValidationError", function* () {
    expect(() =>
      validateProps(
        "Comp",
        { model: "bad" },
        {
          model: { type: "string", enum: ["a", "b"] },
        },
      ),
    ).toThrow("must be one of");
  });

  // C19: Enum accepted — valid value
  it("C19: enum valid value → accepted", function* () {
    const result = validateProps(
      "Comp",
      { model: "a" },
      {
        model: { type: "string", enum: ["a", "b"] },
      },
    );
    expect(result["model"]).toBe("a");
  });

  // C21: No inputs, some props → error
  it("C21: no inputs, some props → PropValidationError", function* () {
    expect(() => validateProps("Badge", { size: "lg" }, {})).toThrow(PropValidationError);
  });

  it("applies default when prop not provided", function* () {
    const result = validateProps(
      "Comp",
      {},
      {
        greeting: { type: "string", default: "Hello" },
      },
    );
    expect(result["greeting"]).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

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
