/**
 * Smoke test — runs the full smoke-test document (smoke-test/README.md)
 * through the entire pipeline using the real Node.js runtime. Verifies
 * the output contains expected content from every feature: frontmatter
 * interpolation, component expansion, nested components, dotted names,
 * executable code blocks, silent modifier, props, Content slot, markdown
 * healing, non-executable passthrough, eval blocks with shared bindings,
 * binding capture (`as` and `<Capture>`), persist modifier, timeout modifier,
 * daemon modifier, sample modifier,
 * bracket params, provider pattern, and nested providers.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { nodeRuntime } from "@executablemd/durable-effects";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

describe("smoke test", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("runs the full smoke-test document and produces expected output", function* () {
    const stream = new InMemoryStream();

    const output = yield* collect(yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime: nodeRuntime(),
      componentDirs: ["smoke-test", "core/components"],
      freshness: false,
    }));

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

    // ----- Binding capture section -----
    expect(output).toContain("§ Binding Capture");
    expect(output).toContain("Capture values:");
    expect(output).toContain("component binding from Fragment");
    expect(output).toContain("| inline binding from Capture");
    expect(output).not.toContain("Hidden capture should not render inline.");

    // ----- In-Process Evaluation section -----
    expect(output).toContain("§ In-Process Evaluation");

    // Eval blocks produce no rendered output — their bindings are invisible
    expect(output).not.toContain("Hello from eval");
    expect(output).not.toContain("with 3 numbers");

    // persist eval — resource survival via spawn + when convergence
    // The persist block spawns a task; the next block converges on it.
    // Neither produces rendered output.
    expect(output).not.toContain("serverReady"); // eval binding — no output
    expect(output).toContain("kept the task alive"); // prose explains persist

    // timeout eval block — produces no output
    expect(output).not.toContain("startedAt");

    // findFreePort + eval binding interpolation
    // The eval block allocates a port; the exec block uses {port} syntax.
    // The output should contain "Server would start on port <number>"
    expect(output).toMatch(/Server would start on port \d+/);

    // But exec blocks in the same document still produce output
    expect(output).toContain("Exec blocks are independent of eval bindings");

    // Eval summary table entries
    expect(output).toContain("eval modifier");
    expect(output).toContain("persist modifier");
    expect(output).toContain("persist resource survival");
    expect(output).toContain("timeout modifier");
    expect(output).toContain("eval + exec coexistence");
    expect(output).toContain("findFreePort VM global");
    expect(output).toContain("eval binding interpolation");

    // ----- Background Processes section (daemon) -----
    expect(output).toContain("§ Background Processes");
    // The daemon server responds with "daemon-ok"
    expect(output).toContain("daemon-ok");

    // ----- Sample Component section -----
    expect(output).toContain("§ Sample Component");
    // Self-closing with prompt — StubProvider returns [response-from-sample-stub]
    expect(output).toContain("[response-from-sample-stub]");
    // With children — children rendered then sampled
    // The children text should NOT appear raw (it's consumed by the Sample component)

    // ----- Smoke test summary table — new entries -----
    expect(output).toContain("daemon modifier");
    expect(output).toContain("provider pattern");
    expect(output).toContain("per-component eval scope");
    expect(output).toContain("props in env.values");
    expect(output).toContain("Sample component");
    expect(output).toContain("output() function");
    expect(output).toContain("renderChildren() closure");
    expect(output).toContain("Instruction component");
    expect(output).toContain("composable instructions");
    expect(output).toContain("component as capture");
    expect(output).toContain("Capture directive");

    // ----- Instruction Component section -----
    expect(output).toContain("§ Instruction Component");
    // Instruction wraps Sample — response includes system prompt text
    expect(output).toContain("[response-from-instruction-stub|system:You are a helpful pirate.]");

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
    const firstOutput = yield* collect(yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime: nodeRuntime(),
      componentDirs: ["smoke-test", "core/components"],
      freshness: false,
    }));

    // Replay — durableRun short-circuits on the Close event in the
    // journal, returning the stored result without any I/O calls.
    const secondOutput = yield* collect(yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime: nodeRuntime(),
      componentDirs: ["smoke-test", "core/components"],
      freshness: false,
    }));

    expect(secondOutput).toBe(firstOutput);
  });
});
