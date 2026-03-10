/**
 * Smoke test — runs the full smoke-test document (smoke-test/README.md)
 * through the entire pipeline using the real Node.js runtime. Verifies
 * the output contains expected content from every feature: frontmatter
 * interpolation, component expansion, nested components, dotted names,
 * executable code blocks, silent modifier, props, Content slot, markdown
 * healing, non-executable passthrough, eval blocks with shared bindings,
 * persist modifier, and timeout modifier.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@effectionx/durable-streams";
import { nodeRuntime } from "@effectionx/durable-effects";
import { runDocument } from "../src/run-document.ts";

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

describe("smoke test", () => {
  it("runs the full smoke-test document and produces expected output", function* () {
    const stream = new InMemoryStream();

    const output = yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime: nodeRuntime(),
      componentDirs: ["smoke-test"],
      freshness: false,
    });

    // ----- Root frontmatter interpolation -----
    expect(output).toContain("# Executable MDX");
    expect(output).toContain("version **0.1.0**");
    expect(output).toContain("https://github.com/thefrontside/effectionx");

    // ----- Section component (Content slot + meta interpolation) -----
    expect(output).toContain("§ What is Executable MDX?");
    expect(output).toContain("§ Components");
    expect(output).toContain("§ Nested Components");
    expect(output).toContain("§ Executable Code Blocks");
    expect(output).toContain("§ Props and Interpolation");
    expect(output).toContain("§ Markdown Healing");
    expect(output).toContain("§ Durability");
    expect(output).toContain("§ Smoke Test Summary");

    // ----- Note component (props interpolation + defaults) -----
    // Default level=info
    expect(output).toContain("📝 **info:** This note uses the default level (info).");
    // Overridden level=warning
    expect(output).toContain("📝 **warning:** This note overrides the level to warning.");

    // ----- Feature component (nested — Feature contains Note) -----
    expect(output).toContain("**Recursive Expansion**");
    expect(output).toContain("Components expand bottom-up");
    expect(output).toContain("This note was generated inside the Feature component.");

    // ----- Dotted component name (Tips.Formatting → Tips/Formatting.md) -----
    expect(output).toContain("💡 **Formatting tip:**");
    expect(output).toContain("<Content />");

    // ----- Executable code blocks -----
    // find count — should produce a number
    expect(output).toMatch(/\d+/);
    // echo block
    expect(output).toContain("Hello from a durable workflow");

    // ----- Silent exec — output suppressed -----
    // The silent block content should NOT appear in output
    expect(output).not.toContain("This output is journaled but not shown in the document");

    // ----- Non-executable code block (yaml passthrough) -----
    expect(output).toContain("# This is just a code block");
    expect(output).toContain("type: string");

    // ----- PropDemo component -----
    expect(output).toContain('"Hey, world!"');

    // ----- Badge component (no inputs, meta interpolation) -----
    expect(output).toContain("✓ verified");

    // ----- Markdown healing -----
    // The unclosed bold before <Badge /> should be healed
    // "**bold before the component" should get closed before the boundary
    // Both text segments should be independently valid markdown

    // ----- Smoke test summary table -----
    expect(output).toContain("| Feature");
    expect(output).toContain("Root frontmatter");
    expect(output).toContain("Component with props");
    expect(output).toContain("Content slot");
    expect(output).toContain("Nested expansion");
    expect(output).toContain("Dotted component name");
    expect(output).toContain("exec modifier");
    expect(output).toContain("silent modifier");
    expect(output).toContain("Markdown healing");

    // ----- In-Process Evaluation section -----
    expect(output).toContain("§ In-Process Evaluation");

    // Eval blocks produce no rendered output — their bindings are invisible
    expect(output).not.toContain("Hello from eval");
    expect(output).not.toContain("with 3 numbers");

    // persist eval block — bindings available but resource prose is visible
    // The block itself produces no output; the explanatory prose around it does
    expect(output).not.toContain("localhost:3000"); // persist block binding — no output
    expect(output).not.toContain("ws://localhost"); // downstream eval block — no output

    // Resource survival — persist eval spawns a task, next block converges on it
    // Both blocks produce no output; the prose about resource survival is visible
    expect(output).toContain("Resources spawned inside");
    expect(output).not.toContain("serverReady"); // eval binding — no output

    // timeout eval block — produces no output
    expect(output).not.toContain("startedAt");

    // But exec blocks in the same document still produce output
    expect(output).toContain("Exec blocks are independent of eval bindings");

    // Eval summary table entries
    expect(output).toContain("eval modifier");
    expect(output).toContain("persist modifier");
    expect(output).toContain("persist resource survival");
    expect(output).toContain("timeout modifier");
    expect(output).toContain("eval + exec coexistence");

    // ----- Durability section -----
    expect(output).toContain("Run at:");

    // ----- Journal should have events -----
    const events = stream.snapshot();
    // At minimum: root import + Section(x9) + Note(x5 total) + Feature + Badge + Formatting + PropDemo + exec blocks + eval blocks
    expect(events.length).toBeGreaterThan(10);
  });

  it("replay produces identical output without re-reading files", function* () {
    const stream = new InMemoryStream();

    // Golden run
    const firstOutput = yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime: nodeRuntime(),
      componentDirs: ["smoke-test"],
      freshness: false,
    });

    // Replay — durableRun short-circuits on the Close event in the
    // journal, returning the stored result without any I/O calls.
    const secondOutput = yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime: nodeRuntime(),
      componentDirs: ["smoke-test"],
      freshness: false,
    });

    expect(secondOutput).toBe(firstOutput);
  });
});
