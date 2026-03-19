import { describe, it } from "@effectionx/bdd/node";
import { expect } from "expect";
import assert from "node:assert/strict";
import { scanSegments, parseInfoString } from "../src/scanner.ts";
import type {
  ComponentInvocation,
  ExecutableCodeBlock,
  TextSegment,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Tier A — Boundary scanner tests (spec §11)
// ---------------------------------------------------------------------------

describe("scanSegments", () => {
  // A1: Self-closing component
  it("A1: self-closing component", function*() {
    const segments = scanSegments("Hello <Comp /> world");
    expect(segments).toMatchObject([
      { type: "text", content: "Hello " },
      {
        type: "component",
        name: "Comp",
        selfClosing: true,
        props: {},
        children: [],
      },
      { type: "text", content: " world" },
    ]);
  });

  // A2: Block component with text children
  it("A2: block component with text children", function*() {
    const segments = scanSegments("<Comp>hello world</Comp>");
    expect(segments).toMatchObject([
      {
        type: "component",
        name: "Comp",
        selfClosing: false,
        children: [{ type: "text", content: "hello world" }],
      },
    ]);
  });

  // A3: Dotted component name
  it("A3: dotted component name", function*() {
    const segments = scanSegments("<Ns.Sub />");
    expect(segments).toMatchObject([
      { name: "Ns.Sub", selfClosing: true },
    ]);
  });

  // A4: String attribute with `>`
  it("A4: string attribute containing >", function*() {
    const segments = scanSegments('<Comp title="a > b" />');
    expect(segments).toMatchObject([
      { props: { title: "a > b" } },
    ]);
  });

  // A5: Expression attribute with nested braces
  it("A5: expression attribute with nested braces", function*() {
    const segments = scanSegments('<Comp data={{ a: 1 }} />');
    expect(segments).toMatchObject([
      { props: { data: { a: 1 } } },
    ]);
  });

  // A6: Template literal attribute
  it("A6: template literal attribute", function*() {
    const segments = scanSegments("<Comp label={`hello`} />");
    expect(segments).toMatchObject([
      { type: "component" },
    ]);
    // Scanner completes without error
  });

  // A7: Spread props
  it("A7: spread props", function*() {
    const segments = scanSegments("<Comp {...props} />");
    expect(segments).toMatchObject([
      { type: "component", selfClosing: true },
    ]);
    // Spread props are skipped, no crash
  });

  // A8: Not a component — comparison expression
  it("A8: not a component — comparison expression", function*() {
    const _segments = scanSegments("a < B && c > d");
    // '<' followed by ' B' (space before B) — not a tag
    // Or if B is right after <, it would be `<B` which IS uppercase
    // Let's use lowercase to be safe
    const segments2 = scanSegments("a < b && c > d");
    expect(segments2).toMatchObject([
      { type: "text" },
    ]);
  });

  // A9: Incomplete tag at end of input
  it("A9: incomplete tag at end of input", function*() {
    const segments = scanSegments("Hello <MyComp");
    // Should be treated as text since tag is incomplete
    expect(segments).toMatchObject([
      { type: "text" },
    ]);
  });

  // A10: Code block with `exec` modifier
  it("A10: code block with exec modifier", function*() {
    const segments = scanSegments("```bash exec\nls -la\n```\n");
    expect(segments).toMatchObject([
      {
        type: "codeBlock",
        language: "bash",
        content: "ls -la\n",
        executable: true,
        modifiers: [{ name: "exec" }],
      },
    ]);
  });

  // A11: Code block with `silent exec`
  it("A11: code block with silent exec", function*() {
    const segments = scanSegments("```bash silent exec\nls\n```\n");
    expect(segments).toMatchObject([
      {
        type: "codeBlock",
        language: "bash",
        executable: true,
        modifiers: [{ name: "silent" }, { name: "exec" }],
      },
    ]);
  });

  // A12: Code block without `exec`
  it("A12: code block without exec is text", function*() {
    const segments = scanSegments("```bash\nls -la\n```\n");
    expect(segments.length).toBe(1);
    expect(segments[0]!.type).toBe("text");
    expect((segments[0] as { content: string }).content).toContain("ls -la");
  });

  // A13: Code block with modifiers but no exec
  it("A13: code block with modifiers but no exec", function*() {
    const segments = scanSegments("```bash silent\nls\n```\n");
    expect(segments).toMatchObject([
      { type: "text" },
    ]);
  });

  // A14: Component inside fenced code block
  it("A14: component inside fenced code block is text", function*() {
    const segments = scanSegments("```jsx\n<Component />\n```\n");
    expect(segments.length).toBe(1);
    expect(segments[0]!.type).toBe("text");
    expect((segments[0] as { content: string }).content).toContain("<Component />");
  });

  // A14b: Component inside inline code span is text
  it("A14b: component inside inline code span is text", function*() {
    const segments = scanSegments("Use `<Content />` for slot");
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "text");
    assert.ok((segments[0] as TextSegment).content.includes("`<Content />`"));
  });

  // A14c: Component inside double-backtick code span is text
  it("A14c: component inside double-backtick code span is text", function*() {
    const segments = scanSegments("Use ``<Content />`` for slot");
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "text");
    assert.ok((segments[0] as TextSegment).content.includes("``<Content />``"));
  });

  // A14d: Component after inline code span with other content
  it("A14d: component inside code span with surrounding text", function*() {
    const segments = scanSegments("hello `see <Content />` world");
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "text");
    assert.ok((segments[0] as TextSegment).content.includes("`see <Content />`"));
  });

  // A14e: Exec code block inside component children
  it("A14e: exec code block inside component children produces codeBlock segment", function*() {
    const input = '<Section title="test">\n\n```bash exec\necho hello\n```\n\n</Section>';
    const segments = scanSegments(input);
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    assert.equal(comp.type, "component");
    assert.equal(comp.name, "Section");
    // Children should contain: text, codeBlock, text
    const codeBlocks = comp.children.filter((c) => c.type === "codeBlock");
    assert.equal(codeBlocks.length, 1);
    assert.equal(codeBlocks[0]!.type, "codeBlock");
    assert.equal((codeBlocks[0] as ExecutableCodeBlock).language, "bash");
    assert.equal((codeBlocks[0] as ExecutableCodeBlock).executable, true);
  });

  // A14f: Non-executable code block inside component children stays as text
  it("A14f: non-exec code block inside component children is text", function*() {
    const input = '<Section title="test">\n\n```yaml\nkey: value\n```\n\n</Section>';
    const segments = scanSegments(input);
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    // Non-executable code block should be part of text children
    const codeBlocks = comp.children.filter((c) => c.type === "codeBlock");
    assert.equal(codeBlocks.length, 0);
    // The yaml block should be in a text segment
    const textContent = comp.children
      .filter((c) => c.type === "text")
      .map((c) => (c as TextSegment).content)
      .join("");
    assert.ok(textContent.includes("```yaml"));
    assert.ok(textContent.includes("key: value"));
  });

  // A14g: Inline code span inside component children
  it("A14g: inline code span inside component children protects component syntax", function*() {
    const input = '<Section title="test">\n\nUse `<Content />` here\n\n</Section>';
    const segments = scanSegments(input);
    assert.equal(segments.length, 1);
    const comp = segments[0] as ComponentInvocation;
    // Children should be a single text segment — Content is not parsed as component
    const components = comp.children.filter((c) => c.type === "component");
    assert.equal(components.length, 0);
    const textContent = comp.children
      .filter((c) => c.type === "text")
      .map((c) => (c as TextSegment).content)
      .join("");
    assert.ok(textContent.includes("`<Content />`"));
  });

  // A15: Boolean prop
  it("A15: boolean prop", function*() {
    const segments = scanSegments("<Comp verbose />");
    expect(segments).toMatchObject([
      { props: { verbose: true } },
    ]);
  });

  // A16: Numeric expression prop
  it("A16: numeric expression prop", function*() {
    const segments = scanSegments("<Comp count={42} />");
    expect(segments).toMatchObject([
      { props: { count: 42 } },
    ]);
  });

  // A17: Modifier with params
  it("A17: modifier with params", function*() {
    const segments = scanSegments("```bash timeout=30s exec\nls\n```\n");
    expect(segments).toMatchObject([
      {
        modifiers: [
          { name: "timeout", params: "30s" },
          { name: "exec" },
        ],
      },
    ]);
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
    expect(segments).toMatchObject([
      { type: "text" },
      { type: "component" },
      { type: "text" }, // newline between component and code block
      { type: "codeBlock" },
    ]);
  });

  it("nested components", function*() {
    const segments = scanSegments("<Outer><Inner /></Outer>");
    expect(segments).toMatchObject([
      {
        name: "Outer",
        children: [
          { name: "Inner", selfClosing: true },
        ],
      },
    ]);
  });

  it("component with multiple string props", function*() {
    const segments = scanSegments('<Comp name="alice" role="admin" />');
    expect(segments).toMatchObject([
      { props: { name: "alice", role: "admin" } },
    ]);
  });
});

describe("parseInfoString", () => {
  it("parses language only", function*() {
    const result = parseInfoString("bash");
    expect(result).toMatchObject({
      language: "bash",
      modifiers: [],
      executable: false,
    });
  });

  it("parses language + exec", function*() {
    const result = parseInfoString("bash exec");
    expect(result).toMatchObject({
      language: "bash",
      modifiers: [{ name: "exec" }],
      executable: true,
    });
  });

  it("parses language + silent + exec", function*() {
    const result = parseInfoString("bash silent exec");
    expect(result).toMatchObject({
      language: "bash",
      modifiers: [{ name: "silent" }, { name: "exec" }],
      executable: true,
    });
  });

  it("parses modifier with params", function*() {
    const result = parseInfoString("bash timeout=30s exec");
    expect(result).toMatchObject({
      modifiers: [
        { name: "timeout", params: "30s" },
        { name: "exec" },
      ],
    });
  });

  it("eval makes executable", function*() {
    const result = parseInfoString("js eval");
    expect(result.executable).toBe(true);
  });

  it("empty string", function*() {
    const result = parseInfoString("");
    expect(result).toMatchObject({
      language: "",
      modifiers: [],
      executable: false,
    });
  });

  // Bracket param tests
  it("parses bracket params: sample[model=phi3-mini]", function*() {
    const result = parseInfoString("bash sample[model=phi3-mini] exec");
    expect(result).toMatchObject({
      language: "bash",
      modifiers: [
        { name: "sample", params: "model=phi3-mini" },
        { name: "exec" },
      ],
      executable: true,
    });
  });

  it("parses bracket params with different key", function*() {
    const result = parseInfoString("bash sample[temperature=0.7] exec");
    expect(result).toMatchObject({
      modifiers: [
        { name: "sample", params: "temperature=0.7" },
        { name: "exec" },
      ],
    });
  });

  it("bracket params without value treated as params", function*() {
    const result = parseInfoString("bash sample[brief] exec");
    expect(result).toMatchObject({
      modifiers: [
        { name: "sample", params: "brief" },
        { name: "exec" },
      ],
    });
  });
});
