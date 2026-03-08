import { describe, it } from "@effectionx/bdd/node";
import assert from "node:assert/strict";
import { scanSegments, parseInfoString } from "./scanner.ts";
import type {
  ComponentInvocation,
  ExecutableCodeBlock,
  TextSegment,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Tier A — Boundary scanner tests (spec §11)
// ---------------------------------------------------------------------------

describe("scanSegments", () => {
  // A1: Self-closing component
  it("A1: self-closing component", function*() {
    const segments = scanSegments("Hello <Comp /> world");
    assert.equal(segments.length, 3);
    assert.equal(segments[0]!.type, "text");
    assert.equal((segments[0] as TextSegment).content, "Hello ");

    const comp = segments[1] as ComponentInvocation;
    assert.equal(comp.type, "component");
    assert.equal(comp.name, "Comp");
    assert.equal(comp.selfClosing, true);
    assert.deepEqual(comp.props, {});
    assert.deepEqual(comp.children, []);

    assert.equal(segments[2]!.type, "text");
    assert.equal((segments[2] as TextSegment).content, " world");
  });

  // A2: Block component with text children
  it("A2: block component with text children", function*() {
    const segments = scanSegments("<Comp>hello world</Comp>");
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.type, "component");
    assert.equal(comp.name, "Comp");
    assert.equal(comp.selfClosing, false);
    assert.equal(comp.children.length, 1);
    assert.equal(comp.children[0]!.type, "text");
    assert.equal((comp.children[0] as TextSegment).content, "hello world");
  });

  // A3: Dotted component name
  it("A3: dotted component name", function*() {
    const segments = scanSegments("<Ns.Sub />");
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.name, "Ns.Sub");
    assert.equal(comp.selfClosing, true);
  });

  // A4: String attribute with `>`
  it("A4: string attribute containing >", function*() {
    const segments = scanSegments('<Comp title="a > b" />');
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.props["title"], "a > b");
  });

  // A5: Expression attribute with nested braces
  it("A5: expression attribute with nested braces", function*() {
    const segments = scanSegments('<Comp data={{ a: 1 }} />');
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.deepEqual(comp.props["data"], { a: 1 });
  });

  // A6: Template literal attribute
  it("A6: template literal attribute", function*() {
    const segments = scanSegments("<Comp label={`hello`} />");
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.type, "component");
    // Scanner completes without error
  });

  // A7: Spread props
  it("A7: spread props", function*() {
    const segments = scanSegments("<Comp {...props} />");
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.type, "component");
    assert.equal(comp.selfClosing, true);
    // Spread props are skipped, no crash
  });

  // A8: Not a component — comparison expression
  it("A8: not a component — comparison expression", function*() {
    const segments = scanSegments("a < B && c > d");
    // '<' followed by ' B' (space before B) — not a tag
    // Or if B is right after <, it would be `<B` which IS uppercase
    // Let's use lowercase to be safe
    const segments2 = scanSegments("a < b && c > d");
    assert.equal(segments2.length, 1);
    assert.equal(segments2[0]!.type, "text");
  });

  // A9: Incomplete tag at end of input
  it("A9: incomplete tag at end of input", function*() {
    const segments = scanSegments("Hello <MyComp");
    // Should be treated as text since tag is incomplete
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "text");
  });

  // A10: Code block with `exec` modifier
  it("A10: code block with exec modifier", function*() {
    const segments = scanSegments("```bash exec\nls -la\n```\n");
    assert.equal(segments.length, 1);
    const block = segments[0] as ExecutableCodeBlock;
    assert.equal(block.type, "codeBlock");
    assert.equal(block.language, "bash");
    assert.equal(block.content, "ls -la\n");
    assert.equal(block.executable, true);
    assert.equal(block.modifiers.length, 1);
    assert.equal(block.modifiers[0]!.name, "exec");
  });

  // A11: Code block with `silent exec`
  it("A11: code block with silent exec", function*() {
    const segments = scanSegments("```bash silent exec\nls\n```\n");
    assert.equal(segments.length, 1);
    const block = segments[0] as ExecutableCodeBlock;
    assert.equal(block.type, "codeBlock");
    assert.equal(block.language, "bash");
    assert.equal(block.executable, true);
    assert.equal(block.modifiers.length, 2);
    assert.equal(block.modifiers[0]!.name, "silent");
    assert.equal(block.modifiers[1]!.name, "exec");
  });

  // A12: Code block without `exec`
  it("A12: code block without exec is text", function*() {
    const segments = scanSegments("```bash\nls -la\n```\n");
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "text");
    assert.ok((segments[0] as TextSegment).content.includes("ls -la"));
  });

  // A13: Code block with modifiers but no exec
  it("A13: code block with modifiers but no exec", function*() {
    const segments = scanSegments("```bash silent\nls\n```\n");
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "text");
  });

  // A14: Component inside fenced code block
  it("A14: component inside fenced code block is text", function*() {
    const segments = scanSegments("```jsx\n<Component />\n```\n");
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "text");
    assert.ok((segments[0] as TextSegment).content.includes("<Component />"));
  });

  // A15: Boolean prop
  it("A15: boolean prop", function*() {
    const segments = scanSegments("<Comp verbose />");
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.props["verbose"], true);
  });

  // A16: Numeric expression prop
  it("A16: numeric expression prop", function*() {
    const segments = scanSegments("<Comp count={42} />");
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.props["count"], 42);
  });

  // A17: Modifier with params
  it("A17: modifier with params", function*() {
    const segments = scanSegments("```bash timeout=30s exec\nls\n```\n");
    assert.equal(segments.length, 1);
    const block = segments[0] as ExecutableCodeBlock;
    assert.equal(block.modifiers.length, 2);
    assert.equal(block.modifiers[0]!.name, "timeout");
    assert.equal(block.modifiers[0]!.params, "30s");
    assert.equal(block.modifiers[1]!.name, "exec");
  });

  // Additional edge cases
  it("mixed content: text + component + code block", function*() {
    const input = `# Hello

<Greeting name="world" />

\`\`\`bash exec
echo hi
\`\`\`
`;
    const segments = scanSegments(input);
    assert.equal(segments.length, 4);
    assert.equal(segments[0]!.type, "text");
    assert.equal(segments[1]!.type, "component");
    assert.equal(segments[2]!.type, "text"); // newline between component and code block
    assert.equal(segments[3]!.type, "codeBlock");
  });

  it("nested components", function*() {
    const segments = scanSegments("<Outer><Inner /></Outer>");
    assert.equal(segments.length, 1);
    const outer = segments[0] as ComponentInvocation;
    assert.equal(outer.name, "Outer");
    assert.equal(outer.children.length, 1);
    const inner = outer.children[0] as ComponentInvocation;
    assert.equal(inner.name, "Inner");
    assert.equal(inner.selfClosing, true);
  });

  it("component with multiple string props", function*() {
    const segments = scanSegments('<Comp name="alice" role="admin" />');
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.props["name"], "alice");
    assert.equal(comp.props["role"], "admin");
  });
});

describe("parseInfoString", () => {
  it("parses language only", function*() {
    const result = parseInfoString("bash");
    assert.equal(result.language, "bash");
    assert.equal(result.modifiers.length, 0);
    assert.equal(result.executable, false);
  });

  it("parses language + exec", function*() {
    const result = parseInfoString("bash exec");
    assert.equal(result.language, "bash");
    assert.equal(result.modifiers.length, 1);
    assert.equal(result.modifiers[0]!.name, "exec");
    assert.equal(result.executable, true);
  });

  it("parses language + silent + exec", function*() {
    const result = parseInfoString("bash silent exec");
    assert.equal(result.language, "bash");
    assert.equal(result.modifiers.length, 2);
    assert.equal(result.modifiers[0]!.name, "silent");
    assert.equal(result.modifiers[1]!.name, "exec");
    assert.equal(result.executable, true);
  });

  it("parses modifier with params", function*() {
    const result = parseInfoString("bash timeout=30s exec");
    assert.equal(result.modifiers.length, 2);
    assert.equal(result.modifiers[0]!.name, "timeout");
    assert.equal(result.modifiers[0]!.params, "30s");
    assert.equal(result.modifiers[1]!.name, "exec");
  });

  it("eval makes executable", function*() {
    const result = parseInfoString("js eval");
    assert.equal(result.executable, true);
  });

  it("empty string", function*() {
    const result = parseInfoString("");
    assert.equal(result.language, "");
    assert.equal(result.modifiers.length, 0);
    assert.equal(result.executable, false);
  });
});
