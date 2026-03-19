/**
 * Text interpolation tests — eval binding interpolation in text segments.
 *
 * Verifies that bare `{name}` references in text segments resolve from
 * the eval binding environment (env.values), matching the test plan
 * from the text-interpolation spec §9.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { expandSegments } from "../src/expand.ts";
import type { ExpansionContext } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { interpolateEvalBindings } from "../src/eval-interpolate.ts";
import type { Operation } from "effection";
import { EvalEnvCtx } from "../src/eval-env.ts";
import type {
  Segment,
  ComponentDefinition,
  InputDefinition,
  Json,
  CodeBlockResult,
  Modifier,
  CodeBlockContext,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers (same pattern as expand.test.ts)
// ---------------------------------------------------------------------------

function makeComponent(
  name: string,
  body: string,
  opts: {
    meta?: Record<string, unknown>;
    inputs?: Record<string, InputDefinition>;
  } = {},
): ComponentDefinition {
  return {
    kind: "markdown",
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

/**
 * Expand segments with a pre-populated EvalEnv.
 */
function expandWithBindings(
  segments: Segment[],
  ctx: ExpansionContext,
  bindings: Record<string, unknown>,
  meta: Record<string, unknown> = {},
  props: Record<string, Json> = {},
): Operation<string> {
  function* op() {
    return yield* EvalEnvCtx.with({ values: bindings }, function* () {
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

/**
 * Expand segments with no EvalEnv on the scope.
 */
function expandWithoutEnv(
  segments: Segment[],
  ctx: ExpansionContext,
  meta: Record<string, unknown> = {},
  props: Record<string, Json> = {},
): Operation<string> {
  function* op() {
    const expanded = yield* expandSegments(
      segments,
      meta,
      props,
      new Set(),
      ctx,
    );
    return renderSegments(expanded);
  }
  return op() as unknown as Operation<string>;
}

// ---------------------------------------------------------------------------
// Text interpolation tests (spec §9 test plan)
// ---------------------------------------------------------------------------

describe("Text interpolation — eval bindings in text segments", () => {
  // TI1: Bare binding in text resolves
  it("TI1: bare binding in text resolves from env.values", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Server on port {port}.");
    const output = yield* expandWithBindings(segments, ctx, { port: 49821 });
    expect(output).toBe("Server on port 49821.");
  });

  // TI2: Bare binding with no env entry left verbatim
  it("TI2: bare binding with no env entry left verbatim", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Value is {unknown}.");
    const output = yield* expandWithBindings(segments, ctx, {});
    expect(output).toBe("Value is {unknown}.");
  });

  // TI3: {meta.title} still resolves in first pass
  it("TI3: {meta.title} still resolves in first pass", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Title: {meta.title}");
    const output = yield* expandWithBindings(
      segments,
      ctx,
      { title: "should not appear" },
      { title: "My Page" },
    );
    expect(output).toBe("Title: My Page");
  });

  // TI4: {props.name} still resolves in first pass
  it("TI4: {props.name} still resolves in first pass", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Hello, {props.name}!");
    const output = yield* expandWithBindings(
      segments,
      ctx,
      { name: "should not appear" },
      {},
      { name: "world" },
    );
    expect(output).toBe("Hello, world!");
  });

  // TI5: Both passes in same text
  it("TI5: both meta/props and eval bindings in same text", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("{meta.title} by {author}");
    const output = yield* expandWithBindings(
      segments,
      ctx,
      { author: "Alice" },
      { title: "My Doc" },
    );
    expect(output).toBe("My Doc by Alice");
  });

  // TI6: Eval binding does not shadow meta
  it("TI6: eval binding does not shadow meta (different syntax)", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("{meta.x} and {x}");
    const output = yield* expandWithBindings(
      segments,
      ctx,
      { x: "eval-value" },
      { x: "meta-value" },
    );
    expect(output).toBe("meta-value and eval-value");
  });

  // TI7: Non-string value coerced
  it("TI7: non-string value coerced via String()", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Count is {count}.");
    const output = yield* expandWithBindings(segments, ctx, { count: 42 });
    expect(output).toBe("Count is 42.");
  });

  // TI8: Object value produces [object Object]
  it("TI8: object value produces [object Object]", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Data: {obj}");
    const output = yield* expandWithBindings(segments, ctx, { obj: {} });
    expect(output).toBe("Data: [object Object]");
  });

  // TI9: No EvalEnv — second pass skipped
  it("TI9: no EvalEnv — bare {name} left verbatim", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Value is {name}.");
    const output = yield* expandWithoutEnv(segments, ctx);
    expect(output).toBe("Value is {name}.");
  });

  // TI10: Escaped braces not interpolated
  it("TI10: escaped braces not interpolated", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Literal: \\{name}");
    const output = yield* expandWithBindings(segments, ctx, {
      name: "resolved",
    });
    expect(output).toBe("Literal: {name}");
  });

  // TI11: Children in <Content /> use child's env
  it("TI11: children in <Content /> use child component env, not parent", function* () {
    // Parent has binding 'label'. Child component gets a fresh EvalEnv
    // (via expandComponent). Text from children expanded inside child's
    // scope should NOT see parent's bindings.
    const child = makeComponent("Child", "<Content />");
    const ctx = makeCtx({ Child: child });
    const segments = scanSegments("<Child>text with {label}</Child>");
    // Parent env has 'label', but child gets a fresh env
    const output = yield* expandWithBindings(segments, ctx, {
      label: "parent-value",
    });
    // The child's fresh env does NOT have 'label', so it stays verbatim
    expect(output).toBe("text with {label}");
  });

  // TI12: <Capture> text uses current env
  it("TI12: Capture text uses current component env", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments(
      '<Capture as="captured">value is {port}\n</Capture>',
    );
    const env = { values: { port: 8080 } as Record<string, unknown> };
    function* op() {
      return yield* EvalEnvCtx.with(env, function* () {
        const expanded = yield* expandSegments(
          segments,
          {},
          {},
          new Set(),
          ctx,
        );
        return renderSegments(expanded);
      });
    }
    const output = yield* (op() as unknown as Operation<string>);
    expect(output).toBe("");
    expect(env.values["captured"]).toBe("value is 8080");
  });

  // TI13: Multiple bindings in one text segment
  it("TI13: multiple bindings in one text segment", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("{host}:{port}");
    const output = yield* expandWithBindings(segments, ctx, {
      host: "127.0.0.1",
      port: 3000,
    });
    expect(output).toBe("127.0.0.1:3000");
  });

  // TI14: Binding adjacent to meta ref
  it("TI14: binding adjacent to meta ref — both resolved", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("{meta.title}: {subtitle}");
    const output = yield* expandWithBindings(
      segments,
      ctx,
      { subtitle: "a guide" },
      { title: "EMA" },
    );
    expect(output).toBe("EMA: a guide");
  });

  // TI15: Empty env.values — no crash
  it("TI15: empty env.values — bare refs left verbatim, no crash", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("Value is {name} and {other}.");
    const output = yield* expandWithBindings(segments, ctx, {});
    expect(output).toBe("Value is {name} and {other}.");
  });

  // TI17: Dotted path in text segment resolves nested property
  it("TI17: dotted path {pr.meta.title} resolves in text segment", function* () {
    const ctx = makeCtx({});
    const segments = scanSegments("PR #{pr.meta.number}: {pr.meta.title}");
    const output = yield* expandWithBindings(segments, ctx, {
      pr: { meta: { number: "42", title: "feat: add feature" } },
    });
    expect(output).toBe("PR #42: feat: add feature");
  });

  // TI16: Code blocks unchanged
  it("TI16: code block interpolation still works as before", function* () {
    const capturedContext: CodeBlockContext[] = [];
    const ctx: ExpansionContext = {
      importComponent: function* () {
        throw new Error("not needed");
      },
      runModifierChain: function* (
        _modifiers: Modifier[],
        context: CodeBlockContext,
      ) {
        capturedContext.push(context);
        return { output: "ok\n", exitCode: 0, stderr: "" };
      },
    };
    const segments = scanSegments("```bash exec\necho {port}\n```\n");
    yield* expandWithBindings(segments, ctx, { port: 8080 });
    // The code block content should have been interpolated
    expect(capturedContext[0].content).toBe("echo 8080\n");
  });
});

// ---------------------------------------------------------------------------
// Escaping tests for interpolateEvalBindings
// ---------------------------------------------------------------------------

describe("interpolateEvalBindings — escaping", () => {
  it("escaped opening brace prevents interpolation", function* () {
    const result = interpolateEvalBindings("\\{name}", { name: "val" });
    expect(result).toBe("{name}");
  });

  it("escaped brace alongside normal interpolation", function* () {
    const result = interpolateEvalBindings(
      "\\{name} and {port}",
      { name: "val", port: 8080 },
    );
    expect(result).toBe("{name} and 8080");
  });

  it("multiple escaped braces", function* () {
    const result = interpolateEvalBindings(
      "\\{a} \\{b} {c}",
      { a: 1, b: 2, c: 3 },
    );
    expect(result).toBe("{a} {b} 3");
  });
});
