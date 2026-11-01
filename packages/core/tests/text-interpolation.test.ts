/**
 * Text interpolation tests — eval binding interpolation in text segments.
 *
 * Verifies that bare `{name}` references in text segments resolve from
 * the eval binding environment (env.values), matching the test plan
 * from the text-interpolation spec §9.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { interpolateEvalBindings } from "../src/eval-interpolate.ts";
import { readsBinding } from "../src/generated-interpolation.ts";
import { previewGeneratedXmdRoot } from "../src/generated-xmd-preview.ts";
import type { Operation } from "effection";
import type {
  Segment,
  ComponentDefinition,
  PropsSchema,
  Json,
  CodeBlockResult,
} from "../src/types.ts";

function makeComponent(
  name: string,
  body: string,
  opts: {
    meta?: Record<string, unknown>;
    props?: PropsSchema;
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
  components: Record<string, ComponentDefinition>,
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

/**
 * Expand segments with a pre-populated binding environment.
 */
function expandWithBindings(
  segments: Segment[],
  components: Record<string, ComponentDefinition>,
  bindings: Record<string, unknown>,
  meta: Record<string, unknown> = {},
  props: Record<string, Json> = {},
): Operation<string> {
  return scoped(function* () {
    yield* useTestComponents(components);
    const testEnv = { values: bindings };
    yield* Component.around({ env: () => testEnv }, { at: "min" });
    const expanded = yield* expandSegments(segments, meta, props, new Set());
    return renderSegments(expanded);
  });
}

/**
 * Expand segments with no binding environment in scope.
 */
function expandWithoutEnv(
  segments: Segment[],
  components: Record<string, ComponentDefinition>,
  meta: Record<string, unknown> = {},
  props: Record<string, Json> = {},
): Operation<string> {
  return scoped(function* () {
    yield* useTestComponents(components);
    const expanded = yield* expandSegments(segments, meta, props, new Set());
    return renderSegments(expanded);
  });
}

describe("Text interpolation — eval bindings in text segments", () => {
  // TI1: Bare binding in text resolves
  it("TI1: bare binding in text resolves from env.values", function* () {
    const ctx = {};
    const segments = scanSegments("Server on port {port}.");
    const output = yield* expandWithBindings(segments, ctx, { port: 49821 });
    expect(output).toBe("Server on port 49821.");
  });

  // TI2: Bare binding with no env entry left verbatim
  it("TI2: bare binding with no env entry left verbatim", function* () {
    const ctx = {};
    const segments = scanSegments("Value is {unknown}.");
    const output = yield* expandWithBindings(segments, ctx, {});
    expect(output).toBe("Value is {unknown}.");
  });

  // TI3: {meta.title} still resolves in first pass
  it("TI3: {meta.title} still resolves in first pass", function* () {
    const ctx = {};
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
    const ctx = {};
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
    const ctx = {};
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
    const ctx = {};
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
    const ctx = {};
    const segments = scanSegments("Count is {count}.");
    const output = yield* expandWithBindings(segments, ctx, { count: 42 });
    expect(output).toBe("Count is 42.");
  });

  // TI8: Object value produces [object Object]
  it("TI8: object value produces [object Object]", function* () {
    const ctx = {};
    const segments = scanSegments("Data: {obj}");
    const output = yield* expandWithBindings(segments, ctx, { obj: {} });
    expect(output).toBe("Data: [object Object]");
  });

  // TI9: No EvalEnv — second pass skipped
  it("TI9: no EvalEnv — bare {name} left verbatim", function* () {
    const ctx = {};
    const segments = scanSegments("Value is {name}.");
    const output = yield* expandWithoutEnv(segments, ctx);
    expect(output).toBe("Value is {name}.");
  });

  // TI10: Escaped braces not interpolated
  it("TI10: escaped braces not interpolated", function* () {
    const ctx = {};
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
    const ctx = { Child: child };
    const segments = scanSegments("<Child>text with {label}</Child>");
    // Parent env has 'label', but child gets a fresh env
    const output = yield* expandWithBindings(segments, ctx, {
      label: "parent-value",
    });
    // The child's fresh env does NOT have 'label', so it stays verbatim
    expect(output).toBe("text with {label}");
  });

  // TI12: <Let> text uses current env
  it("TI12: <Let> text uses current component env", function* () {
    const ctx = {};
    const segments = scanSegments('<Let as="captured">value is {port}\n</Let>');
    const bindings: Record<string, unknown> = { port: 8080 };
    const output = yield* expandWithBindings(segments, ctx, bindings);
    expect(output).toBe("");
    expect(bindings["captured"]).toBe("value is 8080");
  });

  // TI13: Multiple bindings in one text segment
  it("TI13: multiple bindings in one text segment", function* () {
    const ctx = {};
    const segments = scanSegments("{host}:{port}");
    const output = yield* expandWithBindings(segments, ctx, {
      host: "127.0.0.1",
      port: 3000,
    });
    expect(output).toBe("127.0.0.1:3000");
  });

  // TI14: Binding adjacent to meta ref
  it("TI14: binding adjacent to meta ref — both resolved", function* () {
    const ctx = {};
    const segments = scanSegments("{meta.title}: {subtitle}");
    const output = yield* expandWithBindings(
      segments,
      ctx,
      { subtitle: "a guide" },
      { title: "xmd" },
    );
    expect(output).toBe("xmd: a guide");
  });

  // TI15: Empty env.values — no crash
  it("TI15: empty env.values — bare refs left verbatim, no crash", function* () {
    const ctx = {};
    const segments = scanSegments("Value is {name} and {other}.");
    const output = yield* expandWithBindings(segments, ctx, {});
    expect(output).toBe("Value is {name} and {other}.");
  });

  // TI17: Dotted path in text segment resolves nested property
  it("TI17: dotted path {pr.meta.title} resolves in text segment", function* () {
    const ctx = {};
    const segments = scanSegments("PR #{pr.meta.number}: {pr.meta.title}");
    const output = yield* expandWithBindings(segments, ctx, {
      pr: { meta: { number: "42", title: "feat: add feature" } },
    });
    expect(output).toBe("PR #42: feat: add feature");
  });

  // TI16: Code blocks unchanged
  it("TI16: code block interpolation still works as before", function* () {
    const captured: string[] = [];
    const segments = scanSegments(
      [
        "````bash exec",
        "echo {port} {props.name}",
        "cat <<'EOF'",
        "```xmd",
        "{source} {props.name}",
        "```",
        "EOF",
        "````",
        "```ts eval",
        "const text = `${source}`;",
        "```",
        "",
      ].join("\n"),
    );
    yield* scoped(function* () {
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *applyModifiers([_modifiers, block], _next) {
            captured.push(block.content);
            return { output: "ok\n", exitCode: 0, stderr: "" };
          },
          env: () => ({ values: { port: 8080, source: "CURRENT", props: { name: "PROP" } } }),
        },
        { at: "min" },
      );
      return yield* expandSegments(segments, {}, {}, new Set());
    });
    expect(captured).toEqual([
      "echo 8080 PROP\ncat <<'EOF'\n```xmd\nCURRENT PROP\n```\nEOF\n",
      "const text = `${source}`;\n",
    ]);
  });

  it("TI18: passive slices stay literal while prose and inline code interpolate", function* () {
    const example = "<If condition={matches}>{source} {props.name} {meta.title} \\{source}</If>\n";
    for (const opening of ["```xmd", "~~~ts", "   ````xmd"]) {
      const closing = opening.startsWith("~~~")
        ? "~~~"
        : opening.startsWith("   ")
          ? "   ````"
          : "```";
      const fence = opening + "\n" + example + closing + "\n";
      const segments = scanSegments(
        "{source} {props.name} {meta.title} `{source}`\n" + fence + "after {source}",
      );
      for (const source of ["FIRST", "CHANGED"]) {
        const output = yield* expandWithBindings(
          segments,
          {},
          { source, matches: false, props: { name: "PROP" } },
          { title: "META" },
        );
        expect(output).toBe(`${source} PROP META \`${source}\`\n` + fence + `after ${source}`);
      }
    }
  });

  it("TI19: a first-pass value containing fences does not change the second pass's slices", function* () {
    const output = yield* expandWithBindings(
      scanSegments("{meta.example}"),
      {},
      { source: "CURRENT" },
      { example: "```xmd\n{source}\n```" },
    );
    expect(output).toBe("```xmd\nCURRENT\n```");
  });

  it("TI20: a multiline inline span after a component still interpolates", function* () {
    const source = '<Let as="prefix" value={0} />```xmd\n{source}\n```\n';
    const segments = scanSegments(source);
    const output = yield* expandWithBindings(segments, {}, { source: "CURRENT_1050" });
    expect(output).toBe("```xmd\nCURRENT_1050\n```\n");
    const text = segments[1];
    if (text?.type !== "text") {
      throw new Error("expected text after the component");
    }
    expect(readsBinding(text)).toBe(true);
    const preview = previewGeneratedXmdRoot("<Output>" + source + "</Output>");
    if (!preview.ok) {
      throw preview.error;
    }
    expect(preview.value).toEqual({ output: "", incomplete: false });
  });
});

describe("interpolateEvalBindings — escaping", () => {
  it("escaped opening brace prevents interpolation", function* () {
    const result = interpolateEvalBindings("\\{name}", { name: "val" });
    expect(result).toBe("{name}");
  });

  it("escaped brace alongside normal interpolation", function* () {
    const result = interpolateEvalBindings("\\{name} and {port}", { name: "val", port: 8080 });
    expect(result).toBe("{name} and 8080");
  });

  it("multiple escaped braces", function* () {
    const result = interpolateEvalBindings("\\{a} \\{b} {c}", { a: 1, b: 2, c: 3 });
    expect(result).toBe("{a} {b} 3");
  });
});
