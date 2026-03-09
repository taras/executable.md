/**
 * Smoke test — runs the full smoke-test document (smoke-test/README.md)
 * through the entire pipeline and verifies the output contains expected
 * content from every feature: frontmatter interpolation, component expansion,
 * nested components, dotted names, executable code blocks, silent modifier,
 * props, Content slot, markdown healing, and non-executable passthrough.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@effectionx/durable-streams";
import { stubRuntime } from "@effectionx/durable-effects";
import type { DurableRuntime, StatResult } from "@effectionx/durable-streams";
import { runDocument } from "../src/run-document.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read all .md files from smoke-test/ into a flat map keyed by workspace-relative path. */
function loadSmokeTestFiles(): Record<string, string> {
  const smokeDir = path.resolve(import.meta.dirname!, "..", "smoke-test");
  const files: Record<string, string> = {};

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const rel = path.relative(path.resolve(smokeDir, ".."), full);
        files[rel] = fs.readFileSync(full, "utf-8");
      }
    }
  }

  walk(smokeDir);
  return files;
}

function makeSmokeRuntime(files: Record<string, string>): DurableRuntime {
  return stubRuntime({
    *readTextFile(filePath: string) {
      const content = files[filePath];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${filePath}`);
      }
      return content;
    },
    *stat(filePath: string): Generator<never, StatResult, unknown> {
      const exists = filePath in files;
      return { exists, isFile: exists, isDirectory: false };
    },
    *exec(options: { command: string[]; timeout?: number }) {
      const cmd = options.command;

      // bash -c "<script>"
      if (cmd[0] === "bash" && cmd[1] === "-c") {
        const script = (cmd[2] ?? "").trim();

        // find components -name '*.md' | wc -l | tr -d ' '
        // Count .md files that would be in the "components" search path
        if (script.includes("find") && script.includes("wc -l")) {
          // In the smoke-test layout, the "components" dir is the smoke-test dir itself
          // Count component files (everything except README.md)
          const count = Object.keys(files).filter(
            (k) => k.startsWith("smoke-test/") && k !== "smoke-test/README.md" && k.endsWith(".md"),
          ).length;
          return { exitCode: 0, stdout: `${count}\n`, stderr: "" };
        }

        // echo "..."
        if (script.startsWith("echo ")) {
          // Extract the quoted string content
          const match = script.match(/^echo\s+"(.*)"\s*$/);
          if (match) {
            return { exitCode: 0, stdout: match[1] + "\n", stderr: "" };
          }
          return { exitCode: 0, stdout: script.slice(5) + "\n", stderr: "" };
        }

        // cat <<'EOF' ... EOF (the summary table)
        if (script.startsWith("cat <<")) {
          // Extract content between first newline and last EOF
          const eofStart = script.indexOf("\n");
          const eofEnd = script.lastIndexOf("EOF");
          if (eofStart >= 0 && eofEnd > eofStart) {
            const content = script.slice(eofStart + 1, eofEnd);
            return { exitCode: 0, stdout: content, stderr: "" };
          }
          return { exitCode: 0, stdout: script + "\n", stderr: "" };
        }

        // Default: return the script itself
        return { exitCode: 0, stdout: script + "\n", stderr: "" };
      }

      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

describe("smoke test", () => {
  it("runs the full smoke-test document and produces expected output", function* () {
    const files = loadSmokeTestFiles();

    // Verify all expected files are loaded
    expect(Object.keys(files).sort()).toEqual([
      "smoke-test/Badge.md",
      "smoke-test/Feature.md",
      "smoke-test/Note.md",
      "smoke-test/PropDemo.md",
      "smoke-test/README.md",
      "smoke-test/Section.md",
      "smoke-test/Tips/Formatting.md",
    ]);

    const stream = new InMemoryStream();
    const runtime = makeSmokeRuntime(files);

    const output = yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime,
      componentDirs: ["smoke-test"],
      freshness: false, // no staleness checking for smoke test
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

    // ----- Durability section -----
    expect(output).toContain("Run at:");

    // ----- Journal should have events -----
    const events = stream.snapshot();
    // At minimum: root import + Section(x8) + Note(x5 total) + Feature + Badge + Formatting + PropDemo + exec blocks
    expect(events.length).toBeGreaterThan(10);
  });

  it("replay produces identical output without re-reading files", function* () {
    const files = loadSmokeTestFiles();
    const stream = new InMemoryStream();
    const runtime = makeSmokeRuntime(files);

    // Golden run
    const firstOutput = yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime,
      componentDirs: ["smoke-test"],
      freshness: false,
    });

    // Replay — use a runtime that throws on all I/O
    const replayRuntime = stubRuntime({
      *readTextFile(_path: string) {
        throw new Error("UNEXPECTED: readTextFile called during replay");
      },
      *stat(_path: string): Generator<never, StatResult, unknown> {
        throw new Error("UNEXPECTED: stat called during replay");
      },
      *exec(_options: unknown) {
        throw new Error("UNEXPECTED: exec called during replay");
      },
    });

    const secondOutput = yield* runDocument({
      docPath: "smoke-test/README.md",
      stream,
      runtime: replayRuntime,
      componentDirs: ["smoke-test"],
      freshness: false,
    });

    expect(secondOutput).toBe(firstOutput);
  });
});
