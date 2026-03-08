import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandSegments } from "./expand.ts";
import type { ExpansionContext } from "./expand.ts";
import { scanSegments } from "./scanner.ts";
import { interpolate } from "./interpolate.ts";
import { validateProps, PropValidationError } from "./validate.ts";
import { renderSegments } from "./render.ts";
import type {
  Segment,
  ComponentDefinition,
  Json,
  CodeBlockResult,
  Modifier,
  CodeBlockContext,
} from "./types.ts";

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

function* run(
  segments: Segment[],
  ctx: ExpansionContext,
  meta: Record<string, unknown> = {},
  props: Record<string, Json> = {},
): Generator<unknown, string, unknown> {
  const expanded = yield* expandSegments(
    segments,
    meta,
    props,
    new Set(),
    ctx,
  );
  return renderSegments(expanded);
}

/** Run a generator to completion (no durable effects in tests). */
function runSync<T>(gen: Generator<unknown, T, unknown>): T {
  let result = gen.next();
  while (!result.done) {
    result = gen.next(result.value);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Tier C — Expansion and prop validation (spec §11)
// ---------------------------------------------------------------------------

describe("expansion", () => {
  // C1: Basic expansion
  it("C1: basic expansion — component body in output", () => {
    const comp = makeComponent("Greeting", "Hello world!");
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "Hello world!");
  });

  // C2: Content slot
  it("C2: content slot — children at <Content /> position", () => {
    const comp = makeComponent("Wrap", "Before <Content /> After");
    const ctx = makeCtx({ Wrap: comp });
    const segments = scanSegments("<Wrap>middle</Wrap>");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "Before middle After");
  });

  // C3: Nested expansion
  it("C3: nested expansion — A contains B", () => {
    const compB = makeComponent("B", "inner");
    const compA = makeComponent("A", "outer <B /> end");
    const ctx = makeCtx({ A: compA, B: compB });
    const segments = scanSegments("<A />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "outer inner end");
  });

  // C4: Transitive expansion — A→B→C
  it("C4: transitive expansion — A references B references C", () => {
    const compC = makeComponent("C", "leaf");
    const compB = makeComponent("B", "mid(<C />)");
    const compA = makeComponent("A", "top(<B />)");
    const ctx = makeCtx({ A: compA, B: compB, C: compC });
    const segments = scanSegments("<A />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "top(mid(leaf))");
  });

  // C5: Direct cycle
  it("C5: direct cycle — A contains A → ErrorSegment", () => {
    const compA = makeComponent("A", "start <A /> end");
    const ctx = makeCtx({ A: compA });
    const segments = scanSegments("<A />");
    const output = runSync(run(segments, ctx));
    assert.ok(output.includes("ERROR"));
    assert.ok(output.includes("Cycle detected"));
  });

  // C6: Mutual cycle — A→B→A
  it("C6: mutual cycle — A→B→A → ErrorSegment", () => {
    const compA = makeComponent("A", "a(<B />)");
    const compB = makeComponent("B", "b(<A />)");
    const ctx = makeCtx({ A: compA, B: compB });
    const segments = scanSegments("<A />");
    const output = runSync(run(segments, ctx));
    assert.ok(output.includes("ERROR"));
    assert.ok(output.includes("Cycle detected"));
  });

  // C8: Frontmatter interpolation
  it("C8: frontmatter interpolation — {meta.title}", () => {
    const comp = makeComponent("Page", "Title: {meta.title}", {
      meta: { title: "My Page" },
    });
    const ctx = makeCtx({ Page: comp });
    const segments = scanSegments("<Page />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "Title: My Page");
  });

  // C9: Props interpolation
  it("C9: props interpolation — {props.name}", () => {
    const comp = makeComponent("Greeting", "Hello, {props.name}!", {
      inputs: { name: { type: "string", required: true } },
    });
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments('<Greeting name="world" />');
    const output = runSync(run(segments, ctx));
    assert.equal(output, "Hello, world!");
  });

  // C10: Missing interpolation key → empty string
  it("C10: missing interpolation key → empty string", () => {
    const comp = makeComponent("Comp", "value: {meta.nonexistent}");
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "value: ");
  });

  // C11: Nested key access
  it("C11: nested key access — {meta.config.db.host}", () => {
    const comp = makeComponent("Comp", "host: {meta.config.db.host}", {
      meta: { config: { db: { host: "localhost" } } },
    });
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "host: localhost");
  });

  // C12: No Content slot — children silently discarded
  it("C12: no Content slot — children silently discarded", () => {
    const comp = makeComponent("NoSlot", "fixed content");
    const ctx = makeCtx({ NoSlot: comp });
    const segments = scanSegments("<NoSlot>ignored</NoSlot>");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "fixed content");
  });

  // C13: Multiple Content slots
  it("C13: multiple Content slots — each replaced with same children", () => {
    const comp = makeComponent(
      "Multi",
      "first: <Content /> second: <Content />",
    );
    const ctx = makeCtx({ Multi: comp });
    const segments = scanSegments("<Multi>stuff</Multi>");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "first: stuff second: stuff");
  });

  // C16: Default applied
  it("C16: default applied — props.greeting resolves to default", () => {
    const comp = makeComponent("Greeting", "{props.greeting}, world!", {
      inputs: { greeting: { type: "string", default: "Hello" } },
    });
    const ctx = makeCtx({ Greeting: comp });
    const segments = scanSegments("<Greeting />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "Hello, world!");
  });

  // C20: No inputs, no props — valid
  it("C20: no inputs, no props — valid", () => {
    const comp = makeComponent("Badge", "badge");
    const ctx = makeCtx({ Badge: comp });
    const segments = scanSegments("<Badge />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "badge");
  });

  // C22: Optional with no default, not passed → empty string
  it("C22: optional with no default, not passed → empty in interpolation", () => {
    const comp = makeComponent("Comp", "val:{props.opt}", {
      inputs: { opt: { type: "string", required: false } },
    });
    const ctx = makeCtx({ Comp: comp });
    const segments = scanSegments("<Comp />");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "val:");
  });

  // Code block expansion
  it("code block expansion via modifier chain", () => {
    const ctx = makeCtx(
      {},
      { output: "hello\n", exitCode: 0, stderr: "" },
    );
    const segments = scanSegments("```bash exec\necho hello\n```\n");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "hello\n");
  });

  // Code block with non-zero exit
  it("code block with non-zero exit → error", () => {
    const ctx = makeCtx(
      {},
      { output: "", exitCode: 1, stderr: "not found" },
    );
    const segments = scanSegments("```bash exec\nfoo\n```\n");
    const output = runSync(run(segments, ctx));
    assert.ok(output.includes("ERROR"));
    assert.ok(output.includes("not found"));
  });

  // Silent code block → no output
  it("silent code block produces no output", () => {
    const ctx = makeCtx(
      {},
      { output: "", exitCode: 0, stderr: "" },
    );
    const segments = scanSegments("```bash silent exec\necho hello\n```\n");
    const output = runSync(run(segments, ctx));
    assert.equal(output, "");
  });
});

// ---------------------------------------------------------------------------
// Prop validation (spec §5.5)
// ---------------------------------------------------------------------------

describe("validateProps", () => {
  // C14: Undeclared prop rejected
  it("C14: undeclared prop → PropValidationError", () => {
    assert.throws(
      () => validateProps("Comp", { foo: "bar" }, {}),
      (err: unknown) => {
        assert.ok(err instanceof PropValidationError);
        assert.ok(err.message.includes('Unknown prop "foo"'));
        return true;
      },
    );
  });

  // C15: Required prop missing
  it("C15: required prop missing → PropValidationError", () => {
    assert.throws(
      () =>
        validateProps("Comp", {}, {
          name: { type: "string", required: true },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PropValidationError);
        assert.ok(err.message.includes('Required prop "name"'));
        return true;
      },
    );
  });

  // C17: Type mismatch rejected
  it("C17: type mismatch → PropValidationError", () => {
    assert.throws(
      () =>
        validateProps("Comp", { count: "abc" }, {
          count: { type: "number" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PropValidationError);
        assert.ok(err.message.includes("expected number"));
        return true;
      },
    );
  });

  // C18: Enum validated — invalid value
  it("C18: enum invalid value → PropValidationError", () => {
    assert.throws(
      () =>
        validateProps("Comp", { model: "bad" }, {
          model: { type: "string", enum: ["a", "b"] },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PropValidationError);
        assert.ok(err.message.includes("must be one of"));
        return true;
      },
    );
  });

  // C19: Enum accepted — valid value
  it("C19: enum valid value → accepted", () => {
    const result = validateProps("Comp", { model: "a" }, {
      model: { type: "string", enum: ["a", "b"] },
    });
    assert.equal(result["model"], "a");
  });

  // C21: No inputs, some props → error
  it("C21: no inputs, some props → PropValidationError", () => {
    assert.throws(
      () => validateProps("Badge", { size: "lg" }, {}),
      (err: unknown) => {
        assert.ok(err instanceof PropValidationError);
        return true;
      },
    );
  });

  it("applies default when prop not provided", () => {
    const result = validateProps("Comp", {}, {
      greeting: { type: "string", default: "Hello" },
    });
    assert.equal(result["greeting"], "Hello");
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe("interpolate", () => {
  it("replaces meta references", () => {
    assert.equal(interpolate("{meta.title}", { title: "Hello" }, {}), "Hello");
  });

  it("replaces props references", () => {
    assert.equal(interpolate("{props.name}", {}, { name: "world" }), "world");
  });

  it("missing key → empty string", () => {
    assert.equal(interpolate("{meta.nope}", {}, {}), "");
  });

  it("array → comma-joined", () => {
    assert.equal(
      interpolate("{meta.tags}", { tags: ["a", "b", "c"] }, {}),
      "a, b, c",
    );
  });

  it("nested access", () => {
    assert.equal(
      interpolate("{meta.a.b.c}", { a: { b: { c: "deep" } } }, {}),
      "deep",
    );
  });

  it("escaped braces → literal", () => {
    assert.equal(
      interpolate("\\{meta.title}", { title: "Hello" }, {}),
      "{meta.title}",
    );
  });
});
