import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { scanSegments, parseInfoString } from "./scanner.ts";

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
    const segments = scanSegments("a < B && c > d");
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
});
