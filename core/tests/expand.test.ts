import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
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
    name,
    path: `components/${name}.md`,
    meta: opts.meta ?? {},
    inputs: opts.inputs ?? {},
    bodySegments: scanSegments(body),
    contentHash: `sha256:fake-${name}`,
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
    runModifierChain: function* (
      _modifiers: Modifier[],
      _context: CodeBlockContext,
    ) {
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
      const expanded = yield* expandSegments(
        segments,
        meta,
        props,
        new Set(),
        ctx,
      );
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
      const expanded = yield* expandSegments(
        segments,
        {},
        {},
        new Set(),
        ctx,
      );
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
  it("C1: basic expansion — component body in output", function*() {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello world!");
  });

  // C2: Content slot
  it("C2: content slot — children at <Content /> position", function*() {
    const comp = makeComponent("Wrap", "Before <Content /> After");
    const ctx = makeCtx({ Wrap: comp });
    const segments = scanSegments("<Wrap>middle</Wrap>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Before middle After");
  });

  // C3: Nested expansion
  it("C3: nested expansion — A contains B", function*() {
    const compB = makeComponent("B", "inner");
    const compA = makeComponent("A", "outer <B /> end");
    const ctx = makeCtx({ A: compA, B: compB });
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("outer inner end");
  });

  // C4: Transitive expansion — A→B→C
  it("C4: transitive expansion — A references B references C", function*() {
    const compC = makeComponent("C", "leaf");
    const compB = makeComponent("B", "mid(<C />)");
    const compA = makeComponent("A", "top(<B />)");
    const ctx = makeCtx({ A: compA, B: compB, C: compC });
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("top(mid(leaf))");
  });

  // C5: Direct cycle
  it("C5: direct cycle — A contains A → ErrorSegment", function*() {
    const compA = makeComponent("A", "start <A /> end");
    const ctx = makeCtx({ A: compA });
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("Cycle detected");
  });

  // C6: Mutual cycle — A→B→A
  it("C6: mutual cycle — A→B→A → ErrorSegment", function*() {
    const compA = makeComponent("A", "a(<B />)");
    const compB = makeComponent("B", "b(<A />)");
    const ctx = makeCtx({ A: compA, B: compB });
    const segments = scanSegments("<A />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("Cycle detected");
  });

  // C8: Frontmatter interpolation
  it("C8: frontmatter interpolation — {meta.title}", function*() {
    const comp = makeComponent("Page", "Title: {meta.title}", {
      meta: { title: "My Page" },
    });
    const ctx = makeCtx({ Page: comp });
    const segments = scanSegments("<Page />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Title: My Page");
  });

  // C9: Props interpolation
  it("C9: props interpolation — {props.name}", function*() {
    const comp = makeComponent("Greeting", "Hello, {props.name}!", {
      inputs: { name: { type: "string", required: true } },
    });
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments('<Greeting name="world" />');
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello, world!");
  });

  // C10: Missing interpolation key → empty string
  it("C10: missing interpolation key → empty string", function*() {
    const comp = makeComponent("Comp", "value: {meta.nonexistent}");
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("value: ");
  });

  // C11: Nested key access
  it("C11: nested key access — {meta.config.db.host}", function*() {
    const comp = makeComponent("Comp", "host: {meta.config.db.host}", {
      meta: { config: { db: { host: "localhost" } } },
    });
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("host: localhost");
  });

  // C12: No Content slot — children silently discarded
  it("C12: no Content slot — children silently discarded", function*() {
    const comp = makeComponent("NoSlot", "fixed content");
    const ctx = makeCtx({ NoSlot: comp });
    const segments = scanSegments("<NoSlot>ignored</NoSlot>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("fixed content");
  });

  // C13: Multiple Content slots
  it("C13: multiple Content slots — each replaced with same children", function*() {
    const comp = makeComponent(
      "Multi",
      "first: <Content /> second: <Content />",
    );
    const ctx = makeCtx({ Multi: comp });
    const segments = scanSegments("<Multi>stuff</Multi>");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("first: stuff second: stuff");
  });

  // C16: Default applied
  it("C16: default applied — props.greeting resolves to default", function*() {
    const comp = makeComponent("Greeting", "{props.greeting}, world!", {
      inputs: { greeting: { type: "string", default: "Hello" } },
    });
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("Hello, world!");
  });

  // C20: No inputs, no props — valid
  it("C20: no inputs, no props — valid", function*() {
    const comp = makeComponent("Badge", "badge");
    const ctx = makeCtx({ Badge: comp });
    const segments = scanSegments("<Badge />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("badge");
  });

  // C22: Optional with no default, not passed → empty string
  it("C22: optional with no default, not passed → empty in interpolation", function*() {
    const comp = makeComponent("Comp", "val:{props.opt}", {
      inputs: { opt: { type: "string", required: false } },
    });
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("val:");
  });

  // Code block expansion
  it("code block expansion via modifier chain", function*() {
    const ctx = makeCtx(
      {},
      { output: "hello\n", exitCode: 0, stderr: "" },
    );
    const segments = scanSegments("```bash exec\necho hello\n```\n");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("hello\n");
  });

  // Code block with non-zero exit
  it("code block with non-zero exit → error", function*() {
    const ctx = makeCtx(
      {},
      { output: "", exitCode: 1, stderr: "not found" },
    );
    const segments = scanSegments("```bash exec\nfoo\n```\n");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("not found");
  });

  // Silent code block → no output
  it("silent code block produces no output", function*() {
    const ctx = makeCtx(
      {},
      { output: "", exitCode: 0, stderr: "" },
    );
    const segments = scanSegments("```bash silent exec\necho hello\n```\n");
    const output = yield* expand(segments, ctx);
    expect(output).toBe("");
  });

  it("captures component output with as", function*() {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting as=\"saved\" />");
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["saved"]).toBe("Hello world!");
  });

  it("Capture stores children output into env and stays silent", function*() {
    const ctx = makeCtx({});
    const segments = scanSegments(
      "<Capture as=\"x\">hello\n</Capture>",
    );
    const { output, env } = yield* expandWithEnv(segments, ctx);
    expect(output).toBe("");
    expect(env["x"]).toBe("hello");
  });

  it("Capture rejects expression as prop", function*() {
    const ctx = makeCtx({});
    const segments = scanSegments("<Capture as={name}>text</Capture>");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must be a string literal");
  });

  it("Capture rejects self-closing usage", function*() {
    const ctx = makeCtx({});
    const segments = scanSegments("<Capture as=\"x\" />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must have content");
  });

  it("Capture rejects extra props", function*() {
    const ctx = makeCtx({});
    const segments = scanSegments("<Capture as=\"x\" slot=\"y\">text</Capture>");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("only accepts the \"as\" prop");
  });

  it("component as rejects expression prop", function*() {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting as={name} />");
    const output = yield* expand(segments, ctx);
    expect(output).toContain("ERROR");
    expect(output).toContain("must be a string literal");
  });
});

// ---------------------------------------------------------------------------
// Prop validation (spec §5.5)
// ---------------------------------------------------------------------------

describe("validateProps", () => {
  // C14: Undeclared prop rejected
  it("C14: undeclared prop → PropValidationError", function*() {
    expect(() => validateProps("Comp", { foo: "bar" }, {})).toThrow('Unknown prop "foo"');
  });

  // C15: Required prop missing
  it("C15: required prop missing → PropValidationError", function*() {
    expect(() =>
      validateProps("Comp", {}, {
        name: { type: "string", required: true },
      }),
    ).toThrow('Required prop "name"');
  });

  // C17: Type mismatch rejected
  it("C17: type mismatch → PropValidationError", function*() {
    expect(() =>
      validateProps("Comp", { count: "abc" }, {
        count: { type: "number" },
      }),
    ).toThrow("expected number");
  });

  // C18: Enum validated — invalid value
  it("C18: enum invalid value → PropValidationError", function*() {
    expect(() =>
      validateProps("Comp", { model: "bad" }, {
        model: { type: "string", enum: ["a", "b"] },
      }),
    ).toThrow("must be one of");
  });

  // C19: Enum accepted — valid value
  it("C19: enum valid value → accepted", function*() {
    const result = validateProps("Comp", { model: "a" }, {
      model: { type: "string", enum: ["a", "b"] },
    });
    expect(result["model"]).toBe("a");
  });

  // C21: No inputs, some props → error
  it("C21: no inputs, some props → PropValidationError", function*() {
    expect(() => validateProps("Badge", { size: "lg" }, {})).toThrow(PropValidationError);
  });

  it("applies default when prop not provided", function*() {
    const result = validateProps("Comp", {}, {
      greeting: { type: "string", default: "Hello" },
    });
    expect(result["greeting"]).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe("interpolate", () => {
  it("replaces meta references", function*() {
    expect(interpolate("{meta.title}", { title: "Hello" }, {})).toBe("Hello");
  });

  it("replaces props references", function*() {
    expect(interpolate("{props.name}", {}, { name: "world" })).toBe("world");
  });

  it("missing key → empty string", function*() {
    expect(interpolate("{meta.nope}", {}, {})).toBe("");
  });

  it("array → comma-joined", function*() {
    expect(
      interpolate("{meta.tags}", { tags: ["a", "b", "c"] }, {}),
    ).toBe("a, b, c");
  });

  it("nested access", function*() {
    expect(
      interpolate("{meta.a.b.c}", { a: { b: { c: "deep" } } }, {}),
    ).toBe("deep");
  });

  it("escaped braces → literal", function*() {
    expect(
      interpolate("\\{meta.title}", { title: "Hello" }, {}),
    ).toBe("{meta.title}");
  });
});
